use super::*;
use crate::agent_conversation_api::AgentConversationApi;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "real provider QA; requires the Hmux guardian, installed Codex and an existing account profile"]
async fn real_codex_task_continues_through_the_slack_adapter() {
    let root = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap()).join("slack");
    owner_directory(&root);
    let state_root = root.join("runtime");
    owner_directory(&state_root);
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
        reference_id: "slack-live-qa".into(),
    };
    let store = Arc::new(
        SqliteDomainStore::open(root.join("domain.sqlite3"))
            .await
            .unwrap(),
    );
    seed(&store, &root, 1).await;
    let workspace = root.join("workspace-0");
    fs::write(workspace.join("AGENTS.md"), "This is a disposable QA repository. Work only inside this directory. Do not inspect credentials, use external services, or contact other agents.\n").unwrap();
    let profile = execution_profile(&store, &credential_home, Some(&credential)).await;
    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let manager = ManagedStructuredRuntimeManager::new(
        ManagedStructuredRuntimeConfiguration::new(
            "slack-live-qa",
            ManagedProviderExecutable::new(
                ManagedProviderKind::Codex,
                Some(required_executable("DURE_CODEX_BIN")),
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
        false,
    )
    .await
    .unwrap();
    let descriptors = live_descriptors(&discovery_root, 1);
    let endpoint = root.join("conversation.sock");
    let listener = UnixListener::bind(&endpoint).unwrap();
    let api = AgentConversationApi::new(Arc::clone(&service), registry);
    let serving = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        while let Some(line) = lines.next_line().await.unwrap() {
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            let result = api
                .dispatch(request["operation"].as_str().unwrap(), &request["body"])
                .await
                .expect("the smoke uses the existing conversation API only");
            let response = match result {
                Ok(result) => serde_json::json!({"id":request["id"],"result":result}),
                Err(error) => serde_json::json!({"id":request["id"],"error":{"code":error.code()}}),
            };
            write
                .write_all(format!("{response}\n").as_bytes())
                .await
                .unwrap();
        }
    });
    let driver = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../scripts/qa/slack-real-conversation.mjs");
    let mut command = tokio::process::Command::new(required_executable("DURE_NODE_BIN"));
    command
        .arg(driver)
        .arg(&endpoint)
        .arg(&root)
        .arg(binding.agent_id.as_str());
    command
        .env_remove("DURE_SLACK_APP_TOKEN")
        .env_remove("DURE_SLACK_BOT_TOKEN");
    let outcome = timeout(Duration::from_secs(600), command.status()).await;
    serving.abort();
    let _ = serving.await;
    let current = service
        .binding(&binding.interaction_session_id)
        .await
        .unwrap()
        .unwrap();
    assert!(manager.stop_binding(&current, false).await.unwrap());
    wait_for_descriptor_absence(&descriptors);
    println!("slack-real-conversation: owned runtime stopped");
    assert!(
        outcome.unwrap().unwrap().success(),
        "real Slack-adapter conversation smoke failed"
    );
}
