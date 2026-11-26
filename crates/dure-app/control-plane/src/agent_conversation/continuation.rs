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

/// The wait before the first retry of owed work; each further failure in a
/// row doubles it, up to `RETRY_MAX_MS`.
const RETRY_MIN_MS: i64 = 1_000;
const RETRY_MAX_MS: i64 = 30_000;

/// Why a step stopped short. Owed work is still durable but has no other
/// wake-up: the input is still queued, or the loop could not read whether
/// anything was due. A goal or recovery outcome is recorded by its owner and
/// is not owed.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct Stalled {
    code: &'static str,
    owed: bool,
}

impl Stalled {
    fn owed(code: &'static str) -> Self {
        Self { code, owed: true }
    }

    fn settled(code: &'static str) -> Self {
        Self { code, owed: false }
    }
}

/// A step the loop runs at a time rather than on a notification.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum Owed {
    /// Re-read which Agents have work, as at startup.
    Scan,
    Agent(AgentIdV1),
}

/// When the loop next owes a step: a recovery that waits for its provider's
/// limit to reset, or a retry. A notification is the only wake-up for queued
/// input, so a failure at that moment, such as store contention under load,
/// would otherwise leave the input `queued` until some unrelated event.
#[derive(Default)]
struct Wakes {
    at_ms: BTreeMap<Owed, i64>,
    /// The current run of failures of each retried step, and its reason.
    failures: BTreeMap<Owed, (u32, &'static str)>,
}

impl Wakes {
    fn hold(&mut self, owed: Owed, at_ms: i64) {
        self.failures.remove(&owed);
        self.at_ms.insert(owed, at_ms);
    }

    fn settle(&mut self, owed: &Owed) {
        self.failures.remove(owed);
        self.at_ms.remove(owed);
    }

    /// Schedules the next attempt of a failed step. A run of failures
    /// reports once for each reason.
    fn failed(&mut self, owed: Owed, code: &'static str, now_ms: i64) {
        let (failures, reported) = self.failures.get(&owed).copied().unwrap_or((0, ""));
        if reported != code {
            match &owed {
                Owed::Scan => eprintln!(
                    "Dure conversation continuation could not read its work: {code}; retrying"
                ),
                Owed::Agent(agent_id) => {
                    eprintln!("Dure conversation {agent_id} continuation failed: {code}; retrying")
                }
            }
        }
        let failures = failures.saturating_add(1);
        self.at_ms.insert(
            owed.clone(),
            now_ms.saturating_add(retry_delay_ms(failures)),
        );
        self.failures.insert(owed, (failures, code));
    }

    /// Schedules a scan unless one is already due. Notifications that could
    /// not be resolved in a burst share it.
    fn owe_scan(&mut self, code: &'static str, now_ms: i64) {
        if !self.at_ms.contains_key(&Owed::Scan) {
            self.failed(Owed::Scan, code, now_ms);
        }
    }

    /// How long until the earliest wake, capped so a far reset re-reads the
    /// clock: a computer that slept past it continues soon after waking.
    fn until_next(&self, now_ms: i64) -> Option<Duration> {
        const MAX_SLEEP_MS: i64 = 60 * 1000;
        let earliest = *self.at_ms.values().min()?;
        let delay = earliest.saturating_sub(now_ms).clamp(0, MAX_SLEEP_MS);
        Some(Duration::from_millis(delay.unsigned_abs()))
    }

    /// Removes and returns the steps due now. A failure run is kept until the
    /// step settles, so its next failure waits longer.
    fn take_due(&mut self, now_ms: i64) -> Vec<Owed> {
        let due: Vec<_> = self
            .at_ms
            .iter()
            .filter(|(_, at)| **at <= now_ms)
            .map(|(owed, _)| owed.clone())
            .collect();
        for owed in &due {
            self.at_ms.remove(owed);
        }
        due
    }
}

fn retry_delay_ms(failures: u32) -> i64 {
    RETRY_MIN_MS
        .saturating_mul(1 << failures.saturating_sub(1).min(5))
        .min(RETRY_MAX_MS)
}

fn clock() -> Result<i64, &'static str> {
    now_ms().map_err(|_| "agent_conversation_clock_unavailable")
}

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

