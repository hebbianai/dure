use super::*;
use hmux_runtime_contract::{
    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER, ManagedCreateGenerationFence,
    ManagedCreateOutcome, ManagedRehostRecipe, ManagedRehostReplacement, ManagedStopOutcome,
    PermissionMode, ProviderStateEnvironment, TerminalEnvironment,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;

fn fixture(root: &Path, fresh: bool) -> (ManagedRehostReceipt, RecoveryReservation) {
    fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
    let mut request = ManagedRehostRequest::new(
        "read-completed",
        "source",
        "workspace",
        "principal",
        "runner",
        1,
        "host",
        "terminal",
        true,
    )
    .unwrap();
    if fresh {
        request = request
            .with_replacement(
                ManagedRehostReplacement::new(
                    "fixture",
                    PermissionMode::Default,
                    root,
                    24,
                    80,
                    TerminalEnvironment::default(),
                    None,
                    ProviderStateEnvironment::default(),
                    ManagedRehostRecipe::new(
                        vec![
                            "fixture".into(),
                            MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                        ],
                        None,
                    )
                    .unwrap(),
                )
                .unwrap()
                .with_fresh_command(vec!["fixture".into()])
                .unwrap(),
            )
            .unwrap();
    }
    let source =
        ManagedStopReceipt::from_request(request.source(), ManagedStopOutcome::Stopped, "stopped")
            .unwrap();
    let replacement = ManagedCreateReceipt::new(
        "create-target",
        "target",
        "workspace",
        "fixture",
        PermissionMode::Default,
        root,
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new("principal-2", "runner-2", 2, "host-2", "terminal-2")
            .unwrap(),
    )
    .unwrap();
    let receipt = if fresh {
        ManagedRehostReceipt::new_fresh(&request, source, replacement, None, false)
    } else {
        ManagedRehostReceipt::new(&request, source, replacement, "conversation", None, false)
    }
    .unwrap();
    let payload = json!({"request": request, "launchReference": null, "conversationId": receipt.conversation_id()}).to_string();
    let RecoveryReservationState::Pending(mut reservation) = reserve_prepared(
        root,
        PreparedRecoveryIdentity {
            recovery_id: format!(
                "{MANAGED_REHOST_RECOVERY_ID_PREFIX}{}",
                request.operation_id()
            ),
            source_session_id: "source".into(),
            source_workspace_id: "workspace".into(),
            action: MANAGED_REHOST_RECOVERY_ACTION,
            legacy_request_fingerprint: None,
        },
        Some(payload),
    )
    .unwrap() else {
        panic!("new fixture must be pending")
    };
    reservation
        .checkpoint_source_stop_receipt(
            serde_json::to_string(receipt.source_stop_receipt()).unwrap(),
        )
        .unwrap();
    reservation
        .checkpoint_replacement_receipt(
            serde_json::to_string(receipt.replacement_receipt()).unwrap(),
        )
        .unwrap();
    (receipt, reservation)
}

fn complete(reservation: &mut RecoveryReservation) {
    reservation
        .complete(RecoveryCompletion {
            target_session_id: "target".into(),
            target_workspace_id: "workspace".into(),
            target_build_id: "fixture".into(),
            action: MANAGED_REHOST_RECOVERY_ACTION.into(),
            outcome: "rehosted".into(),
            resume_checkpoint: None,
            operation_checkpoint: reservation.operation_checkpoint().cloned(),
        })
        .unwrap();
}

fn request() -> ManagedRehostReconcileRequest {
    ManagedRehostReconcileRequest::by_operation_identity("read-completed", "source", "workspace")
        .unwrap()
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, SystemTime)> {
    let mut result = BTreeMap::new();
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        let metadata = fs::metadata(&path).unwrap();
        let bytes = if metadata.is_dir() {
            result.extend(snapshot(&path));
            Vec::new()
        } else {
            fs::read(&path).unwrap()
        };
        result.insert(path, (bytes, metadata.modified().unwrap()));
    }
    result
}

