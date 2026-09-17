use std::path::PathBuf;

use dure_app::{
    AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1, AgentExecutionProfileV1, AgentIdV1,
    AgentInteractionProfileV1, AgentProviderConversationPlanV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeLaunchSelectionV1, AgentRuntimeReplacementAuthorityUpdateV1,
    AgentRuntimeReplacementAuthorityV1, AgentRuntimeSelectionV1, AgentRuntimeSourceStopPolicyV1,
    AgentRuntimeTargetFailureKindV1, AgentRuntimeTargetFailureV1,
    AgentRuntimeTransitionAdvanceRequestV1, AgentRuntimeTransitionAdvanceV1,
    AgentRuntimeTransitionEffectAuthorizationV1, AgentRuntimeTransitionIntentV1,
    AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionRepairRequestV1,
    AgentRuntimeTransitionStateV1, AgentRuntimeTransitionStore,
    AgentRuntimeTransitionSupersedeRequestV1, DomainStore, DomainStoreErrorV1, OperationIdV1,
    ProviderIdV1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::agent_runtime_projection::AgentRuntimeSourceSnapshotV1;
use crate::agent_runtime_stop_boundary::{SOURCE_RETAINED_CODE, SourceStopFailure};
use crate::hmux_session_inspection::{HmuxSessionInspection, HmuxSessionInspectionFailure};
use crate::provider_credential_profile::{
    PreparedProviderCredentialLaunchV1, ProviderCredentialProfileErrorV1,
};
use crate::structured_provider_runtime::{
    StructuredProviderOpenRequestV1, StructuredProviderRuntimeErrorV1,
};

use super::{
    ServiceState, authority_stop_fence, now_ms, query_hmux_for_runtime_transition, valid_token,
};

mod admission;
mod inspection;
#[cfg(test)]
pub(crate) use inspection::AgentRuntimeInspectObservationV1;
use inspection::inspect_projection_locked;
pub(crate) use inspection::{
    AgentRuntimeProjectionInspectObservationV1, inspect, inspect_projection,
};
pub(super) mod deferred;
mod drive;
pub(super) use drive::drive_locked;
mod request_replay;
pub(super) use request_replay::apply;
pub(super) mod native;
mod replacement;
use admission::{load_or_admit, validate_replay};
use replacement::corrected_successor_intent;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRuntimeTransitionApplyBodyV1 {
    pub(crate) schema_version: u16,
    pub(crate) agent_id: dure_app::AgentIdV1,
    pub(crate) target_interaction_profile: AgentInteractionProfileV1,
    #[serde(default)]
    pub(crate) expected_source_revision: Option<i64>,
    #[serde(default)]
    pub(crate) source_stop_policy: AgentRuntimeSourceStopPolicyV1,
    #[serde(default)]
    pub(crate) target_execution_profile: Option<AgentExecutionProfileV1>,
    /// Complete target launch selection; absent inherits the source values.
    #[serde(default)]
    pub(crate) target_launch_selection: Option<AgentRuntimeLaunchSelectionV1>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRuntimeInspectBodyV1 {
    pub(crate) schema_version: u16,
    pub(crate) agent_id: AgentIdV1,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRuntimeRepairIntentInspectBodyV1 {
    pub(crate) schema_version: u16,
    pub(crate) agent_id: AgentIdV1,
    pub(crate) operation_id: OperationIdV1,
    pub(crate) expected_journal_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRuntimeRepairApplyBodyV1 {
    pub(crate) schema_version: u16,
    pub(crate) agent_id: AgentIdV1,
    pub(crate) operation_id: OperationIdV1,
    pub(crate) expected_journal_revision: i64,
    pub(crate) action: AgentRuntimeRepairActionV1,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AgentRuntimeRepairActionV1 {
    Retry,
    Supersede {
        target_interaction_profile: AgentInteractionProfileV1,
        #[serde(default)]
        target_execution_profile: Option<AgentExecutionProfileV1>,
        #[serde(default)]
        target_launch_selection: Option<AgentRuntimeLaunchSelectionV1>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRuntimeTransitionApplyReceiptV1 {
    schema_version: u16,
    agent_id: AgentIdV1,
    selection_revision: i64,
    provider_id: ProviderIdV1,
    execution_profile: AgentExecutionProfileV1,
    permission_mode: dure_app::ProviderPermissionModeV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<dure_app::AgentSpawnModelSelectionV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<dure_app::AgentSpawnEffortSelectionV1>,
    provider_conversation_ref: Option<String>,
    authority: AgentRuntimeBindingAuthorityV1,
    launch_idempotency_key: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRuntimeRepairIntentInspectObservationV1 {
    #[serde(flatten)]
    status: InspectedIntentStatus,
    schema_version: u16,
    agent_id: AgentIdV1,
    operation_id: OperationIdV1,
    journal_revision: i64,
    source_selection_revision: i64,
    source_interaction_profile: AgentInteractionProfileV1,
    source_execution_profile: AgentExecutionProfileV1,
    source_launch_selection: AgentRuntimeLaunchSelectionV1,
    target_interaction_profile: AgentInteractionProfileV1,
    target_execution_profile: AgentExecutionProfileV1,
    target_launch_selection: AgentRuntimeLaunchSelectionV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum InspectedIntentStatus {
    Admitted,
    RepairRequired {
        target_failure: AgentRuntimeTargetFailureV1,
    },
}

enum AdmissionOutcome {
    AlreadySelected(Box<(AgentRuntimeSelectionV1, AgentRuntimeBindingAuthorityV1)>),
    Transition(Box<AgentRuntimeTransitionRecordV1>),
    Replayed(Box<AgentRuntimeTransitionRecordV1>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SourceObservationFailure {
    NativeAuthorityStale,
    ProviderConversationUnavailable { source_exited: bool },
    ProviderConversationStale,
}

impl SourceObservationFailure {
    fn admission_error(self) -> super::BackendDispatchError {
        let code = match self {
            Self::NativeAuthorityStale => "agent_runtime_native_authority_stale",
            Self::ProviderConversationUnavailable { .. } => {
                "agent_runtime_provider_conversation_unavailable"
            }
            Self::ProviderConversationStale => "agent_runtime_provider_conversation_stale",
        };
        match self {
            Self::ProviderConversationUnavailable {
                source_exited: true,
            } => super::BackendDispatchError::terminal(code),
            _ => super::BackendDispatchError::from(code),
        }
    }
}

#[derive(Debug)]
pub(super) enum TransitionDriveOutcome {
    Committed(Box<AgentRuntimeTransitionApplyReceiptV1>),
    Deferred,
    SourceRetained,
    RepairRequired,
    Superseded,
}

pub(super) enum TargetStartFailure {
    RepairRequired {
        failure: AgentRuntimeTargetFailureV1,
        replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1,
    },
    Retryable(String),
}

impl TargetStartFailure {
    pub(super) fn repair(
        kind: AgentRuntimeTargetFailureKindV1,
        provider_code: impl Into<String>,
    ) -> Self {
        Self::RepairRequired {
            failure: AgentRuntimeTargetFailureV1::from_untrusted_provider_diagnostic(
                kind,
                provider_code,
            ),
            replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
        }
    }

    pub(super) fn with_replacement_authority(
        self,
        authority: Option<AgentRuntimeBindingAuthorityV1>,
    ) -> Self {
        match self {
            Self::RepairRequired { failure, .. } => Self::RepairRequired {
                failure,
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::Replace {
                    authority: authority
                        .map(AgentRuntimeReplacementAuthorityV1)
                        .map(Box::new),
                },
            },
            other => other,
        }
    }

    pub(super) fn retryable(code: impl Into<String>) -> Self {
        Self::Retryable(code.into())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TransitionKind {
    StructuredTarget,
    NativeTarget,
}

fn transition_kind(
    source: &AgentRuntimeSelectionV1,
    target_interaction_profile: AgentInteractionProfileV1,
    target_execution_profile: &AgentExecutionProfileV1,
    launch_selection_changed: bool,
    same_selection_replacement: bool,
) -> Result<TransitionKind, String> {
    let profile_changed = source.interaction_profile != target_interaction_profile;
    let execution_changed = source.execution_profile != *target_execution_profile;
    if !profile_changed
        && !execution_changed
        && !launch_selection_changed
        && !same_selection_replacement
    {
        return Err("agent_runtime_transition_direction_unsupported".into());
    }
    match target_interaction_profile {
        AgentInteractionProfileV1::StructuredProtocol
            if profile_changed
                || source.interaction_profile == AgentInteractionProfileV1::StructuredProtocol =>
        {
            Ok(TransitionKind::StructuredTarget)
        }
        AgentInteractionProfileV1::NativeCli => Ok(TransitionKind::NativeTarget),
        _ => Err("agent_runtime_transition_direction_unsupported".into()),
    }
}

fn drive_outcome(
    outcome: TransitionDriveOutcome,
) -> Result<AgentRuntimeTransitionApplyReceiptV1, super::BackendDispatchError> {
    match outcome {
        TransitionDriveOutcome::Committed(receipt) => Ok(*receipt),
        TransitionDriveOutcome::Deferred => Err(super::BackendDispatchError::terminal(
            "agent_runtime_target_deferred",
        )),
        TransitionDriveOutcome::SourceRetained => Err(source_retained_error()),
        TransitionDriveOutcome::RepairRequired => Err(repair_required_error()),
        TransitionDriveOutcome::Superseded => Err(superseded_error()),
    }
}

pub(crate) async fn repair(
    state: &ServiceState,
    attempt_id: &str,
    body: AgentRuntimeRepairApplyBodyV1,
) -> Result<AgentRuntimeTransitionApplyReceiptV1, super::BackendDispatchError> {
    if body.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1
        || body.expected_journal_revision < 1
    {
        return Err(super::BackendDispatchError::terminal(
            "agent_runtime_repair_request_invalid",
        ));
    }
    let _agent_guard = state.agent_operations.acquire(&body.agent_id).await;
    let current = state
        .store
        .agent_runtime_transition(&body.operation_id)
        .await
        .map_err(repair_store_error)?
        .ok_or_else(|| {
            super::BackendDispatchError::terminal("agent_runtime_repair_transition_unavailable")
        })?;
    if current.intent.source.agent_id != body.agent_id {
        return Err(super::BackendDispatchError::terminal(
            "agent_runtime_repair_conflict",
        ));
    }

    // An admitted transition has nothing to authorize: no source was stopped
    // and no target started, so a Retry simply drives it in place. This is
    // also the only API-reachable escape for a transition whose recovery
    // drives fail silently (a wedged chat-to-terminal switch was unreachable
    // by every operation for a day, 2026-08-31) - and the synchronous drive
    // surfaces the real failure to the caller instead of a generic conflict.
    if current.state == AgentRuntimeTransitionStateV1::Admitted
        && matches!(body.action, AgentRuntimeRepairActionV1::Retry)
    {
        if current.journal_revision != body.expected_journal_revision {
            return Err(super::BackendDispatchError::terminal(
                "agent_runtime_repair_conflict",
            ));
        }
        state.agent_runtime_recovery_wake.notify_one();
        return drive_outcome(drive_locked(state, current).await?);
    }

    let (repair_operation_id, repair_idempotency_key) = runtime_repair_identity(
        attempt_id,
        &body.agent_id,
        &body.operation_id,
        body.expected_journal_revision,
        &body.action,
    )
    .map_err(|_| super::BackendDispatchError::terminal("agent_runtime_repair_request_invalid"))?;

    let authorization = match &body.action {
        AgentRuntimeRepairActionV1::Retry => state
            .store
            .authorize_agent_runtime_transition_repair(&AgentRuntimeTransitionRepairRequestV1 {
                schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
                operation_id: body.operation_id.clone(),
                expected_journal_revision: body.expected_journal_revision,
                repair_operation_id,
                repaired_at_ms: clock_at_least(current.updated_at_ms).map_err(|_| {
                    super::BackendDispatchError::from("agent_runtime_repair_clock_unavailable")
                })?,
            })
            .await
            .map_err(repair_store_error)?,
        AgentRuntimeRepairActionV1::Supersede {
            target_interaction_profile,
            target_execution_profile,
            target_launch_selection,
        } => {
            let successor_operation_id = repair_operation_id;
            let successor_idempotency_key = repair_idempotency_key;
            let successor_intent = if current.state == AgentRuntimeTransitionStateV1::Superseded {
                replayed_successor_intent(
                    state,
                    &current,
                    &successor_operation_id,
                    *target_interaction_profile,
                    target_execution_profile.as_ref(),
                    target_launch_selection.as_ref(),
                )
                .await?
            } else {
                corrected_successor_intent(
                    state,
                    &current,
                    successor_operation_id,
                    successor_idempotency_key,
                    *target_interaction_profile,
                    target_execution_profile.clone(),
                    target_launch_selection.clone(),
                )
                .await?
            };
            state
                .store
                .supersede_agent_runtime_transition(&AgentRuntimeTransitionSupersedeRequestV1 {
                    schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
                    operation_id: body.operation_id.clone(),
                    expected_journal_revision: body.expected_journal_revision,
                    superseded_at_ms: successor_intent.requested_at_ms,
                    successor_intent,
                })
                .await
                .map_err(repair_store_error)?
        }
    };

    match authorization {
        AgentRuntimeTransitionEffectAuthorizationV1::Authorized(transition) => {
            state.agent_runtime_recovery_wake.notify_one();
            drive_outcome(drive_locked(state, transition).await?)
        }
        AgentRuntimeTransitionEffectAuthorizationV1::Replayed(transition) => {
            observe_replayed_repair(state, &transition).await
        }
    }
}

async fn replayed_successor_intent(
    state: &ServiceState,
    current: &AgentRuntimeTransitionRecordV1,
    successor_operation_id: &OperationIdV1,
    target_interaction_profile: AgentInteractionProfileV1,
    target_execution_profile: Option<&AgentExecutionProfileV1>,
    target_launch_selection: Option<&AgentRuntimeLaunchSelectionV1>,
) -> Result<AgentRuntimeTransitionIntentV1, super::BackendDispatchError> {
    if current.superseded_by_operation_id.as_ref() != Some(successor_operation_id) {
        return Err(super::BackendDispatchError::terminal(
            "agent_runtime_repair_idempotency_conflict",
        ));
    }
    let successor = state
        .store
        .agent_runtime_transition(successor_operation_id)
        .await
        .map_err(repair_store_error)?
        .ok_or_else(|| super::BackendDispatchError::from("agent_runtime_repair_store_failed"))?;
    let expected_execution = target_execution_profile
        .cloned()
        .unwrap_or_else(|| successor.intent.source.execution_profile.clone());
    if successor.intent.target_interaction_profile != target_interaction_profile
        || successor.intent.target_execution_profile != expected_execution
        || successor.intent.target_launch_selection.as_ref() != target_launch_selection
    {
        return Err(super::BackendDispatchError::terminal(
            "agent_runtime_repair_idempotency_conflict",
        ));
    }
    Ok(successor.intent)
}

async fn observe_replayed_repair(
    state: &ServiceState,
    transition: &AgentRuntimeTransitionRecordV1,
) -> Result<AgentRuntimeTransitionApplyReceiptV1, super::BackendDispatchError> {
    transition.validate().map_err(repair_store_error)?;
    match transition.state {
        AgentRuntimeTransitionStateV1::Committed => {
            let selection = state
                .store
                .agent_runtime_selection(&transition.intent.source.agent_id)
                .await
                .map_err(repair_store_error)?
                .ok_or_else(|| {
                    super::BackendDispatchError::from("agent_runtime_repair_store_failed")
                })?;
            let expected = transition
                .intent
                .target_selection_at(transition.updated_at_ms)
                .map_err(repair_store_error)?;
            if selection != expected {
                return Err(super::BackendDispatchError::terminal(
                    "agent_runtime_repair_conflict",
                ));
            }
            let authority = transition.target_authority.as_ref().ok_or_else(|| {
                super::BackendDispatchError::from("agent_runtime_repair_store_failed")
            })?;
            transition_receipt(&selection, authority, Some(transition)).map_err(Into::into)
        }
        AgentRuntimeTransitionStateV1::RepairRequired => Err(repair_required_error()),
        AgentRuntimeTransitionStateV1::Superseded => Err(superseded_error()),
        AgentRuntimeTransitionStateV1::Admitted
        | AgentRuntimeTransitionStateV1::SourceStopped
        | AgentRuntimeTransitionStateV1::TargetStarted => Err(
            super::BackendDispatchError::terminal("agent_runtime_repair_in_progress"),
        ),
        AgentRuntimeTransitionStateV1::SourceRetained => Err(source_retained_error()),
    }
}

fn source_retained_error() -> super::BackendDispatchError {
    super::BackendDispatchError::terminal(SOURCE_RETAINED_CODE)
}

fn repair_required_error() -> super::BackendDispatchError {
    super::BackendDispatchError::terminal("agent_runtime_repair_required")
}

fn superseded_error() -> super::BackendDispatchError {
    super::BackendDispatchError::terminal("agent_runtime_transition_superseded")
}

/// Projects the immutable source and target for action input preparation.
/// The existing negotiated operation also serves admitted intents, without
/// changing the established inspect-v1 or repair-required wire shapes.
pub(crate) async fn inspect_repair_intent(
    state: &ServiceState,
    body: AgentRuntimeRepairIntentInspectBodyV1,
) -> Result<AgentRuntimeRepairIntentInspectObservationV1, String> {
    if body.schema_version != AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1
        || body.expected_journal_revision <= 0
    {
        return Err("agent_runtime_repair_intent_inspect_request_invalid".into());
    }
    let _agent_guard = state.agent_operations.acquire(&body.agent_id).await;
    let transition = state
        .store
        .active_agent_runtime_transition(&body.agent_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| "agent_runtime_repair_intent_unavailable".to_string())?;
    transition.validate().map_err(store_error)?;
    if transition.intent.operation_id != body.operation_id
        || transition.journal_revision != body.expected_journal_revision
    {
        return Err("agent_runtime_repair_intent_conflict".into());
    }
    let status = match transition.state {
        AgentRuntimeTransitionStateV1::Admitted => InspectedIntentStatus::Admitted,
        AgentRuntimeTransitionStateV1::RepairRequired => InspectedIntentStatus::RepairRequired {
            target_failure: transition
                .target_failure
                .clone()
                .ok_or_else(|| "agent_runtime_repair_intent_conflict".to_string())?,
        },
        _ => return Err("agent_runtime_repair_intent_conflict".into()),
    };
    let source_launch_selection = AgentRuntimeLaunchSelectionV1 {
        model: transition.intent.source.model.clone(),
        effort: transition.intent.source.effort.clone(),
        permission_mode: Some(transition.intent.source.permission_mode.clone()),
    };
    let mut target_launch_selection = transition.intent.effective_launch_selection();
    target_launch_selection.permission_mode = Some(transition.intent.effective_permission_mode());
    Ok(AgentRuntimeRepairIntentInspectObservationV1 {
        status,
        schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
        agent_id: body.agent_id,
        operation_id: body.operation_id,
        journal_revision: transition.journal_revision,
        source_selection_revision: transition.intent.source.revision,
        source_interaction_profile: transition.intent.source.interaction_profile,
        source_execution_profile: transition.intent.source.execution_profile,
        source_launch_selection,
        target_interaction_profile: transition.intent.target_interaction_profile,
        target_execution_profile: transition.intent.target_execution_profile,
        target_launch_selection,
    })
}

fn transition_receipt(
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentRuntimeBindingAuthorityV1,
    transition: Option<&AgentRuntimeTransitionRecordV1>,
) -> Result<AgentRuntimeTransitionApplyReceiptV1, String> {
    let receipt = runtime_receipt(selection, authority, transition)?;
    match transition {
        Some(transition) => authority
            .validate_for_transition_target(selection, &transition.intent.provider_conversation_ref)
            .map_err(store_error)?,
        None => authority
            .validate_for_selection(selection)
            .map_err(store_error)?,
    }
    Ok(receipt)
}

fn runtime_receipt(
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentRuntimeBindingAuthorityV1,
    transition: Option<&AgentRuntimeTransitionRecordV1>,
) -> Result<AgentRuntimeTransitionApplyReceiptV1, String> {
    let provider_conversation_ref = match authority {
        AgentRuntimeBindingAuthorityV1::NativeCli { authority } => {
            authority.binding.provider_conversation_id.clone()
        }
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => {
            binding.provider_conversation_ref.clone()
        }
    };
    authority
        .validate_for_selection(selection)
        .map_err(store_error)?;
    let launch_idempotency_key = match authority {
        AgentRuntimeBindingAuthorityV1::NativeCli { authority } => selection
            .selected_by_operation_id
            .as_ref()
            .and_then(|operation_id| {
                transition.filter(|transition| transition.intent.operation_id == *operation_id)
            })
            .map(|transition| {
                let target_attempt_operation_id = native::target_attempt_operation_id(transition);
                transition
                    .target_launch_idempotency_key
                    .clone()
                    .map(|key| {
                        dure_app::validate_agent_runtime_native_launch_identity_v1(
                            target_attempt_operation_id,
                            &authority.binding.session_id,
                            &key,
                        )
                        .map_err(store_error)?;
                        Ok(key)
                    })
                    .unwrap_or_else(|| {
                        native::legacy_target_launch_idempotency_key(
                            target_attempt_operation_id,
                            &authority.binding.session_id,
                        )
                    })
            })
            .transpose()?,
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { .. } => None,
    };
    Ok(AgentRuntimeTransitionApplyReceiptV1 {
        schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
        agent_id: selection.agent_id.clone(),
        selection_revision: selection.revision,
        provider_id: selection.provider_id.clone(),
        execution_profile: selection.execution_profile.clone(),
        permission_mode: selection.permission_mode.clone(),
        model: selection.model.clone(),
        effort: selection.effort.clone(),
        provider_conversation_ref,
        authority: authority.clone(),
        launch_idempotency_key,
    })
}

pub(crate) fn native_rehost_receipt(
    selection: &AgentRuntimeSelectionV1,
    authority: &dure_app::AgentCheckpointBindingAuthorityV1,
    durable_receipt: &dure_app::AgentRuntimeNativeRehostReceiptV1,
) -> Result<AgentRuntimeTransitionApplyReceiptV1, String> {
    durable_receipt
        .validate_for(selection, authority)
        .map_err(store_error)?;
    let binding_authority = AgentRuntimeBindingAuthorityV1::NativeCli {
        authority: authority.clone(),
    };
    let mut receipt = runtime_receipt(selection, &binding_authority, None)?;
    receipt.launch_idempotency_key =
        Some(durable_receipt.launch_idempotency_key.as_str().to_owned());
    Ok(receipt)
}

async fn stable_runtime_receipt(
    state: &ServiceState,
    selection: &AgentRuntimeSelectionV1,
    authority: &AgentRuntimeBindingAuthorityV1,
) -> Result<AgentRuntimeTransitionApplyReceiptV1, String> {
    let Some(operation_id) = selection.selected_by_operation_id.as_ref() else {
        return transition_receipt(selection, authority, None);
    };
    if let Some(transition) = state
        .store
        .agent_runtime_transition(operation_id)
        .await
        .map_err(store_error)?
    {
        if transition.state != AgentRuntimeTransitionStateV1::Committed
            || transition
                .intent
                .target_selection_at(transition.updated_at_ms)
                .map_err(store_error)?
                != *selection
        {
            return Err("agent_runtime_transition_commit_stale".into());
        }
        return transition_receipt(selection, authority, Some(&transition));
    }
    let AgentRuntimeBindingAuthorityV1::NativeCli {
        authority: native_authority,
    } = authority
    else {
        return Err("agent_runtime_transition_commit_stale".into());
    };
    let durable_receipt = state
        .store
        .agent_runtime_native_rehost_receipt(&selection.agent_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| "agent_runtime_transition_commit_stale".to_string())?;
    native_rehost_receipt(selection, native_authority, &durable_receipt)
}

async fn stop_source(
    state: &ServiceState,
    transition: &AgentRuntimeTransitionRecordV1,
) -> Result<AgentRuntimeTransitionRecordV1, SourceStopFailure> {
    match &transition.intent.source_authority {
        AgentRuntimeBindingAuthorityV1::NativeCli { .. } => {
            native::stop_source(state, transition).await
        }
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { .. } => {
            stop_structured_source(state, transition).await
        }
    }
}

async fn stop_structured_source(
    state: &ServiceState,
    transition: &AgentRuntimeTransitionRecordV1,
) -> Result<AgentRuntimeTransitionRecordV1, SourceStopFailure> {
    let runtime = state
        .structured_runtimes
        .resolve(&transition.intent.source.provider_id)
        .ok_or_else(|| {
            SourceStopFailure::Failed("agent_runtime_structured_profile_unavailable".into())
        })?;
    runtime
        .stop_replacement_source(transition)
        .await
        .map_err(structured_stop_failure)?;
    advance(
        state,
        transition,
        AgentRuntimeTransitionAdvanceV1::SourceStopped,
    )
    .await
    .map_err(SourceStopFailure::from)
}

fn structured_stop_failure(error: StructuredProviderRuntimeErrorV1) -> SourceStopFailure {
    if error.retains_source() {
        SourceStopFailure::SourceRetained
    } else {
        SourceStopFailure::Failed(error.code)
    }
}

async fn start_target(
    state: &ServiceState,
    transition: &AgentRuntimeTransitionRecordV1,
    prepared_profile: PreparedProviderCredentialLaunchV1,
) -> Result<AgentRuntimeTransitionRecordV1, TargetStartFailure> {
    match transition.intent.target_interaction_profile {
        AgentInteractionProfileV1::NativeCli => {
            native::start_target(state, transition, prepared_profile).await
        }
        AgentInteractionProfileV1::StructuredProtocol => {
            start_structured_target(state, transition, prepared_profile).await
        }
    }
}

async fn start_structured_target(
    state: &ServiceState,
    transition: &AgentRuntimeTransitionRecordV1,
    prepared_profile: PreparedProviderCredentialLaunchV1,
) -> Result<AgentRuntimeTransitionRecordV1, TargetStartFailure> {
    let runtime = state
        .structured_runtimes
        .resolve(&transition.intent.source.provider_id)
        .ok_or_else(|| {
            TargetStartFailure::retryable("agent_runtime_structured_profile_unavailable")
        })?;
    let launch = transition.intent.effective_launch_selection();
    let opened = runtime
        .open_replacement(
            StructuredProviderOpenRequestV1 {
                agent_id: transition.intent.source.agent_id.clone(),
                execution_profile: transition.intent.target_execution_profile.clone(),
                permission_mode: transition.intent.effective_permission_mode(),
                model: launch.model,
                effort: launch.effort,
                provider_conversation_ref: transition
                    .intent
                    .provider_conversation_ref
                    .as_option()
                    .map(str::to_owned),
            },
            transition,
            prepared_profile.environment(),
        )
        .await
        .map_err(structured_target_failure)?;
    advance(
        state,
        transition,
        AgentRuntimeTransitionAdvanceV1::TargetStarted {
            authority: Box::new(AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: opened,
            }),
            launch_idempotency_key: None,
        },
    )
    .await
    .map_err(TargetStartFailure::retryable)
}

fn structured_target_failure(error: StructuredProviderRuntimeErrorV1) -> TargetStartFailure {
    use crate::structured_provider_runtime::{
        StructuredProviderRuntimeErrorKindV1 as Kind, StructuredProviderTargetQuiescenceV1,
    };

    let replacement_authority = match error.target_quiescence {
        StructuredProviderTargetQuiescenceV1::Unknown => {
            return TargetStartFailure::retryable(error.code);
        }
        StructuredProviderTargetQuiescenceV1::NoTarget => None,
        StructuredProviderTargetQuiescenceV1::ExactFailedBinding(binding) => {
            Some(AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: *binding })
        }
    };
    let kind = match error.kind {
        Kind::RequestInvalid => AgentRuntimeTargetFailureKindV1::TargetInvalid,
        Kind::CredentialUnavailable => AgentRuntimeTargetFailureKindV1::CredentialUnavailable,
        Kind::CredentialStale => AgentRuntimeTargetFailureKindV1::CredentialStale,
        Kind::RuntimeConflict => AgentRuntimeTargetFailureKindV1::IdentityMismatch,
        Kind::ExplicitRecoveryRequired => AgentRuntimeTargetFailureKindV1::LaunchFailed,
        Kind::RuntimeUnavailable | Kind::SourceBusy | Kind::LaunchFailed | Kind::StopFailed => {
            return TargetStartFailure::retryable(error.code);
        }
    };
    let failure = TargetStartFailure::repair(kind, error.code);
    match replacement_authority {
        Some(authority) => failure.with_replacement_authority(Some(authority)),
        None => failure,
    }
}

async fn advance(
    state: &ServiceState,
    transition: &AgentRuntimeTransitionRecordV1,
    advance: AgentRuntimeTransitionAdvanceV1,
) -> Result<AgentRuntimeTransitionRecordV1, String> {
    state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            operation_id: transition.intent.operation_id.clone(),
            expected_journal_revision: transition.journal_revision,
            advance,
            advanced_at_ms: clock_at_least(transition.updated_at_ms)?,
        })
        .await
        .map_err(store_error)
}

async fn inspect_native_source(
    state: &ServiceState,
    source: &AgentRuntimeSelectionV1,
    authority: &dure_app::AgentCheckpointBindingAuthorityV1,
) -> Result<HmuxSessionInspection, HmuxSessionInspectionFailure> {
    if authority.binding.agent_id != source.agent_id {
        return Err(HmuxSessionInspectionFailure::AuthorityStale);
    }
    query_hmux_for_runtime_transition(
        &state.hmux_identity,
        &authority.binding.session_id,
        &authority.runtime_workspace_id,
        &authority_stop_fence(authority),
    )
    .await
}

fn validate_source_observation(
    source: &AgentRuntimeSelectionV1,
    provider_conversation: &AgentProviderConversationPlanV1,
    inspection: &HmuxSessionInspection,
) -> Result<(), SourceObservationFailure> {
    if inspection.provider_id != source.provider_id.as_str() {
        return Err(SourceObservationFailure::NativeAuthorityStale);
    }
    if provider_conversation.as_option().is_none()
        && (inspection.is_exited_exact()
            || inspection.turn_completed_count() != Some(0)
            || !inspection.is_agent_quiescent())
    {
        return Err(SourceObservationFailure::ProviderConversationUnavailable {
            source_exited: inspection.is_exited_exact(),
        });
    }
    if inspection.is_exited_exact() {
        return Ok(());
    }
    if inspection
        .provider_conversation_identity
        .as_ref()
        .map(|identity| identity.conversation_id.as_str())
        != provider_conversation.as_option()
    {
        return Err(SourceObservationFailure::ProviderConversationStale);
    }
    Ok(())
}

pub(super) async fn runtime_workspace(
    state: &ServiceState,
    source: &AgentRuntimeSelectionV1,
) -> Result<(String, PathBuf), String> {
    let agent = state
        .store
        .agent(&source.agent_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| "agent_runtime_agent_unavailable".to_string())?;
    if agent.provider_id != source.provider_id {
        return Err("agent_runtime_selection_stale".into());
    }
    let workspace = state
        .store
        .workspace(&agent.workspace_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| "agent_runtime_workspace_unavailable".to_string())?;
    let project = state
        .store
        .project(&workspace.project_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| "agent_runtime_workspace_unavailable".to_string())?;
    let runtime_workspace_id = dure_app::agent_bootstrap_runtime_workspace(
        &agent.agent_id,
        &workspace.workspace_id,
        &project.project_id,
    )
    .map_err(|_| "agent_checkpoint_binding_identity_mismatch".to_string())?
    .unwrap_or(workspace.workspace_id);
    let root = PathBuf::from(workspace.root_path);
    if !root.is_absolute() || !root.is_dir() {
        return Err("agent_runtime_workspace_unavailable".into());
    }
    Ok((runtime_workspace_id.as_str().into(), root))
}

async fn converge_native_provider_conversation(
    state: &ServiceState,
    source: &AgentRuntimeSelectionV1,
    authority: dure_app::AgentCheckpointBindingAuthorityV1,
    inspection: &HmuxSessionInspection,
) -> Result<
    (
        dure_app::AgentCheckpointBindingAuthorityV1,
        AgentProviderConversationPlanV1,
    ),
    super::BackendDispatchError,
> {
    let provider_conversation_ref =
        authority
            .binding
            .provider_conversation_id
            .clone()
            .or_else(|| {
                inspection
                    .provider_conversation_identity
                    .as_ref()
                    .map(|identity| identity.conversation_id.clone())
            });
    let provider_conversation =
        AgentProviderConversationPlanV1::from_option(provider_conversation_ref.clone())
            .map_err(store_error)?;
    validate_source_observation(source, &provider_conversation, inspection)
        .map_err(SourceObservationFailure::admission_error)?;
    if authority.binding.provider_conversation_id.is_some() {
        return Ok((authority, provider_conversation));
    }
    let Some(provider_conversation_ref) = provider_conversation_ref else {
        return Ok((authority, provider_conversation));
    };
    let authority = state
        .store
        .converge_agent_checkpoint_provider_conversation(&authority, &provider_conversation_ref)
        .await
        .map_err(store_error)?;
    Ok((authority, provider_conversation))
}

pub(super) fn runtime_transition_identity(
    attempt_id: &str,
) -> Result<(OperationIdV1, String), String> {
    runtime_operation_identity(
        b"dure-agent-runtime-transition-attempt/v1\0",
        &[attempt_id.as_bytes()],
    )
}

fn runtime_operation_identity(
    domain: &[u8],
    fields: &[&[u8]],
) -> Result<(OperationIdV1, String), String> {
    let mut digest = Sha256::new();
    digest.update(domain);
    for field in fields {
        update_digest_field(&mut digest, field);
    }
    let digest = format!("{:x}", digest.finalize());
    let idempotency_key = format!("runtime-attempt-{digest}");
    if !valid_token(&idempotency_key) {
        return Err("agent_runtime_transition_request_invalid".into());
    }
    let operation_id = OperationIdV1::new(format!("runtime-transition-{digest}"))
        .map_err(|_| "agent_runtime_transition_request_invalid".to_string())?;
    Ok((operation_id, idempotency_key))
}

fn runtime_repair_identity(
    attempt_id: &str,
    agent_id: &AgentIdV1,
    transition_operation_id: &OperationIdV1,
    expected_journal_revision: i64,
    action: &AgentRuntimeRepairActionV1,
) -> Result<(OperationIdV1, String), String> {
    if expected_journal_revision < 1 {
        return Err("agent_runtime_repair_request_invalid".into());
    }
    let canonical_action = serde_json::to_vec(action)
        .map_err(|_| "agent_runtime_repair_request_invalid".to_string())?;
    let mut digest = Sha256::new();
    digest.update(b"dure-agent-runtime-repair-attempt/v2\0");
    update_digest_field(&mut digest, agent_id.as_str().as_bytes());
    update_digest_field(&mut digest, transition_operation_id.as_str().as_bytes());
    update_digest_field(&mut digest, &expected_journal_revision.to_be_bytes());
    update_digest_field(&mut digest, &canonical_action);
    update_digest_field(&mut digest, attempt_id.as_bytes());
    let digest = format!("{:x}", digest.finalize());
    let idempotency_key = format!("runtime-repair-attempt-{digest}");
    if !valid_token(&idempotency_key) {
        return Err("agent_runtime_repair_request_invalid".into());
    }
    let operation_id = OperationIdV1::new(format!("runtime-repair-{digest}"))
        .map_err(|_| "agent_runtime_repair_request_invalid".to_string())?;
    Ok((operation_id, idempotency_key))
}

pub(super) fn stop_identity(operation_id: &OperationIdV1, runtime_revision: u64) -> String {
    let digest = Sha256::digest(
        format!(
            "dure-agent-runtime-stop/v1\0{}\0{runtime_revision}",
            operation_id.as_str()
        )
        .as_bytes(),
    );
    format!("runtime-stop-{digest:x}")
}

pub(super) fn quiescent_stop_identity(
    operation_id: &OperationIdV1,
    runtime_revision: u64,
    observed_through_output_seq: u64,
) -> String {
    let digest = Sha256::digest(
        format!(
            "dure-agent-runtime-quiescent-stop/v1\0{}\0{runtime_revision}\0{observed_through_output_seq}",
            operation_id.as_str()
        )
        .as_bytes(),
    );
    format!("runtime-stop-{digest:x}")
}

fn update_digest_field(digest: &mut Sha256, value: &[u8]) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value);
}

fn clock_at_least(minimum: i64) -> Result<i64, String> {
    now_ms()
        .map(|value| value.max(minimum))
        .map_err(|_| "agent_runtime_clock_unavailable".into())
}

fn store_error(error: DomainStoreErrorV1) -> String {
    match error {
        DomainStoreErrorV1::InvalidRecord { .. } => {
            "agent_runtime_transition_request_invalid".into()
        }
        DomainStoreErrorV1::IdentityConflict { .. }
        | DomainStoreErrorV1::IdempotencyConflict { .. }
        | DomainStoreErrorV1::RevisionConflict { .. } => "agent_runtime_transition_conflict".into(),
        _ => "agent_runtime_transition_store_failed".into(),
    }
}

fn repair_store_error(error: DomainStoreErrorV1) -> super::BackendDispatchError {
    match error {
        DomainStoreErrorV1::InvalidRecord { .. } => {
            super::BackendDispatchError::terminal("agent_runtime_repair_request_invalid")
        }
        DomainStoreErrorV1::InvalidEventStream { .. }
        | DomainStoreErrorV1::IdentityConflict { .. }
        | DomainStoreErrorV1::IdempotencyConflict { .. }
        | DomainStoreErrorV1::RevisionConflict { .. } => {
            super::BackendDispatchError::terminal("agent_runtime_repair_conflict")
        }
        DomainStoreErrorV1::NotFound { .. } => {
            super::BackendDispatchError::terminal("agent_runtime_repair_transition_unavailable")
        }
        _ => super::BackendDispatchError::from("agent_runtime_repair_store_failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::structured_provider_runtime::StructuredProviderRuntimeErrorKindV1;
    use dure_app::{AgentExecutionProfileV1, AgentIdV1, ProviderIdV1, ProviderPermissionModeV1};

    fn selection(revision: i64) -> AgentRuntimeSelectionV1 {
        AgentRuntimeSelectionV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            provider_id: ProviderIdV1::new("claude").unwrap(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision,
            selected_by_operation_id: (revision > 1)
                .then(|| OperationIdV1::new("prior-transition").unwrap()),
            updated_at_ms: 1,
        }
    }

    #[test]
    fn transition_identity_is_stable_only_for_the_exact_transport_attempt() {
        let first = runtime_transition_identity("request-1").unwrap();
        let replay = runtime_transition_identity("request-1").unwrap();
        let fresh_attempt = runtime_transition_identity("request-2").unwrap();

        assert_eq!(first, replay);
        assert_ne!(first, fresh_attempt);
        assert!(first.1.starts_with("runtime-attempt-"));
    }

    #[test]
    fn repair_identity_is_bound_to_the_exact_durable_handle_and_action() {
        let transition = OperationIdV1::new("runtime-transition-1").unwrap();
        let agent = AgentIdV1::new("agent-1").unwrap();
        let retry = AgentRuntimeRepairActionV1::Retry;
        let exact = runtime_repair_identity("request-1", &agent, &transition, 3, &retry).unwrap();

        assert_eq!(
            exact,
            runtime_repair_identity("request-1", &agent, &transition, 3, &retry).unwrap()
        );
        assert_ne!(
            exact,
            runtime_repair_identity(
                "request-1",
                &AgentIdV1::new("agent-2").unwrap(),
                &transition,
                3,
                &retry,
            )
            .unwrap(),
            "the same transport request cannot authorize another Agent"
        );
        assert_ne!(
            exact,
            runtime_repair_identity("request-1", &agent, &transition, 4, &retry).unwrap(),
            "a fresh RepairRequired revision is a distinct authorization"
        );
        assert_ne!(
            exact,
            runtime_repair_identity(
                "request-1",
                &agent,
                &transition,
                3,
                &AgentRuntimeRepairActionV1::Supersede {
                    target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
                    target_execution_profile: None,
                    target_launch_selection: None,
                },
            )
            .unwrap(),
            "a retry and corrected successor cannot share effect identity"
        );
    }

    #[test]
    fn transition_request_parses_stop_policy_and_expected_source_revision() {
        let request = |source_stop_policy: Option<&str>, expected_source_revision: Option<i64>| {
            let mut value = serde_json::json!({
                "schemaVersion": 1,
                "agentId": "agent-1",
                "targetInteractionProfile": "structured_protocol"
            });
            if let Some(policy) = source_stop_policy {
                value["sourceStopPolicy"] = serde_json::json!(policy);
            }
            if let Some(revision) = expected_source_revision {
                value["expectedSourceRevision"] = serde_json::json!(revision);
            }
            serde_json::from_value::<AgentRuntimeTransitionApplyBodyV1>(value).unwrap()
        };

        assert_eq!(
            request(None, None).source_stop_policy,
            AgentRuntimeSourceStopPolicyV1::Preserve
        );
        let discard = request(Some("discard"), Some(7));
        assert_eq!(
            discard.source_stop_policy,
            AgentRuntimeSourceStopPolicyV1::Discard
        );
        assert_eq!(discard.expected_source_revision, Some(7));
    }

    #[test]
    fn exact_exited_source_remains_valid_when_its_conversation_is_already_durable() {
        let inspection: HmuxSessionInspection = serde_json::from_value(serde_json::json!({
            "schema_version": 1,
            "session_id": "session-1",
            "workspace_id": "workspace-1",
            "session_class": "managed",
            "lifecycle": "exited",
            "provider_id": "claude",
            "runner_principal": "local-user",
            "runner_instance": "runner-1",
            "channel_epoch": "1",
            "host_instance_id": "host-1",
            "terminal_epoch": "terminal-1",
            "output_seq": "0",
            "health": "exited",
            "agentRuntimeState": null,
            "providerConversationIdentity": null
        }))
        .unwrap();

        assert_eq!(
            validate_source_observation(
                &selection(1),
                &AgentProviderConversationPlanV1::resume("conversation-1").unwrap(),
                &inspection,
            ),
            Ok(())
        );
    }

    #[test]
    fn exited_source_cannot_be_classified_fresh_from_a_live_looking_zero_projection() {
        let inspection: HmuxSessionInspection = serde_json::from_value(serde_json::json!({
            "schema_version": 1,
            "session_id": "session-1",
            "workspace_id": "workspace-1",
            "session_class": "managed",
            "lifecycle": "exited",
            "provider_id": "claude",
            "runner_principal": "local-user",
            "runner_instance": "runner-1",
            "channel_epoch": "1",
            "host_instance_id": "host-1",
            "terminal_epoch": "terminal-1",
            "output_seq": "0",
            "health": "exited",
            "agentRuntimeState": {
                "terminal_epoch": "terminal-1",
                "revision": "1",
                "observed_through_output_seq": "0",
                "turn_completed_count": "0",
                "lifecycle": "running",
                "activity": "waiting",
                "attention": "none",
                "attention_id": null
            },
            "providerConversationIdentity": null
        }))
        .unwrap();

        assert_eq!(
            validate_source_observation(
                &selection(1),
                &AgentProviderConversationPlanV1::fresh(),
                &inspection,
            ),
            Err(SourceObservationFailure::ProviderConversationUnavailable {
                source_exited: true,
            })
        );
    }

    #[test]
    fn current_transition_directions_remain_classified_by_one_authority() {
        let native = selection(1);
        assert_eq!(
            transition_kind(
                &native,
                AgentInteractionProfileV1::StructuredProtocol,
                &native.execution_profile,
                false,
                false,
            ),
            Ok(TransitionKind::StructuredTarget)
        );

        let mut structured = native;
        structured.interaction_profile = AgentInteractionProfileV1::StructuredProtocol;
        let replacement = AgentExecutionProfileV1::CredentialReference {
            reference_id: "account-b".into(),
            credential_generation: Some("credential-b-9".into()),
        };
        assert_eq!(
            transition_kind(
                &structured,
                AgentInteractionProfileV1::StructuredProtocol,
                &replacement,
                false,
                false,
            ),
            Ok(TransitionKind::StructuredTarget)
        );

        // A launch-selection change with unchanged profiles rides the target
        // runtime's replacement machinery for either interaction profile.
        assert_eq!(
            transition_kind(
                &structured,
                AgentInteractionProfileV1::StructuredProtocol,
                &structured.execution_profile,
                true,
                false,
            ),
            Ok(TransitionKind::StructuredTarget)
        );
        let native_again = selection(3);
        assert_eq!(
            transition_kind(
                &native_again,
                AgentInteractionProfileV1::NativeCli,
                &native_again.execution_profile,
                true,
                false,
            ),
            Ok(TransitionKind::NativeTarget)
        );
    }

    #[test]
    fn structured_chat_can_replace_itself_with_the_native_profile() {
        let mut structured = selection(1);
        structured.interaction_profile = AgentInteractionProfileV1::StructuredProtocol;

        assert_eq!(
            transition_kind(
                &structured,
                AgentInteractionProfileV1::NativeCli,
                &structured.execution_profile,
                false,
                false,
            ),
            Ok(TransitionKind::NativeTarget)
        );

        assert_eq!(
            transition_kind(
                &structured,
                AgentInteractionProfileV1::StructuredProtocol,
                &structured.execution_profile,
                false,
                true,
            ),
            Ok(TransitionKind::StructuredTarget),
            "an explicit successor may relaunch the stopped logical source profile"
        );
    }

    #[test]
    fn stop_identity_changes_when_a_busy_runtime_advances_revision() {
        let operation = OperationIdV1::new("runtime-transition-1").unwrap();
        assert_eq!(stop_identity(&operation, 3), stop_identity(&operation, 3));
        assert_ne!(stop_identity(&operation, 3), stop_identity(&operation, 4));
        assert_eq!(
            quiescent_stop_identity(&operation, 3, 8),
            quiescent_stop_identity(&operation, 3, 8)
        );
        assert_ne!(
            quiescent_stop_identity(&operation, 3, 8),
            quiescent_stop_identity(&operation, 4, 8)
        );
        assert_ne!(
            quiescent_stop_identity(&operation, 3, 8),
            quiescent_stop_identity(&operation, 3, 9),
            "a refused quiescence CAS must retry under a fresh exact request identity"
        );
    }

    #[test]
    fn structured_stop_conflict_retains_the_selected_source() {
        let failure = structured_stop_failure(
            crate::structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                StructuredProviderRuntimeErrorKindV1::RuntimeConflict,
                "provider_runtime_conflict",
            ),
        );

        assert!(matches!(failure, SourceStopFailure::SourceRetained));
    }

    #[test]
    fn only_provider_proven_quiescence_can_publish_repair_required() {
        let unknown = structured_target_failure(
            crate::structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                StructuredProviderRuntimeErrorKindV1::RuntimeConflict,
                "provider_runtime_conflict",
            ),
        );
        assert!(matches!(unknown, TargetStartFailure::Retryable(_)));

        let no_target = structured_target_failure(
            crate::structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                StructuredProviderRuntimeErrorKindV1::CredentialUnavailable,
                "provider_credential_unavailable",
            )
            .without_target(),
        );
        assert!(matches!(
            no_target,
            TargetStartFailure::RepairRequired {
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
                ..
            }
        ));
    }

    #[test]
    fn retained_attempt_is_terminal_for_transport_replay() {
        let error = source_retained_error();

        assert_eq!(error.code, SOURCE_RETAINED_CODE);
        assert!(matches!(
            error.disposition,
            super::super::BackendFailureDispositionV1::Terminal
        ));
    }

    #[test]
    fn runtime_inspection_uses_the_frontend_wire_shape() {
        assert_eq!(
            serde_json::to_value(AgentRuntimeInspectObservationV1::Unmanaged {
                schema_version: 1,
                agent_id: AgentIdV1::new("agent-1").unwrap(),
            })
            .unwrap(),
            serde_json::json!({
                "state": "unmanaged",
                "schemaVersion": 1,
                "agentId": "agent-1",
            })
        );
    }
}
