use super::{observation::read_successor_admitted, read_upgrade};
use crate::{
    LocalSessionCatalog,
    recovery_journal::{JournalAdmissionLock, RecoveryRecord, RecoveryRecordState},
};
use std::path::Path;

/// Fresh intent belongs to the exact source, independently of the caller's
/// writable launch destination. Existing operations keep their original root
/// and bytes; retry must never relocate an already admitted operation.
pub(in crate::recovery_journal) fn prepared_location(
    root: &Path,
    identity: &crate::recovery_journal::PreparedRecoveryIdentity,
    payload: Option<String>,
) -> Result<(std::path::PathBuf, Option<String>), String> {
    if !matches!(
        identity.action,
        super::CURRENT_BUILD_ACTION | super::SELECTED_BUILD_ACTION
    ) || payload.is_none()
        || crate::recovery_journal::existing_operation::read_existing_record(
            root,
            &identity.recovery_id,
        )?
        .is_some()
    {
        return Ok((root.to_path_buf(), payload));
    }
    // A collected operation is still that same operation. Do not route a
    // stale supplied payload around its original compacted completion.
    super::compacted::refuse_new_operation(&root.join(".recovery"), &identity.recovery_id)?;
    let checkpoint = crate::recovery_journal::RecoveryOperationCheckpoint {
        canonical_payload: payload.as_ref().unwrap().clone(),
        source_stop_receipt: None,
        replacement_receipt: None,
    };
    let mut prepared = super::PreparedStandaloneUpgrade::<serde_json::Value>::read(&checkpoint)?;
    let source_root = prepared.source.discovery_root().to_path_buf();
    if !source_root.is_absolute() {
        return Err(
            "hmux_recovery_journal_invalid: upgrade source namespace must be absolute".into(),
        );
    }
    let Some(replacement) = &mut prepared.replacement else {
        return Ok((root.to_path_buf(), payload));
    };
    if source_root == root {
        return Ok((source_root, payload));
    }
    crate::recovery_journal::validate_existing_private_directory(&source_root)?;
    if replacement.discovery_root.is_none() {
        replacement.discovery_root = Some(root.to_path_buf());
    }
    Ok((
        source_root,
        Some(serde_json::to_string(&prepared).map_err(|error| error.to_string())?),
    ))
}

/// Initial payload publication is the source-ownership boundary. Both fresh
/// prepared reservations and legacy first preparation hold the same journal
/// admission lock here; retries and later checkpoints do not acquire a second
/// source claim. The admitted operation itself remains the durable authority.
pub(in crate::recovery_journal) fn admit_prepared(
    admission: &JournalAdmissionLock,
    directory: &Path,
    candidate: &RecoveryRecord,
) -> Result<(), String> {
    let RecoveryRecordState::Reserved {
        operation_checkpoint: Some(checkpoint),
        ..
    } = &candidate.state
    else {
        return Ok(());
    };
    let Some(prepared) = read_upgrade(&candidate.action, checkpoint)? else {
        return Ok(());
    };
    let Some(replacement) = &prepared.replacement else {
        return Ok(());
    };
    if replacement
        .create
        .recovery_operation_id()
        .is_some_and(|id| id != candidate.recovery_id)
    {
        return Err(
            "hmux_recovery_journal_invalid: upgrade launch belongs to another operation".into(),
        );
    }
    if replacement.create.recovery_operation_id().is_some() {
        let operation_root = directory.parent().ok_or_else(|| {
            "hmux_recovery_journal_invalid: operation root is missing".to_string()
        })?;
        let bound_root = replacement
            .create
            .recovery_operation_root()
            .unwrap_or_else(|| replacement.discovery_root(operation_root));
        if bound_root != operation_root {
            return Err("hmux_recovery_journal_invalid: upgrade broker binding belongs to another operation namespace".into());
        }
    }
    let source = prepared.source;
    if source.generation().fence.session_id != candidate.source_session_id
        || source.generation().fence.workspace_id != candidate.source_workspace_id
    {
        return Err(
            "hmux_recovery_journal_invalid: upgrade source differs from its operation".into(),
        );
    }
    let catalog =
        LocalSessionCatalog::new(directory.parent().ok_or_else(|| {
            "hmux_recovery_journal_invalid: recovery root is missing".to_string()
        })?);
    if read_successor_admitted(
        admission,
        &catalog,
        catalog.discovery_root(),
        source.generation(),
        source.provider_process(),
    )?
    .is_some()
    {
        return Err(
            "hmux_recovery_source_busy: another upgrade owns this source generation".into(),
        );
    }
    Ok(())
}