#[test]
fn original_exact_and_fresh_receipts_are_read_without_mutation_or_operation_lock() {
    for fresh in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (expected, mut reservation) = fixture(root.path(), fresh);
        complete(&mut reservation);
        let before = snapshot(root.path());
        // The execution lock stays held: reading must not wait for or replay its broker.
        for _ in 0..2 {
            assert_eq!(
                read_completed_managed_rehost_receipt(root.path(), &request()).unwrap(),
                Some(expected.clone())
            );
        }
        assert_eq!(before, snapshot(root.path()));
    }
}

#[test]
fn predecessor_reads_the_same_edge_before_and_after_compaction_or_index_publication() {
    for state in ["complete", "compacted", "journal_only"] {
        let root = tempfile::tempdir().unwrap();
        let (receipt, mut reservation) = fixture(root.path(), false);
        complete(&mut reservation);
        if state == "compacted" {
            drop(reservation);
            let report = garbage_collect_completed(
                root.path(),
                RecoveryJournalGcPolicy {
                    minimum_completed_age: Duration::ZERO,
                    maximum_completed_records: 0,
                    maximum_completed_bytes: 0,
                    ..RecoveryJournalGcPolicy::default()
                },
            )
            .unwrap();
            assert_eq!(report.removed_completed_records, 1);
        } else if state == "journal_only" {
            // Model the completed-record / forward-publication crash cut.
            // Retain the fixture's index rather than changing its receipts.
            fs::rename(
                root.path().join(".managed-rehost-successors-v1"),
                root.path().join("retained-index"),
            )
            .unwrap();
        }
        let expected = ManagedRehostResolution::from_receipts(
            receipt.operation_id(),
            receipt.source_stop_receipt(),
            receipt.replacement_receipt(),
        )
        .unwrap();
        let before = snapshot(root.path());
        let started = std::time::Instant::now();
        for _ in 0..2 {
            let edge = read_managed_rehost_predecessor(root.path(), receipt.replacement_receipt())
                .unwrap()
                .unwrap();
            assert_eq!(edge.source_generation(), expected.source_generation());
            assert_eq!(edge.current_generation(), expected.current_generation());
        }
        eprintln!(
            "predecessor {state}: two fixture reads in {:?}",
            started.elapsed()
        );
        assert_eq!(before, snapshot(root.path()));
    }
}

