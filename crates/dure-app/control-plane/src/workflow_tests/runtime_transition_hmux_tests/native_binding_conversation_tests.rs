use super::*;
use hmux_client::{
    AgentRuntimeActivity, AgentRuntimeAttention, AgentStateReport, ManagedAgentStateReporter,
    ProviderConversationIdentity, SessionFence,
};

#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn native_binding_learned_conversation_uses_real_hmux() {
    for bound_conversation in [None, Some(CONVERSATION), Some("another-conversation")] {
        ensure_late_conversation(bound_conversation).await;
    }
}

/// Claude's `/clear` keeps the process and starts a new conversation. The
/// desktop proposes it to the Host as the successor of the current one, and the
/// Host accepts only that. A runtime change made afterwards resumes it.
#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn native_binding_follows_a_continued_conversation_uses_real_hmux() {
    const CONTINUED: &str = "019f0000-0000-7000-8000-000000000002";
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 120\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let agent_id = AgentIdV1::new("continued-conversation-agent").unwrap();
    let source = launch(&state, &hmux, "continued-conversation-source").await;
    bind_source(&state, &agent_id, &source).await;
    let fence = SessionFence {
        workspace_id: source.workspace_id.clone(),
        session_id: source.session_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: source.runner_instance.clone(),
        channel_epoch: source.channel_epoch.parse().unwrap(),
        host_instance_id: source.host_instance_id.clone(),
        terminal_epoch: source.terminal_epoch.clone(),
    };
    // Hook reports are causal, and a continuation must be one.
    let report = |conversation_identity, sequence, turn_completed| AgentStateReport {
        approval_request: None,
        progress: None,
        identity_only: false,
        activity: AgentRuntimeActivity::Waiting,
        attention: AgentRuntimeAttention::None,
        turn_completed,
        turn_completion_id: turn_completed.then(|| "continued-turn".into()),
        turn_failure: None,
        causality: Some(hmux_client::AgentStateReportCausality {
            sequence,
            work_id: turn_completed.then(|| "continued-turn".into()),
        }),
        working_ttl_ms: None,
        conversation_identity,
        expected_observation: None,
        background_work: false,
        startup_gate: None,
    };
    let reporter =
        ManagedAgentStateReporter::new(&state.hmux_identity.runtime_executable_path, &hmux.root)
            .with_discovery_root(&hmux.discovery);
    let attach = || {
        hmux_client::ManagedAttachRequest::new(&source.session_id, &source.workspace_id).unwrap()
    };
    let unrelated = ProviderConversationIdentity {
        provider_id: "codex".into(),
        conversation_id: "unrelated-conversation".into(),
        previous_conversation_id: None,
        expected_fence: Some(fence.clone()),
    };
    assert!(
        reporter
            .report_agent_state_for_fence(
                attach(),
                report(Some(unrelated), 1, false),
                fence.clone()
            )
            .is_err(),
        "the Host refuses a conversation that does not continue its own"
    );
    reporter
        .report_agent_state_for_fence(
            attach(),
            report(
                Some(ProviderConversationIdentity {
                    provider_id: "codex".into(),
                    conversation_id: CONTINUED.into(),
                    previous_conversation_id: Some(CONVERSATION.into()),
                    expected_fence: Some(fence.clone()),
                }),
                2,
                false,
            ),
            fence.clone(),
        )
        .unwrap();
    reporter
        .report_agent_state_for_fence(attach(), report(None, 3, true), fence)
        .unwrap();

    let receipt = agent_runtime_transition_apply::apply(
        &state,
        "continued-conversation-setting",
        agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            expected_source_revision: Some(1),
            expected_operation_id: None,
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            target_execution_profile: None,
            target_launch_selection: Some(dure_app::AgentRuntimeLaunchSelectionV1 {
                model: Some(dure_app::AgentSpawnModelSelectionV1::parse("gpt-6-astra").unwrap()),
                effort: None,
                permission_mode: None,
            }),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(receipt).unwrap()["providerConversationRef"],
        CONTINUED
    );
    assert_eq!(
        hmux.requests()
            .last()
            .unwrap()
            .provider_conversation_ref
            .as_deref(),
        Some(CONTINUED),
        "the successor resumes the conversation the process ran, not the one it was launched with"
    );
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        authority.binding.provider_conversation_id.as_deref(),
        Some(CONTINUED)
    );
    hmux.stop(&WorkflowSessionGenerationV1::from_checkpoint_authority(
        &authority,
        &ProviderIdV1::new("codex").unwrap(),
    ));
}

