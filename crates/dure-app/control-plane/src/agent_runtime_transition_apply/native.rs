use std::time::Duration;

#[cfg(test)]
use dure_app::AgentRuntimeReplacementAuthorityUpdateV1;
use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AgentCheckpointBindingAuthorityV1, AgentExecutionProfileV1,
    AgentProviderConversationPlanV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeReplacementAuthorityV1, AgentRuntimeSelectionV1, AgentRuntimeTargetFailureKindV1,
    AgentRuntimeTransitionAdvanceV1, AgentRuntimeTransitionRecordV1, DomainStore, OperationIdV1,
    RuntimeKindIdV1, SessionBindingRecordV1, WorkflowSessionGenerationV1,
    WorkflowSessionLaunchFailureDispositionV1, WorkflowSessionLaunchFailureV1,
    WorkflowSessionLaunchReceiptV1, WorkflowSessionLaunchRequestV1,
};
use hmux_client::recovery_journal::managed_create_ledger::ManagedSessionRetirementObservation;
use hmux_client::{
    LocalSessionCatalog, MANAGED_STOP_OUTCOME_UNKNOWN_CODE, ManagedSessionStopper,
    ManagedStopConversationFence, ManagedStopOutcome, ManagedStopRequest,
    PresentationCheckpointPredecessor,
};
use sha2::{Digest, Sha256};
use tokio::time::{Instant, sleep};

use super::{
    HmuxSessionInspection, ServiceState, TargetStartFailure, advance, clock_at_least,
    inspect_native_source, quiescent_stop_identity, runtime_workspace, stop_identity, store_error,
    validate_source_observation,
};
use crate::agent_runtime_stop_boundary::SourceStopFailure;
use crate::hmux_session_inspection::HmuxSessionInspectionFailure;
use crate::provider_credential_profile::PreparedProviderCredentialLaunchV1;
use crate::structured_provider_runtime::{
    StructuredProviderRuntimeErrorKindV1, StructuredProviderRuntimeErrorV1,
    retire_transition_replacement_source,
};

const STOP_RECONCILE_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_RECONCILE_INTERVAL: Duration = Duration::from_millis(25);

mod stop;
use stop::stop_exact;

pub(super) fn preflight_target(
    state: &ServiceState,
    source: &AgentRuntimeSelectionV1,
    launch: &dure_app::AgentRuntimeLaunchSelectionV1,
    permission_mode: &dure_app::ProviderPermissionModeV1,
    provider_conversation_ref: Option<&str>,
) -> Result<(), String> {
    let runtime_kind = RuntimeKindIdV1::new("runtime.hmux")
        .map_err(|_| "agent_runtime_native_profile_unavailable".to_string())?;
    if !state.runtime_adapters.contains_runtime_kind(&runtime_kind) {
        return Err("agent_runtime_native_profile_unavailable".into());
    }
    let plan = state
        .agent_providers
        .launch_plan(
            &source.provider_id,
            permission_mode,
            launch.model.as_ref(),
            launch.effort.as_ref(),
            provider_conversation_ref,
        )
        .map_err(|error| error.code.as_str().to_owned())?
        .ok_or_else(|| "agent_runtime_native_profile_unavailable".to_string())?;
    crate::resolve_provider_executable(&plan.executable)
        .map_err(|_| "agent_runtime_native_profile_unavailable".to_string())?;
    Ok(())
}

