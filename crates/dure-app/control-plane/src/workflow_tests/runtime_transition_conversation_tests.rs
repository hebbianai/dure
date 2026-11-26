//! A Terminal Agent whose provider moved to a new conversation in the same
//! process, as Claude does after `/clear` or an in-process continuation. The
//! Host follows it for the exact Session generation; the Agent's runtime
//! changes must resume what the process runs now.

use super::*;

const BEFORE_CLEAR: &str = "conversation-before-clear";
const AFTER_CLEAR: &str = "conversation-after-clear";
const ATTEMPT: &str = "cleared-terminal-to-chat";

/// Opens the Chat a move asks for and records the conversation it resumes.
struct ResumingChatRuntime {
    store: Arc<SqliteDomainStore>,
    resumed: Arc<StdMutex<Vec<Option<String>>>>,
}

fn unavailable() -> structured_provider_runtime::StructuredProviderRuntimeErrorV1 {
    structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
        structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
        "resuming_chat_fixture_unavailable",
    )
}

impl structured_provider_runtime::StructuredProviderRuntime for ResumingChatRuntime {
    fn open(
        &self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(unavailable()) })
    }

    fn attach_existing<'a>(
        &'a self,
        _selection: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        Box::pin(async move { Ok(binding.clone()) })
    }

    fn open_replacement<'a>(
        &'a self,
        request: structured_provider_runtime::StructuredProviderOpenRequestV1,
        transition: &'a AgentRuntimeTransitionRecordV1,
        _provider_state_environment: hmux_client::ProviderStateEnvironment,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        self.resumed
            .lock()
            .unwrap()
            .push(request.provider_conversation_ref.clone());
        let store = Arc::clone(&self.store);
        let provider_id = transition.intent.source.provider_id.clone();
        Box::pin(async move {
            store
                .create_agent_interaction(&AgentInteractionBindingV1 {
                    schema_version: 1,
                    interaction_session_id: AgentInteractionSessionIdV1::new(
                        "cleared-terminal-chat",
                    )
                    .unwrap(),
                    agent_id: request.agent_id,
                    provider_id,
                    execution_profile: request.execution_profile,
                    provider_conversation_ref: request.provider_conversation_ref,
                    runtime: AgentProviderRuntimeFenceV1 {
                        runtime_generation: "cleared-terminal-chat-runtime".into(),
                        provider_epoch: "cleared-terminal-chat-provider".into(),
                    },
                    timeline_epoch: AgentTimelineEpochV1::new("cleared-terminal-chat-timeline")
                        .unwrap(),
                    binding_revision: 1,
                    history_complete: false,
                    created_at_ms: 30,
                    updated_at_ms: 30,
                })
                .await
                .map_err(|_| unavailable())
        })
    }

    fn stop_replacement_source<'a>(
        &'a self,
        _transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn retire_replacement_source<'a>(
        &'a self,
        _transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<
        'a,
        dure_app::AgentRuntimeReplacementAuthorityV1,
    > {
        Box::pin(async { Err(unavailable()) })
    }

    fn stop_current<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

fn framed(value: &impl serde::Serialize) -> Vec<u8> {
    let payload = serde_json::to_vec(value).unwrap();
    let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(&payload);
    frame
}

struct ClearedTerminal {
    _root: TempDir,
    state: ServiceState,
    agent_id: AgentIdV1,
    stop_calls: std::path::PathBuf,
    resumed: Arc<StdMutex<Vec<Option<String>>>>,
}

