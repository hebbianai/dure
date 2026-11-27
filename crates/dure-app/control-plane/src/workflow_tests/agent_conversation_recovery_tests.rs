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

/// `dure runs resume` sends the binding the runtime projection reported as
/// recover's exact fence, and requires the capability saying that recover
/// relaunches a provider that ended.
#[tokio::test]
async fn the_projected_chat_binding_fences_a_recover_that_requires_provider_exit() {
    let (_root, state, expected, attach_count) =
        selected_codex_recovery_fixture(AgentExecutionProfileV1::ProviderDefault).await;
    let mut inspect = recovery_request(&state, &expected);
    inspect.request_id = "agent-runtime-projection-inspect-1".into();
    inspect.operation = "agent_runtime.projection.inspect".into();
    inspect.body = json!({ "schemaVersion": 1, "agentId": expected.agent_id });
    let observed = dispatch(&state, &inspect).await.unwrap();
    assert_eq!(observed["state"], "stable");
    let authority = &observed["receipt"]["authority"];
    assert_eq!(authority["interactionProfile"], "structured_protocol");

    let mut recover = recovery_request(&state, &expected);
    recover.body = json!({ "schemaVersion": 1, "expectedBinding": authority["binding"] });
    recover.expected.required_capabilities = vec![
        "agent_conversation.recover".into(),
        "agent_conversation.recover.provider_exit.v1".into(),
    ];
    let response = dispatch(&state, &recover).await.unwrap();
    let recovered: AgentInteractionBindingV1 =
        serde_json::from_value(response["binding"].clone()).unwrap();

    assert_eq!(attach_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        recovered.interaction_session_id,
        expected.interaction_session_id
    );
    assert_ne!(recovered.runtime, expected.runtime);
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
            workspace_move: None,
            requested_at_ms: 20,
        })
        .await
        .unwrap();
    drop(guard);

    let error = recovery.await.unwrap().unwrap_err();

    assert_eq!(error.code, "agent_conversation_conflict");
    assert_eq!(attach_count.load(Ordering::SeqCst), 0);
}

/// A provider that records the input of each turn it starts.
#[derive(Default)]
struct RecordingCommands {
    inputs: StdMutex<Vec<String>>,
}

impl crate::agent_conversation::AgentProviderCommands for RecordingCommands {
    fn start_turn<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
        intent: &'a dure_app::AgentStartTurnIntentV1,
    ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
        self.inputs.lock().unwrap().push(intent.input.clone());
        Box::pin(async { Ok(json!({ "accepted": true })) })
    }

    fn answer_pending<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
        _: &'a dure_app::AgentPendingAnswerIntentV1,
        _: &'a dure_app::AgentPendingRequestV1,
    ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
        Box::pin(async { unreachable!("no request is pending") })
    }

    fn interrupt_turn<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
        _: &'a dure_app::AgentInterruptTurnRequestV1,
    ) -> crate::agent_conversation::AgentProviderCommandFuture<'a> {
        Box::pin(async { unreachable!("no turn is interrupted") })
    }
}

/// A structured runtime whose `attach_existing` keeps a live provider and
/// relaunches a gone one on a new runtime generation, as the Claude and
/// Codex runtimes do. With `credential_unavailable`, a relaunch is refused
/// the way a missing account is.
struct RelaunchingRuntime {
    state_store: Arc<SqliteDomainStore>,
    registry: Arc<crate::agent_conversation_api::AgentConversationRuntimeRegistry>,
    commands: Arc<RecordingCommands>,
    kept_live: AtomicUsize,
    relaunch_attempts: AtomicUsize,
    credential_unavailable: bool,
}

impl structured_provider_runtime::StructuredProviderRuntime for RelaunchingRuntime {
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
        Box::pin(async move {
            if self.registry.resolve(binding).is_ok() {
                self.kept_live.fetch_add(1, Ordering::SeqCst);
                return Ok(binding.clone());
            }
            let attempt = self.relaunch_attempts.fetch_add(1, Ordering::SeqCst) + 1;
            if self.credential_unavailable {
                return Err(
                    structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                        structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::CredentialUnavailable,
                        "relaunching_runtime_credential_unavailable",
                    ),
                );
            }
            let relaunched = self
                .state_store
                .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
                    schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                    interaction_session_id: binding.interaction_session_id.clone(),
                    expected_binding_revision: binding.binding_revision,
                    source: binding.runtime.clone(),
                    source_execution_profile: binding.execution_profile.clone(),
                    target: AgentProviderRuntimeFenceV1 {
                        runtime_generation: format!("runtime-relaunched-{attempt}"),
                        provider_epoch: format!("provider-relaunched-{attempt}"),
                    },
                    target_execution_profile: binding.execution_profile.clone(),
                    provider_conversation_ref: binding.provider_conversation_ref.clone(),
                    replaced_at_ms: binding.updated_at_ms + 1,
                })
                .await
                .map_err(|_| CountingStructuredRuntime::unavailable())?;
            self.registry
                .register(relaunched.clone(), self.commands.clone())
                .map_err(|_| CountingStructuredRuntime::unavailable())?;
            Ok(relaunched)
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