pub(super) async fn stop_source(
    state: &ServiceState,
    transition: &AgentRuntimeTransitionRecordV1,
) -> Result<AgentRuntimeTransitionRecordV1, SourceStopFailure> {
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority } =
        &transition.intent.source_authority
    else {
        return Err(SourceStopFailure::Failed(
            "agent_runtime_native_authority_stale".into(),
        ));
    };
    let current_authority = state
        .store
        .agent_checkpoint_binding_authority(&transition.intent.source.agent_id)
        .await
        .map_err(store_error)?
        .ok_or(SourceStopFailure::SourceRetained)?;
    if current_authority != *authority {
        return Err(SourceStopFailure::SourceRetained);
    }
    let (_, workspace) = runtime_workspace(state, &transition.intent.source)
        .await
        .map_err(source_context_failure)?;
    let conversation = ManagedStopConversationFence::new(
        transition.intent.source.provider_id.as_str(),
        authority.binding.provider_conversation_id.clone(),
    )
    .map_err(|_| SourceStopFailure::SourceRetained)?;
    if !transition.intent.source_stop_policy.requires_idle() {
        let inspection = inspect_native_source(state, &transition.intent.source, authority)
            .await
            .map_err(source_inspection_failure)?;
        validate_source_observation(
            &transition.intent.source,
            &transition.intent.provider_conversation_ref,
            &inspection,
        )
        .map_err(|_| SourceStopFailure::SourceRetained)?;
        if !inspection.is_exited_exact() {
            stop_exact(
                state,
                authority,
                Some(conversation.clone()),
                &workspace,
                stop_identity(&transition.intent.operation_id, 0),
                None,
            )
            .await
            .map_err(SourceStopFailure::from)?;
        }
        return advance(
            state,
            transition,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
        )
        .await
        .map_err(SourceStopFailure::from);
    }

    let mut inspection = inspect_native_source(state, &transition.intent.source, authority)
        .await
        .map_err(source_inspection_failure)?;
    // The exact inspection has its own query timeout. This budget governs only
    // stop reconciliation after the first authoritative quiescence fence.
    let deadline = Instant::now() + STOP_RECONCILE_TIMEOUT;
    loop {
        validate_source_observation(
            &transition.intent.source,
            &transition.intent.provider_conversation_ref,
            &inspection,
        )
        .map_err(|_| SourceStopFailure::SourceRetained)?;
        if inspection.is_exited_exact() {
            break;
        }
        let quiescence = inspection
            .managed_stop_quiescence_fence()
            .map_err(|_| SourceStopFailure::SourceRetained)?;
        if !transition.intent.source_stop_policy.accepts_observation(
            quiescence.runtime_revision(),
            quiescence.observed_through_output_seq(),
        ) {
            return Err(SourceStopFailure::SourceRetained);
        }
        let stop_id = quiescent_stop_identity(
            &transition.intent.operation_id,
            quiescence.runtime_revision(),
            quiescence.observed_through_output_seq(),
        );
        match stop_exact(
            state,
            authority,
            Some(conversation.clone()),
            &workspace,
            stop_id,
            Some(quiescence.clone()),
        )
        .await
        {
            Ok(()) => break,
            Err(ExactStopFailure::Refused) if Instant::now() < deadline => {
                let refreshed = inspect_native_source(state, &transition.intent.source, authority)
                    .await
                    .map_err(source_inspection_failure)?;
                validate_source_observation(
                    &transition.intent.source,
                    &transition.intent.provider_conversation_ref,
                    &refreshed,
                )
                .map_err(|_| SourceStopFailure::SourceRetained)?;
                if refreshed.is_exited_exact() {
                    break;
                }
                let refreshed_quiescence = refreshed
                    .managed_stop_quiescence_fence()
                    .map_err(|_| SourceStopFailure::SourceRetained)?;
                if refreshed_quiescence == quiescence {
                    return Err(SourceStopFailure::SourceRetained);
                }
                inspection = refreshed;
            }
            Err(error) => return Err(error.into()),
        }
    }
    advance(
        state,
        transition,
        AgentRuntimeTransitionAdvanceV1::SourceStopped,
    )
    .await
    .map_err(SourceStopFailure::from)
}

pub(crate) async fn stop_current(
    state: &ServiceState,
    source: &AgentRuntimeSelectionV1,
    authority: &AgentCheckpointBindingAuthorityV1,
    operation_id: &OperationIdV1,
) -> Result<(), SourceStopFailure> {
    let current_authority = state
        .store
        .agent_checkpoint_binding_authority(&source.agent_id)
        .await
        .map_err(store_error)?
        .ok_or(SourceStopFailure::SourceRetained)?;
    if current_authority != *authority {
        return Err(SourceStopFailure::SourceRetained);
    }
    let catalog = LocalSessionCatalog::new(&state.hmux_identity.discovery_root);
    let session_id = authority.binding.session_id.clone();
    let workspace_id = authority.runtime_workspace_id.clone();
    let retirement = tokio::task::spawn_blocking(move || {
        catalog.read_managed_session_retirement(&session_id, &workspace_id)
    })
    .await
    .map_err(|_| SourceStopFailure::Failed("agent_runtime_stop_outcome_unknown".into()))?
    .map_err(|_| SourceStopFailure::Failed("agent_runtime_stop_outcome_unknown".into()))?;
    if let ManagedSessionRetirementObservation::Finalized { receipt } = retirement {
        if receipt.session_id() != authority.binding.session_id
            || receipt.workspace_id() != authority.runtime_workspace_id
            || receipt.runner_principal() != authority.runner_principal
            || receipt.runner_instance() != authority.runner_instance
            || Some(receipt.channel_epoch()) != authority.channel_epoch.parse().ok()
            || receipt.host_instance_id() != authority.host_instance_id
            || receipt.terminal_epoch() != authority.terminal_epoch
        {
            return Err(SourceStopFailure::SourceRetained);
        }
        // Final retirement survives discovery cleanup and may belong to an
        // earlier stop ID. This proves only this generation's exit; the removal
        // transaction still owns logical-chain closure and checkout release.
        return Ok(());
    }
    // Explicit close owns this session generation, not a healthy conversation
    // or checkout. The stop broker resolves and retires it from discovery even
    // when the query CLI, provider, or original working directory is gone.
    stop_exact(
        state,
        authority,
        None,
        &state.hmux_identity.discovery_root,
        // Do not replay an older release's conversation-fenced broker intent.
        // This close remains idempotent without inheriting that refusal.
        format!("close-{}", stop_identity(operation_id, 0)),
        None,
    )
    .await
    .map_err(Into::into)
}

