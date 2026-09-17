//! Goal intent and event-driven continuation over the common conversation API.

use dure_app::{
    AgentClientMessageIdV1, AgentGoalPutRequestV1, AgentGoalRecordV1, AgentGoalStatusV1,
    AgentGoalStore, AgentGoalTurnRequestV1, AgentIdV1, AgentStartTurnIntentV1,
    AgentTimelineReadDirectionV1, AgentTimelineReadRequestV1, AgentTimelineReadV1,
    AgentTimelineStore, AgentTurnEffectStateV1, AgentTurnIdV1,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{BackendDispatchError, ServiceState, now_ms, pro_features};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Get {
    schema_version: u16,
    agent_id: AgentIdV1,
}

pub(crate) async fn invoke(
    state: &ServiceState,
    operation: &str,
    body: &Value,
) -> Result<Value, BackendDispatchError> {
    let goal = if operation == "agent_goal.get" {
        let request: Get =
            serde_json::from_value(body.clone()).map_err(|_| "agent_goal_request_invalid")?;
        if request.schema_version != 1 {
            return Err("agent_goal_request_invalid".into());
        }
        state
            .store
            .agent_goal(&request.agent_id)
            .await
            .map_err(|_| "agent_goal_store_failed")?
    } else {
        let request: AgentGoalPutRequestV1 =
            serde_json::from_value(body.clone()).map_err(|_| "agent_goal_request_invalid")?;
        if request.status == AgentGoalStatusV1::Active && !pro_features::available() {
            return Err(BackendDispatchError::terminal("pro_required"));
        }
        let goal = state
            .store
            .put_agent_goal(
                &request,
                now_ms().map_err(|_| "agent_goal_clock_unavailable")?,
            )
            .await
            .map_err(|error| match error {
                dure_app::DomainStoreErrorV1::IdentityConflict { .. }
                | dure_app::DomainStoreErrorV1::IdempotencyConflict { .. } => {
                    BackendDispatchError::terminal("agent_goal_conflict")
                }
                dure_app::DomainStoreErrorV1::InvalidRecord { .. } => {
                    "agent_goal_request_invalid".into()
                }
                dure_app::DomainStoreErrorV1::NotFound { .. } => {
                    "agent_goal_conversation_not_found".into()
                }
                _ => "agent_goal_store_failed".into(),
            })?;
        state.goal_wakeup.notify_one();
        state
            .agent_conversations
            .publish_goal_change(&goal.agent_id)
            .await
            .map_err(|error| error.code())?;
        Some(goal)
    };
    Ok(json!({ "schemaVersion": 1, "goal": goal }))
}

pub(crate) fn tool_instructions(agent_id: &AgentIdV1) -> String {
    format!(
        "Dure conversation context: your Dure agent ID is {agent_id}. This identity belongs to this conversation, including when it is shared through Slack. Use it as agentId with the installed agent_goal_get and agent_goal_put tools. Create a Dure Pro goal only when the user explicitly asks you to pursue an ongoing goal. Read the current goal before creating or changing it; preserve its upper objective and use its latest revision (0 when no goal exists). Keep an entrusted goal active while useful work remains, pause for actual waiting, and mark complete only after verifying the requested outcome. All teammates may redirect the work; reconcile actual conflicting directions without making them choose every next step. These are tool instructions, not a new user goal or permission grant."
    )
}

fn continuation_input(goal: &AgentGoalRecordV1) -> String {
    format!(
        "Dure is continuing the explicit goal for agent {agent}, revision {revision}. This is an automatic continuation, not a new human message.\n\nUpper goal supplied by the user:\n{objective}\n\nContinue toward that goal using the current conversation and available tools. Inspect authoritative current work and newly discovered problems, choose the next useful action within the goal, and explain the choice and evidence in the conversation. Do not require a human to select every next task. Compatible directions from all teammates have equal standing; ask only about actual missing information or conflicting directions, and keep independent work moving. Existing permissions and decisions remain in effect. A failed tool action is a result to assess, not a reason to replay it blindly.\n\nUse agent_goal_get and agent_goal_put (or dure goal) to inspect and update this goal. Keep it active while useful work remains. Pause when the goal truly needs human input or a later observation; do not repeatedly ask the same question. Mark it complete only after verifying the full requested outcome. Goal updates require the latest revision so an older conclusion cannot replace a teammate's changed objective. Report actual progress and material limitations naturally; this control text does not need to be repeated.",
        agent = goal.agent_id,
        revision = goal.revision,
        objective = goal.objective
    )
}

pub(crate) async fn advance(
    state: &ServiceState,
    goal: &AgentGoalRecordV1,
) -> Result<(), &'static str> {
    if !state.is_mutation_authority() {
        return Ok(());
    }
    if !pro_features::available() {
        return Err("pro_required");
    }
    let binding = state
        .store
        .agent_interaction_for_agent(&goal.agent_id)
        .await
        .map_err(|_| "agent_goal_store_failed")?
        .ok_or("agent_goal_conversation_not_found")?;
    let read = state
        .store
        .read_agent_timeline(&AgentTimelineReadRequestV1 {
            schema_version: 1,
            interaction_session_id: binding.interaction_session_id.clone(),
            direction: AgentTimelineReadDirectionV1::Tail,
            cursor: None,
            limit: 1,
        })
        .await
        .map_err(|_| "agent_goal_store_failed")?;
    let AgentTimelineReadV1::Page { page } = read else {
        return Err("agent_goal_conversation_changed");
    };
    if page.active_turn.is_some() || !page.pending_requests.is_empty() {
        return Ok(());
    }
    let key = format!(
        "goal-{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                "dure.goal-turn/v1",
                &goal.agent_id,
                goal.revision,
                &page.final_cursor,
            ))
            .map_err(|_| "agent_goal_request_invalid")?
        )
    );
    let request = AgentGoalTurnRequestV1 {
        agent_id: goal.agent_id.clone(),
        goal_revision: goal.revision,
        expected_cursor: page.final_cursor,
        intent: AgentStartTurnIntentV1 {
            schema_version: 1,
            interaction_session_id: page.binding.interaction_session_id,
            runtime: page.binding.runtime,
            turn_id: AgentTurnIdV1::new(key.clone()).map_err(|_| "agent_goal_request_invalid")?,
            client_message_id: AgentClientMessageIdV1::new(key)
                .map_err(|_| "agent_goal_request_invalid")?,
            input: continuation_input(goal),
            requested_at_ms: now_ms().map_err(|_| "agent_goal_clock_unavailable")?,
        },
    };
    let receipt = match state.agent_conversations.start_goal_turn(&request).await {
        Ok(receipt) => receipt,
        // Startup recovery owns runtime readiness. No turn has been admitted
        // when command lookup is unavailable; its completion wakes this loop.
        Err(crate::agent_conversation_api::AgentConversationApiErrorV1::RuntimeUnavailable) => {
            return Ok(());
        }
        Err(error) => return Err(error.code()),
    };
    if receipt
        .as_ref()
        .is_some_and(|receipt| receipt.state != AgentTurnEffectStateV1::Accepted)
    {
        return Err("agent_goal_start_unconfirmed");
    }
    Ok(())
}