/// An idle Codex-shaped Terminal Agent bound to `BEFORE_CLEAR` whose exact Host
/// generation now reports `AFTER_CLEAR`, the successor it verified.
async fn cleared_terminal() -> ClearedTerminal {
    let agent_id = AgentIdV1::new("cleared-terminal-agent").unwrap();
    let provider_id = ProviderIdV1::new("codex").unwrap();
    let (root, mut state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            agent_id: agent_id.clone(),
            agent_provider_id: provider_id.clone(),
            conversation_id: Some(BEFORE_CLEAR.into()),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    state
        .store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            provider_id: provider_id.clone(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    let generation = json!({
        "session_id": "coordinator-session",
        "workspace_id": "coordinator-workspace",
        "runner_principal": "coordinator-runner",
        "runner_instance": "coordinator-instance",
        "channel_epoch": "1",
        "host_instance_id": "coordinator-host",
        "terminal_epoch": "coordinator-terminal",
    });
    let mut identity = generation.clone();
    identity["provider_id"] = json!("codex");
    identity["conversation_id"] = json!(AFTER_CLEAR);
    let mut inspection = generation;
    inspection.as_object_mut().unwrap().extend(
        json!({
            "schema_version": 1,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": "codex",
            "output_seq": "0",
            "health": "healthy",
            "agentRuntimeState": {
                "terminal_epoch": "coordinator-terminal",
                "revision": "1",
                "observed_through_output_seq": "0",
                "lifecycle": "running",
                "activity": "waiting",
                "attention": "none",
                "attention_id": null,
                "turn_completed_count": "1"
            },
            "providerConversationIdentity": identity,
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("current-session.json"),
        serde_json::to_vec(&inspection).unwrap(),
    )
    .unwrap();

    // The source stop must pin the conversation the Host reports; the broker
    // answers only that exact request.
    let (operation_id, _) =
        agent_runtime_transition_apply::runtime_transition_identity(ATTEMPT).unwrap();
    let stop_request = ManagedStopRequest::new(
        agent_runtime_transition_apply::quiescent_stop_identity(&operation_id, 1, 0),
        "coordinator-session",
        "coordinator-workspace",
    )
    .unwrap()
    .with_expected_fence(
        "coordinator-runner",
        "coordinator-instance",
        1,
        "coordinator-host",
        "coordinator-terminal",
    )
    .unwrap()
    .with_expected_conversation(
        ManagedStopConversationFence::new("codex", Some(AFTER_CLEAR.into())).unwrap(),
    )
    .unwrap()
    .with_expected_quiescence(
        ManagedStopQuiescenceFence::new("coordinator-terminal", 1, 0).unwrap(),
    )
    .unwrap();
    let reconcile_path = root.path().join("cleared-stop-reconcile.bin");
    fs::write(
        &reconcile_path,
        framed(&ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_intent_not_found",
            "cleared fixture has no prior stop",
        )),
    )
    .unwrap();
    let stopped_path = root.path().join("cleared-stop-completed.bin");
    fs::write(
        &stopped_path,
        framed(&ManagedStopBrokerResponse::Completed(Box::new(
            ManagedStopReceipt::from_request(
                &stop_request,
                ManagedStopOutcome::Stopped,
                "cleared fixture exact source stopped",
            )
            .unwrap(),
        ))),
    )
    .unwrap();
    let stop_calls = root.path().join("cleared-stop-calls");
    let hmux = state.hmux_identity.executable_path.clone();
    let hmux_runtime = state.hmux_identity.runtime_executable_path.clone();
    fs::write(
        &hmux_runtime,
        format!(
            "#!/bin/sh\ncase \"${{2:-}}\" in\n  {MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}) cat '{}';;\n  {MANAGED_STOP_BROKER_SUBCOMMAND}) printf x >> '{}'; cat '{}';;\n  *) exit 64;;\nesac\n",
            reconcile_path.display(),
            stop_calls.display(),
            stopped_path.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&hmux_runtime, fs::Permissions::from_mode(0o700)).unwrap();
    state.hmux_identity =
        resolve_hmux_toolchain_identity(&hmux, &hmux_runtime, &state.hmux_identity.discovery_root)
            .unwrap();
    make_fixture_mutation_authority(&mut state);
    state.agent_providers =
        Arc::new(provider_extension::test_codex_structured_agent_provider_registry());
    let resumed = Arc::new(StdMutex::new(Vec::new()));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(ResumingChatRuntime {
                store: Arc::clone(&state.store),
                resumed: Arc::clone(&resumed),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    ClearedTerminal {
        _root: root,
        state,
        agent_id,
        stop_calls,
        resumed,
    }
}

async fn move_into_chat(
    terminal: &ClearedTerminal,
) -> Result<
    agent_runtime_transition_apply::AgentRuntimeTransitionApplyReceiptV1,
    crate::BackendDispatchError,
> {
    agent_runtime_transition_apply::apply(
        &terminal.state,
        ATTEMPT,
        agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
            schema_version: 1,
            agent_id: terminal.agent_id.clone(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            expected_source_revision: Some(1),
            expected_operation_id: None,
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            target_execution_profile: None,
            target_launch_selection: None,
        },
    )
    .await
}

async fn bound_conversation(terminal: &ClearedTerminal) -> Option<String> {
    terminal
        .state
        .store
        .agent_checkpoint_binding_authority(&terminal.agent_id)
        .await
        .unwrap()
        .unwrap()
        .binding
        .provider_conversation_id
}

#[tokio::test]
async fn a_terminal_agent_moves_into_chat_with_the_conversation_its_clear_started() {
    let terminal = cleared_terminal().await;

    let receipt = move_into_chat(&terminal).await.unwrap();

    assert_eq!(
        serde_json::to_value(&receipt).unwrap()["providerConversationRef"],
        AFTER_CLEAR
    );
    assert_eq!(
        *terminal.resumed.lock().unwrap(),
        vec![Some(AFTER_CLEAR.to_owned())],
        "Chat resumes the conversation the Terminal runs, not the one it was bound with"
    );
    assert_eq!(fs::read(&terminal.stop_calls).unwrap(), b"x");
    let (operation_id, _) =
        agent_runtime_transition_apply::runtime_transition_identity(ATTEMPT).unwrap();
    let transition = terminal
        .state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(transition.state, AgentRuntimeTransitionStateV1::Committed);
    assert_eq!(
        transition.intent.provider_conversation_ref.as_option(),
        Some(AFTER_CLEAR)
    );
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority } =
        &transition.intent.source_authority
    else {
        panic!("the move starts from the Terminal");
    };
    assert_eq!(
        authority.binding.provider_conversation_id.as_deref(),
        Some(AFTER_CLEAR)
    );
    assert_eq!(
        terminal
            .state
            .store
            .agent_runtime_selection(&terminal.agent_id)
            .await
            .unwrap()
            .unwrap()
            .interaction_profile,
        AgentInteractionProfileV1::StructuredProtocol
    );
    assert_eq!(
        terminal
            .state
            .store
            .agent_interaction_for_agent(&terminal.agent_id)
            .await
            .unwrap()
            .unwrap()
            .provider_conversation_ref
            .as_deref(),
        Some(AFTER_CLEAR)
    );
}

#[tokio::test]
async fn a_chat_that_continues_the_conversation_before_clear_refuses_the_move_before_the_terminal_stops()
 {
    let terminal = cleared_terminal().await;
    // The Agent was in Chat before it moved to the Terminal and ran `/clear`.
    let earlier_chat = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("earlier-chat").unwrap(),
        agent_id: terminal.agent_id.clone(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some(BEFORE_CLEAR.into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "earlier-chat-runtime".into(),
            provider_epoch: "earlier-chat-provider".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("earlier-chat-timeline").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 5,
        updated_at_ms: 5,
    };
    terminal
        .state
        .store
        .create_agent_interaction(&earlier_chat)
        .await
        .unwrap();
    let selection = terminal
        .state
        .store
        .agent_runtime_selection(&terminal.agent_id)
        .await
        .unwrap();

    let error = move_into_chat(&terminal).await.unwrap_err();

    assert_eq!(error.code, "agent_runtime_provider_conversation_changed");
    assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
    assert!(!terminal.stop_calls.exists(), "the Terminal keeps running");
    assert!(terminal.resumed.lock().unwrap().is_empty());
    let (operation_id, _) =
        agent_runtime_transition_apply::runtime_transition_identity(ATTEMPT).unwrap();
    assert!(
        terminal
            .state
            .store
            .agent_runtime_transition(&operation_id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        terminal
            .state
            .store
            .agent_runtime_selection(&terminal.agent_id)
            .await
            .unwrap(),
        selection
    );
    assert_eq!(
        terminal
            .state
            .store
            .agent_interaction(&earlier_chat.interaction_session_id)
            .await
            .unwrap(),
        Some(earlier_chat)
    );
    // The binding still records what the Terminal runs now.
    assert_eq!(
        bound_conversation(&terminal).await.as_deref(),
        Some(AFTER_CLEAR)
    );
}