fn source_context_failure(error: String) -> SourceStopFailure {
    match error.as_str() {
        "agent_runtime_agent_unavailable"
        | "agent_runtime_selection_stale"
        | "agent_runtime_workspace_unavailable" => SourceStopFailure::SourceRetained,
        _ => SourceStopFailure::Failed(error),
    }
}

fn source_inspection_failure(error: HmuxSessionInspectionFailure) -> SourceStopFailure {
    if error == HmuxSessionInspectionFailure::RuntimeIdentityChanged
        || error.proves_identity_mismatch()
    {
        SourceStopFailure::SourceRetained
    } else {
        SourceStopFailure::Failed(error.code().into())
    }
}

async fn stop_managed_request(
    state: &ServiceState,
    workspace: &std::path::Path,
    request: ManagedStopRequest,
) -> Result<(), ExactStopFailure> {
    let stopper =
        ManagedSessionStopper::new(&state.hmux_identity.runtime_executable_path, workspace)
            .with_discovery_root(&state.hmux_identity.discovery_root);
    let deadline = Instant::now() + STOP_RECONCILE_TIMEOUT;
    let receipt = loop {
        let stopper = stopper.clone();
        let request = request.clone();
        let result = tokio::task::spawn_blocking(move || stopper.stop(request))
            .await
            .map_err(|_| ExactStopFailure::Failed("agent_runtime_stop_failed".into()))?;
        match result {
            Ok(receipt) => break receipt,
            Err(error) if error.code() == MANAGED_STOP_OUTCOME_UNKNOWN_CODE => {
                if Instant::now() >= deadline {
                    return Err(ExactStopFailure::Failed(
                        "agent_runtime_stop_outcome_unknown".into(),
                    ));
                }
                sleep_until_retry(deadline).await;
                if Instant::now() >= deadline {
                    return Err(ExactStopFailure::Failed(
                        "agent_runtime_stop_outcome_unknown".into(),
                    ));
                }
            }
            Err(error) if error.is_definitive_managed_stop_refusal() => {
                return Err(ExactStopFailure::Refused);
            }
            Err(_) => {
                return Err(ExactStopFailure::Failed("agent_runtime_stop_failed".into()));
            }
        }
    };
    if !matches!(
        receipt.outcome(),
        ManagedStopOutcome::Stopped | ManagedStopOutcome::AlreadyExited
    ) {
        return Err(ExactStopFailure::Failed("agent_runtime_stop_failed".into()));
    }
    Ok(())
}

fn target_cleanup_identity(operation_id: &OperationIdV1) -> String {
    let digest = Sha256::digest(
        format!(
            "dure-agent-runtime-target-cleanup/v1\0{}",
            operation_id.as_str()
        )
        .as_bytes(),
    );
    format!("runtime-target-cleanup-{digest:x}")
}

fn target_cleanup_request(
    operation_id: &OperationIdV1,
    session: &WorkflowSessionGenerationV1,
) -> Result<ManagedStopRequest, TargetStartFailure> {
    let channel_epoch = session
        .channel_epoch
        .parse::<u64>()
        .map_err(|_| TargetStartFailure::retryable("agent_runtime_native_target_cleanup_failed"))?;
    ManagedStopRequest::new(
        target_cleanup_identity(operation_id),
        &session.session_id,
        &session.workspace_id,
    )
    .and_then(|request| {
        request.with_expected_fence(
            &session.runner_principal,
            &session.runner_instance,
            channel_epoch,
            &session.host_instance_id,
            &session.terminal_epoch,
        )
    })
    .map_err(|_| TargetStartFailure::retryable("agent_runtime_native_target_cleanup_failed"))
}

