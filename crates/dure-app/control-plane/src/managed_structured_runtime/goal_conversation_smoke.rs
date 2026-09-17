use super::*;
use crate::agent_conversation_api::AgentConversationApi;
use crate::workflow_tests::goal_provider_smoke;
use dure_app::{AgentGoalRecordV1, AgentGoalStatusV1, AgentGoalStore};
use futures_util::FutureExt;
use std::panic::AssertUnwindSafe;

struct GoalPhase {
    fixture_root: tempfile::TempDir,
    state: Arc<crate::ServiceState>,
    installed: serde_json::Value,
    binding: AgentInteractionBindingV1,
    descriptors: Vec<SessionDescriptor>,
    goal: AgentGoalRecordV1,
}

#[test]
#[ignore = "real provider QA; requires the Hmux guardian, installed Codex and an existing account profile"]
fn real_codex_continues_and_completes_an_explicit_goal() {
    let run = |previous: Option<GoalPhase>| {
        thread::spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap()
                .block_on(run_goal_phase(previous))
        })
        .join()
        .unwrap()
    };
    let initial = run(None);
    assert_eq!(initial.goal.status, AgentGoalStatusV1::Active);
    for descriptor in &initial.descriptors {
        for process in [&descriptor.host_process, &descriptor.provider_process] {
            assert_eq!(
                probe_local_process_generation(process).unwrap(),
                LocalProcessGenerationStatus::Live,
                "backend shutdown must preserve the exact Hmux-owned process"
            );
        }
    }
    let completed = run(Some(initial));
    assert_eq!(completed.goal.status, AgentGoalStatusV1::Complete);
}

