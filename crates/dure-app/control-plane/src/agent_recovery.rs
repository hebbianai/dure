//! Automatic account recovery over the existing runtime and conversation owners.

use dure_app::{
    AgentIdV1, AgentInteractionProfileV1, AgentRecoveryRecordV1, AgentRecoveryStopV1,
    AgentRecoveryStore, AgentRuntimeSourceStopPolicyV1, AgentRuntimeTransitionStateV1,
    AgentRuntimeTransitionStore, AgentTimelineReadDirectionV1, AgentTimelineReadRequestV1,
    AgentTimelineReadV1, AgentTimelineStore, AgentTurnEffectStateV1, ProviderRecoveryStore,
    agent_runtime_transition_identity,
};

use crate::agent_conversation_api::AgentConversationApiErrorV1;
use crate::agent_runtime_projection::AgentRuntimeObservedV1;
use crate::agent_runtime_transition_apply::{self, AgentRuntimeTransitionApplyBodyV1};
use crate::{ServiceState, now_ms, pro_features};

async fn stop(
    state: &ServiceState,
    record: &AgentRecoveryRecordV1,
    reason: AgentRecoveryStopV1,
) -> Result<bool, &'static str> {
    let stopped = state
        .store
        .stop_agent_recovery(&record.attempt_id, &reason)
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    stopped_result(stopped.stopped.as_ref())
}

fn stopped_result(reason: Option<&AgentRecoveryStopV1>) -> Result<bool, &'static str> {
    match reason {
        Some(AgentRecoveryStopV1::Exhausted) => Err("agent_recovery_accounts_exhausted"),
        Some(AgentRecoveryStopV1::Failed { .. }) => Err("agent_recovery_failed"),
        Some(AgentRecoveryStopV1::Superseded) | None => Ok(false),
    }
}

async fn may_start(
    state: &ServiceState,
    record: &AgentRecoveryRecordV1,
) -> Result<bool, &'static str> {
    let policy = state
        .store
        .provider_recovery_policy(&record.source.provider_id)
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    if !policy.as_ref().is_some_and(|policy| {
        policy.enabled
            && policy
                .activated_at_ms
                .is_some_and(|at| at <= record.failure.created_at_ms)
            && record.target.as_ref().is_some_and(|target| {
                policy
                    .accounts
                    .iter()
                    .any(|account| account.profile == target.profile)
            })
    }) {
        return Ok(false);
    }
    let read = state
        .store
        .read_agent_timeline(&AgentTimelineReadRequestV1 {
            schema_version: 1,
            interaction_session_id: record.source.interaction_session_id.clone(),
            direction: AgentTimelineReadDirectionV1::Tail,
            cursor: None,
            limit: 1,
        })
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    Ok(matches!(read, AgentTimelineReadV1::Page { page }
        if page.binding.interaction_session_id == record.source.interaction_session_id
            && page.binding.agent_id == record.source.agent_id
            && page.binding.provider_id == record.source.provider_id
            && page.binding.execution_profile == record.source.execution_profile
            && page.binding.timeline_epoch == record.source.timeline_epoch
            && page.binding.provider_conversation_ref == record.source.provider_conversation_ref
            && page.latest_failure.as_ref() == Some(&record.failure)
            && page.active_turn.is_none() && page.pending_requests.is_empty()
            && page.goal.as_ref().map(|goal| goal.revision) == record.goal_revision))
}

/// True means this failure still owns automatic continuation. Human queue
/// admission retains priority in the caller, including when recovery stops.
pub(crate) async fn advance(
    state: &ServiceState,
    agent_id: &AgentIdV1,
) -> Result<bool, &'static str> {
    if !state.is_mutation_authority() || !pro_features::available() {
        return Ok(false);
    }
    // Recovery and manual runtime changes use the same per-Agent order.
    let _agent_guard = state.agent_operations.acquire(agent_id).await;
    let before = state
        .store
        .latest_agent_recovery(agent_id)
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    let result = advance_locked(state, agent_id).await;
    let after = state
        .store
        .latest_agent_recovery(agent_id)
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    if before != after {
        state
            .agent_conversations
            .publish_recovery_change(agent_id)
            .await
            .map_err(|error| error.code())?;
    }
    result
}

