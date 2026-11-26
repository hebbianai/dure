//! Automatic account recovery over the existing runtime and conversation owners.
//!
//! One owner serves both runtime modes. A Chat Agent's failure is its
//! timeline's failed turn, and recovery retries that turn on the next account.
//! A native terminal Agent's failure is the turn its Hmux Host saw settle on a
//! typed limit failure; recovery moves the same conversation to the next
//! account in the terminal and sends it one fixed prompt to continue.

mod native_scan;

pub(crate) use native_scan::scan_native_failures;

use dure_app::{
    AgentCheckpointBindingAuthorityV1, AgentIdV1, AgentInteractionProfileV1,
    AgentNativeRecoveryContinuationV1, AgentNativeRecoveryRecordV1, AgentNativeTurnFailureV1,
    AgentRecoveryAttemptV1, AgentRecoveryStopV1, AgentRecoveryStore,
    AgentRuntimeBindingAuthorityV1, AgentRuntimeSelectionV1, AgentRuntimeSourceStopPolicyV1,
    AgentRuntimeTransitionStateV1, AgentRuntimeTransitionStore, AgentTimelineReadDirectionV1,
    AgentTimelineReadRequestV1, AgentTimelineReadV1, AgentTimelineStore, AgentTurnEffectStateV1,
    OperationIdV1, ProviderRecoveryStore, RuntimeKindIdV1, WorkflowPromptDeliveryIntentV1,
    WorkflowPromptDeliveryRequestV1, WorkflowSessionGenerationV1,
    agent_runtime_transition_identity,
};

use crate::agent_conversation_api::AgentConversationApiErrorV1;
use crate::agent_runtime_projection::{AgentRuntimeObservedV1, read_locked};
use crate::agent_runtime_transition_apply::{self, AgentRuntimeTransitionApplyBodyV1};
use crate::hmux_session_inspection::HmuxSessionInspection;
use crate::{
    ServiceState, authority_stop_fence, now_ms, pro_features, query_hmux_for_runtime_transition,
};

/// The one prompt a native Agent receives after its conversation moved to
/// another account. Fixed text, so it never carries provider output.
const NATIVE_CONTINUATION: &str = "Your previous turn stopped at a usage limit. Dure moved this \
    conversation to another account; continue where you left off.";

/// How long the resumed conversation has to become ready for its prompt
/// after the account switch committed.
const NATIVE_TARGET_READY_TIMEOUT_MS: i64 = 120_000;

async fn stop(
    state: &ServiceState,
    record: &AgentRecoveryAttemptV1,
    reason: AgentRecoveryStopV1,
) -> Result<bool, &'static str> {
    let stopped = state
        .store
        .stop_agent_recovery(record.attempt_id(), &reason)
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    stopped_result(stopped.stopped())
}

fn stopped_result(reason: Option<&AgentRecoveryStopV1>) -> Result<bool, &'static str> {
    match reason {
        Some(AgentRecoveryStopV1::Exhausted) => Err("agent_recovery_accounts_exhausted"),
        Some(AgentRecoveryStopV1::Failed { .. }) => Err("agent_recovery_failed"),
        Some(AgentRecoveryStopV1::Superseded) | None => Ok(false),
    }
}

/// Whether the provider's recovery policy still covers this failure and
/// still offers the attempt's target account.
async fn policy_allows(
    state: &ServiceState,
    record: &AgentRecoveryAttemptV1,
) -> Result<bool, &'static str> {
    let policy = state
        .store
        .provider_recovery_policy(record.provider_id())
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    Ok(policy.as_ref().is_some_and(|policy| {
        policy.enabled
            && policy
                .activated_at_ms
                .is_some_and(|at| at <= record.failure_created_at_ms())
            && record.target().is_some_and(|target| {
                policy
                    .accounts
                    .iter()
                    .any(|account| account.profile == target.profile)
            })
    }))
}

