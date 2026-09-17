use super::*;
use dure_app::SessionCheckoutOwnerV1;
use hmux_client::recovery_journal::{
    self, RECOVERY_COMPLETION_ACKNOWLEDGED_CODE, RecoveryJournalGcPolicy,
};

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn refusal_survives_gc_before_compensation_and_cannot_relaunch_after_reconnect() {
    let fixture = Fixture::new().await;
    refuse_without_compensation(&fixture).await;
    let catalog = LocalSessionCatalog::new(&fixture.discovery);
    let operation = OperationIdV1::new("ordinary-create").unwrap();
    fixture.runtime.store.close().await;

    // Lose the caller after durable refusal but before its SQL/Git compensation.
    recovery_journal::garbage_collect_completed(&fixture.discovery, aggressive_gc()).unwrap();
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    crate::reconcile_checkout_users(
        store.clone(),
        fixture.executable.clone(),
        fixture.discovery.clone(),
        fixture.registration.clone(),
    )
    .await
    .unwrap();
    let after = (fixture.claims(), fixture.removal("after-gc"));
    let runtime = CheckoutSessionRuntime::at_root(
        store.clone(),
        fixture.executable.clone(),
        fixture.discovery.clone(),
    )
    .unwrap();
    let replay = runtime
        .create_standalone(operation, fixture.request())
        .await;
    let relaunched = match replay {
        Err(_) => false,
        Ok(created) => {
            let descriptor = created.session().descriptor();
            crate::close_standalone_session(
                store.clone(),
                catalog,
                descriptor.workspace_id.clone(),
                descriptor.session_id.clone(),
                Some(descriptor.terminal_epoch.clone()),
                Duration::from_secs(3),
            )
            .await
            .unwrap();
            true
        }
    };
    store.close().await;
    assert_eq!((after, relaunched), ((0, Ok(())), false));
    assert_eq!(
        recovery_journal::inspect_existing(&fixture.discovery)
            .unwrap()
            .operation_records,
        0
    );
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn closed_refusal_reclaims_completion_after_interruption_before_acknowledgement() {
    let fixture = Fixture::new().await;
    let pending = refuse_without_compensation(&fixture).await;
    let SessionCheckoutOwnerV1::Recovery { recovery_id } = &pending.binding.identity.owner else {
        panic!("pending operation owns its checkout");
    };
    let admitted = fixture
        .runtime
        .store
        .begin_session_checkout_claim_close(&pending.binding.identity, &pending.binding.claim_id)
        .await
        .unwrap()
        .unwrap();
    crate::cleanup::finish_checkout_cleanup(&fixture.runtime.store, admitted)
        .await
        .unwrap();
    assert_eq!(fixture.claims(), 0);
    assert_eq!(
        fixture
            .runtime
            .store
            .session_checkout(&pending.binding.identity)
            .await
            .unwrap()
            .unwrap()
            .admission,
        SessionCheckoutAdmissionV1::Closed
    );
    fixture.runtime.store.close().await;
    let gc =
        recovery_journal::garbage_collect_completed(&fixture.discovery, aggressive_gc()).unwrap();
    assert_eq!(gc.removed_completed_records, 0);
    assert_eq!(gc.remaining.completed_records, 1);
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    let unavailable = fixture
        .database
        .parent()
        .unwrap()
        .join("unavailable-runtime");
    assert!(!unavailable.exists());
    let runtime =
        CheckoutSessionRuntime::at_root(store.clone(), unavailable, fixture.discovery.clone())
            .unwrap();
    runtime
        .reconcile_creation_retention(recovery_id)
        .await
        .unwrap();
    assert_eq!(
        recovery_journal::inspect_existing(&fixture.discovery)
            .unwrap()
            .operation_records,
        0
    );
    let error = runtime
        .create_standalone(
            OperationIdV1::new("ordinary-create").unwrap(),
            fixture.request(),
        )
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains(RECOVERY_COMPLETION_ACKNOWLEDGED_CODE)
    );
    runtime
        .reconcile_creation_retention(recovery_id)
        .await
        .unwrap();
    store.close().await;
    assert_eq!(
        (fixture.claims(), fixture.removal("after-ack")),
        (0, Ok(()))
    );
}

async fn refuse_without_compensation(fixture: &Fixture) -> SessionCheckoutRecordV1 {
    let blocker = fixture.blocker();
    let catalog = LocalSessionCatalog::new(&fixture.discovery);
    let operation = OperationIdV1::new("ordinary-create").unwrap();
    let Creation::Pending(prepared) = prepare(&catalog, &operation, fixture.request()).unwrap()
    else {
        panic!("new creation must be pending");
    };
    let (reservation, request) = *prepared;
    fixture
        .runtime
        .retain_creation_request(reservation.recovery_id(), &request)
        .await
        .unwrap();
    let failure = super::super::execution::execute(
        catalog,
        fixture.runtime.standalone_creator.clone(),
        reservation,
        request,
    )
    .unwrap_err();
    assert!(
        failure
            .to_string()
            .contains("hmux_standalone_recovery_name_conflict")
    );
    let record = fixture.record().await;
    fixture.retire_blocker(blocker);
    record
}

fn aggressive_gc() -> RecoveryJournalGcPolicy {
    RecoveryJournalGcPolicy {
        minimum_completed_age: Duration::ZERO,
        maximum_completed_records: 0,
        maximum_completed_bytes: 0,
        ..RecoveryJournalGcPolicy::default()
    }
}
