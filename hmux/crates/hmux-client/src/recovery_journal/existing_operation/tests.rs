use super::*;

fn prepared_identity() -> PreparedRecoveryIdentity {
    PreparedRecoveryIdentity {
        recovery_id: "prepared-stop".into(),
        source_session_id: "source".into(),
        source_workspace_id: "workspace".into(),
        action: MANAGED_STOP_RECOVERY_ACTION,
        legacy_request_fingerprint: None,
    }
}

fn prepared_pending(root: &Path) -> RecoveryReservation {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let RecoveryReservationState::Pending(reservation) =
        reserve_prepared(root, prepared_identity(), Some("{}".into())).unwrap()
    else {
        panic!("new prepared fixture must be pending");
    };
    reservation
}

#[test]
fn prepared_absence_does_not_create_journal_artifacts() {
    let root = tempfile::tempdir().unwrap();
    assert!(
        reopen_prepared(root.path(), &prepared_identity())
            .unwrap()
            .is_none()
    );
    assert!(!root.path().join(".recovery").exists());
}

#[test]
fn prepared_absence_does_not_wait_for_unrelated_admission() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join(".recovery");
    ensure_private_directory(&directory).unwrap();
    let admission = acquire_admission_lock(&directory).unwrap();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (result_tx, result_rx) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            started_tx.send(()).unwrap();
            result_tx
                .send(reopen_prepared(root.path(), &prepared_identity()))
                .unwrap();
        });
        started_rx.recv().unwrap();
        let while_locked = result_rx.recv_timeout(Duration::from_secs(1));
        drop(admission);
        worker.join().unwrap();
        assert!(
            matches!(while_locked, Ok(Ok(None))),
            "an absent observation must finish while unrelated admission is held: {while_locked:?}"
        );
    });
}

