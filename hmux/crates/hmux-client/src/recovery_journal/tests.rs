//! Recovery journal unit tests and their private on-disk fixtures.

use super::*;
use hmux_runtime_contract::{
    ManagedCreateGenerationFence, ManagedCreateOutcome, ManagedRehostLaunchIdentity,
    ManagedStopOutcome, ManagedStopRequest, PermissionMode,
};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const TEST_ACTION: &str = "restore_plain_shell_with_current_build";

mod maintenance_scans;
mod metadata_snapshot;
mod private_json_validation;

fn operation_payload(value: impl Into<String>) -> RecoveryOperationPayload {
    RecoveryOperationPayload::new(value.into()).unwrap()
}

#[test]
fn operation_payload_admits_bounded_json_once() {
    assert!(RecoveryOperationPayload::new("{}".into()).is_ok());
    assert!(RecoveryOperationPayload::new(String::new()).is_err());
    assert!(RecoveryOperationPayload::new("not-json".into()).is_err());
    assert!(
        RecoveryOperationPayload::new(format!(
            "\"{}\"",
            "x".repeat(MAX_RECOVERY_OPERATION_PAYLOAD_BYTES - 2)
        ))
        .is_ok()
    );
    assert!(
        RecoveryOperationPayload::new(format!(
            "\"{}\"",
            "x".repeat(MAX_RECOVERY_OPERATION_PAYLOAD_BYTES - 1)
        ))
        .is_err()
    );
}

#[test]
fn escaped_payload_capacity_failure_does_not_mutate_the_reservation() {
    let temp = tempfile::tempdir().unwrap();
    let payload = serde_json::to_string(&"\\".repeat(16_382)).unwrap();
    assert_eq!(payload.len(), 32_766);
    let identity = identity("escaped-record", "workspace-1", "source-1");
    let RecoveryReservationState::Pending(mut reservation) =
        reserve(temp.path(), identity.clone()).unwrap()
    else {
        panic!("new operation must be pending")
    };

    assert_eq!(
        reservation
            .prepare_operation_payload(operation_payload(payload))
            .unwrap_err(),
        RECOVERY_RECORD_CAPACITY_EXCEEDED_CODE
    );
    assert!(reservation.operation_checkpoint().is_none());
    drop(reservation);

    let RecoveryReservationState::Pending(reopened) = reserve(temp.path(), identity).unwrap()
    else {
        panic!("failed payload publication must leave the small reservation reopenable")
    };
    assert!(reopened.operation_checkpoint().is_none());
}

#[test]
fn completion_capacity_is_checked_by_the_exact_record_serializer() {
    let temp = tempfile::tempdir().unwrap();
    let canonical_payload = serde_json::to_string(&"x".repeat(32_766)).unwrap();
    let replacement_receipt = serde_json::to_string(&"\0".repeat(5_400)).unwrap();
    let identity = identity("completion-capacity", "workspace-1", "source-1");
    let RecoveryReservationState::Pending(mut reservation) =
        reserve(temp.path(), identity.clone()).unwrap()
    else {
        panic!("new operation must be pending")
    };
    let completion = RecoveryCompletion {
        target_session_id: "target-1".into(),
        target_workspace_id: "workspace-1".into(),
        target_build_id: "build-1".into(),
        action: identity.action.into(),
        outcome: "completed".into(),
        resume_checkpoint: None,
        operation_checkpoint: Some(RecoveryOperationCheckpoint {
            canonical_payload: canonical_payload.clone(),
            source_stop_receipt: None,
            replacement_receipt: Some(replacement_receipt.clone()),
        }),
    };

    assert_eq!(
        reservation
            .prepare_operation_payload_for_completion(
                operation_payload(canonical_payload.clone()),
                completion,
            )
            .unwrap_err(),
        RECOVERY_RECORD_CAPACITY_EXCEEDED_CODE
    );
    assert!(reservation.operation_checkpoint().is_none());
    reservation
        .prepare_operation_payload(operation_payload(canonical_payload))
        .unwrap();
    assert_eq!(
        reservation
            .checkpoint_replacement_receipt(replacement_receipt)
            .unwrap_err(),
        RECOVERY_RECORD_CAPACITY_EXCEEDED_CODE
    );
    assert!(
        reservation
            .operation_checkpoint()
            .unwrap()
            .replacement_receipt
            .is_none()
    );
    drop(reservation);

    let RecoveryReservationState::Pending(reopened) = reserve(temp.path(), identity).unwrap()
    else {
        panic!("capacity refusal must not publish a partial checkpoint")
    };
    assert!(
        reopened
            .operation_checkpoint()
            .unwrap()
            .replacement_receipt
            .is_none()
    );
}

fn identity(recovery_id: &str, workspace_id: &str, session_id: &str) -> RecoveryIdentity {
    RecoveryIdentity {
        recovery_id: recovery_id.into(),
        source_session_id: session_id.into(),
        source_workspace_id: workspace_id.into(),
        request_fingerprint: request_fingerprint(&[recovery_id, workspace_id, session_id]),
        action: TEST_ACTION,
    }
}

fn direct_rehost_resolution(
    discovery_root: &Path,
    operation_id: &str,
    source_session_id: &str,
    replacement_session_id: &str,
    source_epoch: u64,
    replacement_epoch: u64,
) -> ManagedRehostResolution {
    direct_rehost_resolution_with_launch_identity(
        discovery_root,
        operation_id,
        source_session_id,
        replacement_session_id,
        source_epoch,
        replacement_epoch,
        None,
    )
}

fn direct_rehost_resolution_with_launch_identity(
    discovery_root: &Path,
    operation_id: &str,
    source_session_id: &str,
    replacement_session_id: &str,
    source_epoch: u64,
    replacement_epoch: u64,
    launch_identity: Option<ManagedRehostLaunchIdentity>,
) -> ManagedRehostResolution {
    let source = ManagedStopReceipt::from_request(
        &ManagedStopRequest::new(
            format!("stop-{operation_id}"),
            source_session_id,
            "workspace-successors",
        )
        .unwrap()
        .with_expected_fence(
            format!("principal-{source_session_id}"),
            format!("runner-{source_session_id}"),
            source_epoch,
            format!("host-{source_session_id}"),
            format!("terminal-{source_session_id}"),
        )
        .unwrap(),
        ManagedStopOutcome::Stopped,
        "managed source stopped",
    )
    .unwrap();
    let replacement = ManagedCreateReceipt::new(
        format!("create-{operation_id}"),
        replacement_session_id,
        "workspace-successors",
        "codex",
        PermissionMode::Default,
        discovery_root,
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new(
            format!("principal-{replacement_session_id}"),
            format!("runner-{replacement_session_id}"),
            replacement_epoch,
            format!("host-{replacement_session_id}"),
            format!("terminal-{replacement_session_id}"),
        )
        .unwrap(),
    )
    .unwrap();
    ManagedRehostResolution::from_receipts_with_launch_identity(
        operation_id,
        &source,
        &replacement,
        launch_identity,
    )
    .unwrap()
}

fn write_completed_rehost_record(
    discovery_root: &Path,
    operation_id: &str,
    source_session_id: &str,
    replacement_session_id: &str,
    action: &str,
) -> PathBuf {
    write_completed_rehost_record_with_payload(
        discovery_root,
        operation_id,
        source_session_id,
        replacement_session_id,
        action,
        "{}",
    )
}

fn write_completed_rehost_record_with_payload(
    discovery_root: &Path,
    operation_id: &str,
    source_session_id: &str,
    replacement_session_id: &str,
    action: &str,
    canonical_payload: &str,
) -> PathBuf {
    let source = ManagedStopReceipt::from_request(
        &ManagedStopRequest::new(
            format!("stop-{operation_id}"),
            source_session_id,
            "workspace-successors",
        )
        .unwrap()
        .with_expected_fence(
            format!("principal-{source_session_id}"),
            format!("runner-{source_session_id}"),
            1,
            format!("host-{source_session_id}"),
            format!("terminal-{source_session_id}"),
        )
        .unwrap(),
        ManagedStopOutcome::Stopped,
        "managed source stopped",
    )
    .unwrap();
    let replacement = ManagedCreateReceipt::new(
        format!("create-{operation_id}"),
        replacement_session_id,
        "workspace-successors",
        "codex",
        PermissionMode::Default,
        discovery_root,
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new(
            format!("principal-{replacement_session_id}"),
            format!("runner-{replacement_session_id}"),
            2,
            format!("host-{replacement_session_id}"),
            format!("terminal-{replacement_session_id}"),
        )
        .unwrap(),
    )
    .unwrap();
    let directory = discovery_root.join(".recovery");
    ensure_private_directory(&directory).unwrap();
    let record = RecoveryRecord {
        schema_version: RECOVERY_SCHEMA_VERSION,
        recovery_id: if action == MANAGED_REHOST_RECOVERY_ACTION {
            format!("{MANAGED_REHOST_RECOVERY_ID_PREFIX}{operation_id}")
        } else {
            operation_id.into()
        },
        source_session_id: source.session_id().into(),
        source_workspace_id: source.workspace_id().into(),
        request_fingerprint: if action == MANAGED_REHOST_RECOVERY_ACTION {
            request_fingerprint(&[canonical_payload])
        } else {
            request_fingerprint(&[operation_id])
        },
        action: action.into(),
        created_unix_ms: unix_time_ms(),
        state: RecoveryRecordState::Completed {
            target_session_id: replacement.session_id().into(),
            target_workspace_id: replacement.workspace_id().into(),
            target_build_id: "build-1".into(),
            outcome: "replaced".into(),
            resume_checkpoint: None,
            operation_checkpoint: Some(RecoveryOperationCheckpoint {
                canonical_payload: canonical_payload.into(),
                source_stop_receipt: Some(
                    serde_json::json!({ "kind": "managed_stop", "receipt": source }).to_string(),
                ),
                replacement_receipt: Some(serde_json::to_string(&replacement).unwrap()),
            }),
            completed_unix_ms: Some(unix_time_ms()),
        },
    };
    validate_stored_record(&record).unwrap();
    let path = directory.join(format!("operation_{}.json", digest(&record.recovery_id)));
    write_record(&directory, &path, &record).unwrap();
    path
}

fn write_reserved_record_fixture(
    discovery_root: &Path,
    recovery_id: &str,
    workspace_id: &str,
    session_id: &str,
) {
    write_reserved_record_fixture_for_action(
        discovery_root,
        recovery_id,
        workspace_id,
        session_id,
        TEST_ACTION,
    );
}

fn write_reserved_record_fixture_for_action(
    discovery_root: &Path,
    recovery_id: &str,
    workspace_id: &str,
    session_id: &str,
    action: &str,
) {
    let directory = discovery_root.join(".recovery");
    ensure_private_directory(&directory).unwrap();
    let identity = identity(recovery_id, workspace_id, session_id);
    let record = RecoveryRecord {
        schema_version: RECOVERY_SCHEMA_VERSION,
        recovery_id: identity.recovery_id,
        source_session_id: identity.source_session_id,
        source_workspace_id: identity.source_workspace_id,
        request_fingerprint: identity.request_fingerprint,
        action: action.into(),
        created_unix_ms: unix_time_ms(),
        state: RecoveryRecordState::Reserved {
            resume_checkpoint: None,
            operation_checkpoint: None,
        },
    };
    validate_stored_record(&record).unwrap();
    let payload = serde_json::to_vec(&record).unwrap();
    let path = directory.join(format!("operation_{}.json", digest(recovery_id)));
    // Capacity fixtures need valid on-disk state, not hundreds of durable
    // publication fsyncs; production write_record tests keep that path covered.
    let mut file = open_private_new(&path).unwrap();
    file.write_all(&payload).unwrap();
}

