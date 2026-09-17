use super::*;

#[test]
fn mixed_quota_admission_stops_when_remaining_records_cannot_fill_its_quota() {
    for (action, general, stops, quota) in [
        (TEST_ACTION, 8, 512, MAX_GENERAL_OPERATION_RECORDS),
        (
            MANAGED_STOP_RECOVERY_ACTION,
            256,
            272,
            MAX_MANAGED_STOP_OPERATION_RECORDS,
        ),
    ] {
        let temp = tempfile::tempdir().unwrap();
        for (kind, count) in [
            (TEST_ACTION, general),
            (MANAGED_STOP_RECOVERY_ACTION, stops),
        ] {
            for index in 0..count {
                write_reserved_record_fixture_for_action(
                    temp.path(),
                    &format!("{kind}-{index}"),
                    "workspace-1",
                    "source-1",
                    kind,
                );
            }
        }
        let next = PreparedRecoveryIdentity {
            recovery_id: "mixed-next".into(),
            source_session_id: "source-1".into(),
            source_workspace_id: "workspace-1".into(),
            action,
            legacy_request_fingerprint: None,
        };
        let phases = std::cell::RefCell::new(Vec::new());
        let reads = RECORD_READ_COUNT.get();
        let scans = JOURNAL_SCAN_COUNT.get();
        let started = std::time::Instant::now();
        let admitted =
            reserve_prepared_observed(temp.path(), next.clone(), Some("{}".into()), |p| {
                phases.borrow_mut().push(p)
            })
            .unwrap();
        let read_count = RECORD_READ_COUNT.get() - reads;
        eprintln!(
            "mixed {action} admission: {} us, {read_count} reads",
            started.elapsed().as_micros()
        );
        let own_class = if action == MANAGED_STOP_RECOVERY_ACTION {
            stops
        } else {
            general
        };
        let required_witnesses = general + stops - quota + 1;
        // Even if every same-class record comes first, only enough validated
        // opposite-class witnesses to prove free capacity need to be read.
        assert!(
            (required_witnesses..=required_witnesses + own_class).contains(&read_count),
            "read {read_count} records instead of at most {}",
            required_witnesses + own_class
        );
        assert_eq!(JOURNAL_SCAN_COUNT.get() - scans, 1);
        assert!(
            !phases
                .borrow()
                .contains(&RecoveryReservationPhase::CapacityMaintenance)
        );
        assert!(matches!(admitted, RecoveryReservationState::Pending(_)));
        let inspection = inspect(temp.path()).unwrap();
        assert_eq!(inspection.operation_records, general + stops + 1);
        assert_eq!(inspection.pending_records, general + stops + 1);
        drop(admitted);
        let reads = RECORD_READ_COUNT.get();
        assert!(matches!(reserve_prepared(temp.path(), next, None).unwrap(),
            RecoveryReservationState::Pending(reservation) if reservation.was_existing()));
        assert_eq!(RECORD_READ_COUNT.get() - reads, 1);
    }
}

#[test]
fn stop_below_its_own_quota_does_not_read_historical_payloads() {
    for count in [
        MAX_GENERAL_OPERATION_RECORDS,
        MAX_MANAGED_STOP_OPERATION_RECORDS - 1,
    ] {
        let temp = tempfile::tempdir().unwrap();
        for index in 0..count {
            write_reserved_record_fixture_for_action(
                temp.path(),
                &format!("stop-{index}"),
                "workspace-1",
                "source-1",
                MANAGED_STOP_RECOVERY_ACTION,
            );
        }
        let phases = std::cell::RefCell::new(Vec::new());
        let reads = RECORD_READ_COUNT.get();
        let admitted = reserve_prepared_observed(
            temp.path(),
            managed_stop_identity(count),
            Some("{}".into()),
            |p| phases.borrow_mut().push(p),
        )
        .unwrap();
        assert!(matches!(admitted, RecoveryReservationState::Pending(_)));
        assert_eq!(RECORD_READ_COUNT.get() - reads, 0);
        assert!(
            !phases
                .borrow()
                .contains(&RecoveryReservationPhase::RecordScan)
        );
        assert_eq!(inspect(temp.path()).unwrap().pending_records, count + 1);
    }
}

