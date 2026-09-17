use super::*;
use dure_git_checkout::{
    GIT_CHECKOUT_USE_SCHEMA_VERSION_V1, GitCheckoutRemovalOperation, GitCheckoutRemovalRequestV1,
    GitCheckoutUseActionV1, GitCheckoutUseOutcomeV1, GitCheckoutUseRequestV1,
    apply_git_checkout_use,
};
use structured_provider_runtime::StructuredProviderRuntimeErrorKindV1;

#[tokio::test]
async fn registered_checkout_retires_its_own_user_before_removal() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed =
        seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::RegisteredDureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);
    let preview = preview_stop(&state, "registered-remove", &seed.spawn_operation_id)
        .await
        .unwrap();
    let applied = call_dispatch_stop(
        &state,
        "registered-remove-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();
    assert_eq!(applied["receipt"]["state"]["status"], "succeeded");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert!(!seed.checkout.exists());
}

#[tokio::test]
async fn registered_checkout_preserve_releases_only_its_own_user() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed =
        seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::RegisteredDureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);
    let other = OperationIdV1::new("another-registration").unwrap();
    let registration =
        dure_git_checkout::claim_git_checkout_registration(&seed.checkout, &other, None)
            .unwrap()
            .unwrap();
    let preview = preview_stop_with_workspace_disposition(
        &state,
        "registered-preserve",
        &seed.spawn_operation_id,
        "preserve",
    )
    .await
    .unwrap();
    let applied = call_dispatch_stop(
        &state,
        "registered-preserve-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();
    assert_eq!(applied["receipt"]["state"]["status"], "workspace_preserved");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert!(seed.checkout.is_dir());
    assert_eq!(
        dure_git_checkout::claim_git_checkout_registration(
            &seed.checkout,
            &seed.spawn_operation_id,
            Some(&registration)
        )
        .unwrap_err()
        .code,
        "checkout_use_phase_conflict"
    );
    assert!(
        dure_git_checkout::claim_git_checkout_registration(
            &seed.checkout,
            &other,
            Some(&registration)
        )
        .is_ok()
    );
    let removal = GitCheckoutRemovalRequestV1 {
        repository_path: registration.repository_path.clone(),
        instance: registration.instance.clone(),
        policy: dure_app::GitCheckoutRemovalPolicyV1::RequireClean,
    };
    assert_eq!(
        dure_git_checkout::remove_git_checkout_instance(&removal)
            .unwrap_err()
            .code,
        "checkout_use_in_use"
    );
    dure_git_checkout::release_git_checkout_registration(
        &registration,
        &other,
        &OperationIdV1::new("release-other-registration").unwrap(),
    )
    .unwrap();
    assert!(dure_git_checkout::remove_git_checkout_instance(&removal).is_ok());
}

#[tokio::test]
async fn registered_checkout_other_user_blocks_removal_before_provider_stop() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed =
        seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::RegisteredDureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);
    dure_git_checkout::claim_git_checkout_registration(
        &seed.checkout,
        &OperationIdV1::new("another-active-registration").unwrap(),
        None,
    )
    .unwrap();
    let preview = preview_stop(&state, "registered-blocked", &seed.spawn_operation_id)
        .await
        .unwrap();
    let error = call_dispatch_stop(
        &state,
        "registered-blocked-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "checkout_use_in_use");
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert!(seed.checkout.is_dir());
}

#[tokio::test]
async fn registered_checkout_source_retained_keeps_its_registration_for_both_dispositions() {
    for disposition in ["preserve", "remove_owned"] {
        let (root, mut state, _, _) = fixture(Vec::new()).await;
        let seed =
            seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::RegisteredDureOwned).await;
        let stop_count = install_runtime(
            &mut state,
            seed.provider_id.clone(),
            Some(StructuredProviderRuntimeErrorKindV1::SourceBusy),
        );
        let registration = state
            .store
            .agent_spawn_receipt(&seed.spawn_operation_id)
            .await
            .unwrap()
            .unwrap()
            .checkout_registration
            .unwrap();
        let preview = preview_stop_with_workspace_disposition(
            &state,
            "registered-retained",
            &seed.spawn_operation_id,
            disposition,
        )
        .await
        .unwrap();
        let applied = call_dispatch_stop(
            &state,
            "registered-retained-apply",
            "dispatch.stop.apply",
            apply_body(&preview),
        )
        .await
        .unwrap();
        assert_eq!(applied["receipt"]["state"]["status"], "source_retained");
        assert_eq!(stop_count.load(Ordering::SeqCst), 1);
        assert_eq!(
            dure_git_checkout::claim_git_checkout_registration(
                &seed.checkout,
                &seed.spawn_operation_id,
                Some(&registration)
            )
            .unwrap(),
            Some(registration)
        );
    }
}