async fn scan(
    state: &ServiceState,
    pending: &mut BTreeSet<AgentIdV1>,
    wakes: &mut Wakes,
) -> Result<(), &'static str> {
    match enqueue_active(state, pending).await {
        Ok(()) => wakes.settle(&Owed::Scan),
        Err(code) => wakes.failed(Owed::Scan, code, clock()?),
    }
    Ok(())
}

/// One step for an Agent; `Some` is when its recovery next needs a step.
pub(crate) async fn advance(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    goal: Option<&AgentGoalRecordV1>,
) -> Result<Option<i64>, Stalled> {
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
        .map_err(|_| Stalled::owed("agent_conversation_store_failed"))?
    else {
        return recovery.map(|_| wake_at_ms).map_err(Stalled::settled);
    };
    if state
        .store
        .has_queued_agent_turns(&binding.interaction_session_id)
        .await
        .map_err(|_| Stalled::owed("agent_queue_store_failed"))?
    {
        return match state.agent_conversations.start_queued_turn(&binding).await {
            // Runtime recovery publishes readiness; no effect was claimed.
            Ok(_) | Err(AgentConversationApiErrorV1::RuntimeUnavailable) => Ok(wake_at_ms),
            // A failed claim leaves the input queued. A provider refusal has
            // recorded its outcome; the retry claims the next input, if any.
            Err(error) => Err(Stalled::owed(error.code())),
        };
    }
    if recovery.map_err(Stalled::settled)?.owns() {
        return Ok(wake_at_ms);
    }
    match goal {
        Some(goal) => agent_goal::advance(state, goal)
            .await
            .map(|()| None)
            .map_err(Stalled::settled),
        None => Ok(None),
    }
}

