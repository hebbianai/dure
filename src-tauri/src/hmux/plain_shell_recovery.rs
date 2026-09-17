use super::{
    HmuxManager, RecoveryExecutionReceipt, RecoveryExecutionRequest,
    project_known_healthy_session, recovery, recovery_execution_refusal,
    recovery_request_refusal, runtime, validate_identifier, verified_resurrection_recipe,
};
use base64::Engine;
use hmux_client::{
    LocalSessionCatalog, PresentationCheckpointPredecessor,
    RecoveryDecision, RecoveryPolicyInput, SessionClass, SessionDescriptor, SessionLifecycle,
    SessionProbeStatus, SessionSelector, StandaloneCreateRequest,
    StandaloneRecoveryCreateIdentity, evaluate_recovery_policy,
    probe_local_session_exact,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

const ACTION: &str = "restore_plain_shell_with_current_build";

mod completed;
mod launch;

use completed::CompletedReplayError;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedPayload {
    recovery_id: String,
    source_session_id: String,
    source_workspace_id: String,
    source_runner_principal: String,
    source_runner_instance: String,
    source_channel_epoch: String,
    source_host_instance_id: String,
    source_terminal_epoch: String,
    source_session_name: String,
    target_build_id: String,
    create_request: StandaloneCreateRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_checkout: Option<dure_app::SessionCheckoutBindingV1>,
}

enum Preparation {
    Prepared(Box<PreparedPayload>),
    Refused(Box<RecoveryExecutionReceipt>),
}

enum SourceValidationError {
    Terminal,
    Retryable(String),
}

#[derive(Clone, Copy)]
enum SourceRefusal {
    Healthy,
    IncompatibleProtocol,
    Changed,
    ProcessLive,
}

impl SourceRefusal {
    fn reason(self) -> &'static str {
        match self {
            Self::Healthy => "recovery_source_healthy",
            Self::IncompatibleProtocol => "incompatible_protocol",
            Self::Changed => "recovery_source_changed",
            Self::ProcessLive => "recovery_source_process_live",
        }
    }
}

