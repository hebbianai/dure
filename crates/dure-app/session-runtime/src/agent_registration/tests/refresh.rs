use super::*;
use hmux_client::{CreatedManagedSession, ManagedCreateAdvanceResolution};
use hmux_client::{LocalProcessGenerationStatus, probe_local_process_generation};
mod legacy;
mod lookup;
mod removal;

fn ready(result: ManagedCreateAdvanceResolution) -> CreatedManagedSession {
    match result {
        ManagedCreateAdvanceResolution::Current(created)
        | ManagedCreateAdvanceResolution::Advanced(created) => created,
        other => panic!("Refresh did not become ready: {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn same_directory_refresh_does_not_require_git_metadata() {
    let fixture = Fixture::new(true).await;
    let registered = fixture.register("refresh-without-git").await.unwrap();
    let request = fixture.request(&registered.root);
    fixture.runtime.advance(request.clone()).await.unwrap();
    // Only this disposable linked checkout is changed. Its directory and
    // provider remain usable even when Git cannot parse the checkout pointer.
    let git_file = fixture.checkout.join(".git");
    let saved = std::fs::read(&git_file).unwrap();
    std::fs::write(&git_file, b"invalid git directory pointer\n").unwrap();
    let phases = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = phases.clone();
    let result = fixture
        .runtime
        .replace_current_and_advance_observed(request, move |phase| {
            observed.lock().unwrap().push(phase);
        })
        .await;
    std::fs::write(&git_file, saved).unwrap();
    fixture
        .runtime
        .close_agent_registration(registered.binding)
        .await
        .unwrap();
    assert!(
        matches!(
            result,
            Ok(ManagedCreateAdvanceResolution::Current(_)
                | ManagedCreateAdvanceResolution::Advanced(_))
        ),
        "same-directory Refresh must not consult Git: {result:?}"
    );
    assert_eq!(fixture.claims(), 0);
    fixture.store.close().await;
    assert_eq!(
        *phases.lock().unwrap(),
        [
            "checkout.replacement.entry",
            "checkout.replay.ready",
            "checkout.source.ready",
            "checkout.registration.ready",
            "checkout.admission.ready",
            "checkout.reservation.ready",
            "checkout.claim.ready",
            "checkout.broker.start",
            "checkout.broker.ready",
            "checkout.replacement.ready",
        ]
    );
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn cancellation_after_reopen_retires_unpublished_refresh_targets() {
    let fixture = Fixture::new(true).await;
    let registered = fixture.register("refresh-cancel").await.unwrap();
    let request = fixture.request(&registered.root);
    let source = ready(fixture.runtime.advance(request.clone()).await.unwrap());
    let target = ready(
        fixture
            .runtime
            .replace_current_and_advance(request.clone())
            .await
            .unwrap(),
    );
    let replay = ready(
        fixture
            .runtime
            .replace_current_and_advance(request.clone())
            .await
            .unwrap(),
    );
    assert_eq!(target.session().descriptor(), replay.session().descriptor());
    let source_process = source.session().descriptor().provider_process.clone();
    let target_process = target.session().descriptor().provider_process.clone();
    fixture.store.close().await;
    let store = SqliteDomainStore::open(fixture.checkout.parent().unwrap().join("state.sqlite3"))
        .await
        .unwrap();
    let runtime = CheckoutSessionRuntime::at_root(
        store.clone(),
        PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap()),
        fixture.runtime.discovery_root.clone(),
    )
    .unwrap();
    runtime
        .close_agent_registration(registered.binding.clone())
        .await
        .unwrap();
    assert_eq!(
        probe_local_process_generation(&source_process).unwrap(),
        LocalProcessGenerationStatus::Absent
    );
    assert_eq!(
        probe_local_process_generation(&target_process).unwrap(),
        LocalProcessGenerationStatus::Absent
    );
    assert_eq!(fixture.claims(), 0);
    assert!(runtime.replace_current_and_advance(request).await.is_err());
    runtime
        .close_agent_registration(registered.binding)
        .await
        .unwrap();
    store.close().await;
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn failed_refresh_keeps_the_live_source_and_its_agent_claim() {
    let fixture = Fixture::new(true).await;
    let registered = fixture.register("refresh-failure").await.unwrap();
    let source = ready(
        fixture
            .runtime
            .advance(fixture.request(&registered.root))
            .await
            .unwrap(),
    );
    let source_process = source.session().descriptor().provider_process.clone();
    let request = ManagedCreateRequest::new(
        registered.root.idempotency_key(),
        registered.root.session_id(),
        registered.root.workspace_id(),
        "local-shell",
        PermissionMode::Default,
        &fixture.checkout,
        vec![
            fixture
                .checkout
                .join("missing-provider")
                .to_str()
                .unwrap()
                .into(),
        ],
        24,
        80,
    )
    .unwrap();
    let result = fixture.runtime.replace_current_and_advance(request).await;
    assert!(
        !matches!(
            result,
            Ok(ManagedCreateAdvanceResolution::Current(_)
                | ManagedCreateAdvanceResolution::Advanced(_))
        ),
        "missing provider must fail: {result:?}"
    );
    assert_eq!(
        probe_local_process_generation(&source_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    assert_eq!(fixture.claims(), 1);
    assert_eq!(
        fixture.removal("while-failed-refresh"),
        Err("checkout_use_in_use")
    );
    fixture
        .runtime
        .close_agent_registration(registered.binding)
        .await
        .unwrap();
    assert_eq!(fixture.claims(), 0);
    fixture.store.close().await;
}

#[tokio::test]
async fn replacement_membership_serializes_with_cancellation_and_rejects_foreign_roots() {
    let fixture = Fixture::new(false).await;
    let registered = fixture.register("refresh-admission").await.unwrap();
    let source = managed_identity(
        &fixture.runtime.namespace,
        registered.root.idempotency_key(),
        registered.root.session_id(),
        registered.root.workspace_id(),
    );
    let target = managed_identity(
        &fixture.runtime.namespace,
        "refresh-key",
        "refresh-session",
        registered.root.workspace_id(),
    );
    let foreign = managed_identity(
        &fixture.runtime.namespace,
        "foreign-key",
        "foreign-session",
        "another-workspace",
    );
    assert!(
        fixture
            .store
            .admit_agent_checkout_replacement(&registered.binding, &source, &foreign)
            .await
            .is_err()
    );
    let admission = fixture
        .store
        .admit_agent_checkout_replacement(&registered.binding, &source, &target)
        .await
        .unwrap();
    assert!(admission.retained());
    // A cancelled preparation rolls back membership without releasing the
    // source. No runtime was reserved or launched in this store-only test.
    drop(admission);
    assert!(
        fixture
            .store
            .agent_checkout_for_root(&target)
            .await
            .unwrap()
            .is_none()
    );
    fixture
        .store
        .begin_agent_registration_close(&registered.binding)
        .await
        .unwrap();
    assert!(
        fixture
            .store
            .admit_agent_checkout_replacement(&registered.binding, &source, &target)
            .await
            .is_err()
    );
    assert_eq!(fixture.claims(), 1);
    fixture
        .runtime
        .close_agent_registration(registered.binding)
        .await
        .unwrap();
    assert_eq!(fixture.claims(), 0);
    fixture.store.close().await;
}
