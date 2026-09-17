use super::*;

struct DeterministicCodexRecoveryRuntime {
    store: Arc<SqliteDomainStore>,
    attach_count: Arc<AtomicUsize>,
}

impl structured_provider_runtime::StructuredProviderRuntime for DeterministicCodexRecoveryRuntime {
    fn open(
        &self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn attach_existing<'a>(
        &'a self,
        _selection: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        let store = Arc::clone(&self.store);
        let attach_count = Arc::clone(&self.attach_count);
        let binding = binding.clone();
        Box::pin(async move {
            attach_count.fetch_add(1, Ordering::SeqCst);
            store
                .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
                    schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                    interaction_session_id: binding.interaction_session_id.clone(),
                    expected_binding_revision: binding.binding_revision,
                    source: binding.runtime.clone(),
                    source_execution_profile: binding.execution_profile.clone(),
                    target: AgentProviderRuntimeFenceV1 {
                        runtime_generation: "runtime-codex-recovered".into(),
                        provider_epoch: "provider-codex-recovered".into(),
                    },
                    target_execution_profile: binding.execution_profile.clone(),
                    provider_conversation_ref: binding.provider_conversation_ref.clone(),
                    replaced_at_ms: binding.updated_at_ms + 1,
                })
                .await
                .map_err(|_| CountingStructuredRuntime::unavailable())
        })
    }

    fn open_replacement<'a>(
        &'a self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
        _transition: &'a AgentRuntimeTransitionRecordV1,
        _provider_state_environment: hmux_client::ProviderStateEnvironment,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn stop_replacement_source<'a>(
        &'a self,
        _transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn retire_replacement_source<'a>(
        &'a self,
        _transition: &'a AgentRuntimeTransitionRecordV1,
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
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }
}

fn recovery_binding(
    agent_id: AgentIdV1,
    execution_profile: AgentExecutionProfileV1,
) -> AgentInteractionBindingV1 {
    AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-codex-recovery")
            .unwrap(),
        agent_id,
        provider_id: ProviderIdV1::new("codex").unwrap(),
        execution_profile,
        provider_conversation_ref: Some("conversation-codex-recovery".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-codex-dead".into(),
            provider_epoch: "provider-codex-dead".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-codex-recovery").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 10,
        updated_at_ms: 10,
    }
}

async fn selected_codex_recovery_fixture(
    execution_profile: AgentExecutionProfileV1,
) -> (
    TempDir,
    ServiceState,
    AgentInteractionBindingV1,
    Arc<AtomicUsize>,
) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new("agent-codex-recovery").unwrap();
    let provider_id = ProviderIdV1::new("codex").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: provider_id.clone(),
            display_name: "Codex recovery".into(),
            created_at_ms: 10,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    state
        .store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            provider_id: provider_id.clone(),
            interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            execution_profile: execution_profile.clone(),
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    let binding = recovery_binding(agent_id, execution_profile);
    state
        .store
        .create_agent_interaction(&binding)
        .await
        .unwrap();
    let attach_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(DeterministicCodexRecoveryRuntime {
                store: Arc::clone(&state.store),
                attach_count: Arc::clone(&attach_count),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    (root, state, binding, attach_count)
}

fn recovery_request(
    state: &ServiceState,
    expected_binding: &AgentInteractionBindingV1,
) -> BackendRequest {
    BackendRequest {
        schema_version: 1,
        api_version: BACKEND_PROTOCOL_API.into(),
        kind: BACKEND_REQUEST_KIND.into(),
        request_id: "agent-conversation-recover-1".into(),
        operation: "agent_conversation.recover".into(),
        expected: ExpectedBackend {
            scope_id: None,
            backend_id: BACKEND_ID.into(),
            generation: state.descriptor.generation.clone(),
            protocol: ExpectedProtocol {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            required_capabilities: Vec::new(),
        },
        body: json!({
            "schemaVersion": 1,
            "expectedBinding": expected_binding,
        }),
        connection: None,
    }
}

#[tokio::test]
async fn exact_codex_recovery_rotates_one_dead_runtime_generation() {
    let (_root, state, expected, attach_count) =
        selected_codex_recovery_fixture(AgentExecutionProfileV1::ProviderDefault).await;

    let response = dispatch(&state, &recovery_request(&state, &expected))
        .await
        .unwrap();
    let recovered: AgentInteractionBindingV1 =
        serde_json::from_value(response["binding"].clone()).unwrap();

    assert_eq!(attach_count.load(Ordering::SeqCst), 1);
    assert_eq!(recovered.binding_revision, expected.binding_revision + 1);
    assert_eq!(
        recovered.runtime.runtime_generation,
        "runtime-codex-recovered"
    );
    assert_eq!(
        state
            .store
            .agent_interaction_for_agent(&expected.agent_id)
            .await
            .unwrap(),
        Some(recovered)
    );
}

#[tokio::test]
async fn stale_credential_recovery_never_reaches_the_provider_process() {
    let current_profile = AgentExecutionProfileV1::CredentialReference {
        reference_id: "account-current".into(),
        credential_generation: Some("credential-current".into()),
    };
    let (_root, state, current, attach_count) =
        selected_codex_recovery_fixture(current_profile).await;
    let mut stale = current.clone();
    stale.execution_profile = AgentExecutionProfileV1::CredentialReference {
        reference_id: "account-stale".into(),
        credential_generation: Some("credential-stale".into()),
    };

    let error = dispatch(&state, &recovery_request(&state, &stale))
        .await
        .unwrap_err();

    assert_eq!(error.code, "agent_conversation_conflict");
    assert_eq!(attach_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        state
            .store
            .agent_interaction_for_agent(&current.agent_id)
            .await
            .unwrap(),
        Some(current)
    );
}

#[tokio::test]
async fn exact_recovery_queued_behind_a_credential_switch_has_zero_provider_effects() {
    let (_root, state, expected, attach_count) =
        selected_codex_recovery_fixture(AgentExecutionProfileV1::ProviderDefault).await;
    let state = Arc::new(state);
    let guard = state.agent_operations.acquire(&expected.agent_id).await;
    let request = recovery_request(&state, &expected);
    let recovery = {
        let state = Arc::clone(&state);
        tokio::spawn(async move { dispatch(&state, &request).await })
    };
    let source = state
        .store
        .agent_runtime_selection(&expected.agent_id)
        .await
        .unwrap()
        .unwrap();
    state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("credential-switch-before-recovery").unwrap(),
            idempotency_key: "credential-switch-before-recovery-key".into(),
            source,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: expected.clone(),
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                expected.provider_conversation_ref.as_deref().unwrap(),
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: AgentExecutionProfileV1::CredentialReference {
                reference_id: "account-next".into(),
                credential_generation: Some("credential-next".into()),
            },
            target_launch_selection: None,
            requested_at_ms: 20,
        })
        .await
        .unwrap();
    drop(guard);

    let error = recovery.await.unwrap().unwrap_err();

    assert_eq!(error.code, "agent_conversation_conflict");
    assert_eq!(attach_count.load(Ordering::SeqCst), 0);
}
