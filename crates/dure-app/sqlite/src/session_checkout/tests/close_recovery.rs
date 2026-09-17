use super::*;

#[tokio::test]
async fn remembering_a_close_target_survives_reopen_without_closing_admission() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let binding = binding();
    let payload = serde_json::json!({"generation": "created", "process": 17});
    assert_eq!(
        store
            .remember_session_checkout_close_target(&binding.identity, &payload)
            .await
            .unwrap(),
        None
    );
    store.prepare_session_checkout(&binding).await.unwrap();
    let remembered = store
        .remember_session_checkout_close_target(&binding.identity, &payload)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(remembered.admission, SessionCheckoutAdmissionV1::Open);
    assert_eq!(remembered.close_payload, Some(payload.clone()));
    store.close().await;
    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store.session_checkout(&binding.identity).await.unwrap(),
        Some(remembered.clone())
    );
    store
        .admit_session_checkout(&binding.identity)
        .await
        .unwrap()
        .finish()
        .await
        .unwrap();
    assert_eq!(
        store
            .session_checkout_close_targets("/runtime/one", "workspace", "shell")
            .await
            .unwrap(),
        vec![remembered]
    );
    assert!(matches!(
        store
            .remember_session_checkout_close_target(
                &binding.identity,
                &serde_json::json!({"generation": "another"})
            )
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    store
        .begin_session_checkout_close_with(&binding.identity, &payload)
        .await
        .unwrap();
    for expected in [
        SessionCheckoutAdmissionV1::Closing,
        SessionCheckoutAdmissionV1::Closed,
    ] {
        if expected == SessionCheckoutAdmissionV1::Closed {
            store
                .finish_session_checkout_close(&binding.identity)
                .await
                .unwrap();
        }
        assert_eq!(
            store
                .remember_session_checkout_close_target(&binding.identity, &payload)
                .await
                .unwrap()
                .unwrap()
                .admission,
            expected
        );
    }
    store.close().await;
}

#[tokio::test]
async fn transfer_discards_the_source_cleanup_target_and_ignores_its_late_writer() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let other = second_writer(&store).await;
    let source = binding();
    let payload = serde_json::json!({"generation": "source"});
    store.prepare_session_checkout(&source).await.unwrap();
    store
        .remember_session_checkout_close_target(&source.identity, &payload)
        .await
        .unwrap();
    let mut target = source.identity.clone();
    target.owner = dure_app::SessionCheckoutOwnerV1::Standalone {
        workspace_id: "workspace".into(),
        session_id: "replacement".into(),
        recovery_id: "replacement-create".into(),
    };
    let transferred = store
        .transfer_session_checkout_with(&source, &target, || async {
            Ok::<_, DomainStoreErrorV1>(())
        })
        .await
        .unwrap();
    assert_eq!(transferred.close_payload, None);
    assert_eq!(
        other.session_checkout(&target).await.unwrap(),
        Some(transferred.clone())
    );
    assert_eq!(
        other
            .remember_session_checkout_close_target(&source.identity, &payload)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        other
            .begin_session_checkout_claim_close(&source.identity, &source.claim_id)
            .await
            .unwrap(),
        None
    );
    let new_payload = serde_json::json!({"generation": "replacement"});
    let saved = other
        .remember_session_checkout_close_target(&target, &new_payload)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.close_payload, Some(new_payload));
    let replay = store
        .transfer_session_checkout_with(&source, &target, || async {
            Err::<(), _>(DomainStoreErrorV1::Storage {
                code: "unexpected_reservation",
                detail: "replay must not reserve again".into(),
            })
        })
        .await
        .unwrap();
    assert_eq!(replay, saved);
    other.close().await;
    store.close().await;
}

#[tokio::test]
async fn close_retains_its_exact_runtime_input_across_reopen_and_rejects_retargeting() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let binding = binding();
    store.prepare_session_checkout(&binding).await.unwrap();
    let payload = serde_json::json!({"generation": "original", "process": 17});
    let closing = store
        .begin_session_checkout_close_with(&binding.identity, &payload)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(closing.admission, SessionCheckoutAdmissionV1::Closing);
    assert_eq!(closing.close_payload, Some(payload.clone()));
    assert!(
        store
            .admit_session_checkout(&binding.identity)
            .await
            .is_err()
    );
    store.close().await;

    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store
            .session_checkout_close_targets("/runtime/one", "workspace", "shell")
            .await
            .unwrap(),
        vec![closing.clone()]
    );
    assert_eq!(
        store
            .begin_session_checkout_close_with(&binding.identity, &payload)
            .await
            .unwrap(),
        Some(closing.clone())
    );
    assert!(matches!(
        store
            .begin_session_checkout_close_with(
                &binding.identity,
                &serde_json::json!({"generation": "replacement"})
            )
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert_eq!(
        store.session_checkout(&binding.identity).await.unwrap(),
        Some(closing)
    );
    for (namespace, workspace, session) in [
        ("/runtime/other", "workspace", "shell"),
        ("/runtime/one", "other", "shell"),
        ("/runtime/one", "workspace", "other"),
    ] {
        assert!(
            store
                .session_checkout_close_targets(namespace, workspace, session)
                .await
                .unwrap()
                .is_empty()
        );
    }
    let closed = store
        .finish_session_checkout_close(&binding.identity)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(closed.close_payload, Some(payload));
    assert!(
        store
            .session_checkout_close_targets("/runtime/one", "workspace", "shell")
            .await
            .unwrap()
            .is_empty()
    );
    store.close().await;
}

#[tokio::test]
async fn former_owner_close_cannot_save_cleanup_authority_for_a_transferred_claim() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let source = binding();
    store.prepare_session_checkout(&source).await.unwrap();
    let mut target = source.identity.clone();
    target.owner = dure_app::SessionCheckoutOwnerV1::Standalone {
        workspace_id: "workspace".into(),
        session_id: "replacement".into(),
        recovery_id: "runtime-create-key".into(),
    };
    let transferred = store
        .transfer_session_checkout_with(&source, &target, || async {
            Ok::<_, DomainStoreErrorV1>(())
        })
        .await
        .unwrap();
    assert_eq!(
        store
            .begin_session_checkout_close_with(
                &source.identity,
                &serde_json::json!({"generation": "source"})
            )
            .await
            .unwrap(),
        None
    );
    assert!(
        store
            .session_checkout_close_targets("/runtime/one", "workspace", "shell")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.session_checkout(&target).await.unwrap(),
        Some(transferred)
    );
    store.close().await;
}
