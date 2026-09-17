use super::*;

fn identity() -> ManagedCreateReconcileRequest {
    ManagedCreateReconcileRequest::new("create-1", "session-1", "workspace-1").unwrap()
}

fn fence() -> ManagedCreateGenerationFence {
    ManagedCreateGenerationFence::new("principal-1", "runner-1", 7, "host-1", "terminal-1").unwrap()
}

fn retire(root: &Path) {
    let stop = complete_generation(root);
    checkpoint_retirement_exact(root, &stop).unwrap();
    finalize_retirement_exact(root, &stop).unwrap();
}

#[test]
fn exact_close_intent_requires_its_generation_and_survives_retirement() {
    let root = secure_root();
    let source = identity();
    assert!(!close_exact_create(root.path(), &source, &fence()).unwrap());
    assert!(!root.path().join(LEDGER_DIRECTORY).exists());
    let stop = complete_generation(root.path());
    let wrong =
        ManagedCreateGenerationFence::new("principal-1", "runner-1", 7, "other-host", "terminal-1")
            .unwrap();
    assert!(!close_exact_create(root.path(), &source, &wrong).unwrap());
    assert!(close_exact_create(root.path(), &source, &fence()).unwrap());
    assert_eq!(closed_retired_chain(root.path(), &source).unwrap(), None);
    assert_eq!(
        reserve_terminal_successor(root.path(), &source, || panic!(
            "logical close owns admission"
        ))
        .unwrap(),
        ManagedCreateSuccessorLedgerState::Closed,
    );
    checkpoint_retirement_exact(root.path(), &stop).unwrap();
    assert!(close_exact_create(root.path(), &source, &fence()).unwrap());
    assert_eq!(closed_retired_chain(root.path(), &source).unwrap(), None);
    finalize_retirement_exact(root.path(), &stop).unwrap();
    assert!(close_exact_create(root.path(), &source, &fence()).unwrap());
    assert!(
        closed_retired_chain(root.path(), &source)
            .unwrap()
            .is_some()
    );
}

#[test]
fn exact_close_intent_preserves_previously_admitted_successors() {
    let root = secure_root();
    let (source, _, _) = retired_source_with_successor(root.path());
    let before = resolve_successor_chain(root.path(), &source).unwrap();
    assert!(!close_exact_create(root.path(), &source, &fence()).unwrap());
    assert_eq!(
        resolve_successor_chain(root.path(), &source).unwrap(),
        before
    );
}

#[test]
fn exact_close_intent_does_not_promote_pending_or_abandoned_creates() {
    let root = secure_root();
    let source = identity();
    let ManagedCreateLedgerState::Prepared(mut pending) = reserve(
        root.path(),
        source.workspace_id(),
        source.session_id(),
        source.idempotency_key(),
        &request_digest(1),
    )
    .unwrap() else {
        panic!("new create must be pending")
    };
    pending.checkpoint_pre_spawn_absence().unwrap();
    drop(pending);
    assert!(!close_exact_create(root.path(), &source, &fence()).unwrap());
    abandon_generation(root.path(), &source, &request_digest(1));
    assert!(!close_exact_create(root.path(), &source, &fence()).unwrap());
}

#[test]
fn closed_retirement_read_requires_both_logical_close_and_final_stop() {
    let root = secure_root();
    let source = identity();
    let stop = complete_generation(root.path());
    assert_eq!(closed_retired_chain(root.path(), &source).unwrap(), None);
    assert_eq!(
        closed_retired_chain_receipt(root.path(), &source).unwrap(),
        None
    );
    claim_successor_chain_cleanup(root.path(), &source).unwrap();
    assert_eq!(closed_retired_chain(root.path(), &source).unwrap(), None);
    assert_eq!(
        closed_retired_chain_receipt(root.path(), &source).unwrap(),
        None
    );
    checkpoint_retirement_exact(root.path(), &stop).unwrap();
    assert_eq!(closed_retired_chain(root.path(), &source).unwrap(), None);
    assert_eq!(
        closed_retired_chain_receipt(root.path(), &source).unwrap(),
        None
    );
    finalize_retirement_exact(root.path(), &stop).unwrap();
    let chain = closed_retired_chain(root.path(), &source).unwrap().unwrap();
    assert_eq!(chain.identities(), std::slice::from_ref(&source));
    let receipt = closed_retired_chain_receipt(root.path(), &source)
        .unwrap()
        .unwrap();
    assert_eq!(receipt.chain(), chain.identities());
    assert_eq!(receipt.stop_receipt(), Some(&stop));
    assert_eq!(
        closed_retired_chain_receipt(root.path(), &source).unwrap(),
        Some(receipt)
    );
    assert_eq!(
        closed_retired_chain(root.path(), &source).unwrap(),
        Some(chain)
    );
    let wrong = ManagedCreateReconcileRequest::new(
        "another-key",
        source.session_id(),
        source.workspace_id(),
    )
    .unwrap();
    assert!(closed_retired_chain(root.path(), &wrong).is_err());
    assert!(closed_retired_chain_receipt(root.path(), &wrong).is_err());
}

