use super::*;
use real_hmux::RealHmux;

mod delegate_checkout_tests;
mod native_binding_conversation_tests;
mod native_close_retirement_tests;
mod native_deferred_tests;
mod native_publication_tests;
mod native_run_rehost_tests;
mod native_stop_conversation_tests;
mod state_reporter;

const CONVERSATION: &str = "019f0000-0000-7000-8000-000000000001";

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run pnpm test:hmux-runtime-transition"]
async fn runtime_transition_uses_real_hmux() {
    no_op_replay_does_not_restart_a_closed_runtime().await;
    for corrected_target in [false, true] {
        stopped_close_successor(corrected_target).await;
    }
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run pnpm test:hmux-runtime-selection"]
async fn runtime_selection_uses_real_hmux() {
    for target in [
        dure_app::AgentRuntimeLaunchSelectionV1 {
            model: Some(dure_app::AgentSpawnModelSelectionV1::parse("gpt-6-astra").unwrap()),
            effort: None,
            permission_mode: None,
        },
        dure_app::AgentRuntimeLaunchSelectionV1 {
            model: None,
            effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("high").unwrap()),
            permission_mode: None,
        },
        dure_app::AgentRuntimeLaunchSelectionV1 {
            model: None,
            effort: None,
            permission_mode: Some(dure_app::AgentSpawnPermissionModeV1::SkipPermissions),
        },
    ] {
        active_source_waits_for_a_quiescent_preserve_transition(target).await;
    }
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the auto-edit control-plane smoke"]
async fn runtime_auto_edit_selection_uses_real_hmux() {
    active_source_waits_for_a_quiescent_preserve_transition(
        dure_app::AgentRuntimeLaunchSelectionV1 {
            model: None,
            effort: None,
            permission_mode: Some(dure_app::AgentSpawnPermissionModeV1::AutoEdit),
        },
    )
    .await;
}

// Exercise the same Preserve admission used by deferred credential switches,
// with a launch-selection change so the fixture needs no account secrets.
async fn active_source_waits_for_a_quiescent_preserve_transition(
    target: dure_app::AgentRuntimeLaunchSelectionV1,
) {
    use hmux_client::{AgentRuntimeActivity, AgentRuntimeAttention};
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 60\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let agent_id = AgentIdV1::new("busy-native-agent").unwrap();
    let source = launch(&state, &hmux, "busy-native-source").await;
    bind_source(&state, &agent_id, &source).await;
    let original = hmux.session(&source);
    let body = agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        target_interaction_profile: AgentInteractionProfileV1::NativeCli,
        expected_source_revision: Some(1),
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        target_execution_profile: None,
        target_launch_selection: Some(target),
    };
    let report = |activity, attention, completed| {
        state_reporter::report(&hmux, &source, activity, attention, completed);
    };
    for (key, activity, attention) in [
        (
            "working-switch",
            AgentRuntimeActivity::Working,
            AgentRuntimeAttention::None,
        ),
        (
            "approval-switch",
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::ApprovalRequired,
        ),
    ] {
        report(activity, attention, false);
        let error = agent_runtime_transition_apply::apply(&state, key, body.clone())
            .await
            .unwrap_err();
        assert_eq!(error.code, "agent_runtime_source_busy", "{error:?}");
        assert_eq!(hmux.requests().len(), 1);
        let retained = hmux.session(&source);
        assert!(retained.same_generation(&original));
        assert_eq!(retained.host_process, original.host_process);
        assert_eq!(retained.lifecycle, hmux_client::SessionLifecycle::Ready);
        assert_eq!(
            inspect(&state, &agent_id).await["receipt"]["selectionRevision"],
            1
        );
    }
    // Resolving the approval resumes work before the eventual completion.
    report(
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    // Waiting is not enough when the Host still owns unsubmitted input. This
    // refusal is definitive: the same source remains selected and running.
    let controller = hmux_client::LocalSessionCatalog::new(&hmux.discovery)
        .open(&hmux_client::SessionSelector::new(
            &source.session_id,
            Some(source.workspace_id.clone()),
        ))
        .unwrap();
    controller.send_input(b"pending draft".to_vec()).unwrap();
    let retained = agent_runtime_transition_apply::apply(&state, "draft-switch", body.clone())
        .await
        .unwrap_err();
    assert_eq!(
        retained.code, "agent_runtime_source_retained",
        "{retained:?}"
    );
    assert!(hmux.session(&source).same_generation(&original));
    assert_eq!(hmux.requests().len(), 1);
    assert_eq!(
        inspect(&state, &agent_id).await["receipt"]["selectionRevision"],
        1
    );
    controller.send_input(b"\r".to_vec()).unwrap();
    report(
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    let receipt = agent_runtime_transition_apply::apply(&state, "completed-switch", body.clone())
        .await
        .unwrap();
    let projection = serde_json::to_value(&receipt).unwrap();
    assert_eq!(projection["selectionRevision"], 2);
    assert_eq!(projection["providerConversationRef"], CONVERSATION);
    assert_eq!(hmux.requests().len(), 2);
    assert_eq!(
        hmux.session(&source).lifecycle,
        hmux_client::SessionLifecycle::Exited
    );
    assert_eq!(
        agent_runtime_transition_apply::apply(&state, "completed-switch", body)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(hmux.requests().len(), 2);
    agent_runtime_close_apply::apply(
        &state,
        "close-busy-fixture-successor",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id,
        },
    )
    .await
    .unwrap();
}

async fn no_op_replay_does_not_restart_a_closed_runtime() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 60\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let agent_id = AgentIdV1::new("native-noop-agent").unwrap();
    let source = launch(&state, &hmux, "native-noop-source").await;
    bind_source(&state, &agent_id, &source).await;
    let body = agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        target_interaction_profile: AgentInteractionProfileV1::NativeCli,
        expected_source_revision: None,
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        target_execution_profile: None,
        target_launch_selection: None,
    };
    let original = agent_runtime_transition_apply::apply(&state, "native-noop", body.clone())
        .await
        .unwrap();
    assert_eq!(
        agent_runtime_transition_apply::apply(&state, "native-noop", body.clone())
            .await
            .unwrap(),
        original
    );
    assert_eq!(hmux.requests().len(), 1);
    agent_runtime_close_apply::apply(
        &state,
        "close-after-noop",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id,
        },
    )
    .await
    .unwrap();
    state.store = Arc::new(
        SqliteDomainStore::open(hmux.root.join("domain.sqlite"))
            .await
            .unwrap(),
    );
    let replay = agent_runtime_transition_apply::apply(&state, "native-noop", body).await;
    assert_eq!(
        hmux.requests().len(),
        1,
        "a no-op replay must not launch a replacement"
    );
    assert_eq!(
        hmux.session(&source).lifecycle,
        hmux_client::SessionLifecycle::Exited
    );
    assert_eq!(
        replay.unwrap_err().code,
        "agent_runtime_transition_commit_stale"
    );
}