#[tokio::test]
async fn registered_checkout_stop_does_not_adopt_a_same_path_successor() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed =
        seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::RegisteredDureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);
    run_git(
        &seed.repository,
        &["worktree", "remove", seed.checkout.to_str().unwrap()],
    );
    run_git(
        &seed.repository,
        &[
            "worktree",
            "add",
            "--detach",
            seed.checkout.to_str().unwrap(),
            "HEAD",
        ],
    );
    let successor = capture_git_checkout_instance(&GitCheckoutCaptureRequestV1 {
        repository_path: seed.repository.to_string_lossy().into_owned(),
        checkout_path: seed.checkout.to_string_lossy().into_owned(),
    })
    .unwrap();
    let preview = preview_stop(&state, "registered-replaced", &seed.spawn_operation_id)
        .await
        .unwrap();
    let applied = call_dispatch_stop(
        &state,
        "registered-replaced-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();
    assert_eq!(applied["receipt"]["state"]["status"], "workspace_replaced");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert!(seed.checkout.is_dir());
    assert_eq!(
        capture_git_checkout_instance(&GitCheckoutCaptureRequestV1 {
            repository_path: seed.repository.to_string_lossy().into_owned(),
            checkout_path: seed.checkout.to_string_lossy().into_owned(),
        })
        .unwrap(),
        successor
    );
}

struct CheckoutObservingRuntime {
    inner: Arc<dyn structured_provider_runtime::StructuredProviderRuntime>,
    newcomer: GitCheckoutUseRequestV1,
}

impl structured_provider_runtime::StructuredProviderRuntime for CheckoutObservingRuntime {
    fn open(
        &self,
        request: structured_provider_runtime::StructuredProviderOpenRequestV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1>
    {
        self.inner.open(request)
    }

    fn attach_existing<'a>(
        &'a self,
        selection: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        self.inner.attach_existing(selection, binding)
    }

    fn open_replacement<'a>(
        &'a self,
        request: structured_provider_runtime::StructuredProviderOpenRequestV1,
        transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
        environment: hmux_client::ProviderStateEnvironment,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        self.inner
            .open_replacement(request, transition, environment)
    }

    fn stop_replacement_source<'a>(
        &'a self,
        transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        self.inner.stop_replacement_source(transition)
    }

    fn retire_replacement_source<'a>(
        &'a self,
        transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<
        'a,
        AgentRuntimeReplacementAuthorityV1,
    > {
        self.inner.retire_replacement_source(transition)
    }

    fn stop_current<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        assert_eq!(
            apply_git_checkout_use(&self.newcomer).unwrap_err().code,
            "checkout_use_phase_conflict",
            "checkout admission must already hold when the provider receives stop"
        );
        self.inner.stop_current(binding)
    }
}

#[tokio::test]
async fn checkout_is_fenced_when_the_runtime_receives_stop() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);
    let preview = preview_stop(&state, "permit-first-preview", &seed.spawn_operation_id)
        .await
        .unwrap();
    let observer = CheckoutObservingRuntime {
        inner: state
            .structured_runtimes
            .resolve(&seed.provider_id)
            .unwrap(),
        newcomer: claim_request(&preview, "claim-before-provider-stop"),
    };
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(seed.provider_id, Arc::new(observer))
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    let applied = call_dispatch_stop(
        &state,
        "permit-first-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();
    assert_eq!(applied["receipt"]["state"]["status"], "succeeded");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert!(!seed.checkout.exists());
}