fn complete_reservation(discovery_root: &Path, recovery_id: &str) -> RecoveryReservation {
    let recovery_identity = identity(recovery_id, "workspace-1", "source-1");
    let RecoveryReservationState::Pending(mut reservation) =
        reserve(discovery_root, recovery_identity).unwrap()
    else {
        panic!("new reservation must be pending")
    };
    reservation
        .complete(RecoveryCompletion {
            target_session_id: format!("target-{recovery_id}"),
            target_workspace_id: "workspace-1".into(),
            target_build_id: "build-1".into(),
            action: TEST_ACTION.into(),
            outcome: "replaced".into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .unwrap();
    reservation
}

fn write_completed_record(discovery_root: &Path, recovery_id: &str) {
    write_completed_record_at(discovery_root, recovery_id, unix_time_ms(), "build-1");
}

fn write_completed_record_at(
    discovery_root: &Path,
    recovery_id: &str,
    completed_unix_ms: u64,
    target_build_id: &str,
) -> PathBuf {
    write_completed_record_for_action_at(
        discovery_root,
        recovery_id,
        completed_unix_ms,
        target_build_id,
        TEST_ACTION,
    )
}

fn write_completed_record_for_action_at(
    discovery_root: &Path,
    recovery_id: &str,
    completed_unix_ms: u64,
    target_build_id: &str,
    action: &str,
) -> PathBuf {
    let directory = discovery_root.join(".recovery");
    ensure_private_directory(&directory).unwrap();
    let identity = identity(recovery_id, "workspace-1", "source-1");
    let record = RecoveryRecord {
        schema_version: RECOVERY_SCHEMA_VERSION,
        recovery_id: identity.recovery_id,
        source_session_id: identity.source_session_id,
        source_workspace_id: identity.source_workspace_id,
        request_fingerprint: identity.request_fingerprint,
        action: action.into(),
        created_unix_ms: completed_unix_ms,
        state: RecoveryRecordState::Completed {
            target_session_id: format!("target-{recovery_id}"),
            target_workspace_id: "workspace-1".into(),
            target_build_id: target_build_id.into(),
            outcome: if action == STANDALONE_CREATE_OPERATION_RECOVERY_ACTION {
                STANDALONE_CREATE_OPERATION_COMPLETION_OUTCOME.into()
            } else {
                "replaced".into()
            },
            resume_checkpoint: None,
            operation_checkpoint: None,
            completed_unix_ms: Some(completed_unix_ms),
        },
    };
    let path = directory.join(format!("operation_{}.json", digest(recovery_id)));
    write_record(&directory, &path, &record).unwrap();
    path
}

fn journal_entry_names(discovery_root: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(discovery_root.join(".recovery"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

fn aggressive_gc_policy() -> RecoveryJournalGcPolicy {
    RecoveryJournalGcPolicy {
        minimum_completed_age: Duration::ZERO,
        maximum_completed_records: 0,
        maximum_completed_bytes: 0,
        minimum_orphan_age: Duration::ZERO,
        maximum_source_lock_files: 0,
        maximum_orphan_operation_locks: 0,
        maximum_temporary_files: 0,
    }
}

fn overflow_only_gc_policy() -> RecoveryJournalGcPolicy {
    RecoveryJournalGcPolicy {
        minimum_completed_age: Duration::ZERO,
        maximum_completed_records: usize::MAX,
        maximum_completed_bytes: u64::MAX,
        minimum_orphan_age: Duration::ZERO,
        maximum_source_lock_files: usize::MAX,
        maximum_orphan_operation_locks: usize::MAX,
        maximum_temporary_files: usize::MAX,
    }
}

const TEST_OVERFLOW_SCAN_CAPACITY: JournalScanCapacity = JournalScanCapacity {
    authoritative_entries: 8,
    overflow_entries: 32,
    low_water_entries: 4,
};

const TEST_SEMANTIC_OVERFLOW_SCAN_CAPACITY: JournalScanCapacity = JournalScanCapacity {
    authoritative_entries: 16,
    overflow_entries: 64,
    low_water_entries: 8,
};

fn create_orphan_temporary_flood_with_count(
    directory: &Path,
    label: &str,
    entry_count: usize,
) -> String {
    let operation = digest(label);
    for index in 0..entry_count {
        let path = directory.join(format!(".gc-operation_{operation}-{label}-{index}.tmp"));
        drop(open_private_new(&path).unwrap());
    }
    operation
}

fn count_temporary_flood(directory: &Path, operation: &str) -> usize {
    let prefix = format!(".gc-operation_{operation}-");
    fs::read_dir(directory)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".tmp"))
        })
        .count()
}

fn prepare_overflow_fixture(label: &str) -> (tempfile::TempDir, PathBuf, String) {
    prepare_overflow_fixture_with_capacity(label, PRODUCTION_JOURNAL_SCAN_CAPACITY)
}

fn prepare_overflow_fixture_with_capacity(
    label: &str,
    capacity: JournalScanCapacity,
) -> (tempfile::TempDir, PathBuf, String) {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");
    ensure_private_directory(&directory).unwrap();
    drop(open_private_lock(&directory.join(ADMISSION_LOCK_NAME)).unwrap());
    let operation = create_orphan_temporary_flood_with_count(
        &directory,
        label,
        capacity.authoritative_entries + 1,
    );
    (temp, directory, operation)
}

fn garbage_collect_completed_with_capacity(
    discovery_root: &Path,
    policy: RecoveryJournalGcPolicy,
    capacity: JournalScanCapacity,
) -> Result<RecoveryJournalGcReport, String> {
    garbage_collect_completed_at_with_capacity(
        discovery_root,
        policy,
        unix_time_ms(),
        None,
        capacity,
    )
}

#[test]
fn completed_recovery_replays_without_storing_request_material() {
    let temp = tempfile::tempdir().unwrap();
    let identity = RecoveryIdentity {
        recovery_id: "recovery-1".into(),
        source_session_id: "source-1".into(),
        source_workspace_id: "workspace-1".into(),
        request_fingerprint: request_fingerprint(&["conversation-1", "secret-must-not-be-written"]),
        action: "replace_ai_provider_with_explicit_conversation",
    };
    let RecoveryReservationState::Pending(mut reservation) =
        reserve(temp.path(), identity.clone()).unwrap()
    else {
        panic!("first reservation must be pending")
    };
    reservation
        .complete(RecoveryCompletion {
            target_session_id: "target-1".into(),
            target_workspace_id: "workspace-1".into(),
            target_build_id: "build-1".into(),
            action: identity.action.into(),
            outcome: "replaced".into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .unwrap();
    drop(reservation);

    let RecoveryReservationState::Completed(completed) = reserve(temp.path(), identity).unwrap()
    else {
        panic!("completed reservation must replay")
    };
    assert_eq!(completed.target_session_id, "target-1");
    let record = fs::read_to_string(
        fs::read_dir(temp.path().join(".recovery"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .unwrap(),
    )
    .unwrap();
    assert!(!record.contains("secret-must-not-be-written"));
    assert!(!record.contains("conversation-1"));
}

#[test]
fn reserved_recovery_reports_when_it_is_a_crash_retry() {
    let temp = tempfile::tempdir().unwrap();
    let identity = RecoveryIdentity {
        recovery_id: "upgrade-1".into(),
        source_session_id: "source-1".into(),
        source_workspace_id: "workspace-1".into(),
        request_fingerprint: request_fingerprint(&["upgrade"]),
        action: "upgrade_standalone_with_current_build",
    };
    let RecoveryReservationState::Pending(first) = reserve(temp.path(), identity.clone()).unwrap()
    else {
        panic!("first reservation must be pending")
    };
    assert!(!first.was_existing());
    drop(first);

    let RecoveryReservationState::Pending(retried) = reserve(temp.path(), identity).unwrap() else {
        panic!("reserved operation must reopen as pending")
    };
    assert!(retried.was_existing());
}

#[test]
fn reused_recovery_id_rejects_a_different_request() {
    let temp = tempfile::tempdir().unwrap();
    let identity = RecoveryIdentity {
        recovery_id: "recovery-1".into(),
        source_session_id: "source-1".into(),
        source_workspace_id: "workspace-1".into(),
        request_fingerprint: request_fingerprint(&["request-a"]),
        action: "restore_plain_shell_with_current_build",
    };
    let reservation = reserve(temp.path(), identity.clone()).unwrap();
    drop(reservation);
    let conflicting = RecoveryIdentity {
        request_fingerprint: request_fingerprint(&["request-b"]),
        ..identity
    };
    assert_eq!(
        reserve(temp.path(), conflicting).unwrap_err(),
        "hmux_recovery_idempotency_conflict: recovery id belongs to another request"
    );
}

#[test]
fn dropping_reservation_unlocks_an_inherited_file_description() {
    let temp = tempfile::tempdir().unwrap();
    let identity = RecoveryIdentity {
        recovery_id: "recovery-1".into(),
        source_session_id: "source-1".into(),
        source_workspace_id: "workspace-1".into(),
        request_fingerprint: request_fingerprint(&["request-a"]),
        action: "restore_plain_shell_with_current_build",
    };
    let RecoveryReservationState::Pending(reservation) =
        reserve(temp.path(), identity.clone()).unwrap()
    else {
        panic!("first reservation must be pending")
    };
    assert_eq!(
        reserve(temp.path(), identity.clone()).unwrap_err(),
        "hmux_recovery_busy: recovery operation is already running"
    );
    let inherited_lock = reservation._lock.file.try_clone().unwrap();

    drop(reservation);

    let RecoveryReservationState::Pending(retry) = reserve(temp.path(), identity).unwrap() else {
        panic!("retry after releasing the reservation must be pending")
    };
    drop(retry);
    drop(inherited_lock);
}

#[test]
fn source_lock_serializes_distinct_recovery_ids_for_one_session() {
    let temp = tempfile::tempdir().unwrap();
    let first = lock_source(temp.path(), "workspace-1", "session-1").unwrap();
    assert_eq!(
        lock_source(temp.path(), "workspace-1", "session-1").unwrap_err(),
        "hmux_recovery_source_busy: another operation owns this source session"
    );
    let other = lock_source(temp.path(), "workspace-1", "session-2").unwrap();

    drop(first);
    let retried = lock_source(temp.path(), "workspace-1", "session-1").unwrap();
    drop(retried);
    drop(other);
}

#[test]
fn retirement_fence_blocks_new_pending_publication_until_destructive_boundary_releases() {
    let temp = tempfile::tempdir().unwrap();
    let source = digest("workspace-1\0session-1");
    let source_path = temp
        .path()
        .join(".recovery")
        .join(format!("source_{source}.lock"));
    let fence = match try_fence_source_retirement(temp.path(), "workspace-1", "session-1").unwrap()
    {
        RecoverySourceRetirementFenceState::Acquired(fence) => fence,
        RecoverySourceRetirementFenceState::Busy => panic!("fixture source must be free"),
    };
    assert!(!fence.source_is_pending("workspace-1", "session-1"));
    assert!(
        !source_path.exists(),
        "retirement created persistent source-lock debris"
    );
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (completed_tx, completed_rx) = std::sync::mpsc::channel();

    std::thread::scope(|scope| {
        let writer = scope.spawn(|| {
            started_tx.send(()).unwrap();
            completed_tx
                .send(
                    reserve(
                        temp.path(),
                        identity("retirement-race", "workspace-1", "session-1"),
                    )
                    .map(|_| ()),
                )
                .unwrap();
        });
        started_rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            completed_rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty),
            "Reserved record bypassed the retirement admission fence"
        );

        drop(fence);
        completed_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("journal publication did not resume")
            .unwrap();
        writer.join().unwrap();
    });
}

#[test]
fn retirement_fence_retains_maintenance_before_admission_until_archive_finishes() {
    let temp = tempfile::tempdir().unwrap();
    let fence = match try_fence_source_retirement(temp.path(), "workspace-1", "session-1").unwrap()
    {
        RecoverySourceRetirementFenceState::Acquired(fence) => fence,
        RecoverySourceRetirementFenceState::Busy => panic!("fixture source must be free"),
    };
    let root = DiscoveryRoot::open(temp.path()).unwrap();
    assert!(
        root.acquire_maintenance_exclusive().is_err(),
        "GC maintenance bypassed the retirement fence"
    );

    drop(fence);
    let maintenance = root
        .acquire_maintenance_exclusive()
        .expect("GC maintenance did not resume after retirement");
    drop(maintenance);
}

#[test]
fn record_publication_waits_for_the_admission_scan_fence() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");
    ensure_private_directory(&directory).unwrap();
    let recovery_id = "admission-fenced-publication";
    let identity = identity(recovery_id, "workspace-1", "source-1");
    let record = RecoveryRecord {
        schema_version: RECOVERY_SCHEMA_VERSION,
        recovery_id: identity.recovery_id,
        source_session_id: identity.source_session_id,
        source_workspace_id: identity.source_workspace_id,
        request_fingerprint: identity.request_fingerprint,
        action: identity.action.into(),
        created_unix_ms: unix_time_ms(),
        state: RecoveryRecordState::Reserved {
            resume_checkpoint: None,
            operation_checkpoint: None,
        },
    };
    let path = directory.join(format!("operation_{}.json", digest(recovery_id)));
    let admission = acquire_admission_lock(&directory).unwrap();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (completed_tx, completed_rx) = std::sync::mpsc::channel();

    std::thread::scope(|scope| {
        let writer = scope.spawn(|| {
            started_tx.send(()).unwrap();
            completed_tx
                .send(write_record(&directory, &path, &record))
                .unwrap();
        });
        started_rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            completed_rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty),
            "record publication bypassed the admission fence"
        );
        assert_eq!(
            journal_entry_names(temp.path()),
            vec![ADMISSION_LOCK_NAME.to_string()],
            "a scanner could observe a writer's temporary state"
        );

        drop(admission);
        completed_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("record publication did not resume after admission")
            .unwrap();
        writer.join().unwrap();
    });
    assert!(path.is_file());
}

#[test]
fn concurrent_first_source_locks_publish_a_private_directory_atomically() {
    for iteration in 0..16 {
        let temp = tempfile::tempdir().unwrap();
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                barrier.wait();
                lock_source(temp.path(), "workspace-1", "session-1")
            });
            let second = scope.spawn(|| {
                barrier.wait();
                lock_source(temp.path(), "workspace-1", "session-2")
            });
            let first = first.join().unwrap().unwrap();
            let second = second
                .join()
                .unwrap()
                .unwrap_or_else(|error| panic!("iteration {iteration} failed: {error}"));
            drop(first);
            drop(second);
        });
    }
}