pub(super) fn target_attempt_operation_id(
    transition: &AgentRuntimeTransitionRecordV1,
) -> &OperationIdV1 {
    transition
        .last_repair_operation_id
        .as_ref()
        .unwrap_or(&transition.intent.operation_id)
}

async fn cleanup_permanent_target_failure(
    state: &ServiceState,
    transition: &AgentRuntimeTransitionRecordV1,
    workspace: &std::path::Path,
    session: &WorkflowSessionGenerationV1,
    failure: TargetStartFailure,
    replacement_authority: Option<&AgentRuntimeReplacementAuthorityV1>,
) -> TargetStartFailure {
    if !matches!(failure, TargetStartFailure::RepairRequired { .. }) {
        return failure;
    }
    let Ok(request) = target_cleanup_request(target_attempt_operation_id(transition), session)
    else {
        return TargetStartFailure::retryable("agent_runtime_native_target_cleanup_failed");
    };
    if stop_managed_request(state, workspace, request)
        .await
        .is_err()
    {
        return TargetStartFailure::retryable("agent_runtime_native_target_cleanup_failed");
    }
    preserve_prepared_replacement(failure, replacement_authority)
}

async fn sleep_until_retry(deadline: Instant) {
    let remaining = deadline.saturating_duration_since(Instant::now());
    sleep(STOP_RECONCILE_INTERVAL.min(remaining)).await;
}

enum ExactStopFailure {
    RequestInvalid,
    Refused,
    Failed(String),
}

impl From<ExactStopFailure> for SourceStopFailure {
    fn from(error: ExactStopFailure) -> Self {
        match error {
            ExactStopFailure::RequestInvalid | ExactStopFailure::Refused => Self::SourceRetained,
            ExactStopFailure::Failed(code) => Self::Failed(code),
        }
    }
}

fn native_repair(
    kind: AgentRuntimeTargetFailureKindV1,
    code: impl Into<String>,
) -> TargetStartFailure {
    TargetStartFailure::repair(kind, code)
}

fn presentation_predecessor(
    transition: &AgentRuntimeTransitionRecordV1,
) -> Result<Option<PresentationCheckpointPredecessor>, TargetStartFailure> {
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority } =
        &transition.intent.source_authority
    else {
        return Ok(None);
    };
    let channel_epoch = authority.channel_epoch.parse::<u64>().map_err(|_| {
        native_repair(
            AgentRuntimeTargetFailureKindV1::IdentityMismatch,
            "agent_runtime_native_source_authority_invalid",
        )
    })?;
    PresentationCheckpointPredecessor::new(
        &authority.binding.session_id,
        &authority.runner_principal,
        &authority.runner_instance,
        channel_epoch,
        &authority.host_instance_id,
        &authority.terminal_epoch,
    )
    .map(Some)
    .map_err(|_| {
        native_repair(
            AgentRuntimeTargetFailureKindV1::IdentityMismatch,
            "agent_runtime_native_source_authority_invalid",
        )
    })
}

async fn retire_structured_replacement_source(
    state: &ServiceState,
    transition: &AgentRuntimeTransitionRecordV1,
) -> Result<Option<AgentRuntimeReplacementAuthorityV1>, TargetStartFailure> {
    retire_transition_replacement_source(&state.structured_runtimes, transition)
        .await
        .map_err(structured_replacement_retirement_failure)
}

fn preserve_prepared_replacement(
    failure: TargetStartFailure,
    replacement_authority: Option<&AgentRuntimeReplacementAuthorityV1>,
) -> TargetStartFailure {
    match replacement_authority {
        Some(authority) => failure.with_replacement_authority(Some(authority.0.clone())),
        None => failure,
    }
}

fn structured_replacement_retirement_failure(
    error: StructuredProviderRuntimeErrorV1,
) -> TargetStartFailure {
    match error.kind {
        StructuredProviderRuntimeErrorKindV1::RequestInvalid
        | StructuredProviderRuntimeErrorKindV1::RuntimeConflict
        | StructuredProviderRuntimeErrorKindV1::CredentialStale => TargetStartFailure::repair(
            AgentRuntimeTargetFailureKindV1::IdentityMismatch,
            error.code,
        ),
        StructuredProviderRuntimeErrorKindV1::CredentialUnavailable
        | StructuredProviderRuntimeErrorKindV1::ExplicitRecoveryRequired => {
            TargetStartFailure::repair(AgentRuntimeTargetFailureKindV1::LaunchFailed, error.code)
        }
        StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable
        | StructuredProviderRuntimeErrorKindV1::SourceBusy
        | StructuredProviderRuntimeErrorKindV1::LaunchFailed
        | StructuredProviderRuntimeErrorKindV1::StopFailed => {
            TargetStartFailure::retryable(error.code)
        }
    }
}