pub(super) fn execute<R: tauri::Runtime>(
    manager: &HmuxManager,
    app: &AppHandle<R>,
    catalog: &LocalSessionCatalog,
    request: RecoveryExecutionRequest,
) -> Result<RecoveryExecutionReceipt, String> {
    let target_build_id = runtime::current_build_id();
    if request.managed_launch.is_some() {
        return Ok(recovery_request_refusal(
            &request.session_id,
            target_build_id,
            "managed_recovery_identity_mismatch",
        ));
    }
    let legacy_fingerprint = legacy_fingerprint(&request)?;
    let identity = recovery::PreparedRecoveryIdentity {
        recovery_id: request.recovery_id.clone(),
        source_session_id: request.session_id.clone(),
        source_workspace_id: request.workspace_id.clone(),
        action: ACTION,
        legacy_request_fingerprint: Some(legacy_fingerprint),
    };
    let state = match recovery::reserve_prepared(
        catalog.discovery_root(),
        identity.clone(),
        None,
    ) {
        Ok(state) => state,
        Err(error) if error.starts_with("hmux_recovery_prepare_required:") => {
            let payload = match prepare(app, catalog, &request)? {
                Preparation::Prepared(payload) => *payload,
                Preparation::Refused(receipt) => return Ok(*receipt),
            };
            let canonical_payload = serde_json::to_string(&payload).map_err(|_| {
                "hmux_recovery_request_invalid: prepared request is not serializable".to_string()
            })?;
            recovery::reserve_prepared(
                catalog.discovery_root(),
                identity.clone(),
                Some(canonical_payload),
            )?
        }
        Err(error) => return Err(error),
    };
    let mut reservation = match state {
        recovery::RecoveryReservationState::Completed(completion) => {
            return completed::replay_completion(catalog, &request, &identity, completion);
        }
        recovery::RecoveryReservationState::Pending(reservation) => reservation,
    };
    let payload = if let Some(checkpoint) = reservation.operation_checkpoint() {
        match parse_payload(checkpoint) {
            Ok(payload) => payload,
            Err(_) => {
                return complete_failure(
                    &mut reservation,
                    &request,
                    None,
                    "recovery_journal_invalid",
                );
            }
        }
    } else {
        let payload = match prepare(app, catalog, &request)? {
            Preparation::Prepared(payload) => *payload,
            Preparation::Refused(receipt) => return Ok(*receipt),
        };
        let canonical_payload = serde_json::to_string(&payload).map_err(|_| {
            "hmux_recovery_request_invalid: prepared request is not serializable".to_string()
        })?;
        reservation.prepare_operation_payload(recovery::RecoveryOperationPayload::new(
            canonical_payload,
        )?)?;
        payload
    };
    if validate_payload(&payload, &request).is_err() {
        return complete_failure(
            &mut reservation,
            &request,
            Some(&payload),
            "recovery_journal_invalid",
        );
    }
    let created = match reservation
        .operation_checkpoint()
        .and_then(|checkpoint| checkpoint.replacement_receipt.as_deref())
    {
        Some(saved) => completed::open_saved_target(catalog, &payload, saved),
        None => launch::create(catalog, &payload),
    };
    let created = match created {
        Ok(created) => created,
        Err(CompletedReplayError::Terminal(reason)) => {
            return complete_failure(&mut reservation, &request, Some(&payload), reason);
        }
        Err(CompletedReplayError::Retryable(message)) => return Err(message),
    };
    if reservation
        .operation_checkpoint()
        .and_then(|checkpoint| checkpoint.replacement_receipt.as_ref())
        .is_none()
    {
        let target = hmux_client::CompletedStandaloneTarget::from_created(
            created.receipt().clone(),
            created.session().descriptor(),
        )
        .map_err(|error| error.to_string())?;
        // Freeze the generation before projection can lose its response.
        // Existing receipts are immutable, including the legacy wire shape.
        reservation.checkpoint_replacement_receipt(
            serde_json::to_string(&target).map_err(|error| error.to_string())?,
        )?;
    }
    let descriptor = created.session().descriptor().clone();
    let replacement_probe = probe_local_session_exact(catalog, &descriptor);
    if descriptor.session_class != SessionClass::Standalone
        || descriptor.provider_id != "local-shell"
        || descriptor.session_name.as_deref() != Some(payload.source_session_name.as_str())
        || descriptor.host_build_version != payload.target_build_id
        || payload
            .create_request
            .recovery_identity()
            .is_none_or(|identity| identity.target_session_id() != descriptor.session_id)
        || replacement_probe != SessionProbeStatus::Healthy
    {
        return Err(
            "hmux_recovery_replacement_unhealthy: restored shell failed its fresh handshake"
                .to_string(),
        );
    }
    let replacement_session = project_known_healthy_session(descriptor);
    manager
        .pending_created
        .lock()
        .expect("Hmux pending create registry poisoned")
        .insert(replacement_session.session_id.clone(), created);
    reservation.complete(recovery::RecoveryCompletion {
        target_session_id: replacement_session.session_id.clone(),
        target_workspace_id: replacement_session.workspace_id.clone(),
        target_build_id: payload.target_build_id.clone(),
        action: ACTION.to_string(),
        outcome: "restored".to_string(),
        resume_checkpoint: None,
        operation_checkpoint: None,
    })?;
    Ok(RecoveryExecutionReceipt {
        source_session_id: payload.source_session_id,
        target_build_id: Some(payload.target_build_id),
        action: ACTION,
        outcome: "restored",
        replayed: false,
        reason: None,
        operation_id: None,
        conversation_id: None,
        launch_reference: None,
        source_stop_receipt: None,
        replacement_target: None,
        replacement_session: Some(replacement_session),
    })
}