#[test]
fn closed_retirement_read_preserves_admission_and_observes_only_a_closed_tip() {
    let root = secure_root();
    retire(root.path());
    let source = identity();
    assert_eq!(closed_retired_chain(root.path(), &source).unwrap(), None);
    assert_eq!(
        closed_retired_chain_receipt(root.path(), &source).unwrap(),
        None
    );
    let target = successor_in_source_shard(&source, "read-then-advance", &request_digest(2));
    assert_eq!(
        reserve_terminal_successor(root.path(), &source, || Ok(target.clone())).unwrap(),
        ManagedCreateSuccessorLedgerState::Created(target.clone())
    );
    assert_eq!(closed_retired_chain(root.path(), &source).unwrap(), None);
    let target_identity = ManagedCreateReconcileRequest::new(
        target.idempotency_key(),
        target.session_id(),
        source.workspace_id(),
    )
    .unwrap();
    let target_stop = complete_and_retire_generation(
        root.path(),
        &target_identity,
        &request_digest(2),
        2,
        ManagedCreateLineageAdmission::Successor,
    );
    assert_eq!(closed_retired_chain(root.path(), &source).unwrap(), None);
    assert_eq!(
        closed_retired_chain_receipt(root.path(), &source).unwrap(),
        None
    );
    let closed = close_finalized_create(root.path(), &target_identity).unwrap();
    assert!(closed.is_some());
    assert_eq!(closed_retired_chain(root.path(), &source).unwrap(), closed);
    assert_eq!(
        closed_retired_chain(root.path(), &target_identity).unwrap(),
        closed
    );
    let receipt = closed_retired_chain_receipt(root.path(), &source)
        .unwrap()
        .unwrap();
    assert_eq!(receipt.chain(), &[source, target_identity.clone()]);
    assert_eq!(receipt.stop_receipt(), Some(&target_stop));
    assert_eq!(
        closed_retired_chain_receipt(root.path(), &target_identity).unwrap(),
        Some(receipt)
    );
}

#[test]
fn closed_retirement_read_excludes_unknown_unlaunched_and_abandoned_creates() {
    let root = secure_root();
    let source = identity();
    assert_eq!(closed_retired_chain(root.path(), &source).unwrap(), None);
    assert_eq!(
        closed_retired_chain_receipt(root.path(), &source).unwrap(),
        None
    );
    assert!(!root.path().join(LEDGER_DIRECTORY).exists());
    reserve(
        root.path(),
        source.workspace_id(),
        source.session_id(),
        source.idempotency_key(),
        &request_digest(1),
    )
    .unwrap();
    claim_successor_chain_cleanup(root.path(), &source).unwrap();
    assert_eq!(closed_retired_chain(root.path(), &source).unwrap(), None);
    assert_eq!(
        closed_retired_chain_receipt(root.path(), &source).unwrap(),
        None
    );

    let root = secure_root();
    abandon_generation(root.path(), &source, &request_digest(1));
    assert!(close_abandoned_create(root.path(), &source).unwrap());
    assert_eq!(closed_retired_chain(root.path(), &source).unwrap(), None);
    assert_eq!(
        closed_retired_chain_receipt(root.path(), &source).unwrap(),
        None
    );
}

#[test]
fn finalized_create_cleanup_uses_its_own_key_and_durable_stop_receipt() {
    let root = secure_root();
    let source = identity();
    assert_eq!(close_finalized_create(root.path(), &source).unwrap(), None);
    let stop = complete_generation(root.path());
    assert_eq!(close_finalized_create(root.path(), &source).unwrap(), None);
    checkpoint_retirement_exact(root.path(), &stop).unwrap();
    assert_eq!(close_finalized_create(root.path(), &source).unwrap(), None);
    finalize_retirement_exact(root.path(), &stop).unwrap();
    let wrong =
        ManagedCreateReconcileRequest::new("wrong-key", source.session_id(), source.workspace_id())
            .unwrap();
    assert!(close_finalized_create(root.path(), &wrong).is_err());
    let chain = close_finalized_create(root.path(), &source)
        .unwrap()
        .unwrap();
    assert_eq!(chain.identities(), std::slice::from_ref(&source));
    assert_eq!(
        close_finalized_create(root.path(), &source).unwrap(),
        Some(chain)
    );
}

