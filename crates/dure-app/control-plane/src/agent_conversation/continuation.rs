//! One event-driven execution loop for queued human input and explicit goals.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use dure_app::{
    AgentGoalRecordV1, AgentGoalStatusV1, AgentGoalStore, AgentIdV1, AgentQueuedTurnStore,
    AgentTimelineStore,
};
use tokio::sync::broadcast;
use tokio::task::{Id, JoinSet};

use crate::agent_conversation::AgentConversationNotificationKindV1;
use crate::agent_conversation_api::AgentConversationApiErrorV1;
use crate::{ServiceState, agent_goal, now_ms};

async fn enqueue_active(
    state: &ServiceState,
    pending: &mut BTreeSet<AgentIdV1>,
) -> Result<(), &'static str> {
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

async fn advance(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    goal: Option<&AgentGoalRecordV1>,
) -> Result<(), &'static str> {
    let binding = state
        .store
        .agent_interaction_for_agent(agent_id)
        .await
        .map_err(|_| "agent_conversation_store_failed")?
        .ok_or("agent_conversation_not_found")?;
    if state
        .store
        .has_queued_agent_turns(&binding.interaction_session_id)
        .await
        .map_err(|_| "agent_queue_store_failed")?
    {
        return match state.agent_conversations.start_queued_turn(&binding).await {
            // Runtime recovery publishes readiness; no effect was claimed.
            Ok(_) | Err(AgentConversationApiErrorV1::RuntimeUnavailable) => Ok(()),
            Err(error) => Err(error.code()),
        };
    }
    match goal {
        Some(goal) => agent_goal::advance(state, goal).await,
        None => Ok(()),
    }
}

async fn run_inner(state: Arc<ServiceState>) -> Result<(), &'static str> {
    state.wait_for_mutation_authority().await;
    let mut notifications = state.agent_conversations.notifications();
    let mut pending = BTreeSet::new();
    let mut running: HashMap<Id, (AgentIdV1, Option<u64>)> = HashMap::new();
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
        tokio::select! {
            _ = state.goal_wakeup.notified() => enqueue_active(&state, &mut pending).await?,
            notification = notifications.recv() => match notification {
                Ok(notification) => {
                    if notification.kinds.iter().all(|kind| matches!(kind, AgentConversationNotificationKindV1::LiveText | AgentConversationNotificationKindV1::Goal)) { continue; }
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
                if let Some((agent_id, revision)) = running.remove(&id)
                    && let Err(code) = outcome {
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

pub(crate) async fn run(state: Arc<ServiceState>) {
    if let Err(code) = run_inner(state).await {
        eprintln!("Dure conversation continuation stopped: {code}");
    }
}
