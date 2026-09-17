use super::*;
use crate::LocalSessionCatalog;
use crate::recovery_journal::standalone_broker_admission::StandaloneBrokerAdmission;

fn catalog(fixture: &UpgradeFixture) -> LocalSessionCatalog {
    LocalSessionCatalog::with_read_only_discovery_roots(
        fixture.root.path().join("unused-primary"),
        vec![fixture.root.path().to_path_buf()],
    )
    .unwrap()
}

fn pending(
    fixture: &UpgradeFixture,
    catalog: &LocalSessionCatalog,
) -> Box<PendingStandaloneUpgrade> {
    let Some(StandaloneUpgradeProgress::Pending(pending)) = read_successor(
        catalog,
        fixture.source.generation(),
        fixture.source.provider_process(),
    )
    .unwrap() else {
        panic!("the configured compatibility root owns the pending operation");
    };
    pending
}

fn collect(root: &std::path::Path) {
    let report = garbage_collect_completed(
        root,
        RecoveryJournalGcPolicy {
            minimum_completed_age: std::time::Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(report.removed_completed_records, 1);
}

#[test]
fn compatibility_close_uses_the_original_writer_and_broker_locks_through_collection() {
    for action in [CURRENT_BUILD_ACTION, SELECTED_BUILD_ACTION] {
        let fixture = prepared_fixture_with_binding(action, true);
        let catalog = catalog(&fixture);
        let pending = pending(&fixture, &catalog);
        assert!(matches!(
            pending.settle_for_close(&catalog).unwrap(),
            StandaloneUpgradeProgress::Pending(_)
        ));
        drop(fixture.operation);
        let broker = StandaloneBrokerAdmission::acquire(fixture.root.path()).unwrap();
        assert!(matches!(
            pending.settle_for_close(&catalog).unwrap(),
            StandaloneUpgradeProgress::Pending(_)
        ));
        drop(broker);
        assert!(matches!(
            pending.settle_for_close(&catalog).unwrap(),
            StandaloneUpgradeProgress::Cancelled
        ));
        collect(fixture.root.path());
        assert!(matches!(
            pending.settle_for_close(&catalog).unwrap(),
            StandaloneUpgradeProgress::Cancelled
        ));
        assert!(matches!(
            read_successor(
                &catalog,
                fixture.source.generation(),
                fixture.source.provider_process()
            )
            .unwrap(),
            Some(StandaloneUpgradeProgress::Cancelled)
        ));
        assert!(!catalog.discovery_root().exists());
    }
}

#[test]
fn compatibility_caller_loss_resolves_the_same_target_before_and_after_collection() {
    for action in [CURRENT_BUILD_ACTION, SELECTED_BUILD_ACTION] {
        let fixture = pending_fixture(action);
        let catalog = catalog(&fixture);
        let pending = pending(&fixture, &catalog);
        drop(fixture.operation);
        let assert_target = |progress| {
            let StandaloneUpgradeProgress::Completed(successor) = progress else {
                panic!("an existing target must be reconciled, never cancelled");
            };
            assert_eq!(successor.target, fixture.target);
        };
        assert_target(pending.settle_for_close(&catalog).unwrap());
        collect(fixture.root.path());
        assert_target(pending.settle_for_close(&catalog).unwrap());
        assert_target(
            read_successor(
                &catalog,
                fixture.source.generation(),
                fixture.source.provider_process(),
            )
            .unwrap()
            .unwrap(),
        );
        assert!(!catalog.discovery_root().exists());
    }
}

#[test]
fn configured_history_is_readable_without_authorizing_fresh_creation_there() {
    let fixture = pending_fixture(SELECTED_BUILD_ACTION);
    let catalog = catalog(&fixture);
    let saved = serde_json::to_string(&fixture.target).unwrap();
    assert_eq!(
        crate::CompletedStandaloneTarget::from_recovery_checkpoint(
            &catalog,
            &fixture.create,
            &saved,
        )
        .unwrap(),
        fixture.target
    );
    assert!(
        crate::validate_standalone_recovery_receipt(
            &catalog,
            &fixture.create,
            fixture.target.receipt(),
        )
        .is_err()
    );
    let unconfigured = LocalSessionCatalog::new(catalog.discovery_root());
    assert!(
        crate::CompletedStandaloneTarget::from_recovery_checkpoint(
            &unconfigured,
            &fixture.create,
            &saved,
        )
        .is_err()
    );
    assert!(!catalog.discovery_root().exists());
}

#[test]
fn following_completed_edges_keeps_creation_and_legacy_lookup_scopes() {
    let fixture = pending_fixture(SELECTED_BUILD_ACTION);
    let primary = fixture.root.path().join("primary");
    let legacy = vec![
        fixture.root.path().join("legacy-one"),
        fixture.root.path().join("legacy-two"),
    ];
    let catalog =
        LocalSessionCatalog::with_read_only_discovery_roots(&primary, legacy.clone()).unwrap();
    let followed = catalog.including_completed_standalone_target(&fixture.target);
    assert_eq!(followed.discovery_root(), primary);
    assert_eq!(
        followed.discovery_paths().collect::<Vec<_>>(),
        vec![
            primary.as_path(),
            legacy[0].as_path(),
            legacy[1].as_path(),
            fixture.root.path()
        ],
    );
    assert_eq!(
        followed
            .including_completed_standalone_target(&fixture.target)
            .discovery_paths()
            .count(),
        4,
    );
    assert!(
        crate::validate_standalone_recovery_receipt(
            &followed,
            &fixture.create,
            fixture.target.receipt(),
        )
        .is_err()
    );
    assert!(!primary.exists());
    assert!(legacy.iter().all(|path| !path.exists()));
}

#[test]
fn compatibility_retirement_discards_launch_inputs_but_preserves_the_completed_edge() {
    let mut fixture = pending_fixture(SELECTED_BUILD_ACTION);
    let catalog = catalog(&fixture);
    fixture.operation.complete(fixture.completion).unwrap();
    drop(fixture.operation);
    retire_launch_inputs(
        &catalog,
        fixture.target.generation(),
        fixture.target.provider_process(),
    )
    .unwrap();
    assert!(
        read_compacted_launch(
            &fixture.root.path().join(".recovery"),
            fixture.target.generation(),
            fixture.target.provider_process(),
        )
        .unwrap()
        .is_none()
    );
    collect(fixture.root.path());
    let Some(StandaloneUpgradeProgress::Completed(successor)) = read_successor(
        &catalog,
        fixture.source.generation(),
        fixture.source.provider_process(),
    )
    .unwrap() else {
        panic!("retirement must preserve the immutable source-to-target edge");
    };
    assert_eq!(successor.target, fixture.target);
    assert!(!catalog.discovery_root().exists());
}

#[test]
fn operation_lookup_preserves_pending_writer_and_completion_across_namespace_change() {
    for action in [CURRENT_BUILD_ACTION, SELECTED_BUILD_ACTION] {
        let fixture = pending_fixture(action);
        let catalog = catalog(&fixture);
        let id = fixture.operation.recovery_id().to_string();
        let checkpoint = fixture.operation.operation_checkpoint().cloned();
        let Some(StandaloneUpgradeOperation::Pending(pending)) =
            read_operation(&catalog, &id, action).unwrap()
        else {
            panic!("the pending operation must be visible outside the current primary");
        };
        assert_eq!(pending.operation_root(), fixture.root.path());
        assert!(
            pending
                .reopen()
                .unwrap_err()
                .starts_with("hmux_recovery_busy:")
        );
        drop(fixture.operation);
        let Some(RecoveryReservationState::Pending(mut original)) = pending.reopen().unwrap()
        else {
            panic!("reopen must retain the existing operation");
        };
        assert_eq!(original.operation_checkpoint(), checkpoint.as_ref());
        original.complete(fixture.completion).unwrap();
        drop(original);
        let assert_completion = || {
            let Some(StandaloneUpgradeOperation::Rehosted(completed)) =
                read_operation(&catalog, &id, action).unwrap()
            else {
                panic!("the same operation must expose its completed target");
            };
            assert_eq!(completed.successor.target, fixture.target);
            assert_eq!(completed.source, fixture.source);
        };
        assert_completion();
        collect(fixture.root.path());
        assert_completion();
        assert!(!catalog.discovery_root().exists());
    }
}

#[test]
fn operation_lookup_never_picks_between_two_pending_namespace_owners() {
    let first = prepared_fixture(SELECTED_BUILD_ACTION);
    let second = prepared_fixture(SELECTED_BUILD_ACTION);
    assert_eq!(
        first.operation.recovery_id(),
        second.operation.recovery_id()
    );
    let catalog = LocalSessionCatalog::with_read_only_discovery_roots(
        first.root.path(),
        vec![second.root.path().to_path_buf()],
    )
    .unwrap();
    let result = read_operation(
        &catalog,
        first.operation.recovery_id(),
        SELECTED_BUILD_ACTION,
    );
    assert!(
        result
            .err()
            .is_some_and(|error| error.starts_with("hmux_recovery_idempotency_conflict:"))
    );
    assert!(first.operation.operation_checkpoint().is_some());
    assert!(second.operation.operation_checkpoint().is_some());
}