#[cfg(unix)]
#[test]
fn journal_directory_creation_does_not_report_success_before_parent_sync() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");

    let error = ensure_private_directory_with_parent_sync(&directory, |_| {
        Err(std::io::Error::other(
            "fault-injected parent directory sync failure",
        ))
    })
    .unwrap_err();

    assert_eq!(
        error,
        "hmux_recovery_journal_failed: parent directory sync failed"
    );
    assert!(directory.exists());
    // Retrying must sync the parent even though the child now exists.
    ensure_private_directory(&directory).unwrap();
    let RecoveryReservationState::Pending(reservation) = reserve(
        temp.path(),
        identity("after-parent-sync-retry", "workspace-1", "source-1"),
    )
    .unwrap() else {
        panic!("durable directory retry must admit recovery")
    };
    drop(reservation);
}

#[test]
fn private_resume_checkpoint_survives_source_termination_retry() {
    let temp = tempfile::tempdir().unwrap();
    let identity = RecoveryIdentity {
        recovery_id: "adopt-1".into(),
        source_session_id: "legacy-1".into(),
        source_workspace_id: "workspace-1".into(),
        request_fingerprint: request_fingerprint(&["codex", "/repo"]),
        action: "adopt_legacy_provider_with_exact_conversation",
    };
    let RecoveryReservationState::Pending(mut reservation) =
        reserve(temp.path(), identity.clone()).unwrap()
    else {
        panic!("first reservation must be pending")
    };
    reservation
        .checkpoint_resume(RecoveryResumeCheckpoint {
            provider_id: "codex".into(),
            resume_identity: "019fa342-4698-78b2-a47d-784690b3c756".into(),
            provider_cwd: "/repo".into(),
            source_host_process_id: 101,
            source_host_start_marker: "host-start".into(),
            source_provider_process_id: 102,
            source_provider_start_marker: "provider-start".into(),
            source_host_instance_id: None,
            source_terminal_epoch: None,
            source_host_proof_marker: None,
            source_provider_proof_marker: None,
            source_terminated: true,
            attempt: 1,
        })
        .unwrap();
    drop(reservation);

    let RecoveryReservationState::Pending(retried) = reserve(temp.path(), identity).unwrap() else {
        panic!("checkpointed recovery must remain pending")
    };
    let checkpoint = retried.resume_checkpoint().unwrap();
    assert!(checkpoint.source_terminated);
    assert_eq!(checkpoint.attempt, 1);
    assert_eq!(
        checkpoint.resume_identity,
        "019fa342-4698-78b2-a47d-784690b3c756"
    );
}

#[test]
fn prepared_operation_replays_every_journaled_boundary_without_a_client_hint() {
    let temp = tempfile::tempdir().unwrap();
    let identity = PreparedRecoveryIdentity {
        recovery_id: "managed-rehost-1".into(),
        source_session_id: "managed-source-1".into(),
        source_workspace_id: "workspace-1".into(),
        action: "replace_ai_provider_with_explicit_conversation",
        legacy_request_fingerprint: None,
    };
    let payload = serde_json::json!({
        "conversationId": "conversation-exact",
        "credentialId": "credential-crispy",
        "providerStateEnvironment": {
            "CODEX_HOME": "/private/codex-crispy",
            "CODEX_SQLITE_HOME": "/private/codex-crispy/sqlite"
        },
        "terminalEnvironment": {
            "TERM": "xterm-256color",
            "NO_COLOR": null
        }
    })
    .to_string();

    let RecoveryReservationState::Pending(first) =
        reserve_prepared(temp.path(), identity.clone(), Some(payload.clone())).unwrap()
    else {
        panic!("first prepared reservation must be pending")
    };
    assert_eq!(
        first.operation_checkpoint().unwrap().canonical_payload,
        payload
    );
    drop(first);

    let RecoveryReservationState::Pending(mut after_payload) =
        reserve_prepared(temp.path(), identity.clone(), None).unwrap()
    else {
        panic!("payload-journal retry must remain pending")
    };
    let stop_receipt = serde_json::json!({
        "stopId": "managed-rehost-1-stop",
        "hostInstanceId": "host-source-1",
        "terminalEpoch": "terminal-source-1",
        "outcome": "stopped"
    })
    .to_string();
    after_payload
        .checkpoint_source_stop_receipt(stop_receipt.clone())
        .unwrap();
    drop(after_payload);

    let RecoveryReservationState::Pending(mut after_stop) =
        reserve_prepared(temp.path(), identity.clone(), None).unwrap()
    else {
        panic!("source-stop retry must remain pending")
    };
    assert_eq!(
        after_stop
            .operation_checkpoint()
            .unwrap()
            .source_stop_receipt
            .as_deref(),
        Some(stop_receipt.as_str())
    );
    let replacement_receipt = serde_json::json!({
        "sessionId": "managed-target-1",
        "workspaceId": "workspace-1",
        "credentialId": "credential-crispy",
        "conversationId": "conversation-exact"
    })
    .to_string();
    after_stop
        .checkpoint_replacement_receipt(replacement_receipt.clone())
        .unwrap();
    drop(after_stop);

    let RecoveryReservationState::Pending(mut after_replacement) =
        reserve_prepared(temp.path(), identity.clone(), None).unwrap()
    else {
        panic!("replacement-create retry must remain pending")
    };
    assert_eq!(
        after_replacement
            .operation_checkpoint()
            .unwrap()
            .replacement_receipt
            .as_deref(),
        Some(replacement_receipt.as_str())
    );
    after_replacement
        .complete(RecoveryCompletion {
            target_session_id: "managed-target-1".into(),
            target_workspace_id: "workspace-1".into(),
            target_build_id: "build-1".into(),
            action: identity.action.into(),
            outcome: "replaced".into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .unwrap();
    drop(after_replacement);

    let RecoveryReservationState::Completed(completed) =
        reserve_prepared(temp.path(), identity, None).unwrap()
    else {
        panic!("completed prepared operation must replay")
    };
    let checkpoint = completed.operation_checkpoint.unwrap();
    assert_eq!(checkpoint.canonical_payload, payload);
    assert_eq!(
        checkpoint.source_stop_receipt.as_deref(),
        Some(stop_receipt.as_str())
    );
    assert_eq!(
        checkpoint.replacement_receipt.as_deref(),
        Some(replacement_receipt.as_str())
    );
}

#[test]
fn request_bound_reservation_keeps_its_public_fingerprint_with_a_private_payload() {
    let temp = tempfile::tempdir().unwrap();
    let identity = identity("public-request-1", "workspace-1", "operation-1");
    let payload = serde_json::json!({
        "targetSessionId": "standalone-private-target",
        "launchOwnerProof": "private-proof"
    })
    .to_string();
    let RecoveryReservationState::Pending(mut first) =
        reserve(temp.path(), identity.clone()).unwrap()
    else {
        panic!("new public request must reserve")
    };
    first
        .prepare_operation_payload(operation_payload(payload.clone()))
        .unwrap();
    assert!(
        first
            .prepare_operation_payload(operation_payload("{\"changed\":true}"))
            .unwrap_err()
            .contains("idempotency_conflict")
    );
    drop(first);

    let mut changed_identity = identity.clone();
    changed_identity.request_fingerprint = "f".repeat(64);
    assert!(
        reserve(temp.path(), changed_identity)
            .unwrap_err()
            .contains("idempotency_conflict")
    );

    let RecoveryReservationState::Pending(replayed) = reserve(temp.path(), identity).unwrap()
    else {
        panic!("same public request must reopen")
    };
    assert_eq!(
        replayed.operation_checkpoint().unwrap().canonical_payload,
        payload
    );
}

#[test]
fn prepared_operation_lookup_is_read_only_and_exact() {
    let temp = tempfile::tempdir().unwrap();
    let identity = PreparedRecoveryIdentity {
        recovery_id: "managed-stop-lookup".into(),
        source_session_id: "managed-source-lookup".into(),
        source_workspace_id: "workspace-lookup".into(),
        action: MANAGED_STOP_RECOVERY_ACTION,
        legacy_request_fingerprint: None,
    };

    assert!(!prepared_operation_exists(temp.path(), &identity).unwrap());
    assert!(!temp.path().join(".recovery").exists());

    let reservation =
        reserve_prepared(temp.path(), identity.clone(), Some("{}".to_string())).unwrap();
    assert!(prepared_operation_exists(temp.path(), &identity).unwrap());
    let mut different = identity;
    different.recovery_id.push_str("-different");
    assert!(!prepared_operation_exists(temp.path(), &different).unwrap());
    assert_eq!(inspect_existing(temp.path()).unwrap().operation_records, 1);
    drop(reservation);
}

#[test]
fn prepared_operation_rejects_a_changed_canonical_payload() {
    let temp = tempfile::tempdir().unwrap();
    let identity = PreparedRecoveryIdentity {
        recovery_id: "managed-rehost-1".into(),
        source_session_id: "managed-source-1".into(),
        source_workspace_id: "workspace-1".into(),
        action: "replace_ai_provider_with_explicit_conversation",
        legacy_request_fingerprint: None,
    };
    let first = serde_json::json!({
        "conversationId": "conversation-exact",
        "credentialId": "credential-a"
    })
    .to_string();
    let changed = serde_json::json!({
        "conversationId": "conversation-exact",
        "credentialId": "credential-b"
    })
    .to_string();
    drop(reserve_prepared(temp.path(), identity.clone(), Some(first)).unwrap());

    assert_eq!(
        reserve_prepared(temp.path(), identity, Some(changed)).unwrap_err(),
        "hmux_recovery_idempotency_conflict: canonical operation payload changed"
    );
}

#[test]
fn prepared_operation_migration_requires_the_legacy_request_fingerprint() {
    let temp = tempfile::tempdir().unwrap();
    write_reserved_record_fixture(temp.path(), "legacy-1", "workspace-1", "source-1");
    let legacy = identity("legacy-1", "workspace-1", "source-1");
    let prepared_identity = |fingerprint: Option<String>| PreparedRecoveryIdentity {
        recovery_id: legacy.recovery_id.clone(),
        source_session_id: legacy.source_session_id.clone(),
        source_workspace_id: legacy.source_workspace_id.clone(),
        action: legacy.action,
        legacy_request_fingerprint: fingerprint,
    };

    assert_eq!(
        reserve_prepared(temp.path(), prepared_identity(None), None).unwrap_err(),
        "hmux_recovery_idempotency_conflict: legacy operation fingerprint changed"
    );
    assert_eq!(
        reserve_prepared(
            temp.path(),
            prepared_identity(Some(request_fingerprint(&["changed"]))),
            None,
        )
        .unwrap_err(),
        "hmux_recovery_idempotency_conflict: legacy operation fingerprint changed"
    );

    let RecoveryReservationState::Pending(mut reservation) = reserve_prepared(
        temp.path(),
        prepared_identity(Some(legacy.request_fingerprint)),
        None,
    )
    .unwrap() else {
        panic!("matching legacy operation must be migratable")
    };
    reservation
        .prepare_operation_payload(operation_payload(
            serde_json::json!({"prepared": true}).to_string(),
        ))
        .unwrap();
    assert!(reservation.operation_checkpoint().is_some());
}

#[test]
fn operation_capacity_rejects_new_ids_but_reopens_existing_ids() {
    let temp = tempfile::tempdir().unwrap();
    for index in 0..MAX_GENERAL_OPERATION_RECORDS {
        write_reserved_record_fixture(
            temp.path(),
            &format!("recovery-{index}"),
            "workspace-1",
            &format!("source-{index}"),
        );
    }

    let RecoveryReservationState::Pending(existing) = reserve(
        temp.path(),
        identity("recovery-0", "workspace-1", "source-0"),
    )
    .unwrap() else {
        panic!("existing reservation must remain available at capacity")
    };
    drop(existing);
    assert_eq!(
        reserve(
            temp.path(),
            identity("over-capacity", "workspace-1", "new-source")
        )
        .unwrap_err(),
        "hmux_recovery_journal_capacity_exceeded: operation record limit reached (256/256)"
    );
}

#[test]
fn operation_capacity_compacts_a_completed_rehost_before_admitting_a_new_id() {
    let temp = tempfile::tempdir().unwrap();
    let compacted_path = write_completed_rehost_record(
        temp.path(),
        "compactable-rehost",
        "compactable-source",
        "compactable-successor",
        "adapter_owned_provider_replacement",
    );
    for index in 0..(MAX_GENERAL_OPERATION_RECORDS - 1) {
        write_reserved_record_fixture(
            temp.path(),
            &format!("recovery-{index}"),
            "workspace-1",
            &format!("source-{index}"),
        );
    }

    let RecoveryReservationState::Pending(admitted) = reserve(
        temp.path(),
        identity("after-capacity-compaction", "workspace-1", "new-source"),
    )
    .unwrap() else {
        panic!("a compacted successor must make room for the new operation")
    };
    drop(admitted);

    assert!(!compacted_path.exists());
    assert_eq!(
        inspect(temp.path()).unwrap().operation_records,
        MAX_GENERAL_OPERATION_RECORDS
    );
    let ManagedRehostResolutionLookup::Resolved(resolution) =
        resolve_managed_rehost_current(temp.path(), "workspace-successors", "compactable-source")
            .unwrap()
    else {
        panic!("the compacted receipt must remain exact successor authority")
    };
    assert_eq!(
        resolution.current_generation().session_id(),
        "compactable-successor"
    );
}

#[test]
fn operation_capacity_never_compacts_a_busy_completed_rehost() {
    let temp = tempfile::tempdir().unwrap();
    let compactable_path = write_completed_rehost_record(
        temp.path(),
        "busy-rehost",
        "busy-source",
        "busy-successor",
        "adapter_owned_provider_replacement",
    );
    let directory = temp.path().join(".recovery");
    let held = RecoveryLock::acquire(
        open_private_lock(&directory.join(format!("operation_{}.lock", digest("busy-rehost"))))
            .unwrap(),
    )
    .unwrap();
    for index in 0..(MAX_GENERAL_OPERATION_RECORDS - 1) {
        write_reserved_record_fixture(
            temp.path(),
            &format!("recovery-{index}"),
            "workspace-1",
            &format!("source-{index}"),
        );
    }

    assert_eq!(
        reserve(
            temp.path(),
            identity("blocked-by-busy-rehost", "workspace-1", "new-source")
        )
        .unwrap_err(),
        "hmux_recovery_journal_capacity_exceeded: operation record limit reached (256/256)"
    );
    assert!(compactable_path.exists());
    drop(held);
}

#[test]
fn operation_capacity_compacts_an_expired_completed_general_operation() {
    let temp = tempfile::tempdir().unwrap();
    let minimum_age_ms = u64::try_from(
        RecoveryJournalGcPolicy::default()
            .minimum_completed_age
            .as_millis(),
    )
    .unwrap();
    let completed_path = write_completed_record_at(
        temp.path(),
        "expired-general",
        unix_time_ms().saturating_sub(minimum_age_ms + 1),
        "build-1",
    );
    for index in 0..(MAX_GENERAL_OPERATION_RECORDS - 1) {
        write_reserved_record_fixture(
            temp.path(),
            &format!("recovery-{index}"),
            "workspace-1",
            &format!("source-{index}"),
        );
    }

    let RecoveryReservationState::Pending(admitted) = reserve(
        temp.path(),
        identity("after-general-compaction", "workspace-1", "new-source"),
    )
    .unwrap() else {
        panic!("an expired general completion must make room for a new operation")
    };
    drop(admitted);
    assert!(!completed_path.exists());
}

#[test]
fn operation_capacity_preserves_a_fresh_completed_general_operation() {
    let temp = tempfile::tempdir().unwrap();
    let completed_path =
        write_completed_record_at(temp.path(), "fresh-general", unix_time_ms(), "build-1");
    for index in 0..(MAX_GENERAL_OPERATION_RECORDS - 1) {
        write_reserved_record_fixture(
            temp.path(),
            &format!("recovery-{index}"),
            "workspace-1",
            &format!("source-{index}"),
        );
    }

    assert_eq!(
        reserve(
            temp.path(),
            identity("blocked-by-fresh-general", "workspace-1", "new-source")
        )
        .unwrap_err(),
        "hmux_recovery_journal_capacity_exceeded: operation record limit reached (256/256)"
    );
    assert!(completed_path.exists());
}

#[test]
fn operation_capacity_never_compacts_a_busy_expired_general_operation() {
    let temp = tempfile::tempdir().unwrap();
    let minimum_age_ms = u64::try_from(
        RecoveryJournalGcPolicy::default()
            .minimum_completed_age
            .as_millis(),
    )
    .unwrap();
    let completed_path = write_completed_record_at(
        temp.path(),
        "busy-expired-general",
        unix_time_ms().saturating_sub(minimum_age_ms + 1),
        "build-1",
    );
    let directory = temp.path().join(".recovery");
    let held = RecoveryLock::acquire(
        open_private_lock(
            &directory.join(format!("operation_{}.lock", digest("busy-expired-general"))),
        )
        .unwrap(),
    )
    .unwrap();
    for index in 0..(MAX_GENERAL_OPERATION_RECORDS - 1) {
        write_reserved_record_fixture(
            temp.path(),
            &format!("recovery-{index}"),
            "workspace-1",
            &format!("source-{index}"),
        );
    }

    assert_eq!(
        reserve(
            temp.path(),
            identity("blocked-by-busy-general", "workspace-1", "new-source")
        )
        .unwrap_err(),
        "hmux_recovery_journal_capacity_exceeded: operation record limit reached (256/256)"
    );
    assert!(completed_path.exists());
    drop(held);
}

#[test]
fn operation_capacity_admission_is_serialized() {
    let temp = tempfile::tempdir().unwrap();
    for index in 0..(MAX_GENERAL_OPERATION_RECORDS - 1) {
        write_reserved_record_fixture(
            temp.path(),
            &format!("recovery-{index}"),
            "workspace-1",
            &format!("source-{index}"),
        );
    }
    let barrier = std::sync::Barrier::new(2);
    let admitted = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            barrier.wait();
            reserve(temp.path(), identity("last-a", "workspace-1", "source-a"))
        });
        let second = scope.spawn(|| {
            barrier.wait();
            reserve(temp.path(), identity("last-b", "workspace-1", "source-b"))
        });
        [first.join().unwrap(), second.join().unwrap()]
            .into_iter()
            .map(|result| match result {
                Ok(reservation) => {
                    drop(reservation);
                    true
                }
                Err(error) => {
                    assert_eq!(
                        error,
                        "hmux_recovery_journal_capacity_exceeded: operation record limit reached (256/256)"
                    );
                    false
                }
            })
            .filter(|was_admitted| *was_admitted)
            .count()
    });
    assert_eq!(admitted, 1);
    assert_eq!(
        inspect(temp.path()).unwrap().operation_records,
        MAX_GENERAL_OPERATION_RECORDS
    );
}