#[tokio::test]
async fn checkout_claim_blocks_canonical_stop_before_provider_stop() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);
    let preview = preview_stop(&state, "claim-first-preview", &seed.spawn_operation_id)
        .await
        .unwrap();
    let instance = capture_git_checkout_instance(&GitCheckoutCaptureRequestV1 {
        repository_path: seed.repository.to_string_lossy().into_owned(),
        checkout_path: seed.checkout.to_string_lossy().into_owned(),
    })
    .unwrap();
    let claim = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: seed.repository.to_string_lossy().into_owned(),
        operation_id: OperationIdV1::new("concurrent-checkout-claim").unwrap(),
        action: GitCheckoutUseActionV1::Claim {
            instance,
            owner_id: OperationIdV1::new("another-checkout-user").unwrap(),
        },
    })
    .unwrap();
    assert!(matches!(
        claim.outcome,
        GitCheckoutUseOutcomeV1::ClaimAcquired { .. }
    ));

    let result = call_dispatch_stop(
        &state,
        "claim-first-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await;

    assert!(
        result.is_err(),
        "a concurrent checkout use must retain the checkout"
    );
    assert_eq!(
        stop_count.load(Ordering::SeqCst),
        0,
        "checkout admission must precede provider stop"
    );
    assert!(seed.checkout.is_dir());
}

fn checkout_request(preview: &Value) -> GitCheckoutRemovalRequestV1 {
    serde_json::from_value(preview["receipt"]["plan"]["ownedCheckout"].clone()).unwrap()
}

fn stop_operation_id(preview: &Value) -> OperationIdV1 {
    serde_json::from_value(preview["receipt"]["plan"]["operationId"].clone()).unwrap()
}

fn claim_request(preview: &Value, claim_id: &str) -> GitCheckoutUseRequestV1 {
    let checkout = checkout_request(preview);
    GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: checkout.repository_path,
        operation_id: OperationIdV1::new(claim_id).unwrap(),
        action: GitCheckoutUseActionV1::Claim {
            instance: checkout.instance,
            owner_id: OperationIdV1::new("another-checkout-user").unwrap(),
        },
    }
}

fn checkout_record(seed: &DispatchStopSeed) -> String {
    let record = run_git(
        &seed.repository,
        &[
            "for-each-ref",
            "--format=%(objectname)",
            "refs/dure/checkout-use/v1/",
        ],
    );
    assert_eq!(record.lines().count(), 1);
    record
}

#[tokio::test]
async fn checkout_permit_replays_after_stop_failure_and_backend_restart() {
    for ownership in [
        SpawnWorkspaceOwnership::DureOwned,
        SpawnWorkspaceOwnership::RegisteredDureOwned,
    ] {
        let (root, mut state, _, _) = fixture(Vec::new()).await;
        let seed = seed_dispatch_stop(&state, &root, ownership).await;
        let stop_count = install_runtime(
            &mut state,
            seed.provider_id.clone(),
            Some(StructuredProviderRuntimeErrorKindV1::StopFailed),
        );
        let preview = preview_stop(&state, "permit-replay-preview", &seed.spawn_operation_id)
            .await
            .unwrap();
        let body = apply_body(&preview);

        assert!(
            call_dispatch_stop(
                &state,
                "permit-replay-first",
                "dispatch.stop.apply",
                body.clone()
            )
            .await
            .is_err()
        );
        assert_eq!(stop_count.load(Ordering::SeqCst), 1);
        let permit_record = checkout_record(&seed);
        assert_eq!(
            apply_git_checkout_use(&claim_request(&preview, "late-claim"))
                .unwrap_err()
                .code,
            "checkout_use_phase_conflict"
        );

        let (mut reopened, _) =
            reopen_fixture_service_state(&state, &root.path().join("domain.sqlite")).await;
        let retried_stop_count = install_runtime(
            &mut reopened,
            seed.provider_id.clone(),
            Some(StructuredProviderRuntimeErrorKindV1::StopFailed),
        );
        assert!(
            call_dispatch_stop(
                &reopened,
                "permit-replay-second",
                "dispatch.stop.apply",
                body.clone()
            )
            .await
            .is_err()
        );
        assert_eq!(retried_stop_count.load(Ordering::SeqCst), 1);
        assert_eq!(
            checkout_record(&seed),
            permit_record,
            "recovery must reuse the durable permit without rewriting it"
        );

        let final_stop_count = install_runtime(&mut reopened, seed.provider_id, None);
        let applied = call_dispatch_stop(
            &reopened,
            "permit-replay-complete",
            "dispatch.stop.apply",
            body,
        )
        .await
        .unwrap();
        assert_eq!(applied["receipt"]["state"]["status"], "succeeded");
        assert_eq!(final_stop_count.load(Ordering::SeqCst), 1);
        assert!(!seed.checkout.exists());
    }
}

