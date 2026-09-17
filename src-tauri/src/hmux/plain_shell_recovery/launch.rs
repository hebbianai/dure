use super::*;
use hmux_client::CreatedStandaloneSession;

pub(super) fn create(
    catalog: &LocalSessionCatalog,
    payload: &PreparedPayload,
) -> Result<CreatedStandaloneSession, CompletedReplayError> {
    // Serialize exact source operations here. Recipe mutation belongs to the
    // broker; holding its recipe lock while invoking it would contend with self.
    let _source_lock = recovery::lock_source(
        catalog.discovery_root(),
        &payload.source_workspace_id,
        &payload.source_session_id,
    )
    .map_err(CompletedReplayError::Retryable)?;
    validate_source(catalog, payload).map_err(|error| match error {
        SourceValidationError::Terminal => {
            CompletedReplayError::Terminal("recovery_source_changed")
        }
        SourceValidationError::Retryable(message) => CompletedReplayError::Retryable(message),
    })?;
    let current = runtime::resolve_installed_build(&payload.target_build_id).map_err(|_| {
        CompletedReplayError::Retryable(format!(
            "hmux_recovery_target_build_unavailable: prepared build {} is not currently installed",
            payload.target_build_id
        ))
    })?;
    crate::session_checkout::create_standalone_replacement(
        current.runtime,
        catalog.discovery_root().to_path_buf(),
        payload.source_checkout.clone(),
        payload.create_request.clone(),
        None,
    )
    .map_err(|error| match &error {
        dure_session_runtime::SessionCheckoutError::Runtime(error)
            if error.is_standalone_recovery_terminal_refusal() =>
        {
            CompletedReplayError::Terminal("recovery_identity_conflict")
        }
        _ => CompletedReplayError::Retryable(error.to_string()),
    })
}
