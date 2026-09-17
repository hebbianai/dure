use super::{
    RecoveryOperationCheckpoint, RecoveryRecordState, STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
    acquire_admission_lock, prepared_standalone_create, private_directory_exists, scan_journal,
};
use crate::{
    CompletedStandaloneTarget, ExitedSessionRetirementGeneration, LocalSession,
    LocalSessionCatalog, StandaloneCreateRequest, standalone_create_idempotency_key,
};

/// Read the launch that created this exact generation, not another session
/// with the same display name. Envelope owners decode their existing payloads;
/// discovery and receipt binding remain shared across all consumers.
pub fn read_for_session(
    catalog: &LocalSessionCatalog,
    source: &LocalSession,
    mut decode_envelope: impl FnMut(
        &str,
        &RecoveryOperationCheckpoint,
    ) -> Result<Option<StandaloneCreateRequest>, String>,
) -> Result<Option<StandaloneCreateRequest>, String> {
    let Some(creation_key) = source.create_idempotency_key() else {
        return Ok(None);
    };
    let generation =
        ExitedSessionRetirementGeneration::from_descriptor(source.descriptor()).map_err(message)?;
    let mut found = None;
    for root in catalog.discovery_paths() {
        if let Some(request) = read_in_root(
            catalog,
            source,
            creation_key,
            &generation,
            &root.join(".recovery"),
            &mut decode_envelope,
        )? {
            if found.as_ref().is_some_and(|prior| prior != &request) {
                return Err("hmux_standalone_launch_invalid: exact generation has conflicting launch inputs".into());
            }
            found = Some(request);
        }
    }
    Ok(found)
}

fn read_in_root(
    catalog: &LocalSessionCatalog,
    source: &LocalSession,
    creation_key: &str,
    generation: &ExitedSessionRetirementGeneration,
    directory: &std::path::Path,
    decode_envelope: &mut impl FnMut(
        &str,
        &RecoveryOperationCheckpoint,
    ) -> Result<Option<StandaloneCreateRequest>, String>,
) -> Result<Option<StandaloneCreateRequest>, String> {
    let admission = if private_directory_exists(directory)? {
        Some(acquire_admission_lock(directory)?)
    } else {
        None
    };
    let descriptor = source.descriptor();
    if let Some(request) = super::standalone_upgrade::read_compacted_launch(
        directory,
        generation,
        &descriptor.provider_process,
    )? {
        return Ok(Some(request));
    }
    if admission.is_none() {
        return Ok(None);
    }
    for entry in scan_journal(directory, true)? {
        let Some(record) = entry.record else { continue };
        let RecoveryRecordState::Completed {
            target_session_id,
            target_workspace_id,
            operation_checkpoint: Some(checkpoint),
            ..
        } = record.state
        else {
            continue;
        };
        if target_session_id != descriptor.session_id
            || target_workspace_id != descriptor.workspace_id
        {
            continue;
        }
        let request = if record.action == STANDALONE_CREATE_OPERATION_RECOVERY_ACTION {
            Some(prepared_standalone_create::read_request(&checkpoint)?)
        } else if let Some(upgrade) =
            super::standalone_upgrade::read_upgrade(&record.action, &checkpoint)?
        {
            upgrade.replacement.map(|replacement| replacement.create)
        } else {
            decode_envelope(&record.action, &checkpoint)?
        };
        let Some(request) = request else { continue };
        let Some(identity) = request.recovery_identity() else {
            continue;
        };
        if standalone_create_idempotency_key(identity) != creation_key {
            continue;
        }
        let receipt = checkpoint.replacement_receipt.as_deref().ok_or_else(|| {
            "hmux_standalone_launch_invalid: completed launch has no target receipt".to_string()
        })?;
        let target =
            CompletedStandaloneTarget::from_recovery_checkpoint(catalog, &request, receipt)
                .map_err(message)?;
        if target.generation() == generation
            && target.provider_process() == &descriptor.provider_process
        {
            return Ok(Some(request));
        }
    }
    Ok(None)
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