#[tokio::test]
async fn checkout_source_retained_releases_the_permit_for_a_new_user() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let stop_count = install_runtime(
        &mut state,
        seed.provider_id,
        Some(StructuredProviderRuntimeErrorKindV1::SourceBusy),
    );
    let preview = preview_stop(&state, "permit-retain-preview", &seed.spawn_operation_id)
        .await
        .unwrap();
    let applied = call_dispatch_stop(
        &state,
        "permit-retain-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();
    assert_eq!(applied["receipt"]["state"]["status"], "source_retained");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert!(seed.checkout.is_dir());
    assert!(matches!(
        apply_git_checkout_use(&claim_request(&preview, "claim-after-retain"))
            .unwrap()
            .outcome,
        GitCheckoutUseOutcomeV1::ClaimAcquired { .. }
    ));
}

async fn authorize_checkout_stop(
    state: &ServiceState,
    preview: &Value,
) -> dure_app::AgentDispatchStopRecordV1 {
    let planned = state
        .store
        .agent_dispatch_stop(&stop_operation_id(preview))
        .await
        .unwrap()
        .unwrap();
    state
        .store
        .authorize_agent_dispatch_stop(&AgentDispatchStopAuthorizeRequestV1 {
            schema_version: AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            operation_id: planned.plan().operation_id().clone(),
            plan_token: planned.plan().plan_token().clone(),
            expected_journal_revision: planned.journal_revision(),
            runtime_close_intent: AgentRuntimeCloseIntentV1 {
                schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
                operation_id: OperationIdV1::new("checkout-stop-child").unwrap(),
                idempotency_key: "checkout-stop-child".into(),
                source: planned.plan().runtime_selection().clone(),
                source_authority: planned.plan().runtime_authority().clone(),
                stopped_transition: None,
                requested_at_ms: planned.plan().planned_at_ms(),
            },
            authorized_at_ms: planned.plan().planned_at_ms(),
        })
        .await
        .unwrap()
        .0
}

#[tokio::test]
async fn checkout_abort_response_loss_preserves_a_successor_permit_after_restart() {
    for abort_response_lost in [false, true] {
        let (root, state, _, _) = fixture(Vec::new()).await;
        let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
        let preview = preview_stop(&state, "abort-replay-preview", &seed.spawn_operation_id)
            .await
            .unwrap();
        let authorized = authorize_checkout_stop(&state, &preview).await;
        let dure_app::AgentDispatchStopStateV1::Authorized {
            runtime_close_operation_id,
        } = authorized.state()
        else {
            panic!("stop must be authorized");
        };
        let close = state
            .store
            .agent_runtime_close(runtime_close_operation_id)
            .await
            .unwrap()
            .unwrap();
        let removal = GitCheckoutRemovalOperation::new(
            &checkout_request(&preview),
            &stop_operation_id(&preview),
        )
        .unwrap()
        .admit()
        .unwrap();
        state
            .store
            .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
                schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
                operation_id: close.intent.operation_id,
                expected_journal_revision: close.journal_revision,
                advance: AgentRuntimeCloseAdvanceV1::SourceRetained,
                advanced_at_ms: close.updated_at_ms + 1,
            })
            .await
            .unwrap();

        let successor = if abort_response_lost {
            // The abort committed, but its parent receipt was lost before terminalization.
            removal.abort().unwrap();
            Some(
                GitCheckoutRemovalOperation::new(
                    &checkout_request(&preview),
                    &OperationIdV1::new("successor-checkout-removal").unwrap(),
                )
                .unwrap()
                .admit()
                .unwrap(),
            )
        } else {
            // The backend exited before abort. The Git authority must retain its permit.
            drop(removal);
            None
        };
        let successor_record = checkout_record(&seed);
        let (mut reopened, _) =
            reopen_fixture_service_state(&state, &root.path().join("domain.sqlite")).await;
        let stop_count = install_runtime(&mut reopened, seed.provider_id.clone(), None);
        let applied = call_dispatch_stop(
            &reopened,
            "abort-replay-apply",
            "dispatch.stop.apply",
            apply_body(&preview),
        )
        .await
        .unwrap();
        assert_eq!(applied["receipt"]["state"]["status"], "source_retained");
        assert_eq!(stop_count.load(Ordering::SeqCst), 0);
        if let Some(successor) = successor {
            assert_eq!(
                checkout_record(&seed),
                successor_record,
                "old cleanup must not consume a successor's permit"
            );
            assert_eq!(
                apply_git_checkout_use(&claim_request(&preview, "claim-during-successor"))
                    .unwrap_err()
                    .code,
                "checkout_use_phase_conflict"
            );
            successor.abort().unwrap();
        } else {
            assert!(matches!(
                apply_git_checkout_use(&claim_request(&preview, "claim-after-recovered-abort"))
                    .unwrap()
                    .outcome,
                GitCheckoutUseOutcomeV1::ClaimAcquired { .. }
            ));
        }
        assert!(seed.checkout.is_dir());
    }
}

