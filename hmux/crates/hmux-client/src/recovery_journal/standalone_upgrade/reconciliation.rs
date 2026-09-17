use super::{
    PreparedStandaloneUpgrade, StandaloneUpgradeOperation, StandaloneUpgradeProgress,
    StandaloneUpgradeSuccessor, cancellation, observation::read_operation_at, read_upgrade,
};
use crate::recovery_journal::{
    RecoveryCompletion, RecoveryIdentity, RecoveryOperationCheckpoint, RecoveryReservation,
    RecoveryReservationState, existing_operation,
    standalone_broker_admission::StandaloneBrokerAdmission,
};
use crate::{
    CompletedStandaloneTarget, LocalSessionCatalog, StandaloneCreateReceipt,
    standalone_create_idempotency_key,
};
use hmux_host::local_discovery::workspace_id_for_path;

/// A read-only observation until the original operation lock is reacquired.
/// Explicit close reacquires that operation and the broker's launch boundary;
/// passive readers cannot cancel through a mere absence observation.
/// The operation's namespace is frozen here, independently of the caller's
/// current primary root and the source/target discovery locations.
#[derive(Clone)]
pub struct PendingStandaloneUpgrade {
    pub(super) operation_root: std::path::PathBuf,
    pub(super) identity: RecoveryIdentity,
}

impl PendingStandaloneUpgrade {
    pub(super) fn from_record(
        operation_root: &std::path::Path,
        record: &crate::recovery_journal::RecoveryRecord,
    ) -> Result<Self, String> {
        let action = match record.action.as_str() {
            super::SELECTED_BUILD_ACTION => super::SELECTED_BUILD_ACTION,
            super::CURRENT_BUILD_ACTION => super::CURRENT_BUILD_ACTION,
            _ => {
                return Err(
                    "hmux_recovery_journal_invalid: pending operation is not an upgrade".into(),
                );
            }
        };
        Ok(Self {
            operation_root: operation_root.to_path_buf(),
            identity: RecoveryIdentity {
                recovery_id: record.recovery_id.clone(),
                source_session_id: record.source_session_id.clone(),
                source_workspace_id: record.source_workspace_id.clone(),
                request_fingerprint: record.request_fingerprint.clone(),
                action,
            },
        })
    }

    /// Resume only this already admitted operation, never reserve on absence.
    pub fn reopen(&self) -> Result<Option<RecoveryReservationState>, String> {
        existing_operation::reopen(&self.operation_root, &self.identity)
    }

    pub fn operation_root(&self) -> &std::path::Path {
        &self.operation_root
    }

