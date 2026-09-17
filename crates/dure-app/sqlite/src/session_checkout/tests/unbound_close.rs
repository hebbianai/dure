use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

#[tokio::test]
async fn unbound_close_prevents_late_preparation_after_reopen() {
    for finished in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("domain.sqlite");
        let store = SqliteDomainStore::open(&path).await.unwrap();
        let selected = binding();
        assert_eq!(
            store
                .begin_session_checkout_close(&selected.identity)
                .await
                .unwrap(),
            None
        );
        if finished {
            store
                .finish_session_checkout_close(&selected.identity)
                .await
                .unwrap();
        }
        store.close().await;
        let reopened = SqliteDomainStore::open(&path).await.unwrap();
        // Closing an unbound runtime must not invent a cwd or resource claim.
        assert_eq!(
            reopened.session_checkout(&selected.identity).await.unwrap(),
            None
        );
        let reservations = AtomicUsize::new(0);
        let prepared = reopened
            .prepare_session_checkout_with(&selected, || async {
                reservations.fetch_add(1, Ordering::SeqCst);
                Ok::<_, DomainStoreErrorV1>(())
            })
            .await;
        reopened.close().await;
        assert_eq!(
            (prepared.is_err(), reservations.load(Ordering::SeqCst)),
            (true, 0),
            "close-first must exclude late resource preparation before runtime reservation"
        );
    }
}

#[tokio::test]
async fn unbound_target_close_prevents_transfer_from_a_recovery() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let other = second_writer(&store).await;
    let source = binding();
    let source = SessionCheckoutBindingV1 {
        identity: SessionCheckoutIdentityV1 {
            owner: dure_app::SessionCheckoutOwnerV1::Recovery {
                recovery_id: "recovery-before-target-close".into(),
            },
            ..source.identity.clone()
        },
        ..source
    };
    let original = store.prepare_session_checkout(&source).await.unwrap();
    let target = binding().identity;
    other.begin_session_checkout_close(&target).await.unwrap();
    let reservations = AtomicUsize::new(0);
    let transferred = store
        .transfer_session_checkout_with(&source, &target, || async {
            reservations.fetch_add(1, Ordering::SeqCst);
            Ok::<_, DomainStoreErrorV1>(())
        })
        .await;
    let retained = store.session_checkout(&source.identity).await.unwrap();
    other.close().await;
    store.close().await;
    assert_eq!(
        (
            transferred.is_err(),
            reservations.load(Ordering::SeqCst),
            retained
        ),
        (true, 0, Some(original)),
        "an earlier target close must leave recovery ownership and reservation untouched"
    );
}