#[test]
fn mixed_quota_last_slot_is_serialized_across_admissions() {
    let temp = tempfile::tempdir().unwrap();
    for (action, count) in [
        ("another-general-action", MAX_GENERAL_OPERATION_RECORDS - 1),
        (
            MANAGED_STOP_RECOVERY_ACTION,
            MAX_MANAGED_STOP_OPERATION_RECORDS,
        ),
    ] {
        for index in 0..count {
            write_reserved_record_fixture_for_action(
                temp.path(),
                &format!("{action}-{index}"),
                "workspace-1",
                "source-1",
                action,
            );
        }
    }
    let barrier = std::sync::Barrier::new(2);
    let results = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            barrier.wait();
            reserve(
                temp.path(),
                identity("mixed-last-a", "workspace-1", "source-1"),
            )
        });
        let second = scope.spawn(|| {
            barrier.wait();
            reserve(
                temp.path(),
                identity("mixed-last-b", "workspace-1", "source-1"),
            )
        });
        [first.join().unwrap(), second.join().unwrap()]
    });
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let error = results.into_iter().find_map(Result::err).unwrap();
    assert_eq!(
        error,
        "hmux_recovery_journal_capacity_exceeded: operation record limit reached (256/256)"
    );
    let inspection = inspect(temp.path()).unwrap();
    assert_eq!(inspection.pending_records, MAX_OPERATION_RECORDS);
    assert_eq!(inspection.completed_records, 0);
}

#[test]
fn quota_payload_validation_precedes_any_retirement() {
    for malformed in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(".recovery");
        for index in 0..MAX_GENERAL_OPERATION_RECORDS - 1 {
            write_reserved_record_fixture(
                temp.path(),
                &format!("pending-{index}"),
                "workspace-1",
                "source-1",
            );
        }
        let completed = write_completed_record_for_action_at(
            temp.path(),
            "old-general",
            1,
            "build-general",
            TEST_ACTION,
        );
        let completed_before = fs::read(&completed).unwrap();
        let pending = directory.join(format!("operation_{}.json", digest("pending-0")));
        let pending_before = fs::read(&pending).unwrap();
        let next = PreparedRecoveryIdentity {
            recovery_id: "new-general".into(),
            source_session_id: "source-1".into(),
            source_workspace_id: "workspace-1".into(),
            action: TEST_ACTION,
            legacy_request_fingerprint: None,
        };
        let error =
            reserve_prepared_observed(temp.path(), next.clone(), Some("{}".into()), |phase| {
                if phase == RecoveryReservationPhase::RecordScan {
                    // Change the file after metadata admission. Content must still
                    // be read and validated, including its binding to this path.
                    if malformed {
                        fs::write(&pending, b"{").unwrap();
                    } else {
                        let mut record: RecoveryRecord =
                            serde_json::from_slice(&pending_before).unwrap();
                        record.recovery_id = "different-operation".into();
                        fs::write(&pending, serialize_record(&record).unwrap()).unwrap();
                    }
                }
            })
            .unwrap_err();
        assert_eq!(
            error,
            if malformed {
                "hmux_recovery_journal_invalid: record is malformed"
            } else {
                "hmux_recovery_journal_invalid: record identity does not match its path"
            }
        );
        assert_eq!(fs::read(&completed).unwrap(), completed_before);
        assert!(
            !directory
                .join(format!("operation_{}.json", digest(&next.recovery_id)))
                .exists()
        );
        fs::write(&pending, &pending_before).unwrap();
        let phases = std::cell::RefCell::new(Vec::new());
        drop(
            reserve_prepared_observed(temp.path(), next, Some("{}".into()), |phase| {
                phases.borrow_mut().push(phase)
            })
            .unwrap(),
        );
        assert!(
            phases
                .borrow()
                .contains(&RecoveryReservationPhase::CapacityMaintenance)
        );
        assert!(!completed.exists());
        assert_eq!(fs::read(&pending).unwrap(), pending_before);
    }
}