/// Ends the goal whose step failed. False when that could not be recorded:
/// the goal is still active and its step is owed again.
async fn fail_goal(state: &ServiceState, agent_id: &AgentIdV1, revision: u64, code: &str) -> bool {
    let Ok(now) = now_ms() else {
        return false;
    };
    match state
        .store
        .fail_agent_goal(agent_id, revision, code, now)
        .await
    {
        Ok(Some(_)) => {
            if let Err(error) = state
                .agent_conversations
                .publish_goal_change(agent_id)
                .await
            {
                eprintln!(
                    "Dure conversation {agent_id} goal change was not published: {}",
                    error.code()
                );
            }
            true
        }
        Ok(None) => true,
        Err(_) => false,
    }
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
    let mut wakes = Wakes::default();
    let mut jobs = JoinSet::new();
    scan(&state, &mut pending, &mut wakes).await?;
    loop {
        let ready: Vec<_> = pending
            .iter()
            .filter(|agent_id| !running.values().any(|(running, _)| running == *agent_id))
            .cloned()
            .collect();
        for agent_id in ready {
            pending.remove(&agent_id);
            let goal = match state.store.agent_goal(&agent_id).await {
                Ok(goal) => goal.filter(|goal| goal.status == AgentGoalStatusV1::Active),
                Err(_) => {
                    wakes.failed(Owed::Agent(agent_id), "agent_goal_store_failed", clock()?);
                    continue;
                }
            };
            let revision = goal.as_ref().map(|goal| goal.revision);
            let worker = Arc::clone(&state);
            let target = agent_id.clone();
            let task = jobs.spawn(async move { advance(&worker, &target, goal.as_ref()).await });
            running.insert(task.id(), (agent_id, revision));
        }
        let next_wake = wakes.until_next(clock()?);
        tokio::select! {
            _ = tokio::time::sleep(next_wake.unwrap_or_default()), if next_wake.is_some() => {
                for owed in wakes.take_due(clock()?) {
                    match owed {
                        Owed::Agent(agent_id) => { pending.insert(agent_id); }
                        Owed::Scan => scan(&state, &mut pending, &mut wakes).await?,
                    }
                }
            }
            _ = state.goal_wakeup.notified() => scan(&state, &mut pending, &mut wakes).await?,
            Some(agent_id) = native_failures.recv() => {
                pending.insert(agent_id);
            }
            notification = notifications.recv() => match notification {
                Ok(notification) => {
                    if notification.kinds.iter().all(|kind| matches!(kind, AgentConversationNotificationKindV1::LiveText | AgentConversationNotificationKindV1::Goal | AgentConversationNotificationKindV1::Recovery)) { continue; }
                    match state.store.agent_interaction(&notification.interaction_session_id).await {
                        Ok(Some(binding)) => { pending.insert(binding.agent_id); }
                        Ok(None) => {}
                        Err(_) => wakes.owe_scan("agent_conversation_store_failed", clock()?),
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => scan(&state, &mut pending, &mut wakes).await?,
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            },
            completed = jobs.join_next_with_id(), if !jobs.is_empty() => {
                let Some(completed) = completed else { continue; };
                let (id, outcome) = match completed {
                    Ok((id, result)) => (id, result),
                    Err(error) => (error.id(), Err(Stalled::owed("agent_conversation_worker_failed"))),
                };
                let Some((agent_id, revision)) = running.remove(&id) else { continue; };
                let owed = Owed::Agent(agent_id.clone());
                match outcome {
                    Ok(Some(at)) => wakes.hold(owed, at),
                    Ok(None) => wakes.settle(&owed),
                    Err(stalled) => {
                        let goal_recorded = match revision {
                            Some(revision) => fail_goal(&state, &agent_id, revision, stalled.code).await,
                            None => true,
                        };
                        if stalled.owed || !goal_recorded {
                            wakes.failed(owed, stalled.code, clock()?);
                        } else {
                            eprintln!("Dure conversation {agent_id} continuation failed: {}", stalled.code);
                            wakes.settle(&owed);
                        }
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

/// Ends only when notifications close or the clock is unreadable: a store
/// failure leaves its work owed instead.
pub(crate) async fn run(state: Arc<ServiceState>) {
    if let Err(code) = run_inner(state).await {
        eprintln!("Dure conversation continuation stopped: {code}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_doubles_up_to_the_cap() {
        let delays: Vec<_> = (1..=7).map(retry_delay_ms).collect();
        assert_eq!(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
        assert_eq!(retry_delay_ms(u32::MAX), RETRY_MAX_MS);
    }

    #[test]
    fn a_due_step_is_taken_once_and_unresolved_notifications_share_one_scan() {
        let agent = Owed::Agent(AgentIdV1::new("agent-1").unwrap());
        let mut wakes = Wakes::default();
        wakes.failed(agent.clone(), "agent_queue_store_failed", 0);
        wakes.owe_scan("agent_conversation_store_failed", 0);
        wakes.owe_scan("agent_conversation_store_failed", 0);
        assert_eq!(wakes.until_next(0), Some(Duration::from_secs(1)));
        assert!(wakes.take_due(999).is_empty());

        assert_eq!(wakes.take_due(1_000), [Owed::Scan, agent.clone()]);
        assert_eq!(
            wakes.until_next(1_000),
            None,
            "a taken step is not due again"
        );

        // The run continues: the next failure waits twice as long.
        wakes.failed(agent.clone(), "agent_queue_store_failed", 1_000);
        assert_eq!(wakes.until_next(1_000), Some(Duration::from_secs(2)));
        // A recovery hold replaces the retry and ends the run.
        wakes.hold(agent.clone(), 10_000);
        assert_eq!(wakes.until_next(1_000), Some(Duration::from_secs(9)));
        wakes.settle(&agent);
        wakes.failed(agent.clone(), "agent_queue_store_failed", 1_000);
        assert_eq!(wakes.until_next(1_000), Some(Duration::from_secs(1)));
    }
}
