use futures_util::FutureExt;

use super::*;

struct PreflightCountingRuntime {
    available: bool,
    stop_count: Arc<AtomicUsize>,
    open_count: Arc<AtomicUsize>,
    attach_count: Arc<AtomicUsize>,
}

impl structured_provider_runtime::StructuredProviderRuntime for PreflightCountingRuntime {
    fn new_session_availability(
        &self,
    ) -> Result<(), structured_provider_runtime::StructuredProviderRuntimeErrorV1> {
        if self.available {
            return Ok(());
        }
        Err(
            structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
                "agent_runtime_structured_profile_unavailable",
            )
            .with_detail(Some(
                "codex 0.152.2 not reviewed: schema digest fixture".into(),
            )),
        )
    }

    fn open(
        &self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1>
    {
        self.open_count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn attach_existing<'a>(
        &'a self,
        _selection: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        self.attach_count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(binding.clone()) })
    }

    fn open_replacement<'a>(
        &'a self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
        _provider_state_environment: hmux_client::ProviderStateEnvironment,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        self.open_count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn stop_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        self.stop_count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }

    fn retire_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<
        'a,
        dure_app::AgentRuntimeReplacementAuthorityV1,
    > {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn stop_current<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        self.stop_count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn incompatible_structured_target_is_rejected_before_admission_or_effects() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    state.agent_providers =
        Arc::new(provider_extension::test_codex_structured_agent_provider_registry());
    let agent_id = AgentIdV1::new("structured-incompatible-agent").unwrap();
    let provider_id = ProviderIdV1::new("codex").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: provider_id.clone(),
            display_name: "Structured incompatible agent".into(),
            created_at_ms: 10,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    initialize_structured_source_for_provider(&state, agent_id.clone(), provider_id.clone()).await;

    let stop_count = Arc::new(AtomicUsize::new(0));
    let open_count = Arc::new(AtomicUsize::new(0));
    let attach_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(PreflightCountingRuntime {
                available: false,
                stop_count: Arc::clone(&stop_count),
                open_count: Arc::clone(&open_count),
                attach_count: Arc::clone(&attach_count),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);

    let error = agent_runtime_transition_apply::apply(
        &state,
        "structured-incompatible-attempt",
        agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            expected_source_revision: None,
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            target_execution_profile: None,
            target_launch_selection: Some(dure_app::AgentRuntimeLaunchSelectionV1 {
                model: Some(dure_app::AgentSpawnModelSelectionV1::parse("gpt-5.6-sol").unwrap()),
                effort: None,
                permission_mode: None,
            }),
        },
    )
    .await
    .unwrap_err();

    assert_eq!(error.code, "agent_runtime_structured_profile_unavailable");
    assert_eq!(
        error.message,
        "agent_runtime_structured_profile_unavailable"
    );
    assert_eq!(
        error.details,
        Some(serde_json::json!({
            "detail": "codex 0.152.2 not reviewed: schema digest fixture"
        }))
    );
    assert!(
        state
            .store
            .active_agent_runtime_transition(&agent_id)
            .await
            .unwrap()
            .is_none(),
        "an incompatible target runtime cannot own a durable transition"
    );
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert_eq!(open_count.load(Ordering::SeqCst), 0);
    assert_eq!(attach_count.load(Ordering::SeqCst), 0);
    assert!(
        state
            .agent_runtime_recovery_wake
            .notified()
            .now_or_never()
            .is_none(),
        "preflight refusal must not wake lifecycle recovery"
    );
}

#[tokio::test]
async fn pi_unsupported_permission_preserves_source_before_any_effect() {
    let (_root, mut state, launcher, _) = fixture(Vec::new()).await;
    state.agent_providers = Arc::new(provider_extension::test_structured_agent_provider_registry(
        "pi",
    ));
    let agent_id = AgentIdV1::new("pi-permission-agent").unwrap();
    let provider_id = ProviderIdV1::new("pi").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: provider_id.clone(),
            display_name: "Pi permission fixture".into(),
            created_at_ms: 10,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    let (source, binding) =
        initialize_structured_source_for_provider(&state, agent_id.clone(), provider_id.clone())
            .await;
    let stop_count = Arc::new(AtomicUsize::new(0));
    let open_count = Arc::new(AtomicUsize::new(0));
    let attach_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(PreflightCountingRuntime {
                available: true,
                stop_count: stop_count.clone(),
                open_count: open_count.clone(),
                attach_count: attach_count.clone(),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    for (index, permission) in [
        ProviderPermissionModeV1::AutoEdit,
        ProviderPermissionModeV1::SkipPermissions,
    ]
    .into_iter()
    .enumerate()
    {
        let error = agent_runtime_transition_apply::apply(
            &state,
            &format!("pi-permission-{index}"),
            agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
                schema_version: 1,
                agent_id: agent_id.clone(),
                target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
                expected_source_revision: Some(source.revision),
                source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
                target_execution_profile: None,
                target_launch_selection: Some(dure_app::AgentRuntimeLaunchSelectionV1 {
                    model: None,
                    effort: None,
                    permission_mode: Some(permission),
                }),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "permission_mode_unsupported");
        assert!(
            state
                .store
                .active_agent_runtime_transition(&agent_id)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            state
                .store
                .agent_runtime_selection(&agent_id)
                .await
                .unwrap(),
            Some(source.clone())
        );
        assert_eq!(
            state
                .store
                .agent_interaction(&binding.interaction_session_id)
                .await
                .unwrap(),
            Some(binding.clone())
        );
    }
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert_eq!(open_count.load(Ordering::SeqCst), 0);
    assert_eq!(attach_count.load(Ordering::SeqCst), 0);
    assert!(launcher.requests().is_empty());
}
