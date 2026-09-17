use super::*;

mod quota_reads;

/// Bounded diagnostic labels, never record identities or private payloads.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryReservationPhase {
    /// Root validation and the nonblocking shared maintenance acquisition.
    MaintenanceAcquire,
    /// Only the blocking admission lock call, excluding file open/validation.
    AdmissionLock,
    MetadataScan,
    /// Private-file reads, decoding and validation needed to prove quota usage.
    RecordScan,
    /// Retire eligible receipts under the same admission lock and snapshot.
    CapacityMaintenance,
    /// Nonblocking operation lock attempt, excluding file open/validation.
    OperationLock,
    RecordRead,
    /// Serialization, durable write/sync and atomic publication.
    RecordPublish,
}

pub(super) struct RecoveryReservationInput<'a> {
    pub(super) recovery_id: &'a str,
    pub(super) source_session_id: &'a str,
    pub(super) source_workspace_id: &'a str,
    pub(super) action: &'static str,
    pub(super) expected_request_fingerprint: Option<&'a str>,
    pub(super) canonical_payload: Option<&'a str>,
    pub(super) legacy_request_fingerprint: Option<&'a str>,
    pub(super) fingerprint_binding: FingerprintBinding,
}

pub(super) fn reserve_internal<G>(
    discovery_root: &Path,
    input: RecoveryReservationInput<'_>,
    observe: &impl Fn(RecoveryReservationPhase) -> G,
) -> Result<RecoveryReservationState, String> {
    let RecoveryReservationInput {
        recovery_id,
        source_session_id,
        source_workspace_id,
        action,
        expected_request_fingerprint,
        canonical_payload,
        legacy_request_fingerprint,
        fingerprint_binding,
    } = input;
    // A submitted execution payload owns initial namespace creation. Reopen
    // and observation paths cannot create a missing writer on their own.
    if canonical_payload.is_some() {
        DiscoveryRoot::create(discovery_root)
            .map_err(|error| format!("hmux_recovery_journal_invalid: {error}"))?;
    }
    let maintenance = {
        let _scope = observe(RecoveryReservationPhase::MaintenanceAcquire);
        acquire_discovery_maintenance_shared(discovery_root)?
    };
    let directory = discovery_root.join(".recovery");
    ensure_private_directory(&directory)?;
    let digest = digest(recovery_id);
    let admission = acquire_admission_lock_observed(&directory, || {
        observe(RecoveryReservationPhase::AdmissionLock)
    })?;
    let lock_path = directory.join(format!("operation_{digest}.lock"));
    let record_path = directory.join(format!("operation_{digest}.json"));
    let was_existing = private_path_exists(&record_path)?;
    // Compaction changes storage, not operation identity. Admission owns the
    // check so stale callers cannot replace a completed upgrade with new intent.
    #[cfg(feature = "local-runtime")]
    if !was_existing {
        standalone_upgrade::refuse_new_operation(&directory, recovery_id)?;
    }
    if !was_existing && expected_request_fingerprint.is_none() && canonical_payload.is_none() {
        return Err(
            "hmux_recovery_prepare_required: canonical operation payload is required".to_string(),
        );
    }
    let admitted_request_fingerprint = expected_request_fingerprint
        .map(ToOwned::to_owned)
        .or_else(|| canonical_payload.map(|payload| request_fingerprint(&[payload])))
        .or_else(|| legacy_request_fingerprint.map(ToOwned::to_owned));
    refuse_acknowledged_binding(
        &directory,
        recovery_id,
        source_session_id,
        source_workspace_id,
        admitted_request_fingerprint.as_deref(),
        action,
    )?;
    let lock_was_existing = private_path_exists(&lock_path)?;
    let mut entries = {
        let _scope = observe(RecoveryReservationPhase::MetadataScan);
        scan_journal(&directory, false)?
    };
    let operation_records = entries
        .iter()
        .filter(|entry| matches!(entry.kind, JournalEntryKind::OperationRecord(_)))
        .count();
    if !was_existing {
        let (quota, code) = if action == MANAGED_STOP_RECOVERY_ACTION {
            (
                MAX_MANAGED_STOP_OPERATION_RECORDS,
                "hmux_recovery_managed_stop_capacity_exceeded",
            )
        } else {
            (
                MAX_GENERAL_OPERATION_RECORDS,
                "hmux_recovery_journal_capacity_exceeded",
            )
        };
        let used = if operation_records < quota {
            operation_records
        } else {
            let _scope = observe(RecoveryReservationPhase::RecordScan);
            read_admitted_quota_bound(&admission, &mut entries, action, operation_records, quota)?
        };
        if used >= quota {
            // An upper bound still at capacity means every record was read:
            // `used` is exact and compaction has a fully validated snapshot.
            let required = used.saturating_sub(quota).saturating_add(1);
            let compacted = {
                let _scope = observe(RecoveryReservationPhase::CapacityMaintenance);
                if action == MANAGED_STOP_RECOVERY_ACTION {
                    compact_completed_stops_for_admission(&admission, &directory, &entries)?
                } else {
                    compact_completed_operations_for_admission(&directory, &entries, required)?
                }
            };
            if compacted < required {
                let remaining = used.saturating_sub(compacted);
                return Err(format!(
                    "{code}: operation record limit reached ({remaining}/{quota})"
                ));
            }
            entries = {
                let _scope = observe(RecoveryReservationPhase::MetadataScan);
                scan_journal(&directory, false)?
            };
        }
    }
    ensure_raw_admission_capacity(
        entries.len(),
        usize::from(!lock_was_existing) + usize::from(!was_existing),
    )?;
    let candidate = if was_existing {
        None
    } else {
        let request_fingerprint = expected_request_fingerprint
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| request_fingerprint(&[canonical_payload.unwrap_or_default()]));
        let record = RecoveryRecord {
            schema_version: RECOVERY_SCHEMA_VERSION,
            recovery_id: recovery_id.to_string(),
            source_session_id: source_session_id.to_string(),
            source_workspace_id: source_workspace_id.to_string(),
            request_fingerprint,
            action: action.to_string(),
            created_unix_ms: unix_time_ms(),
            state: RecoveryRecordState::Reserved {
                resume_checkpoint: None,
                operation_checkpoint: canonical_payload.map(|payload| {
                    RecoveryOperationCheckpoint {
                        canonical_payload: payload.to_string(),
                        source_stop_receipt: None,
                        replacement_receipt: None,
                    }
                }),
            },
        };
        #[cfg(feature = "local-runtime")]
        standalone_upgrade::admit_prepared(&admission, &directory, &record)?;
        Some(record)
    };
    let lock_file = open_private_lock(&lock_path)?;
    let lock = {
        let _scope = observe(RecoveryReservationPhase::OperationLock);
        RecoveryLock::acquire(lock_file)?
    };
    let record = if let Some(record) = candidate {
        let _scope = observe(RecoveryReservationPhase::RecordPublish);
        write_record_admitted(&admission, &directory, &record_path, &record)?;
        record
    } else {
        let _scope = observe(RecoveryReservationPhase::RecordRead);
        read_record(&record_path)?
    };
    if let Some(request_fingerprint) = expected_request_fingerprint {
        validate_record(
            &record,
            &RecoveryIdentity {
                recovery_id: recovery_id.to_string(),
                source_session_id: source_session_id.to_string(),
                source_workspace_id: source_workspace_id.to_string(),
                request_fingerprint: request_fingerprint.to_string(),
                action,
            },
        )?;
    } else {
        validate_prepared_record(
            &record,
            &PreparedRecoveryIdentity {
                recovery_id: recovery_id.to_string(),
                source_session_id: source_session_id.to_string(),
                source_workspace_id: source_workspace_id.to_string(),
                action,
                legacy_request_fingerprint: legacy_request_fingerprint.map(str::to_string),
            },
            canonical_payload,
        )?;
    }
    publish_managed_rehost_successor(&directory, &record)?;
    drop(admission);
    drop(maintenance);
    match &record.state {
        RecoveryRecordState::Reserved { .. } => {
            Ok(RecoveryReservationState::Pending(RecoveryReservation {
                record_path: Box::new(record_path),
                directory,
                record,
                was_existing,
                fingerprint_binding,
                _lock: lock,
            }))
        }
        RecoveryRecordState::Completed {
            target_session_id,
            target_workspace_id,
            target_build_id,
            outcome,
            resume_checkpoint,
            operation_checkpoint,
            ..
        } => Ok(RecoveryReservationState::Completed(RecoveryCompletion {
            target_session_id: target_session_id.clone(),
            target_workspace_id: target_workspace_id.clone(),
            target_build_id: target_build_id.clone(),
            action: record.action,
            outcome: outcome.clone(),
            resume_checkpoint: resume_checkpoint.clone(),
            operation_checkpoint: operation_checkpoint.clone(),
        })),
    }
}