#[test]
fn finalized_create_cleanup_preserves_competing_successors() {
    let root = secure_root();
    let (source, target, _) = retired_source_with_successor(root.path());
    let before = resolve_successor_chain(root.path(), &source).unwrap();
    assert_eq!(close_finalized_create(root.path(), &source).unwrap(), None);
    assert_eq!(
        resolve_successor_chain(root.path(), &source).unwrap(),
        before
    );
    complete_and_retire_generation(
        root.path(),
        &target,
        &request_digest(2),
        2,
        ManagedCreateLineageAdmission::Successor,
    );
    assert_eq!(close_finalized_create(root.path(), &source).unwrap(), None);
    let chain = close_finalized_create(root.path(), &target)
        .unwrap()
        .unwrap();
    assert_eq!(chain.identities(), &[source, target]);
}

#[test]
fn stopped_creation_without_a_ledger_does_not_fabricate_create_authority() {
    let tracked = secure_root();
    let stop = complete_generation(tracked.path());
    let legacy = secure_root();
    assert_eq!(close_stopped_creation(legacy.path(), &stop).unwrap(), None);
    assert!(!legacy.path().join(LEDGER_DIRECTORY).exists());
}

#[test]
fn stopped_creation_requires_finalization_and_uses_the_stored_create_key() {
    let root = secure_root();
    let stop = complete_generation(root.path());
    assert!(close_stopped_creation(root.path(), &stop).is_err());
    checkpoint_retirement_exact(root.path(), &stop).unwrap();
    assert!(close_stopped_creation(root.path(), &stop).is_err());
    finalize_retirement_exact(root.path(), &stop).unwrap();
    let other_generation = ManagedStopReceipt::from_request(
        &hmux_runtime_contract::ManagedStopRequest::new("stop-2", "session-1", "workspace-1")
            .unwrap()
            .with_expected_fence("principal-1", "runner-1", 7, "other-host", "terminal-1")
            .unwrap(),
        ManagedStopOutcome::Stopped,
        "managed_provider_stopped",
    )
    .unwrap();
    assert!(close_stopped_creation(root.path(), &other_generation).is_err());
    let chain = close_stopped_creation(root.path(), &stop).unwrap().unwrap();
    assert_eq!(chain.identities(), &[identity()]);
    assert_eq!(
        close_stopped_creation(root.path(), &stop).unwrap(),
        Some(chain)
    );
    assert_eq!(
        reserve_terminal_successor(root.path(), &identity(), || {
            panic!("the exact stopped creation cannot admit another successor")
        })
        .unwrap(),
        ManagedCreateSuccessorLedgerState::Closed
    );
}

#[test]
fn stopped_creation_preserves_an_admitted_successor_and_can_close_only_its_exact_tip() {
    let root = secure_root();
    let (source, target, stop) = retired_source_with_successor(root.path());
    let before = resolve_successor_chain(root.path(), &source).unwrap();
    assert!(close_stopped_creation(root.path(), &stop).is_err());
    assert_eq!(
        resolve_successor_chain(root.path(), &source).unwrap(),
        before
    );
    let target_stop = complete_and_retire_generation(
        root.path(),
        &target,
        &request_digest(2),
        2,
        ManagedCreateLineageAdmission::Successor,
    );
    assert!(close_stopped_creation(root.path(), &stop).is_err());
    let chain = close_stopped_creation(root.path(), &target_stop)
        .unwrap()
        .unwrap();
    assert_eq!(chain.identities(), &[source, target]);
    assert_eq!(chain.prior_stop_receipts(), &[stop]);
}

