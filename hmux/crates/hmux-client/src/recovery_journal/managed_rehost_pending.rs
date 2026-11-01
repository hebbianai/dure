//! Pending managed rehost operations and their deterministic expiry.
//!
//! A reserved `managed_rehost_exact_fence_v1` record fails closed for every
//! reader: resolution reports `hmux_managed_rehost_retry_required` until the
//! operation completes. The client that reserved it normally finishes it in
//! the same process. When that process dies, or when continuation refuses
//! deterministically (after a host reboot the exact source Host's process
//! evidence can no longer be proven), nothing else owns the record: journal GC
//! retires only completed records and protects every pending source. The
//! source then stays unattachable forever (hebbianai/dure#309).
//!
//! This module gives a supervisor the two primitives it needs. Listing exposes
//! every pending rehost with whether it recorded progress past admission.
//! Expiry removes one reserved record only when the record itself proves that
//! nothing destructive happened: no source stop receipt, no replacement
//! receipt and no resume checkpoint. The source then resolves to `not_found`
//! again and the operation identity is free for a fresh admission. An
//! operation that recorded progress can only be finished by reconciliation.

use super::*;
use hmux_runtime_contract::ManagedRehostReconcileRequest;
use managed_rehost_observation::{prepared_identity, with_recovery_directory};

#[cfg(test)]
mod tests;

/// One reserved managed rehost operation, read from its journal record.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingManagedRehostOperation {
    pub operation_id: String,
    pub source_session_id: String,
    pub source_workspace_id: String,
    pub created_unix_ms: u64,
    /// The operation recorded progress past admission: a source stop receipt,
    /// a replacement receipt or a resume checkpoint. Its destructive boundary
    /// may have been crossed, so only reconciliation may finish it.
    pub progress_checkpointed: bool,
}

impl PendingManagedRehostOperation {
    /// The exact identity reconciliation and expiry take for this operation.
    pub fn reconcile_request(&self) -> Result<ManagedRehostReconcileRequest, String> {
        ManagedRehostReconcileRequest::by_operation_identity(
            &self.operation_id,
            &self.source_session_id,
            &self.source_workspace_id,
        )
        .map_err(|error| format!("hmux_recovery_journal_invalid: {error}"))
    }

    /// Time since the reservation was admitted; zero when the clock moved back.
    #[must_use]
    pub fn age(&self, now_unix_ms: u64) -> Duration {
        Duration::from_millis(now_unix_ms.saturating_sub(self.created_unix_ms))
    }
}

/// Outcome of one expiry attempt. Only `Expired` changed the journal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagedRehostExpiry {
    /// The reserved record and its operation lock were removed.
    Expired,
    /// Another process holds the operation lock and owns the outcome.
    Busy,
    /// No reserved record exists for this operation: it is absent or completed.
    NotPending,
    /// The operation recorded progress past admission; only reconciliation may
    /// finish it.
    ProgressCheckpointed,
    /// The reservation is younger than the caller's minimum age.
    TooRecent,
}