#[test]
fn quota_witness_requires_valid_content_and_path_binding_before_early_exit() {
    for malformed in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join(".recovery");
        for index in 0..MAX_GENERAL_OPERATION_RECORDS {
            write_reserved_record_fixture_for_action(
                temp.path(),
                &format!("witness-{index}"),
                "workspace-1",
                "source-1",
                MANAGED_STOP_RECOVERY_ACTION,
            );
        }
        // One valid opposite-class witness would suffice. None may be trusted
        // from a header alone, or before checking its operation/path binding.
        let error = reserve_prepared_observed(
            temp.path(),
            PreparedRecoveryIdentity {
                recovery_id: "after-invalid-witness".into(),
                source_session_id: "source-1".into(),
                source_workspace_id: "workspace-1".into(),
                action: TEST_ACTION,
                legacy_request_fingerprint: None,
            },
            Some("{}".into()),
            |phase| {
                if phase == RecoveryReservationPhase::RecordScan {
                    for index in 0..MAX_GENERAL_OPERATION_RECORDS {
                        let path = directory.join(format!(
                            "operation_{}.json",
                            digest(&format!("witness-{index}"))
                        ));
                        if malformed {
                            fs::write(&path, b"{").unwrap();
                        } else {
                            let mut record: RecoveryRecord =
                                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                            record.recovery_id = "different-witness".into();
                            fs::write(&path, serialize_record(&record).unwrap()).unwrap();
                        }
                    }
                }
            },
        )
        .unwrap_err();
        assert_eq!(
            error,
            if malformed {
                "hmux_recovery_journal_invalid: record is malformed"
            } else {
                "hmux_recovery_journal_invalid: record identity does not match its path"
            }
        );
        assert!(
            !directory
                .join(format!(
                    "operation_{}.json",
                    digest("after-invalid-witness")
                ))
                .exists()
        );
    }
}

#[test]
fn general_pressure_admission_enumerates_once_before_retirement() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");
    for index in 0..MAX_GENERAL_OPERATION_RECORDS - 2 {
        write_reserved_record_fixture(
            temp.path(),
            &format!("pending-general-{index}"),
            "workspace-1",
            "source-1",
        );
    }
    let busy_path = write_completed_record_for_action_at(
        temp.path(),
        "busy-general",
        1,
        "build-general",
        TEST_ACTION,
    );
    let busy_before = fs::read(&busy_path).unwrap();
    let busy = RecoveryLock::acquire(
        open_private_lock(&directory.join(format!("operation_{}.lock", digest("busy-general"))))
            .unwrap(),
    )
    .unwrap();
    let retired = write_completed_record_for_action_at(
        temp.path(),
        "old-general",
        2,
        "build-general",
        TEST_ACTION,
    );
    for index in 0..MAX_GENERAL_OPERATION_RECORDS {
        write_completed_record_for_action_at(
            temp.path(),
            &format!("stop-{index}"),
            1,
            "build-stop",
            MANAGED_STOP_RECOVERY_ACTION,
        );
    }
    let pending_path = directory.join(format!("operation_{}.json", digest("pending-general-0")));
    let pending_before = fs::read(&pending_path).unwrap();
    let reads = RECORD_READ_COUNT.get();
    let scans = JOURNAL_SCAN_COUNT.get();
    let started = std::time::Instant::now();
    let next = identity("new-general", "workspace-1", "source-1");
    let admitted = reserve(temp.path(), next.clone()).unwrap();
    eprintln!(
        "general pressure admission: {} us, {} scans, {} reads",
        started.elapsed().as_micros(),
        JOURNAL_SCAN_COUNT.get() - scans,
        RECORD_READ_COUNT.get() - reads
    );
    assert!(matches!(admitted, RecoveryReservationState::Pending(_)));
    // One metadata enumeration, every payload validated, then fresh metadata
    // after retirement. A busy candidate is never read through its held lock.
    assert_eq!(
        RECORD_READ_COUNT.get() - reads,
        2 * MAX_GENERAL_OPERATION_RECORDS + 1
    );
    assert_eq!(JOURNAL_SCAN_COUNT.get() - scans, 2);
    assert!(!retired.exists());
    assert_eq!(fs::read(&pending_path).unwrap(), pending_before);
    assert_eq!(fs::read(&busy_path).unwrap(), busy_before);
    let inspection = inspect(temp.path()).unwrap();
    assert_eq!(
        inspection.operation_records,
        2 * MAX_GENERAL_OPERATION_RECORDS
    );
    assert_eq!(
        inspection.pending_records,
        MAX_GENERAL_OPERATION_RECORDS - 1
    );
    drop(admitted);
    assert!(matches!(reserve(temp.path(), next).unwrap(),
        RecoveryReservationState::Pending(reservation) if reservation.was_existing()));
    drop(busy);
}

