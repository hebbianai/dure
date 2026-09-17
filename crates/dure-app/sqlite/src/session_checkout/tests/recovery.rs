use dure_app::SessionCheckoutOwnerV1;

use super::*;

fn owner(owner: SessionCheckoutOwnerV1) -> SessionCheckoutIdentityV1 {
    SessionCheckoutIdentityV1 {
        owner,
        ..binding().identity
    }
}

fn recovery() -> SessionCheckoutIdentityV1 {
    owner(SessionCheckoutOwnerV1::Recovery {
        recovery_id: "convert-one".into(),
    })
}

async fn reserved() -> Result<(), DomainStoreErrorV1> {
    Ok(())
}

async fn must_not_reserve() -> Result<(), DomainStoreErrorV1> {
    panic!("a replay or closed owner must not reserve another runtime")
}

#[tokio::test]
async fn recovery_retains_one_claim_across_both_runtime_kinds_and_response_loss() {
    for source in [
        binding().identity,
        owner(SessionCheckoutOwnerV1::Standalone {
            workspace_id: "workspace".into(),
            session_id: "standalone-source".into(),
            recovery_id: "create-source".into(),
        }),
    ] {
        for target in [
            owner(SessionCheckoutOwnerV1::Managed {
                workspace_id: "workspace".into(),
                session_id: "managed-target".into(),
                idempotency_key: "create-target".into(),
            }),
            owner(SessionCheckoutOwnerV1::Standalone {
                workspace_id: "workspace".into(),
                session_id: "standalone-target".into(),
                recovery_id: "create-target".into(),
            }),
        ] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("domain.sqlite");
            let mut store = SqliteDomainStore::open(&path).await.unwrap();
            let fixture = binding();
            let source = SessionCheckoutBindingV1::new(
                source.clone(),
                fixture.working_directory,
                fixture.registration,
            );
            store.prepare_session_checkout(&source).await.unwrap();
            store
                .transfer_session_checkout_with(&source, &recovery(), reserved)
                .await
                .unwrap();
            // Lose the caller's result and reopen the database. The journal
            // owner must be enough to resume; no replacement exists yet.
            store.close().await;
            store = SqliteDomainStore::open(&path).await.unwrap();
            let retained = store
                .transfer_session_checkout_with(&source, &recovery(), must_not_reserve)
                .await
                .unwrap();
            assert_eq!(retained.admission, SessionCheckoutAdmissionV1::Open);
            assert_eq!(
                retained.binding,
                SessionCheckoutBindingV1 {
                    identity: recovery(),
                    ..source.clone()
                }
            );
            assert_ne!(retained.binding.claim_id, recovery().owner_id());
            assert_eq!(
                store
                    .begin_session_checkout_close(&source.identity)
                    .await
                    .unwrap(),
                None
            );
            let other = second_writer(&store).await;
            let transferred = other
                .transfer_session_checkout_with(&retained.binding, &target, reserved)
                .await
                .unwrap();
            assert_eq!(
                transferred.binding,
                SessionCheckoutBindingV1 {
                    identity: target.clone(),
                    ..source.clone()
                }
            );
            assert_eq!(
                store
                    .session_checkout_registration(&source.claim_id)
                    .await
                    .unwrap(),
                Some(transferred.clone())
            );
            for previous in [&source.identity, &retained.binding.identity] {
                assert_eq!(
                    store.begin_session_checkout_close(previous).await.unwrap(),
                    None
                );
            }
            other.begin_session_checkout_close(&target).await.unwrap();
            other.finish_session_checkout_close(&target).await.unwrap();
            other.close().await;
            store.close().await;
            store = SqliteDomainStore::open(&path).await.unwrap();
            assert_eq!(
                store
                    .transfer_session_checkout_with(&retained.binding, &target, must_not_reserve)
                    .await
                    .unwrap(),
                SessionCheckoutRecordV1 {
                    binding: transferred.binding,
                    admission: SessionCheckoutAdmissionV1::Closed,
                    close_payload: None,
                }
            );
            store.close().await;
        }
    }
}

#[tokio::test]
async fn failed_or_cancelled_target_reservation_retains_recovery_until_its_close() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let other = second_writer(&store).await;
    let source = binding();
    let target = owner(SessionCheckoutOwnerV1::Managed {
        workspace_id: "workspace".into(),
        session_id: "target".into(),
        idempotency_key: "create-target".into(),
    });
    store.prepare_session_checkout(&source).await.unwrap();
    let retained = store
        .transfer_session_checkout_with(&source, &recovery(), reserved)
        .await
        .unwrap();
    assert!(matches!(
        store
            .transfer_session_checkout_with(&retained.binding, &target, || async {
                Err(DomainStoreErrorV1::Storage {
                    code: "reservation_failed",
                    detail: "injected".into(),
                })
            })
            .await,
        Err(DomainStoreErrorV1::Storage {
            code: "reservation_failed",
            ..
        })
    ));
    assert_eq!(
        other.session_checkout(&recovery()).await.unwrap(),
        Some(retained.clone())
    );
    let (entered, observed) = tokio::sync::oneshot::channel();
    let writer = store.clone();
    let expected = retained.binding.clone();
    let replacement = target.clone();
    let transfer = tokio::spawn(async move {
        writer
            .transfer_session_checkout_with(&expected, &replacement, || async {
                entered.send(()).unwrap();
                std::future::pending::<Result<(), DomainStoreErrorV1>>().await
            })
            .await
    });
    observed.await.unwrap();
    assert_eq!(
        other.session_checkout(&recovery()).await.unwrap(),
        Some(retained.clone())
    );
    assert_eq!(other.session_checkout(&target).await.unwrap(), None);
    for identity in [&source.identity, &retained.binding.identity, &target] {
        assert!(matches!(
            other.begin_session_checkout_close(identity).await,
            Err(DomainStoreErrorV1::Busy { .. })
        ));
    }
    transfer.abort();
    assert!(transfer.await.unwrap_err().is_cancelled());
    assert_eq!(
        store.session_checkout(&recovery()).await.unwrap(),
        Some(retained.clone())
    );
    assert_eq!(
        store
            .begin_session_checkout_close(&source.identity)
            .await
            .unwrap(),
        None
    );
    other
        .begin_session_checkout_close(&recovery())
        .await
        .unwrap();
    for closed in [false, true] {
        if closed {
            other
                .finish_session_checkout_close(&recovery())
                .await
                .unwrap();
        }
        assert!(matches!(
            store
                .transfer_session_checkout_with(&retained.binding, &target, must_not_reserve)
                .await,
            Err(DomainStoreErrorV1::Storage {
                code: "session_checkout_closing",
                ..
            })
        ));
        assert_eq!(store.session_checkout(&target).await.unwrap(), None);
    }
    other.close().await;
    store.close().await;
}