/// List every reserved managed rehost operation in one discovery root.
///
/// This is a read transaction under the shared admission lock, like latest
/// successor resolution: concurrent readers proceed, writers wait until the
/// scan finishes. A missing journal is empty.
pub fn pending_managed_rehost_operations(
    discovery_root: &Path,
) -> Result<Vec<PendingManagedRehostOperation>, String> {
    let directory = discovery_root.join(".recovery");
    match fs::symlink_metadata(&directory) {
        Ok(_) => validate_existing_private_directory(&directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("hmux_recovery_journal_invalid: directory is unreadable".into()),
    }
    let file = open_private_lock(&directory.join(ADMISSION_LOCK_NAME))?;
    FileExt::lock_shared(&file)
        .map_err(|_| "hmux_recovery_journal_failed: read admission lock failed".to_string())?;
    let _admission = RecoveryLock { file };
    let mut pending = Vec::new();
    for entry in scan_journal(&directory, true)? {
        let Some(record) = entry.record else { continue };
        if record.action != MANAGED_REHOST_RECOVERY_ACTION {
            continue;
        }
        let RecoveryRecordState::Reserved {
            resume_checkpoint,
            operation_checkpoint,
        } = &record.state
        else {
            continue;
        };
        pending.push(PendingManagedRehostOperation {
            operation_id: rehost_operation_id(&record),
            progress_checkpointed: progress_checkpointed(
                resume_checkpoint.as_ref(),
                operation_checkpoint.as_ref(),
            ),
            source_session_id: record.source_session_id,
            source_workspace_id: record.source_workspace_id,
            created_unix_ms: record.created_unix_ms,
        });
    }
    pending.sort_by(|left, right| {
        left.created_unix_ms
            .cmp(&right.created_unix_ms)
            .then_with(|| left.operation_id.cmp(&right.operation_id))
    });
    Ok(pending)
}

/// Retire one reserved managed rehost operation that never crossed its
/// destructive boundary.
///
/// The record is removed under the journal admission lock while holding its
/// operation lock non-blockingly, exactly like completion acknowledgement. A
/// held operation lock, recorded progress or a reservation younger than
/// `minimum_age` leaves the journal untouched. Callers should attempt
/// reconciliation first: a resumable operation finishes with its receipt,
/// and only a refused one is worth forfeiting.
pub fn expire_pending_managed_rehost(
    discovery_root: &Path,
    request: &ManagedRehostReconcileRequest,
    minimum_age: Duration,
) -> Result<ManagedRehostExpiry, String> {
    expire_pending_managed_rehost_at(discovery_root, request, minimum_age, unix_time_ms())
}

fn expire_pending_managed_rehost_at(
    discovery_root: &Path,
    request: &ManagedRehostReconcileRequest,
    minimum_age: Duration,
    now_unix_ms: u64,
) -> Result<ManagedRehostExpiry, String> {
    request
        .validate()
        .map_err(|error| format!("hmux_recovery_journal_invalid: {error}"))?;
    with_recovery_directory(discovery_root, |directory| {
        let identity = prepared_identity(request);
        let operation_digest = digest(&identity.recovery_id);
        let record_path = directory.join(format!("operation_{operation_digest}.json"));
        if !private_path_exists(&record_path)? {
            return Ok(ManagedRehostExpiry::NotPending);
        }
        let lock_path = directory.join(format!("operation_{operation_digest}.lock"));
        let Some(lock) = RecoveryLock::try_acquire_for_maintenance(open_private_lock(&lock_path)?)?
        else {
            return Ok(ManagedRehostExpiry::Busy);
        };
        let record = read_record(&record_path)?;
        validate_prepared_record(&record, &identity, None)?;
        let RecoveryRecordState::Reserved {
            resume_checkpoint,
            operation_checkpoint,
        } = &record.state
        else {
            return Ok(ManagedRehostExpiry::NotPending);
        };
        if progress_checkpointed(resume_checkpoint.as_ref(), operation_checkpoint.as_ref()) {
            return Ok(ManagedRehostExpiry::ProgressCheckpointed);
        }
        if !old_enough(now_unix_ms, record.created_unix_ms, minimum_age) {
            return Ok(ManagedRehostExpiry::TooRecent);
        }
        transactional_remove_record(directory, &record_path, &operation_digest)?;
        remove_opened_file(directory, &lock_path, &lock.file)?;
        drop(lock);
        Ok(ManagedRehostExpiry::Expired)
    })
    .map(|expiry| expiry.unwrap_or(ManagedRehostExpiry::NotPending))
}

fn progress_checkpointed(
    resume_checkpoint: Option<&RecoveryResumeCheckpoint>,
    operation_checkpoint: Option<&RecoveryOperationCheckpoint>,
) -> bool {
    resume_checkpoint.is_some()
        || operation_checkpoint.is_some_and(|checkpoint| {
            checkpoint.source_stop_receipt.is_some() || checkpoint.replacement_receipt.is_some()
        })
}