#[test]
fn stop_pressure_admission_reads_records_once_and_preserves_other_operations() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");
    write_reserved_record_fixture_for_action(
        temp.path(),
        "pending-stop",
        "workspace-1",
        "source-1",
        MANAGED_STOP_RECOVERY_ACTION,
    );
    let pending = directory.join(format!("operation_{}.json", digest("pending-stop")));
    let pending_before = fs::read(&pending).unwrap();
    let general = write_completed_record_for_action_at(
        temp.path(),
        "general-kept",
        1,
        "build-general",
        TEST_ACTION,
    );
    let general_before = fs::read(&general).unwrap();
    for index in 0..MAX_MANAGED_STOP_OPERATION_RECORDS - 2 {
        write_completed_record_for_action_at(
            temp.path(),
            &format!("stop-kept-{index}"),
            3,
            "build-stop",
            MANAGED_STOP_RECOVERY_ACTION,
        );
    }
    let active_path = directory.join(format!("operation_{}.json", digest("stop-kept-0")));
    let active_before = fs::read(&active_path).unwrap();
    let active_lock = RecoveryLock::acquire(
        open_private_lock(&directory.join(format!("operation_{}.lock", digest("stop-kept-0"))))
            .unwrap(),
    )
    .unwrap();
    let retired = write_completed_record_for_action_at(
        temp.path(),
        "stop-oldest",
        2,
        "build-stop",
        MANAGED_STOP_RECOVERY_ACTION,
    );
    let reads = RECORD_READ_COUNT.get();
    let scans = JOURNAL_SCAN_COUNT.get();
    let started = std::time::Instant::now();
    let next = managed_stop_identity(MAX_MANAGED_STOP_OPERATION_RECORDS);
    let admitted = reserve_prepared(temp.path(), next.clone(), Some("{}".into())).unwrap();
    eprintln!(
        "stop pressure admission: {} us, {} scans, {} reads",
        started.elapsed().as_micros(),
        JOURNAL_SCAN_COUNT.get() - scans,
        RECORD_READ_COUNT.get() - reads
    );
    assert!(matches!(admitted, RecoveryReservationState::Pending(_)));
    // One bounded snapshot (512 stops + 1 general), then an exact candidate
    // reread under its operation lock. No second semantic admission scan.
    assert_eq!(
        RECORD_READ_COUNT.get() - reads,
        MAX_MANAGED_STOP_OPERATION_RECORDS + 2
    );
    assert_eq!(JOURNAL_SCAN_COUNT.get() - scans, 2);
    assert!(!retired.exists());
    assert_eq!(fs::read(&pending).unwrap(), pending_before);
    assert_eq!(fs::read(&general).unwrap(), general_before);
    assert_eq!(fs::read(&active_path).unwrap(), active_before);
    let inspection = inspect(temp.path()).unwrap();
    assert_eq!(
        inspection.operation_records,
        MAX_MANAGED_STOP_OPERATION_RECORDS + 1
    );
    assert_eq!(inspection.pending_records, 2);
    drop(admitted);
    assert!(matches!(reserve_prepared(temp.path(), next, None).unwrap(),
        RecoveryReservationState::Pending(reservation) if reservation.was_existing()));
    drop(active_lock);
}

#[cfg(feature = "local-runtime")]
#[test]
fn state_gc_reads_one_fresh_snapshot_per_admission() {
    let temp = tempfile::tempdir().unwrap();
    write_reserved_record_fixture(temp.path(), "fresh-scan", "workspace-1", "source-1");
    let scans = JOURNAL_SCAN_COUNT.get();
    let reads = RECORD_READ_COUNT.get();
    let report = recover_scan_capacity_for_state_gc(temp.path()).unwrap();
    assert_eq!(report.remaining.pending_records, 1);
    assert_eq!(JOURNAL_SCAN_COUNT.get() - scans, 1);
    assert_eq!(RECORD_READ_COUNT.get() - reads, 1);

    write_completed_record(temp.path(), "fresh-scan");
    let scans = JOURNAL_SCAN_COUNT.get();
    let reads = RECORD_READ_COUNT.get();
    let report = recover_scan_capacity_for_state_gc(temp.path()).unwrap();
    assert_eq!(report.remaining.pending_records, 0);
    assert_eq!(report.remaining.completed_records, 1);
    assert_eq!(JOURNAL_SCAN_COUNT.get() - scans, 1);
    assert_eq!(RECORD_READ_COUNT.get() - reads, 1);
}