async fn run_goal_phase(previous: Option<GoalPhase>) -> GoalPhase {
    let root = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap()).join("goal");
    let state_root = root.join("runtime");
    if previous.is_none() {
        owner_directory(&root);
        owner_directory(&state_root);
    }
    let discovery_root = PathBuf::from(std::env::var_os("HMUX_DISCOVERY_ROOT").unwrap());
    let codex_home = PathBuf::from(std::env::var_os("CODEX_HOME").unwrap())
        .canonicalize()
        .unwrap();
    let credential_home = codex_home.parent().unwrap().parent().unwrap().to_path_buf();
    assert_eq!(
        codex_home.parent().unwrap(),
        credential_home.join("accounts")
    );
    let credential = CredentialFixture {
        directory_name: ProviderCredentialProfileDirectoryNameV1::new(
            &ProviderIdV1::new("codex").unwrap(),
            codex_home.file_name().unwrap().to_string_lossy(),
        )
        .unwrap(),
        generation: fs::read_to_string(codex_home.join(".dure-profile-generation-v1"))
            .unwrap()
            .trim()
            .into(),
        reference_id: "goal-live-qa".into(),
    };
    let (fixture_root, mut state) = match previous.as_ref() {
        Some(previous) => (
            None,
            crate::workflow_tests::reopen_goal_runtime_fixture(
                &previous.state,
                &previous.fixture_root.path().join("domain.sqlite"),
            )
            .await,
        ),
        None => {
            let (root, state) = crate::workflow_tests::goal_runtime_fixture().await;
            (Some(root), state)
        }
    };
    let store = Arc::clone(&state.store);
    if previous.is_none() {
        seed(&store, &root, 1).await;
    }
    let endpoint = root.join("backend.sock");
    let config_path = root.join("provider-install.json");
    if previous.is_none() {
        let workspace = root.join("workspace-0");
        fs::write(workspace.join("AGENTS.md"), "This is a disposable QA repository. Work only on the stated goal. Do not inspect credentials, use external services, or contact other agents. The installed dure-orchestration MCP tools connect only to this test's local Dure backend.\n").unwrap();
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
        fs::write(&config_path, serde_json::to_vec(&serde_json::json!({
            "root": root, "endpoint": endpoint, "codex": required_executable("DURE_CODEX_BIN"),
            "expected": { "backendId": state.descriptor.backend_id, "generation": state.descriptor.generation,
                "protocol": {"minimum": {"major": 1, "minor": 0}, "maximum": {"major": 1, "minor": 0}},
                "capabilities": ["orchestration.invoke", "agent_goal.v1"] }
        })).unwrap()).unwrap();
    }
    let installer = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../scripts/qa/goal-installed-provider.mjs");
    let installed = match previous.as_ref() {
        Some(previous) => {
            let catalog = PathBuf::from(previous.installed["backendHome"].as_str().unwrap())
                .join("backend-profiles.json");
            let mut profiles: serde_json::Value =
                serde_json::from_slice(&fs::read(&catalog).unwrap()).unwrap();
            let local = profiles["profiles"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|profile| profile["id"] == "local")
                .unwrap();
            local["expected"]["generation"] = state.descriptor.generation.clone().into();
            fs::write(catalog, serde_json::to_vec(&profiles).unwrap()).unwrap();
            previous.installed.clone()
        }
        None => {
            let installed = Command::new(required_executable("DURE_NODE_BIN"))
                .arg(installer)
                .arg(&config_path)
                .output()
                .unwrap();
            assert!(
                installed.status.success(),
                "goal installation failed: {}",
                String::from_utf8_lossy(&installed.stderr)
            );
            serde_json::from_slice(&installed.stdout).unwrap()
        }
    };
    println!("goal-installed-provider: {installed}");
    let profile = execution_profile(&store, &credential_home, Some(&credential)).await;
    let service = Arc::new(
        AgentConversationService::new(Arc::clone(&store))
            .with_backend_home(installed["backendHome"].as_str().unwrap()),
    );
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let manager = ManagedStructuredRuntimeManager::new(
        ManagedStructuredRuntimeConfiguration::new(
            state.descriptor.generation.clone(),
            ManagedProviderExecutable::new(
                ManagedProviderKind::Codex,
                Some(PathBuf::from(installed["executable"].as_str().unwrap())),
            ),
            required_executable("DURE_PROVIDER_LAUNCHER_BIN"),
            required_executable("DURE_HMUX_RUNTIME_BIN"),
            discovery_root.clone(),
            state_root.clone(),
            state_root,
        )
        .unwrap(),
        Arc::new(ProviderCredentialProfileRegistry::with_platform_home(
            credential_home,
            Some(PathBuf::from(std::env::var_os("HOME").unwrap())),
            Arc::clone(&store),
        )),
        Arc::clone(&service),
        Arc::clone(&registry),
        Arc::clone(&store),
    );
    let binding = runtime_scale_launch::open_or_attach(
        &manager,
        AgentIdV1::new("agent-codex-scale-0").unwrap(),
        &profile,
        previous.is_some(),
    )
    .await
    .unwrap();
    let descriptors = live_descriptors(&discovery_root, 1);
    if let Some(previous) = previous.as_ref() {
        assert_ne!(
            state.descriptor.generation,
            previous.state.descriptor.generation
        );
        assert_eq!(
            binding.interaction_session_id,
            previous.binding.interaction_session_id
        );
        assert_eq!(
            binding.provider_conversation_ref,
            previous.binding.provider_conversation_ref
        );
        assert_eq!(binding.runtime, previous.binding.runtime);
        assert_eq!(
            store.agent_goal(&binding.agent_id).await.unwrap().as_ref(),
            Some(&previous.goal)
        );
        assert!(same_exact_generation(
            &descriptors[0],
            &previous.descriptors[0]
        ));
        println!(
            "goal-backend-restarted: {}",
            serde_json::json!({
                "before": previous.state.descriptor.generation,
                "after": state.descriptor.generation,
                "conversation": binding.interaction_session_id,
                "providerConversation": binding.provider_conversation_ref,
                "runtime": binding.runtime,
                "goalRevision": previous.goal.revision,
            })
        );
    }
    let restarted = previous.is_some();
    let fixture_root = match previous {
        Some(previous) => previous.fixture_root,
        None => fixture_root.unwrap(),
    };
    state.agent_conversation_runtimes = Arc::clone(&registry);
    state.agent_conversations = Arc::new(AgentConversationApi::new(Arc::clone(&service), registry));
    let state = Arc::new(state);
    if restarted {
        fs::remove_file(&endpoint).unwrap();
    }
    let server = goal_provider_smoke::serve(Arc::clone(&state), &endpoint);
    // Stop the first backend at the completed-segment boundary. The replacement
    // starts the production goal loop, which must discover the durable goal.
    let goal_runtime = restarted.then(|| tokio::spawn(crate::agent_conversation::continuation::run(Arc::clone(&state))));
    if !restarted {
        goal_provider_smoke::start(&state, &binding).await;
    }
    let outcome = AssertUnwindSafe(timeout(Duration::from_secs(360), async {
        goal_provider_smoke::observe(
            &state,
            &binding,
            &root,
            if restarted {
                AgentGoalStatusV1::Complete
            } else {
                AgentGoalStatusV1::Active
            },
        )
        .await;
    }))
    .catch_unwind()
    .await;
    if let Some(goal_runtime) = goal_runtime {
        goal_runtime.abort();
        let _ = goal_runtime.await;
    }
    server.abort();
    let _ = server.await;
    let current = service
        .binding(&binding.interaction_session_id)
        .await
        .unwrap()
        .unwrap();
    if restarted || !matches!(&outcome, Ok(Ok(()))) {
        assert!(manager.stop_binding(&current, false).await.unwrap());
        wait_for_descriptor_absence(&descriptors);
        println!("goal-real-provider: owned runtime stopped");
    }
    outcome.unwrap().unwrap();
    let goal = store.agent_goal(&binding.agent_id).await.unwrap().unwrap();
    GoalPhase {
        fixture_root,
        state,
        installed,
        binding: current,
        descriptors,
        goal,
    }
}