#[tokio::test]
async fn checkout_physical_response_loss_finalizes_without_another_stop() {
    let (root, state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let preview = preview_stop(&state, "removed-replay-preview", &seed.spawn_operation_id)
        .await
        .unwrap();
    let authorized = authorize_checkout_stop(&state, &preview).await;
    let dure_app::AgentDispatchStopStateV1::Authorized {
        runtime_close_operation_id,
    } = authorized.state()
    else {
        panic!("stop must be authorized");
    };
    let close = state
        .store
        .agent_runtime_close(runtime_close_operation_id)
        .await
        .unwrap()
        .unwrap();
    let removal =
        GitCheckoutRemovalOperation::new(&checkout_request(&preview), &stop_operation_id(&preview))
            .unwrap()
            .admit()
            .unwrap();
    state
        .store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
            operation_id: close.intent.operation_id,
            expected_journal_revision: close.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: close.updated_at_ms + 1,
        })
        .await
        .unwrap();
    removal.remove().unwrap();
    let removed_record = checkout_record(&seed);

    let (mut reopened, _) =
        reopen_fixture_service_state(&state, &root.path().join("domain.sqlite")).await;
    let stop_count = install_runtime(&mut reopened, seed.provider_id.clone(), None);
    let applied = call_dispatch_stop(
        &reopened,
        "removed-replay-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();
    assert_eq!(applied["receipt"]["state"]["status"], "succeeded");
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert_eq!(checkout_record(&seed), removed_record);
    assert!(!seed.checkout.exists());
}

#[tokio::test]
async fn checkout_physical_refusal_reacquires_after_abort_without_stopping_twice() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);
    let preview = preview_stop(&state, "dirty-checkout-preview", &seed.spawn_operation_id)
        .await
        .unwrap();
    let dirty_path = seed.checkout.join("README.md");
    let original = fs::read(&dirty_path).unwrap();
    fs::write(&dirty_path, "uncommitted fixture work\n").unwrap();
    assert!(
        call_dispatch_stop(
            &state,
            "dirty-checkout-apply",
            "dispatch.stop.apply",
            apply_body(&preview)
        )
        .await
        .is_err()
    );
    let aborted_record = checkout_record(&seed);
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        fs::read_to_string(&dirty_path).unwrap(),
        "uncommitted fixture work\n"
    );

    fs::write(&dirty_path, original).unwrap();
    let applied = call_dispatch_stop(
        &state,
        "clean-checkout-retry",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();
    assert_eq!(applied["receipt"]["state"]["status"], "succeeded");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_ne!(checkout_record(&seed), aborted_record);
    assert!(!seed.checkout.exists());
}