fn managed_stop_identity(index: usize) -> PreparedRecoveryIdentity {
    PreparedRecoveryIdentity {
        recovery_id: format!("managed-stop-{index}"),
        source_session_id: format!("managed-session-{index}"),
        source_workspace_id: "managed-workspace".into(),
        action: MANAGED_STOP_RECOVERY_ACTION,
        legacy_request_fingerprint: None,
    }
}

#[test]
fn managed_stop_and_general_recovery_capacity_are_isolated() {
    let general_full = tempfile::tempdir().unwrap();
    for index in 0..MAX_GENERAL_OPERATION_RECORDS {
        write_reserved_record_fixture(
            general_full.path(),
            &format!("general-{index}"),
            "workspace-1",
            &format!("source-{index}"),
        );
    }
    let RecoveryReservationState::Pending(stop) = reserve_prepared(
        general_full.path(),
        managed_stop_identity(0),
        Some("{}".into()),
    )
    .unwrap() else {
        panic!("managed stop must retain its dedicated slot pool")
    };
    drop(stop);

    let stop_full = tempfile::tempdir().unwrap();
    for index in 0..MAX_MANAGED_STOP_OPERATION_RECORDS {
        write_reserved_record_fixture_for_action(
            stop_full.path(),
            &format!("managed-stop-{index}"),
            "managed-workspace",
            &format!("managed-session-{index}"),
            MANAGED_STOP_RECOVERY_ACTION,
        );
    }
    let RecoveryReservationState::Pending(general) = reserve(
        stop_full.path(),
        identity("general-after-stop-burst", "workspace-1", "source-general"),
    )
    .unwrap() else {
        panic!("general recovery must retain its dedicated slot pool")
    };
    drop(general);
    assert_eq!(
        reserve_prepared(
            stop_full.path(),
            managed_stop_identity(MAX_MANAGED_STOP_OPERATION_RECORDS),
            Some("{}".into()),
        )
        .unwrap_err(),
        "hmux_recovery_managed_stop_capacity_exceeded: operation record limit reached (512/512)"
    );
}

#[test]
fn action_gc_removes_only_expired_completed_managed_stops() {
    let temp = tempfile::tempdir().unwrap();
    let retention = Duration::from_secs(7 * 24 * 60 * 60);
    let now = retention.as_millis() as u64 + 1_000;
    let expired = write_completed_record_for_action_at(
        temp.path(),
        "managed-expired",
        999,
        "build-stop",
        MANAGED_STOP_RECOVERY_ACTION,
    );
    let recent = write_completed_record_for_action_at(
        temp.path(),
        "managed-recent",
        1_001,
        "build-stop",
        MANAGED_STOP_RECOVERY_ACTION,
    );
    let general = write_completed_record_for_action_at(
        temp.path(),
        "general-expired",
        999,
        "build-general",
        TEST_ACTION,
    );
    let policy = RecoveryJournalGcPolicy {
        minimum_completed_age: retention,
        maximum_completed_records: 1,
        maximum_completed_bytes: u64::MAX,
        ..RecoveryJournalGcPolicy::default()
    };

    garbage_collect_completed_at(temp.path(), policy, now, Some(MANAGED_STOP_RECOVERY_ACTION))
        .unwrap();

    assert!(!expired.exists());
    assert!(recent.exists());
    assert!(general.exists());
}

#[test]
fn action_gc_low_water_counts_pending_records_and_reclaims_every_eligible_receipt() {
    let policy = RecoveryJournalGcPolicy {
        minimum_completed_age: Duration::ZERO,
        maximum_completed_records: 2,
        maximum_completed_bytes: u64::MAX,
        ..RecoveryJournalGcPolicy::default()
    };

    let mixed = tempfile::tempdir().unwrap();
    write_reserved_record_fixture_for_action(
        mixed.path(),
        "managed-pending",
        "managed-workspace",
        "managed-session-pending",
        MANAGED_STOP_RECOVERY_ACTION,
    );
    for index in 0..2 {
        write_completed_record_for_action_at(
            mixed.path(),
            &format!("managed-completed-{index}"),
            1,
            "build-stop",
            MANAGED_STOP_RECOVERY_ACTION,
        );
    }
    let mixed_report =
        garbage_collect_completed_at(mixed.path(), policy, 2, Some(MANAGED_STOP_RECOVERY_ACTION))
            .unwrap();
    assert_eq!(mixed_report.removed_completed_records, 1);
    assert_eq!(mixed_report.remaining.pending_records, 1);
    assert_eq!(mixed_report.remaining.completed_records, 1);

    let pending_dominates = tempfile::tempdir().unwrap();
    for index in 0..3 {
        write_reserved_record_fixture_for_action(
            pending_dominates.path(),
            &format!("managed-pending-{index}"),
            "managed-workspace",
            &format!("managed-session-pending-{index}"),
            MANAGED_STOP_RECOVERY_ACTION,
        );
    }
    for index in 0..2 {
        write_completed_record_for_action_at(
            pending_dominates.path(),
            &format!("managed-completed-{index}"),
            1,
            "build-stop",
            MANAGED_STOP_RECOVERY_ACTION,
        );
    }
    let pending_report = garbage_collect_completed_at(
        pending_dominates.path(),
        policy,
        2,
        Some(MANAGED_STOP_RECOVERY_ACTION),
    )
    .unwrap();
    assert_eq!(pending_report.removed_completed_records, 2);
    assert_eq!(pending_report.remaining.pending_records, 3);
    assert_eq!(pending_report.remaining.completed_records, 0);
}

#[test]
fn source_capacity_rejects_new_ids_but_reopens_existing_ids() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");
    ensure_private_directory(&directory).unwrap();
    for index in 0..MAX_SOURCE_LOCK_FILES {
        let source = digest(&format!("workspace-1\0source-{index}"));
        drop(open_private_lock(&directory.join(format!("source_{source}.lock"))).unwrap());
    }

    let existing = lock_source(temp.path(), "workspace-1", "source-0").unwrap();
    drop(existing);
    assert_eq!(
        lock_source(temp.path(), "workspace-1", "over-capacity").unwrap_err(),
        "hmux_recovery_source_capacity_exceeded: source lock limit reached"
    );
}

#[test]
fn journal_scan_refuses_allowed_name_flood_at_a_global_bound() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");
    ensure_private_directory(&directory).unwrap();
    let operation = digest("flood");
    for index in 0..=MAX_JOURNAL_SCAN_ENTRIES {
        let path = directory.join(format!(".gc-operation_{operation}-{index}.tmp"));
        drop(open_private_new(&path).unwrap());
    }

    assert_eq!(
        inspect(temp.path()).unwrap_err(),
        format!("hmux_recovery_journal_capacity: entry scan exceeds {MAX_JOURNAL_SCAN_ENTRIES}")
    );
}

