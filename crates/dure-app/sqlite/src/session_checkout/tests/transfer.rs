use super::*;

mod close_target;

fn target() -> SessionCheckoutIdentityV1 {
    SessionCheckoutIdentityV1 {
        owner: dure_app::SessionCheckoutOwnerV1::Managed {
            workspace_id: "workspace".into(),
            session_id: "replacement".into(),
            idempotency_key: "create-replacement".into(),
        },
        ..binding().identity
    }
}

async fn reservation_succeeds() -> Result<(), DomainStoreErrorV1> {
    Ok(())
}

async fn must_not_reserve() -> Result<(), DomainStoreErrorV1> {
    panic!("this ordering must not admit another runtime reservation")
}

#[tokio::test]
async fn transfer_first_publishes_one_owner_and_excludes_a_late_source_close() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let other = second_writer(&store).await;
    let source = binding();
    let target = SessionCheckoutIdentityV1 {
        owner: dure_app::SessionCheckoutOwnerV1::Standalone {
            workspace_id: "workspace".into(),
            session_id: "standalone_replacement".into(),
            recovery_id: "standalone-recovery".into(),
        },
        ..target()
    };
    let original = store.prepare_session_checkout(&source).await.unwrap();
    let (entered, observed) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let writer = store.clone();
    let expected = source.clone();
    let replacement = target.clone();
    let transfer = tokio::spawn(async move {
        writer
            .transfer_session_checkout_with(&expected, &replacement, || async {
                entered.send(()).unwrap();
                released.await.unwrap();
                reservation_succeeds().await
            })
            .await
    });
    observed.await.unwrap();
    assert_eq!(
        other.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
    assert_eq!(other.session_checkout(&target).await.unwrap(), None);
    for identity in [&source.identity, &target] {
        assert!(matches!(
            other.begin_session_checkout_close(identity).await,
            Err(DomainStoreErrorV1::Busy { .. })
        ));
    }
    let competitor = SessionCheckoutIdentityV1 {
        owner: dure_app::SessionCheckoutOwnerV1::Standalone {
            workspace_id: "workspace".into(),
            session_id: "competing-replacement".into(),
            recovery_id: "competing-recovery".into(),
        },
        ..target.clone()
    };
    assert!(matches!(
        other
            .transfer_session_checkout_with(&source, &competitor, must_not_reserve)
            .await,
        Err(DomainStoreErrorV1::Busy { .. })
    ));
    release.send(()).unwrap();
    let transferred = transfer.await.unwrap().unwrap();
    assert_eq!(
        transferred.binding,
        SessionCheckoutBindingV1 {
            identity: target.clone(),
            ..source.clone()
        }
    );
    assert_eq!(transferred.admission, SessionCheckoutAdmissionV1::Open);
    assert_ne!(transferred.binding.claim_id, target.owner_id());
    assert_eq!(
        other
            .session_checkout_registration(&source.claim_id)
            .await
            .unwrap(),
        Some(transferred.clone())
    );
    assert_eq!(
        other
            .begin_session_checkout_close(&source.identity)
            .await
            .unwrap(),
        None
    );
    assert!(matches!(
        store.prepare_session_checkout(&source).await,
        Err(DomainStoreErrorV1::Storage {
            code: "session_checkout_closing",
            ..
        })
    ));
    assert!(matches!(
        other
            .transfer_session_checkout_with(&source, &competitor, must_not_reserve)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert_eq!(
        other.session_checkout(&target).await.unwrap(),
        Some(transferred.clone())
    );
    assert_eq!(
        other
            .begin_session_checkout_claim_close(&target, &target.owner_id())
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        other.session_checkout(&target).await.unwrap(),
        Some(transferred)
    );
    assert_eq!(
        other
            .begin_session_checkout_close(&target)
            .await
            .unwrap()
            .unwrap()
            .admission,
        SessionCheckoutAdmissionV1::Closing
    );
    other.close().await;
    store.close().await;
}

#[tokio::test]
async fn close_first_excludes_transfer_before_reserving_the_replacement() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let other = second_writer(&store).await;
    let source = binding();
    let target = target();
    store.prepare_session_checkout(&source).await.unwrap();
    other
        .begin_session_checkout_claim_close(&source.identity, &source.claim_id)
        .await
        .unwrap();
    for state in [
        SessionCheckoutAdmissionV1::Closing,
        SessionCheckoutAdmissionV1::Closed,
    ] {
        if state == SessionCheckoutAdmissionV1::Closed {
            other
                .finish_session_checkout_close(&source.identity)
                .await
                .unwrap();
        }
        assert!(matches!(
            store
                .transfer_session_checkout_with(&source, &target, must_not_reserve)
                .await,
            Err(DomainStoreErrorV1::Storage {
                code: "session_checkout_closing",
                ..
            })
        ));
        assert_eq!(store.session_checkout(&target).await.unwrap(), None);
        assert_eq!(
            store.session_checkout(&source.identity).await.unwrap(),
            Some(SessionCheckoutRecordV1 {
                binding: source.clone(),
                admission: state,
                close_payload: None,
            })
        );
    }
    other.close().await;
    store.close().await;
}

#[tokio::test]
async fn an_admitted_claim_excludes_transfer_until_its_writer_finishes() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let other = second_writer(&store).await;
    let source = binding();
    let target = target();
    store.prepare_session_checkout(&source).await.unwrap();
    let claim = store
        .admit_session_checkout(&source.identity)
        .await
        .unwrap();
    assert!(matches!(
        other
            .transfer_session_checkout_with(&source, &target, must_not_reserve)
            .await,
        Err(DomainStoreErrorV1::Busy { .. })
    ));
    claim.finish().await.unwrap();
    other
        .transfer_session_checkout_with(&source, &target, reservation_succeeds)
        .await
        .unwrap();
    assert!(matches!(
        store.admit_session_checkout(&source.identity).await,
        Err(DomainStoreErrorV1::Storage {
            code: "session_checkout_unprepared",
            ..
        })
    ));
    store
        .admit_session_checkout(&target)
        .await
        .unwrap()
        .finish()
        .await
        .unwrap();
    other.close().await;
    store.close().await;
}

