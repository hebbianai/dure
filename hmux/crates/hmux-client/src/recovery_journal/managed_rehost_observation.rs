//! Read-only operation results and the direct edges shared with latest-successor resolution.

use super::*;
use hmux_runtime_contract::{
    ManagedRehostReceipt, ManagedRehostReconcileRequest, ManagedRehostRequest,
};

#[cfg(test)]
mod receipt_tests;

/// Locate the original source in one existing operation record, never a mutable name.
/// Compacted records require the caller's retained source tuple; no index scan or repair.
pub fn resolve_managed_rehost_operation_identity(
    discovery_root: &Path,
    operation_id: &str,
) -> Result<Option<ManagedRehostReconcileRequest>, String> {
    with_recovery_directory(discovery_root, |directory| {
        let recovery_id = format!("{MANAGED_REHOST_RECOVERY_ID_PREFIX}{operation_id}");
        let path = directory.join(format!("operation_{}.json", digest(&recovery_id)));
        if !private_path_exists(&path)? {
            return Ok(None);
        }
        let record = read_record(&path)?;
        let request = ManagedRehostReconcileRequest::by_operation_identity(
            operation_id,
            &record.source_session_id,
            &record.source_workspace_id,
        )
        .map_err(|error| format!("hmux_recovery_journal_invalid: {error}"))?;
        validate_prepared_record(&record, &prepared_identity(&request), None)?;
        Ok(Some(request))
    })
    .map(Option::flatten)
}

/// Observe one admitted operation, not its latest successor and not a reconcile command.
/// Reads one journal record and its bounded index shard under the existing admission lock.
/// No journal, lock, receipt, process, or presentation state is created or repaired.
pub fn observe_managed_rehost_operation(
    discovery_root: &Path,
    request: &ManagedRehostReconcileRequest,
) -> Result<ManagedRehostResolutionLookup, String> {
    with_operation_record(discovery_root, request, |directory, record| {
        let lookup = direct_edge(
            directory,
            request.source_workspace_id(),
            request.source_session_id(),
            record,
        )?;
        match lookup {
            ManagedRehostResolutionLookup::Resolved(edge)
                if edge.operation_ids() != [request.operation_id()] =>
            {
                Ok(ManagedRehostResolutionLookup::NotFound)
            }
            result => Ok(result),
        }
    })
    .map(|lookup| lookup.unwrap_or(ManagedRehostResolutionLookup::NotFound))
}

/// Read the original completed result, not a broker replay or a new execution.
/// Pending operations are not advanced. Missing or compacted receipts stay absent;
/// the successor index cannot reconstruct private stop/create evidence.
pub fn read_completed_managed_rehost_receipt(
    discovery_root: &Path,
    request: &ManagedRehostReconcileRequest,
) -> Result<Option<ManagedRehostReceipt>, String> {
    with_operation_record(discovery_root, request, |_, record| {
        let Some(record) = record else {
            return Ok(None);
        };
        if is_refused_managed_rehost_record(record) {
            return Ok(None);
        }
        let completion = completed_from_record(record)?;
        if completion.outcome != "rehosted" {
            return Err(
                "hmux_managed_rehost_resolution_invalid: unsupported completion outcome".into(),
            );
        }
        let edge = completed_rehost_receipts(record)?;
        let identity = edge.launch_identity.ok_or_else(|| {
            "hmux_managed_rehost_resolution_invalid: completed launch identity is unknown"
                .to_string()
        })?;
        let checkpoint = completion.operation_checkpoint.ok_or_else(|| {
            "hmux_managed_rehost_resolution_invalid: completion lost its payload".to_string()
        })?;
        let mut payload: serde_json::Value = serde_json::from_str(&checkpoint.canonical_payload)
            .map_err(|error| format!("hmux_managed_rehost_resolution_invalid: {error}"))?;
        // Use the admitted request only to correlate the original result.
        let admitted: ManagedRehostRequest = serde_json::from_value(
            payload
                .get_mut("request")
                .map(serde_json::Value::take)
                .unwrap_or(serde_json::Value::Null),
        )
        .map_err(|error| format!("hmux_managed_rehost_resolution_invalid: {error}"))?;
        let receipt = match identity.conversation_id() {
            Some(conversation_id) => ManagedRehostReceipt::new(
                &admitted,
                edge.source,
                edge.replacement,
                conversation_id,
                identity.launch_reference().map(str::to_owned),
                false,
            ),
            None => ManagedRehostReceipt::new_fresh(
                &admitted,
                edge.source,
                edge.replacement,
                identity.launch_reference().map(str::to_owned),
                false,
            ),
        }
        .map_err(|error| format!("hmux_managed_rehost_resolution_invalid: {error}"))?;
        receipt
            .validate_against_reconcile(request)
            .map_err(|error| format!("hmux_managed_rehost_resolution_invalid: {error}"))?;
        Ok(Some(receipt))
    })
    .map(Option::flatten)
}

