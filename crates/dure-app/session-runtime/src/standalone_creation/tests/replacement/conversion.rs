use super::*;
use hmux_client::{LocalProcessGenerationStatus, probe_local_process_generation};

mod managed;

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn unbound_conversion_retains_before_stop_and_transfers_across_reconnect() {
    let fixture = Fixture::new().await;
    let (original, request) = legacy_replacement(&fixture).await;
    let selected = fixture
        .runtime
        .select_recovery_checkout(None, &fixture.checkout, "legacy-conversion")
        .await
        .unwrap();
    let serialized = serde_json::to_string(&selected).unwrap();
    assert_eq!(fixture.claims(), 0, "selection itself is read-only");
    assert!(
        fixture
            .runtime
            .retained_recovery_checkout("legacy-conversion")
            .await
            .unwrap()
            .is_none()
    );
    let retained = fixture
        .runtime
        .retain_checkout_for_recovery(selected, "legacy-conversion".into())
        .await;
    let observation = (
        retained.is_ok(),
        fixture.claims(),
        fixture.removal("remove-before-conversion-stop"),
        probe_local_process_generation(&original.session().descriptor().provider_process).unwrap(),
    );
    if retained.is_err() {
        retention::close(&fixture.runtime.store, &fixture, &original).await;
        fixture.runtime.store.close().await;
    }
    assert_eq!(
        observation,
        (
            true,
            1,
            Err("checkout_use_in_use"),
            LocalProcessGenerationStatus::Live
        ),
        "pre-stop retention failed: {retained:?}",
    );
    let retained = retained.unwrap();
    assert_eq!(
        fixture
            .runtime
            .retained_recovery_checkout("legacy-conversion")
            .await
            .unwrap(),
        Some(retained.clone())
    );
    fixture.runtime.store.close().await;
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    let runtime = CheckoutSessionRuntime::at_root(
        store.clone(),
        fixture.executable.clone(),
        fixture.discovery.clone(),
    )
    .unwrap();
    let replayed = runtime
        .retain_checkout_for_recovery(
            serde_json::from_str(&serialized).unwrap(),
            "legacy-conversion".into(),
        )
        .await
        .unwrap();
    assert_eq!(replayed, retained);
    let replacement = runtime
        .create_standalone_replacement(
            Some(replayed),
            request,
            Some(crate::StandaloneReplacementSource::from_session(original.session()).unwrap()),
        )
        .await
        .unwrap();
    let selected_again = runtime
        .select_recovery_checkout(None, &fixture.checkout, "legacy-conversion")
        .await
        .unwrap();
    assert_eq!(
        selected_again, retained,
        "lookup must retain the original frozen binding"
    );
    // An old pre-stop observer cannot steal a transferred claim back.
    assert!(
        runtime
            .retain_checkout_for_recovery(selected_again, "legacy-conversion".into(),)
            .await
            .is_err()
    );
    let active = runtime
        .checkout_for_session(replacement.session().clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(active.claim_id, retained.claim_id);
    assert_ne!(active.identity, retained.identity);
    retention::close(&store, &fixture, &original).await;
    assert_eq!(fixture.claims(), 1);
    retention::close(&store, &fixture, &replacement).await;
    store.close().await;
    assert_eq!(fixture.claims(), 0);
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn unbound_conversion_removal_first_preserves_source_and_frozen_retry() {
    let fixture = Fixture::new().await;
    let (original, request) = legacy_replacement(&fixture).await;
    let selected = fixture
        .runtime
        .select_recovery_checkout(None, &fixture.checkout, "conversion-after-permit")
        .await
        .unwrap();
    let permit = GitCheckoutRemovalOperation::new(
        &GitCheckoutRemovalRequestV1 {
            repository_path: fixture.registration.repository_path.clone(),
            instance: fixture.registration.instance.clone(),
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
        &OperationIdV1::new("removal-before-conversion").unwrap(),
    )
    .unwrap()
    .admit()
    .unwrap();
    let retained = fixture
        .runtime
        .retain_checkout_for_recovery(selected.clone(), "conversion-after-permit".into())
        .await;
    let source = original.session().descriptor();
    let observation = (
        retained.is_ok(),
        fixture.claims(),
        probe_local_process_generation(&source.host_process).unwrap(),
        probe_local_process_generation(&source.provider_process).unwrap(),
    );
    permit.abort().unwrap();
    assert_eq!(
        observation,
        (
            false,
            0,
            LocalProcessGenerationStatus::Live,
            LocalProcessGenerationStatus::Live,
        )
    );
    let retry = fixture
        .runtime
        .retain_checkout_for_recovery(selected, "conversion-after-permit".into())
        .await;
    if retry.is_err() {
        retention::close(&fixture.runtime.store, &fixture, &original).await;
        fixture.runtime.store.close().await;
    }
    let retained = retry.expect("the same frozen selection must be admitted after permit abort");
    let replacement = fixture
        .runtime
        .create_standalone_replacement(
            Some(retained),
            request,
            Some(crate::StandaloneReplacementSource::from_session(original.session()).unwrap()),
        )
        .await
        .unwrap();
    assert_eq!(fixture.claims(), 1);
    retention::close(&fixture.runtime.store, &fixture, &replacement).await;
    fixture.runtime.store.close().await;
    assert_eq!(fixture.claims(), 0);
}