async fn ensure_late_conversation(bound_conversation: Option<&str>) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 120\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let agent_id = AgentIdV1::new("late-conversation-agent").unwrap();
    let source = launch_conversation(&state, &hmux, "late-conversation-source", None).await;
    bind_source_conversation(&state, &agent_id, &source, bound_conversation).await;
    let before = hmux.session(&source);
    let original = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let binding = BindingEnsureBody {
        schema_version: 1,
        agent_id: agent_id.clone(),
        session_id: source.session_id.clone(),
        workspace_id: source.workspace_id.clone(),
        display_name: "Native fixture".into(),
        worktree_path: hmux.root.to_str().unwrap().into(),
        stop_fence: authority_stop_fence(&original),
    };
    if bound_conversation.is_none() {
        ensure_binding(&state, binding.clone()).await.unwrap();
        assert_eq!(
            inspect(&state, &agent_id).await["receipt"]["providerConversationRef"],
            Value::Null
        );
    }
    let fence = SessionFence {
        workspace_id: source.workspace_id.clone(),
        session_id: source.session_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: source.runner_instance.clone(),
        channel_epoch: source.channel_epoch.parse().unwrap(),
        host_instance_id: source.host_instance_id.clone(),
        terminal_epoch: source.terminal_epoch.clone(),
    };
    ManagedAgentStateReporter::new(&state.hmux_identity.runtime_executable_path, &hmux.root)
        .with_discovery_root(&hmux.discovery)
        .report_agent_state_for_fence(
            hmux_client::ManagedAttachRequest::new(&source.session_id, &source.workspace_id)
                .unwrap(),
            AgentStateReport {
                approval_request: None,
                progress: None,
                identity_only: true,
                activity: AgentRuntimeActivity::Waiting,
                attention: AgentRuntimeAttention::None,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                conversation_identity: Some(ProviderConversationIdentity {
                    provider_id: "codex".into(),
                    conversation_id: CONVERSATION.into(),
                    previous_conversation_id: None,
                    expected_fence: Some(fence.clone()),
                }),
                expected_observation: None,
                background_work: false,
                startup_gate: None,
                turn_failure: None,
            },
            fence.clone(),
        )
        .unwrap();
    let mut stale = binding.clone();
    stale.stop_fence.terminal_epoch = "another-terminal".into();
    assert_eq!(
        ensure_binding(&state, stale).await.unwrap_err(),
        "agent_checkpoint_binding_runtime_owned"
    );
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap()
            .unwrap(),
        original
    );
    let mut stale_workspace = binding.clone();
    stale_workspace.worktree_path.push_str("-other");
    assert_eq!(
        ensure_binding(&state, stale_workspace).await.unwrap_err(),
        "agent_checkpoint_binding_workspace_stale"
    );
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap()
            .unwrap(),
        original
    );
    // The exact generation's Host names the conversation it runs. A binding
    // that recorded none, or another one, follows it.
    let result = ensure_binding(&state, binding.clone()).await;
    assert!(
        result.is_ok(),
        "same-generation binding must learn its conversation: {result:?}"
    );
    assert_eq!(
        ensure_binding(&state, binding).await.unwrap(),
        result.unwrap()
    );
    assert!(before.same_generation(&hmux.session(&source)));
    assert_eq!(
        hmux.requests().len(),
        1,
        "identity convergence cannot launch a successor"
    );
    let mut expected = original;
    expected.binding.provider_conversation_id = Some(CONVERSATION.into());
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap()
            .unwrap(),
        expected
    );
    state.store = Arc::new(
        SqliteDomainStore::open(hmux.root.join("domain.sqlite"))
            .await
            .unwrap(),
    );
    let observation = serde_json::to_value(
        agent_runtime_transition_apply::inspect_projection(
            &state,
            agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 {
                schema_version: 1,
                agent_id: agent_id.clone(),
            },
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        observation["receipt"]["providerConversationRef"],
        CONVERSATION
    );
    assert_eq!(observation["receipt"]["selectionRevision"], 1);

    // Settings and accounts share Preserve admission. Use a setting here so
    // the real runtime test needs no account secrets or provider login.
    let transition = agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        target_interaction_profile: AgentInteractionProfileV1::NativeCli,
        expected_source_revision: Some(1),
        expected_operation_id: None,
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        target_execution_profile: None,
        target_launch_selection: Some(dure_app::AgentRuntimeLaunchSelectionV1 {
            model: Some(dure_app::AgentSpawnModelSelectionV1::parse("gpt-6-astra").unwrap()),
            effort: None,
            permission_mode: None,
        }),
    };
    assert_eq!(
        agent_runtime_transition_apply::apply(&state, "late-conversation-busy", transition.clone())
            .await
            .unwrap_err()
            .code,
        "agent_runtime_source_busy"
    );
    assert!(before.same_generation(&hmux.session(&source)));
    assert_eq!(hmux.requests().len(), 1);
    ManagedAgentStateReporter::new(&state.hmux_identity.runtime_executable_path, &hmux.root)
        .with_discovery_root(&hmux.discovery)
        .report_agent_state_for_fence(
            hmux_client::ManagedAttachRequest::new(&source.session_id, &source.workspace_id)
                .unwrap(),
            AgentStateReport {
                approval_request: None,
                progress: None,
                identity_only: false,
                activity: AgentRuntimeActivity::Waiting,
                attention: AgentRuntimeAttention::None,
                turn_completed: true,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                conversation_identity: None,
                expected_observation: None,
                background_work: false,
                startup_gate: None,
                turn_failure: None,
            },
            fence,
        )
        .unwrap();
    let receipt =
        agent_runtime_transition_apply::apply(&state, "late-conversation-setting", transition)
            .await
            .unwrap();
    assert_eq!(
        serde_json::to_value(receipt).unwrap()["providerConversationRef"],
        CONVERSATION
    );
    assert_eq!(
        hmux.requests()
            .last()
            .unwrap()
            .provider_conversation_ref
            .as_deref(),
        Some(CONVERSATION)
    );
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    hmux.stop(&WorkflowSessionGenerationV1::from_checkpoint_authority(
        &authority,
        &ProviderIdV1::new("codex").unwrap(),
    ));
}
