use super::*;
use crate::LocalSessionCatalog;
use hmux_runtime_contract::ManagedStopOutcome;

fn private_root() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    }
    root
}

fn request() -> ManagedStopRequest {
    ManagedStopRequest::new("stop-1", "session-1", "workspace-1")
        .unwrap()
        .with_expected_fence("principal-1", "runner-1", 7, "host-1", "terminal-1")
        .unwrap()
}

fn pending(root: &Path, request: &ManagedStopRequest) -> RecoveryReservation {
    let RecoveryReservationState::Pending(reservation) = reserve_prepared(
        root,
        identity(
            request.stop_id(),
            request.session_id(),
            request.workspace_id(),
        ),
        Some(serde_json::to_string(request).unwrap()),
    )
    .unwrap() else {
        panic!("new fixture must reserve a stop");
    };
    reservation
}

fn complete(reservation: &mut RecoveryReservation, outcome: &str) {
    reservation
        .complete(RecoveryCompletion {
            target_session_id: "session-1".into(),
            target_workspace_id: "workspace-1".into(),
            target_build_id: "fixture-build".into(),
            action: MANAGED_STOP_RECOVERY_ACTION.into(),
            outcome: outcome.into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .unwrap();
}

fn completed(root: &Path) -> ManagedStopReceipt {
    let exact = request();
    let receipt = ManagedStopReceipt::from_request(
        &exact,
        ManagedStopOutcome::Stopped,
        "managed_provider_stopped",
    )
    .unwrap();
    let mut reservation = pending(root, &exact);
    reservation
        .checkpoint_source_stop_receipt(serde_json::to_string(&receipt).unwrap())
        .unwrap();
    complete(&mut reservation, "stopped");
    receipt
}

fn files(root: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
    let mut result = std::collections::BTreeMap::new();
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            result.extend(files(&path));
        } else {
            result.insert(path.clone(), fs::read(path).unwrap());
        }
    }
    result
}

#[test]
fn completed_stop_read_does_not_admit_or_advance_a_pending_stop() {
    let root = private_root();
    let exact = request();
    let reconciliation = ManagedStopReconcileRequest::from_stop_request(&exact).unwrap();
    assert_eq!(read_completed(root.path(), &reconciliation).unwrap(), None);
    assert!(files(root.path()).is_empty());
    let mut reservation = pending(root.path(), &exact);
    let before = files(root.path());
    assert_eq!(read_completed(root.path(), &reconciliation).unwrap(), None);
    assert_eq!(files(root.path()), before);
    let receipt = ManagedStopReceipt::from_request(
        &exact,
        ManagedStopOutcome::Stopped,
        "managed_provider_stopped",
    )
    .unwrap();
    reservation
        .checkpoint_source_stop_receipt(serde_json::to_string(&receipt).unwrap())
        .unwrap();
    let checkpointed = files(root.path());
    assert_eq!(read_completed(root.path(), &reconciliation).unwrap(), None);
    assert_eq!(files(root.path()), checkpointed);
    complete(&mut reservation, "stopped");
    let finalized = files(root.path());
    assert_eq!(
        read_completed(root.path(), &reconciliation).unwrap(),
        Some(receipt)
    );
    assert_eq!(files(root.path()), finalized);
}

#[test]
fn completed_stop_read_survives_client_reopen_without_a_runtime_or_manifest() {
    let root = private_root();
    let receipt = completed(root.path());
    let reconciliation = ManagedStopReconcileRequest::from_stop_request(&request()).unwrap();
    let before = files(root.path());
    for _ in 0..2 {
        let catalog = LocalSessionCatalog::new(root.path());
        assert_eq!(
            catalog
                .read_completed_managed_stop(&reconciliation)
                .unwrap(),
            Some(receipt.clone())
        );
    }
    assert_eq!(files(root.path()), before);
}

#[test]
fn completed_stop_read_refuses_changed_generation_and_corrupt_completion() {
    let root = private_root();
    completed(root.path());
    let changed = request()
        .with_expected_fence("principal-1", "runner-2", 7, "host-1", "terminal-1")
        .unwrap();
    let reconciliation = ManagedStopReconcileRequest::from_stop_request(&changed).unwrap();
    let before = files(root.path());
    assert!(
        read_completed(root.path(), &reconciliation)
            .unwrap_err()
            .contains("operation identity")
    );
    assert_eq!(files(root.path()), before);

    let corrupt = private_root();
    let mut reservation = pending(corrupt.path(), &request());
    reservation
        .checkpoint_source_stop_receipt("{}".into())
        .unwrap();
    complete(&mut reservation, "stopped");
    let reconciliation = ManagedStopReconcileRequest::from_stop_request(&request()).unwrap();
    assert!(
        read_completed(corrupt.path(), &reconciliation)
            .unwrap_err()
            .contains("receipt")
    );
}

#[test]
fn completed_stop_read_does_not_treat_a_refusal_as_process_exit() {
    let root = private_root();
    let mut reservation = pending(root.path(), &request());
    complete(&mut reservation, "refused_precondition");
    let reconciliation = ManagedStopReconcileRequest::from_stop_request(&request()).unwrap();
    assert_eq!(read_completed(root.path(), &reconciliation).unwrap(), None);
}

#[test]
fn completed_stop_read_keeps_compatibility_roots_and_refuses_competing_owners() {
    let canonical = private_root();
    let legacy = private_root();
    let receipt = completed(legacy.path());
    let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
        canonical.path(),
        vec![legacy.path().to_path_buf()],
    )
    .unwrap();
    let reconciliation = ManagedStopReconcileRequest::from_stop_request(&request()).unwrap();
    let before = files(legacy.path());
    assert_eq!(
        catalog
            .read_completed_managed_stop(&reconciliation)
            .unwrap(),
        Some(receipt)
    );
    assert!(files(canonical.path()).is_empty());
    assert_eq!(files(legacy.path()), before);
    completed(canonical.path());
    assert!(
        catalog
            .read_completed_managed_stop(&reconciliation)
            .unwrap_err()
            .to_string()
            .contains("competing discovery")
    );
}