fn with_operation_record<T>(
    discovery_root: &Path,
    request: &ManagedRehostReconcileRequest,
    read: impl FnOnce(&Path, Option<&RecoveryRecord>) -> Result<T, String>,
) -> Result<Option<T>, String> {
    with_recovery_directory(discovery_root, |directory| {
        let record = operation_record(directory, request)?;
        read(directory, record.as_ref())
    })
}

fn operation_record(
    directory: &Path,
    request: &ManagedRehostReconcileRequest,
) -> Result<Option<RecoveryRecord>, String> {
    let identity = prepared_identity(request);
    let path = directory.join(format!("operation_{}.json", digest(&identity.recovery_id)));
    if !private_path_exists(&path)? {
        return Ok(None);
    }
    let record = read_record(&path)?;
    validate_prepared_record(&record, &identity, None)?;
    Ok(Some(record))
}

/// Read one exact predecessor without replaying rehost or requiring its
/// un-compacted operation payload. This is resource ancestry, not stop authority.
pub fn read_managed_rehost_predecessor(
    discovery_root: &Path,
    target: &ManagedCreateReceipt,
) -> Result<Option<ManagedRehostResolution>, String> {
    target
        .validate()
        .map_err(|error| format!("hmux_managed_rehost_resolution_invalid: {error}"))?;
    if target.generation_fence().is_none() {
        return Err(
            "hmux_managed_rehost_resolution_invalid: exact target generation is required".into(),
        );
    }
    with_recovery_directory(discovery_root, |directory| {
        let mut candidate = managed_rehost_successor_index::predecessor(directory, target)?;
        // A completion can be durable before its index publication. Reuse the
        // existing journal reader only when the index has no candidate.
        if candidate.is_none() {
            for entry in scan_journal(directory, true)? {
                let Some(record) = entry.record else {
                    continue;
                };
                if is_refused_managed_rehost_record(&record) {
                    continue;
                }
                if (record.action != MANAGED_REHOST_RECOVERY_ACTION
                    && !is_completed_rehost_receipt_record(&record))
                    || !matches!(record.state, RecoveryRecordState::Completed { .. })
                {
                    continue;
                }
                let edge = resolution_edge(&record)?;
                if matches_rehost_target(&edge, target) {
                    if candidate.is_some() {
                        return Err(
                            "hmux_managed_rehost_resolution_conflict: target has multiple predecessors".into(),
                        );
                    }
                    candidate = Some(edge);
                }
            }
        }
        let Some(candidate) = candidate else {
            return Ok(None);
        };
        let source = candidate.source_generation();
        let request = ManagedRehostReconcileRequest::by_operation_identity(
            &candidate.operation_ids()[0],
            source.session_id(),
            source.workspace_id(),
        )
        .map_err(|error| format!("hmux_managed_rehost_resolution_invalid: {error}"))?;
        let record = operation_record(directory, &request)?;
        match direct_edge(
            directory,
            source.workspace_id(),
            source.session_id(),
            record.as_ref(),
        )? {
            ManagedRehostResolutionLookup::Resolved(edge) if matches_rehost_target(&edge, target) => {
                Ok(Some(*edge))
            }
            _ => Err(
                "hmux_managed_rehost_resolution_conflict: predecessor no longer names the exact target".into(),
            ),
        }
    })
    .map(Option::flatten)
}