#[test]
fn retired_cleanup_requires_finalized_exact_generation_and_keeps_abandonment_separate() {
    let root = secure_root();
    let source = identity();
    assert!(
        close_retired_create(root.path(), &source, &fence())
            .unwrap()
            .is_none()
    );
    assert!(!root.path().join(LEDGER_DIRECTORY).exists());
    let ManagedCreateLedgerState::Prepared(mut reservation) = reserve(
        root.path(),
        source.workspace_id(),
        source.session_id(),
        source.idempotency_key(),
        &request_digest(1),
    )
    .unwrap() else {
        panic!("source must be prepared")
    };
    assert!(
        close_retired_create(root.path(), &source, &fence())
            .unwrap()
            .is_none()
    );
    reservation.checkpoint_pre_spawn_absence().unwrap();
    assert!(
        close_retired_create(root.path(), &source, &fence())
            .unwrap()
            .is_none()
    );
    let stop = complete_generation(root.path());
    assert!(
        close_retired_create(root.path(), &source, &fence())
            .unwrap()
            .is_none()
    );
    checkpoint_retirement_exact(root.path(), &stop).unwrap();
    assert!(
        close_retired_create(root.path(), &source, &fence())
            .unwrap()
            .is_none()
    );
    finalize_retirement_exact(root.path(), &stop).unwrap();
    assert!(!close_abandoned_create(root.path(), &source).unwrap());
    let chain = close_retired_create(root.path(), &source, &fence())
        .unwrap()
        .unwrap();
    assert_eq!(chain.identities(), &[source]);

    let root = secure_root();
    let source = identity();
    abandon_generation(root.path(), &source, &request_digest(1));
    assert!(
        close_retired_create(root.path(), &source, &fence())
            .unwrap()
            .is_none()
    );
    assert!(close_abandoned_create(root.path(), &source).unwrap());
}

#[test]
fn retired_cleanup_preserves_every_changed_fence_and_wrong_create_key() {
    let root = secure_root();
    retire(root.path());
    let source = identity();
    for changed in [
        ManagedCreateGenerationFence::new("other", "runner-1", 7, "host-1", "terminal-1"),
        ManagedCreateGenerationFence::new("principal-1", "other", 7, "host-1", "terminal-1"),
        ManagedCreateGenerationFence::new("principal-1", "runner-1", 8, "host-1", "terminal-1"),
        ManagedCreateGenerationFence::new("principal-1", "runner-1", 7, "other", "terminal-1"),
        ManagedCreateGenerationFence::new("principal-1", "runner-1", 7, "host-1", "other"),
    ] {
        assert!(
            close_retired_create(root.path(), &source, &changed.unwrap())
                .unwrap()
                .is_none()
        );
    }
    let wrong =
        ManagedCreateReconcileRequest::new("other", source.session_id(), source.workspace_id())
            .unwrap();
    assert!(close_retired_create(root.path(), &wrong, &fence()).is_err());
    assert!(matches!(
        reserve_terminal_successor(root.path(), &source, || Ok(successor_in_source_shard(
            &source,
            "after-refusal",
            &request_digest(2),
        )))
        .unwrap(),
        ManagedCreateSuccessorLedgerState::Created(_)
    ));
}

#[test]
fn retired_cleanup_closes_before_advance_and_replays_after_response_loss() {
    let root = secure_root();
    retire(root.path());
    let source = identity();
    let chain = close_retired_create(root.path(), &source, &fence())
        .unwrap()
        .unwrap();
    assert_eq!(chain.identities(), std::slice::from_ref(&source));
    assert_eq!(
        close_retired_create(root.path(), &source, &fence()).unwrap(),
        Some(chain)
    );
    assert_eq!(
        reserve_terminal_successor(root.path(), &source, || {
            panic!("closed exact generation cannot allocate a successor")
        })
        .unwrap(),
        ManagedCreateSuccessorLedgerState::Closed
    );
}

#[test]
fn retired_cleanup_never_follows_a_previously_admitted_successor() {
    let root = secure_root();
    retire(root.path());
    let source = identity();
    let target = successor_in_source_shard(&source, "prior-advance", &request_digest(2));
    assert!(matches!(
        reserve_terminal_successor(root.path(), &source, || Ok(target.clone())).unwrap(),
        ManagedCreateSuccessorLedgerState::Created(_)
    ));
    let before = resolve_successor_chain(root.path(), &source).unwrap();
    assert!(
        close_retired_create(root.path(), &source, &fence())
            .unwrap()
            .is_none()
    );
    assert_eq!(
        resolve_successor_chain(root.path(), &source).unwrap(),
        before
    );
    assert_eq!(
        reserve_terminal_successor(root.path(), &source, || panic!("reuse successor")).unwrap(),
        ManagedCreateSuccessorLedgerState::Existing(target)
    );
}

