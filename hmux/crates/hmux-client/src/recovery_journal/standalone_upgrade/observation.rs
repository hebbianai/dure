use super::{
    CANCELLED_CODE, CompletedStandaloneUpgrade, PendingStandaloneUpgrade,
    StandaloneUpgradeOperation, StandaloneUpgradeProgress, StandaloneUpgradeSuccessor,
    cancellation, compacted, completed_launch, read_upgrade,
};
use crate::recovery_journal as journal;

enum LocalOperation {
    Missing,
    // An existing no-replacement completion still owns its local operation ID.
    Found(Option<StandaloneUpgradeOperation>),
}

/// Read the same completion before and after journal compaction. Pending intent
/// remains authoritative over a partially published compact completion.
pub fn read_completed(
    catalog: &crate::LocalSessionCatalog,
    recovery_id: &str,
    action: &str,
) -> Result<Option<CompletedStandaloneUpgrade>, String> {
    match read_operation(catalog, recovery_id, action)? {
        Some(StandaloneUpgradeOperation::Cancelled) => {
            Err(format!("{}: upgrade was cancelled", CANCELLED_CODE))
        }
        Some(StandaloneUpgradeOperation::Rehosted(completed)) => Ok(Some(*completed)),
        Some(StandaloneUpgradeOperation::Pending(_)) | None => Ok(None),
    }
}

/// Discovery does not turn a missing primary record into a fresh operation.
/// Pending and terminal facts use the same namespace lookup and decoder.
pub fn read_operation(
    catalog: &crate::LocalSessionCatalog,
    recovery_id: &str,
    action: &str,
) -> Result<Option<StandaloneUpgradeOperation>, String> {
    let mut found = LocalOperation::Missing;
    let mut visited = std::collections::BTreeSet::new();
    let mut roots = catalog
        .discovery_paths()
        .map(std::path::Path::to_path_buf)
        .collect::<std::collections::VecDeque<_>>();
    while let Some(root) = roots.pop_front() {
        if !visited.insert(root.clone()) {
            continue;
        }
        match read_local_operation(catalog, &root, recovery_id, action)? {
            LocalOperation::Missing => roots.extend(compacted::imported_operation_roots(
                &root.join(".recovery"),
                recovery_id,
            )?),
            LocalOperation::Found(observed) => {
                if let LocalOperation::Found(existing) = &found {
                    let same = match (existing.as_ref(), observed.as_ref()) {
                        (
                            Some(StandaloneUpgradeOperation::Cancelled),
                            Some(StandaloneUpgradeOperation::Cancelled),
                        ) => true,
                        (
                            Some(StandaloneUpgradeOperation::Rehosted(a)),
                            Some(StandaloneUpgradeOperation::Rehosted(b)),
                        ) => a == b,
                        _ => false,
                    };
                    if !same {
                        return Err("hmux_recovery_idempotency_conflict: upgrade has conflicting operation namespaces".into());
                    }
                }
                found = LocalOperation::Found(observed);
            }
        }
    }
    match found {
        LocalOperation::Found(observed) => Ok(observed),
        LocalOperation::Missing => Ok(None),
    }
}

pub(super) fn read_operation_at(
    catalog: &crate::LocalSessionCatalog,
    operation_root: &std::path::Path,
    recovery_id: &str,
    action: &str,
) -> Result<Option<StandaloneUpgradeOperation>, String> {
    match read_local_operation(catalog, operation_root, recovery_id, action)? {
        LocalOperation::Found(observed) => Ok(observed),
        LocalOperation::Missing => Ok(None),
    }
}

fn read_local_operation(
    catalog: &crate::LocalSessionCatalog,
    operation_root: &std::path::Path,
    recovery_id: &str,
    action: &str,
) -> Result<LocalOperation, String> {
    let directory = operation_root.join(".recovery");
    let _admission = if journal::private_directory_exists(&directory)? {
        Some(journal::acquire_admission_lock(&directory)?)
    } else {
        None
    };
    if let Some(record) =
        journal::existing_operation::read_existing_record(operation_root, recovery_id)?
    {
        journal::validate_stored_record(&record)?;
        if record.recovery_id != recovery_id || record.action != action {
            return Err("hmux_recovery_idempotency_conflict: upgrade identity differs".into());
        }
        if matches!(record.state, journal::RecoveryRecordState::Reserved { .. }) {
            return Ok(LocalOperation::Found(Some(
                StandaloneUpgradeOperation::Pending(Box::new(
                    PendingStandaloneUpgrade::from_record(operation_root, &record)?,
                )),
            )));
        }
        if cancellation::completed(&record)?.is_some() {
            return Ok(LocalOperation::Found(Some(
                StandaloneUpgradeOperation::Cancelled,
            )));
        }
        return completed_launch(catalog, &record)?
            .map(|(prepared, target)| {
                Ok(StandaloneUpgradeOperation::Rehosted(Box::new(
                    CompletedStandaloneUpgrade {
                        successor: StandaloneUpgradeSuccessor::from_launch(
                            &prepared.replacement.unwrap().create,
                            target,
                        )?,
                        source: prepared.source,
                        source_build_id: prepared.source_build_id,
                    },
                )))
            })
            .transpose()
            .map(LocalOperation::Found);
    }
    Ok(
        match compacted::read_completed(&directory, recovery_id, action)? {
            Some(observed) => LocalOperation::Found(Some(observed)),
            None => LocalOperation::Missing,
        },
    )
}

