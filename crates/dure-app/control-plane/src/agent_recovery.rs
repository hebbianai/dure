//! Automatic account recovery over the existing runtime and conversation owners.
//!
//! One owner serves both runtime modes. A Chat Agent's failure is its
//! timeline's failed turn, and recovery retries that turn on the next account.
//! A native terminal Agent's failure is the turn its Hmux Host saw settle on a
//! typed limit failure; recovery moves the same conversation to the next
//! account in the terminal, or with no account waits for the login's reported
//! reset, and sends it one fixed prompt to continue.

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
};

use crate::agent_conversation_api::AgentConversationApiErrorV1;
use crate::agent_runtime_projection::{AgentRuntimeObservedV1, read_locked};
use crate::agent_runtime_transition_apply::{self, AgentRuntimeTransitionApplyBodyV1};
use crate::hmux_session_inspection::{HmuxSessionInspection, HmuxSessionInspectionFailure};
use crate::provider_credential_profile::ProviderCredentialProfileErrorV1;
use crate::{
    ServiceState, authority_stop_fence, now_ms, pro_features, query_hmux_for_runtime_transition,
};

/// The one prompt a native Agent receives after its conversation moved to
/// another account. Fixed text, so it never carries provider output.
const NATIVE_CONTINUATION: &str = "Your previous turn stopped at a usage limit. Dure moved this \
    conversation to another account; continue where you left off.";

/// The one prompt a native Agent receives in the same terminal once the limit
/// that stopped it has reset.
const NATIVE_RESET_CONTINUATION: &str = "Your previous turn stopped at a usage limit, which has \
    now reset; continue where you left off.";

/// How long the resumed conversation has to become ready for its prompt
/// after the account switch committed.
const NATIVE_TARGET_READY_TIMEOUT_MS: i64 = 120_000;

/// What automatic recovery holds for an Agent after one step.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AgentRecoveryHoldV1 {
    /// No recovery owns the conversation's next turn.
    Released,
    /// Recovery owns the next turn: a switch or send is underway or retained.
    Owned,
    /// Recovery owns the next turn and sends it on the same account at this
    /// Unix millisecond, once the provider's limit has reset.
    WaitsUntil(i64),
}

impl AgentRecoveryHoldV1 {
    pub(crate) fn owns(self) -> bool {
        self != Self::Released
    }
}

async fn stop(
    state: &ServiceState,
    record: &AgentRecoveryAttemptV1,
    reason: AgentRecoveryStopV1,
) -> Result<AgentRecoveryHoldV1, &'static str> {
    let stopped = state
        .store
        .stop_agent_recovery(record.attempt_id(), &reason)
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    stopped_result(stopped.stopped())
}

fn stopped_result(
    reason: Option<&AgentRecoveryStopV1>,
) -> Result<AgentRecoveryHoldV1, &'static str> {
    match reason {
        Some(AgentRecoveryStopV1::Exhausted) => Err("agent_recovery_accounts_exhausted"),
        Some(AgentRecoveryStopV1::Failed { .. }) => Err("agent_recovery_failed"),
        Some(AgentRecoveryStopV1::Superseded) | None => Ok(AgentRecoveryHoldV1::Released),
    }
}

/// Whether the provider's recovery policy still covers this failure and
/// still permits the attempt's plan: its target account, or continuing on
/// the same account after the reported reset.
async fn policy_allows(
    state: &ServiceState,
    record: &AgentRecoveryAttemptV1,
) -> Result<bool, &'static str> {
    let policy = state
        .store
        .provider_recovery_policy(record.provider_id())
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    Ok(policy
        .as_ref()
        .is_some_and(|policy| record.permitted_by(policy)))
}

const REPAIR_REQUIRED: &str = "agent_runtime_repair_required";

