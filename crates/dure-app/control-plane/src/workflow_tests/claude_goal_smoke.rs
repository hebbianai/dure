use super::*;
use crate::agent_conversation::AgentConversationService;
use crate::agent_conversation_api::{AgentConversationApi, AgentConversationRuntimeRegistry};
use crate::claude_conversation_host::ClaudeConversationHost;
use crate::claude_sdk_host_supervisor::ClaudeSdkHostSupervisorConfiguration;
use crate::claude_structured_runtime::{
    ClaudeStructuredOpenRequestV1, ClaudeStructuredRuntimeConfiguration,
    ClaudeStructuredRuntimeManager,
};
use crate::provider_credential_profile::ProviderCredentialProfileRegistry;
use dure_app::{AgentGoalStatusV1, AgentGoalStore};
use futures_util::FutureExt;
use hmux_client::{
    LocalProcessGenerationStatus, LocalSessionCatalog, probe_local_process_generation,
};
use std::{panic::AssertUnwindSafe, path::PathBuf, process::Command, time::Duration};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "real provider QA; requires the Hmux guardian and an authenticated default Claude account"]
async fn real_claude_continues_and_completes_an_explicit_goal() {
    exercise(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "real runtime QA; requires the Hmux guardian, pinned Node and network for installation"]
async fn cold_claude_opens_before_its_first_model_turn() {
    exercise(false).await;
}

async fn exercise(run_goal: bool) {
    let root = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap()).join("c");
    let workspace = root.join("workspace");
    let host_state = root.join("hs");
    let runtime_state = root.join("rs");
    let artifact_root = root.join("artifact");
    for directory in [
        &root,
        &workspace,
        &host_state,
        &runtime_state,
        &artifact_root,
    ] {
        fs::create_dir(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::write(workspace.join("CLAUDE.md"), "This is a disposable QA project. Work only on the stated goal, use only the local files and installed dure-orchestration goal tools, and do not contact external services or other agents. Include CONFIG_PRESERVED in your first response.\n").unwrap();
    fs::write(
        workspace.join("first.txt"),
        "The first delivery has 17 parcels.\n",
    )
    .unwrap();
    fs::write(
        workspace.join("second.txt"),
        "The second delivery has 26 parcels.\n",
    )
    .unwrap();
    let (_fixture_root, mut state) = goal_runtime_fixture().await;
    let store = Arc::clone(&state.store);
    let project = ProjectIdV1::new("claude-goal-project").unwrap();
    let workspace_id = WorkspaceIdV1::new("claude-goal-workspace").unwrap();
    let agent = AgentIdV1::new("claude-goal-agent").unwrap();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: project.clone(),
            root_path: workspace.to_string_lossy().into_owned(),
            display_name: "Claude goal QA".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: workspace_id.clone(),
            project_id: project,
            root_path: workspace.to_string_lossy().into_owned(),
            base_commit_sha: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent.clone(),
            workspace_id,
            provider_id: ProviderIdV1::new("claude").unwrap(),
            display_name: "Claude goal QA".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    let endpoint = root.join("backend.sock");
    let config = root.join("provider-install.json");
    fs::write(&config, serde_json::to_vec(&json!({
        "root": root, "workspace": workspace, "provider": "claude", "endpoint": endpoint,
        "expected": {"backendId": state.descriptor.backend_id, "generation": state.descriptor.generation,
            "protocol": {"minimum": {"major": 1, "minor": 0}, "maximum": {"major": 1, "minor": 0}},
            "capabilities": ["orchestration.invoke", "agent_goal.v1"]},
    })).unwrap()).unwrap();
    let node = PathBuf::from(std::env::var_os("DURE_NODE_BIN").unwrap());
    let driver = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("provider-drivers/claude");
    let installed = Command::new(&node)
        .arg(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../scripts/qa/goal-installed-provider.mjs"),
        )
        .arg(&config)
        .output()
        .unwrap();
    assert!(
        installed.status.success(),
        "goal install: {}",
        String::from_utf8_lossy(&installed.stderr)
    );
    let installed: Value = serde_json::from_slice(&installed.stdout).unwrap();
    println!("goal-installed-provider: {installed}");
    let service = Arc::new(
        AgentConversationService::new(Arc::clone(&store))
            .with_backend_home(installed["backendHome"].as_str().unwrap()),
    );
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let environment = BTreeMap::from([
        ("HOME".into(), std::env::var("HOME").unwrap()),
        ("PATH".into(), std::env::var("PATH").unwrap()),
    ]);
    let host = Arc::new(
        ClaudeConversationHost::new(
            ClaudeSdkHostSupervisorConfiguration::new(
                &node,
                driver.join("shared-sdk-host-entrypoint.mjs"),
                &host_state,
                &artifact_root,
                "claude-goal-qa",
                environment.clone().into_iter().collect(),
            )
            .unwrap(),
            "claude-goal-qa",
            Arc::clone(&service),
            Arc::clone(&registry),
        )
        .unwrap(),
    );
    let discovery_root = PathBuf::from(std::env::var_os("HMUX_DISCOVERY_ROOT").unwrap());
    let manager = ClaudeStructuredRuntimeManager::new(
        ClaudeStructuredRuntimeConfiguration::new(
            state.descriptor.generation.clone(),
            PathBuf::from(std::env::var_os("DURE_HMUX_RUNTIME_BIN").unwrap()),
            &discovery_root,
            PathBuf::from(std::env::var_os("DURE_CLAUDE_PROCESS_RELAY_BIN").unwrap()),
            &runtime_state,
            environment,
        )
        .unwrap(),
        Arc::new(ProviderCredentialProfileRegistry::new(
            root.clone(),
            Arc::clone(&store),
        )),
        Arc::clone(&service),
        host,
        Arc::clone(&store),
    );
    state.agent_conversation_runtimes = Arc::clone(&registry);
    state.agent_conversations = Arc::new(AgentConversationApi::new(Arc::clone(&service), registry));
    let state = Arc::new(state);
    let server = goal_provider_smoke::serve(Arc::clone(&state), &endpoint);
    let opened_at = std::time::Instant::now();
    let opened = manager
        .open(ClaudeStructuredOpenRequestV1 {
            agent_id: agent.clone(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: None,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
        })
        .await;
    if opened.is_err() {
        for entry in fs::read_dir(&runtime_state).unwrap().flatten() {
            if let Ok(source) = fs::read(entry.path().join("launch.json")) {
                let journal: Value = serde_json::from_slice(&source).unwrap();
                eprintln!("goal-claude-launch-failure: {}", journal["failure"]);
            }
        }
    }
    let binding = opened.unwrap().binding;
    println!(
        "goal-claude-opened: {}",
        json!({
            "elapsedMs": opened_at.elapsed().as_millis(), "binding": binding,
            "modelTurnRequested": run_goal,
        })
    );
    let descriptors = LocalSessionCatalog::new(&discovery_root).list().unwrap();
    assert_eq!(descriptors.len(), 1);
    let goal_runtime = run_goal.then(|| tokio::spawn(crate::agent_goal::run(Arc::clone(&state))));
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(360), async {
        if run_goal {
            goal_provider_smoke::start(&state, &binding).await;
            goal_provider_smoke::observe(&state, &binding, &root, AgentGoalStatusV1::Complete)
                .await;
        } else {
            assert!(store.agent_goal(&agent).await.unwrap().is_none());
        }
    }))
    .catch_unwind()
    .await;
    if let Some(goal_runtime) = goal_runtime {
        goal_runtime.abort();
        let _ = goal_runtime.await;
    }
    server.abort();
    let _ = server.await;
    assert!(
        manager
            .stop(
                &binding.interaction_session_id,
                &binding.runtime.runtime_generation
            )
            .await
            .unwrap()
    );
    for descriptor in &descriptors {
        for process in [&descriptor.host_process, &descriptor.provider_process] {
            assert_eq!(
                probe_local_process_generation(process).unwrap(),
                LocalProcessGenerationStatus::Absent
            );
        }
    }
    println!(
        "goal-claude-provider: {}",
        json!({
            "agentId": agent, "conversation": service.binding(&binding.interaction_session_id).await.unwrap(),
            "goal": store.agent_goal(&agent).await.unwrap(), "ownedRuntimeStopped": true,
        })
    );
    outcome.unwrap().unwrap();
}