#[tokio::test]
async fn checkout_legacy_permit_recovery_requires_a_committed_stop() {
    for close_state in [
        dure_app::AgentRuntimeCloseStateV1::Admitted,
        dure_app::AgentRuntimeCloseStateV1::Stopped,
        dure_app::AgentRuntimeCloseStateV1::SourceRetained,
    ] {
        let (root, state, _, _) = fixture(Vec::new()).await;
        let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
        let preview = preview_stop(&state, "legacy-recovery-preview", &seed.spawn_operation_id)
            .await
            .unwrap();
        let authorized = authorize_checkout_stop(&state, &preview).await;
        let dure_app::AgentDispatchStopStateV1::Authorized {
            runtime_close_operation_id,
        } = authorized.state()
        else {
            panic!("stop must be authorized");
        };
        let close = state
            .store
            .agent_runtime_close(runtime_close_operation_id)
            .await
            .unwrap()
            .unwrap();
        let advance = match close_state {
            dure_app::AgentRuntimeCloseStateV1::Admitted => None,
            dure_app::AgentRuntimeCloseStateV1::Stopped => {
                Some(AgentRuntimeCloseAdvanceV1::Stopped)
            }
            dure_app::AgentRuntimeCloseStateV1::SourceRetained => {
                Some(AgentRuntimeCloseAdvanceV1::SourceRetained)
            }
        };
        if let Some(advance) = advance {
            state
                .store
                .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
                    schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
                    operation_id: close.intent.operation_id,
                    expected_journal_revision: close.journal_revision,
                    advance,
                    advanced_at_ms: close.updated_at_ms + 1,
                })
                .await
                .unwrap();
        }

        // Reproduce the pre-admission implementation's persisted permit format.
        let claim =
            apply_git_checkout_use(&claim_request(&preview, "legacy-digest-claim")).unwrap();
        let GitCheckoutUseOutcomeV1::ClaimAcquired {
            instance_digest,
            claim,
        } = claim.outcome
        else {
            panic!("checkout claim must expose its instance digest");
        };
        let checkout = checkout_request(&preview);
        let released = apply_git_checkout_use(&GitCheckoutUseRequestV1 {
            schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
            repository_path: checkout.repository_path.clone(),
            operation_id: OperationIdV1::new("legacy-digest-release").unwrap(),
            action: GitCheckoutUseActionV1::Release {
                instance: checkout.instance.clone(),
                claim_id: claim.claim_id,
            },
        })
        .unwrap();
        apply_git_checkout_use(&GitCheckoutUseRequestV1 {
            schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
            repository_path: checkout.repository_path,
            operation_id: OperationIdV1::new(format!(
                "legacy-permit-r{}-{instance_digest}",
                released.revision.value(),
            ))
            .unwrap(),
            action: GitCheckoutUseActionV1::AcquireRemovalPermit {
                instance: checkout.instance,
                retiring_claim_ids: Vec::new(),
                policy: checkout.policy,
            },
        })
        .unwrap();
        let legacy_record = checkout_record(&seed);
        let (mut reopened, _) =
            reopen_fixture_service_state(&state, &root.path().join("domain.sqlite")).await;
        let stop_count = install_runtime(&mut reopened, seed.provider_id.clone(), None);
        let applied = call_dispatch_stop(
            &reopened,
            "legacy-recovery-apply",
            "dispatch.stop.apply",
            apply_body(&preview),
        )
        .await;
        assert_eq!(stop_count.load(Ordering::SeqCst), 0);
        match close_state {
            dure_app::AgentRuntimeCloseStateV1::Stopped => {
                assert_eq!(applied.unwrap()["receipt"]["state"]["status"], "succeeded");
                assert!(!seed.checkout.exists());
            }
            dure_app::AgentRuntimeCloseStateV1::Admitted => {
                assert!(applied.is_err());
                assert_eq!(checkout_record(&seed), legacy_record);
                assert!(seed.checkout.is_dir());
            }
            dure_app::AgentRuntimeCloseStateV1::SourceRetained => {
                assert_eq!(
                    applied.unwrap()["receipt"]["state"]["status"],
                    "source_retained"
                );
                assert_eq!(checkout_record(&seed), legacy_record);
                assert!(seed.checkout.is_dir());
            }
        }
    }
}
