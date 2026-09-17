use super::*;

fn make_runtime_ledger_unavailable(fixture: &Fixture) {
    // Fail runtime metadata access before any Host or provider can launch,
    // without altering this store-only fixture's durable checkout ownership.
    std::fs::create_dir_all(&fixture.runtime.discovery_root).unwrap();
    std::fs::write(
        fixture.runtime.discovery_root.join(".managed-create-v2"),
        b"not a runtime ledger directory\n",
    )
    .unwrap();
}

#[tokio::test]
async fn retained_refresh_root_resolves_ownership_without_runtime_ancestry() {
    let fixture = Fixture::new(false).await;
    let registered = fixture.register("retained-root-lookup").await.unwrap();
    let expected = managed_identity(
        &fixture.runtime.namespace,
        registered.root.idempotency_key(),
        registered.root.session_id(),
        registered.root.workspace_id(),
    );
    make_runtime_ledger_unavailable(&fixture);
    let result = fixture
        .runtime
        .refresh_checkout_source(&registered.root)
        .await;
    fixture.store.close().await;
    assert_eq!(result.unwrap(), (expected, Some(registered.binding)));
}

#[tokio::test]
async fn unretained_identity_still_requires_runtime_ancestry() {
    let fixture = Fixture::new(false).await;
    let registered = fixture.register("exact-root-lookup").await.unwrap();
    make_runtime_ledger_unavailable(&fixture);
    let root = &registered.root;
    for (key, session, workspace) in [
        ("another-key", root.session_id(), root.workspace_id()),
        (
            root.idempotency_key(),
            "another-session",
            root.workspace_id(),
        ),
        (
            root.idempotency_key(),
            root.session_id(),
            "another-workspace",
        ),
    ] {
        let unknown = ManagedCreateReconcileRequest::new(key, session, workspace).unwrap();
        assert!(
            fixture
                .runtime
                .refresh_checkout_source(&unknown)
                .await
                .is_err(),
            "an unretained identity must not borrow the registered root's ownership"
        );
    }
    fixture.store.close().await;
}

#[tokio::test]
async fn refresh_observation_retains_preparation_phases_on_admission_error() {
    let fixture = Fixture::new(false).await;
    let registered = fixture.register("observed-refresh-error").await.unwrap();
    make_runtime_ledger_unavailable(&fixture);
    let phases = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = phases.clone();
    let result = fixture
        .runtime
        .replace_current_and_advance_observed(fixture.request(&registered.root), move |phase| {
            captured.lock().unwrap().push(phase);
        })
        .await;
    assert!(
        result.is_err(),
        "unavailable runtime ledger must still refuse admission"
    );
    assert_eq!(fixture.claims(), 1, "diagnostics must not release the source");
    fixture.store.close().await;
    assert_eq!(
        *phases.lock().unwrap(),
        [
            "checkout.replacement.entry",
            "checkout.replay.ready",
            "checkout.source.ready",
            "checkout.registration.ready",
            "checkout.admission.ready",
        ]
    );
}
