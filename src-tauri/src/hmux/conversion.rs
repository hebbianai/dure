use super::*;

mod checkout;
#[cfg(test)]
mod checkout_tests;
mod launch;
mod operation;
pub(super) use operation::read_standalone_launch;
mod retirement;
use launch::{create_replacement, ReplacementAttempt, ReplacementContext};

const ACTION_TO_MANAGED: &str = "convert_standalone_to_managed_with_exact_conversation";
const ACTION_TO_STANDALONE: &str = "convert_managed_to_standalone_with_exact_conversation";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionConversionTarget {
    Managed,
    Standalone,
}

impl SessionConversionTarget {
    fn action(self) -> &'static str {
        match self {
            Self::Managed => ACTION_TO_MANAGED,
            Self::Standalone => ACTION_TO_STANDALONE,
        }
    }

    fn class(self) -> SessionClass {
        match self {
            Self::Managed => SessionClass::Managed,
            Self::Standalone => SessionClass::Standalone,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::Standalone => "standalone",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConversionRequest {
    conversion_id: String,
    source_session_id: String,
    source_workspace_id: String,
    #[serde(default)]
    expected_source_fence: Option<ManagedStopFence>,
    target: SessionConversionTarget,
    provider_id: String,
    expected_conversation_id: Option<String>,
    cwd: String,
    confirmed: bool,
    permission_mode: PermissionMode,
    credential_id: Option<String>,
    credential_directory: Option<String>,
    credential_generation: Option<u64>,
    rows: u16,
    columns: u16,
    terminal_environment: TerminalEnvironment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    terminal_default_colors: Option<hmux_client::TerminalDefaultColors>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConversionReceipt {
    pub source_session_id: String,
    pub source_workspace_id: String,
    pub target_class: &'static str,
    pub target_build_id: Option<String>,
    pub replacement_idempotency_key: Option<String>,
    pub action: &'static str,
    pub outcome: &'static str,
    pub replayed: bool,
    pub reason: Option<String>,
    pub requires_confirmation: bool,
    pub provider_id: String,
    pub conversation_id: Option<String>,
    pub replacement_session: Option<SessionSummary>,
}

impl HmuxManager {
    pub fn convert_session<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        request: SessionConversionRequest,
    ) -> Result<SessionConversionReceipt, String> {
        validate_request(&request)?;
        let catalog = product_catalog().map_err(|error| error.to_string())?;

        if !request.confirmed {
            let cwd = canonical_cwd(&request.cwd)?;
            let source = exact_source(&catalog, &request)?;
            let identity = inspect_source_provider(&source, &request, &cwd)?;
            validate_expected_conversation(&request, &identity)?;
            return Ok(refusal(
                &request,
                runtime::current_build_id(),
                "update_requires_confirmation",
                true,
                Some(identity.conversation_id),
                false,
            ));
        }

        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        let catalog = operation::execution_catalog(&catalog, &request)?;
        let state = operation::reserve(&catalog, request, |request, checkpoint| {
            launch::prepare(
                &catalog,
                request,
                checkpoint,
                runtime::ensure_current_build(app)?,
            )
        })?;
        let (prepared, mut reservation) = match state {
            operation::ReservedConversion::Completed(completed) => {
                let (request, completion, target) = *completed;
                return replay_completion(&catalog, &request, completion, target);
            }
            operation::ReservedConversion::Pending(pending) => *pending,
        };
        let request = prepared.request.clone();
        let current = prepared.current.clone();
        let cwd = PathBuf::from(&request.cwd);
        let _source_lock = recovery::lock_source(
            catalog.discovery_root(),
            &request.source_workspace_id,
            &request.source_session_id,
        )?;
        let replayed = reservation.was_existing();
        let mut checkpoint = match reservation.resume_checkpoint().cloned() {
            Some(checkpoint) => {
                if checkpoint.provider_id != request.provider_id
                    || checkpoint.provider_cwd != cwd.to_string_lossy()
                    || request
                        .expected_conversation_id
                        .as_deref()
                        .is_some_and(|expected| expected != checkpoint.resume_identity)
                {
                    return Err(
                        "hmux_recovery_idempotency_conflict: conversion checkpoint changed"
                            .to_string(),
                    );
                }
                checkpoint
            }
            None => {
                let checkpoint = prepared.initial_checkpoint.clone();
                reservation.checkpoint_resume(checkpoint.clone())?;
                checkpoint
            }
        };
        let source_identity = identity_from_checkpoint(&checkpoint)?;

        if request.target == SessionConversionTarget::Standalone
            && (request.credential_id.is_some()
                || request.credential_directory.is_some()
                || request.credential_generation.is_some())
        {
            return Ok(refusal(
                &request,
                Some(current.build_id),
                "session_conversion_credential_release_unsupported",
                false,
                Some(source_identity.conversation_id),
                replayed,
            ));
        }

        let source_to_stop = if !checkpoint.source_terminated {
            prepared
                .launch
                .ensure_target_available(&catalog, &current.runtime)?;
            let source = match source_retirement_state(
                &catalog,
                &request,
                &checkpoint,
                &source_identity,
            )? {
                SourceRetirementState::FenceChanged => {
                    return Ok(refusal(
                        &request,
                        Some(current.build_id),
                        "session_conversion_source_fence_changed",
                        false,
                        Some(source_identity.conversation_id),
                        replayed,
                    ));
                }
                SourceRetirementState::ProcessChanged => {
                    return Ok(refusal(
                        &request,
                        Some(current.build_id),
                        "session_conversion_process_changed",
                        false,
                        Some(source_identity.conversation_id),
                        replayed,
                    ));
                }
                SourceRetirementState::AlreadyRetired => None,
                SourceRetirementState::Live(source) => {
                    let selector = SessionSelector::new(
                        source.session_id.clone(),
                        Some(source.workspace_id.clone()),
                    );
                    if probe_local_session(&catalog, &selector) != SessionProbeStatus::Healthy {
                        return Err(
                        "session_conversion_source_unhealthy: source session failed its health probe"
                            .to_string(),
                    );
                    }
                    let observed = inspect_source_provider(&source, &request, &cwd)?;
                    if observed != source_identity {
                        return Ok(refusal(
                            &request,
                            Some(current.build_id),
                            "session_conversion_process_changed",
                            false,
                            Some(source_identity.conversation_id),
                            replayed,
                        ));
                    }
                    Some(source)
                }
            };
            prepared.retain_source_checkout(&catalog)?;
            source
        } else {
            if !matches!(
                source_retirement_state(&catalog, &request, &checkpoint, &source_identity)?,
                SourceRetirementState::AlreadyRetired,
            ) {
                return Err(
                    "session_conversion_process_changed: terminated source identity is live"
                        .to_string(),
                );
            }
            None
        };
        retirement::finish(
            &catalog,
            &current.runtime,
            &request,
            source_to_stop.as_deref(),
            &checkpoint,
        )?;
        if !checkpoint.source_terminated {
            checkpoint.source_terminated = true;
            reservation.checkpoint_resume(checkpoint.clone())?;
        }

        let root_key =
            conversion_replacement_idempotency_key(&request.conversion_id, checkpoint.attempt);
        let replacement = match create_replacement(ReplacementContext {
            manager: self,
            catalog: &catalog,
            prepared: &prepared,
            expected_identity: &source_identity,
            idempotency_key: &root_key,
            attempt: checkpoint.attempt,
            reservation: &mut reservation,
        }) {
            Ok(ReplacementAttempt::Ready(replacement)) => *replacement,
            Ok(ReplacementAttempt::Retired) => {
                return Ok(refusal(
                    &request,
                    Some(current.build_id),
                    "session_conversion_replacement_retired",
                    false,
                    Some(source_identity.conversation_id),
                    replayed,
                ));
            }
            Err(reason) => {
                return Ok(SessionConversionReceipt {
                    source_session_id: request.source_session_id,
                    source_workspace_id: request.source_workspace_id,
                    target_class: request.target.as_str(),
                    target_build_id: Some(current.build_id),
                    replacement_idempotency_key: None,
                    action: request.target.action(),
                    outcome: "replacement_failed",
                    replayed,
                    reason: Some(reason),
                    requires_confirmation: false,
                    provider_id: source_identity.provider_id,
                    conversation_id: Some(source_identity.conversation_id),
                    replacement_session: None,
                });
            }
        };
        let replacement_idempotency_key = replacement
            .managed_receipt
            .as_ref()
            .map(|receipt| receipt.idempotency_key().to_string());
        let mut operation_checkpoint = reservation.operation_checkpoint().cloned();
        if let Some(receipt) = replacement.managed_receipt {
            // Hmux owns pending successor history. Freeze only the actual
            // terminal result together with this outer completion.
            let operation = operation_checkpoint.as_mut().ok_or_else(|| {
                "hmux_recovery_journal_invalid: completed conversion has no prepared inputs"
                    .to_string()
            })?;
            operation.replacement_receipt =
                Some(serde_json::to_string(&receipt).map_err(|error| error.to_string())?);
        }
        let replacement = replacement.session;
        let replacement_build_id = replacement.host_build_version.clone();
        reservation.complete(recovery::RecoveryCompletion {
            target_session_id: replacement.session_id.clone(),
            target_workspace_id: replacement.workspace_id.clone(),
            target_build_id: replacement_build_id.clone(),
            action: request.target.action().to_string(),
            outcome: "converted".to_string(),
            resume_checkpoint: Some(checkpoint),
            operation_checkpoint,
        })?;
        Ok(SessionConversionReceipt {
            source_session_id: request.source_session_id,
            source_workspace_id: request.source_workspace_id,
            target_class: request.target.as_str(),
            target_build_id: Some(replacement_build_id),
            replacement_idempotency_key,
            action: request.target.action(),
            outcome: "converted",
            replayed,
            reason: None,
            requires_confirmation: false,
            provider_id: source_identity.provider_id,
            conversation_id: Some(source_identity.conversation_id),
            replacement_session: Some(replacement),
        })
    }
}

fn validate_request(request: &SessionConversionRequest) -> Result<(), String> {
    validate_identifier("conversion id", &request.conversion_id)?;
    validate_identifier("source session id", &request.source_session_id)?;
    validate_identifier("source workspace id", &request.source_workspace_id)?;
    validate_identifier("provider id", &request.provider_id)?;
    if request.rows == 0 || request.columns == 0 {
        return Err("session conversion terminal dimensions must be non-zero".to_string());
    }
    if let Some(conversation_id) = request.expected_conversation_id.as_deref() {
        validate_cli_identity("expected conversation id", conversation_id)?;
    }
    if let Some(colors) = request.terminal_default_colors {
        colors.validate().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn validate_expected_conversation(
    request: &SessionConversionRequest,
    identity: &adoption::ProviderIdentity,
) -> Result<(), String> {
    validate_conversation_hint(
        request.expected_conversation_id.as_deref(),
        &identity.conversation_id,
    )
}

fn validate_conversation_hint(expected: Option<&str>, conversation_id: &str) -> Result<(), String> {
    if expected.is_some_and(|expected| expected != conversation_id) {
        return Err(
            "session_conversion_conversation_changed: provider conversation does not match the durable Agent binding"
                .to_string(),
        );
    }
    Ok(())
}

fn validated_replacement_conversation_id<'a>(
    request: &SessionConversionRequest,
    checkpoint_identity: &'a adoption::ProviderIdentity,
) -> Result<&'a str, String> {
    validate_expected_conversation(request, checkpoint_identity)?;
    Ok(checkpoint_identity.conversation_id.as_str())
}

fn canonical_cwd(cwd: &str) -> Result<PathBuf, String> {
    let cwd = fs::canonicalize(cwd)
        .map_err(|_| "session_conversion_cwd_unavailable: provider cwd is missing".to_string())?;
    if !cwd.is_dir() {
        return Err(
            "session_conversion_cwd_unavailable: provider cwd is not a directory".to_string(),
        );
    }
    Ok(cwd)
}

fn exact_source(
    catalog: &LocalSessionCatalog,
    request: &SessionConversionRequest,
) -> Result<SessionDescriptor, String> {
    let source = conversion_source(catalog, request)?;
    if source.lifecycle != SessionLifecycle::Ready {
        return Err("session_conversion_source_unhealthy: source session is not ready".to_string());
    }
    let selector =
        SessionSelector::new(source.session_id.clone(), Some(source.workspace_id.clone()));
    if probe_local_session(catalog, &selector) != SessionProbeStatus::Healthy {
        return Err(
            "session_conversion_source_unhealthy: source session failed its health probe"
                .to_string(),
        );
    }
    Ok(source)
}

fn conversion_source(
    catalog: &LocalSessionCatalog,
    request: &SessionConversionRequest,
) -> Result<SessionDescriptor, String> {
    let source = catalog
        .find(&SessionSelector::new(
            &request.source_session_id,
            Some(request.source_workspace_id.clone()),
        ))
        .map_err(|_| "session_conversion_source_missing: source session is absent".to_string())?;
    validate_conversion_source(request, &source)?;
    Ok(source)
}

fn validate_conversion_source(
    request: &SessionConversionRequest,
    source: &SessionDescriptor,
) -> Result<(), String> {
    let source_matches = match (request.target, source.session_class) {
        (SessionConversionTarget::Managed, SessionClass::Standalone | SessionClass::Managed) => {
            source.provider_id == "local-shell"
        }
        (SessionConversionTarget::Standalone, SessionClass::Managed) => {
            source.provider_id == request.provider_id
        }
        (SessionConversionTarget::Standalone, SessionClass::Standalone) => false,
    };
    if !source_matches {
        return Err(
            "session_conversion_source_mismatch: source class or provider changed".to_string(),
        );
    }
    match source.session_class {
        SessionClass::Managed => {
            let expected = request.expected_source_fence.as_ref().ok_or_else(|| {
                "session_conversion_source_fence_required: managed source has no client-owned complete fence"
                    .to_string()
            })?;
            expected.validate()?;
            if !expected.matches(source) {
                return Err(
                    "session_conversion_source_fence_changed: managed source generation changed after confirmation"
                        .to_string(),
                );
            }
        }
        SessionClass::Standalone if request.expected_source_fence.is_some() => {
            return Err(
                "session_conversion_source_mismatch: standalone source cannot carry a managed fence"
                    .to_string(),
            );
        }
        SessionClass::Standalone => {}
    }
    Ok(())
}

enum SourceRetirementState {
    Live(Box<SessionDescriptor>),
    AlreadyRetired,
    FenceChanged,
    ProcessChanged,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SourceProcessPosture {
    Live,
    Retired,
    Changed,
    InvalidRetirement,
}

fn source_process_posture(
    lifecycle: Option<SessionLifecycle>,
    host_live: bool,
    provider_live: bool,
) -> SourceProcessPosture {
    match (lifecycle, host_live, provider_live) {
        (None | Some(SessionLifecycle::Exited), false, false)
        | (Some(SessionLifecycle::Ready), false, false) => SourceProcessPosture::Retired,
        (None | Some(SessionLifecycle::Exited), _, _) => SourceProcessPosture::InvalidRetirement,
        (Some(SessionLifecycle::Ready), true, true) => SourceProcessPosture::Live,
        (Some(SessionLifecycle::Ready), _, _) => SourceProcessPosture::Changed,
    }
}

fn source_retirement_state(
    catalog: &LocalSessionCatalog,
    request: &SessionConversionRequest,
    checkpoint: &recovery::RecoveryResumeCheckpoint,
    identity: &adoption::ProviderIdentity,
) -> Result<SourceRetirementState, String> {
    let source = match catalog.find(&SessionSelector::new(
        &request.source_session_id,
        Some(request.source_workspace_id.clone()),
    )) {
        Ok(source) => source,
        Err(error) if error.is_session_absent() => {
            return match source_process_posture(
                None,
                adoption::source_host_matches(identity),
                adoption::source_provider_matches(identity),
            ) {
                SourceProcessPosture::Retired => Ok(SourceRetirementState::AlreadyRetired),
                _ => Err(
                    "session_conversion_process_changed: source discovery is absent while a fenced process remains live"
                        .to_string(),
                ),
            };
        }
        Err(error) => {
            return Err(format!(
                "session_conversion_source_unavailable: source discovery could not be inspected: {error}"
            ));
        }
    };
    validate_conversion_source(request, &source)?;
    if !source_fence_matches(checkpoint, &source) {
        return Ok(SourceRetirementState::FenceChanged);
    }
    if source.lifecycle == SessionLifecycle::Exited {
        // Managed retirement is finalized from the durable request below,
        // including replays whose source manifest has already disappeared.
        if source.session_class == SessionClass::Standalone {
            retirement::stop_standalone_source(catalog, &source, checkpoint)?;
        }
        return Ok(SourceRetirementState::AlreadyRetired);
    }

    let host_live = adoption::source_host_matches(identity);
    let provider_live = adoption::source_provider_matches(identity);
    match source_process_posture(Some(source.lifecycle), host_live, provider_live) {
        SourceProcessPosture::Live => Ok(SourceRetirementState::Live(Box::new(source))),
        SourceProcessPosture::Retired => Ok(SourceRetirementState::AlreadyRetired),
        SourceProcessPosture::Changed => Ok(SourceRetirementState::ProcessChanged),
        SourceProcessPosture::InvalidRetirement => {
            Err("session_conversion_process_changed: exited source identity is live".to_string())
        }
    }
}

fn inspect_source_provider(
    source: &SessionDescriptor,
    request: &SessionConversionRequest,
    cwd: &std::path::Path,
) -> Result<adoption::ProviderIdentity, String> {
    adoption::inspect_provider_under_host(source.host_process.process_id, &request.provider_id, cwd)
}

fn checkpoint_from_identity(
    identity: &adoption::ProviderIdentity,
    source: &SessionDescriptor,
) -> recovery::RecoveryResumeCheckpoint {
    recovery::RecoveryResumeCheckpoint {
        provider_id: identity.provider_id.clone(),
        resume_identity: identity.conversation_id.clone(),
        provider_cwd: identity.provider_cwd.to_string_lossy().into_owned(),
        source_host_process_id: identity.host_pid,
        source_host_start_marker: identity.host_start_time.to_string(),
        source_provider_process_id: identity.provider_pid,
        source_provider_start_marker: identity.provider_start_time.to_string(),
        source_host_instance_id: Some(source.host_instance_id.clone()),
        source_terminal_epoch: Some(source.terminal_epoch.clone()),
        source_host_proof_marker: Some(source.host_process.start_marker.clone()),
        source_provider_proof_marker: Some(source.provider_process.start_marker.clone()),
        source_terminated: false,
        attempt: 0,
    }
}

fn source_fence_matches(
    checkpoint: &recovery::RecoveryResumeCheckpoint,
    source: &SessionDescriptor,
) -> bool {
    checkpoint.source_host_instance_id.as_deref() == Some(&source.host_instance_id)
        && checkpoint.source_terminal_epoch.as_deref() == Some(&source.terminal_epoch)
        && checkpoint.source_host_process_id == source.host_process.process_id
        && checkpoint.source_host_proof_marker.as_deref() == Some(&source.host_process.start_marker)
        && checkpoint.source_provider_proof_marker.as_deref()
            == Some(&source.provider_process.start_marker)
}

fn identity_from_checkpoint(
    checkpoint: &recovery::RecoveryResumeCheckpoint,
) -> Result<adoption::ProviderIdentity, String> {
    Ok(adoption::ProviderIdentity {
        host_pid: checkpoint.source_host_process_id,
        host_start_time: checkpoint.source_host_start_marker.parse().map_err(|_| {
            "hmux_recovery_journal_invalid: host start marker is invalid".to_string()
        })?,
        provider_pid: checkpoint.source_provider_process_id,
        provider_start_time: checkpoint
            .source_provider_start_marker
            .parse()
            .map_err(|_| {
                "hmux_recovery_journal_invalid: provider start marker is invalid".to_string()
            })?,
        provider_id: checkpoint.provider_id.clone(),
        conversation_id: checkpoint.resume_identity.clone(),
        provider_cwd: PathBuf::from(&checkpoint.provider_cwd),
    })
}

fn verify_replacement(
    catalog: &LocalSessionCatalog,
    descriptor: SessionDescriptor,
    request: &SessionConversionRequest,
    build_id: &str,
    expected_identity: &adoption::ProviderIdentity,
) -> Result<SessionSummary, String> {
    let expected_provider = match request.target {
        SessionConversionTarget::Managed => request.provider_id.as_str(),
        SessionConversionTarget::Standalone => "local-shell",
    };
    let selector = SessionSelector::new(
        descriptor.session_id.clone(),
        Some(descriptor.workspace_id.clone()),
    );
    if descriptor.session_class != request.target.class()
        || descriptor.lifecycle != SessionLifecycle::Ready
        || descriptor.provider_id != expected_provider
        || descriptor.host_build_version != build_id
        || probe_local_session(catalog, &selector) != SessionProbeStatus::Healthy
    {
        return Err(
            "session_conversion_replacement_unverified: replacement identity is invalid"
                .to_string(),
        );
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        match adoption::inspect_provider_under_host(
            descriptor.host_process.process_id,
            &expected_identity.provider_id,
            &expected_identity.provider_cwd,
        ) {
            Ok(identity)
                if identity.provider_id == expected_identity.provider_id
                    && identity.conversation_id == expected_identity.conversation_id
                    && identity.provider_cwd == expected_identity.provider_cwd =>
            {
                let current = catalog.find(&selector).map_err(|_| {
                    "session_conversion_replacement_unverified: replacement disappeared after provider verification"
                        .to_string()
                })?;
                if !same_session_generation(&descriptor, &current) {
                    return Err(
                        "session_conversion_replacement_unverified: replacement generation changed during verification"
                            .to_string(),
                    );
                }
                return Ok(probe_and_project_session(catalog, current));
            }
            Ok(_) => {
                return Err(
                    "session_conversion_replacement_identity_changed: replacement opened a different conversation or cwd"
                        .to_string(),
                );
            }
            Err(error) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(100));
                if !process_generation_is_live(&descriptor.host_process) {
                    return Err(
                        "session_conversion_replacement_exited: replacement Host exited before identity verification"
                            .to_string(),
                    );
                }
                let _ = error;
            }
            Err(error) => {
                return Err(format!(
                    "session_conversion_replacement_identity_unverified: {error}"
                ));
            }
        }
    }
}

fn same_session_generation(left: &SessionDescriptor, right: &SessionDescriptor) -> bool {
    left.session_id == right.session_id
        && left.workspace_id == right.workspace_id
        && left.host_instance_id == right.host_instance_id
        && left.terminal_epoch == right.terminal_epoch
        && left.host_process == right.host_process
        && left.provider_process == right.provider_process
}

fn replay_completion(
    catalog: &LocalSessionCatalog,
    request: &SessionConversionRequest,
    completion: recovery::RecoveryCompletion,
    target: Option<launch::CompletedTarget>,
) -> Result<SessionConversionReceipt, String> {
    if completion.action != request.target.action() || completion.outcome != "converted" {
        return Err(
            "hmux_recovery_journal_invalid: conversion completion is unsupported".to_string(),
        );
    }
    let checkpoint = completion.resume_checkpoint.ok_or_else(|| {
        "hmux_recovery_journal_invalid: conversion completion lost resume identity".to_string()
    })?;
    let (descriptor, replacement_idempotency_key) = match target {
        Some(launch::CompletedTarget::Standalone(target)) => {
            let Some(created) = launch::reopen_standalone_target(catalog, &target)? else {
                return Ok(refusal(
                    request,
                    Some(completion.target_build_id),
                    "session_conversion_replacement_retired",
                    false,
                    Some(checkpoint.resume_identity),
                    true,
                ));
            };
            (created.session().descriptor().clone(), None)
        }
        Some(launch::CompletedTarget::Managed(receipt)) => {
            if receipt.session_id() != completion.target_session_id
                || receipt.workspace_id() != completion.target_workspace_id
            {
                return Err(
                    "hmux_recovery_journal_invalid: completed managed target changed".into(),
                );
            }
            let created = hmux_client::CreatedManagedSession::from_completed_receipt(receipt)
                .map_err(|error| error.to_string())?;
            (
                created.session().descriptor().clone(),
                Some(created.receipt().idempotency_key().to_string()),
            )
        }
        None => {
            // Old completions predate the runtime-owned successor receipt.
            let descriptor = catalog
                .find(&SessionSelector::new(
                    &completion.target_session_id,
                    Some(completion.target_workspace_id),
                ))
                .map_err(|_| {
                    "session_conversion_receipt_target_missing: completed target is unavailable"
                        .to_string()
                })?;
            let key = (request.target == SessionConversionTarget::Managed).then(|| {
                conversion_replacement_idempotency_key(&request.conversion_id, checkpoint.attempt)
            });
            (descriptor, key)
        }
    };
    let replacement = verify_replacement(
        catalog,
        descriptor,
        request,
        &completion.target_build_id,
        &identity_from_checkpoint(&checkpoint)?,
    )?;
    Ok(SessionConversionReceipt {
        source_session_id: request.source_session_id.clone(),
        source_workspace_id: request.source_workspace_id.clone(),
        target_class: request.target.as_str(),
        target_build_id: Some(completion.target_build_id),
        replacement_idempotency_key,
        action: request.target.action(),
        outcome: "converted",
        replayed: true,
        reason: None,
        requires_confirmation: false,
        provider_id: checkpoint.provider_id,
        conversation_id: Some(checkpoint.resume_identity),
        replacement_session: Some(replacement),
    })
}

fn refusal(
    request: &SessionConversionRequest,
    target_build_id: Option<String>,
    reason: &str,
    requires_confirmation: bool,
    conversation_id: Option<String>,
    replayed: bool,
) -> SessionConversionReceipt {
    SessionConversionReceipt {
        source_session_id: request.source_session_id.clone(),
        source_workspace_id: request.source_workspace_id.clone(),
        target_class: request.target.as_str(),
        target_build_id,
        replacement_idempotency_key: None,
        action: request.target.action(),
        outcome: "refused",
        replayed,
        reason: Some(reason.to_string()),
        requires_confirmation,
        provider_id: request.provider_id.clone(),
        conversation_id,
        replacement_session: None,
    }
}

fn conversion_digest(source_session_id: &str, target: SessionConversionTarget) -> String {
    let mut digest = Sha256::new();
    digest.update(source_session_id.as_bytes());
    digest.update([0]);
    digest.update(target.as_str().as_bytes());
    format!("{:x}", digest.finalize())[..24].to_string()
}

fn conversion_target_session_id(
    source_session_id: &str,
    target: SessionConversionTarget,
    attempt: u32,
) -> String {
    let base = format!("convert_{}", conversion_digest(source_session_id, target));
    if attempt == 0 {
        base
    } else {
        format!("{base}_{attempt}")
    }
}

fn conversion_standalone_name(
    source_session_id: &str,
    target: SessionConversionTarget,
    attempt: u32,
) -> String {
    let base = format!("convert-{}", conversion_digest(source_session_id, target));
    if attempt == 0 {
        base
    } else {
        format!("{base}-{attempt}")
    }
}

fn conversion_replacement_idempotency_key(conversion_id: &str, attempt: u32) -> String {
    if attempt == 0 {
        conversion_id.to_string()
    } else {
        format!("{conversion_id}_{attempt}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_client::{
        EndpointDescriptor, EndpointKind, ProcessDescriptor, ProtocolVersion, VersionRange,
    };

    fn source_descriptor(session_class: SessionClass, provider_id: &str) -> SessionDescriptor {
        SessionDescriptor {
            schema_version: 1,
            session_id: "source-session".into(),
            session_name: None,
            workspace_id: "dure-local-shells-v1".into(),
            session_class,
            lifecycle: SessionLifecycle::Ready,
            provider_id: provider_id.into(),
            runtime_host: None,
            worktree_alias: None,
            branch: None,
            launch_program: Some("/bin/zsh".into()),
            runner_principal: "principal-1".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: "7".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
            output_seq: "11".into(),
            host_build_version: "build-1".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: Vec::new(),
            retirement_policy: None,
            host_process: ProcessDescriptor {
                process_id: 10,
                start_marker: "host-start".into(),
            },
            provider_process: ProcessDescriptor {
                process_id: 11,
                start_marker: "provider-start".into(),
            },
            endpoint: EndpointDescriptor {
                kind: EndpointKind::UnixSocket,
                address: "/tmp/hmux-conversion-test.sock".into(),
            },
            created_unix_ms: "1".into(),
            lifecycle_changed_unix_ms: "2".into(),
            exit: None,
            failure: None,
        }
    }

    fn stop_fence(source: &SessionDescriptor) -> ManagedStopFence {
        ManagedStopFence {
            runner_principal: source.runner_principal.clone(),
            runner_instance: source.runner_instance.clone(),
            channel_epoch: source.channel_epoch.clone(),
            host_instance_id: source.host_instance_id.clone(),
            terminal_epoch: source.terminal_epoch.clone(),
        }
    }

    pub(super) fn managed_request(
        expected_conversation_id: Option<&str>,
    ) -> SessionConversionRequest {
        SessionConversionRequest {
            conversion_id: "conversion_1".into(),
            source_session_id: "standalone_source".into(),
            source_workspace_id: "workspace_1".into(),
            expected_source_fence: None,
            target: SessionConversionTarget::Managed,
            provider_id: "codex".into(),
            expected_conversation_id: expected_conversation_id.map(str::to_string),
            cwd: "/tmp".into(),
            confirmed: true,
            permission_mode: PermissionMode::Default,
            credential_id: None,
            credential_directory: None,
            credential_generation: None,
            rows: 24,
            columns: 80,
            terminal_environment: TerminalEnvironment::default(),
            terminal_default_colors: None,
        }
    }

    pub(super) fn retired_checkpoint() -> recovery::RecoveryResumeCheckpoint {
        recovery::RecoveryResumeCheckpoint {
            provider_id: "codex".into(),
            resume_identity: "conversation-1".into(),
            provider_cwd: "/tmp".into(),
            source_host_process_id: 100,
            source_host_start_marker: "1".into(),
            source_provider_process_id: 101,
            source_provider_start_marker: "2".into(),
            source_host_instance_id: Some("host-1".into()),
            source_terminal_epoch: Some("terminal-1".into()),
            source_host_proof_marker: Some("1".into()),
            source_provider_proof_marker: Some("2".into()),
            source_terminated: true,
            attempt: 0,
        }
    }

    #[test]
    fn retired_source_replacement_uses_checkpoint_identity_when_client_hint_is_absent() {
        let checkpoint = retired_checkpoint();
        assert!(checkpoint.source_terminated);
        let identity = identity_from_checkpoint(&checkpoint).unwrap();

        assert_eq!(
            validated_replacement_conversation_id(&managed_request(None), &identity).unwrap(),
            "conversation-1"
        );
        assert_eq!(
            validated_replacement_conversation_id(
                &managed_request(Some("another-conversation")),
                &identity,
            )
            .unwrap_err(),
            "session_conversion_conversation_changed: provider conversation does not match the durable Agent binding"
        );
    }

    #[test]
    fn request_validation_defers_provider_capability_to_exact_adoption() {
        for provider_id in ["codex", "claude", "kimi"] {
            let mut request = managed_request(None);
            request.provider_id = provider_id.to_string();
            assert!(validate_request(&request).is_ok(), "{provider_id}");
        }
    }

    #[test]
    fn standalone_conversion_seeds_the_requested_terminal_colors() {
        let mut value = serde_json::to_value(managed_request(None)).unwrap();
        value["target"] = "standalone".into();
        value["terminalDefaultColors"] = serde_json::json!({
            "foregroundRgb": 0x171717, "backgroundRgb": 0xffffff,
        });
        let request = serde_json::from_value(value).unwrap();
        let create = launch::standalone_request(
            &request, vec!["/bin/sh".into()], 0, "fixture-proof".into(),
        ).unwrap();
        assert_eq!(
            create.terminal_default_colors(),
            Some(hmux_client::TerminalDefaultColors::new(0x171717, 0xffffff).unwrap()),
        );
    }

    #[test]
    fn conversion_rejects_terminal_colors_outside_srgb() {
        for field in ["foregroundRgb", "backgroundRgb"] {
            let mut value = serde_json::to_value(managed_request(None)).unwrap();
            value["terminalDefaultColors"] = serde_json::json!({
                "foregroundRgb": 0x171717, "backgroundRgb": 0xffffff,
            });
            value["terminalDefaultColors"][field] = 0x0100_0000u32.into();
            let request = serde_json::from_value(value).unwrap();
            assert!(validate_request(&request).is_err(), "{field}");
        }
    }

    #[test]
    fn legacy_conversion_without_colors_preserves_its_wire_shape_and_launch_default() {
        let value = serde_json::to_value(managed_request(None)).unwrap();
        // Legacy recovery fingerprints include the entire serialized request.
        assert!(value.get("terminalDefaultColors").is_none());
        let request: SessionConversionRequest = serde_json::from_value(value.clone()).unwrap();
        validate_request(&request).unwrap();
        assert_eq!(serde_json::to_value(&request).unwrap(), value);
        let create = launch::standalone_request(
            &request, vec!["/bin/sh".into()], 0, "fixture-proof".into(),
        ).unwrap();
        assert_eq!(create.terminal_default_colors(), None);
    }

    #[test]
    fn managed_local_shell_is_a_fenced_source_for_managed_provider_conversion() {
        let source = source_descriptor(SessionClass::Managed, "local-shell");
        let mut request = managed_request(None);
        request.source_session_id = source.session_id.clone();
        request.source_workspace_id = source.workspace_id.clone();
        request.expected_source_fence = Some(stop_fence(&source));

        assert!(validate_conversion_source(&request, &source).is_ok());

        request.expected_source_fence = None;
        assert!(validate_conversion_source(&request, &source)
            .unwrap_err()
            .starts_with("session_conversion_source_fence_required:"));

        let managed_provider = source_descriptor(SessionClass::Managed, "codex");
        request.expected_source_fence = Some(stop_fence(&managed_provider));
        assert!(validate_conversion_source(&request, &managed_provider)
            .unwrap_err()
            .starts_with("session_conversion_source_mismatch:"));
    }

    #[test]
    fn target_identity_is_stable_across_retries_and_distinct_per_class() {
        assert_eq!(
            conversion_target_session_id("standalone_source", SessionConversionTarget::Managed, 0,),
            conversion_target_session_id("standalone_source", SessionConversionTarget::Managed, 0,)
        );
        assert_ne!(
            conversion_digest("standalone_source", SessionConversionTarget::Managed,),
            conversion_digest("standalone_source", SessionConversionTarget::Standalone,)
        );
        assert_ne!(
            conversion_target_session_id("standalone_source", SessionConversionTarget::Managed, 0,),
            conversion_target_session_id("standalone_source", SessionConversionTarget::Managed, 1,)
        );
        assert_eq!(
            conversion_replacement_idempotency_key("conversion_1", 2),
            "conversion_1_2"
        );
    }

    #[test]
    fn source_process_fallback_requires_absent_processes_to_infer_retirement() {
        for lifecycle in [None, Some(SessionLifecycle::Exited)] {
            assert_eq!(
                source_process_posture(lifecycle, false, false),
                SourceProcessPosture::Retired
            );
            assert_eq!(
                source_process_posture(lifecycle, true, false),
                SourceProcessPosture::InvalidRetirement
            );
            assert_eq!(
                source_process_posture(lifecycle, false, true),
                SourceProcessPosture::InvalidRetirement
            );
        }
        assert_eq!(
            source_process_posture(Some(SessionLifecycle::Ready), true, true),
            SourceProcessPosture::Live
        );
        assert_eq!(
            source_process_posture(Some(SessionLifecycle::Ready), false, true),
            SourceProcessPosture::Changed
        );
        assert_eq!(
            source_process_posture(Some(SessionLifecycle::Ready), false, false),
            SourceProcessPosture::Retired
        );
    }

}