#[test]
fn prepared_reopen_preserves_exact_lock_payload_and_completion() {
    let root = tempfile::tempdir().unwrap();
    let initial = prepared_pending(root.path());
    let original = fs::read(&*initial.record_path).unwrap();
    let path = (*initial.record_path).clone();
    assert!(
        reopen_prepared(root.path(), &prepared_identity())
            .unwrap_err()
            .starts_with("hmux_recovery_busy")
    );
    drop(initial);
    let mut wrong = prepared_identity();
    wrong.source_session_id = "another-source".into();
    assert!(
        reopen_prepared(root.path(), &wrong)
            .unwrap_err()
            .starts_with("hmux_recovery_idempotency_conflict")
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    let Some(RecoveryReservationState::Pending(mut current)) =
        reopen_prepared(root.path(), &prepared_identity()).unwrap()
    else {
        panic!("exact prepared record must reopen");
    };
    assert!(current.was_existing());
    assert!(
        current
            .prepare_operation_payload(
                RecoveryOperationPayload::new("{\"changed\":true}".into()).unwrap()
            )
            .is_err()
    );
    let checkpoint = current.operation_checkpoint().unwrap().clone();
    let identity = RecoveryIdentity {
        recovery_id: prepared_identity().recovery_id,
        source_session_id: "source".into(),
        source_workspace_id: "workspace".into(),
        request_fingerprint: request_fingerprint(&["{}"]),
        action: MANAGED_STOP_RECOVERY_ACTION,
    };
    let completion = RecoveryCompletion {
        target_session_id: "source".into(),
        target_workspace_id: "workspace".into(),
        target_build_id: "build".into(),
        action: MANAGED_STOP_RECOVERY_ACTION.into(),
        outcome: "stopped".into(),
        resume_checkpoint: None,
        operation_checkpoint: Some(checkpoint),
    };
    current.complete(completion.clone()).unwrap();
    drop(current);
    assert!(
        matches!(reopen_prepared(root.path(), &prepared_identity()).unwrap(), Some(RecoveryReservationState::Completed(observed)) if observed == completion)
    );
    acknowledge_completion(root.path(), &identity, &completion).unwrap();
    assert!(
        reopen_prepared(root.path(), &prepared_identity())
            .unwrap()
            .is_none()
    );
    assert!(
        reserve_prepared(root.path(), prepared_identity(), Some("{}".into()))
            .unwrap_err()
            .starts_with(RECOVERY_COMPLETION_ACKNOWLEDGED_CODE)
    );
}

#[test]
fn prepared_reopen_keeps_legacy_payload_fingerprint_binding() {
    let root = tempfile::tempdir().unwrap();
    let mut prepared = prepared_identity();
    prepared.legacy_request_fingerprint = Some(request_fingerprint(&["legacy"]));
    drop(
        reserve(
            root.path(),
            RecoveryIdentity {
                recovery_id: prepared.recovery_id.clone(),
                source_session_id: prepared.source_session_id.clone(),
                source_workspace_id: prepared.source_workspace_id.clone(),
                request_fingerprint: prepared.legacy_request_fingerprint.clone().unwrap(),
                action: prepared.action,
            },
        )
        .unwrap(),
    );
    let Some(RecoveryReservationState::Pending(mut current)) =
        reopen_prepared(root.path(), &prepared).unwrap()
    else {
        panic!("matching legacy fingerprint must reopen");
    };
    current
        .prepare_operation_payload(RecoveryOperationPayload::new("{}".into()).unwrap())
        .unwrap();
    drop(current);
    prepared.legacy_request_fingerprint = None;
    assert!(matches!(
        reopen_prepared(root.path(), &prepared).unwrap(),
        Some(RecoveryReservationState::Pending(_))
    ));
}

#[cfg(unix)]
#[test]
fn prepared_reopen_validates_only_its_exact_record_not_unrelated_paths() {
    let root = tempfile::tempdir().unwrap();
    let current = prepared_pending(root.path());
    let path = (*current.record_path).clone();
    drop(current);
    let unrelated = root
        .path()
        .join(".recovery")
        .join(format!("operation_{}.json", digest("unrelated")));
    std::os::unix::fs::symlink(&path, unrelated).unwrap();
    assert!(matches!(
        reopen_prepared(root.path(), &prepared_identity()).unwrap(),
        Some(RecoveryReservationState::Pending(_))
    ));
    let mut record = read_record(&path).unwrap();
    record.request_fingerprint = request_fingerprint(&["wrong"]);
    write_record(path.parent().unwrap(), &path, &record).unwrap();
    assert!(
        reopen_prepared(root.path(), &prepared_identity())
            .unwrap_err()
            .starts_with("hmux_recovery_journal_invalid")
    );
}

fn observe(root: &Path, recovery_id: &str) -> Result<Option<RecoveryOperationObservation>, String> {
    read(
        root,
        recovery_id,
        STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
    )
}

fn pending(root: &Path) -> RecoveryReservation {
    let RecoveryReservationState::Pending(reservation) = reserve(
        root,
        RecoveryIdentity {
            recovery_id: "creation".into(),
            source_session_id: "intent".into(),
            source_workspace_id: "operation".into(),
            request_fingerprint: request_fingerprint(&["immutable-intent"]),
            action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
        },
    )
    .unwrap() else {
        panic!("new fixture must be pending");
    };
    reservation
}

#[test]
fn observes_absent_pending_and_completed_without_acquiring_or_creating_an_operation() {
    let root = tempfile::tempdir().unwrap();
    assert!(observe(root.path(), "creation").unwrap().is_none());
    assert!(!root.path().join(".recovery").exists());
    let mut reservation = pending(root.path());
    assert!(matches!(
        observe(root.path(), "creation").unwrap(),
        Some(RecoveryOperationObservation::Pending {
            checkpoint: None,
            ..
        })
    ));
    reservation
        .prepare_operation_payload(RecoveryOperationPayload::new("{}".into()).unwrap())
        .unwrap();
    let checkpoint = reservation.operation_checkpoint().unwrap().clone();
    let before = fs::read(&*reservation.record_path).unwrap();
    let Some(RecoveryOperationObservation::Pending {
        checkpoint: observed,
        ..
    }) = observe(root.path(), "creation").unwrap()
    else {
        panic!("held reservation is observable without blocking");
    };
    assert_eq!(observed.as_ref(), Some(&checkpoint));
    assert_eq!(fs::read(&*reservation.record_path).unwrap(), before);
    let mut completed = prepared_standalone_create::refusal::completion(
        "standalone_target",
        "operation",
        "hmux_standalone_recovery_name_conflict",
    );
    completed.operation_checkpoint = Some(checkpoint);
    reservation.complete(completed.clone()).unwrap();
    drop(reservation);
    let Some(RecoveryOperationObservation::Completed {
        identity,
        completion: observed,
    }) = observe(root.path(), "creation").unwrap()
    else {
        panic!("completed operation must remain observable");
    };
    assert_eq!(*observed, completed);
    assert!(observe(root.path(), "another-operation").unwrap().is_none());
    assert!(
        read(root.path(), "creation", "another_action_v1")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        acknowledge_completion(root.path(), &identity, &observed).unwrap(),
        RecoveryCompletionAcknowledgement::Acknowledged
    );
    assert!(observe(root.path(), "creation").unwrap().is_none());
    assert!(
        reserve(root.path(), identity)
            .err()
            .unwrap()
            .starts_with(RECOVERY_COMPLETION_ACKNOWLEDGED_CODE)
    );
}

#[test]
fn refuses_a_record_whose_identity_was_replaced_at_the_same_lookup_path() {
    let root = tempfile::tempdir().unwrap();
    let reservation = pending(root.path());
    let path = (*reservation.record_path).clone();
    let mut record = reservation.record.clone();
    record.recovery_id = "different-operation".into();
    drop(reservation);
    write_record(path.parent().unwrap(), &path, &record).unwrap();
    assert!(
        observe(root.path(), "creation")
            .err()
            .unwrap()
            .starts_with("hmux_recovery_idempotency_conflict")
    );
}

#[test]
fn reopen_is_noncreating_exact_and_retains_only_its_operation_lock() {
    let root = tempfile::tempdir().unwrap();
    let identity = RecoveryIdentity {
        recovery_id: "creation".into(),
        source_session_id: "intent".into(),
        source_workspace_id: "operation".into(),
        request_fingerprint: request_fingerprint(&["immutable-intent"]),
        action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION,
    };
    assert!(reopen(root.path(), &identity).unwrap().is_none());
    assert!(!root.path().join(".recovery").exists());
    let mut initial = pending(root.path());
    initial
        .prepare_operation_payload(RecoveryOperationPayload::new("{}".into()).unwrap())
        .unwrap();
    let checkpoint = initial.operation_checkpoint().unwrap().clone();
    let path = (*initial.record_path).clone();
    let original = fs::read(&path).unwrap();
    assert!(
        reopen(root.path(), &identity)
            .unwrap_err()
            .starts_with("hmux_recovery_busy")
    );
    drop(initial);
    let mut wrong = identity.clone();
    wrong.request_fingerprint = request_fingerprint(&["other-intent"]);
    assert!(
        reopen(root.path(), &wrong)
            .unwrap_err()
            .starts_with("hmux_recovery_idempotency_conflict")
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    let Some(RecoveryReservationState::Pending(mut resumed)) =
        reopen(root.path(), &identity).unwrap()
    else {
        panic!("exact pending operation must reopen");
    };
    assert!(resumed.was_existing());
    assert_eq!(resumed.operation_checkpoint(), Some(&checkpoint));
    assert!(
        reopen(root.path(), &identity)
            .unwrap_err()
            .starts_with("hmux_recovery_busy")
    );
    let mut unrelated = identity.clone();
    unrelated.recovery_id = "unrelated".into();
    assert!(
        matches!(
            reserve(root.path(), unrelated).unwrap(),
            RecoveryReservationState::Pending(_)
        ),
        "a retained operation lock must not retain global journal admission"
    );
    let mut completion = prepared_standalone_create::refusal::completion(
        "standalone_target",
        "operation",
        "hmux_standalone_recovery_target_exited",
    );
    completion.operation_checkpoint = Some(checkpoint);
    resumed.complete(completion.clone()).unwrap();
    drop(resumed);
    let Some(RecoveryReservationState::Completed(observed)) =
        reopen(root.path(), &identity).unwrap()
    else {
        panic!("completed operation must never reopen as pending");
    };
    assert_eq!(observed, completion);
    acknowledge_completion(root.path(), &identity, &completion).unwrap();
    assert!(
        reopen(root.path(), &identity)
            .unwrap_err()
            .starts_with(RECOVERY_COMPLETION_ACKNOWLEDGED_CODE)
    );
    assert!(!path.exists());
}

#[test]
fn reopen_uses_the_current_completion_after_a_stale_pending_observation() {
    let root = tempfile::tempdir().unwrap();
    let mut reservation = pending(root.path());
    let Some(RecoveryOperationObservation::Pending { identity, .. }) =
        observe(root.path(), "creation").unwrap()
    else {
        panic!("fixture must be pending");
    };
    let completion = prepared_standalone_create::refusal::completion(
        "standalone_target",
        "operation",
        "hmux_standalone_create_operation_invalid",
    );
    reservation.complete(completion.clone()).unwrap();
    drop(reservation);
    let Some(RecoveryReservationState::Completed(current)) =
        reopen(root.path(), &identity).unwrap()
    else {
        panic!("the locked current completion wins over a stale observation");
    };
    assert_eq!(current, completion);
}

#[cfg(unix)]
#[test]
fn refuses_a_symlinked_journal_without_following_it() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    fs::create_dir(&source).unwrap();
    drop(pending(&source));
    let alias = root.path().join("alias");
    fs::create_dir(&alias).unwrap();
    std::os::unix::fs::symlink(source.join(".recovery"), alias.join(".recovery")).unwrap();
    assert!(observe(&alias, "creation").is_err());
    assert!(observe(&source, "creation").unwrap().is_some());
}
