//! One event-driven execution loop for queued human input and explicit goals.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Duration;

use dure_app::{
    AgentGoalRecordV1, AgentGoalStatusV1, AgentGoalStore, AgentIdV1, AgentQueuedTurnStore,
    AgentRecoveryStore, AgentTimelineStore,
};
use tokio::sync::{broadcast, mpsc};
use tokio::task::{Id, JoinSet};

use crate::agent_conversation::AgentConversationNotificationKindV1;
use crate::agent_conversation_api::AgentConversationApiErrorV1;
use crate::agent_recovery::AgentRecoveryHoldV1;
use crate::{ServiceState, agent_goal, agent_recovery, now_ms};

async fn enqueue_active(
    state: &ServiceState,
    pending: &mut BTreeSet<AgentIdV1>,
) -> Result<(), &'static str> {
    pending.extend(
        state
            .store
            .agents_with_recovery()
            .await
            .map_err(|_| "agent_recovery_store_failed")?,
    );
    pending.extend(
        state
            .store
            .agents_with_queued_turns()
            .await
            .map_err(|_| "agent_queue_store_failed")?,
    );
    pending.extend(
        state
            .store
            .active_agent_goals()
            .await
            .map_err(|_| "agent_goal_store_failed")?
            .into_iter()
            .map(|goal| goal.agent_id),
    );
    Ok(())
}

/// One step for an Agent; `Some` is when its recovery next needs a step.
pub(crate) async fn advance(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    goal: Option<&AgentGoalRecordV1>,
) -> Result<Option<i64>, &'static str> {
    let recovery = agent_recovery::advance(state, agent_id).await;
    let wake_at_ms = match recovery {
        Ok(AgentRecoveryHoldV1::WaitsUntil(at)) => Some(at),
        _ => None,
    };
    // A native terminal Agent has no conversation to queue turns or goals
    // in; account recovery is all this loop does for it.
    let Some(binding) = state
        .store
        .agent_interaction_for_agent(agent_id)
        .await
        .map_err(|_| "agent_conversation_store_failed")?
    else {
        return recovery.map(|_| wake_at_ms);
    };
    if state
        .store
        .has_queued_agent_turns(&binding.interaction_session_id)
        .await
        .map_err(|_| "agent_queue_store_failed")?
    {
        return match state.agent_conversations.start_queued_turn(&binding).await {
            // Runtime recovery publishes readiness; no effect was claimed.
            Ok(_) | Err(AgentConversationApiErrorV1::RuntimeUnavailable) => Ok(wake_at_ms),
            Err(error) => Err(error.code()),
        };
    }
    if recovery?.owns() {
        return Ok(wake_at_ms);
    }
    match goal {
        Some(goal) => agent_goal::advance(state, goal).await.map(|()| None),
        None => Ok(None),
    }
}

/// How long until the earliest wake, capped so a far reset re-reads the
/// clock: a computer that slept past it continues soon after waking.
fn until_next_wake(wakes: &BTreeMap<AgentIdV1, i64>, now_ms: i64) -> Option<Duration> {
    const MAX_SLEEP_MS: i64 = 60 * 1000;
    let earliest = *wakes.values().min()?;
    let delay = earliest.saturating_sub(now_ms).clamp(0, MAX_SLEEP_MS);
    Some(Duration::from_millis(delay.unsigned_abs()))
}