/// A headless Chat Agent (no client subscribed) whose provider is live, with
/// the backend's runtime recovery and conversation loops running.
async fn headless_chat_fixture(
    credential_unavailable: bool,
) -> (
    TempDir,
    Arc<ServiceState>,
    AgentInteractionBindingV1,
    Arc<RelaunchingRuntime>,
    Vec<tokio::task::JoinHandle<()>>,
) {
    let (root, mut state, binding, _) =
        selected_codex_recovery_fixture(AgentExecutionProfileV1::ProviderDefault).await;
    let runtime = Arc::new(RelaunchingRuntime {
        state_store: Arc::clone(&state.store),
        registry: Arc::clone(&state.agent_conversation_runtimes),
        commands: Arc::new(RecordingCommands::default()),
        kept_live: AtomicUsize::new(0),
        relaunch_attempts: AtomicUsize::new(0),
        credential_unavailable,
    });
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(binding.provider_id.clone(), runtime.clone())
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    state
        .agent_conversation_runtimes
        .register(binding.clone(), runtime.commands.clone())
        .unwrap();
    let state = Arc::new(state);
    let loops = vec![
        tokio::spawn(crate::agent_runtime_recovery::run(Arc::clone(&state))),
        tokio::spawn(crate::agent_conversation::continuation::run(Arc::clone(
            &state,
        ))),
    ];
    // Startup recovery finds the provider live and keeps it.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while runtime.kept_live.load(Ordering::SeqCst) == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "startup recovery never looked at the runtime"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    (root, state, binding, runtime, loops)
}

/// What the Claude host does when a Query ends by itself: its commands leave
/// the registry. Then input is queued for the Agent, as `dure send` or a
/// child's result does.
async fn provider_ends_then_input_is_queued(
    state: &ServiceState,
    binding: &AgentInteractionBindingV1,
    input: &str,
) {
    state
        .agent_conversation_runtimes
        .retire(&binding.interaction_session_id, &binding.runtime)
        .unwrap();
    state
        .agent_conversations
        .enqueue_turn_intent(&dure_app::AgentStartTurnIntentV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: binding.interaction_session_id.clone(),
            runtime: binding.runtime.clone(),
            turn_id: dure_app::AgentTurnIdV1::new("turn-after-exit").unwrap(),
            client_message_id: dure_app::AgentClientMessageIdV1::new("message-after-exit").unwrap(),
            input: input.into(),
            requested_at_ms: binding.updated_at_ms + 1,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn queued_input_relaunches_a_headless_chat_whose_provider_ended() {
    let (_root, state, binding, runtime, loops) = headless_chat_fixture(false).await;

    provider_ends_then_input_is_queued(&state, &binding, "continue the work").await;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while runtime.commands.inputs.lock().unwrap().is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the queued input never reached a relaunched provider"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        *runtime.commands.inputs.lock().unwrap(),
        ["continue the work"]
    );
    assert_eq!(runtime.relaunch_attempts.load(Ordering::SeqCst), 1);
    let current = state
        .store
        .agent_interaction_for_agent(&binding.agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.runtime.runtime_generation, "runtime-relaunched-1");
    assert_eq!(
        current.provider_conversation_ref,
        binding.provider_conversation_ref
    );
    for task in loops {
        task.abort();
    }
}

#[tokio::test]
async fn a_relaunch_that_cannot_succeed_is_not_repeated_for_each_wake() {
    let (_root, state, binding, runtime, loops) = headless_chat_fixture(true).await;

    provider_ends_then_input_is_queued(&state, &binding, "continue the work").await;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while runtime.relaunch_attempts.load(Ordering::SeqCst) == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the queued input never asked for a relaunch"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    // Each refused relaunch wakes the conversation loop, which finds the
    // input still waiting. The same refusal is not asked for again.
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    state.goal_wakeup.notify_one();
    state.agent_runtime_recovery_wake.notify_one();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(runtime.relaunch_attempts.load(Ordering::SeqCst), 1);
    assert!(runtime.commands.inputs.lock().unwrap().is_empty());
    for task in loops {
        task.abort();
    }
}