fn read_admitted_quota_bound(
    _admission: &JournalAdmissionLock,
    entries: &mut [JournalEntry],
    action: &str,
    mut used: usize,
    quota: usize,
) -> Result<usize, String> {
    // Admission fences publication and retirement since the bounded metadata
    // scan. Count unread records against this quota; only fully validated
    // opposite-class records can lower that upper bound. Stop once free space
    // is proved. At pressure, validate everything before planning any mutation.
    let is_stop = action == MANAGED_STOP_RECOVERY_ACTION;
    let mut pending = entries
        .iter_mut()
        .filter(|entry| matches!(entry.kind, JournalEntryKind::OperationRecord(_)));
    while used >= quota {
        // Even if every record is opposite-class, this many reads are needed
        // before capacity can be proved. Never speculate past that bound.
        let batch: Vec<_> = pending.by_ref().take((used - quota + 1).min(64)).collect();
        if batch.is_empty() {
            break;
        }
        let records = quota_reads::read_entries(&batch, &|entry| {
            read_journal_entry_record(&entry.path, &entry.kind)
        })?;
        for (entry, record) in batch.into_iter().zip(records) {
            entry.record = record;
            if entry
                .record
                .as_ref()
                .is_some_and(|record| (record.action == MANAGED_STOP_RECOVERY_ACTION) != is_stop)
            {
                used -= 1;
            }
        }
    }
    Ok(used)
}

fn compact_completed_stops_for_admission(
    _admission: &JournalAdmissionLock,
    directory: &Path,
    entries: &[JournalEntry],
) -> Result<usize, String> {
    // Admission still fences every record publisher. Reuse its validated
    // snapshot for planning, but retain the exact candidate reread and
    // nonblocking operation lock before durable retirement. The caller scans
    // fresh metadata afterward for raw-entry admission, not every payload again.
    let candidates = planned_completed_candidates(
        entries,
        &RecoveryJournalGcPolicy::managed_stop_capacity(),
        unix_time_ms(),
        Some(MANAGED_STOP_RECOVERY_ACTION),
    );
    let mut retired = 0;
    for candidate in candidates {
        if try_retire_completed_candidate(directory, &candidate, |record| {
            record.action == MANAGED_STOP_RECOVERY_ACTION
        })? {
            retired += 1;
        }
    }
    Ok(retired)
}