#[test]
fn overflow_gc_reclaims_safe_temporaries_and_restores_reservation_admission() {
    let (temp, directory, operation) = prepare_overflow_fixture("recoverable-flood");
    assert_eq!(
        count_temporary_flood(&directory, &operation),
        MAX_JOURNAL_SCAN_ENTRIES + 1
    );

    let report = garbage_collect_completed(temp.path(), overflow_only_gc_policy()).unwrap();
    assert!(report.removed_temporary_files >= JOURNAL_OVERFLOW_HEADROOM);
    assert!(fs::read_dir(&directory).unwrap().count() <= JOURNAL_SCAN_LOW_WATER);

    let RecoveryReservationState::Pending(reservation) = reserve(
        temp.path(),
        identity("after-overflow", "workspace-1", "source-after-overflow"),
    )
    .unwrap() else {
        panic!("overflow recovery must restore new reservation admission")
    };
    assert!(!reservation.was_existing());
    drop(reservation);
}

#[test]
fn overflow_low_water_admits_two_source_locks_then_a_new_reservation() {
    let (temp, directory, _) = prepare_overflow_fixture("production-headroom");
    garbage_collect_completed(temp.path(), overflow_only_gc_policy()).unwrap();
    let mut entry_count = fs::read_dir(&directory).unwrap().count();
    assert_eq!(entry_count, JOURNAL_SCAN_LOW_WATER);

    let operation = digest("active-publications");
    for index in 0..MAX_OPERATION_RECORDS {
        let path = directory.join(format!(".gc-operation_{operation}-active-{index}.tmp"));
        drop(open_private_new(&path).unwrap());
    }
    entry_count += MAX_OPERATION_RECORDS;
    assert_eq!(entry_count, MAX_JOURNAL_SCAN_ENTRIES - 4);

    let recipe_lock = lock_source(temp.path(), "saved_recipe_v1", "session-name").unwrap();
    let source_lock = lock_source(temp.path(), "workspace-1", "source-1").unwrap();
    let RecoveryReservationState::Pending(reservation) = reserve(
        temp.path(),
        identity("production-order", "workspace-1", "source-1"),
    )
    .unwrap() else {
        panic!("source-lock to reservation ordering must remain within the scan bound")
    };

    assert_eq!(
        fs::read_dir(&directory).unwrap().count(),
        MAX_JOURNAL_SCAN_ENTRIES
    );
    assert_eq!(
        inspect(temp.path()).unwrap().operation_records,
        1,
        "the authoritative bounded inspector must remain usable"
    );

    let before_refusal = fs::read_dir(&directory).unwrap().count();
    assert_eq!(
        lock_source(temp.path(), "workspace-1", "next-source").unwrap_err(),
        "hmux_recovery_journal_capacity_exceeded: raw entry limit reached"
    );
    assert_eq!(fs::read_dir(&directory).unwrap().count(), before_refusal);
    assert_eq!(
        reserve(
            temp.path(),
            identity("next-operation", "workspace-1", "next-source")
        )
        .unwrap_err(),
        "hmux_recovery_journal_capacity_exceeded: raw entry limit reached"
    );
    assert_eq!(fs::read_dir(&directory).unwrap().count(), before_refusal);
    assert_eq!(inspect(temp.path()).unwrap().operation_records, 1);
    drop(reservation);
    drop(source_lock);
    drop(recipe_lock);

    let reopened_source = lock_source(temp.path(), "workspace-1", "source-1").unwrap();
    let RecoveryReservationState::Pending(reopened_reservation) = reserve(
        temp.path(),
        identity("production-order", "workspace-1", "source-1"),
    )
    .unwrap() else {
        panic!("existing source and reservation must reopen at the raw limit")
    };
    assert!(reopened_reservation.was_existing());
    assert_eq!(fs::read_dir(&directory).unwrap().count(), before_refusal);
    assert_eq!(inspect(temp.path()).unwrap().operation_records, 1);
    drop(reopened_reservation);
    drop(reopened_source);
}

#[test]
fn overflow_gc_reclaims_recordless_operation_and_unlocked_source_locks() {
    let source_temp = tempfile::tempdir().unwrap();
    let source_directory = source_temp.path().join(".recovery");
    ensure_private_directory(&source_directory).unwrap();
    drop(open_private_lock(&source_directory.join(ADMISSION_LOCK_NAME)).unwrap());
    for index in 0..=TEST_OVERFLOW_SCAN_CAPACITY.authoritative_entries {
        let source = digest(&format!("overflow-source-{index}"));
        drop(open_private_lock(&source_directory.join(format!("source_{source}.lock"))).unwrap());
    }
    let source_report = garbage_collect_completed_with_capacity(
        source_temp.path(),
        overflow_only_gc_policy(),
        TEST_OVERFLOW_SCAN_CAPACITY,
    )
    .unwrap();
    assert!(source_report.removed_source_locks > 0);
    assert!(
        fs::read_dir(&source_directory).unwrap().count()
            <= TEST_OVERFLOW_SCAN_CAPACITY.low_water_entries
    );

    let operation_temp = tempfile::tempdir().unwrap();
    let operation_directory = operation_temp.path().join(".recovery");
    ensure_private_directory(&operation_directory).unwrap();
    drop(open_private_lock(&operation_directory.join(ADMISSION_LOCK_NAME)).unwrap());
    for index in 0..=TEST_OVERFLOW_SCAN_CAPACITY.authoritative_entries {
        let operation = digest(&format!("overflow-operation-{index}"));
        drop(
            open_private_lock(&operation_directory.join(format!("operation_{operation}.lock")))
                .unwrap(),
        );
    }
    let operation_report = garbage_collect_completed_with_capacity(
        operation_temp.path(),
        overflow_only_gc_policy(),
        TEST_OVERFLOW_SCAN_CAPACITY,
    )
    .unwrap();
    assert!(operation_report.removed_orphan_operation_locks > 0);
    assert!(
        fs::read_dir(&operation_directory).unwrap().count()
            <= TEST_OVERFLOW_SCAN_CAPACITY.low_water_entries
    );
}

#[test]
fn overflow_gc_unknown_entry_fails_before_deleting_safe_temporaries() {
    let (temp, directory, operation) =
        prepare_overflow_fixture_with_capacity("unknown-flood", TEST_OVERFLOW_SCAN_CAPACITY);
    let unknown = directory.join("unexpected");
    drop(open_private_new(&unknown).unwrap());
    let before = count_temporary_flood(&directory, &operation);

    assert_eq!(
        garbage_collect_completed_with_capacity(
            temp.path(),
            overflow_only_gc_policy(),
            TEST_OVERFLOW_SCAN_CAPACITY,
        )
        .unwrap_err(),
        "hmux_recovery_journal_invalid: unexpected journal entry unexpected"
    );
    assert_eq!(count_temporary_flood(&directory, &operation), before);
    assert!(unknown.exists());
}

#[cfg(unix)]
#[test]
fn overflow_gc_symlink_fails_before_deleting_safe_temporaries() {
    use std::os::unix::fs::symlink;

    let (temp, directory, operation) =
        prepare_overflow_fixture_with_capacity("symlink-flood", TEST_OVERFLOW_SCAN_CAPACITY);
    let target = temp.path().join("external-target");
    drop(open_private_new(&target).unwrap());
    let linked = directory.join(format!(
        ".gc-operation_{}-linked.tmp",
        digest("linked-overflow")
    ));
    symlink(&target, &linked).unwrap();
    let before = count_temporary_flood(&directory, &operation);

    assert_eq!(
        garbage_collect_completed_with_capacity(
            temp.path(),
            overflow_only_gc_policy(),
            TEST_OVERFLOW_SCAN_CAPACITY,
        )
        .unwrap_err(),
        "hmux_recovery_journal_invalid: file is not private"
    );
    assert_eq!(count_temporary_flood(&directory, &operation), before);
    assert!(
        fs::symlink_metadata(&linked)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(target.exists());
}

#[cfg(unix)]
#[test]
fn overflow_gc_wrong_mode_fails_before_deleting_safe_temporaries() {
    use std::os::unix::fs::PermissionsExt;

    let (temp, directory, operation) =
        prepare_overflow_fixture_with_capacity("wrong-mode-flood", TEST_OVERFLOW_SCAN_CAPACITY);
    let wrong_mode = directory.join(format!(
        ".gc-operation_{}-wrong-mode.tmp",
        digest("wrong-mode-overflow")
    ));
    drop(open_private_new(&wrong_mode).unwrap());
    fs::set_permissions(&wrong_mode, fs::Permissions::from_mode(0o644)).unwrap();
    let before = count_temporary_flood(&directory, &operation);

    assert_eq!(
        garbage_collect_completed_with_capacity(
            temp.path(),
            overflow_only_gc_policy(),
            TEST_OVERFLOW_SCAN_CAPACITY,
        )
        .unwrap_err(),
        "hmux_recovery_journal_invalid: file is not private"
    );
    assert_eq!(count_temporary_flood(&directory, &operation), before);
    assert!(wrong_mode.exists());
}

#[test]
fn overflow_recovery_rejects_a_candidate_replaced_after_validation() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");
    ensure_private_directory(&directory).unwrap();
    let operation = digest("replaced-overflow-candidate");
    let path = directory.join(format!(".gc-operation_{operation}-replaced.tmp"));
    drop(open_private_new(&path).unwrap());
    let planned = scan_journal_bounded(
        &directory,
        JournalRecordScan::RetainThrough(0),
        MAX_JOURNAL_OVERFLOW_SCAN_ENTRIES,
        "overflow recovery scan",
    )
    .unwrap()
    .pop()
    .unwrap();
    fs::rename(&path, temp.path().join("held-original")).unwrap();
    drop(open_private_new(&path).unwrap());
    let replacement = open_private_existing(&path, "temporary record").unwrap();

    assert_eq!(
        ensure_planned_open_file(&planned, &replacement).unwrap_err(),
        "hmux_recovery_journal_invalid: file changed during overflow recovery"
    );
    assert!(path.exists());
}

#[test]
fn overflow_gc_preserves_active_pending_and_completed_semantic_state() {
    let temp = tempfile::tempdir().unwrap();
    let pending_id = "pending-overflow";
    let RecoveryReservationState::Pending(pending) = reserve(
        temp.path(),
        identity(pending_id, "workspace-1", "pending-source"),
    )
    .unwrap() else {
        panic!("pending overflow fixture must reserve")
    };
    let completed_id = "completed-overflow";
    drop(complete_reservation(temp.path(), completed_id));

    let directory = temp.path().join(".recovery");
    let pending_digest = digest(pending_id);
    let pending_record = directory.join(format!("operation_{pending_digest}.json"));
    let completed_digest = digest(completed_id);
    let completed_record = directory.join(format!("operation_{completed_digest}.json"));
    let pending_lock = directory.join(format!("operation_{pending_digest}.lock"));
    let completed_lock = directory.join(format!("operation_{completed_digest}.lock"));
    let pending_before = fs::read(&pending_record).unwrap();
    let completed_before = fs::read(&completed_record).unwrap();
    let active_temporary = directory.join(format!(".operation_{pending_digest}-active.tmp"));
    drop(open_private_new(&active_temporary).unwrap());
    create_orphan_temporary_flood_with_count(
        &directory,
        "semantic-flood",
        TEST_SEMANTIC_OVERFLOW_SCAN_CAPACITY.authoritative_entries + 1,
    );

    let report = garbage_collect_completed_with_capacity(
        temp.path(),
        overflow_only_gc_policy(),
        TEST_SEMANTIC_OVERFLOW_SCAN_CAPACITY,
    )
    .unwrap();
    assert!(report.removed_temporary_files > 0);
    assert_eq!(fs::read(&pending_record).unwrap(), pending_before);
    assert_eq!(fs::read(&completed_record).unwrap(), completed_before);
    assert!(pending_lock.exists());
    assert!(completed_lock.exists());
    assert!(active_temporary.exists());
    assert_eq!(report.remaining.pending_records, 1);
    assert_eq!(report.remaining.completed_records, 1);
    assert_eq!(report.remaining.operation_records, 2);
    drop(pending);
}

#[test]
fn inspection_fails_closed_on_malformed_records_and_symlinks() {
    let malformed = tempfile::tempdir().unwrap();
    let directory = malformed.path().join(".recovery");
    ensure_private_directory(&directory).unwrap();
    let path = directory.join(format!("operation_{}.json", digest("malformed")));
    let mut file = open_private_new(&path).unwrap();
    file.write_all(b"{").unwrap();
    drop(file);
    assert_eq!(
        inspect(malformed.path()).unwrap_err(),
        "hmux_recovery_journal_invalid: record is malformed"
    );

    let mismatched = tempfile::tempdir().unwrap();
    write_reserved_record_fixture(
        mismatched.path(),
        "record-identity",
        "workspace-1",
        "source-1",
    );
    let directory = mismatched.path().join(".recovery");
    let original = directory.join(format!("operation_{}.json", digest("record-identity")));
    let wrong_path = directory.join(format!("operation_{}.json", digest("wrong-identity")));
    fs::rename(original, wrong_path).unwrap();
    assert_eq!(
        inspect(mismatched.path()).unwrap_err(),
        "hmux_recovery_journal_invalid: record identity does not match its path"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        let linked = tempfile::tempdir().unwrap();
        let directory = linked.path().join(".recovery");
        ensure_private_directory(&directory).unwrap();
        let target = linked.path().join("target");
        drop(open_private_new(&target).unwrap());
        let record_path = directory.join(format!("operation_{}.json", digest("symlink-record")));
        symlink(&target, &record_path).unwrap();
        assert_eq!(
            reserve(
                linked.path(),
                identity("symlink-record", "workspace-1", "source-1")
            )
            .unwrap_err(),
            "hmux_recovery_journal_invalid: file is not private"
        );

        let source = digest("workspace-1\0symlink-source");
        let source_path = directory.join(format!("source_{source}.lock"));
        symlink(&target, source_path).unwrap();
        assert_eq!(
            lock_source(linked.path(), "workspace-1", "symlink-source").unwrap_err(),
            "hmux_recovery_journal_invalid: file is not private"
        );
    }
}

