use super::*;
use hmux_client::{
    AgentRuntimeActivity, AgentRuntimeAttention, AgentStateReport, ManagedAgentStateReporter,
    ProviderConversationIdentity, SessionFence, SessionLifecycle,
};

#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn native_close_learned_conversation_uses_real_hmux() {
    for bound_conversation in [None, Some(CONVERSATION), Some("another-conversation")] {
        close_after_conversation_report(bound_conversation).await;
    }
}

async fn close_after_conversation_report(bound_conversation: Option<&str>) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 120\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let agent_id = AgentIdV1::new("fresh-native-close-agent").unwrap();
    let source = launch_conversation(&state, &hmux, "fresh-native-close-source", None).await;
    bind_source_conversation(&state, &agent_id, &source, bound_conversation).await;
    let before = hmux.session(&source);
    let fence = SessionFence {
        workspace_id: source.workspace_id.clone(),
        session_id: source.session_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: source.runner_instance.clone(),
        channel_epoch: source.channel_epoch.parse().unwrap(),
        host_instance_id: source.host_instance_id.clone(),
        terminal_epoch: source.terminal_epoch.clone(),
    };
    let report =
        ManagedAgentStateReporter::new(&state.hmux_identity.runtime_executable_path, &hmux.root)
            .with_discovery_root(&hmux.discovery)
            .report_agent_state_for_fence(
                hmux_client::ManagedAttachRequest::new(&source.session_id, &source.workspace_id)
                    .unwrap(),
                AgentStateReport {
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
                },
                fence,
            )
            .unwrap();
    assert_eq!(report, hmux_client::AgentStateReportOutcome::Applied);
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        authority.binding.provider_conversation_id.as_deref(),
        bound_conversation
    );
    assert!(before.same_generation(&hmux.session(&source)));

    let selection = state
        .store
        .agent_runtime_selection(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let mut stale_authority = authority.clone();
    stale_authority.terminal_epoch = "another-terminal".into();
    let stale = agent_runtime_transition_apply::native::stop_current(
        &state,
        &selection,
        &stale_authority,
        &OperationIdV1::new("close-stale-generation").unwrap(),
    )
    .await;
    assert!(matches!(
        stale,
        Err(crate::agent_runtime_stop_boundary::SourceStopFailure::SourceRetained)
    ));
    assert!(before.same_generation(&hmux.session(&source)));
    assert_eq!(hmux.session(&source).lifecycle, SessionLifecycle::Ready);

    let body = agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
    };
    let result =
        agent_runtime_close_apply::apply(&state, "close-learned-conversation", body.clone()).await;
    assert!(
        result.is_ok(),
        "explicit close owns the session, not its conversation projection: {result:?}"
    );
    assert_eq!(hmux.session(&source).lifecycle, SessionLifecycle::Exited);
    let close = state
        .store
        .effective_agent_runtime_close(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(close.state, AgentRuntimeCloseStateV1::Stopped);
    assert_eq!(
        agent_runtime_close_apply::apply(&state, "close-learned-conversation", body)
            .await
            .unwrap(),
        result.unwrap()
    );
    assert_eq!(
        hmux.requests().len(),
        1,
        "close replay must not create a successor"
    );
}

