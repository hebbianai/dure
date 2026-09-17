use super::{ObservedStandaloneUpgrade, compacted, read_upgrade};
use crate::StandaloneReplacementSource;
use crate::recovery_journal::{
    RecoveryCompletion, RecoveryRecord, RecoveryRecordState, RecoveryReservation,
    standalone_broker_admission::StandaloneBrokerAdmission,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const CANCELLED_CODE: &str = "hmux_standalone_upgrade_cancelled";

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CancelledUpgrade {
    pub recovery_id: String,
    request_fingerprint: String,
    pub action: String,
    pub source: StandaloneReplacementSource,
}

fn identity(
    record: &RecoveryRecord,
) -> Result<(CancelledUpgrade, ObservedStandaloneUpgrade), String> {
    let checkpoint = match &record.state {
        RecoveryRecordState::Reserved {
            operation_checkpoint,
            ..
        }
        | RecoveryRecordState::Completed {
            operation_checkpoint,
            ..
        } => operation_checkpoint,
    }
    .as_ref()
    .ok_or_else(invalid)?;
    let prepared = read_upgrade(&record.action, checkpoint)?.ok_or_else(invalid)?;
    if checkpoint.replacement_receipt.is_some()
        || prepared
            .replacement
            .as_ref()
            .and_then(|replacement| replacement.create.recovery_operation_id())
            != Some(&record.recovery_id)
        || prepared.source.generation().fence.session_id != record.source_session_id
        || prepared.source.generation().fence.workspace_id != record.source_workspace_id
    {
        return Err(invalid());
    }
    Ok((
        CancelledUpgrade {
            recovery_id: record.recovery_id.clone(),
            request_fingerprint: record.request_fingerprint.clone(),
            action: record.action.clone(),
            source: prepared.source.clone(),
        },
        prepared,
    ))
}

pub(super) fn completed(record: &RecoveryRecord) -> Result<Option<CancelledUpgrade>, String> {
    let RecoveryRecordState::Completed {
        outcome,
        target_session_id,
        target_workspace_id,
        target_build_id,
        ..
    } = &record.state
    else {
        return Ok(None);
    };
    if outcome != "cancelled"
        || !matches!(
            record.action.as_str(),
            super::CURRENT_BUILD_ACTION | super::SELECTED_BUILD_ACTION
        )
    {
        return Ok(None);
    }
    let (fact, prepared) = identity(record)?;
    let request = &prepared.replacement.unwrap().create;
    if request.recovery_identity().unwrap().target_session_id() != target_session_id
        || hmux_host::local_discovery::workspace_id_for_path(request.provider_cwd())
            != *target_workspace_id
        || target_build_id != "not_created"
    {
        return Err(invalid());
    }
    Ok(Some(fact))
}

/// The cancellation fact is published before the primary completion record.
/// A crash between those writes cannot make the detached request launchable.
pub(in crate::recovery_journal) fn is_published(
    recovery: &Path,
    record: &RecoveryRecord,
) -> Result<bool, String> {
    let Some(fact) = compacted::cancelled(recovery, &record.recovery_id)? else {
        return Ok(false);
    };
    if fact != identity(record)?.0 {
        return Err(invalid());
    }
    Ok(true)
}

pub(super) fn complete(
    reservation: &mut RecoveryReservation,
    _launch: &StandaloneBrokerAdmission,
) -> Result<(), String> {
    let (_, prepared) = identity(&reservation.record)?;
    let request = prepared.replacement.unwrap().create;
    reservation.complete(RecoveryCompletion {
        target_session_id: request
            .recovery_identity()
            .unwrap()
            .target_session_id()
            .into(),
        target_workspace_id: hmux_host::local_discovery::workspace_id_for_path(
            request.provider_cwd(),
        ),
        target_build_id: "not_created".into(),
        action: reservation.record.action.clone(),
        outcome: "cancelled".into(),
        resume_checkpoint: None,
        operation_checkpoint: reservation.operation_checkpoint().cloned(),
    })
}

fn invalid() -> String {
    "hmux_recovery_journal_invalid: cancellation differs from its bound upgrade".into()
}