pub(super) async fn start_target(
    state: &ServiceState,
    transition: &AgentRuntimeTransitionRecordV1,
    prepared_profile: PreparedProviderCredentialLaunchV1,
) -> Result<AgentRuntimeTransitionRecordV1, TargetStartFailure> {
    let source = &transition.intent.source;
    let launch = transition.intent.effective_launch_selection();
    let permission_mode = transition.intent.effective_permission_mode();
    let provider = state
        .agent_providers
        .session_launch_plan(
            &source.provider_id,
            &permission_mode,
            launch.model.as_ref(),
            launch.effort.as_ref(),
            transition.intent.provider_conversation_ref.as_option(),
            hmux_client::MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
        )
        .map_err(|error| {
            native_repair(
                AgentRuntimeTargetFailureKindV1::TargetInvalid,
                error.code.as_str(),
            )
        })?
        .ok_or_else(|| TargetStartFailure::retryable("agent_runtime_native_profile_unavailable"))?;
    let provider_executable = crate::resolve_provider_executable(&provider.launch.executable)
        .map_err(|_| TargetStartFailure::retryable("agent_runtime_native_profile_unavailable"))?;
    let provider_executable = provider_executable
        .to_str()
        .ok_or_else(|| TargetStartFailure::retryable("agent_runtime_native_profile_unavailable"))?
        .to_owned();
    let (workspace_id, workspace) = runtime_workspace(state, source)
        .await
        .map_err(TargetStartFailure::retryable)?;
    let working_directory = workspace
        .to_str()
        .ok_or_else(|| TargetStartFailure::retryable("agent_runtime_workspace_unavailable"))?
        .to_owned();
    let identity = target_identity(target_attempt_operation_id(transition));
    let launch = WorkflowSessionLaunchRequestV1 {
        runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").map_err(|_| {
            TargetStartFailure::retryable("agent_runtime_native_profile_unavailable")
        })?,
        launch_idempotency_key: identity.launch_idempotency_key,
        session_id: identity.session_id,
        workspace_id,
        provider_id: source.provider_id.clone(),
        provider_conversation_ref: transition
            .intent
            .provider_conversation_ref
            .as_option()
            .map(str::to_owned),
        permission_mode,
        provider_executable,
        provider_arguments: provider.launch.arguments,
        provider_resume: dure_app::WorkflowSessionResumePlanV1::from_arguments(
            provider.resume_arguments,
            &transition.intent.target_execution_profile,
        ),
        initial_prompt: None,
        working_directory,
        prelaunch_command: None,
    };
    launch.validate().map_err(|_| {
        native_repair(
            AgentRuntimeTargetFailureKindV1::TargetInvalid,
            "agent_runtime_native_launch_invalid",
        )
    })?;
    let presentation_predecessor = presentation_predecessor(transition)?;
    let replacement_authority = retire_structured_replacement_source(state, transition).await?;
    let launch_receipt = state
        .credential_aware_workflow_launcher
        .launch_with_provider_state(
            launch.clone(),
            prepared_profile.environment(),
            presentation_predecessor,
        )
        .await
        .map_err(native_launch_failure)
        .map_err(|failure| {
            preserve_prepared_replacement(failure, replacement_authority.as_ref())
        })?;
    if launch_receipt.validate_for_request(&launch).is_err() {
        let session = &launch_receipt.session;
        return Err(cleanup_permanent_target_failure(
            state,
            transition,
            &workspace,
            session,
            native_repair(
                AgentRuntimeTargetFailureKindV1::IdentityMismatch,
                "agent_runtime_native_target_identity_mismatch",
            ),
            replacement_authority.as_ref(),
        )
        .await);
    }
    let WorkflowSessionLaunchReceiptV1 {
        launch_idempotency_key,
        session,
    } = launch_receipt;
    let target_selection = transition
        .intent
        .target_selection_at(
            clock_at_least(transition.updated_at_ms).map_err(TargetStartFailure::retryable)?,
        )
        .map_err(|error| TargetStartFailure::retryable(store_error(error)))?;
    let provisional_authority = match target_authority(
        state,
        transition,
        &session,
        &target_selection,
        transition
            .intent
            .provider_conversation_ref
            .as_option()
            .map(str::to_owned),
    )
    .await
    {
        Ok(authority) => authority,
        Err(failure) => {
            return Err(cleanup_permanent_target_failure(
                state,
                transition,
                &workspace,
                &session,
                failure,
                replacement_authority.as_ref(),
            )
            .await);
        }
    };
    let inspection =
        match inspect_native_source(state, &target_selection, &provisional_authority).await {
            Ok(inspection) => inspection,
            Err(code) => {
                let failure = native_target_inspection_failure(code);
                return Err(cleanup_permanent_target_failure(
                    state,
                    transition,
                    &workspace,
                    &session,
                    failure,
                    replacement_authority.as_ref(),
                )
                .await);
            }
        };
    let provider_conversation_id = match validate_target_observation(
        source,
        &transition.intent.provider_conversation_ref,
        &inspection,
    ) {
        Ok(provider_conversation_id) => provider_conversation_id,
        Err(()) => {
            return Err(cleanup_permanent_target_failure(
                state,
                transition,
                &workspace,
                &session,
                native_repair(
                    AgentRuntimeTargetFailureKindV1::IdentityMismatch,
                    "agent_runtime_native_target_identity_mismatch",
                ),
                replacement_authority.as_ref(),
            )
            .await);
        }
    };
    let authority = match target_authority(
        state,
        transition,
        &session,
        &target_selection,
        provider_conversation_id,
    )
    .await
    {
        Ok(authority) => authority,
        Err(failure) => {
            return Err(cleanup_permanent_target_failure(
                state,
                transition,
                &workspace,
                &session,
                failure,
                replacement_authority.as_ref(),
            )
            .await);
        }
    };
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&authority)
        .await
        .map_err(|error| TargetStartFailure::retryable(store_error(error)))?;
    advance(
        state,
        transition,
        AgentRuntimeTransitionAdvanceV1::TargetStarted {
            authority: Box::new(AgentRuntimeBindingAuthorityV1::NativeCli { authority }),
            launch_idempotency_key: Some(launch_idempotency_key),
        },
    )
    .await
    .map_err(TargetStartFailure::retryable)
}

