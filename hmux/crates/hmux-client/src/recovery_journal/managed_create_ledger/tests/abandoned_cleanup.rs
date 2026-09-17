use super::*;

fn identity() -> ManagedCreateReconcileRequest {
    ManagedCreateReconcileRequest::new("create-1", "session-1", "workspace-1").unwrap()
}

#[test]
fn abandoned_cleanup_preserves_unknown_pending_completed_and_retired_creates() {
    let root = secure_root();
    let source = identity();
    assert!(!close_abandoned_create(root.path(), &source).unwrap());
    assert!(!root.path().join(LEDGER_DIRECTORY).exists());
    let ManagedCreateLedgerState::Prepared(mut reservation) = reserve(
        root.path(),
        source.workspace_id(),
        source.session_id(),
        source.idempotency_key(),
        &request_digest(1),
    )
    .unwrap() else {
        panic!("source must be prepared");
    };
    assert!(!close_abandoned_create(root.path(), &source).unwrap());
    reservation.checkpoint_pre_spawn_absence().unwrap();
    assert!(!close_abandoned_create(root.path(), &source).unwrap());
    // A rejected cleanup cannot fence this still-owned create from completing.
    let stop = complete_generation(root.path());
    assert!(!close_abandoned_create(root.path(), &source).unwrap());
    checkpoint_retirement_exact(root.path(), &stop).unwrap();
    assert!(!close_abandoned_create(root.path(), &source).unwrap());
    finalize_retirement_exact(root.path(), &stop).unwrap();
    assert!(!close_abandoned_create(root.path(), &source).unwrap());
    assert!(matches!(
        reserve_terminal_successor(root.path(), &source, || {
            Ok(successor_in_source_shard(
                &source,
                "still-open",
                &request_digest(2),
            ))
        })
        .unwrap(),
        ManagedCreateSuccessorLedgerState::Created(_)
    ));
}

#[test]
fn abandoned_cleanup_closes_before_late_advance_and_replays_after_response_loss() {
    let root = secure_root();
    let source = identity();
    abandon_generation(root.path(), &source, &request_digest(1));
    let wrong_key = ManagedCreateReconcileRequest::new(
        "unrelated-create",
        source.session_id(),
        source.workspace_id(),
    )
    .unwrap();
    assert!(close_abandoned_create(root.path(), &wrong_key).is_err());
    assert!(close_abandoned_create(root.path(), &source).unwrap());
    assert!(close_abandoned_create(root.path(), &source).unwrap());
    assert_eq!(
        reserve_terminal_successor(root.path(), &source, || {
            panic!("closed abandoned identity cannot allocate a successor")
        })
        .unwrap(),
        ManagedCreateSuccessorLedgerState::Closed,
    );
    assert!(matches!(
        reserve(
            root.path(),
            source.workspace_id(),
            source.session_id(),
            source.idempotency_key(),
            &request_digest(1)
        )
        .unwrap(),
        ManagedCreateLedgerState::Retired,
    ));
}

#[test]
fn abandoned_cleanup_never_follows_an_admitted_successor() {
    let root = secure_root();
    let source = identity();
    abandon_generation(root.path(), &source, &request_digest(1));
    let target = successor_in_source_shard(&source, "prior-advance", &request_digest(2));
    assert!(matches!(
        reserve_terminal_successor(root.path(), &source, || Ok(target.clone())).unwrap(),
        ManagedCreateSuccessorLedgerState::Created(_)
    ));
    let before = resolve_successor_chain(root.path(), &source).unwrap();
    assert!(!close_abandoned_create(root.path(), &source).unwrap());
    assert_eq!(
        resolve_successor_chain(root.path(), &source).unwrap(),
        before
    );
    assert_eq!(
        reserve_terminal_successor(root.path(), &source, || panic!(
            "reuse the admitted successor"
        ))
        .unwrap(),
        ManagedCreateSuccessorLedgerState::Existing(target),
    );
}

#[test]
fn abandoned_cleanup_and_advance_have_one_atomic_winner() {
    let root = secure_root();
    for index in 0..16 {
        let source = ManagedCreateReconcileRequest::new(
            format!("create-{index}"),
            format!("session-{index}"),
            "cleanup-race",
        )
        .unwrap();
        abandon_generation(root.path(), &source, &request_digest(1));
        let start = Arc::new(Barrier::new(3));
        let cleanup = {
            let path = root.path().to_path_buf();
            let source = source.clone();
            let start = Arc::clone(&start);
            thread::spawn(move || {
                start.wait();
                close_abandoned_create(&path, &source).unwrap()
            })
        };
        let advance = {
            let path = root.path().to_path_buf();
            let source = source.clone();
            let start = Arc::clone(&start);
            thread::spawn(move || {
                start.wait();
                reserve_terminal_successor(&path, &source, || {
                    Ok(successor_in_source_shard(
                        &source,
                        "racing-advance",
                        &request_digest(2),
                    ))
                })
                .unwrap()
            })
        };
        start.wait();
        let closed = cleanup.join().unwrap();
        let successor = advance.join().unwrap();
        assert!(matches!(
            (closed, successor),
            (true, ManagedCreateSuccessorLedgerState::Closed)
                | (false, ManagedCreateSuccessorLedgerState::Created(_))
        ));
    }
}
