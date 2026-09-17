use super::*;
use crate::agent_conversation::AgentConversationService;
use crate::agent_conversation_api::{AgentConversationApi, AgentConversationRuntimeRegistry};
use crate::managed_structured_runtime::{
    ManagedProviderExecutable, ManagedProviderKind, ManagedStructuredRuntimeConfiguration,
    ManagedStructuredRuntimeManager,
};
use crate::provider_credential_profile::ProviderCredentialProfileRegistry;
use crate::structured_provider_runtime::{
    StructuredProviderRuntime, StructuredProviderRuntimeRegistry,
};
use dure_app::AgentSpawnJournalStore;
use hmux_client::{
    LocalProcessGenerationStatus, LocalSessionCatalog, probe_local_process_generation,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "actual Codex QA; requires the Hmux guardian, pinned binaries and the default Codex account"]
async fn a_slack_mention_creates_a_real_checkout_and_provider_task() {
    run(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "actual Codex goal QA; requires the Hmux guardian, pinned binaries and the default Codex account"]
async fn a_slack_goal_discovers_and_completes_follow_up_work() {
    run(true).await;
}

async fn run(ongoing_goal: bool) {
    let root = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
        .join(if ongoing_goal { "g" } else { "s" });
    let repository = root.join("repository");
    let runtime_root = root.join("runtime");
    let provider_home = root.join("provider-home");
    for directory in [&root, &repository, &runtime_root, &provider_home] {
        fs::create_dir(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let (_fixture_root, mut state) = goal_runtime_fixture().await;
    state.request_slots = Arc::new(Semaphore::new(crate::MAX_ACTIVE_REQUESTS));
    let store = Arc::clone(&state.store);
    let endpoint = root.join("backend.sock");
    let config = root.join("spawn.json");
    fs::write(&config, serde_json::to_vec(&json!({
        "root": root, "repository": repository, "endpoint": endpoint, "goal": ongoing_goal,
        "codex": PathBuf::from(std::env::var_os("DURE_CODEX_BIN").unwrap()),
        "expected": {"backendId": state.descriptor.backend_id, "generation": state.descriptor.generation,
            "protocol": {"minimum": {"major": 1, "minor": 0}, "maximum": {"major": 1, "minor": 0}},
            "capabilities": crate::control_plane_capabilities()},
    })).unwrap()).unwrap();
    let node = PathBuf::from(std::env::var_os("DURE_NODE_BIN").unwrap());
    let driver = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../scripts/qa/slack-spawn-conversation.mjs");
    let prepared = std::process::Command::new(&node)
        .arg(&driver)
        .arg(&config)
        .arg("--prepare")
        .output()
        .unwrap();
    assert!(
        prepared.status.success(),
        "{}",
        String::from_utf8_lossy(&prepared.stderr)
    );
    let prepared: Value = serde_json::from_slice(&prepared.stdout).unwrap();
    register_project(
        &state.projects_catalog_path,
        "slack-spawn-project".into(),
        "Slack spawn QA".into(),
        repository.to_string_lossy().into_owned(),
    )
    .unwrap();
    let discovery = PathBuf::from(std::env::var_os("HMUX_DISCOVERY_ROOT").unwrap());
    let hmux = PathBuf::from(std::env::var_os("DURE_HMUX_BIN").unwrap());
    let hmux_runtime = PathBuf::from(std::env::var_os("DURE_HMUX_RUNTIME_BIN").unwrap());
    state.hmux_identity =
        resolve_hmux_toolchain_identity(&hmux, &hmux_runtime, &discovery).unwrap();
    state.runtime_adapters = Arc::new(runtime_extension::local_hmux_runtime_registry(
        state.hmux_identity.clone(),
    ));
    state.credential_profiles = Arc::new(ProviderCredentialProfileRegistry::new(
        provider_home,
        Arc::clone(&store),
    ));
    let service = Arc::new(
        AgentConversationService::new(Arc::clone(&store))
            .with_backend_home(prepared["backendHome"].as_str().unwrap()),
    );
    let conversations = Arc::new(AgentConversationRuntimeRegistry::default());
    let manager = Arc::new(ManagedStructuredRuntimeManager::new(
        ManagedStructuredRuntimeConfiguration::new(
            &state.descriptor.generation,
            ManagedProviderExecutable::new(
                ManagedProviderKind::Codex,
                Some(PathBuf::from(prepared["executable"].as_str().unwrap())),
            ),
            PathBuf::from(std::env::var_os("DURE_PROVIDER_LAUNCHER_BIN").unwrap()),
            hmux_runtime,
            &discovery,
            &runtime_root,
            &runtime_root,
        )
        .unwrap(),
        Arc::clone(&state.credential_profiles),
        Arc::clone(&service),
        Arc::clone(&conversations),
        Arc::clone(&store),
    ));
    let mut runtimes = StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(ProviderIdV1::new("codex").unwrap(), manager.clone())
        .unwrap();
    state.agent_providers = Arc::new(provider_extension::local_agent_provider_registry(
        &root,
        runtimes.providers(),
    ));
    state.structured_runtimes = Arc::new(runtimes);
    state.agent_conversation_runtimes = Arc::clone(&conversations);
    state.agent_conversations = Arc::new(AgentConversationApi::new(
        Arc::clone(&service),
        conversations,
    ));
    let state = Arc::new(state);
    let server = goal_provider_smoke::serve(Arc::clone(&state), &endpoint);
    let goal_runtime =
        ongoing_goal.then(|| tokio::spawn(crate::agent_conversation::continuation::run(Arc::clone(&state))));
    let outcome = tokio::time::timeout(
        Duration::from_secs(if ongoing_goal { 600 } else { 360 }),
        tokio::process::Command::new(node)
            .arg(driver)
            .arg(config)
            .status(),
    )
    .await;
    if let Some(goal_runtime) = goal_runtime {
        goal_runtime.abort();
        let _ = goal_runtime.await;
    }
    server.abort();
    let _ = server.await;
    let receipt = store
        .agent_spawn_receipt_by_idempotency_key(prepared["idempotencyKey"].as_str().unwrap())
        .await
        .unwrap();
    let descriptors = LocalSessionCatalog::new(&discovery).list().unwrap();
    if let Some(receipt) = &receipt {
        if let Some(binding) = service
            .binding_for_agent(&receipt.plan.agent_id)
            .await
            .unwrap()
        {
            manager.stop_current(&binding).await.unwrap();
        }
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if descriptors.iter().all(|descriptor| {
                [&descriptor.host_process, &descriptor.provider_process]
                    .into_iter()
                    .all(|process| {
                        probe_local_process_generation(process).unwrap()
                            == LocalProcessGenerationStatus::Absent
                    })
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    println!("slack-spawn-provider: owned runtime stopped");
    assert!(
        outcome.unwrap().unwrap().success(),
        "actual Slack spawn scenario failed"
    );
    assert_eq!(descriptors.len(), 1);
    let receipt = receipt.unwrap();
    let workspace = store
        .workspace(&receipt.plan.workspace_id)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(PathBuf::from(&workspace.root_path), repository);
    assert_eq!(
        fs::read_to_string(PathBuf::from(&workspace.root_path).join("result.txt")).unwrap(),
        "43\n"
    );
    assert!(!repository.join("result.txt").exists());
    if ongoing_goal {
        assert_eq!(
            fs::read_to_string(PathBuf::from(&workspace.root_path).join("breakdown.txt")).unwrap(),
            "17 + 26 = 43\n"
        );
        assert!(!repository.join("breakdown.txt").exists());
        assert_eq!(
            fs::read_to_string(PathBuf::from(&workspace.root_path).join("report.txt")).unwrap(),
            "Total parcels: 43\n"
        );
        assert_eq!(
            fs::read_to_string(repository.join("report.txt")).unwrap(),
            "Total parcels: 40\n"
        );
        assert_eq!(
            fs::read_to_string(PathBuf::from(&workspace.root_path).join("counts.txt")).unwrap(),
            fs::read_to_string(repository.join("counts.txt")).unwrap()
        );
    }
    println!(
        "slack-spawn-provider: {}",
        json!({
            "operationId": receipt.operation_id, "agentId": receipt.plan.agent_id,
            "workspaceId": receipt.plan.workspace_id, "workspace": workspace.root_path,
            "worktree": receipt.plan.request.worktree, "result": 43, "originalResultAbsent": true,
            "ongoingGoal": ongoing_goal,
        })
    );
}