#[test]
fn inspection_reports_pending_sources_and_accepts_the_admission_lock() {
    let temp = tempfile::tempdir().unwrap();
    write_reserved_record_fixture(temp.path(), "pending-1", "workspace-1", "source-1");
    write_reserved_record_fixture(temp.path(), "pending-2", "workspace-1", "source-1");
    drop(complete_reservation(temp.path(), "completed-1"));

    let inspection = inspect(temp.path()).unwrap();
    assert_eq!(inspection.operation_records, 3);
    assert_eq!(inspection.pending_records, 2);
    assert_eq!(inspection.completed_records, 1);
    assert_eq!(
        inspection.pending_sources,
        BTreeSet::from([PendingRecoverySource {
            workspace_id: "workspace-1".into(),
            session_id: "source-1".into(),
        }])
    );
    assert!(inspection.operation_record_bytes > 0);
    assert!(inspection.total_bytes >= inspection.operation_record_bytes);
}

#[test]
fn preview_is_lock_free_and_matches_unchanged_authoritative_apply() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");
    write_completed_record(temp.path(), "completed-preview");
    fs::remove_file(directory.join(ADMISSION_LOCK_NAME)).unwrap();

    let source_lock = directory.join(format!("source_{}.lock", digest("source-preview")));
    drop(open_private_lock(&source_lock).unwrap());
    let operation_digest = digest("orphan-preview");
    let operation_lock = directory.join(format!("operation_{operation_digest}.lock"));
    drop(open_private_lock(&operation_lock).unwrap());
    let temporary = directory.join(format!(".operation_{operation_digest}-1-1.tmp"));
    drop(open_private_new(&temporary).unwrap());
    let before = journal_entry_names(temp.path());
    assert!(!before.iter().any(|name| name == ADMISSION_LOCK_NAME));

    let preview = preview_garbage_collect_completed(temp.path(), aggressive_gc_policy()).unwrap();
    let after_preview = journal_entry_names(temp.path());

    assert_eq!(after_preview, before);
    assert!(!directory.join(ADMISSION_LOCK_NAME).exists());
    assert_eq!(preview.planned_completed_records, 1);
    assert!(preview.planned_completed_bytes > 0);
    assert_eq!(preview.planned_source_locks, 1);
    assert_eq!(preview.planned_orphan_operation_locks, 1);
    assert_eq!(preview.planned_temporary_files, 1);
    assert_eq!(preview.removed_completed_records, 0);
    assert_eq!(preview.removed_source_locks, 0);
    assert_eq!(preview.removed_orphan_operation_locks, 0);
    assert_eq!(preview.removed_temporary_files, 0);

    let applied = garbage_collect_completed(temp.path(), aggressive_gc_policy()).unwrap();

    assert_eq!(
        applied.planned_completed_records,
        preview.planned_completed_records
    );
    assert_eq!(
        applied.planned_completed_bytes,
        preview.planned_completed_bytes
    );
    assert_eq!(applied.planned_source_locks, preview.planned_source_locks);
    assert_eq!(
        applied.planned_orphan_operation_locks,
        preview.planned_orphan_operation_locks
    );
    assert_eq!(
        applied.planned_temporary_files,
        preview.planned_temporary_files
    );
    assert_eq!(
        applied.removed_completed_records,
        preview.planned_completed_records
    );
    assert_eq!(
        applied.removed_completed_bytes,
        preview.planned_completed_bytes
    );
    assert_eq!(applied.removed_source_locks, preview.planned_source_locks);
    assert_eq!(
        applied.removed_orphan_operation_locks,
        preview.planned_orphan_operation_locks
    );
    assert_eq!(
        applied.removed_temporary_files,
        preview.planned_temporary_files
    );
    assert!(!source_lock.exists());
    assert!(!operation_lock.exists());
    assert!(!temporary.exists());
}

#[test]
fn completed_gc_never_deletes_pending_and_skips_busy_operations() {
    let temp = tempfile::tempdir().unwrap();
    write_reserved_record_fixture(temp.path(), "pending-1", "workspace-1", "source-1");
    drop(complete_reservation(temp.path(), "completed-idle"));
    let busy = complete_reservation(temp.path(), "completed-busy");

    let first = garbage_collect_completed(temp.path(), aggressive_gc_policy()).unwrap();
    assert_eq!(first.planned_completed_records, 2);
    assert_eq!(first.removed_completed_records, 1);
    assert_eq!(first.busy_entries, 1);
    assert_eq!(first.remaining.pending_records, 1);
    assert_eq!(first.remaining.completed_records, 1);
    assert_eq!(first.remaining.operation_records, 2);
    assert!(
        temp.path()
            .join(".recovery")
            .join(format!("operation_{}.json", digest("pending-1")))
            .exists()
    );

    drop(busy);
    let second = garbage_collect_completed(temp.path(), aggressive_gc_policy()).unwrap();
    assert_eq!(second.planned_completed_records, 1);
    assert_eq!(second.removed_completed_records, 1);
    assert_eq!(second.remaining.pending_records, 1);
    assert_eq!(second.remaining.completed_records, 0);
    assert_eq!(second.remaining.operation_records, 1);
}

#[test]
fn standalone_create_outcomes_survive_compaction_and_gc_until_acknowledged() {
    let temp = tempfile::tempdir().unwrap();
    let protected = write_completed_record_for_action_at(
        temp.path(),
        "standalone-create",
        1,
        "build-standalone",
        STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
    );
    let ordinary = write_completed_record_at(temp.path(), "ordinary", 1, "build-ordinary");
    let terminal = write_completed_record_for_action_at(
        temp.path(),
        "standalone-refused",
        1,
        "not-created",
        STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
    );
    let directory = temp.path().join(".recovery");
    let mut terminal_record = read_record(&terminal).unwrap();
    let RecoveryRecordState::Completed { outcome, .. } = &mut terminal_record.state else {
        panic!("fixture must be completed")
    };
    *outcome = "failed_hmux_test".into();
    write_record(&directory, &terminal, &terminal_record).unwrap();
    let terminal_identity = RecoveryIdentity {
        recovery_id: terminal_record.recovery_id.clone(),
        source_session_id: terminal_record.source_session_id.clone(),
        source_workspace_id: terminal_record.source_workspace_id.clone(),
        request_fingerprint: terminal_record.request_fingerprint.clone(),
        action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
    };
    // The age fixture writes only the record. Open it through real admission
    // before exercising acknowledgement, which never manufactures a lock.
    assert!(matches!(
        reserve(temp.path(), terminal_identity.clone()).unwrap(),
        RecoveryReservationState::Completed(_)
    ));

    let entries = scan_journal(&directory, true).unwrap();
    assert_eq!(
        compact_completed_operations_for_admission(&directory, &entries, 2).unwrap(),
        1
    );
    assert!(protected.exists());
    assert!(!ordinary.exists());
    assert!(terminal.exists());

    let report = garbage_collect_completed(temp.path(), aggressive_gc_policy()).unwrap();
    assert_eq!(report.planned_completed_records, 0);
    assert_eq!(report.removed_completed_records, 0);
    assert!(protected.exists());
    assert_eq!(report.remaining.completed_records, 2);
    let completion = completed_from_record(&terminal_record).unwrap();
    assert_eq!(
        acknowledge_completion(temp.path(), &terminal_identity, &completion).unwrap(),
        RecoveryCompletionAcknowledgement::Acknowledged
    );
    assert!(!terminal.exists());
    assert!(protected.exists());
    assert_eq!(
        acknowledge_completion(temp.path(), &terminal_identity, &completion).unwrap(),
        RecoveryCompletionAcknowledgement::AlreadyAcknowledged
    );
    assert!(
        reserve(temp.path(), terminal_identity)
            .err()
            .unwrap()
            .starts_with(RECOVERY_COMPLETION_ACKNOWLEDGED_CODE)
    );
}

#[test]
fn completion_acknowledgement_is_non_creating_idempotent_and_exact() {
    let absent = tempfile::tempdir().unwrap();
    let mut recovery_identity = identity("standalone-ack", "workspace-1", "source-1");
    recovery_identity.action = STANDALONE_CREATE_OPERATION_RECOVERY_ACTION;
    let completion = RecoveryCompletion {
        target_session_id: "target-standalone-ack".into(),
        target_workspace_id: "workspace-1".into(),
        target_build_id: "build-standalone".into(),
        action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION.into(),
        outcome: STANDALONE_CREATE_OPERATION_COMPLETION_OUTCOME.into(),
        resume_checkpoint: None,
        operation_checkpoint: None,
    };
    assert_eq!(
        read_completed_existing(absent.path(), &recovery_identity).unwrap(),
        RecoveryCompletionLookup::Absent
    );
    assert_eq!(
        acknowledge_completion(absent.path(), &recovery_identity, &completion).unwrap(),
        RecoveryCompletionAcknowledgement::Absent
    );
    assert!(!absent.path().join(".recovery").exists());

    let state = tempfile::tempdir().unwrap();
    let RecoveryReservationState::Pending(pending) =
        reserve(state.path(), recovery_identity.clone()).unwrap()
    else {
        panic!("new operation must be pending")
    };
    drop(pending);
    let operation_digest = digest(&recovery_identity.recovery_id);
    let directory = state.path().join(".recovery");
    let record_path = directory.join(format!("operation_{operation_digest}.json"));
    let lock_path = directory.join(format!("operation_{operation_digest}.lock"));
    assert!(read_completed_existing(state.path(), &recovery_identity).is_err());
    assert!(acknowledge_completion(state.path(), &recovery_identity, &completion).is_err());
    assert!(record_path.exists());
    assert!(lock_path.exists());

    let RecoveryReservationState::Pending(mut pending) =
        reserve(state.path(), recovery_identity.clone()).unwrap()
    else {
        panic!("pending operation must reopen")
    };
    pending.complete(completion.clone()).unwrap();
    drop(pending);
    assert_eq!(
        read_completed_existing(state.path(), &recovery_identity).unwrap(),
        RecoveryCompletionLookup::Completed(Box::new(completion.clone()))
    );
    let mut mismatched = completion.clone();
    mismatched.target_build_id = "different-build".into();
    assert!(acknowledge_completion(state.path(), &recovery_identity, &mismatched).is_err());
    let mut mismatched_identity = recovery_identity.clone();
    mismatched_identity.source_session_id = "another-source".into();
    assert!(acknowledge_completion(state.path(), &mismatched_identity, &completion).is_err());
    assert!(record_path.exists());
    assert!(lock_path.exists());

    completion_acknowledgement::publish(&directory, &recovery_identity).unwrap();
    let acknowledgement_directory = directory.join(completion_acknowledgement::DIRECTORY_NAME);
    assert_eq!(fs::read_dir(acknowledgement_directory).unwrap().count(), 1);
    assert_eq!(
        reserve(state.path(), recovery_identity.clone()).unwrap_err(),
        format!("{RECOVERY_COMPLETION_ACKNOWLEDGED_CODE}: operation completion was acknowledged"),
        "the durable fence must stop an original create after publication"
    );
    assert!(record_path.exists(), "the simulated crash keeps the record");
    assert!(lock_path.exists(), "the simulated crash keeps the lock");

    assert_eq!(
        acknowledge_completion(state.path(), &recovery_identity, &completion).unwrap(),
        RecoveryCompletionAcknowledgement::Acknowledged
    );
    assert!(!record_path.exists());
    assert!(!lock_path.exists());
    let entries_after_ack = journal_entry_names(state.path());
    assert_eq!(
        read_completed_existing(state.path(), &recovery_identity).unwrap(),
        RecoveryCompletionLookup::Acknowledged
    );
    assert_eq!(
        acknowledge_completion(state.path(), &recovery_identity, &completion).unwrap(),
        RecoveryCompletionAcknowledgement::AlreadyAcknowledged
    );
    assert_eq!(journal_entry_names(state.path()), entries_after_ack);
    assert_eq!(
        reserve(state.path(), recovery_identity.clone()).unwrap_err(),
        format!("{RECOVERY_COMPLETION_ACKNOWLEDGED_CODE}: operation completion was acknowledged")
    );
    let mut changed_after_ack = recovery_identity.clone();
    changed_after_ack.request_fingerprint = request_fingerprint(&["changed-after-ack"]);
    assert_eq!(
        reserve(state.path(), changed_after_ack).unwrap_err(),
        "hmux_recovery_idempotency_conflict: recovery id belongs to another request"
    );
    assert_eq!(
        scan_journal_bounded(
            &directory,
            JournalRecordScan::Skip,
            1,
            "acknowledgement isolation test",
        )
        .unwrap()
        .len(),
        1,
        "the acknowledgement directory must not consume root scan capacity"
    );
}

