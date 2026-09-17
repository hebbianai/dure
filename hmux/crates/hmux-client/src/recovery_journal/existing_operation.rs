use super::*;

#[cfg(test)]
mod tests;

/// An atomic journal observation, not permission to launch or mutate an operation.
/// Missing or pending state never proves that its runtime effects are absent.
pub enum RecoveryOperationObservation {
    Pending {
        identity: RecoveryIdentity,
        checkpoint: Option<RecoveryOperationCheckpoint>,
    },
    Completed {
        identity: RecoveryIdentity,
        completion: Box<RecoveryCompletion>,
    },
}

pub fn read(
    discovery_root: &Path,
    recovery_id: &str,
    action: &'static str,
) -> Result<Option<RecoveryOperationObservation>, String> {
    let Some(record) = read_existing_record(discovery_root, recovery_id)? else {
        return Ok(None);
    };
    validate_stored_record(&record)?;
    if record.recovery_id != recovery_id {
        return Err("hmux_recovery_idempotency_conflict: recovery identity differs".into());
    }
    if record.action != action {
        return Ok(None);
    }
    let identity = RecoveryIdentity {
        recovery_id: record.recovery_id.clone(),
        source_session_id: record.source_session_id.clone(),
        source_workspace_id: record.source_workspace_id.clone(),
        request_fingerprint: record.request_fingerprint.clone(),
        action,
    };
    Ok(Some(match record.state {
        RecoveryRecordState::Reserved {
            operation_checkpoint,
            ..
        } => RecoveryOperationObservation::Pending {
            identity,
            checkpoint: operation_checkpoint,
        },
        RecoveryRecordState::Completed { .. } => {
            let completion = Box::new(completed_from_record(&record)?);
            RecoveryOperationObservation::Completed {
                identity,
                completion,
            }
        }
    }))
}

/// Reopen an exact existing operation under the same lock used by reservation,
/// completion observation and acknowledgement. Never create a missing record.
/// The caller can complete or advance existing checkpoints without reconstructing
/// intent; initial payload admission still belongs to `reserve`/`reserve_prepared`.
pub fn reopen(
    discovery_root: &Path,
    identity: &RecoveryIdentity,
) -> Result<Option<RecoveryReservationState>, String> {
    reopen_validated(discovery_root, identity, |_| Ok(()))
}

fn reopen_validated(
    discovery_root: &Path,
    identity: &RecoveryIdentity,
    validate: impl FnOnce(&mut RecoveryReservation) -> Result<(), String>,
) -> Result<Option<RecoveryReservationState>, String> {
    match with_existing_operation(discovery_root, identity, |mut operation| {
        validate(&mut operation)?;
        match &operation.record.state {
            RecoveryRecordState::Reserved { .. } => {
                Ok(RecoveryReservationState::Pending(operation))
            }
            RecoveryRecordState::Completed { .. } => Ok(RecoveryReservationState::Completed(
                completed_from_record(&operation.record)?,
            )),
        }
    })? {
        ExistingRecoveryOperation::Present(state) => Ok(Some(state)),
        ExistingRecoveryOperation::Absent => Ok(None),
        ExistingRecoveryOperation::Acknowledged => Err(format!(
            "{RECOVERY_COMPLETION_ACKNOWLEDGED_CODE}: operation completion was acknowledged"
        )),
    }
}

/// Reopen only the exact stored prepared intent, without new-operation admission or
/// a journal-wide capacity scan. The root must already be resolved by the caller.
/// Absence is an observation, never authority to repeat runtime effects; new
/// intent must still pass `reserve_prepared` with its canonical payload.
pub fn reopen_prepared(
    discovery_root: &Path,
    identity: &PreparedRecoveryIdentity,
) -> Result<Option<RecoveryReservationState>, String> {
    let Some(record) = read_existing_record(discovery_root, &identity.recovery_id)? else {
        return Ok(None);
    };
    validate_prepared_record(&record, identity, None)?;
    let exact = RecoveryIdentity {
        recovery_id: record.recovery_id,
        source_session_id: record.source_session_id,
        source_workspace_id: record.source_workspace_id,
        request_fingerprint: record.request_fingerprint,
        action: identity.action,
    };
    reopen_validated(discovery_root, &exact, |operation| {
        validate_prepared_record(&operation.record, identity, None)?;
        publish_managed_rehost_successor(&operation.directory, &operation.record)?;
        operation.fingerprint_binding = FingerprintBinding::CanonicalPayload;
        Ok(())
    })
}

pub(super) fn read_existing_record(
    discovery_root: &Path,
    recovery_id: &str,
) -> Result<Option<RecoveryRecord>, String> {
    if !valid_recovery_identity_field(recovery_id) {
        return Err("hmux_recovery_journal_invalid: recovery identity is invalid".into());
    }
    let directory = discovery_root.join(".recovery");
    match fs::symlink_metadata(&directory) {
        Ok(_) => validate_existing_private_directory(&directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("hmux_recovery_journal_invalid: directory is unreadable".into()),
    }
    let path = directory.join(format!("operation_{}.json", digest(recovery_id)));
    let record = match fs::symlink_metadata(&path) {
        Ok(_) => read_record(&path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("hmux_recovery_journal_invalid: record is unreadable".into()),
    };
    Ok(Some(record))
}
