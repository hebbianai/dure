use super::*;
use crate::runtime_diagnostics::{MAX_RECORD_BYTES, open_owner_file};
use fs2::FileExt;
use hmux_runtime_contract::PermissionMode;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};

fn request() -> ManagedCreateRequest {
    ManagedCreateRequest::new(
        "timing-request",
        "timing-session",
        "timing-workspace",
        "fixture",
        PermissionMode::Default,
        "/tmp",
        vec!["/bin/true".into()],
        24,
        80,
    )
    .unwrap()
}

fn selected(root: &std::path::Path) -> RequestTiming {
    RequestTiming::selected(Some(OsStr::new("timing-request")), &request(), || {
        Some(root.into())
    })
}

fn record(root: &std::path::Path) -> serde_json::Value {
    let raw = fs::read_to_string(root.join(".diagnostics/runtime-v1").join(FILE)).unwrap();
    assert_eq!(raw.lines().count(), 1);
    assert!(raw.len() <= MAX_RECORD_BYTES);
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn absent_and_mismatched_selection_never_resolve_root_or_read_clock() {
    let reads = CLOCK_READS.get();
    for selector in [
        None,
        Some(OsStr::new("")),
        Some(OsStr::new("another-request")),
    ] {
        let timing =
            RequestTiming::selected(selector, &request(), || panic!("disabled root resolution"));
        for stage in [
            Phase::StopReservation,
            Phase::LaunchCapacity,
            Phase::LaunchCompatibility,
            Phase::LaunchAdmission,
        ] {
            drop(phase(stage));
        }
        timing.finish(&ManagedCreateAdvanceBrokerResponse::Pending, true);
    }
    assert_eq!(CLOCK_READS.get(), reads);
    assert!(ACTIVE.with(|active| active.borrow().is_none()));
}

#[test]
fn bounded_phases_keep_start_order_and_report_truncation() {
    let root = tempfile::tempdir().unwrap();
    let timing = selected(root.path());
    for _ in 0..MAX_PHASES + 4 {
        drop(phase(Phase::SourceClose));
    }
    timing.finish(&ManagedCreateAdvanceBrokerResponse::Pending, true);
    let record = record(root.path());
    assert_eq!(record["requestId"], "timing-request");
    assert_eq!(record["outcome"], "pending");
    assert_eq!(record["responsePublished"], true);
    assert_eq!(record["truncated"], true);
    let phases = record["phases"].as_array().unwrap();
    assert_eq!(phases.len(), MAX_PHASES);
    let total = record["elapsedMicros"].as_u64().unwrap();
    for phase in phases {
        assert!(
            phase["startMicros"].as_u64().unwrap() + phase["elapsedMicros"].as_u64().unwrap()
                <= total
        );
    }
    for pair in phases.windows(2) {
        assert!(pair[0]["startMicros"].as_u64() <= pair[1]["startMicros"].as_u64());
    }
}

#[test]
fn nested_scopes_and_other_threads_do_not_replace_request_identity() {
    let root = tempfile::tempdir().unwrap();
    let timing = selected(root.path());
    {
        let _outer = phase(Phase::SourceStop);
        let nested =
            RequestTiming::selected(Some(OsStr::new("timing-request")), &request(), || {
                panic!("nested root resolution")
            });
        drop(nested);
        drop(phase(Phase::StopReservation));
        std::thread::spawn(|| {
            let reads = CLOCK_READS.get();
            drop(phase(Phase::TargetLaunch));
            assert_eq!(reads, CLOCK_READS.get());
        })
        .join()
        .unwrap();
    }
    timing.finish(&ManagedCreateAdvanceBrokerResponse::Pending, false);
    let record = record(root.path());
    let phases = record["phases"].as_array().unwrap();
    assert_eq!(phases.len(), 2);
    assert_eq!(phases[0]["phase"], "source_stop");
    assert_eq!(phases[1]["phase"], "stop_reservation");
    assert_eq!(record["responsePublished"], false);
}

#[test]
fn busy_sink_drops_record_without_waiting_or_changing_outcome() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join(".diagnostics/runtime-v1");
    fs::create_dir_all(&directory).unwrap();
    let lock = open_owner_file(&directory.join(LOCK), true).unwrap();
    lock.lock_exclusive().unwrap();
    let timing = selected(root.path());
    drop(phase(Phase::SourceClose));
    let response =
        ManagedCreateAdvanceBrokerResponse::refused("fixture_refusal", "private failure detail");
    let before = serde_json::to_value(&response).unwrap();
    let started = Instant::now();
    timing.finish(&response, true);
    assert!(started.elapsed() < Duration::from_millis(100));
    assert_eq!(before, serde_json::to_value(&response).unwrap());
    assert!(!directory.join(FILE).exists());
    assert!(ACTIVE.with(|active| active.borrow().is_none()));
}

