use super::*;

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn unbound_source_close_excludes_late_checkout_preparation_real_hmux() {
    use dure_git_checkout::{capture_git_checkout_registration, read_git_checkout_claims};

    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed =
        seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::RegisteredDureOwned).await;
    let hmux = real_hmux::RealHmux::install(root, &mut state);
    let runtime = PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap());
    let request = ManagedCreateRequest::new(
        "unbound-close-create",
        "unbound-close-source",
        "unbound-close-workspace",
        "local-shell",
        PermissionMode::Default,
        seed.checkout.canonicalize().unwrap(),
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "while IFS= read -r line; do :; done".into(),
        ],
        24,
        80,
    )
    .unwrap();
    // Direct creation represents a pre-existing runtime from before product
    // checkout retention. Its actual create identity exists; its binding does not.
    let created = ManagedSessionCreator::new(&runtime)
        .with_discovery_root(&hmux.discovery)
        .create(request.clone())
        .unwrap();
    let descriptor = created.session().descriptor().clone();
    let identity = ManagedCreateReconcileRequest::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
    )
    .unwrap();
    let owner = shell_checkout_identity(&hmux.discovery, &identity);
    assert_eq!(state.store.session_checkout(&owner).await.unwrap(), None);
    let rejected_runtime = hmux.root.join("unbound-rejected-stop");
    fs::write(&rejected_runtime, "#!/bin/sh\nexit 71\n").unwrap();
    fs::set_permissions(&rejected_runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let closer = dure_session_runtime::CheckoutSessionRuntime::at_root(
        state.store.as_ref().clone(),
        rejected_runtime,
        hmux.discovery.clone(),
    )
    .unwrap();
    assert!(matches!(
        closer.close(identity.clone()).await,
        Err(dure_session_runtime::SessionCheckoutError::Runtime(_))
    ));
    let lifecycle = dure_session_runtime::CheckoutSessionRuntime::at_root(
        state.store.as_ref().clone(),
        runtime,
        hmux.discovery.clone(),
    )
    .unwrap();
    let late_create = lifecycle.create(request.clone()).await;
    let rejected = late_create.is_err();
    drop(late_create);
    let registration = capture_git_checkout_registration(request.provider_cwd())
        .unwrap()
        .unwrap();
    let claimed = read_git_checkout_claims(&registration)
        .unwrap()
        .into_iter()
        .any(|claim| claim.claim_id == owner.owner_id());
    let provider_live = matches!(
        probe_local_process_generation(&descriptor.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    // Finish the same close using the real transport after capturing the repro.
    // Cleanup must not hide a late claim or turn provider exit into exclusion.
    lifecycle.close(identity).await.unwrap();
    drop(created);
    assert_eq!(
        (rejected, provider_live, claimed),
        (true, true, false),
        "close must exclude late checkout preparation even before an unbound runtime stops"
    );
}

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn rejected_successor_stop_already_closes_origin_checkout_admission_real_hmux() {
    shell_lifetime_blocks_removal_until_close(ShellObservation::AdvancedRejectedClose).await;
}

pub(super) async fn reject_stop_and_observe_origin(
    state: &ServiceState,
    hmux: &real_hmux::RealHmux,
    original: &ManagedCreateRequest,
    current: &ManagedCreateReconcileRequest,
) -> SessionCheckoutAdmissionV1 {
    // Fail only this fixture's stop transport, before it can touch the provider.
    // Logical close must retain its admission even when runtime stop fails.
    let rejected_runtime = hmux.root.join("rejected-stop-runtime");
    fs::write(&rejected_runtime, "#!/bin/sh\nexit 71\n").unwrap();
    fs::set_permissions(&rejected_runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let closer = dure_session_runtime::CheckoutSessionRuntime::at_root(
        state.store.as_ref().clone(),
        rejected_runtime,
        hmux.discovery.clone(),
    )
    .unwrap();
    assert!(matches!(
        closer.close(current.clone()).await,
        Err(dure_session_runtime::SessionCheckoutError::Runtime(_))
    ));
    let origin = ManagedCreateReconcileRequest::new(
        original.idempotency_key(),
        original.session_id(),
        original.workspace_id(),
    )
    .unwrap();
    assert_ne!(&origin, current);
    state
        .store
        .session_checkout(&shell_checkout_identity(&hmux.discovery, &origin))
        .await
        .unwrap()
        .unwrap()
        .admission
}
