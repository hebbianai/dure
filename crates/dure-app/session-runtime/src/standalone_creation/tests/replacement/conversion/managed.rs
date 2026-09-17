use super::*;
use hmux_client::{
    ExitedSessionRetirementGeneration, ManagedCreateAdvanceResolution,
    ManagedCreateReconcileRequest, ManagedCreateRequest, PermissionMode,
};

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn managed_conversion_replays_a_legacy_prepared_selection_after_target_transfer() {
    let fixture = Fixture::new().await;
    let (original, _) = legacy_replacement(&fixture).await;
    let recovery_id = "legacy-managed-conversion";
    let selected = fixture
        .runtime
        .select_recovery_checkout(None, &fixture.checkout, recovery_id)
        .await
        .unwrap();
    let retained = fixture
        .runtime
        .retain_checkout_for_recovery(selected, recovery_id.into())
        .await
        .unwrap();
    let source = original.session().descriptor();
    LocalSessionCatalog::new(&fixture.discovery)
        .stop_completed_standalone_target(
            &ExitedSessionRetirementGeneration::from_descriptor(source).unwrap(),
            &source.provider_process,
            Duration::from_secs(3),
        )
        .unwrap();
    let request = target_request(&fixture);
    let created = current(
        fixture
            .runtime
            .create_replacement_and_advance(Some(retained.clone()), request.clone())
            .await
            .unwrap(),
    );
    let target = created.session().descriptor().clone();
    assert_eq!(fixture.claims(), 1);
    assert_eq!(
        fixture.removal("remove-managed-conversion"),
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
    // An old canonical payload has no source_checkout field. Read the same
    // immutable claim from SQL, not the now-absent source or its cwd.
    let frozen = runtime
        .retained_recovery_checkout(recovery_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frozen, retained);
    let replayed = current(
        runtime
            .create_replacement_and_advance(Some(frozen), request.clone())
            .await
            .unwrap(),
    );
    assert_eq!(replayed.session().descriptor(), &target);
    retention::close(&store, &fixture, &original).await;
    assert_eq!(fixture.claims(), 1);
    assert_eq!(
        probe_local_process_generation(&target.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    close_target(&runtime, &request).await;
    assert_eq!(fixture.claims(), 0);
    assert!(
        runtime
            .create_replacement_and_advance(Some(retained), request)
            .await
            .is_err()
    );
    store.close().await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn historical_unbound_managed_target_claims_before_launch_and_retires_exactly() {
    let fixture = Fixture::new().await;
    let request = target_request(&fixture);
    let created = current(
        fixture
            .runtime
            .create_replacement_and_advance(None, request.clone())
            .await
            .unwrap(),
    );
    let observation = (
        fixture.claims(),
        fixture.removal("remove-historical-target"),
    );
    let replayed = current(
        fixture
            .runtime
            .create_replacement_and_advance(None, request.clone())
            .await
            .unwrap(),
    );
    assert_eq!(
        created.session().descriptor(),
        replayed.session().descriptor()
    );
    close_target(&fixture.runtime, &request).await;
    fixture.runtime.store.close().await;
    assert_eq!(observation, (1, Err("checkout_use_in_use")));
    assert_eq!(fixture.claims(), 0);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn historical_unbound_managed_target_respects_removal_before_any_provider() {
    let fixture = Fixture::new().await;
    let request = target_request(&fixture);
    let permit = removal_permit(&fixture);
    let result = fixture
        .runtime
        .create_replacement_and_advance(None, request.clone())
        .await;
    let selector = SessionSelector::new(request.session_id(), Some(request.workspace_id().into()));
    let published = LocalSessionCatalog::new(&fixture.discovery)
        .open(&selector)
        .is_ok();
    let observation = (result.is_ok(), fixture.claims(), published);
    permit.abort().unwrap();
    fixture.runtime.store.close().await;
    let runtime = reopen(&fixture).await;
    let retry = runtime
        .create_replacement_and_advance(None, request.clone())
        .await;
    let retry_observation = (
        matches!(
            &retry,
            Ok(ManagedCreateAdvanceResolution::Current(_)
                | ManagedCreateAdvanceResolution::Advanced(_))
        ),
        fixture.claims(),
    );
    close_target(&runtime, &request).await;
    let after_close = runtime
        .create_replacement_and_advance(None, request.clone())
        .await;
    runtime.store.close().await;
    assert_eq!(observation, (false, 0, false));
    assert_eq!(
        retry_observation,
        (true, 1),
        "aborting removal must leave the frozen conversion request usable: {retry:?}"
    );
    assert!(after_close.is_err(), "explicit close must remain final");
    assert_eq!(fixture.claims(), 0);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn ordinary_managed_admission_refusal_retries_after_store_reopen() {
    let fixture = Fixture::new().await;
    let request = refuse_ordinary_creation(&fixture).await;
    fixture.runtime.store.close().await;
    let runtime = reopen(&fixture).await;
    let retry = runtime.create(request.clone()).await;
    let observation = (retry.is_ok(), fixture.claims());
    close_target(&runtime, &request).await;
    runtime.store.close().await;
    assert_eq!(observation, (true, 1), "retry after refusal: {retry:?}");
    assert_eq!(fixture.claims(), 0);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn explicit_close_after_admission_refusal_prevents_both_launch_paths() {
    let fixture = Fixture::new().await;
    let request = refuse_ordinary_creation(&fixture).await;
    close_target(&fixture.runtime, &request).await;
    fixture.runtime.store.close().await;
    let runtime = reopen(&fixture).await;
    assert!(runtime.create(request.clone()).await.is_err());
    assert!(
        runtime
            .create_replacement_and_advance(None, request.clone())
            .await
            .is_err()
    );
    assert!(
        LocalSessionCatalog::new(&fixture.discovery)
            .open(&SessionSelector::new(
                request.session_id(),
                Some(request.workspace_id().into())
            ))
            .is_err()
    );
    runtime.store.close().await;
    assert_eq!(fixture.claims(), 0);
}

async fn refuse_ordinary_creation(fixture: &Fixture) -> ManagedCreateRequest {
    let permit = removal_permit(fixture);
    let request = target_request(fixture);
    let result = fixture.runtime.create(request.clone()).await;
    let observation = (result.is_ok(), fixture.claims());
    permit.abort().unwrap();
    assert_eq!(observation, (false, 0));
    request
}

fn removal_permit(fixture: &Fixture) -> dure_git_checkout::AdmittedGitCheckoutRemoval {
    GitCheckoutRemovalOperation::new(
        &GitCheckoutRemovalRequestV1 {
            repository_path: fixture.registration.repository_path.clone(),
            instance: fixture.registration.instance.clone(),
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
        &OperationIdV1::new("remove-before-managed-target").unwrap(),
    )
    .unwrap()
    .admit()
    .unwrap()
}

async fn reopen(fixture: &Fixture) -> CheckoutSessionRuntime {
    CheckoutSessionRuntime::at_root(
        SqliteDomainStore::open(&fixture.database).await.unwrap(),
        fixture.executable.clone(),
        fixture.discovery.clone(),
    )
    .unwrap()
}

fn target_request(fixture: &Fixture) -> ManagedCreateRequest {
    ManagedCreateRequest::new(
        "managed-conversion-create",
        "managed-conversion-target",
        "workspace",
        "local-shell",
        PermissionMode::Default,
        &fixture.checkout,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "while IFS= read -r line; do :; done".into(),
        ],
        24,
        80,
    )
    .unwrap()
}

fn current(result: ManagedCreateAdvanceResolution) -> hmux_client::CreatedManagedSession {
    match result {
        ManagedCreateAdvanceResolution::Current(created) => created,
        other => panic!("the same conversion must resolve its existing target: {other:?}"),
    }
}

async fn close_target(runtime: &CheckoutSessionRuntime, request: &ManagedCreateRequest) {
    runtime
        .close(
            ManagedCreateReconcileRequest::new(
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
}