fn complete_failure(
    reservation: &mut recovery::RecoveryReservation,
    request: &RecoveryExecutionRequest,
    payload: Option<&PreparedPayload>,
    reason: &'static str,
) -> Result<RecoveryExecutionReceipt, String> {
    let outcome = format!("failed_{reason}");
    reservation.complete(recovery::RecoveryCompletion {
        target_session_id: payload
            .and_then(|payload| payload.create_request.recovery_identity())
            .map_or_else(
                || request.session_id.clone(),
                |target| target.target_session_id().to_string(),
            ),
        target_workspace_id: request.workspace_id.clone(),
        target_build_id: payload
            .map(|payload| payload.target_build_id.clone())
            .or_else(runtime::current_build_id)
            .unwrap_or_else(|| "unavailable".to_string()),
        action: ACTION.to_string(),
        outcome,
        resume_checkpoint: None,
        operation_checkpoint: None,
    })?;
    Ok(RecoveryExecutionReceipt {
        source_session_id: request.session_id.clone(),
        target_build_id: payload.map(|payload| payload.target_build_id.clone()),
        action: ACTION,
        outcome: "failed",
        replayed: false,
        reason: Some(reason),
        operation_id: None,
        conversation_id: None,
        launch_reference: None,
        source_stop_receipt: None,
        replacement_target: None,
        replacement_session: None,
    })
}

fn legacy_fingerprint(request: &RecoveryExecutionRequest) -> Result<String, String> {
    let mut fingerprint_request = request.clone();
    fingerprint_request.confirmed = true;
    let serialized_request = serde_json::to_string(&fingerprint_request)
        .map_err(|_| "hmux_recovery_request_invalid: request is not serializable".to_string())?;
    Ok(recovery::request_fingerprint(&[&serialized_request]))
}

fn prepare<R: tauri::Runtime>(
    app: &AppHandle<R>,
    catalog: &LocalSessionCatalog,
    request: &RecoveryExecutionRequest,
) -> Result<Preparation, String> {
    let current = runtime::ensure_current_build(app)?;
    let target_build_id = Some(current.build_id.clone());
    let source = catalog
        .open(&SessionSelector::new(
            request.session_id.clone(),
            Some(request.workspace_id.clone()),
        ))
        .map_err(|error| error.to_string())?;
    let session = source.descriptor().clone();
    if session.session_class != SessionClass::Standalone
        || session.provider_id != "local-shell"
    {
        return Ok(Preparation::Refused(Box::new(recovery_execution_refusal(
            &session,
            target_build_id,
            "managed_recovery_identity_mismatch",
        ))));
    }
    let Some(session_name) = session.session_name.clone() else {
        return Ok(Preparation::Refused(Box::new(recovery_execution_refusal(
            &session,
            target_build_id,
            "verified_resurrection_recipe_required",
        ))));
    };
    let Some(recipe) = verified_resurrection_recipe(catalog.discovery_root(), &session_name) else {
        return Ok(Preparation::Refused(Box::new(recovery_execution_refusal(
            &session,
            target_build_id,
            "verified_resurrection_recipe_required",
        ))));
    };
    if let RecoveryDecision::Refused { reason, .. } =
        evaluate_recovery_policy(RecoveryPolicyInput::PlainShell {
            verified_recipe: true,
            replays_explicit_command: recipe.requires_operator_confirmation(),
            confirmed: request.confirmed,
        })
    {
        return Ok(Preparation::Refused(Box::new(recovery_execution_refusal(
            &session,
            target_build_id,
            reason,
        ))));
    }
    if let Some(refusal) = source_refusal(catalog, &session) {
        return Ok(Preparation::Refused(Box::new(recovery_execution_refusal(
            &session,
            target_build_id,
            refusal.reason(),
        ))));
    }

    let target_session_id = target_id(request, &session);
    let mut proof = [0_u8; 32];
    getrandom::fill(&mut proof)
        .map_err(|_| "hmux_recovery_random_failed: launch proof generation failed".to_string())?;
    let channel_epoch = session
        .channel_epoch
        .parse::<u64>()
        .map_err(|_| "hmux_recovery_source_invalid: source channel epoch is invalid".to_string())?;
    let predecessor = PresentationCheckpointPredecessor::new(
        &session.session_id,
        &session.runner_principal,
        &session.runner_instance,
        channel_epoch,
        &session.host_instance_id,
        &session.terminal_epoch,
    )
    .map_err(|error| error.to_string())?;
    let recovery_identity = StandaloneRecoveryCreateIdentity::new(
        target_session_id,
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(proof),
    )
    .and_then(|identity| identity.with_source_predecessor(predecessor))
    .map_err(|error| error.to_string())?;
    let create_request = recipe
        .to_create_request()
        .and_then(|request| request.with_recovery_identity(recovery_identity))
        .map_err(|error| error.to_string())?;
    let source_checkout = crate::session_checkout::checkout_for_session(
        current.runtime.clone(),
        catalog.discovery_root().to_path_buf(),
        source,
    )?;
    Ok(Preparation::Prepared(Box::new(PreparedPayload {
        recovery_id: request.recovery_id.clone(),
        source_session_id: session.session_id,
        source_workspace_id: session.workspace_id,
        source_runner_principal: session.runner_principal,
        source_runner_instance: session.runner_instance,
        source_channel_epoch: session.channel_epoch,
        source_host_instance_id: session.host_instance_id,
        source_terminal_epoch: session.terminal_epoch,
        source_session_name: session_name,
        target_build_id: current.build_id,
        create_request,
        source_checkout,
    })))
}