#[test]
fn unsafe_sink_is_not_followed_and_does_not_poison_next_request() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join(".diagnostics/runtime-v1");
    fs::create_dir_all(&directory).unwrap();
    let target = root.path().join("untouched");
    fs::write(&target, b"keep").unwrap();
    symlink(&target, directory.join(FILE)).unwrap();
    selected(root.path()).finish(&ManagedCreateAdvanceBrokerResponse::Pending, true);
    assert_eq!(fs::read(&target).unwrap(), b"keep");
    let next = tempfile::tempdir().unwrap();
    selected(next.path()).finish(&ManagedCreateAdvanceBrokerResponse::Pending, true);
    assert_eq!(record(next.path())["requestId"], "timing-request");
}

#[test]
fn closed_scope_cannot_attribute_a_late_phase_to_a_new_request() {
    let first = tempfile::tempdir().unwrap();
    let timing = selected(first.path());
    let late = phase(Phase::SourceClose);
    timing.finish(&ManagedCreateAdvanceBrokerResponse::Pending, false);
    let next = tempfile::tempdir().unwrap();
    let timing = selected(next.path());
    drop(late);
    timing.finish(&ManagedCreateAdvanceBrokerResponse::Pending, true);
    assert_eq!(
        record(first.path())["phases"][0]["elapsedMicros"],
        serde_json::Value::Null
    );
    assert!(record(next.path())["phases"].as_array().unwrap().is_empty());
}