/// Observe pending journal intent before its compacted completion. A crash
/// during completion publication can leave both; Reserved still owns the
/// transition until the original operation commits or is reconciled.
pub fn read_successor(
    catalog: &crate::LocalSessionCatalog,
    source: &crate::ExitedSessionRetirementGeneration,
    provider: &crate::ProcessDescriptor,
) -> Result<Option<StandaloneUpgradeProgress>, String> {
    let mut found = None;
    let mut visited = std::collections::BTreeSet::new();
    for operation_root in catalog.discovery_paths() {
        let operation_root =
            compacted::source_operation_root(&operation_root.join(".recovery"), source, provider)?
                .unwrap_or_else(|| operation_root.to_path_buf());
        if !visited.insert(operation_root.clone()) {
            continue;
        }
        let directory = operation_root.join(".recovery");
        let progress = if journal::private_directory_exists(&directory)? {
            let admission = journal::acquire_admission_lock(&directory)?;
            read_successor_admitted(&admission, catalog, &operation_root, source, provider)?
        } else {
            compacted::successor(&directory, source, provider)?
        };
        if let Some(progress) = progress {
            if found
                .as_ref()
                .is_some_and(|existing| !same_terminal_progress(existing, &progress))
            {
                return Err(
                    "hmux_recovery_journal_invalid: source has conflicting upgrades".into(),
                );
            }
            found = Some(progress);
        }
    }
    Ok(found)
}

pub(super) fn read_successor_admitted(
    _admission: &journal::JournalAdmissionLock,
    catalog: &crate::LocalSessionCatalog,
    operation_root: &std::path::Path,
    source: &crate::ExitedSessionRetirementGeneration,
    provider: &crate::ProcessDescriptor,
) -> Result<Option<StandaloneUpgradeProgress>, String> {
    let directory = operation_root.join(".recovery");
    let mut found = None;
    for entry in journal::scan_journal(&directory, true)? {
        let Some(record) = entry.record else { continue };
        if record.source_session_id != source.fence.session_id
            || record.source_workspace_id != source.fence.workspace_id
        {
            continue;
        }
        let checkpoint = match &record.state {
            journal::RecoveryRecordState::Reserved {
                operation_checkpoint,
                ..
            }
            | journal::RecoveryRecordState::Completed {
                operation_checkpoint,
                ..
            } => operation_checkpoint,
        };
        let Some(checkpoint) = checkpoint else {
            continue;
        };
        let Some(prepared) = read_upgrade(&record.action, checkpoint)? else {
            continue;
        };
        if prepared.source.generation() != source
            || prepared.source.provider_process() != provider
            || prepared.replacement.is_none()
        {
            continue;
        }
        let progress = match &record.state {
            journal::RecoveryRecordState::Reserved { .. } => {
                StandaloneUpgradeProgress::Pending(Box::new(PendingStandaloneUpgrade::from_record(
                    operation_root,
                    &record,
                )?))
            }
            journal::RecoveryRecordState::Completed { .. } => {
                if cancellation::completed(&record)?.is_some() {
                    StandaloneUpgradeProgress::Cancelled
                } else {
                    let (prepared, target) =
                        completed_launch(catalog, &record)?.ok_or_else(|| {
                            "hmux_recovery_journal_invalid: completed upgrade lost its launch"
                                .to_string()
                        })?;
                    StandaloneUpgradeProgress::Completed(Box::new(
                        StandaloneUpgradeSuccessor::from_launch(
                            &prepared.replacement.unwrap().create,
                            target,
                        )?,
                    ))
                }
            }
        };
        if found.replace(progress).is_some() {
            return Err("hmux_recovery_journal_invalid: source has conflicting upgrades".into());
        }
    }
    if matches!(found, Some(StandaloneUpgradeProgress::Pending(_))) {
        return Ok(found);
    }
    let saved = compacted::successor(&directory, source, provider)?;
    if let (Some(observed), Some(saved)) = (&found, &saved) {
        if !same_terminal_progress(observed, saved) {
            return Err(
                "hmux_recovery_journal_invalid: compacted upgrade changed its target".into(),
            );
        }
    }
    Ok(found.or(saved))
}

fn same_terminal_progress(
    observed: &StandaloneUpgradeProgress,
    saved: &StandaloneUpgradeProgress,
) -> bool {
    match (observed, saved) {
        (StandaloneUpgradeProgress::Cancelled, StandaloneUpgradeProgress::Cancelled) => true,
        (
            StandaloneUpgradeProgress::Completed(observed),
            StandaloneUpgradeProgress::Completed(saved),
        ) => observed == saved,
        _ => false,
    }
}
