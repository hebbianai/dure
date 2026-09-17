use super::*;
use dure_app::{SessionCheckoutBindingV1, SessionCheckoutOwnerV1};
use dure_git_checkout::{capture_git_checkout_registration, read_git_checkout_claims};
use hmux_client::recovery_journal as recovery;

#[tokio::test]
#[ignore = "requires isolated Hmux binaries; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn failed_transferred_creation_retains_the_recovery_checkout_until_close_real_hmux() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed =
        seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::RegisteredDureOwned).await;
    let missing_program = root.path().join("missing-replacement");
    assert!(!missing_program.exists());
    let hmux = real_hmux::RealHmux::install(root, &mut state);
    let runtime = PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap());
    let lifecycle = dure_session_runtime::CheckoutSessionRuntime::at_root(
        state.store.as_ref().clone(),
        runtime.clone(),
        hmux.discovery.clone(),
    )
    .unwrap();
    let source = ManagedCreateRequest::new(
        "source-before-transfer",
        "transfer-source",
        "transfer-workspace",
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
    let created = lifecycle.create(source.clone()).await.unwrap();
    let descriptor = created.session().descriptor().clone();
    let source_identity = ManagedCreateReconcileRequest::new(
        source.idempotency_key(),
        source.session_id(),
        source.workspace_id(),
    )
    .unwrap();
    let original = state
        .store
        .session_checkout(&shell_checkout_identity(&hmux.discovery, &source_identity))
        .await
        .unwrap()
        .unwrap()
        .binding;
    let target = ManagedCreateRequest::new(
        "failed-transfer-create",
        "failed-transfer-target",
        source.workspace_id(),
        "local-shell",
        PermissionMode::Default,
        source.provider_cwd(),
        vec![missing_program.to_str().unwrap().into()],
        24,
        80,
    )
    .unwrap();
    let target_identity = ManagedCreateReconcileRequest::new(
        target.idempotency_key(),
        target.session_id(),
        target.workspace_id(),
    )
    .unwrap();
    let payload = serde_json::to_string(&target).unwrap();
    let recovery_id = "transfer-with-failed-replacement";
    let action = "convert_standalone_to_managed_with_exact_conversation";
    let recovery::RecoveryReservationState::Pending(mut journal) = recovery::reserve(
        &hmux.discovery,
        recovery::RecoveryIdentity {
            recovery_id: recovery_id.into(),
            source_session_id: source.session_id().into(),
            source_workspace_id: source.workspace_id().into(),
            request_fingerprint: recovery::request_fingerprint(&[&payload]),
            action,
        },
    )
    .unwrap() else {
        panic!("fresh recovery fixture must reserve its own operation");
    };
    journal
        .prepare_operation_payload(recovery::RecoveryOperationPayload::new(payload).unwrap())
        .unwrap();
    let recovery_owner = SessionCheckoutIdentityV1 {
        runtime_namespace: original.identity.runtime_namespace.clone(),
        owner: SessionCheckoutOwnerV1::Recovery {
            recovery_id: recovery_id.into(),
        },
    };
    let retained = state
        .store
        .transfer_session_checkout_with(&original, &recovery_owner, || async {
            Ok::<_, dure_app::DomainStoreErrorV1>(())
        })
        .await
        .unwrap();
    hmux.stop(&shell_generation(&descriptor));
    drop(created);
    let target_owner = shell_checkout_identity(&hmux.discovery, &target_identity);
    let launch = lifecycle
        .create_replacement_and_advance(Some(retained.binding.clone()), target.clone())
        .await;
    assert!(launch.is_err(), "the missing replacement must not launch");
    let registration = capture_git_checkout_registration(source.provider_cwd())
        .unwrap()
        .unwrap();
    let after_create = state
        .store
        .session_checkout(&target_owner)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        after_create.binding,
        SessionCheckoutBindingV1 {
            identity: target_owner.clone(),
            ..original.clone()
        }
    );
    let claim_after_create = read_git_checkout_claims(&registration)
        .unwrap()
        .into_iter()
        .any(|claim| claim.claim_id == original.claim_id);
    // The same automatic compensation is also reachable from checkout removal
    // after loss of the caller. It cannot turn a recovery's retained resource
    // into an abandoned ordinary create merely because its target failed.
    dure_session_runtime::reconcile_checkout_users(
        state.store.as_ref().clone(),
        runtime,
        hmux.discovery.canonicalize().unwrap(),
        registration.clone(),
    )
    .await
    .unwrap();
    let after_reconcile = state
        .store
        .session_checkout(&target_owner)
        .await
        .unwrap()
        .unwrap();
    let claim_after_reconcile = read_git_checkout_claims(&registration)
        .unwrap()
        .into_iter()
        .any(|claim| claim.claim_id == original.claim_id);

    // Explicit close owns final cleanup. Observe the failing transition before
    // cleanup so the fixture cannot hide the released recovery claim on RED.
    lifecycle.close(target_identity.clone()).await.unwrap();
    lifecycle.close(source_identity).await.unwrap();
    let closed = state
        .store
        .session_checkout(&target_owner)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(closed.admission, SessionCheckoutAdmissionV1::Closed);
    assert!(
        !read_git_checkout_claims(&registration)
            .unwrap()
            .into_iter()
            .any(|claim| claim.claim_id == original.claim_id)
    );
    assert!(lifecycle.create(target.clone()).await.is_err());
    assert!(matches!(
        lifecycle
            .create_replacement_and_advance(Some(retained.binding), target)
            .await,
        Err(dure_session_runtime::SessionCheckoutError::Closing)
    ));
    journal
        .complete(recovery::RecoveryCompletion {
            target_session_id: target_identity.session_id().into(),
            target_workspace_id: target_identity.workspace_id().into(),
            target_build_id: descriptor.host_build_version,
            action: action.into(),
            outcome: "cancelled".into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .unwrap();
    assert_eq!(
        (
            after_create.admission,
            claim_after_create,
            after_reconcile.admission,
            claim_after_reconcile
        ),
        (
            SessionCheckoutAdmissionV1::Open,
            true,
            SessionCheckoutAdmissionV1::Open,
            true
        ),
        "failed target compensation must retain the recovery's original claim until explicit close",
    );
}
