use super::*;
use dure_app::SessionCheckoutOwnerV1;

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn completed_journal_replay_publishes_the_same_claim_without_another_launcher() {
    let fixture = Fixture::new().await;
    let (created, before) = complete_without_publication(&fixture).await;
    fixture.runtime.store.close().await;
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    let missing = fixture.database.parent().unwrap().join("missing-runtime");
    assert!(!missing.exists());
    let runtime =
        CheckoutSessionRuntime::at_root(store.clone(), missing, fixture.discovery.clone()).unwrap();
    let replayed = runtime
        .create_standalone(
            OperationIdV1::new("ordinary-create").unwrap(),
            fixture.request(),
        )
        .await
        .unwrap();
    assert_eq!(replayed.receipt(), created.receipt());
    assert_eq!(
        replayed.session().descriptor(),
        created.session().descriptor()
    );
    let current = store
        .session_checkout_registration(&before.binding.claim_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.binding.claim_id, before.binding.claim_id);
    assert!(matches!(
        current.binding.identity.owner,
        SessionCheckoutOwnerV1::Standalone { .. }
    ));
    assert!(current.close_payload.is_some());
    close(&store, &fixture, &replayed).await;
    store.close().await;
    assert_eq!(fixture.claims(), 0);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn transient_launcher_failure_retains_one_pending_claim_then_transfers_it_on_retry() {
    let fixture = Fixture::new().await;
    let missing = fixture.database.parent().unwrap().join("missing-runtime");
    assert!(!missing.exists());
    let unavailable = CheckoutSessionRuntime::at_root(
        fixture.runtime.store.clone(),
        missing,
        fixture.discovery.clone(),
    )
    .unwrap();
    let error = unavailable
        .create_standalone(
            OperationIdV1::new("ordinary-create").unwrap(),
            fixture.request(),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, SessionCheckoutError::Runtime(ref error) if !error.is_standalone_recovery_terminal_refusal())
    );
    let pending = fixture.record().await;
    assert!(matches!(
        pending.binding.identity.owner,
        SessionCheckoutOwnerV1::Recovery { .. }
    ));
    fixture.reconcile().await;
    assert_eq!(fixture.record().await, pending);
    assert_eq!(
        fixture.removal("remove-pending"),
        Err("checkout_use_in_use")
    );
    fixture.runtime.store.close().await;
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    let runtime = CheckoutSessionRuntime::at_root(
        store.clone(),
        fixture.executable.clone(),
        fixture.discovery.clone(),
    )
    .unwrap();
    let created = runtime
        .create_standalone(
            OperationIdV1::new("ordinary-create").unwrap(),
            fixture.request(),
        )
        .await
        .unwrap();
    let claims = read_git_checkout_claims(&fixture.registration).unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].claim_id, pending.binding.claim_id);
    close(&store, &fixture, &created).await;
    store.close().await;
    assert_eq!(fixture.claims(), 0);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn late_pending_owner_cleanup_cannot_release_a_published_session_claim() {
    let fixture = Fixture::new().await;
    let (created, pending) = complete_without_publication(&fixture).await;
    let SessionCheckoutOwnerV1::Recovery { recovery_id } = &pending.binding.identity.owner else {
        panic!("pending claim must belong to its journal");
    };
    fixture
        .runtime
        .publish_creation_session(recovery_id, &created)
        .await
        .unwrap();
    let published = fixture.record().await;
    assert_eq!(published.binding.claim_id, pending.binding.claim_id);
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
    super::super::reconcile_retention(
        &fixture.runtime.store,
        &LocalSessionCatalog::new(&fixture.discovery),
        pending,
    )
    .await
    .unwrap();
    assert_eq!(fixture.record().await, published);
    assert_eq!(fixture.claims(), 1);
    fixture.reconcile().await;
    assert_eq!(fixture.claims(), 0);
    fixture.runtime.store.close().await;
}

pub(super) async fn complete_without_publication(
    fixture: &Fixture,
) -> (CreatedStandaloneSession, SessionCheckoutRecordV1) {
    let catalog = LocalSessionCatalog::new(&fixture.discovery);
    let Creation::Pending(prepared) = prepare(
        &catalog,
        &OperationIdV1::new("ordinary-create").unwrap(),
        fixture.request(),
    )
    .unwrap() else {
        panic!("new creation must be pending");
    };
    let (reservation, request) = *prepared;
    fixture
        .runtime
        .retain_creation_request(reservation.recovery_id(), &request)
        .await
        .unwrap();
    let record = fixture.record().await;
    assert!(matches!(
        record.binding.identity.owner,
        SessionCheckoutOwnerV1::Recovery { .. }
    ));
    let created = super::super::execution::execute(
        catalog,
        fixture.runtime.standalone_creator.clone(),
        reservation,
        request,
    )
    .unwrap();
    assert_eq!(fixture.record().await, record);
    (created, record)
}

pub(super) async fn close(
    store: &SqliteDomainStore,
    fixture: &Fixture,
    created: &CreatedStandaloneSession,
) {
    let descriptor = created.session().descriptor();
    crate::close_standalone_session(
        store.clone(),
        LocalSessionCatalog::new(&fixture.discovery),
        descriptor.workspace_id.clone(),
        descriptor.session_id.clone(),
        Some(descriptor.terminal_epoch.clone()),
        Duration::from_secs(3),
    )
    .await
    .unwrap();
}