/// Before a target's first apply, read what this host observes about the pool:
/// the app's latest usage feeds the usage owner, and logins known signed out,
/// out of the agent's model or shared with the source are set aside before the
/// owner selects again. Then the chosen login is asked whether it is signed
/// in, the way its launch would.
async fn check_target(
    state: &ServiceState,
    record: AgentRecoveryAttemptV1,
) -> Result<AgentRecoveryAttemptV1, &'static str> {
    let Some(policy) = state
        .store
        .provider_recovery_policy(record.provider_id())
        .await
        .map_err(|_| "agent_recovery_store_failed")?
    else {
        return Ok(record);
    };
    let observed_at_ms = now_ms().map_err(|_| "agent_recovery_clock_unavailable")?;
    // The target keeps the agent's model selection.
    let model = state
        .store
        .agent_runtime_selection(record.agent_id())
        .await
        .map_err(|_| "agent_recovery_store_failed")?
        .and_then(|selection| selection.model);
    let pool = state
        .credential_profiles
        .observe_recovery_pool(
            record.provider_id(),
            record.source_execution_profile(),
            model.as_ref().map(|model| model.as_str()),
            &policy.accounts,
            observed_at_ms,
        )
        .await;
    for usage in &pool.usage {
        state
            .store
            .observe_provider_recovery_usage(usage)
            .await
            .map_err(|_| "agent_recovery_store_failed")?;
    }
    let mut record = state
        .store
        .reselect_agent_recovery_target(record.attempt_id(), &pool.unusable, None, observed_at_ms)
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    while let Some(target) = record.target().filter(|_| record.stopped().is_none()) {
        if !state
            .credential_profiles
            .login_signed_out(
                record.provider_id(),
                &target.execution_profile(),
                observed_at_ms,
            )
            .await
        {
            break;
        }
        record = set_aside_target(state, &record, "agent_recovery_target_signed_out").await?;
    }
    Ok(record)
}

/// Sets the current target aside for this attempt and selects the next one.
async fn set_aside_target(
    state: &ServiceState,
    record: &AgentRecoveryAttemptV1,
    code: &str,
) -> Result<AgentRecoveryAttemptV1, &'static str> {
    let unusable = record
        .target()
        .map(|target| vec![target.profile.clone()])
        .unwrap_or_default();
    state
        .store
        .reselect_agent_recovery_target(
            record.attempt_id(),
            &unusable,
            Some(code),
            now_ms().map_err(|_| "agent_recovery_clock_unavailable")?,
        )
        .await
        .map_err(|_| "agent_recovery_store_failed")
}

/// A target failed when it could not start after the source stopped, or its
/// login was refused before anything was admitted. Source-side refusals are
/// not the account's fault and stop the attempt as before.
async fn target_failed(
    state: &ServiceState,
    record: &AgentRecoveryAttemptV1,
    code: &str,
) -> Result<bool, &'static str> {
    let operation_id = record
        .runtime_operation_id()
        .map_err(|_| "agent_recovery_identity_invalid")?;
    let transition = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .map_err(|_| "agent_recovery_store_failed")?;
    Ok(match transition.map(|transition| transition.state) {
        Some(AgentRuntimeTransitionStateV1::RepairRequired) => true,
        None => [
            ProviderCredentialProfileErrorV1::Unavailable,
            ProviderCredentialProfileErrorV1::StaleGeneration,
        ]
        .iter()
        .any(|error| error.code() == code),
        Some(_) => false,
    })
}