#[test]
fn stop_pressure_preserves_locked_receipts_and_validates_before_retirement() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");
    for index in 0..MAX_MANAGED_STOP_OPERATION_RECORDS - 1 {
        write_reserved_record_fixture_for_action(
            temp.path(),
            &format!("pending-{index}"),
            "workspace-1",
            "source-1",
            MANAGED_STOP_RECOVERY_ACTION,
        );
    }
    let completed = write_completed_record_for_action_at(
        temp.path(),
        "locked-stop",
        1,
        "build-stop",
        MANAGED_STOP_RECOVERY_ACTION,
    );
    let completed_before = fs::read(&completed).unwrap();
    let lock_path = directory.join(format!("operation_{}.lock", digest("locked-stop")));
    let busy = RecoveryLock::acquire(open_private_lock(&lock_path).unwrap()).unwrap();
    let next = managed_stop_identity(MAX_MANAGED_STOP_OPERATION_RECORDS);
    let reads = RECORD_READ_COUNT.get();
    assert!(
        reserve_prepared(temp.path(), next.clone(), Some("{}".into()))
            .unwrap_err()
            .starts_with("hmux_recovery_managed_stop_capacity_exceeded:")
    );
    assert_eq!(
        RECORD_READ_COUNT.get() - reads,
        MAX_MANAGED_STOP_OPERATION_RECORDS
    );
    assert_eq!(fs::read(&completed).unwrap(), completed_before);
    assert_eq!(
        inspect(temp.path()).unwrap().pending_records,
        MAX_MANAGED_STOP_OPERATION_RECORDS - 1
    );
    drop(busy);

    let pending = directory.join(format!("operation_{}.json", digest("pending-0")));
    let pending_before = fs::read(&pending).unwrap();
    fs::write(&pending, b"{").unwrap();
    assert_eq!(
        reserve_prepared(temp.path(), next.clone(), Some("{}".into())).unwrap_err(),
        "hmux_recovery_journal_invalid: record is malformed"
    );
    assert_eq!(fs::read(&completed).unwrap(), completed_before);
    assert!(
        !directory
            .join(format!("operation_{}.json", digest(&next.recovery_id)))
            .exists()
    );

    fs::write(&pending, &pending_before).unwrap();
    let admitted = reserve_prepared(temp.path(), next, Some("{}".into())).unwrap();
    assert!(matches!(admitted, RecoveryReservationState::Pending(_)));
    assert!(!completed.exists());
    assert_eq!(fs::read(&pending).unwrap(), pending_before);
    assert_eq!(
        inspect(temp.path()).unwrap().pending_records,
        MAX_MANAGED_STOP_OPERATION_RECORDS
    );
}

#[test]
fn overflow_scan_drops_all_payloads_but_still_validates_every_record() {
    let temp = tempfile::tempdir().unwrap();
    for index in 0..3 {
        write_reserved_record_fixture(
            temp.path(),
            &format!("bounded-{index}"),
            "workspace-1",
            "source-1",
        );
    }
    let directory = temp.path().join(".recovery");
    let admission = acquire_admission_lock(&directory).unwrap();
    for (limit, retained) in [(4, 3), (3, 0), (0, 0)] {
        let reads = RECORD_READ_COUNT.get();
        let entries = scan_journal_bounded(
            &directory,
            JournalRecordScan::RetainThrough(limit),
            8,
            "test scan",
        )
        .unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(RECORD_READ_COUNT.get() - reads, 3);
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.record.is_some())
                .count(),
            retained
        );
    }
    let corrupt_path = directory.join(format!("operation_{}.json", digest("bounded-2")));
    fs::write(&corrupt_path, b"{").unwrap();
    assert_eq!(
        scan_journal_bounded(
            &directory,
            JournalRecordScan::RetainThrough(0),
            8,
            "test scan"
        )
        .unwrap_err(),
        "hmux_recovery_journal_invalid: record is malformed"
    );
    drop(admission);
}