fn native_target_inspection_failure(failure: HmuxSessionInspectionFailure) -> TargetStartFailure {
    if failure.proves_identity_mismatch() {
        native_repair(
            AgentRuntimeTargetFailureKindV1::IdentityMismatch,
            failure.code(),
        )
    } else {
        TargetStartFailure::retryable(failure.code())
    }
}

fn native_launch_failure(failure: WorkflowSessionLaunchFailureV1) -> TargetStartFailure {
    match failure.disposition {
        WorkflowSessionLaunchFailureDispositionV1::Retryable => {
            TargetStartFailure::retryable(failure.code)
        }
        WorkflowSessionLaunchFailureDispositionV1::Rejected => {
            native_repair(AgentRuntimeTargetFailureKindV1::LaunchFailed, failure.code)
        }
    }
}

async fn target_authority(
    state: &ServiceState,
    transition: &AgentRuntimeTransitionRecordV1,
    session: &WorkflowSessionGenerationV1,
    target: &AgentRuntimeSelectionV1,
    provider_conversation_id: Option<String>,
) -> Result<AgentCheckpointBindingAuthorityV1, TargetStartFailure> {
    let source = &transition.intent.source;
    let credential_reference_id = match &transition.intent.target_execution_profile {
        AgentExecutionProfileV1::ProviderDefault => None,
        AgentExecutionProfileV1::CredentialReference { reference_id, .. } => {
            Some(reference_id.clone())
        }
    };
    let existing = state
        .store
        .agent_checkpoint_binding_authority(&source.agent_id)
        .await
        .map_err(|error| TargetStartFailure::retryable(store_error(error)))?;
    if let Some(existing) = existing.as_ref().filter(|authority| {
        authority.binding.agent_id == source.agent_id
            && authority.binding.runtime_kind_id.as_str() == "runtime.hmux"
            && authority.binding.session_id == session.session_id
            && authority.binding.provider_conversation_id == provider_conversation_id
            && authority.binding.credential_reference_id == credential_reference_id
            && authority.runtime_workspace_id == session.workspace_id
            && authority.runner_principal == session.runner_principal
            && authority.runner_instance == session.runner_instance
            && authority.channel_epoch == session.channel_epoch
            && authority.host_instance_id == session.host_instance_id
            && authority.terminal_epoch == session.terminal_epoch
    }) {
        return Ok(existing.clone());
    }
    let binding_generation = existing.as_ref().map_or(Ok(1), |authority| {
        authority
            .binding
            .binding_generation
            .checked_add(1)
            .ok_or_else(|| {
                native_repair(
                    AgentRuntimeTargetFailureKindV1::AuthorityPublishFailed,
                    "agent_runtime_native_binding_failed",
                )
            })
    })?;
    let updated_at_ms = clock_at_least(
        existing
            .as_ref()
            .map_or(transition.updated_at_ms, |authority| {
                authority.updated_at_ms.max(transition.updated_at_ms)
            }),
    )
    .map_err(TargetStartFailure::retryable)?;
    let authority = AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: SessionBindingRecordV1 {
            agent_id: source.agent_id.clone(),
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").map_err(|_| {
                native_repair(
                    AgentRuntimeTargetFailureKindV1::AuthorityPublishFailed,
                    "agent_runtime_native_binding_failed",
                )
            })?,
            session_id: session.session_id.clone(),
            provider_conversation_id,
            credential_reference_id,
            binding_generation,
            bound_at_ms: updated_at_ms,
        },
        runtime_workspace_id: session.workspace_id.clone(),
        runner_principal: session.runner_principal.clone(),
        runner_instance: session.runner_instance.clone(),
        channel_epoch: session.channel_epoch.clone(),
        host_instance_id: session.host_instance_id.clone(),
        terminal_epoch: session.terminal_epoch.clone(),
        updated_at_ms,
    };
    AgentRuntimeBindingAuthorityV1::NativeCli {
        authority: authority.clone(),
    }
    .validate_for_transition_target(target, &transition.intent.provider_conversation_ref)
    .map_err(|_| {
        native_repair(
            AgentRuntimeTargetFailureKindV1::IdentityMismatch,
            "agent_runtime_native_target_identity_mismatch",
        )
    })?;
    Ok(authority)
}

