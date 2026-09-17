use super::*;
use dure_app::SessionCheckoutOwnerV1;

fn named_binding(name: &str) -> SessionCheckoutBindingV1 {
    let mut selected = binding();
    selected.identity.owner = SessionCheckoutOwnerV1::Managed {
        workspace_id: "workspace".into(),
        session_id: name.into(),
        idempotency_key: name.into(),
    };
    selected.claim_id = selected.identity.owner_id();
    selected
}

#[tokio::test]
async fn recovery_uses_the_exact_retained_checkout_and_configured_namespaces() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let source = named_binding("closing");
    let registration = source.registration.as_ref().unwrap();
    let namespace = source.identity.runtime_namespace.clone();
    store.prepare_session_checkout(&source).await.unwrap();
    let closing = store
        .begin_session_checkout_close(&source.identity)
        .await
        .unwrap()
        .unwrap();
    let active = named_binding("open");
    let open = store.prepare_session_checkout(&active).await.unwrap();
    let closed = named_binding("closed");
    store.prepare_session_checkout(&closed).await.unwrap();
    store
        .begin_session_checkout_close(&closed.identity)
        .await
        .unwrap();
    store
        .finish_session_checkout_close(&closed.identity)
        .await
        .unwrap();
    let unbound = named_binding("unbound");
    store
        .begin_session_checkout_close(&unbound.identity)
        .await
        .unwrap();

    // Each field of the frozen resource and the runtime namespace is part of
    // selection. Neither a shared path nor a matching instance token suffices.
    let changes: [fn(&mut SessionCheckoutBindingV1); 8] = [
        |binding| binding.identity.runtime_namespace = "/runtime/other".into(),
        |binding| binding.registration = None,
        |binding| binding.registration.as_mut().unwrap().repository_path = "/other".into(),
        |binding| {
            binding
                .registration
                .as_mut()
                .unwrap()
                .instance
                .schema_version = 2
        },
        |binding| {
            binding
                .registration
                .as_mut()
                .unwrap()
                .instance
                .canonical_path = "/other".into()
        },
        |binding| {
            binding
                .registration
                .as_mut()
                .unwrap()
                .instance
                .git_common_dir = "/other".into()
        },
        |binding| binding.registration.as_mut().unwrap().instance.git_dir = "/other".into(),
        |binding| {
            binding
                .registration
                .as_mut()
                .unwrap()
                .instance
                .instance_token = "other".into()
        },
    ];
    for (index, change) in changes.iter().enumerate() {
        let mut other = named_binding(&format!("excluded-{index}"));
        change(&mut other);
        other.claim_id = other.identity.owner_id();
        store.prepare_session_checkout(&other).await.unwrap();
        store
            .begin_session_checkout_close(&other.identity)
            .await
            .unwrap();
    }
    store.close().await;
    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert!(
        store
            .session_checkout_recovery_candidates(registration, &[])
            .await
            .unwrap()
            .is_empty()
    );
    let found = store
        .session_checkout_recovery_candidates(registration, std::slice::from_ref(&namespace))
        .await
        .unwrap();
    assert_eq!(found.len(), 2);
    assert!(found.contains(&closing));
    assert!(found.contains(&open));

    // Transfer keeps one Git claim but changes its current resource owner.
    // The query must follow that owner, never resurrect its old binding.
    let mut target = named_binding("transferred").identity;
    target.runtime_namespace = "/runtime/destination".into();
    let transferred = store
        .transfer_session_checkout_with(&active, &target, || async {
            Ok::<_, DomainStoreErrorV1>(())
        })
        .await
        .unwrap();
    assert_eq!(
        store
            .session_checkout_recovery_candidates(registration, std::slice::from_ref(&namespace))
            .await
            .unwrap(),
        vec![closing.clone()]
    );
    let found = store
        .session_checkout_recovery_candidates(
            registration,
            &[namespace, target.runtime_namespace.clone()],
        )
        .await
        .unwrap();
    assert_eq!(found.len(), 2);
    assert!(found.contains(&closing));
    assert!(found.contains(&transferred));
    assert_eq!(transferred.binding.claim_id, active.claim_id);
    store.close().await;
}
