use super::*;

#[test]
fn a_busy_writer_keeps_its_pending_operation_and_result() {
    let fixture = pending_fixture(SELECTED_BUILD_ACTION);
    let catalog = crate::LocalSessionCatalog::new(fixture.root.path());
    let Some(StandaloneUpgradeProgress::Pending(pending)) = read_successor(
        &catalog,
        fixture.source.generation(),
        fixture.source.provider_process(),
    )
    .unwrap() else {
        panic!("fixture must be pending")
    };
    let checkpoint = fixture.operation.operation_checkpoint().cloned();
    assert!(matches!(
        pending.settle_for_close(&catalog).unwrap(),
        StandaloneUpgradeProgress::Pending(_)
    ));
    assert_eq!(
        fixture.operation.operation_checkpoint(),
        checkpoint.as_ref()
    );
    assert!(
        read_completed(
            &catalog,
            fixture.operation.recovery_id(),
            SELECTED_BUILD_ACTION
        )
        .unwrap()
        .is_none()
    );
}

#[test]
fn caller_loss_publishes_the_saved_exact_target_and_replays_after_compaction() {
    let fixture = pending_fixture(SELECTED_BUILD_ACTION);
    let catalog = crate::LocalSessionCatalog::new(fixture.root.path());
    let Some(StandaloneUpgradeProgress::Pending(pending)) = read_successor(
        &catalog,
        fixture.source.generation(),
        fixture.source.provider_process(),
    )
    .unwrap() else {
        panic!("fixture must be pending")
    };
    drop(fixture.operation);
    let StandaloneUpgradeProgress::Completed(successor) =
        pending.settle_for_close(&catalog).unwrap()
    else {
        panic!("must recover the started target");
    };
    assert_eq!(successor.target, fixture.target);
    let collected = garbage_collect_completed(
        fixture.root.path(),
        RecoveryJournalGcPolicy {
            minimum_completed_age: std::time::Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(collected.removed_completed_records, 1);
    let StandaloneUpgradeProgress::Completed(replay) = pending.settle_for_close(&catalog).unwrap()
    else {
        panic!("must replay the same completed target");
    };
    assert_eq!(replay, successor);
}

#[test]
fn absence_without_a_result_never_finishes_or_cancels_the_upgrade() {
    let fixture = prepared_fixture(SELECTED_BUILD_ACTION);
    let catalog = crate::LocalSessionCatalog::new(fixture.root.path());
    let Some(StandaloneUpgradeProgress::Pending(pending)) = read_successor(
        &catalog,
        fixture.source.generation(),
        fixture.source.provider_process(),
    )
    .unwrap() else {
        panic!("fixture must be pending")
    };
    let id = fixture.operation.recovery_id().to_string();
    drop(fixture.operation);
    assert!(matches!(
        pending.settle_for_close(&catalog).unwrap(),
        StandaloneUpgradeProgress::Pending(_)
    ));
    assert!(
        read_completed(&catalog, &id, SELECTED_BUILD_ACTION)
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        read_successor(
            &catalog,
            fixture.source.generation(),
            fixture.source.provider_process()
        )
        .unwrap(),
        Some(StandaloneUpgradeProgress::Pending(_))
    ));
}