#[tokio::test]
async fn a_failed_reservation_preserves_the_source_binding() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let source = binding();
    let target = target();
    let original = store.prepare_session_checkout(&source).await.unwrap();
    assert!(matches!(
        store
            .transfer_session_checkout_with(&source, &target, || async {
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
        store.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
    assert_eq!(store.session_checkout(&target).await.unwrap(), None);
    store
        .transfer_session_checkout_with(&source, &target, reservation_succeeds)
        .await
        .unwrap();
    store.close().await;
}

#[tokio::test]
async fn cancelling_a_pending_reservation_rolls_back_owner_publication() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let source = binding();
    let target = target();
    let original = store.prepare_session_checkout(&source).await.unwrap();
    let (entered, observed) = tokio::sync::oneshot::channel();
    let writer = store.clone();
    let expected = source.clone();
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
    transfer.abort();
    assert!(transfer.await.unwrap_err().is_cancelled());
    assert_eq!(
        store.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
    assert_eq!(store.session_checkout(&target).await.unwrap(), None);
    store
        .begin_session_checkout_close(&source.identity)
        .await
        .unwrap();
    store.close().await;
}

#[tokio::test]
async fn reopened_response_loss_replay_never_reserves_or_reopens_the_destination() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let mut store = SqliteDomainStore::open(&path).await.unwrap();
    let source = binding();
    let target = target();
    store.prepare_session_checkout(&source).await.unwrap();
    let transferred = store
        .transfer_session_checkout_with(&source, &target, reservation_succeeds)
        .await
        .unwrap();
    for state in [
        SessionCheckoutAdmissionV1::Open,
        SessionCheckoutAdmissionV1::Closing,
        SessionCheckoutAdmissionV1::Closed,
    ] {
        match state {
            SessionCheckoutAdmissionV1::Open => {}
            SessionCheckoutAdmissionV1::Closing => {
                store.begin_session_checkout_close(&target).await.unwrap();
            }
            SessionCheckoutAdmissionV1::Closed => {
                store.finish_session_checkout_close(&target).await.unwrap();
            }
        }
        store.close().await;
        store = SqliteDomainStore::open(&path).await.unwrap();
        assert_eq!(
            store
                .transfer_session_checkout_with(&source, &target, must_not_reserve)
                .await
                .unwrap(),
            SessionCheckoutRecordV1 {
                binding: transferred.binding.clone(),
                admission: state,
                close_payload: None,
            }
        );
        assert_eq!(
            store.session_checkout(&source.identity).await.unwrap(),
            None
        );
    }
    store.close().await;
}

#[tokio::test]
async fn another_owner_or_changed_frozen_resource_cannot_be_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let source = binding();
    let target = target();
    let original = store.prepare_session_checkout(&source).await.unwrap();
    let mut changed = source.clone();
    changed.working_directory = "/different/checkout".into();
    assert!(matches!(
        store
            .transfer_session_checkout_with(&changed, &target, must_not_reserve)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    changed = source.clone();
    let dure_app::SessionCheckoutOwnerV1::Managed { session_id, .. } = &mut changed.identity.owner
    else {
        panic!("managed source fixture required");
    };
    *session_id = "foreign-source".into();
    assert!(matches!(
        store
            .transfer_session_checkout_with(&changed, &target, must_not_reserve)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    let foreign = SessionCheckoutBindingV1::new(target.clone(), "/another/resource".into(), None);
    let preserved = store.prepare_session_checkout(&foreign).await.unwrap();
    assert!(matches!(
        store
            .transfer_session_checkout_with(&source, &target, must_not_reserve)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert_eq!(
        store.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
    assert_eq!(
        store.session_checkout(&target).await.unwrap(),
        Some(preserved)
    );
    store.close().await;
}