fn target_id(request: &RecoveryExecutionRequest, source: &SessionDescriptor) -> String {
    let mut digest = Sha256::new();
    for field in [
        "hmux_plain_shell_recovery_target_v1",
        request.recovery_id.as_str(),
        source.workspace_id.as_str(),
        source.session_id.as_str(),
        source.host_instance_id.as_str(),
        source.terminal_epoch.as_str(),
    ] {
        digest.update(field.len().to_le_bytes());
        digest.update(field.as_bytes());
    }
    let digest = format!("{:x}", digest.finalize());
    format!("standalone_{}", &digest[..12])
}

fn parse_payload(
    checkpoint: &recovery::RecoveryOperationCheckpoint,
) -> Result<PreparedPayload, String> {
    serde_json::from_str(&checkpoint.canonical_payload).map_err(|_| {
        "hmux_recovery_journal_invalid: prepared plain-shell request is malformed".to_string()
    })
}

pub(super) fn read_standalone_launch(
    action: &str,
    checkpoint: &recovery::RecoveryOperationCheckpoint,
) -> Result<Option<StandaloneCreateRequest>, String> {
    if action != ACTION {
        return Ok(None);
    }
    let create = parse_payload(checkpoint)?.create_request;
    create.validate().map_err(|error| error.to_string())?;
    Ok(Some(create))
}

fn validate_payload(
    payload: &PreparedPayload,
    request: &RecoveryExecutionRequest,
) -> Result<(), String> {
    payload
        .create_request
        .validate()
        .map_err(|_| "hmux_recovery_journal_invalid: create request is invalid".to_string())?;
    let target = payload
        .create_request
        .recovery_identity()
        .ok_or_else(|| {
            "hmux_recovery_journal_invalid: deterministic target identity is missing".to_string()
        })?;
    for (name, value) in [
        ("recovery id", payload.recovery_id.as_str()),
        ("source session id", payload.source_session_id.as_str()),
        ("source workspace id", payload.source_workspace_id.as_str()),
        (
            "source runner principal",
            payload.source_runner_principal.as_str(),
        ),
        (
            "source runner instance",
            payload.source_runner_instance.as_str(),
        ),
        ("source channel epoch", payload.source_channel_epoch.as_str()),
        (
            "source host instance id",
            payload.source_host_instance_id.as_str(),
        ),
        (
            "source terminal epoch",
            payload.source_terminal_epoch.as_str(),
        ),
        ("source session name", payload.source_session_name.as_str()),
        ("target build id", payload.target_build_id.as_str()),
    ] {
        validate_identifier(name, value).map_err(|_| {
            "hmux_recovery_journal_invalid: prepared identity is invalid".to_string()
        })?;
    }
    validate_predecessor(payload, target)?;
    if payload.recovery_id != request.recovery_id
        || payload.source_session_id != request.session_id
        || payload.source_workspace_id != request.workspace_id
        || payload.source_session_id == target.target_session_id()
        || payload.create_request.session_name() != Some(payload.source_session_name.as_str())
    {
        return Err(
            "hmux_recovery_idempotency_conflict: prepared plain-shell request changed".to_string(),
        );
    }
    Ok(())
}