/// `after_failed_target` means an earlier target of this attempt failed to
/// start after it stopped the source, so the native Host failure that started
/// the attempt is already consumed and only the policy is checked again.
async fn may_start(
    state: &ServiceState,
    record: &AgentRecoveryAttemptV1,
    after_failed_target: bool,
) -> Result<bool, &'static str> {
    if !policy_allows(state, record).await? {
        return Ok(false);
    }
    let record = match record {
        AgentRecoveryAttemptV1::Native(_) if after_failed_target => return Ok(true),
        AgentRecoveryAttemptV1::Native(record) => {
            // A person who resumed the conversation, or a new turn, wins:
            // the Host must still show the exact failure that was recorded.
            // A Host that timed out decides nothing: the attempt stays
            // unfinished and the next wake asks again. Any other answer that
            // is not this Host generation means the failure is not current.
            let Some((selection, _, inspection)) = stable_native(state, &record.agent_id).await?
            else {
                return Ok(false);
            };
            let inspection = match inspection {
                Ok(inspection) => inspection,
                Err(HmuxSessionInspectionFailure::DescriptorTimeout) => {
                    return Err("agent_recovery_host_unavailable");
                }
                Err(_) => return Ok(false),
            };
            return Ok(selection.revision == record.source_selection_revision
                && inspection.terminal_epoch == record.native_failure.terminal_epoch
                && inspection.attention_id() == Some(record.native_failure.attention_id.as_str())
                && inspection.settled_turn_failure() == Some(record.native_failure.reason));
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

/// Whether this failure still owns automatic continuation, and until when it
/// waits. Human queue admission retains priority in the caller, including
/// when recovery stops.
pub(crate) async fn advance(
    state: &ServiceState,
    agent_id: &AgentIdV1,
) -> Result<AgentRecoveryHoldV1, &'static str> {
    if !state.is_mutation_authority() || !pro_features::available() {
        return Ok(AgentRecoveryHoldV1::Released);
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

async fn advance_locked(
    state: &ServiceState,
    agent_id: &AgentIdV1,
) -> Result<AgentRecoveryHoldV1, &'static str> {
    let observed_at_ms = now_ms().map_err(|_| "agent_recovery_clock_unavailable")?;
    let native = observe_native_failure(state, agent_id, observed_at_ms).await?;
    let Some(mut record) = state
        .store
        .prepare_agent_recovery(agent_id, observed_at_ms, native.as_ref())
        .await
        .map_err(|_| "agent_recovery_store_failed")?
    else {
        return Ok(AgentRecoveryHoldV1::Released);
    };
    // Each pass returns or sets one more login aside, so the pool bounds it.
    let operation_id = loop {
        if record.stopped().is_some() {
            return stopped_result(record.stopped());
        }
        let operation_id = record
            .runtime_operation_id()
            .map_err(|_| "agent_recovery_identity_invalid")?;
        let current = read_locked(state, agent_id)
            .await
            .map_err(|_| "agent_recovery_store_failed")?;
        // Owned and not this try's journal: an earlier target's failed one.
        let after_failed_target = matches!(current, AgentRuntimeObservedV1::Transitioning { .. });
        let owns_runtime = match current {
            AgentRuntimeObservedV1::Stable { selection, .. } => {
                (selection.revision == record.source_selection_revision()
                    && selection.interaction_profile == record.source_interaction_profile()
                    && &selection.execution_profile == record.source_execution_profile())
                    || selection.selected_by_operation_id.as_ref() == Some(&operation_id)
            }
            // A target that failed to start leaves its journal for the next.
            AgentRuntimeObservedV1::Transitioning { transition, .. } => {
                record.owns_runtime_operation(&transition.intent.operation_id)
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
            Some(AgentRuntimeTransitionStateV1::RepairRequired) => {
                record = set_aside_target(state, &record, REPAIR_REQUIRED).await?;
                continue;
            }
            Some(AgentRuntimeTransitionStateV1::SourceRetained) => {
                return stop(
                    state,
                    &record,
                    AgentRecoveryStopV1::Failed {
                        code: REPAIR_REQUIRED.into(),
                    },
                )
                .await;
            }
            Some(AgentRuntimeTransitionStateV1::Superseded) => {
                return stop(state, &record, AgentRecoveryStopV1::Superseded).await;
            }
            None if !may_start(state, &record, after_failed_target).await? => {
                return stop(state, &record, AgentRecoveryStopV1::Superseded).await;
            }
            // A same-account continuation after a reset has no target to check.
            None if record.resume_at_ms().is_some() => {}
            None => {
                record = check_target(state, record).await?;
                if record.stopped().is_some() {
                    continue;
                }
            }
            _ => {}
        }
        if let (None, Some(resume_at_ms)) = (record.target(), record.resume_at_ms()) {
            // The same runtime continues; only the provider's reset is awaited.
            if observed_at_ms < resume_at_ms {
                return Ok(AgentRecoveryHoldV1::WaitsUntil(resume_at_ms));
            }
            break operation_id;
        }
        if transition
            .is_some_and(|transition| transition.state == AgentRuntimeTransitionStateV1::Committed)
        {
            break operation_id;
        }
        let Some(target) = record.target() else {
            return Err("agent_recovery_accounts_exhausted");
        };
        // The conversation stays in the runtime mode it failed in. Preserve
        // stops a native source only at its exact settled failure.
        let Err(error) = agent_runtime_transition_apply::apply_locked(
            state,
            &record.runtime_attempt_id(),
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
        else {
            break record
                .runtime_operation_id()
                .map_err(|_| "agent_recovery_identity_invalid")?;
        };
        if target_failed(state, &record, &error.code).await? {
            record = set_aside_target(state, &record, &error.code).await?;
            continue;
        }
        return stop(
            state,
            &record,
            AgentRecoveryStopV1::Failed { code: error.code },
        )
        .await;
    };
    let record = match record {
        AgentRecoveryAttemptV1::Native(native) => {
            return continue_native(state, &native, &operation_id).await;
        }
        AgentRecoveryAttemptV1::Conversation(record) => record,
    };
    match state.agent_conversations.start_recovery_turn(&record).await {
        Ok(Some(receipt)) if receipt.state == AgentTurnEffectStateV1::Accepted => {
            Ok(AgentRecoveryHoldV1::Owned)
        }
        Ok(Some(_)) => Err("agent_recovery_turn_unconfirmed"),
        Ok(None) => Ok(AgentRecoveryHoldV1::Released),
        // The runtime owner publishes readiness when startup recovery finishes.
        Err(AgentConversationApiErrorV1::RuntimeUnavailable) => Ok(AgentRecoveryHoldV1::Owned),
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
/// observation, or `None` when the Agent is not one. Each caller decides
/// what a Host that cannot answer means for it.
async fn stable_native(
    state: &ServiceState,
    agent_id: &AgentIdV1,
) -> Result<
    Option<(
        AgentRuntimeSelectionV1,
        AgentCheckpointBindingAuthorityV1,
        Result<HmuxSessionInspection, HmuxSessionInspectionFailure>,
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
    let inspection = query_hmux_for_runtime_transition(
        &state.hmux_identity,
        &authority.binding.session_id,
        &authority.runtime_workspace_id,
        &authority_stop_fence(&authority),
    )
    .await
    .and_then(|inspection| {
        if inspection.provider_id == selection.provider_id.as_str() {
            Ok(inspection)
        } else {
            Err(HmuxSessionInspectionFailure::DescriptorMismatch)
        }
    });
    Ok(Some((*selection, authority, inspection)))
}

/// The settled limit failure a native terminal Agent's Host shows now, when
/// its provider has recovery on. Only the Host's typed failure counts;
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
    let Some(policy) = state
        .store
        .provider_recovery_policy(&selection.provider_id)
        .await
        .map_err(|_| "agent_recovery_store_failed")?
        .filter(|policy| policy.active_at(observed_at_ms))
    else {
        return Ok(None);
    };
    // A Host that cannot answer shows no failure; the next wake looks again.
    let Some((_, _, Ok(inspection))) = stable_native(state, agent_id).await? else {
        return Ok(None);
    };
    let (Some(reason), Some(attention_id)) =
        (inspection.settled_turn_failure(), inspection.attention_id())
    else {
        return Ok(None);
    };
    // Only a continuation after the reset needs the Host's completed turns
    // and the login's reset, which the Host does not report but the login's
    // recorded limit windows do; other observations keep their stored shape.
    let (turn_completed_count, limit_resets_at_ms) = if policy.continue_after_reset {
        (
            inspection.turn_completed_count(),
            state
                .credential_profiles
                .observe_limit_reset(
                    &selection.provider_id,
                    &selection.execution_profile,
                    observed_at_ms,
                )
                .await,
        )
    } else {
        (None, None)
    };
    Ok(Some(AgentNativeTurnFailureV1 {
        terminal_epoch: inspection.terminal_epoch.clone(),
        attention_id: attention_id.to_owned(),
        reason,
        observed_at_ms,
        turn_completed_count,
        limit_resets_at_ms,
    }))
}

/// Sends the conversation its one continuation prompt: on the runtime the
/// committed account switch selected once it is idle, or after the reset on
/// the unchanged source while it still shows the recorded failure, which
/// ended its turn. The prompt is claimed before it is written: a refusal that
/// proves nothing was written releases it for the next wake, and a prompt
/// that may have been written is never written again.
async fn continue_native(
    state: &ServiceState,
    record: &AgentNativeRecoveryRecordV1,
    operation_id: &OperationIdV1,
) -> Result<AgentRecoveryHoldV1, &'static str> {
    let attempt = AgentRecoveryAttemptV1::Native(Box::new(record.clone()));
    match &record.continuation {
        AgentNativeRecoveryContinuationV1::Delivered { .. } => {
            return Ok(AgentRecoveryHoldV1::Released);
        }
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
    let after_reset = record.target.is_none() && record.resume_at_ms.is_some();
    let committed_at_ms = if after_reset {
        None
    } else {
        let Some(transition) = state
            .store
            .agent_runtime_transition(operation_id)
            .await
            .map_err(|_| "agent_recovery_store_failed")?
            .filter(|transition| transition.state == AgentRuntimeTransitionStateV1::Committed)
        else {
            // The runtime journal still owns the switch; wake again later.
            return Ok(AgentRecoveryHoldV1::Owned);
        };
        Some(transition.updated_at_ms)
    };
    // The switch's runtime is the next revision, selected by this attempt;
    // a continuation after the reset stays on the source revision.
    let owns = |selection: &AgentRuntimeSelectionV1| {
        if after_reset {
            selection.revision == record.source_selection_revision
        } else {
            selection.selected_by_operation_id.as_ref() == Some(operation_id)
                && Some(selection.revision) == record.source_selection_revision.checked_add(1)
        }
    };
    // A Host that cannot answer yet is not ready; the selection still
    // decides whether recovery owns the Agent.
    let observed = stable_native(state, &record.agent_id).await?.and_then(
        |(selection, authority, inspection)| Some((selection, authority, inspection.ok()?)),
    );
    let still_owned = match &observed {
        Some((selection, _, _)) => owns(selection) && policy_allows(state, &attempt).await?,
        // The Host may still be starting; the selection decides ownership.
        None => match read_locked(state, &record.agent_id)
            .await
            .map_err(|_| "agent_recovery_store_failed")?
        {
            AgentRuntimeObservedV1::Stable { selection, .. } => owns(&selection),
            _ => false,
        },
    };
    if !still_owned {
        return stop(state, &attempt, AgentRecoveryStopV1::Superseded).await;
    }
    let ready = observed.and_then(|(selection, authority, inspection)| {
        let conversation = crate::agent_runtime_transition_apply::native_source_conversation(
            &authority,
            &inspection,
        )?;
        let takes_prompt = if after_reset {
            inspection.attention_id() == Some(record.native_failure.attention_id.as_str())
                && inspection.settled_turn_failure().is_some()
        } else {
            inspection.is_agent_quiescent()
        };
        takes_prompt.then_some((
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
        // The source answered `may_start` in this pass, so after a reset the
        // next wake decides again; a switched runtime has a bounded start.
        let now = now_ms().map_err(|_| "agent_recovery_clock_unavailable")?;
        if committed_at_ms.is_some_and(|at| now.saturating_sub(at) > NATIVE_TARGET_READY_TIMEOUT_MS)
        {
            return stop(
                state,
                &attempt,
                AgentRecoveryStopV1::Failed {
                    code: "agent_recovery_target_not_ready".into(),
                },
            )
            .await;
        }
        return Ok(AgentRecoveryHoldV1::Owned);
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
        return Ok(AgentRecoveryHoldV1::Released);
    }
    let request = WorkflowPromptDeliveryRequestV1 {
        runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux")
            .map_err(|_| "agent_recovery_identity_invalid")?,
        delivery_idempotency_key,
        session,
        intent: WorkflowPromptDeliveryIntentV1::ExistingConversation {
            provider_conversation_id,
        },
        handoff: if after_reset {
            NATIVE_RESET_CONTINUATION
        } else {
            NATIVE_CONTINUATION
        }
        .to_owned(),
    };
    match state.workflow_prompt_deliverer.deliver(request).await {
        Ok(evidence) => {
            state
                .store
                .settle_native_agent_recovery_continuation(&record.attempt_id, Some(&evidence))
                .await
                .map_err(|_| "agent_recovery_store_failed")?;
            Ok(AgentRecoveryHoldV1::Owned)
        }
        Err(failure) if !failure.may_have_written => {
            state
                .store
                .settle_native_agent_recovery_continuation(&record.attempt_id, None)
                .await
                .map_err(|_| "agent_recovery_store_failed")?;
            Ok(AgentRecoveryHoldV1::Owned)
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