async fn may_start(
    state: &ServiceState,
    record: &AgentRecoveryAttemptV1,
) -> Result<bool, &'static str> {
    if !policy_allows(state, record).await? {
        return Ok(false);
    }
    let record = match record {
        AgentRecoveryAttemptV1::Native(record) => {
            // A person who resumed the conversation, or a new turn, wins:
            // the Host must still show the exact failure that was recorded.
            return Ok(stable_native(state, &record.agent_id).await?.is_some_and(
                |(selection, _, inspection)| {
                    selection.revision == record.source_selection_revision
                        && inspection.terminal_epoch == record.native_failure.terminal_epoch
                        && inspection.attention_id()
                            == Some(record.native_failure.attention_id.as_str())
                        && inspection.settled_turn_failure() == Some(record.native_failure.reason)
                },
            ));
        }
        AgentRecoveryAttemptV1::Conversation(record) => record,
    };
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
    let observed_at_ms = now_ms().map_err(|_| "agent_recovery_clock_unavailable")?;
    let native = observe_native_failure(state, agent_id, observed_at_ms).await?;
    let Some(record) = state
        .store
        .prepare_agent_recovery(agent_id, observed_at_ms, native.as_ref())
        .await
        .map_err(|_| "agent_recovery_store_failed")?
    else {
        return Ok(false);
    };
    if record.stopped().is_some() {
        return stopped_result(record.stopped());
    }
    let (operation_id, _) = agent_runtime_transition_identity(record.attempt_id())
        .map_err(|_| "agent_recovery_identity_invalid")?;
    let current = read_locked(state, agent_id)
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    let owns_runtime = match current {
        AgentRuntimeObservedV1::Stable { selection, .. } => {
            (selection.revision == record.source_selection_revision()
                && selection.interaction_profile == record.source_interaction_profile()
                && &selection.execution_profile == record.source_execution_profile())
                || selection.selected_by_operation_id.as_ref() == Some(&operation_id)
        }
        AgentRuntimeObservedV1::Transitioning { transition, .. } => {
            transition.intent.operation_id == operation_id
        }
        AgentRuntimeObservedV1::Closed { .. } | AgentRuntimeObservedV1::Unmanaged => false,
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
        let Some(target) = record.target() else {
            return Err("agent_recovery_accounts_exhausted");
        };
        // The conversation stays in the runtime mode it failed in. Preserve
        // stops a native source only at its exact settled failure.
        if let Err(error) = agent_runtime_transition_apply::apply_locked(
            state,
            record.attempt_id(),
            AgentRuntimeTransitionApplyBodyV1 {
                schema_version: 1,
                agent_id: agent_id.clone(),
                target_interaction_profile: record.source_interaction_profile(),
                expected_source_revision: Some(record.source_selection_revision()),
                expected_operation_id: None,
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
    let record = match record {
        AgentRecoveryAttemptV1::Native(native) => {
            return continue_native(state, &native, &operation_id).await;
        }
        AgentRecoveryAttemptV1::Conversation(record) => record,
    };
    match state.agent_conversations.start_recovery_turn(&record).await {
        Ok(Some(receipt)) if receipt.state == AgentTurnEffectStateV1::Accepted => Ok(true),
        Ok(Some(_)) => Err("agent_recovery_turn_unconfirmed"),
        Ok(None) => Ok(false),
        // The runtime owner publishes readiness when startup recovery finishes.
        Err(AgentConversationApiErrorV1::RuntimeUnavailable) => Ok(true),
        Err(error) => {
            stop(
                state,
                &AgentRecoveryAttemptV1::Conversation(record),
                AgentRecoveryStopV1::Failed {
                    code: error.code().into(),
                },
            )
            .await?;
            Err(error.code())
        }
    }
}

/// The stable native terminal runtime of an Agent and its exact Host
/// observation, or `None` when the Agent is not one or its Host cannot say.
async fn stable_native(
    state: &ServiceState,
    agent_id: &AgentIdV1,
) -> Result<
    Option<(
        AgentRuntimeSelectionV1,
        AgentCheckpointBindingAuthorityV1,
        HmuxSessionInspection,
    )>,
    &'static str,
> {
    let AgentRuntimeObservedV1::Stable {
        selection,
        authority,
    } = read_locked(state, agent_id)
        .await
        .map_err(|_| "agent_recovery_store_failed")?
    else {
        return Ok(None);
    };
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = *authority else {
        return Ok(None);
    };
    if selection.interaction_profile != AgentInteractionProfileV1::NativeCli {
        return Ok(None);
    }
    // An unreachable Host proves nothing; the next wake inspects again.
    let Ok(inspection) = query_hmux_for_runtime_transition(
        &state.hmux_identity,
        &authority.binding.session_id,
        &authority.runtime_workspace_id,
        &authority_stop_fence(&authority),
    )
    .await
    else {
        return Ok(None);
    };
    if inspection.provider_id != selection.provider_id.as_str() {
        return Ok(None);
    }
    Ok(Some((*selection, authority, inspection)))
}

/// The settled limit failure a native terminal Agent's Host shows now, when
/// its provider has recovery enabled. Only the Host's typed failure counts;
/// terminal output never does.
async fn observe_native_failure(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    observed_at_ms: i64,
) -> Result<Option<AgentNativeTurnFailureV1>, &'static str> {
    let Some(selection) = state
        .store
        .agent_runtime_selection(agent_id)
        .await
        .map_err(|_| "agent_recovery_store_failed")?
        .filter(|selection| selection.interaction_profile == AgentInteractionProfileV1::NativeCli)
    else {
        return Ok(None);
    };
    if !state
        .store
        .provider_recovery_policy(&selection.provider_id)
        .await
        .map_err(|_| "agent_recovery_store_failed")?
        .is_some_and(|policy| policy.enabled)
    {
        return Ok(None);
    }
    let Some((_, _, inspection)) = stable_native(state, agent_id).await? else {
        return Ok(None);
    };
    let (Some(reason), Some(attention_id)) =
        (inspection.settled_turn_failure(), inspection.attention_id())
    else {
        return Ok(None);
    };
    Ok(Some(AgentNativeTurnFailureV1 {
        terminal_epoch: inspection.terminal_epoch.clone(),
        attention_id: attention_id.to_owned(),
        reason,
        observed_at_ms,
    }))
}

/// Sends the resumed conversation its one continuation prompt. The prompt is
/// claimed before it is written: a refusal that proves nothing was written
/// releases it for the next wake, and a prompt that may have been written is
/// never written again.
async fn continue_native(
    state: &ServiceState,
    record: &AgentNativeRecoveryRecordV1,
    operation_id: &OperationIdV1,
) -> Result<bool, &'static str> {
    let attempt = AgentRecoveryAttemptV1::Native(record.clone());
    match &record.continuation {
        AgentNativeRecoveryContinuationV1::Delivered { .. } => return Ok(false),
        // A claim found on replay may already have reached the terminal.
        AgentNativeRecoveryContinuationV1::Claimed { .. } => {
            return stop(
                state,
                &attempt,
                AgentRecoveryStopV1::Failed {
                    code: "agent_recovery_continuation_uncertain".into(),
                },
            )
            .await;
        }
        AgentNativeRecoveryContinuationV1::NotStarted => {}
    }
    let Some(transition) = state
        .store
        .agent_runtime_transition(operation_id)
        .await
        .map_err(|_| "agent_recovery_store_failed")?
        .filter(|transition| transition.state == AgentRuntimeTransitionStateV1::Committed)
    else {
        // The runtime journal still owns the switch; wake again later.
        return Ok(true);
    };
    let switched = stable_native(state, &record.agent_id).await?;
    let still_switched = match &switched {
        Some((selection, _, _)) => {
            selection.selected_by_operation_id.as_ref() == Some(operation_id)
                && Some(selection.revision) == record.source_selection_revision.checked_add(1)
                && policy_allows(state, &attempt).await?
        }
        // The Host may still be starting; the selection decides ownership.
        None => match read_locked(state, &record.agent_id)
            .await
            .map_err(|_| "agent_recovery_store_failed")?
        {
            AgentRuntimeObservedV1::Stable { selection, .. } => {
                selection.selected_by_operation_id.as_ref() == Some(operation_id)
            }
            _ => false,
        },
    };
    if !still_switched {
        return stop(state, &attempt, AgentRecoveryStopV1::Superseded).await;
    }
    let ready = switched.and_then(|(selection, authority, inspection)| {
        let conversation = inspection
            .provider_conversation_identity
            .as_ref()
            .map(|identity| identity.conversation_id.clone())
            .or_else(|| authority.binding.provider_conversation_id.clone())?;
        inspection.is_agent_quiescent().then_some((
            WorkflowSessionGenerationV1 {
                session_id: authority.binding.session_id,
                workspace_id: authority.runtime_workspace_id,
                provider_id: selection.provider_id,
                runner_principal: authority.runner_principal,
                runner_instance: authority.runner_instance,
                channel_epoch: authority.channel_epoch,
                host_instance_id: authority.host_instance_id,
                terminal_epoch: authority.terminal_epoch,
            },
            conversation,
        ))
    });
    let Some((session, provider_conversation_id)) = ready else {
        let now = now_ms().map_err(|_| "agent_recovery_clock_unavailable")?;
        if now.saturating_sub(transition.updated_at_ms) > NATIVE_TARGET_READY_TIMEOUT_MS {
            return stop(
                state,
                &attempt,
                AgentRecoveryStopV1::Failed {
                    code: "agent_recovery_target_not_ready".into(),
                },
            )
            .await;
        }
        return Ok(true);
    };
    let delivery_idempotency_key = format!("recovery:{}", record.attempt_id);
    let claimed = state
        .store
        .claim_native_agent_recovery_continuation(&record.attempt_id, &delivery_idempotency_key)
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    if claimed.continuation
        != (AgentNativeRecoveryContinuationV1::Claimed {
            delivery_idempotency_key: delivery_idempotency_key.clone(),
        })
    {
        return Ok(false);
    }
    let request = WorkflowPromptDeliveryRequestV1 {
        runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux")
            .map_err(|_| "agent_recovery_identity_invalid")?,
        delivery_idempotency_key,
        session,
        intent: WorkflowPromptDeliveryIntentV1::ExistingConversation {
            provider_conversation_id,
        },
        handoff: NATIVE_CONTINUATION.to_owned(),
    };
    match state.workflow_prompt_deliverer.deliver(request).await {
        Ok(evidence) => {
            state
                .store
                .settle_native_agent_recovery_continuation(&record.attempt_id, Some(&evidence))
                .await
                .map_err(|_| "agent_recovery_store_failed")?;
            Ok(true)
        }
        Err(failure) if !failure.may_have_written => {
            state
                .store
                .settle_native_agent_recovery_continuation(&record.attempt_id, None)
                .await
                .map_err(|_| "agent_recovery_store_failed")?;
            Ok(true)
        }
        Err(failure) => {
            stop(
                state,
                &attempt,
                AgentRecoveryStopV1::Failed { code: failure.code },
            )
            .await
        }
    }
}