#[test]
fn capacity_pressure_finishes_with_one_reservation() {
    use crate::managed_stop_intent::{self, ManagedStopIntent};
    use hmux_runtime_contract::{ManagedStopOutcome, ManagedStopReceipt, ManagedStopRequest};

    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    for index in 0..=512 {
        // Only the admission at the existing action quota is selected.
        let timing = (index == 512).then(|| selected(root.path()));
        let request = ManagedStopRequest::new(
            format!("stop-{index}"),
            format!("session-{index}"),
            "timing-workspace",
        )
        .unwrap()
        .with_expected_fence("principal", "runner", 1, "host", "terminal")
        .unwrap();
        let ManagedStopIntent::Pending(mut intent) =
            managed_stop_intent::acquire(root.path(), &request).unwrap()
        else {
            panic!("new stop must be admitted");
        };
        let receipt = ManagedStopReceipt::from_request(
            &request,
            ManagedStopOutcome::Stopped,
            "managed_provider_stopped",
        )
        .unwrap();
        intent.checkpoint_receipt(&request, &receipt).unwrap();
        intent.finish_checkpointed(&receipt).unwrap();
        if let Some(timing) = timing {
            timing.finish(&ManagedCreateAdvanceBrokerResponse::Pending, true);
        }
    }
    let record = record(root.path());
    eprintln!("stop quota admission trace: {record}");
    let phases = record["phases"].as_array().unwrap();
    assert_eq!(
        phases
            .iter()
            .map(|phase| phase["phase"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["stop_reservation"]
    );
    assert!(phases.iter().all(|phase| phase["elapsedMicros"].is_u64()));
    let reservation = &phases[0]["reservation"];
    for field in [
        "maintenanceAcquireMicros",
        "admissionLockMicros",
        "metadataScanMicros",
        "recordScanMicros",
        "capacityMaintenanceMicros",
        "recordPublishMicros",
    ] {
        assert!(
            reservation[field].is_u64(),
            "missing {field} in {reservation}"
        );
    }
    assert!(reservation["recordScanMicros"].as_u64().unwrap() > 0);
    assert_eq!(record["truncated"], false);
}

fn stop_request(id: &str) -> hmux_runtime_contract::ManagedStopRequest {
    hmux_runtime_contract::ManagedStopRequest::new(id, "session", "workspace")
        .unwrap()
        .with_expected_fence("principal", "runner", 1, "host", "terminal")
        .unwrap()
}

#[test]
fn unselected_real_reservation_and_replay_do_not_read_diagnostic_clocks() {
    use crate::managed_stop_intent;

    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let reads = CLOCK_READS.get();
    let request = stop_request("disabled");
    drop(managed_stop_intent::acquire(root.path(), &request).unwrap());
    drop(managed_stop_intent::acquire(root.path(), &request).unwrap());
    assert_eq!(CLOCK_READS.get(), reads);
    assert!(!root.path().join(".diagnostics").exists());
}

#[test]
fn admission_contention_is_measured_separately_from_disk_work() {
    use hmux_client::recovery_journal::{
        MANAGED_STOP_RECOVERY_ACTION, PreparedRecoveryIdentity, reserve_prepared_observed,
    };
    use std::sync::mpsc;

    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    drop(crate::managed_stop_intent::acquire(root.path(), &stop_request("seed")).unwrap());
    let lock =
        open_owner_file(&root.path().join(".recovery/journal_admission.lock"), false).unwrap();
    lock.lock_exclusive().unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let path = root.path().to_path_buf();
    let worker = std::thread::spawn(move || {
        let timing = selected(&path);
        {
            let parent = phase(Phase::StopReservation);
            let identity = PreparedRecoveryIdentity {
                recovery_id: "contended-stop".into(),
                source_session_id: "session".into(),
                source_workspace_id: "workspace".into(),
                action: MANAGED_STOP_RECOVERY_ACTION,
                legacy_request_fingerprint: None,
            };
            drop(
                reserve_prepared_observed(&path, identity, Some("{}".into()), |step| {
                    let scope = parent.reservation_step(step);
                    if step == RecoveryReservationPhase::AdmissionLock {
                        entered_tx.send(()).unwrap();
                    }
                    scope
                })
                .unwrap(),
            );
        }
        timing.finish(&ManagedCreateAdvanceBrokerResponse::Pending, true);
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    // Deliberate contention in a disposable journal. No production delay hook.
    std::thread::sleep(Duration::from_millis(80));
    FileExt::unlock(&lock).unwrap();
    worker.join().unwrap();
    let record = record(root.path());
    let parent = &record["phases"][0];
    let breakdown = &parent["reservation"];
    assert!(breakdown["admissionLockMicros"].as_u64().unwrap() >= 70_000);
    assert!(breakdown["metadataScanMicros"].is_u64());
    assert!(breakdown["operationLockMicros"].is_u64());
    assert!(breakdown["recordPublishMicros"].is_u64());
    assert!(breakdown["recordReadMicros"].is_null());
    let sum: u64 = breakdown
        .as_object()
        .unwrap()
        .values()
        .map(|v| v.as_u64().unwrap())
        .sum();
    assert!(sum <= parent["elapsedMicros"].as_u64().unwrap());
}

#[test]
fn existing_and_busy_operations_keep_their_outcome_and_partial_breakdown() {
    use crate::managed_stop_intent::{self, ManagedStopIntent};

    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let request = stop_request("replay");
    drop(managed_stop_intent::acquire(root.path(), &request).unwrap());
    let timing = selected(root.path());
    let guard = managed_stop_intent::acquire(root.path(), &request).unwrap();
    assert!(matches!(guard, ManagedStopIntent::Resume { .. }));
    let error = managed_stop_intent::acquire(root.path(), &request)
        .err()
        .unwrap();
    assert!(error.outcome_unknown());
    assert!(error.to_string().starts_with("hmux_recovery_busy:"));
    drop(guard);
    timing.finish(&ManagedCreateAdvanceBrokerResponse::Pending, true);
    let record = record(root.path());
    let replay = &record["phases"][0]["reservation"];
    assert!(replay["recordReadMicros"].is_u64());
    assert!(replay["recordPublishMicros"].is_null());
    let busy = &record["phases"][1]["reservation"];
    assert!(busy["operationLockMicros"].is_u64());
    assert!(busy["recordReadMicros"].is_null());
    assert!(busy["recordPublishMicros"].is_null());
}