#[test]
fn predecessor_never_promotes_an_absent_or_different_target_generation() {
    let root = tempfile::tempdir().unwrap();
    let (receipt, mut reservation) = fixture(root.path(), false);
    let target = receipt.replacement_receipt();
    assert!(
        read_managed_rehost_predecessor(root.path(), target)
            .unwrap()
            .is_none()
    );
    complete(&mut reservation);
    let before = snapshot(root.path());
    for fence in [
        ManagedCreateGenerationFence::new("foreign", "runner-2", 2, "host-2", "terminal-2"),
        ManagedCreateGenerationFence::new("principal-2", "foreign", 2, "host-2", "terminal-2"),
        ManagedCreateGenerationFence::new("principal-2", "runner-2", 3, "host-2", "terminal-2"),
        ManagedCreateGenerationFence::new("principal-2", "runner-2", 2, "foreign", "terminal-2"),
        ManagedCreateGenerationFence::new("principal-2", "runner-2", 2, "host-2", "foreign"),
    ] {
        let foreign = target
            .clone()
            .with_generation_fence(fence.unwrap())
            .unwrap();
        assert!(
            read_managed_rehost_predecessor(root.path(), &foreign)
                .unwrap()
                .is_none()
        );
    }
    let foreign = ManagedCreateReceipt::new(
        target.idempotency_key(),
        target.session_id(),
        target.workspace_id(),
        "another-provider",
        PermissionMode::Default,
        root.path(),
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(target.generation_fence().unwrap().clone())
    .unwrap();
    assert!(
        read_managed_rehost_predecessor(root.path(), &foreign)
            .unwrap()
            .is_none()
    );
    assert_eq!(before, snapshot(root.path()));
}

#[test]
fn predecessor_rejects_disagreement_between_completed_journal_and_index() {
    let root = tempfile::tempdir().unwrap();
    let (receipt, mut reservation) = fixture(root.path(), false);
    complete(&mut reservation);
    let path = reservation.record_path.clone();
    let mut record: Value = serde_json::from_slice(&fs::read(path.as_ref()).unwrap()).unwrap();
    let replacement = receipt
        .replacement_receipt()
        .clone()
        .with_generation_fence(
            ManagedCreateGenerationFence::new("principal-3", "runner-3", 3, "host-3", "terminal-3")
                .unwrap(),
        )
        .unwrap();
    record["operation_checkpoint"]["replacementReceipt"] =
        json!(serde_json::to_string(&replacement).unwrap());
    fs::write(path.as_ref(), serde_json::to_vec(&record).unwrap()).unwrap();
    let before = snapshot(root.path());
    let error =
        read_managed_rehost_predecessor(root.path(), receipt.replacement_receipt()).unwrap_err();
    assert!(
        error.starts_with("hmux_managed_rehost_resolution_conflict:"),
        "{error}"
    );
    assert_eq!(before, snapshot(root.path()));
}

#[test]
fn predecessor_selects_from_a_populated_index_and_rejects_multiple_sources() {
    let root = tempfile::tempdir().unwrap();
    let (receipt, mut reservation) = fixture(root.path(), false);
    complete(&mut reservation);
    with_recovery_directory(root.path(), |directory| {
        for index in 0..512 {
            let target = ManagedCreateReceipt::new(
                format!("unrelated-create-{index}"),
                format!("unrelated-target-{index}"),
                "workspace",
                "fixture",
                PermissionMode::Default,
                root.path(),
                ManagedCreateOutcome::Created,
            )
            .unwrap()
            .with_generation_fence(
                receipt
                    .replacement_receipt()
                    .generation_fence()
                    .unwrap()
                    .clone(),
            )
            .unwrap();
            managed_rehost_successor_index::publish(directory, &indexed_edge(index, &target))?;
        }
        Ok(())
    })
    .unwrap();
    let before = snapshot(root.path());
    let started = std::time::Instant::now();
    let edge = read_managed_rehost_predecessor(root.path(), receipt.replacement_receipt())
        .unwrap()
        .unwrap();
    assert_eq!(edge.source_generation().session_id(), "source");
    eprintln!(
        "predecessor among 513 fixture edges: {:?}",
        started.elapsed()
    );
    assert_eq!(before, snapshot(root.path()));

    with_recovery_directory(root.path(), |directory| {
        managed_rehost_successor_index::publish(
            directory,
            &indexed_edge(512, receipt.replacement_receipt()),
        )
    })
    .unwrap();
    let before = snapshot(root.path());
    let error =
        read_managed_rehost_predecessor(root.path(), receipt.replacement_receipt()).unwrap_err();
    assert!(
        error.starts_with("hmux_managed_rehost_resolution_conflict:"),
        "{error}"
    );
    assert_eq!(before, snapshot(root.path()));
}

fn indexed_edge(index: usize, target: &ManagedCreateReceipt) -> ManagedRehostResolution {
    let request = ManagedRehostRequest::new(
        format!("indexed-operation-{index}"),
        format!("indexed-source-{index}"),
        "workspace",
        "principal",
        "runner",
        1,
        "host",
        "terminal",
        true,
    )
    .unwrap();
    let source =
        ManagedStopReceipt::from_request(request.source(), ManagedStopOutcome::Stopped, "stopped")
            .unwrap();
    ManagedRehostResolution::from_receipts(request.operation_id(), &source, target).unwrap()
}

#[test]
fn absent_pending_and_compacted_receipts_never_become_executable_work() {
    let root = tempfile::tempdir().unwrap();
    assert_eq!(
        read_completed_managed_rehost_receipt(root.path(), &request()).unwrap(),
        None
    );
    assert!(snapshot(root.path()).is_empty());
    let (_, mut reservation) = fixture(root.path(), false);
    let before = snapshot(root.path());
    assert!(
        read_completed_managed_rehost_receipt(root.path(), &request())
            .unwrap_err()
            .starts_with("hmux_recovery_pending")
    );
    assert_eq!(before, snapshot(root.path()));
    complete(&mut reservation);
    drop(reservation);
    let report = garbage_collect_completed(
        root.path(),
        RecoveryJournalGcPolicy {
            minimum_completed_age: Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(report.removed_completed_records, 1);
    let before = snapshot(root.path());
    assert!(matches!(
        observe_managed_rehost_operation(root.path(), &request()).unwrap(),
        ManagedRehostResolutionLookup::Resolved(_)
    ));
    assert_eq!(
        read_completed_managed_rehost_receipt(root.path(), &request()).unwrap(),
        None
    );
    assert_eq!(before, snapshot(root.path()));
}

#[test]
fn completed_receipt_rejects_foreign_operation_source_and_fence() {
    let root = tempfile::tempdir().unwrap();
    let (_, mut reservation) = fixture(root.path(), false);
    complete(&mut reservation);
    let before = snapshot(root.path());
    let unknown =
        ManagedRehostReconcileRequest::by_operation_identity("unknown", "source", "workspace")
            .unwrap();
    assert_eq!(
        read_completed_managed_rehost_receipt(root.path(), &unknown).unwrap(),
        None
    );
    let foreign = ManagedRehostReconcileRequest::by_operation_identity(
        "read-completed",
        "foreign",
        "workspace",
    )
    .unwrap();
    assert!(
        read_completed_managed_rehost_receipt(root.path(), &foreign)
            .unwrap_err()
            .starts_with("hmux_recovery_idempotency_conflict")
    );
    let changed_fence = ManagedRehostRequest::new(
        "read-completed",
        "source",
        "workspace",
        "principal",
        "runner",
        1,
        "host",
        "foreign-terminal",
        true,
    )
    .unwrap();
    let changed_fence = ManagedRehostReconcileRequest::from_rehost_request(&changed_fence).unwrap();
    assert!(read_completed_managed_rehost_receipt(root.path(), &changed_fence).is_err());
    assert_eq!(before, snapshot(root.path()));
}

#[test]
fn corrupt_or_uncorrelated_completion_is_never_repaired_by_a_read() {
    let root = tempfile::tempdir().unwrap();
    let (_, mut reservation) = fixture(root.path(), false);
    complete(&mut reservation);
    let path = &reservation.record_path;
    let original: Value = serde_json::from_slice(&fs::read(path.as_ref()).unwrap()).unwrap();
    for fault in [
        "missing_request",
        "unknown_launch",
        "scalar",
        "source_fence",
        "operation",
        "conversation",
        "fingerprint",
        "target",
        "outcome",
    ] {
        let mut record = original.clone();
        let mut payload: Value = serde_json::from_str(
            record["operation_checkpoint"]["canonicalPayload"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        match fault {
            "missing_request" => {
                payload.as_object_mut().unwrap().remove("request");
            }
            "unknown_launch" => {
                payload.as_object_mut().unwrap().remove("launchReference");
            }
            "scalar" => payload = json!(42),
            "source_fence" => {
                payload["request"]["source"]["expectedTerminalEpoch"] = json!("foreign")
            }
            "operation" => payload["request"]["operationId"] = json!("foreign"),
            "conversation" => payload["request"]["expectedConversationId"] = json!("foreign"),
            "target" => record["target_session_id"] = json!("foreign"),
            "outcome" => record["outcome"] = json!("unknown"),
            "fingerprint" => payload["request"]["confirmed"] = json!(false),
            _ => unreachable!(),
        }
        let payload = payload.to_string();
        record["operation_checkpoint"]["canonicalPayload"] = json!(payload);
        if fault != "fingerprint" {
            record["requestFingerprint"] = json!(request_fingerprint(&[&payload]));
        }
        fs::write(path.as_ref(), serde_json::to_vec(&record).unwrap()).unwrap();
        let before = snapshot(root.path());
        assert!(
            read_completed_managed_rehost_receipt(root.path(), &request()).is_err(),
            "fault {fault}"
        );
        assert_eq!(before, snapshot(root.path()));
    }
}