pub(super) fn matches_rehost_target(
    edge: &ManagedRehostResolution,
    target: &ManagedCreateReceipt,
) -> bool {
    let current = edge.current_generation();
    edge.provider_id() == target.provider_id()
        && current.workspace_id() == target.workspace_id()
        && current.session_id() == target.session_id()
        && target.generation_fence().is_some_and(|fence| {
            fence.matches_generation(
                current.runner_principal(),
                current.runner_instance(),
                current.channel_epoch(),
                current.host_instance_id(),
                current.terminal_epoch(),
            )
        })
}

fn with_recovery_directory<T>(
    discovery_root: &Path,
    read: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<Option<T>, String> {
    let directory = discovery_root.join(".recovery");
    match fs::symlink_metadata(&directory) {
        Ok(_) => validate_existing_private_directory(&directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(_) => return Err("hmux_recovery_journal_invalid: directory is unreadable".into()),
    }
    let _admission = RecoveryLock::acquire_admission(open_private_existing_lock(
        &directory.join(ADMISSION_LOCK_NAME),
    )?)?;
    read(&directory).map(Some)
}

fn prepared_identity(request: &ManagedRehostReconcileRequest) -> PreparedRecoveryIdentity {
    PreparedRecoveryIdentity {
        recovery_id: format!(
            "{MANAGED_REHOST_RECOVERY_ID_PREFIX}{}",
            request.operation_id()
        ),
        source_session_id: request.source_session_id().into(),
        source_workspace_id: request.source_workspace_id().into(),
        action: MANAGED_REHOST_RECOVERY_ACTION,
        legacy_request_fingerprint: None,
    }
}

pub(super) fn direct_edge(
    directory: &Path,
    workspace_id: &str,
    session_id: &str,
    record: Option<&RecoveryRecord>,
) -> Result<ManagedRehostResolutionLookup, String> {
    let record = record.filter(|record| !is_refused_managed_rehost_record(record));
    let indexed =
        managed_rehost_successor_index::lookup_lineage(directory, workspace_id, session_id)?;
    if let Some(pending) =
        record.filter(|record| !matches!(record.state, RecoveryRecordState::Completed { .. }))
    {
        if indexed.is_some() {
            return Err(
                "hmux_managed_rehost_resolution_conflict: source is both pending and completed"
                    .into(),
            );
        }
        return Ok(ManagedRehostResolutionLookup::RetryRequired {
            operation_id: rehost_operation_id(pending),
        });
    }
    let journal = record.map(resolution_edge).transpose()?;
    let edge = match (indexed, journal) {
        (Some(mut indexed), Some(journal)) => {
            managed_rehost_successor_index::merge_launch_identity(directory, &mut indexed)?;
            indexed.merge_compatible(&journal).map_err(|_| {
                "hmux_managed_rehost_resolution_conflict: journal and successor index disagree"
                    .to_string()
            })?;
            Some(indexed)
        }
        (Some(mut edge), None) | (None, Some(mut edge)) => {
            managed_rehost_successor_index::merge_launch_identity(directory, &mut edge)?;
            Some(edge)
        }
        (None, None) => {
            managed_rehost_successor_index::lookup(directory, workspace_id, session_id)?
        }
    };
    Ok(
        edge.map_or(ManagedRehostResolutionLookup::NotFound, |edge| {
            ManagedRehostResolutionLookup::Resolved(Box::new(edge))
        }),
    )
}
