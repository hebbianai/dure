use super::*;
use hmux_client::{
    CompletedStandaloneTarget, CompletedStandaloneTargetLifecycle, CreatedStandaloneSession,
};

#[derive(Debug)]
pub(super) enum CompletedReplayError {
    Terminal(&'static str),
    Retryable(String),
}

pub(super) fn open_saved_target(
    catalog: &LocalSessionCatalog,
    payload: &PreparedPayload,
    saved: &str,
) -> Result<CreatedStandaloneSession, CompletedReplayError> {
    let target = CompletedStandaloneTarget::from_recovery_checkpoint(
        catalog,
        &payload.create_request,
        saved,
    )
    .map_err(|error| {
        if error.code() == "hmux_standalone_create_operation_invalid" {
            CompletedReplayError::Terminal("recovery_journal_invalid")
        } else {
            CompletedReplayError::Retryable(format!("{}: {error}", error.code()))
        }
    })?;
    if target.host_build_version() != payload.target_build_id {
        return Err(CompletedReplayError::Terminal("recovery_journal_invalid"));
    }
    match catalog
        .resolve_completed_standalone_target(target.generation(), target.provider_process())
    {
        CompletedStandaloneTargetLifecycle::Retired => {
            Err(CompletedReplayError::Terminal("recovery_identity_conflict"))
        }
        CompletedStandaloneTargetLifecycle::Active => {
            CreatedStandaloneSession::from_completed_target(&target).map_err(|error| {
                CompletedReplayError::Retryable(format!("{}: {error}", error.code()))
            })
        }
        CompletedStandaloneTargetLifecycle::Unresolved => Err(CompletedReplayError::Retryable(
            "hmux_recovery_target_unavailable: completed target is unresolved".into(),
        )),
    }
}

pub(super) fn replay_completion(
    catalog: &LocalSessionCatalog,
    request: &RecoveryExecutionRequest,
    identity: &recovery::PreparedRecoveryIdentity,
    completion: recovery::RecoveryCompletion,
) -> Result<RecoveryExecutionReceipt, String> {
    if let Some(reason) = completed_failure_reason(&completion.outcome) {
        return Ok(completed_failure_receipt(request, &completion, reason));
    }
    let descriptor = match completed_descriptor(catalog, request, &completion) {
        Ok(descriptor) => descriptor,
        Err(CompletedReplayError::Terminal(reason)) => {
            return persist_completed_replay_failure(
                catalog,
                request,
                identity,
                &completion,
                reason,
            );
        }
        Err(CompletedReplayError::Retryable(message)) => return Err(message),
    };
    Ok(RecoveryExecutionReceipt {
        source_session_id: request.session_id.clone(),
        target_build_id: Some(completion.target_build_id),
        action: ACTION,
        outcome: "restored",
        replayed: true,
        reason: None,
        operation_id: None,
        conversation_id: None,
        launch_reference: None,
        source_stop_receipt: None,
        replacement_target: None,
        replacement_session: Some(project_known_healthy_session(descriptor)),
    })
}

fn completed_descriptor(
    catalog: &LocalSessionCatalog,
    request: &RecoveryExecutionRequest,
    completion: &recovery::RecoveryCompletion,
) -> Result<SessionDescriptor, CompletedReplayError> {
    let invalid = || CompletedReplayError::Terminal("recovery_journal_invalid");
    if completion.action != ACTION || completion.outcome != "restored" {
        return Err(invalid());
    }
    let descriptor = if let Some(checkpoint) = completion.operation_checkpoint.as_ref() {
        let payload = parse_payload(checkpoint).map_err(|_| invalid())?;
        validate_payload(&payload, request).map_err(|_| invalid())?;
        if payload.target_build_id != completion.target_build_id {
            return Err(invalid());
        }
        let saved = checkpoint
            .replacement_receipt
            .as_deref()
            .ok_or_else(invalid)?;
        open_saved_target(catalog, &payload, saved)?
            .session()
            .descriptor()
            .clone()
    } else {
        // Receipts predating prepared recovery have no creation proof. Preserve
        // their read-only projection; never infer authority to launch from them.
        catalog
            .find(&SessionSelector::new(
                &completion.target_session_id,
                Some(completion.target_workspace_id.clone()),
            ))
            .map_err(|error| {
                CompletedReplayError::Retryable(format!("{}: {error}", error.code()))
            })?
    };
    if descriptor.session_id != completion.target_session_id
        || descriptor.workspace_id != completion.target_workspace_id
        || descriptor.host_build_version != completion.target_build_id
        || descriptor.session_class != SessionClass::Standalone
        || descriptor.provider_id != "local-shell"
    {
        return Err(invalid());
    }
    if descriptor.lifecycle != SessionLifecycle::Ready
        || probe_local_session_exact(catalog, &descriptor) != SessionProbeStatus::Healthy
    {
        return Err(CompletedReplayError::Retryable(
            "hmux_recovery_receipt_target_unhealthy: completed target failed its handshake".into(),
        ));
    }
    Ok(descriptor)
}

fn persist_completed_replay_failure(
    catalog: &LocalSessionCatalog,
    request: &RecoveryExecutionRequest,
    identity: &recovery::PreparedRecoveryIdentity,
    completion: &recovery::RecoveryCompletion,
    reason: &'static str,
) -> Result<RecoveryExecutionReceipt, String> {
    let terminal_outcome = match reason {
        "recovery_journal_invalid" => "failed_recovery_journal_invalid",
        "recovery_identity_conflict" => "failed_recovery_identity_conflict",
        _ => {
            return Err(
                "hmux_recovery_journal_invalid: unsupported replay failure reason".to_string(),
            );
        }
    };
    let persisted = recovery::record_prepared_replay_terminal_outcome(
        catalog.discovery_root(),
        identity,
        completion,
        terminal_outcome,
    )?;
    Ok(completed_failure_receipt(request, &persisted, reason))
}

fn completed_failure_reason(outcome: &str) -> Option<&'static str> {
    match outcome {
        "failed_recovery_journal_invalid" => Some("recovery_journal_invalid"),
        "failed_recovery_source_changed" => Some("recovery_source_changed"),
        "failed_recovery_target_build_unavailable" => Some("recovery_target_build_unavailable"),
        "failed_recovery_identity_conflict" => Some("recovery_identity_conflict"),
        _ => None,
    }
}

fn completed_failure_receipt(
    request: &RecoveryExecutionRequest,
    completion: &recovery::RecoveryCompletion,
    reason: &'static str,
) -> RecoveryExecutionReceipt {
    RecoveryExecutionReceipt {
        source_session_id: request.session_id.clone(),
        target_build_id: Some(completion.target_build_id.clone()),
        action: ACTION,
        outcome: "failed",
        replayed: true,
        reason: Some(reason),
        operation_id: None,
        conversation_id: None,
        launch_reference: None,
        source_stop_receipt: None,
        replacement_target: None,
        replacement_session: None,
    }
}