async fn advance_locked(state: &ServiceState, agent_id: &AgentIdV1) -> Result<bool, &'static str> {
    let Some(record) = state
        .store
        .prepare_agent_recovery(
            agent_id,
            now_ms().map_err(|_| "agent_recovery_clock_unavailable")?,
        )
        .await
        .map_err(|_| "agent_recovery_store_failed")?
    else {
        return Ok(false);
    };
    if record.stopped.is_some() {
        return stopped_result(record.stopped.as_ref());
    }
    let (operation_id, _) = agent_runtime_transition_identity(&record.attempt_id)
        .map_err(|_| "agent_recovery_identity_invalid")?;
    let current = crate::agent_runtime_projection::read_locked(state, agent_id)
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    let owns_runtime = match current {
        AgentRuntimeObservedV1::Stable { selection, .. } => {
            (selection.revision == record.source_selection_revision
                && selection.interaction_profile == AgentInteractionProfileV1::StructuredProtocol
                && selection.execution_profile == record.source.execution_profile)
                || selection.selected_by_operation_id.as_ref() == Some(&operation_id)
        }
        AgentRuntimeObservedV1::Transitioning { transition, .. } => {
            transition.intent.operation_id == operation_id
        }
        AgentRuntimeObservedV1::Closed(_) | AgentRuntimeObservedV1::Unmanaged => false,
    };
    if !owns_runtime {
        return stop(state, &record, AgentRecoveryStopV1::Superseded).await;
    }
    let transition = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    match transition.as_ref().map(|transition| transition.state) {
        Some(
            AgentRuntimeTransitionStateV1::RepairRequired
            | AgentRuntimeTransitionStateV1::SourceRetained,
        ) => {
            return stop(
                state,
                &record,
                AgentRecoveryStopV1::Failed {
                    code: "agent_runtime_repair_required".into(),
                },
            )
            .await;
        }
        Some(AgentRuntimeTransitionStateV1::Superseded) => {
            return stop(state, &record, AgentRecoveryStopV1::Superseded).await;
        }
        None if !may_start(state, &record).await? => {
            return stop(state, &record, AgentRecoveryStopV1::Superseded).await;
        }
        _ => {}
    }
    if !transition
        .is_some_and(|transition| transition.state == AgentRuntimeTransitionStateV1::Committed)
    {
        let Some(target) = &record.target else {
            return Err("agent_recovery_accounts_exhausted");
        };
        if let Err(error) = agent_runtime_transition_apply::apply_locked(
            state,
            &record.attempt_id,
            AgentRuntimeTransitionApplyBodyV1 {
                schema_version: 1,
                agent_id: agent_id.clone(),
                target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
                expected_source_revision: Some(record.source_selection_revision),
                source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
                target_execution_profile: Some(target.execution_profile()),
                target_launch_selection: None,
            },
        )
        .await
        {
            return stop(
                state,
                &record,
                AgentRecoveryStopV1::Failed { code: error.code },
            )
            .await;
        }
    }
    match state.agent_conversations.start_recovery_turn(&record).await {
        Ok(Some(receipt)) if receipt.state == AgentTurnEffectStateV1::Accepted => Ok(true),
        Ok(Some(_)) => Err("agent_recovery_turn_unconfirmed"),
        Ok(None) => Ok(false),
        // The runtime owner publishes readiness when startup recovery finishes.
        Err(AgentConversationApiErrorV1::RuntimeUnavailable) => Ok(true),
        Err(error) => {
            stop(
                state,
                &record,
                AgentRecoveryStopV1::Failed {
                    code: error.code().into(),
                },
            )
            .await?;
            Err(error.code())
        }
    }
}
