use super::*;
use hmux_client::recovery_journal::prepared_operation_exists;
use launch::PreparedConversion;

#[derive(Debug)]
pub(super) enum ReservedConversion {
    Pending(Box<(PreparedConversion, recovery::RecoveryReservation)>),
    Completed(
        Box<(
            SessionConversionRequest,
            recovery::RecoveryCompletion,
            Option<launch::CompletedTarget>,
        )>,
    ),
}

/// An existing operation retains its namespace for both resource ownership and
/// replacement execution. Changing the caller's primary root is not new intent.
/// Preserve the full discovery scope while selecting that original writer.
pub(super) fn execution_catalog(
    catalog: &LocalSessionCatalog,
    request: &SessionConversionRequest,
) -> Result<LocalSessionCatalog, String> {
    let mut request = request.clone();
    let _ = normalize_request(&mut request);
    let identity = prepared_identity(&request)?;
    let exists = |root: &std::path::Path| prepared_operation_exists(root, &identity);
    if exists(catalog.discovery_root())? {
        return Ok(catalog.clone());
    }
    let mut original = None;
    for root in catalog.discovery_paths().skip(1) {
        if exists(root)? && original.replace(root).is_some() {
            return Err(
                "hmux_recovery_idempotency_conflict: conversion has competing operation namespaces"
                    .into(),
            );
        }
    }
    match original {
        None => Ok(catalog.clone()),
        Some(root) => LocalSessionCatalog::with_read_only_discovery_roots(
            root,
            catalog.discovery_paths()
                .filter(|candidate| *candidate != root)
                .map(std::path::Path::to_path_buf)
                .collect(),
        ).map_err(|error| error.to_string()),
    }
}

/// Prepare only new operations or exact legacy upgrades. Replays consume the
/// journal without consulting mutable launch configuration or installation.
pub(super) fn reserve(
    catalog: &LocalSessionCatalog,
    mut request: SessionConversionRequest,
    mut prepare: impl FnMut(
        &SessionConversionRequest,
        Option<&recovery::RecoveryResumeCheckpoint>,
    ) -> Result<PreparedConversion, String>,
) -> Result<ReservedConversion, String> {
    // A prepared replay does not depend on a client's replacement cwd hint.
    // New/legacy inputs still cross the same canonical directory boundary.
    let cwd = normalize_request(&mut request);
    let identity = prepared_identity(&request)?;
    let mut prepare_payload = |prior_checkpoint| {
        cwd.as_ref().map_err(Clone::clone)?;
        serde_json::to_string(&prepare(&request, prior_checkpoint)?).map_err(|_| {
            "session_conversion_request_invalid: prepared launch is not serializable".to_string()
        })
    };
    // Observation needs no write namespace. The journal initializes it when
    // admitting the first complete payload, before any source retirement.
    let payload = if prepared_operation_exists(catalog.discovery_root(), &identity)? {
        None
    } else {
        Some(prepare_payload(None)?)
    };
    let state = recovery::reserve_prepared(catalog.discovery_root(), identity, payload)?;
    match state {
        recovery::RecoveryReservationState::Pending(mut reservation) => {
            if reservation.operation_checkpoint().is_none() {
                // Only an exact legacy fingerprint can reach this upgrade.
                let payload = prepare_payload(reservation.resume_checkpoint())?;
                reservation
                    .prepare_operation_payload(recovery::RecoveryOperationPayload::new(payload)?)?;
            }
            let operation = reservation.operation_checkpoint().ok_or_else(|| {
                "hmux_recovery_journal_invalid: prepared conversion has no payload".to_string()
            })?;
            let prepared = read_prepared(operation)?;
            validate_replay(
                &request,
                &prepared.request,
                reservation
                    .resume_checkpoint()
                    .or(Some(&prepared.initial_checkpoint)),
            )?;
            Ok(ReservedConversion::Pending(Box::new((
                prepared,
                reservation,
            ))))
        }
        recovery::RecoveryReservationState::Completed(completion) => {
            // A completed legacy operation already required its exact request.
            // Never prepare a launch or rewrite its terminal receipt.
            let (prepared_request, target) = match &completion.operation_checkpoint {
                Some(operation) => {
                    let prepared = read_prepared(operation)?;
                    let target = prepared.launch.completed_target(catalog, Some(operation))?;
                    (prepared.request, target)
                }
                None => (request.clone(), None),
            };
            validate_replay(
                &request,
                &prepared_request,
                completion.resume_checkpoint.as_ref(),
            )?;
            Ok(ReservedConversion::Completed(Box::new((
                prepared_request,
                completion,
                target,
            ))))
        }
    }
}

fn normalize_request(request: &mut SessionConversionRequest) -> Result<PathBuf, String> {
    request.confirmed = true;
    let cwd = canonical_cwd(&request.cwd)?;
    request.cwd = cwd.to_string_lossy().into_owned();
    Ok(cwd)
}

fn prepared_identity(
    request: &SessionConversionRequest,
) -> Result<recovery::PreparedRecoveryIdentity, String> {
    let serialized = serde_json::to_string(request).map_err(|_| {
        "session_conversion_request_invalid: request is not serializable".to_string()
    })?;
    Ok(recovery::PreparedRecoveryIdentity {
        recovery_id: request.conversion_id.clone(),
        source_session_id: request.source_session_id.clone(),
        source_workspace_id: request.source_workspace_id.clone(),
        legacy_request_fingerprint: Some(recovery::request_fingerprint(&[&serialized])),
        action: request.target.action(),
    })
}

fn read_prepared(
    operation: &recovery::RecoveryOperationCheckpoint,
) -> Result<PreparedConversion, String> {
    serde_json::from_str(&operation.canonical_payload)
        .map_err(|_| "hmux_recovery_journal_invalid: conversion inputs are malformed".to_string())
}

pub(in crate::hmux) fn read_standalone_launch(
    action: &str,
    checkpoint: &recovery::RecoveryOperationCheckpoint,
) -> Result<Option<hmux_client::StandaloneCreateRequest>, String> {
    if action != super::ACTION_TO_STANDALONE {
        return Ok(None);
    }
    match read_prepared(checkpoint)?.launch {
        super::launch::PreparedLaunch::Standalone(create) => {
            create.validate().map_err(|error| error.to_string())?;
            Ok(Some(*create))
        }
        super::launch::PreparedLaunch::Managed(_) => Err(
            "hmux_recovery_journal_invalid: standalone conversion has a managed launch".into(),
        ),
    }
}

fn validate_replay(
    request: &SessionConversionRequest,
    prepared: &SessionConversionRequest,
    resume: Option<&recovery::RecoveryResumeCheckpoint>,
) -> Result<(), String> {
    if prepared.conversion_id != request.conversion_id
        || prepared.source_session_id != request.source_session_id
        || prepared.source_workspace_id != request.source_workspace_id
        || prepared.target != request.target
    {
        return Err(
            "hmux_recovery_journal_invalid: conversion inputs belong to another operation".into(),
        );
    }
    if prepared.provider_id != request.provider_id
        || request
            .expected_source_fence
            .as_ref()
            .is_some_and(|hint| Some(hint) != prepared.expected_source_fence.as_ref())
    {
        return Err("session_conversion_source_mismatch: supplied source identity changed".into());
    }
    if let Some(conversation) = resume
        .map(|resume| resume.resume_identity.as_str())
        .or(prepared.expected_conversation_id.as_deref())
    {
        validate_conversation_hint(request.expected_conversation_id.as_deref(), conversation)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