fn validate_predecessor(
    payload: &PreparedPayload,
    target: &StandaloneRecoveryCreateIdentity,
) -> Result<(), String> {
    let source = target.source_predecessor().ok_or_else(|| {
        "hmux_recovery_journal_invalid: exact source predecessor is missing".to_string()
    })?;
    if source.session_id() != payload.source_session_id
        || source.runner_principal() != payload.source_runner_principal
        || source.runner_instance() != payload.source_runner_instance
        || source.channel_epoch().to_string() != payload.source_channel_epoch
        || source.host_instance_id() != payload.source_host_instance_id
        || source.terminal_epoch() != payload.source_terminal_epoch
    {
        return Err(
            "hmux_recovery_journal_invalid: exact source predecessor changed".to_string(),
        );
    }
    Ok(())
}

fn validate_source(
    catalog: &LocalSessionCatalog,
    payload: &PreparedPayload,
) -> Result<(), SourceValidationError> {
    let selector = SessionSelector::new(
        &payload.source_session_id,
        Some(payload.source_workspace_id.clone()),
    );
    let source = match catalog.find(&selector) {
        Ok(source) => source,
        Err(error) if error.is_session_absent() => return Ok(()),
        Err(error) => return Err(SourceValidationError::Retryable(error.to_string())),
    };
    if source.runner_principal != payload.source_runner_principal
        || source.runner_instance != payload.source_runner_instance
        || source.channel_epoch != payload.source_channel_epoch
        || source.host_instance_id != payload.source_host_instance_id
        || source.terminal_epoch != payload.source_terminal_epoch
        || source.session_class != SessionClass::Standalone
        || source.provider_id != "local-shell"
        || source.session_name.as_deref() != Some(payload.source_session_name.as_str())
    {
        return Err(SourceValidationError::Terminal);
    }
    if let Some(refusal) = source_refusal(catalog, &source) {
        if matches!(refusal, SourceRefusal::ProcessLive) {
            return Err(SourceValidationError::Retryable(
                "hmux_recovery_source_process_live: prepared source process is still live"
                    .to_string(),
            ));
        }
        return Err(SourceValidationError::Terminal);
    }
    Ok(())
}

fn source_refusal(
    catalog: &LocalSessionCatalog,
    session: &SessionDescriptor,
) -> Option<SourceRefusal> {
    if let Some(refusal) = probe_source_refusal(probe_local_session_exact(catalog, session)) {
        return Some(refusal);
    }
    (super::process_generation_is_live(&session.host_process)
        || super::process_generation_is_live(&session.provider_process))
    .then_some(SourceRefusal::ProcessLive)
}

fn probe_source_refusal(status: SessionProbeStatus) -> Option<SourceRefusal> {
    match status {
        SessionProbeStatus::Healthy => Some(SourceRefusal::Healthy),
        SessionProbeStatus::IncompatibleProtocol => Some(SourceRefusal::IncompatibleProtocol),
        SessionProbeStatus::GenerationChanged => Some(SourceRefusal::Changed),
        SessionProbeStatus::StaleTransport | SessionProbeStatus::Exited => None,
    }
}
#[cfg(test)]
mod tests;