#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn native_close_does_not_require_an_inspection_cli() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 120\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let agent_id = AgentIdV1::new("native-close-without-inspector").unwrap();
    let source = launch_conversation(&state, &hmux, "close-without-inspector", None).await;
    bind_source_conversation(&state, &agent_id, &source, None).await;
    // A missing or replaced query CLI must not prevent the stop broker from
    // closing the already selected exact generation.
    state.hmux_identity.executable_path = hmux.root.join("unavailable-inspection-cli");
    let result = agent_runtime_close_apply::apply(
        &state,
        "close-without-inspector",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id,
        },
    )
    .await;
    assert!(
        result.is_ok(),
        "explicit close must not require inspection: {result:?}"
    );
    assert_eq!(hmux.session(&source).lifecycle, SessionLifecycle::Exited);
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn native_close_recovers_a_crashed_ready_generation() {
    close_broken_ready_generation(false, false).await;
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn native_close_recovers_an_unresponsive_host() {
    for provider_alive in [false, true] {
        close_broken_ready_generation(true, provider_alive).await;
    }
}

#[cfg(target_os = "macos")]
async fn close_broken_ready_generation(retain_host: bool, provider_alive: bool) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 120\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let agent_id = AgentIdV1::new("broken-ready-close-agent").unwrap();
    let source = launch_conversation(&state, &hmux, "broken-ready-close-source", None).await;
    bind_source_conversation(&state, &agent_id, &source, None).await;
    let before = hmux.session(&source);
    let signal = |process: &hmux_client::ProcessDescriptor, signal: &str| {
        let identity_module = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../scripts/lib/process-identity.mjs")
            .canonicalize()
            .unwrap();
        let result = std::process::Command::new("node")
            .args(["--input-type=module", "-e", r#"
                import assert from 'node:assert/strict';
                import {pathToFileURL} from 'node:url';
                const [module, pidText, marker, signal] = process.argv.slice(1);
                const {processIdentity, signalProcessGenerationSync} = await import(pathToFileURL(module));
                const pid = Number(pidText), identity = processIdentity(pid);
                assert(marker.startsWith('macos-proc-unique-v3:'));
                assert.equal(identity?.split(':').at(-1), marker.split(':')[1]);
                assert(signalProcessGenerationSync({pid, processIdentity: identity}, signal));
            "#])
            .arg(identity_module).arg(process.process_id.to_string())
            .arg(&process.start_marker).arg(signal).status().unwrap();
        assert!(
            result.success(),
            "owned fixture generation was not signalled"
        );
    };
    // Freeze the Host before killing either process so it cannot publish Exited
    // and turn this stale-Ready reproduction into an ordinary completed session.
    signal(&before.host_process, "SIGSTOP");
    if !provider_alive {
        signal(&before.provider_process, "SIGKILL");
    }
    if !retain_host {
        signal(&before.host_process, "SIGKILL");
    }
    assert_eq!(hmux.session(&source).lifecycle, SessionLifecycle::Ready);
    let body = agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
    };
    let result = agent_runtime_close_apply::apply(&state, "close-broken-ready", body.clone()).await;
    assert!(
        result.is_ok(),
        "broken transport must not prevent removal: {result:?}"
    );
    assert_eq!(hmux.session(&source).lifecycle, SessionLifecycle::Exited);
    assert_eq!(
        agent_runtime_close_apply::apply(&state, "close-broken-ready", body)
            .await
            .unwrap(),
        result.unwrap()
    );
}

#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn native_close_does_not_require_the_workspace_directory() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 120\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let agent_id = AgentIdV1::new("native-close-without-workspace").unwrap();
    let source = launch_conversation(&state, &hmux, "close-without-workspace", None).await;
    bind_source_conversation(&state, &agent_id, &source, None).await;
    let mut workspace = state
        .store
        .workspace(&WorkspaceIdV1::new("workspace-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    workspace.root_path = hmux.root.join("missing-workspace").to_str().unwrap().into();
    state.store.upsert_workspace(&workspace).await.unwrap();
    let result = agent_runtime_close_apply::apply(
        &state,
        "close-without-workspace",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id,
        },
    )
    .await;
    assert!(
        result.is_ok(),
        "explicit close must not require the working directory: {result:?}"
    );
    assert_eq!(hmux.session(&source).lifecycle, SessionLifecycle::Exited);
}

#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn native_close_recovers_after_an_older_conversation_fenced_attempt() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 120\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let agent_id = AgentIdV1::new("native-close-after-upgrade").unwrap();
    let source = launch_conversation(&state, &hmux, "close-after-upgrade", None).await;
    bind_source_conversation(&state, &agent_id, &source, None).await;
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let selection = state
        .store
        .agent_runtime_selection(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let operation_id = OperationIdV1::new("close-admitted-before-upgrade").unwrap();
    let old_request = hmux_client::ManagedStopRequest::new(
        agent_runtime_transition_apply::stop_identity(&operation_id, 0),
        &source.session_id,
        &source.workspace_id,
    )
    .unwrap()
    .with_expected_fence(
        &source.runner_principal,
        &source.runner_instance,
        source.channel_epoch.parse().unwrap(),
        &source.host_instance_id,
        &source.terminal_epoch,
    )
    .unwrap()
    .with_expected_conversation(
        hmux_client::ManagedStopConversationFence::new("codex", Some(CONVERSATION.into())).unwrap(),
    )
    .unwrap();
    let old_result = hmux_client::ManagedSessionStopper::new(
        &state.hmux_identity.runtime_executable_path,
        &hmux.root,
    )
    .with_discovery_root(&hmux.discovery)
    .stop(old_request)
    .unwrap_err();
    assert!(old_result.is_definitive_managed_stop_refusal());
    assert_eq!(hmux.session(&source).lifecycle, SessionLifecycle::Ready);
    let result = agent_runtime_transition_apply::native::stop_current(
        &state,
        &selection,
        &authority,
        &operation_id,
    )
    .await;
    assert!(
        result.is_ok(),
        "old conversation-fenced refusal must not veto explicit close"
    );
    assert_eq!(hmux.session(&source).lifecycle, SessionLifecycle::Exited);
    assert!(
        agent_runtime_transition_apply::native::stop_current(
            &state,
            &selection,
            &authority,
            &operation_id
        )
        .await
        .is_ok()
    );
}