#[test]
fn retired_cleanup_and_advance_have_one_atomic_winner() {
    for _ in 0..16 {
        let root = secure_root();
        retire(root.path());
        let source = identity();
        let start = Arc::new(Barrier::new(3));
        let cleanup = {
            let path = root.path().to_path_buf();
            let source = source.clone();
            let start = Arc::clone(&start);
            thread::spawn(move || {
                start.wait();
                close_retired_create(&path, &source, &fence()).unwrap()
            })
        };
        let advance = {
            let path = root.path().to_path_buf();
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
        assert!(matches!(
            (cleanup.join().unwrap(), advance.join().unwrap()),
            (Some(_), ManagedCreateSuccessorLedgerState::Closed)
                | (None, ManagedCreateSuccessorLedgerState::Created(_))
        ));
    }
}

fn retired_source_with_successor(
    root: &Path,
) -> (
    ManagedCreateReconcileRequest,
    ManagedCreateReconcileRequest,
    ManagedStopReceipt,
) {
    let source = identity();
    let index = shard_index(&logical_key(source.workspace_id(), source.session_id())).unwrap();
    let target = identity_in_shard(source.workspace_id(), index, "retired-target");
    let stop = complete_and_retire_generation(
        root,
        &source,
        &request_digest(1),
        1,
        ManagedCreateLineageAdmission::Root,
    );
    assert!(matches!(
        reserve_terminal_successor(root, &source, || {
            Ok(successor_for_target(&target, &request_digest(2)))
        })
        .unwrap(),
        ManagedCreateSuccessorLedgerState::Created(_)
    ));
    (source, target, stop)
}

#[test]
fn origin_resolution_does_not_reserve_unknowns_or_close_unborn_and_retired_successors() {
    let root = secure_root();
    let unknown = identity();
    assert_eq!(
        resolve_create_origin(root.path(), &unknown).unwrap(),
        unknown
    );
    assert!(!root.path().join(LEDGER_DIRECTORY).exists());
    let (source, target, _) = retired_source_with_successor(root.path());
    assert_eq!(resolve_create_origin(root.path(), &source).unwrap(), source);
    assert_eq!(resolve_create_origin(root.path(), &target).unwrap(), source);
    complete_and_retire_generation(
        root.path(),
        &target,
        &request_digest(2),
        2,
        ManagedCreateLineageAdmission::Successor,
    );
    assert_eq!(resolve_create_origin(root.path(), &target).unwrap(), source);
    assert!(matches!(
        reserve_terminal_successor(root.path(), &target, || {
            Ok(successor_in_source_shard(
                &target,
                "after-origin-read",
                &request_digest(3),
            ))
        })
        .unwrap(),
        ManagedCreateSuccessorLedgerState::Created(_)
    ));
}

#[test]
fn retired_cleanup_returns_runtime_ancestry_only_for_the_exact_closed_tip() {
    let root = secure_root();
    let (source, target, stop) = retired_source_with_successor(root.path());
    let target_stop = complete_and_retire_generation(
        root.path(),
        &target,
        &request_digest(2),
        2,
        ManagedCreateLineageAdmission::Successor,
    );
    let source_fence = ManagedCreateGenerationFence::new(
        stop.runner_principal(),
        stop.runner_instance(),
        stop.channel_epoch(),
        stop.host_instance_id(),
        stop.terminal_epoch(),
    )
    .unwrap();
    // Even an already-retired successor is outside the older approval.
    assert!(
        close_retired_create(root.path(), &source, &source_fence)
            .unwrap()
            .is_none()
    );
    let target_fence = ManagedCreateGenerationFence::new(
        target_stop.runner_principal(),
        target_stop.runner_instance(),
        target_stop.channel_epoch(),
        target_stop.host_instance_id(),
        target_stop.terminal_epoch(),
    )
    .unwrap();
    let chain = close_retired_create(root.path(), &target, &target_fence)
        .unwrap()
        .unwrap();
    assert_eq!(chain.identities(), &[source, target.clone()]);
    assert_eq!(chain.prior_stop_receipts(), &[stop]);
    assert_eq!(
        close_retired_create(root.path(), &target, &target_fence).unwrap(),
        Some(chain)
    );
    assert_eq!(
        reserve_terminal_successor(root.path(), &target, || {
            panic!("closed tip cannot allocate another successor")
        })
        .unwrap(),
        ManagedCreateSuccessorLedgerState::Closed
    );
}