async fn stopped_close_successor(corrected_target: bool) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 60\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let agent_id = AgentIdV1::new("native-agent").unwrap();
    let source = launch(&state, &hmux, "native-source").await;
    bind_source(&state, &agent_id, &source).await;
    assert_eq!(
        hmux.session(&source).lifecycle,
        hmux_client::SessionLifecycle::Ready
    );
    let stopped = agent_runtime_close_apply::apply(
        &state,
        "close-native-source",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(stopped, json!({ "schemaVersion": 1, "stopped": true }));
    let source_after_stop = hmux.session(&source);
    assert_eq!(
        source_after_stop.lifecycle,
        hmux_client::SessionLifecycle::Exited
    );
    let close = state
        .store
        .effective_agent_runtime_close(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(close.state, AgentRuntimeCloseStateV1::Stopped);

    // A real second writer owns the conversation while both replacement
    // attempts run. The refusal must come from Hmux, not a fake launch result.
    let blocker = launch(&state, &hmux, "conversation-writer").await;
    let blocker_before = hmux.session(&blocker);
    let mut body = agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        target_interaction_profile: AgentInteractionProfileV1::NativeCli,
        expected_source_revision: Some(1),
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        target_execution_profile: None,
        target_launch_selection: None,
    };
    let mut predecessor = close.intent.operation_id.clone();
    for attempt in 0..2 {
        let key = format!("failed-native-successor-{attempt}");
        let error = agent_runtime_transition_apply::apply(&state, &key, body.clone())
            .await
            .unwrap_err();
        assert_eq!(error.code, "agent_runtime_repair_required", "{error:?}");
        let transition = state
            .store
            .active_agent_runtime_transition(&agent_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(transition.predecessor_operation_id, Some(predecessor));
        assert_eq!(
            transition.target_failure.as_ref().unwrap().provider_code,
            "hmux_managed_conversation_writer_conflict"
        );
        let observation = inspect(&state, &agent_id).await;
        assert_eq!(observation["state"], "transitioning");
        assert_eq!(
            observation["operationId"],
            transition.intent.operation_id.as_str()
        );
        assert_eq!(observation["stage"], "repair_required");
        assert_eq!(
            agent_runtime_transition_apply::apply(&state, &key, body.clone())
                .await
                .unwrap_err()
                .code,
            "agent_runtime_repair_required"
        );
        assert_eq!(
            hmux.requests().len(),
            3 + attempt,
            "replay cannot launch again"
        );
        assert_eq!(
            hmux.session(&blocker).host_process,
            blocker_before.host_process
        );
        assert_eq!(
            hmux.session(&blocker).lifecycle,
            hmux_client::SessionLifecycle::Ready
        );
        assert_eq!(
            hmux.session(&source).host_process,
            source_after_stop.host_process
        );
        assert_eq!(
            hmux.session(&source).lifecycle,
            hmux_client::SessionLifecycle::Exited
        );
        assert_eq!(
            state
                .store
                .agent_runtime_close(&close.intent.operation_id)
                .await
                .unwrap()
                .unwrap(),
            close
        );
        predecessor = transition.intent.operation_id;
    }

    let stale = agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
        expected_source_revision: Some(2),
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Discard,
        ..body.clone()
    };
    assert_eq!(
        agent_runtime_transition_apply::apply(&state, "stale-native-successor", stale)
            .await
            .unwrap_err()
            .code,
        "agent_runtime_transition_conflict"
    );
    assert_eq!(hmux.requests().len(), 4);
    state.store = Arc::new(
        SqliteDomainStore::open(hmux.root.join("domain.sqlite"))
            .await
            .unwrap(),
    );
    assert_eq!(
        inspect(&state, &agent_id).await["operationId"],
        predecessor.as_str()
    );
    hmux.stop(&blocker);
    if corrected_target {
        body.target_launch_selection = Some(dure_app::AgentRuntimeLaunchSelectionV1 {
            model: Some(dure_app::AgentSpawnModelSelectionV1::parse("gpt-5.6-sol").unwrap()),
            effort: None,
            permission_mode: None,
        });
    }
    let receipt =
        agent_runtime_transition_apply::apply(&state, "native-successor-final", body.clone())
            .await
            .unwrap();
    let replay = agent_runtime_transition_apply::apply(&state, "native-successor-final", body)
        .await
        .unwrap();
    assert_eq!(receipt, replay);
    assert_eq!(hmux.requests().len(), 5);
    let requests = hmux.requests();
    let request = requests.last().unwrap();
    assert_eq!(
        request.provider_conversation_ref.as_deref(),
        Some(CONVERSATION)
    );
    assert_eq!(
        request
            .provider_arguments
            .iter()
            .any(|arg| arg == "gpt-5.6-sol"),
        corrected_target
    );
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        authority.binding.provider_conversation_id.as_deref(),
        Some(CONVERSATION)
    );
    assert_ne!(authority.host_instance_id, source.host_instance_id);
    let replacement = WorkflowSessionGenerationV1 {
        session_id: authority.binding.session_id,
        workspace_id: authority.runtime_workspace_id,
        provider_id: ProviderIdV1::new("codex").unwrap(),
        runner_principal: authority.runner_principal,
        runner_instance: authority.runner_instance,
        channel_epoch: authority.channel_epoch,
        host_instance_id: authority.host_instance_id,
        terminal_epoch: authority.terminal_epoch,
    };
    assert_eq!(
        hmux.session(&replacement).lifecycle,
        hmux_client::SessionLifecycle::Ready
    );
    assert!(
        state
            .store
            .effective_agent_runtime_close(&agent_id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(inspect(&state, &agent_id).await["state"], "stable");
    hmux.stop(&replacement);
}

async fn inspect(state: &ServiceState, agent_id: &AgentIdV1) -> Value {
    serde_json::to_value(
        agent_runtime_transition_apply::inspect(
            state,
            agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 {
                schema_version: 1,
                agent_id: agent_id.clone(),
            },
        )
        .await
        .unwrap(),
    )
    .unwrap()
}

async fn launch(state: &ServiceState, hmux: &RealHmux, key: &str) -> WorkflowSessionGenerationV1 {
    launch_conversation(state, hmux, key, Some(CONVERSATION)).await
}

async fn launch_conversation(
    state: &ServiceState,
    hmux: &RealHmux,
    key: &str,
    conversation: Option<&str>,
) -> WorkflowSessionGenerationV1 {
    state
        .credential_aware_workflow_launcher
        .launch_with_provider_state(
            WorkflowSessionLaunchRequestV1 {
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                launch_idempotency_key: key.into(),
                session_id: key.into(),
                workspace_id: "workspace-1".into(),
                provider_id: ProviderIdV1::new("codex").unwrap(),
                provider_conversation_ref: conversation.map(str::to_owned),
                permission_mode: ProviderPermissionModeV1::Default,
                provider_executable: hmux.root.join("codex-fixture").to_str().unwrap().into(),
                provider_arguments: conversation
                    .map(|id| vec!["resume".into(), id.into()])
                    .unwrap_or_default(),
                provider_resume: None,
                initial_prompt: None,
                working_directory: hmux.root.to_str().unwrap().into(),
                prelaunch_command: None,
            },
            ProviderStateEnvironment::default(),
            None,
        )
        .await
        .unwrap()
        .session
}

async fn bind_source(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    source: &WorkflowSessionGenerationV1,
) {
    bind_source_conversation(state, agent_id, source, Some(CONVERSATION)).await;
}

async fn bind_source_conversation(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    source: &WorkflowSessionGenerationV1,
    conversation: Option<&str>,
) {
    bind_source_profile(
        state,
        agent_id,
        source,
        conversation,
        AgentExecutionProfileV1::ProviderDefault,
    )
    .await;
}

async fn bind_source_profile(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    source: &WorkflowSessionGenerationV1,
    conversation: Option<&str>,
    execution_profile: AgentExecutionProfileV1,
) {
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            display_name: "Native fixture".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&AgentCheckpointBindingAuthorityV1 {
            schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
            binding: SessionBindingRecordV1 {
                agent_id: agent_id.clone(),
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                session_id: source.session_id.clone(),
                provider_conversation_id: conversation.map(str::to_owned),
                credential_reference_id: match &execution_profile {
                    AgentExecutionProfileV1::ProviderDefault => None,
                    AgentExecutionProfileV1::CredentialReference { reference_id, .. } => {
                        Some(reference_id.clone())
                    }
                },
                binding_generation: 1,
                bound_at_ms: 10,
            },
            runtime_workspace_id: source.workspace_id.clone(),
            runner_principal: source.runner_principal.clone(),
            runner_instance: source.runner_instance.clone(),
            channel_epoch: source.channel_epoch.clone(),
            host_instance_id: source.host_instance_id.clone(),
            terminal_epoch: source.terminal_epoch.clone(),
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    state
        .store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
}