#[test]
fn completion_acknowledgement_serializes_absence_with_reservation_publication() {
    let state = tempfile::tempdir().unwrap();
    let directory = state.path().join(".recovery");
    ensure_private_directory(&directory).unwrap();
    let admission = acquire_admission_lock(&directory).unwrap();
    let mut recovery_identity = identity("standalone-ack-race", "workspace-1", "source-1");
    recovery_identity.action = STANDALONE_CREATE_OPERATION_RECOVERY_ACTION;
    let completion = RecoveryCompletion {
        target_session_id: "target-standalone-ack-race".into(),
        target_workspace_id: "workspace-1".into(),
        target_build_id: "build-standalone".into(),
        action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION.into(),
        outcome: STANDALONE_CREATE_OPERATION_COMPLETION_OUTCOME.into(),
        resume_checkpoint: None,
        operation_checkpoint: None,
    };
    let digest = digest(&recovery_identity.recovery_id);
    let lock_path = directory.join(format!("operation_{digest}.lock"));
    let record_path = directory.join(format!("operation_{digest}.json"));
    let record = RecoveryRecord {
        schema_version: RECOVERY_SCHEMA_VERSION,
        recovery_id: recovery_identity.recovery_id.clone(),
        source_session_id: recovery_identity.source_session_id.clone(),
        source_workspace_id: recovery_identity.source_workspace_id.clone(),
        request_fingerprint: recovery_identity.request_fingerprint.clone(),
        action: recovery_identity.action.into(),
        created_unix_ms: unix_time_ms(),
        state: RecoveryRecordState::Reserved {
            resume_checkpoint: None,
            operation_checkpoint: None,
        },
    };
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (completed_tx, completed_rx) = std::sync::mpsc::channel();

    std::thread::scope(|scope| {
        let acknowledgement = scope.spawn(|| {
            started_tx.send(()).unwrap();
            completed_tx
                .send(acknowledge_completion(
                    state.path(),
                    &recovery_identity,
                    &completion,
                ))
                .unwrap();
        });
        started_rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            completed_rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty),
            "acknowledgement concluded absence outside admission authority"
        );

        let operation_lock = RecoveryLock::acquire(open_private_lock(&lock_path).unwrap()).unwrap();
        write_record_admitted(&admission, &directory, &record_path, &record).unwrap();
        drop(operation_lock);
        drop(admission);

        assert!(
            completed_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("acknowledgement did not resume after admission")
                .is_err(),
            "a concurrent Reserved record was mistaken for acknowledged absence"
        );
        acknowledgement.join().unwrap();
    });
    assert!(record_path.exists());
    assert!(lock_path.exists());
}

#[test]
fn acknowledged_standalone_completion_reclaims_operation_capacity() {
    let temp = tempfile::tempdir().unwrap();
    let mut recovery_identity = identity("standalone-ack", "workspace-1", "source-ack");
    recovery_identity.action = STANDALONE_CREATE_OPERATION_RECOVERY_ACTION;
    let completion = RecoveryCompletion {
        target_session_id: "target-standalone-ack".into(),
        target_workspace_id: "workspace-1".into(),
        target_build_id: "build-standalone".into(),
        action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION.into(),
        outcome: STANDALONE_CREATE_OPERATION_COMPLETION_OUTCOME.into(),
        resume_checkpoint: None,
        operation_checkpoint: None,
    };
    let RecoveryReservationState::Pending(mut pending) =
        reserve(temp.path(), recovery_identity.clone()).unwrap()
    else {
        panic!("new operation must be pending")
    };
    pending.complete(completion.clone()).unwrap();
    drop(pending);
    for index in 0..(MAX_GENERAL_OPERATION_RECORDS - 1) {
        write_reserved_record_fixture(
            temp.path(),
            &format!("capacity-{index}"),
            "workspace-1",
            &format!("source-{index}"),
        );
    }
    assert_eq!(
        reserve(
            temp.path(),
            identity("blocked-before-ack", "workspace-1", "new-source")
        )
        .unwrap_err(),
        "hmux_recovery_journal_capacity_exceeded: operation record limit reached (256/256)"
    );

    assert_eq!(
        acknowledge_completion(temp.path(), &recovery_identity, &completion).unwrap(),
        RecoveryCompletionAcknowledgement::Acknowledged
    );
    let RecoveryReservationState::Pending(admitted) = reserve(
        temp.path(),
        identity("admitted-after-ack", "workspace-1", "new-source"),
    )
    .unwrap() else {
        panic!("acknowledgement must reclaim one operation slot")
    };
    drop(admitted);
}

#[test]
fn acknowledgement_reclaims_each_exact_idle_source_lock_without_split_ownership() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");
    ensure_private_directory(&directory).unwrap();
    for index in 0..(MAX_SOURCE_LOCK_FILES - 1) {
        let path = source_lock_path(
            &directory,
            "retained-workspace",
            &format!("retained-{index}"),
        );
        drop(open_private_lock(&path).unwrap());
    }

    for index in 0..2 {
        let session_name = format!("request-bound-{index}");
        let source = PendingRecoverySource {
            workspace_id: SAVED_RECIPE_RECOVERY_NAMESPACE.into(),
            session_id: session_name.clone(),
        };
        let source_lock =
            lock_source(temp.path(), &source.workspace_id, &source.session_id).unwrap();
        let mut recovery_identity = identity(
            &format!("standalone-cycle-{index}"),
            "workspace-1",
            &format!("source-{index}"),
        );
        recovery_identity.action = STANDALONE_CREATE_OPERATION_RECOVERY_ACTION;
        let completion = RecoveryCompletion {
            target_session_id: format!("target-{index}"),
            target_workspace_id: "workspace-1".into(),
            target_build_id: "build-standalone".into(),
            action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION.into(),
            outcome: STANDALONE_CREATE_OPERATION_COMPLETION_OUTCOME.into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        };
        let RecoveryReservationState::Pending(mut pending) =
            reserve(temp.path(), recovery_identity.clone()).unwrap()
        else {
            panic!("new operation must be pending")
        };
        pending.complete(completion.clone()).unwrap();
        drop(pending);

        assert_eq!(
            acknowledge_completion_releasing_source(
                temp.path(),
                &recovery_identity,
                &completion,
                &source,
            )
            .unwrap_err(),
            "hmux_recovery_source_busy: completion source is still active"
        );
        drop(source_lock);
        assert_eq!(
            acknowledge_completion_releasing_source(
                temp.path(),
                &recovery_identity,
                &completion,
                &source,
            )
            .unwrap(),
            RecoveryCompletionAcknowledgement::Acknowledged
        );
    }

    let inspection = inspect(temp.path()).unwrap();
    assert_eq!(inspection.source_lock_files, MAX_SOURCE_LOCK_FILES - 1);
    assert_eq!(inspection.operation_records, 0);
}

#[test]
fn busy_large_completed_candidate_does_not_expand_apply_beyond_preview_scope() {
    let temp = tempfile::tempdir().unwrap();
    let large_path =
        write_completed_record_at(temp.path(), "completed-large", 100, &"x".repeat(3_000));
    let small_b_path = write_completed_record_at(temp.path(), "completed-small-b", 200, "small-b");
    let small_c_path = write_completed_record_at(temp.path(), "completed-small-c", 300, "small-c");
    let large_bytes = fs::metadata(&large_path).unwrap().len();
    let completed_bytes = [large_path.as_path(), &small_b_path, &small_c_path]
        .into_iter()
        .map(|path| fs::metadata(path).unwrap().len())
        .sum::<u64>();
    let directory = temp.path().join(".recovery");
    let large_lock_path = directory.join(format!("operation_{}.lock", digest("completed-large")));
    let busy_large = RecoveryLock::acquire(open_private_lock(&large_lock_path).unwrap()).unwrap();
    let policy = RecoveryJournalGcPolicy {
        minimum_completed_age: Duration::ZERO,
        maximum_completed_records: usize::MAX,
        maximum_completed_bytes: completed_bytes.saturating_sub(large_bytes),
        minimum_orphan_age: Duration::ZERO,
        maximum_source_lock_files: usize::MAX,
        maximum_orphan_operation_locks: usize::MAX,
        maximum_temporary_files: usize::MAX,
    };

    let preview = preview_garbage_collect_completed(temp.path(), policy).unwrap();
    assert_eq!(preview.planned_completed_records, 1);
    assert_eq!(preview.planned_completed_bytes, large_bytes);

    let blocked = garbage_collect_completed(temp.path(), policy).unwrap();
    assert_eq!(blocked.planned_completed_records, 1);
    assert_eq!(blocked.removed_completed_records, 0);
    assert_eq!(blocked.busy_entries, 1);
    assert!(large_path.exists());
    assert!(small_b_path.exists());
    assert!(small_c_path.exists());

    drop(busy_large);
    let retried = garbage_collect_completed(temp.path(), policy).unwrap();
    assert_eq!(retried.planned_completed_records, 1);
    assert_eq!(retried.removed_completed_records, 1);
    assert_eq!(retried.removed_completed_bytes, large_bytes);
    assert!(!large_path.exists());
    assert!(small_b_path.exists());
    assert!(small_c_path.exists());
}

#[test]
fn orphan_gc_bounds_lock_and_temporary_retention_without_touching_busy_entries() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".recovery");
    ensure_private_directory(&directory).unwrap();

    let source_busy_path = directory.join(format!("source_{}.lock", digest("source-busy")));
    let source_busy = RecoveryLock::acquire(open_private_lock(&source_busy_path).unwrap()).unwrap();
    let source_idle_path = directory.join(format!("source_{}.lock", digest("source-idle")));
    drop(open_private_lock(&source_idle_path).unwrap());

    let busy_digest = digest("operation-busy");
    let operation_busy_path = directory.join(format!("operation_{busy_digest}.lock"));
    let operation_busy =
        RecoveryLock::acquire(open_private_lock(&operation_busy_path).unwrap()).unwrap();
    let idle_digest = digest("operation-idle");
    let operation_idle_path = directory.join(format!("operation_{idle_digest}.lock"));
    drop(open_private_lock(&operation_idle_path).unwrap());

    let busy_temporary = directory.join(format!(".operation_{busy_digest}-1-1.tmp"));
    drop(open_private_new(&busy_temporary).unwrap());
    let idle_temporary = directory.join(format!(".operation_{idle_digest}-1-1.tmp"));
    drop(open_private_new(&idle_temporary).unwrap());

    let report = garbage_collect_completed(temp.path(), aggressive_gc_policy()).unwrap();
    assert_eq!(report.planned_source_locks, 2);
    assert_eq!(report.planned_orphan_operation_locks, 2);
    assert_eq!(report.planned_temporary_files, 2);
    assert_eq!(report.removed_source_locks, 1);
    assert_eq!(report.removed_orphan_operation_locks, 1);
    assert_eq!(report.removed_temporary_files, 1);
    assert_eq!(report.busy_entries, 3);
    assert!(source_busy_path.exists());
    assert!(operation_busy_path.exists());
    assert!(busy_temporary.exists());
    assert!(!source_idle_path.exists());
    assert!(!operation_idle_path.exists());
    assert!(!idle_temporary.exists());

    drop(source_busy);
    drop(operation_busy);
}

#[test]
fn recovery_source_busy_inspection_does_not_publish_and_fails_closed() {
    let empty = tempfile::tempdir().unwrap();
    assert!(!recovery_sources_busy(empty.path()).unwrap());
    assert!(!empty.path().join(".recovery").exists());

    let temp = tempfile::tempdir().unwrap();
    let held = lock_source(temp.path(), "workspace-1", "source-1").unwrap();
    assert!(recovery_sources_busy(temp.path()).unwrap());
    assert_eq!(
        inspect_recovery_source_locks(temp.path()).unwrap(),
        RecoverySourceLockInspection {
            schema_version: 1,
            present_source_locks: 1,
            busy_source_locks: 1,
            idle_source_locks: 0,
        }
    );
    drop(held);
    assert!(!recovery_sources_busy(temp.path()).unwrap());
    assert_eq!(
        inspect_recovery_source_locks(temp.path()).unwrap(),
        RecoverySourceLockInspection {
            schema_version: 1,
            present_source_locks: 1,
            busy_source_locks: 0,
            idle_source_locks: 1,
        }
    );

    let unknown = temp.path().join(".recovery").join("unexpected");
    drop(open_private_new(&unknown).unwrap());
    assert_eq!(
        recovery_sources_busy(temp.path()).unwrap_err(),
        "hmux_recovery_journal_invalid: unexpected journal entry unexpected"
    );
}

