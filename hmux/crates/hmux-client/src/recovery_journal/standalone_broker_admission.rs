//! Detached execution consumes the same immutable operation as its caller.

use super::{
    RecoveryRecordState, RecoverySourceLock, STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
    acquire_admission_lock, existing_operation, lock_source, prepared_standalone_create,
    standalone_upgrade, validate_stored_record,
};
use crate::{ClientError, StandaloneCreateRequest};
use std::path::{Path, PathBuf};

pub const OPERATION_NOT_PENDING: &str = "hmux_standalone_operation_not_pending";
pub const OPERATION_INPUT_CONFLICT: &str = "hmux_standalone_operation_input_conflict";

/// Own the existing broker-wide launch lock through native host publication.
/// A cancellation writer acquires this same lock after the original
/// operation lock, before it can prove an unborn target will remain absent.
/// This guard is not the operation lock: the normal caller still owns that lock
/// while waiting for the detached broker's response.
pub struct StandaloneBrokerAdmission {
    discovery_root: PathBuf,
    _lock: RecoverySourceLock,
}

impl StandaloneBrokerAdmission {
    pub fn acquire(discovery_root: &Path) -> Result<Self, String> {
        let lock = lock_source(discovery_root, "standalone_runtime_create_v1", "all_names")?;
        Ok(Self {
            discovery_root: discovery_root.to_path_buf(),
            _lock: lock,
        })
    }

    pub fn admit(self, request: &StandaloneCreateRequest) -> Result<Self, ClientError> {
        self.require_pending(request)?;
        Ok(self)
    }

    fn require_pending(&self, request: &StandaloneCreateRequest) -> Result<(), ClientError> {
        let Some(operation_id) = request.recovery_operation_id() else {
            // Legacy requests have no cancellation binding. Their existing
            // name/recipe and exact target recovery behavior stays unchanged.
            return Ok(());
        };
        let operation_root = request
            .recovery_operation_root()
            .unwrap_or(&self.discovery_root);
        let _admission =
            acquire_admission_lock(&operation_root.join(".recovery")).map_err(journal_error)?;
        let Some(record) = existing_operation::read_existing_record(operation_root, operation_id)
            .map_err(journal_error)?
        else {
            return Err(not_pending());
        };
        validate_stored_record(&record).map_err(journal_error)?;
        if standalone_upgrade::cancellation::is_published(
            &operation_root.join(".recovery"),
            &record,
        )
        .map_err(journal_error)?
        {
            return Err(not_pending());
        }
        let RecoveryRecordState::Reserved {
            operation_checkpoint: Some(checkpoint),
            ..
        } = &record.state
        else {
            // Missing, acknowledged, collected and completed records cannot
            // authorize a new launch. Completed replay reads its exact target.
            return Err(not_pending());
        };
        let (frozen, target_root) = if record.action == STANDALONE_CREATE_OPERATION_RECOVERY_ACTION
        {
            (
                prepared_standalone_create::read_request(checkpoint).map_err(journal_error)?,
                operation_root.to_path_buf(),
            )
        } else {
            let replacement = standalone_upgrade::read_upgrade(&record.action, checkpoint)
                .map_err(journal_error)?
                .and_then(|prepared| prepared.replacement)
                .ok_or_else(not_pending)?;
            let root = replacement.discovery_root(operation_root).to_path_buf();
            (replacement.create, root)
        };
        if record.recovery_id != operation_id
            || frozen != *request
            || target_root != self.discovery_root
        {
            return Err(ClientError::transport(
                OPERATION_INPUT_CONFLICT,
                "detached standalone request differs from its immutable operation",
            ));
        }
        Ok(())
    }
}

fn not_pending() -> ClientError {
    ClientError::transport(
        OPERATION_NOT_PENDING,
        "standalone operation no longer authorizes a launch",
    )
}

fn journal_error(message: String) -> ClientError {
    ClientError::transport("hmux_recovery_journal_invalid", message)
}
