use super::*;

#[tokio::test]
async fn legacy_transfer_replay_finishes_missing_target_without_reopening_admission() {
    for admission in [
        SessionCheckoutAdmissionV1::Open,
        SessionCheckoutAdmissionV1::Closing,
        SessionCheckoutAdmissionV1::Closed,
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("domain.sqlite");
        let store = SqliteDomainStore::open(&path).await.unwrap();
        let source = binding();
        let target = target();
        store.prepare_session_checkout(&source).await.unwrap();
        let original = store
            .transfer_session_checkout_with(&source, &target, reservation_succeeds)
            .await
            .unwrap();
        assert_eq!(original.close_payload, None);
        if admission != SessionCheckoutAdmissionV1::Open {
            store
                .begin_session_checkout_claim_close(&target, &source.claim_id)
                .await
                .unwrap();
        }
        if admission == SessionCheckoutAdmissionV1::Closed {
            store.finish_session_checkout_close(&target).await.unwrap();
        }
        store.close().await;

        let reopened = SqliteDomainStore::open(&path).await.unwrap();
        let payload = serde_json::json!({"generation": "retained-exact-target"});
        let completed = reopened
            .transfer_session_checkout_with_target(
                &source,
                &target,
                Some(&payload),
                must_not_reserve,
            )
            .await
            .unwrap();
        assert_eq!(completed.binding, original.binding);
        assert_eq!(completed.admission, admission);
        assert_eq!(completed.close_payload, Some(payload));
        // An older caller can still replay, but cannot erase the newer fact.
        assert_eq!(
            reopened
                .transfer_session_checkout_with(&source, &target, must_not_reserve)
                .await
                .unwrap(),
            completed
        );
        assert_eq!(
            reopened.session_checkout(&target).await.unwrap(),
            Some(completed)
        );
        reopened.close().await;
    }
}

#[tokio::test]
async fn completed_target_is_atomic_with_ownership_and_survives_response_loss() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let other = second_writer(&store).await;
    let source = binding();
    let target = target();
    let original = store.prepare_session_checkout(&source).await.unwrap();
    let payload =
        serde_json::json!({"generation": "exact-replacement", "provider": "exact-provider"});
    let (entered, observed) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let writer = store.clone();
    let expected = source.clone();
    let replacement = target.clone();
    let saved_payload = payload.clone();
    let transfer = tokio::spawn(async move {
        writer
            .transfer_session_checkout_with_target(
                &expected,
                &replacement,
                Some(&saved_payload),
                || async {
                    entered.send(()).unwrap();
                    released.await.unwrap();
                    reservation_succeeds().await
                },
            )
            .await
            .unwrap()
    });
    observed.await.unwrap();
    assert_eq!(
        other.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
    assert_eq!(other.session_checkout(&target).await.unwrap(), None);
    release.send(()).unwrap();
    let transferred = transfer.await.unwrap();
    assert_eq!(transferred.binding.claim_id, source.claim_id);
    assert_eq!(transferred.close_payload, Some(payload.clone()));
    assert_eq!(
        other.session_checkout(&target).await.unwrap(),
        Some(transferred.clone())
    );
    other.close().await;
    store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    let replay = reopened
        .transfer_session_checkout_with_target(&source, &target, Some(&payload), must_not_reserve)
        .await
        .unwrap();
    assert_eq!(replay, transferred);
    let changed = serde_json::json!({"generation": "different-replacement"});
    assert!(
        reopened
            .transfer_session_checkout_with_target(
                &source,
                &target,
                Some(&changed),
                must_not_reserve
            )
            .await
            .is_err()
    );
    assert_eq!(
        reopened.session_checkout(&target).await.unwrap(),
        Some(transferred)
    );
    reopened.close().await;
}

#[tokio::test]
async fn a_failed_transfer_publishes_neither_successor_nor_close_target() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let source = binding();
    let target = target();
    let original = store.prepare_session_checkout(&source).await.unwrap();
    let payload = serde_json::json!({"generation": "not-published"});
    let failure = store
        .transfer_session_checkout_with_target(&source, &target, Some(&payload), || async {
            Err::<(), _>(storage(
                "fixture-reservation-failed",
                "owned fixture refusal",
            ))
        })
        .await;
    assert!(failure.is_err());
    assert_eq!(
        store.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
    assert_eq!(store.session_checkout(&target).await.unwrap(), None);
    store.close().await;
}