#[test]
fn overflow_maintenance_rescans_before_returning_authoritative_records() {
    let (temp, directory, _) = prepare_overflow_fixture_with_capacity(
        "scan-refresh",
        TEST_SEMANTIC_OVERFLOW_SCAN_CAPACITY,
    );
    write_reserved_record_fixture(temp.path(), "protected", "workspace-1", "source-1");
    let admission = acquire_admission_lock(&directory).unwrap();
    let mut report = RecoveryJournalGcReport::default();
    let scans = JOURNAL_SCAN_COUNT.get();
    let reads = RECORD_READ_COUNT.get();
    let entries = scan_journal_with_capacity_recovery(
        &admission,
        &directory,
        &mut report,
        TEST_SEMANTIC_OVERFLOW_SCAN_CAPACITY,
    )
    .unwrap();
    assert!(report.removed_temporary_files > 0);
    assert_eq!(
        entries.len(),
        TEST_SEMANTIC_OVERFLOW_SCAN_CAPACITY.low_water_entries
    );
    assert_eq!(JOURNAL_SCAN_COUNT.get() - scans, 2);
    assert_eq!(RECORD_READ_COUNT.get() - reads, 2);
    assert_eq!(inspect_entries(entries).unwrap().pending_records, 1);
}

#[test]
fn action_gc_at_stop_capacity_reads_each_snapshot_once() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");
    let pending_id = "stop-pending";
    write_reserved_record_fixture_for_action(
        temp.path(),
        pending_id,
        "workspace-1",
        "pending-source",
        MANAGED_STOP_RECOVERY_ACTION,
    );
    for index in 0..MAX_MANAGED_STOP_OPERATION_RECORDS - 2 {
        write_completed_record_for_action_at(
            temp.path(),
            &format!("stop-kept-{index}"),
            2,
            "build-stop",
            MANAGED_STOP_RECOVERY_ACTION,
        );
    }
    let active_path = directory.join(format!("operation_{}.json", digest("stop-kept-0")));
    let active_lock = RecoveryLock::acquire(
        open_private_lock(&directory.join(format!("operation_{}.lock", digest("stop-kept-0"))))
            .unwrap(),
    )
    .unwrap();
    let pending_path = directory.join(format!("operation_{}.json", digest(pending_id)));
    let active_before = fs::read(&active_path).unwrap();
    let pending_before = fs::read(&pending_path).unwrap();
    let policy = RecoveryJournalGcPolicy {
        minimum_completed_age: Duration::ZERO,
        maximum_completed_records: MAX_MANAGED_STOP_OPERATION_RECORDS - 1,
        maximum_completed_bytes: 12 * 1024 * 1024,
        ..RecoveryJournalGcPolicy::default()
    };
    let mut samples = Vec::new();
    for _ in 0..5 {
        let removed = write_completed_record_for_action_at(
            temp.path(),
            "stop-oldest",
            1,
            "build-stop",
            MANAGED_STOP_RECOVERY_ACTION,
        );
        let scans_before = JOURNAL_SCAN_COUNT.get();
        let reads_before = RECORD_READ_COUNT.get();
        let started = std::time::Instant::now();
        let report = garbage_collect_completed_at(
            temp.path(),
            policy,
            3,
            Some(MANAGED_STOP_RECOVERY_ACTION),
        )
        .unwrap();
        samples.push((
            started.elapsed().as_micros(),
            JOURNAL_SCAN_COUNT.get() - scans_before,
            RECORD_READ_COUNT.get() - reads_before,
        ));
        assert_eq!(report.removed_completed_records, 1);
        assert_eq!(report.remaining.operation_records, 511);
        assert_eq!(report.remaining.pending_records, 1);
        assert!(!removed.exists());
        assert_eq!(fs::read(&active_path).unwrap(), active_before);
        assert_eq!(fs::read(&pending_path).unwrap(), pending_before);
    }
    eprintln!("stop GC samples (microseconds, scans, record reads): {samples:?}");
    for (_, scans, reads) in samples {
        // One complete planning snapshot, one post-mutation snapshot, and
        // the exact candidate re-read under its operation lock: 512+511+1.
        assert_eq!(
            scans, 2,
            "capacity preflight must not repeat the planning scan"
        );
        assert_eq!(reads, 2 * MAX_MANAGED_STOP_OPERATION_RECORDS);
    }
    drop(active_lock);
}
