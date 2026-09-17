use super::*;
use crate::recovery_journal::standalone_broker_admission::{
    OPERATION_NOT_PENDING, StandaloneBrokerAdmission,
};

fn pending(fixture: &UpgradeFixture) -> Box<PendingStandaloneUpgrade> {
    let Some(StandaloneUpgradeProgress::Pending(pending)) = read_successor(
        &crate::LocalSessionCatalog::new(fixture.root.path()),
        fixture.source.generation(),
        fixture.source.provider_process(),
    )
    .unwrap() else {
        panic!("fixture must have pending intent");
    };
    pending
}

#[test]
fn published_cancellation_blocks_the_broker_before_primary_completion_and_survives_collection() {
    for action in [CURRENT_BUILD_ACTION, SELECTED_BUILD_ACTION] {
        let mut fixture = prepared_fixture_with_binding(action, true);
        let pending = pending(&fixture);
        let catalog = crate::LocalSessionCatalog::new(fixture.root.path());
        let reserved = fixture.operation.record.clone();
        let launch = StandaloneBrokerAdmission::acquire(fixture.root.path()).unwrap();
        super::super::cancellation::complete(&mut fixture.operation, &launch).unwrap();
        // Crash cut: the compact decision is durable, but the original record
        // still says Reserved. Use the real journal writer, not a corrupt file.
        journal::write_record(
            &fixture.operation.directory,
            &fixture.operation.record_path,
            &reserved,
        )
        .unwrap();
        drop(fixture.operation);
        drop(launch);
        assert!(matches!(
            read_successor(
                &catalog,
                fixture.source.generation(),
                fixture.source.provider_process()
            )
            .unwrap(),
            Some(StandaloneUpgradeProgress::Pending(_))
        ));
        let admission = StandaloneBrokerAdmission::acquire(fixture.root.path())
            .unwrap()
            .admit(&fixture.create);
        let Err(error) = admission else {
            panic!("partial publication must already prevent a delayed launch");
        };
        assert_eq!(error.code(), OPERATION_NOT_PENDING);
        assert!(matches!(
            pending.settle_for_close(&catalog).unwrap(),
            StandaloneUpgradeProgress::Cancelled
        ));
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
        assert!(
            read_completed(&catalog, &reserved.recovery_id, action)
                .err()
                .unwrap()
                .starts_with(super::super::cancellation::CANCELLED_CODE)
        );
        let rebound = reserve_prepared(
            fixture.root.path(),
            PreparedRecoveryIdentity {
                recovery_id: reserved.recovery_id.clone(),
                source_session_id: "new-source".into(),
                source_workspace_id: "new-workspace".into(),
                action,
                legacy_request_fingerprint: None,
            },
            Some("{}".into()),
        );
        assert!(
            rebound
                .err()
                .unwrap()
                .starts_with("hmux_recovery_idempotency_conflict:")
        );
    }
}

#[test]
fn a_busy_broker_preserves_pending_until_the_same_launch_boundary_is_released() {
    let fixture = prepared_fixture_with_binding(SELECTED_BUILD_ACTION, true);
    let pending = pending(&fixture);
    let catalog = crate::LocalSessionCatalog::new(fixture.root.path());
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
}