    pub fn settle_for_close(
        &self,
        catalog: &LocalSessionCatalog,
    ) -> Result<StandaloneUpgradeProgress, String> {
        let pending = || StandaloneUpgradeProgress::Pending(Box::new(self.clone()));
        let state = match self.reopen() {
            Ok(state) => state,
            Err(error) if error.starts_with("hmux_recovery_busy:") => return Ok(pending()),
            Err(error) => return Err(error),
        };
        let Some(RecoveryReservationState::Pending(mut reservation)) = state else {
            // Completion/compaction may have won after the observation. Read
            // its immutable fact; never reserve the missing operation again.
            return Ok(
                match read_operation_at(
                    catalog,
                    &self.operation_root,
                    &self.identity.recovery_id,
                    self.identity.action,
                )? {
                    Some(StandaloneUpgradeOperation::Rehosted(completed)) => {
                        StandaloneUpgradeProgress::Completed(Box::new(completed.successor))
                    }
                    Some(StandaloneUpgradeOperation::Cancelled) => {
                        StandaloneUpgradeProgress::Cancelled
                    }
                    Some(StandaloneUpgradeOperation::Pending(_)) | None => pending(),
                },
            );
        };
        let checkpoint = reservation.operation_checkpoint().ok_or_else(|| {
            "hmux_recovery_journal_invalid: pending upgrade lost its inputs".to_string()
        })?;
        let prepared = read_upgrade(self.identity.action, checkpoint)?.ok_or_else(|| {
            "hmux_recovery_journal_invalid: pending operation is not an upgrade".to_string()
        })?;
        let bound = prepared
            .replacement
            .as_ref()
            .and_then(|replacement| replacement.create.recovery_operation_id())
            == Some(self.identity.recovery_id.as_str());
        let launch = if bound {
            let target_root = prepared
                .replacement
                .as_ref()
                .unwrap()
                .discovery_root(&self.operation_root);
            match StandaloneBrokerAdmission::acquire(target_root) {
                Ok(launch) => Some(launch),
                Err(error) if error.starts_with("hmux_recovery_source_busy:") => {
                    return Ok(pending());
                }
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        if let Some(launch) = &launch {
            if cancellation::is_published(
                &self.operation_root.join(".recovery"),
                &reservation.record,
            )? {
                cancellation::complete(&mut reservation, launch)?;
                return Ok(StandaloneUpgradeProgress::Cancelled);
            }
        }
        let Some(target) = resolve_target(catalog, &prepared, checkpoint)? else {
            return if let Some(launch) = &launch {
                cancellation::complete(&mut reservation, launch)?;
                Ok(StandaloneUpgradeProgress::Cancelled)
            } else {
                // An older broker may still be in flight. Never upgrade its
                // frozen request or turn caller/manifest absence into cancellation.
                Ok(pending())
            };
        };
        let successor = StandaloneUpgradeSuccessor::from_launch(
            &prepared.replacement.unwrap().create,
            target.clone(),
        )?;
        complete_target(&mut reservation, &target)?;
        Ok(StandaloneUpgradeProgress::Completed(Box::new(successor)))
    }
}

/// Resolve existing execution without consulting a launcher. A missing result
/// checkpoint can recover only the frozen create key's current/archived
/// generation, never a same-name session or an assumed absent target.
pub fn resolve_target<Context>(
    catalog: &LocalSessionCatalog,
    prepared: &PreparedStandaloneUpgrade<Context>,
    checkpoint: &RecoveryOperationCheckpoint,
) -> Result<Option<CompletedStandaloneTarget>, String> {
    let Some(replacement) = &prepared.replacement else {
        return Ok(None);
    };
    let request = &replacement.create;
    let target_catalog = replacement
        .discovery_root
        .as_ref()
        .map(LocalSessionCatalog::new);
    let catalog = target_catalog.as_ref().unwrap_or(catalog);
    let target = if let Some(saved) = &checkpoint.replacement_receipt {
        CompletedStandaloneTarget::from_recovery_checkpoint(catalog, request, saved)
            .map_err(|error| error.to_string())?
    } else {
        let identity = request.recovery_identity().ok_or_else(|| {
            "hmux_recovery_journal_invalid: pending upgrade has no create identity".to_string()
        })?;
        let workspace_id = workspace_id_for_path(request.provider_cwd());
        let Some(session) = catalog
            .find_creation(
                &workspace_id,
                identity.target_session_id(),
                &standalone_create_idempotency_key(identity),
            )
            .map_err(|error| error.to_string())?
        else {
            return Ok(None);
        };
        let receipt = StandaloneCreateReceipt::new(
            identity.target_session_id(),
            workspace_id,
            request.session_name().ok_or_else(|| {
                "hmux_recovery_journal_invalid: pending upgrade has no name".to_string()
            })?,
            session.discovery_root().ok_or_else(|| {
                "hmux_recovery_journal_invalid: observed target has no discovery root".to_string()
            })?,
            identity.launch_owner_proof(),
        )
        .map_err(|error| error.to_string())?;
        CompletedStandaloneTarget::from_created(receipt, session.descriptor())
            .map_err(|error| error.to_string())?
    };
    if target.host_build_version() != prepared.target_build_id {
        return Err("hmux_recovery_journal_invalid: upgrade target build differs".into());
    }
    Ok(Some(target))
}

/// Normal execution and caller-loss reconciliation publish one identical
/// target/checkpoint/completion through the existing operation guard. Normalize
/// a legacy receipt at completion, not by mutating an immutable pending checkpoint.
pub fn complete_target(
    reservation: &mut RecoveryReservation,
    target: &CompletedStandaloneTarget,
) -> Result<(), String> {
    let mut checkpoint = reservation.operation_checkpoint().cloned().ok_or_else(|| {
        "hmux_recovery_journal_invalid: upgrade completion lost its inputs".to_string()
    })?;
    checkpoint.replacement_receipt =
        Some(serde_json::to_string(target).map_err(|error| error.to_string())?);
    reservation.complete(RecoveryCompletion {
        target_session_id: target.receipt().session_id().into(),
        target_workspace_id: target.receipt().workspace_id().into(),
        target_build_id: target.host_build_version().into(),
        action: reservation.record.action.clone(),
        outcome: "rehosted".into(),
        resume_checkpoint: None,
        operation_checkpoint: Some(checkpoint),
    })
}
