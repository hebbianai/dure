use super::*;
use hmux_client::recovery_journal::{self, RECOVERY_COMPLETION_ACKNOWLEDGED_CODE};

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn pending_retirement_before_result_checkpoint_reclaims_its_journal() {
    retired_creation_reclaims_journal(false).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn pending_retirement_after_result_checkpoint_reclaims_its_journal() {
    retired_creation_reclaims_journal(true).await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn pending_retirement_does_not_release_a_claim_while_its_writer_is_admitted() {
    let fixture = Fixture::new().await;
    let (reservation, created) = pending_creation(&fixture).await;
    let target = CompletedStandaloneTarget::from_created(
        created.receipt().clone(),
        created.session().descriptor(),
    )
    .unwrap();
    assert_eq!(
        created.abandon_unpresented_creation().unwrap().state,
        SessionRetirementReceiptState::RetirementArmed
    );
    fixture.wait_for_retirement(&target).await;
    let error = crate::reconcile_checkout_users(
        fixture.runtime.store.clone(),
        fixture.executable.clone(),
        fixture.discovery.clone(),
        fixture.registration.clone(),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("hmux_recovery_busy"));
    assert_eq!(fixture.claims(), 1);
    assert_eq!(
        fixture.record().await.admission,
        SessionCheckoutAdmissionV1::Open
    );
    drop(reservation);
    fixture.reconcile().await;
    assert_eq!(fixture.claims(), 0);
    assert_eq!(
        recovery_journal::inspect_existing(&fixture.discovery)
            .unwrap()
            .operation_records,
        0
    );
    fixture.runtime.store.close().await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn completed_retirement_before_publication_is_cleaned_by_create_retry() {
    let fixture = Fixture::new().await;
    let (created, _) = super::retention::complete_without_publication(&fixture).await;
    let target = CompletedStandaloneTarget::from_created(
        created.receipt().clone(),
        created.session().descriptor(),
    )
    .unwrap();
    assert_eq!(
        created.abandon_unpresented_creation().unwrap().state,
        SessionRetirementReceiptState::RetirementArmed
    );
    fixture.wait_for_retirement(&target).await;
    fixture.runtime.store.close().await;
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
        .create_standalone(
            OperationIdV1::new("ordinary-create").unwrap(),
            fixture.request(),
        )
        .await
        .unwrap_err();
    let journal = recovery_journal::inspect_existing(&fixture.discovery).unwrap();
    let repeated = runtime
        .create_standalone(
            OperationIdV1::new("ordinary-create").unwrap(),
            fixture.request(),
        )
        .await
        .unwrap_err();
    let observed = (
        fixture.claims(),
        journal.pending_records,
        journal.completed_records,
        repeated
            .to_string()
            .contains(RECOVERY_COMPLETION_ACKNOWLEDGED_CODE),
    );
    store.close().await;
    assert_eq!(
        observed,
        (0, 0, 0, true),
        "completed and pending retry errors must share compensation"
    );
}

async fn retired_creation_reclaims_journal(checkpointed: bool) {
    let fixture = Fixture::new().await;
    let operation = OperationIdV1::new("ordinary-create").unwrap();
    let (mut reservation, created) = pending_creation(&fixture).await;
    let target = CompletedStandaloneTarget::from_created(
        created.receipt().clone(),
        created.session().descriptor(),
    )
    .unwrap();
    if checkpointed {
        reservation
            .checkpoint_replacement_receipt(serde_json::to_string(&target).unwrap())
            .unwrap();
    }
    drop(reservation);
    assert_eq!(
        created.abandon_unpresented_creation().unwrap().state,
        SessionRetirementReceiptState::RetirementArmed
    );
    fixture.wait_for_retirement(&target).await;
    fixture.runtime.store.close().await;

    let unavailable = fixture
        .database
        .parent()
        .unwrap()
        .join("unavailable-runtime");
    assert!(!unavailable.exists());
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    crate::reconcile_checkout_users(
        store.clone(),
        unavailable.clone(),
        fixture.discovery.clone(),
        fixture.registration.clone(),
    )
    .await
    .unwrap();
    let journal = recovery_journal::inspect_existing(&fixture.discovery).unwrap();
    let runtime =
        CheckoutSessionRuntime::at_root(store.clone(), unavailable, fixture.discovery.clone())
            .unwrap();
    let error = runtime
        .create_standalone(operation, fixture.request())
        .await
        .unwrap_err();
    let observed = (
        fixture.claims(),
        journal.pending_records,
        journal.completed_records,
        error
            .to_string()
            .contains(RECOVERY_COMPLETION_ACKNOWLEDGED_CODE),
    );
    store.close().await;
    assert_eq!(
        observed,
        (0, 0, 0, true),
        "a retired operation must complete before its claim is released"
    );
    assert_eq!(fixture.removal("after-pending-retirement"), Ok(()));
}

async fn pending_creation(fixture: &Fixture) -> (RecoveryReservation, CreatedStandaloneSession) {
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
    let created = fixture.runtime.standalone_creator.create(request).unwrap();
    (reservation, created)
}