async fn run_inner(state: Arc<ServiceState>) -> Result<(), &'static str> {
    state.wait_for_mutation_authority().await;
    let mut notifications = state.agent_conversations.notifications();
    // Native terminal failures live in their Hosts, not in conversation
    // notifications; the scanner wakes the same owner for them.
    let (native_wake, mut native_failures) = mpsc::unbounded_channel();
    let scanner = tokio::spawn(agent_recovery::scan_native_failures(
        Arc::clone(&state),
        native_wake,
    ));
    let _scanner = scanner_guard(scanner);
    let mut pending = BTreeSet::new();
    let mut running: HashMap<Id, (AgentIdV1, Option<u64>)> = HashMap::new();
    let mut wakes: BTreeMap<AgentIdV1, i64> = BTreeMap::new();
    let mut jobs = JoinSet::new();
    enqueue_active(&state, &mut pending).await?;
    loop {
        let ready: Vec<_> = pending
            .iter()
            .filter(|agent_id| !running.values().any(|(running, _)| running == *agent_id))
            .cloned()
            .collect();
        for agent_id in ready {
            pending.remove(&agent_id);
            let goal = state
                .store
                .agent_goal(&agent_id)
                .await
                .map_err(|_| "agent_goal_store_failed")?
                .filter(|goal| goal.status == AgentGoalStatusV1::Active);
            let revision = goal.as_ref().map(|goal| goal.revision);
            let worker = Arc::clone(&state);
            let target = agent_id.clone();
            let task = jobs.spawn(async move { advance(&worker, &target, goal.as_ref()).await });
            running.insert(task.id(), (agent_id, revision));
        }
        let next_wake = if wakes.is_empty() {
            None
        } else {
            until_next_wake(
                &wakes,
                now_ms().map_err(|_| "agent_recovery_clock_unavailable")?,
            )
        };
        tokio::select! {
            _ = tokio::time::sleep(next_wake.unwrap_or_default()), if next_wake.is_some() => {
                let now = now_ms().map_err(|_| "agent_recovery_clock_unavailable")?;
                wakes.retain(|agent_id, at| {
                    let due = *at <= now;
                    if due { pending.insert(agent_id.clone()); }
                    !due
                });
            }
            _ = state.goal_wakeup.notified() => enqueue_active(&state, &mut pending).await?,
            Some(agent_id) = native_failures.recv() => {
                pending.insert(agent_id);
            }
            notification = notifications.recv() => match notification {
                Ok(notification) => {
                    if notification.kinds.iter().all(|kind| matches!(kind, AgentConversationNotificationKindV1::LiveText | AgentConversationNotificationKindV1::Goal | AgentConversationNotificationKindV1::Recovery)) { continue; }
                    if let Some(binding) = state.store.agent_interaction(&notification.interaction_session_id).await.map_err(|_| "agent_conversation_store_failed")? {
                        pending.insert(binding.agent_id);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => enqueue_active(&state, &mut pending).await?,
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            },
            completed = jobs.join_next_with_id(), if !jobs.is_empty() => {
                let Some(completed) = completed else { continue; };
                let (id, outcome) = match completed {
                    Ok((id, result)) => (id, result),
                    Err(error) => (error.id(), Err("agent_conversation_worker_failed")),
                };
                let Some((agent_id, revision)) = running.remove(&id) else { continue; };
                match &outcome {
                    Ok(Some(at)) => { wakes.insert(agent_id.clone(), *at); }
                    Ok(None) | Err(_) => { wakes.remove(&agent_id); }
                }
                if let Err(code) = outcome {
                    eprintln!("Dure conversation {agent_id} continuation failed: {code}");
                    if let Some(revision) = revision
                        && state.store.fail_agent_goal(&agent_id, revision, code, now_ms().map_err(|_| "agent_goal_clock_unavailable")?).await
                            .map_err(|_| "agent_goal_store_failed")?.is_some() {
                        state.agent_conversations.publish_goal_change(&agent_id).await.map_err(|error| error.code())?;
                    }
                }
            }
        }
    }
}

/// Stops the scanner when the loop that consumes its wakes ends.
fn scanner_guard(task: tokio::task::JoinHandle<()>) -> impl Drop {
    struct Abort(tokio::task::JoinHandle<()>);
    impl Drop for Abort {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    Abort(task)
}

pub(crate) async fn run(state: Arc<ServiceState>) {
    if let Err(code) = run_inner(state).await {
        eprintln!("Dure conversation continuation stopped: {code}");
    }
}