fn validate_target_observation(
    source: &AgentRuntimeSelectionV1,
    provider_conversation: &AgentProviderConversationPlanV1,
    inspection: &HmuxSessionInspection,
) -> Result<Option<String>, ()> {
    if inspection.provider_id != source.provider_id.as_str() {
        return Err(());
    }
    // Hmux forgets the live identity projection after an immediate provider
    // exit, but the exact generation still comes from the managed-create
    // request that claimed this conversation. Commit its tombstone so ordinary
    // Terminal recovery can resume it instead of stranding SourceStopped.
    if inspection.is_exited_exact() {
        return Ok(provider_conversation.as_option().map(str::to_owned));
    }
    let observed = inspection
        .provider_conversation_identity
        .as_ref()
        .map(|identity| identity.conversation_id.clone());
    if provider_conversation
        .as_option()
        .is_some_and(|expected| observed.as_deref() != Some(expected))
    {
        return Err(());
    }
    Ok(observed)
}

fn target_identity(operation_id: &OperationIdV1) -> dure_app::AgentRuntimeNativeLaunchIdentityV1 {
    dure_app::agent_runtime_native_launch_identity_v1(operation_id)
}

pub(super) fn legacy_target_launch_idempotency_key(
    operation_id: &OperationIdV1,
    session_id: &str,
) -> Result<String, String> {
    let identity = target_identity(operation_id);
    if identity.session_id != session_id {
        return Err("agent_runtime_native_target_identity_mismatch".into());
    }
    Ok(identity.launch_idempotency_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_app::{
        AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1, AgentIdV1, AgentInteractionProfileV1,
        ProviderIdV1, ProviderPermissionModeV1,
    };

    fn structured_source() -> AgentRuntimeSelectionV1 {
        AgentRuntimeSelectionV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            provider_id: ProviderIdV1::new("claude").unwrap(),
            interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 1,
        }
    }

    #[test]
    fn target_identity_is_stable_and_scoped_to_one_transition() {
        let first = target_identity(&OperationIdV1::new("runtime-transition-1").unwrap());
        let replay = target_identity(&OperationIdV1::new("runtime-transition-1").unwrap());
        let other = target_identity(&OperationIdV1::new("runtime-transition-2").unwrap());

        assert_eq!(first.launch_idempotency_key, replay.launch_idempotency_key);
        assert_eq!(first.session_id, replay.session_id);
        assert_ne!(first.launch_idempotency_key, other.launch_idempotency_key);
        assert_ne!(first.session_id, other.session_id);
        assert_eq!(
            legacy_target_launch_idempotency_key(
                &OperationIdV1::new("runtime-transition-1").unwrap(),
                &first.session_id,
            )
            .unwrap(),
            first.launch_idempotency_key,
        );
        assert!(
            legacy_target_launch_idempotency_key(
                &OperationIdV1::new("runtime-transition-1").unwrap(),
                &other.session_id,
            )
            .is_err()
        );
        let operation_id = OperationIdV1::new("runtime-transition-1").unwrap();
        assert!(
            dure_app::validate_agent_runtime_native_launch_identity_v1(
                &operation_id,
                &first.session_id,
                &first.launch_idempotency_key,
            )
            .is_ok()
        );
        assert!(
            dure_app::validate_agent_runtime_native_launch_identity_v1(
                &operation_id,
                "successor-session",
                "successor-create-key",
            )
            .is_ok()
        );
        assert!(
            dure_app::validate_agent_runtime_native_launch_identity_v1(
                &operation_id,
                &first.session_id,
                "successor-create-key",
            )
            .is_err()
        );
        assert!(
            dure_app::validate_agent_runtime_native_launch_identity_v1(
                &operation_id,
                "successor-session",
                &first.launch_idempotency_key,
            )
            .is_err()
        );
    }

    #[test]
    fn target_cleanup_is_fenced_to_the_exact_returned_generation() {
        let operation_id = OperationIdV1::new("runtime-transition-1").unwrap();
        let session = WorkflowSessionGenerationV1 {
            session_id: "target-session".into(),
            workspace_id: "target-workspace".into(),
            provider_id: ProviderIdV1::new("claude").unwrap(),
            runner_principal: "target-runner".into(),
            runner_instance: "target-instance".into(),
            channel_epoch: "7".into(),
            host_instance_id: "target-host".into(),
            terminal_epoch: "target-terminal".into(),
        };

        let Ok(request) = target_cleanup_request(&operation_id, &session) else {
            panic!("valid returned generation must produce an exact cleanup request")
        };

        assert_eq!(request.stop_id(), target_cleanup_identity(&operation_id));
        assert_eq!(request.session_id(), session.session_id);
        assert_eq!(request.workspace_id(), session.workspace_id);
        assert_eq!(request.expected_runner_principal(), Some("target-runner"));
        assert_eq!(request.expected_runner_instance(), Some("target-instance"));
        assert_eq!(request.expected_channel_epoch(), Some(7));
        assert_eq!(request.expected_host_instance_id(), Some("target-host"));
        assert_eq!(request.expected_terminal_epoch(), Some("target-terminal"));
    }

    #[test]
    fn exact_exited_target_remains_committable_after_live_identity_projection_is_gone() {
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

        assert!(
            validate_target_observation(
                &structured_source(),
                &AgentProviderConversationPlanV1::resume("conversation-1").unwrap(),
                &inspection,
            )
            .is_ok()
        );
    }

    #[test]
    fn stale_native_source_evidence_retains_the_source() {
        for code in [
            "agent_runtime_agent_unavailable",
            "agent_runtime_selection_stale",
            "agent_runtime_workspace_unavailable",
        ] {
            assert!(matches!(
                source_context_failure(code.into()),
                SourceStopFailure::SourceRetained
            ));
        }
        for failure in [
            HmuxSessionInspectionFailure::AuthorityStale,
            HmuxSessionInspectionFailure::RuntimeIdentityChanged,
            HmuxSessionInspectionFailure::DescriptorMismatch,
            HmuxSessionInspectionFailure::AgentRuntimeStateMismatch,
            HmuxSessionInspectionFailure::ProviderConversationIdentityMismatch,
        ] {
            assert!(matches!(
                source_inspection_failure(failure),
                SourceStopFailure::SourceRetained
            ));
        }
        assert!(matches!(
            source_inspection_failure(HmuxSessionInspectionFailure::DescriptorUnavailable),
            SourceStopFailure::Failed(code) if code == "hmux_descriptor_unavailable"
        ));
    }

    #[test]
    fn native_target_inspection_maps_typed_identity_and_transport_failures() {
        assert!(matches!(
            native_target_inspection_failure(HmuxSessionInspectionFailure::DescriptorMalformed),
            TargetStartFailure::RepairRequired {
                failure,
                replacement_authority:
                    AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
            }
                if failure.kind == AgentRuntimeTargetFailureKindV1::IdentityMismatch
                    && failure.provider_code == "hmux_descriptor_malformed"
        ));
        assert!(matches!(
            native_target_inspection_failure(HmuxSessionInspectionFailure::DescriptorUnavailable),
            TargetStartFailure::Retryable(code) if code == "hmux_descriptor_unavailable"
        ));
    }
}