#[test]
fn compacted_successor_index_resolves_256_edges_through_max_u64() {
    let temp = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let recovery = temp.path().join(".recovery");
    ensure_private_directory(&recovery).unwrap();
    for index in 0..256_u64 {
        let source = format!("session-{index}");
        let replacement = format!("session-{}", index + 1);
        let source_epoch = index + 1;
        let replacement_epoch = if index == 255 { u64::MAX } else { index + 2 };
        let edge = direct_rehost_resolution(
            temp.path(),
            &format!("operation-{index}"),
            &source,
            &replacement,
            source_epoch,
            replacement_epoch,
        );
        managed_rehost_successor_index::publish(&recovery, &edge).unwrap();
    }

    let ManagedRehostResolutionLookup::Resolved(resolution) =
        resolve_managed_rehost_current(temp.path(), "workspace-successors", "session-0").unwrap()
    else {
        panic!("the oldest addressable source must retain its compacted chain")
    };
    assert_eq!(resolution.operation_ids().len(), 256);
    assert_eq!(resolution.current_generation().session_id(), "session-256");
    assert_eq!(
        resolution.current_generation().channel_epoch(),
        u64::MAX.to_string()
    );
}

#[test]
fn compacted_multi_hop_resolution_returns_the_final_launch_identity() {
    let temp = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let recovery = temp.path().join(".recovery");
    ensure_private_directory(&recovery).unwrap();
    let first = direct_rehost_resolution_with_launch_identity(
        temp.path(),
        "a-to-b",
        "a",
        "b",
        1,
        2,
        Some(
            ManagedRehostLaunchIdentity::new(
                Some("credential-a".into()),
                Some("conversation-a".into()),
            )
            .unwrap(),
        ),
    );
    let second = direct_rehost_resolution_with_launch_identity(
        temp.path(),
        "b-to-c",
        "b",
        "c",
        2,
        3,
        Some(ManagedRehostLaunchIdentity::new(Some("credential+b".into()), None).unwrap()),
    );
    managed_rehost_successor_index::publish(&recovery, &first).unwrap();
    managed_rehost_successor_index::publish(&recovery, &second).unwrap();

    let ManagedRehostResolutionLookup::Resolved(resolution) =
        resolve_managed_rehost_current(temp.path(), "workspace-successors", "a").unwrap()
    else {
        panic!("the complete compacted chain must resolve")
    };
    assert_eq!(resolution.operation_ids(), &["a-to-b", "b-to-c"]);
    assert_eq!(resolution.current_generation().session_id(), "c");
    assert_eq!(
        resolution
            .launch_identity()
            .and_then(ManagedRehostLaunchIdentity::launch_reference),
        Some("credential+b")
    );
    assert_eq!(
        resolution
            .launch_identity()
            .and_then(ManagedRehostLaunchIdentity::conversation_id),
        None
    );
}

#[test]
fn prepared_launch_identity_distinguishes_unavailable_from_known_fresh() {
    assert_eq!(prepared_launch_identity("{}").unwrap(), None);
    assert_eq!(
        prepared_launch_identity(r#"{"launchReference":null,"conversationId":null}"#).unwrap(),
        Some(ManagedRehostLaunchIdentity::new(None, None).unwrap())
    );
    assert_eq!(
        prepared_launch_identity(
            r#"{"launchReference":"credential+profile","conversationId":"conversation-final"}"#,
        )
        .unwrap(),
        Some(
            ManagedRehostLaunchIdentity::new(
                Some("credential+profile".into()),
                Some("conversation-final".into()),
            )
            .unwrap()
        )
    );
    assert!(prepared_launch_identity(r#"{"launchReference":[],"conversationId":null}"#).is_err());
}

#[test]
fn retained_journal_enriches_a_legacy_successor_launch_identity() {
    let temp = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let recovery = temp.path().join(".recovery");
    ensure_private_directory(&recovery).unwrap();
    let legacy =
        direct_rehost_resolution(temp.path(), "legacy-to-current", "legacy", "current", 1, 2);
    managed_rehost_successor_index::publish(&recovery, &legacy).unwrap();
    let canonical_payload = serde_json::json!({
        "launchReference": "credential+current",
        "conversationId": "conversation-current"
    })
    .to_string();
    write_completed_rehost_record_with_payload(
        temp.path(),
        "legacy-to-current",
        "legacy",
        "current",
        MANAGED_REHOST_RECOVERY_ACTION,
        &canonical_payload,
    );

    let ManagedRehostResolutionLookup::Resolved(resolution) =
        resolve_managed_rehost_current(temp.path(), "workspace-successors", "legacy").unwrap()
    else {
        panic!("the retained journal must enrich the legacy edge")
    };
    assert_eq!(
        resolution
            .launch_identity()
            .and_then(ManagedRehostLaunchIdentity::launch_reference),
        Some("credential+current")
    );
    assert_eq!(
        resolution
            .launch_identity()
            .and_then(ManagedRehostLaunchIdentity::conversation_id),
        Some("conversation-current")
    );
}

#[test]
fn prepublished_launch_overlay_keeps_a_pending_cut_retryable() {
    let temp = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let recovery = temp.path().join(".recovery");
    ensure_private_directory(&recovery).unwrap();
    let edge = direct_rehost_resolution_with_launch_identity(
        temp.path(),
        "overlay-cut",
        "overlay-source",
        "overlay-target",
        1,
        2,
        Some(ManagedRehostLaunchIdentity::new(None, None).unwrap()),
    );
    let identity = PreparedRecoveryIdentity {
        recovery_id: format!("{MANAGED_REHOST_RECOVERY_ID_PREFIX}overlay-cut"),
        source_session_id: "overlay-source".into(),
        source_workspace_id: "workspace-successors".into(),
        action: MANAGED_REHOST_RECOVERY_ACTION,
        legacy_request_fingerprint: None,
    };
    let RecoveryReservationState::Pending(reservation) = reserve_prepared(
        temp.path(),
        identity,
        Some(r#"{"launchReference":null,"conversationId":null}"#.into()),
    )
    .unwrap() else {
        panic!("the crash-cut fixture must remain pending")
    };
    drop(reservation);
    managed_rehost_successor_index::publish_launch_identity(&recovery, &edge).unwrap();

    assert_eq!(
        resolve_managed_rehost_current(temp.path(), "workspace-successors", "overlay-source")
            .unwrap(),
        ManagedRehostResolutionLookup::RetryRequired {
            operation_id: "overlay-cut".into()
        }
    );
}

#[test]
fn completed_cut_joins_its_overlay_before_lineage_and_gc_converges() {
    let temp = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let recovery = temp.path().join(".recovery");
    ensure_private_directory(&recovery).unwrap();
    let identity = ManagedRehostLaunchIdentity::new(
        Some("credential+cut".into()),
        Some("conversation-cut".into()),
    )
    .unwrap();
    let edge = direct_rehost_resolution_with_launch_identity(
        temp.path(),
        "completed-cut",
        "completed-source",
        "completed-target",
        1,
        2,
        Some(identity.clone()),
    );
    managed_rehost_successor_index::publish_launch_identity(&recovery, &edge).unwrap();
    let canonical_payload = serde_json::json!({
        "launchReference": "credential+cut",
        "conversationId": "conversation-cut"
    })
    .to_string();
    let journal = write_completed_rehost_record_with_payload(
        temp.path(),
        "completed-cut",
        "completed-source",
        "completed-target",
        MANAGED_REHOST_RECOVERY_ACTION,
        &canonical_payload,
    );

    let ManagedRehostResolutionLookup::Resolved(before_gc) =
        resolve_managed_rehost_current(temp.path(), "workspace-successors", "completed-source")
            .unwrap()
    else {
        panic!("completed journal plus exact overlay must resolve before lineage compaction")
    };
    assert_eq!(before_gc.launch_identity(), Some(&identity));

    let report = garbage_collect_completed_action(
        temp.path(),
        MANAGED_REHOST_RECOVERY_ACTION,
        RecoveryJournalGcPolicy {
            minimum_completed_age: Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(report.removed_completed_records, 1);
    assert!(!journal.exists());
    assert_eq!(
        resolve_managed_rehost_current(temp.path(), "workspace-successors", "completed-source")
            .unwrap(),
        ManagedRehostResolutionLookup::Resolved(before_gc)
    );
}

#[test]
fn successor_index_conflicts_and_cycles_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let recovery = temp.path().join(".recovery");
    ensure_private_directory(&recovery).unwrap();
    let first = direct_rehost_resolution(temp.path(), "a-to-b", "a", "b", 1, 2);
    managed_rehost_successor_index::publish(&recovery, &first).unwrap();
    let enriched = direct_rehost_resolution_with_launch_identity(
        temp.path(),
        "a-to-b",
        "a",
        "b",
        1,
        2,
        Some(
            ManagedRehostLaunchIdentity::new(
                Some("credential-a".into()),
                Some("conversation-a".into()),
            )
            .unwrap(),
        ),
    );
    managed_rehost_successor_index::publish(&recovery, &enriched).unwrap();
    assert_eq!(
        managed_rehost_successor_index::lookup(&recovery, "workspace-successors", "a").unwrap(),
        Some(enriched.clone())
    );
    let changed_identity = direct_rehost_resolution_with_launch_identity(
        temp.path(),
        "a-to-b",
        "a",
        "b",
        1,
        2,
        Some(
            ManagedRehostLaunchIdentity::new(
                Some("credential-other".into()),
                Some("conversation-a".into()),
            )
            .unwrap(),
        ),
    );
    let error = managed_rehost_successor_index::publish(&recovery, &changed_identity).unwrap_err();
    assert!(error.contains("successor_index_conflict"), "{error}");
    let conflicting = direct_rehost_resolution(temp.path(), "a-to-c", "a", "c", 1, 2);
    let error = managed_rehost_successor_index::publish(&recovery, &conflicting).unwrap_err();
    assert!(error.contains("successor_index_conflict"), "{error}");

    let second = direct_rehost_resolution(temp.path(), "b-to-c", "b", "c", 2, 3);
    let third = direct_rehost_resolution(temp.path(), "c-to-b", "c", "b", 3, 4);
    managed_rehost_successor_index::publish(&recovery, &second).unwrap();
    managed_rehost_successor_index::publish(&recovery, &third).unwrap();
    let error = resolve_managed_rehost_current(temp.path(), "workspace-successors", "a")
        .expect_err("a successor cycle must never expose a guessed current generation");
    assert!(error.contains("cycle"), "{error}");
}

#[test]
fn completed_adapter_rehost_receipts_define_the_successor_without_action_coupling() {
    let temp = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let operation_id = "adapter-recovery-1";
    let source = ManagedStopReceipt::from_request(
        &ManagedStopRequest::new("adapter-stop-1", "adapter-source", "workspace-successors")
            .unwrap()
            .with_expected_fence(
                "source-principal",
                "source-runner",
                1,
                "source-host",
                "source-terminal",
            )
            .unwrap(),
        ManagedStopOutcome::Stopped,
        "source stopped",
    )
    .unwrap();
    let replacement = ManagedCreateReceipt::new(
        "adapter-create-1",
        "adapter-successor",
        "workspace-successors",
        "codex",
        PermissionMode::Default,
        temp.path(),
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new(
            "successor-principal",
            "successor-runner",
            2,
            "successor-host",
            "successor-terminal",
        )
        .unwrap(),
    )
    .unwrap();
    let directory = temp.path().join(".recovery");
    ensure_private_directory(&directory).unwrap();
    let record = RecoveryRecord {
        schema_version: RECOVERY_SCHEMA_VERSION,
        recovery_id: operation_id.into(),
        source_session_id: source.session_id().into(),
        source_workspace_id: source.workspace_id().into(),
        request_fingerprint: request_fingerprint(&[operation_id]),
        action: "adapter_owned_provider_replacement".into(),
        created_unix_ms: unix_time_ms(),
        state: RecoveryRecordState::Completed {
            target_session_id: replacement.session_id().into(),
            target_workspace_id: replacement.workspace_id().into(),
            target_build_id: "build-1".into(),
            outcome: "replaced".into(),
            resume_checkpoint: None,
            operation_checkpoint: Some(RecoveryOperationCheckpoint {
                canonical_payload: "{}".into(),
                source_stop_receipt: Some(
                    serde_json::json!({ "kind": "managed_stop", "receipt": source }).to_string(),
                ),
                replacement_receipt: Some(serde_json::to_string(&replacement).unwrap()),
            }),
            completed_unix_ms: Some(unix_time_ms()),
        },
    };
    validate_stored_record(&record).unwrap();
    write_record(
        &directory,
        &directory.join(format!("operation_{}.json", digest(operation_id))),
        &record,
    )
    .unwrap();

    let ManagedRehostResolutionLookup::Resolved(resolution) =
        resolve_managed_rehost_current(temp.path(), "workspace-successors", "adapter-source")
            .unwrap()
    else {
        panic!("the completed exact stop/create receipts must define a successor")
    };
    assert_eq!(
        resolution.current_generation().session_id(),
        "adapter-successor"
    );
    assert_eq!(resolution.operation_ids(), &[operation_id.to_string()]);
}
