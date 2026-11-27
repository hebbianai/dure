use super::*;

fn start_turn(
    binding: &dure_app::AgentInteractionBindingV1,
    suffix: &str,
    input: &str,
) -> serde_json::Value {
    serde_json::to_value(AgentStartTurnIntentV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: binding.interaction_session_id.clone(),
        runtime: binding.runtime.clone(),
        turn_id: AgentTurnIdV1::new(format!("turn-provider-exit-{suffix}")).unwrap(),
        client_message_id: AgentClientMessageIdV1::new(format!("message-provider-exit-{suffix}"))
            .unwrap(),
        input: input.into(),
        requested_at_ms: 10,
    })
    .unwrap()
}

/// hebbianai/dure#777 on the real stack: the shared SDK Host, the Claude
/// process relay in Hmux, and a Claude CLI that ends by itself after a turn.
/// The ended Query stops taking input, and the next launch of the same
/// conversation relaunches Claude on it instead of returning the dead one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires built Hmux, the pinned Node executable, and Claude driver dependencies"]
async fn a_claude_process_that_ends_by_itself_relaunches_on_the_same_conversation() {
    let node = required_executable("DURE_NODE_BIN");
    let hmux_runtime = required_executable("DURE_HMUX_RUNTIME_BIN");
    let relay = PathBuf::from(env!("CARGO_BIN_EXE_dure-claude-process-relay"))
        .canonicalize()
        .unwrap();
    let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let driver = manifest_root.join("provider-drivers/claude");
    let entrypoint = driver
        .join("shared-sdk-host-entrypoint.mjs")
        .canonicalize()
        .unwrap();
    let installer = driver
        .join("claude-runtime-install.mjs")
        .canonicalize()
        .unwrap();
    let fake_claude = manifest_root
        .join("tests/fixtures/fake-claude-agent-sdk-cli.mjs")
        .canonicalize()
        .unwrap();
    let temporary = tempfile::Builder::new()
        .prefix("dure-claude-exit-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let discovery_root = temporary.path().join("discovery");
    let host_state_root = temporary.path().join("host-state");
    let relay_state_root = temporary.path().join("relay-state");
    let runtime_root = temporary.path().join("runtime");
    for directory in [&discovery_root, &host_state_root, &relay_state_root] {
        owner_directory(directory);
    }
    let install = Command::new(&node)
        .args([
            installer.as_os_str(),
            "--runtime-root".as_ref(),
            runtime_root.as_os_str(),
            "--source".as_ref(),
            fake_claude.as_os_str(),
        ])
        .current_dir(&driver)
        .output()
        .unwrap();
    assert!(
        install.status.success(),
        "runtime adoption failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );

    let store = Arc::new(
        SqliteDomainStore::open(temporary.path().join("domain.sqlite3"))
            .await
            .unwrap(),
    );
    seed(&store, temporary.path()).await;
    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let host = Arc::new(
        ClaudeConversationHost::new(
            ClaudeSdkHostSupervisorConfiguration::new(
                &node,
                &entrypoint,
                &host_state_root,
                &runtime_root,
                "host-provider-exit",
                Vec::new(),
            )
            .unwrap(),
            "client-provider-exit",
            Arc::clone(&service),
            Arc::clone(&registry),
        )
        .unwrap(),
    );
    let manager = ClaudeStructuredRuntimeManager::new(
        ClaudeStructuredRuntimeConfiguration::new(
            "backend-provider-exit",
            &hmux_runtime,
            &discovery_root,
            &relay,
            &relay_state_root,
            BTreeMap::from([
                (
                    "HOME".into(),
                    temporary.path().to_string_lossy().into_owned(),
                ),
                ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            ]),
        )
        .unwrap(),
        Arc::new(ProviderCredentialProfileRegistry::new(
            temporary.path().to_path_buf(),
            Arc::clone(&store),
        )),
        Arc::clone(&service),
        Arc::clone(&host),
        Arc::clone(&store),
    );
    let opened = manager
        .open(ClaudeStructuredOpenRequestV1 {
            agent_id: AgentIdV1::new("agent-claude-managed-runtime").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: None,
            permission_mode: dure_app::ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
        })
        .await
        .unwrap();
    let first = LocalSessionCatalog::new(&discovery_root)
        .list()
        .unwrap()
        .into_iter()
        .find(|descriptor| descriptor.provider_id == "claude")
        .unwrap();
    let mut first_guard = ExactSessionGuard(Some(first.clone()));
    let api = AgentConversationApi::new(Arc::clone(&service), Arc::clone(&registry));
    let interaction = opened.binding.interaction_session_id.clone();

    // Claude answers, then its process ends by itself.
    let response = api
        .dispatch(
            START_TURN_OPERATION,
            &start_turn(&opened.binding, "last", "exit-after-turn"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response["receipt"]["state"], "accepted");
    wait_for_assistant(&service, &interaction, "sdk-echo:exit-after-turn").await;
    wait_for_process_absence(&first.provider_process);

    // Input meets no runtime, which is what starts a relaunch, instead of
    // failing against the exited Query.
    let deadline = Instant::now() + Duration::from_secs(10);
    let refusal = loop {
        match api
            .dispatch(
                START_TURN_OPERATION,
                &start_turn(
                    &opened.binding,
                    "after-exit",
                    "must not reach the exited Query",
                ),
            )
            .await
            .unwrap()
        {
            Err(error) if error.code() == "agent_conversation_runtime_unavailable" => {
                break error;
            }
            outcome => {
                assert!(
                    Instant::now() < deadline,
                    "the exited Query kept taking input: {outcome:?}"
                );
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    };
    assert_eq!(refusal.code(), "agent_conversation_runtime_unavailable");

    // The next launch relaunches Claude on the same conversation.
    let relaunched = manager
        .launch(ClaudeStructuredLaunchRequestV1 {
            interaction_session_id: interaction.clone(),
        })
        .await
        .unwrap_or_else(|error| {
            let failures = fs::read_dir(&relay_state_root)
                .unwrap()
                .flatten()
                .filter_map(|entry| fs::read(entry.path().join("launch.json")).ok())
                .filter_map(|source| serde_json::from_slice::<serde_json::Value>(&source).ok())
                .filter_map(|journal| journal.get("failure").cloned())
                .collect::<Vec<_>>();
            panic!("relaunch failed: {error:?}; {failures:?}");
        });
    assert_ne!(
        relaunched.runtime_generation,
        opened.launch.runtime_generation
    );
    let current = service.binding(&interaction).await.unwrap().unwrap();
    assert_eq!(
        current.runtime.runtime_generation,
        relaunched.runtime_generation
    );
    assert_eq!(
        current.binding_revision,
        opened.binding.binding_revision + 1
    );
    assert!(current.provider_conversation_ref.is_some());
    let second = LocalSessionCatalog::new(&discovery_root)
        .list()
        .unwrap()
        .into_iter()
        .find(|descriptor| {
            descriptor.provider_id == "claude" && descriptor.session_id != first.session_id
        })
        .expect("the relaunch started a new Claude relay");
    first_guard.0 = None;
    let mut second_guard = ExactSessionGuard(Some(second.clone()));

    let response = api
        .dispatch(
            START_TURN_OPERATION,
            &start_turn(&current, "relaunched", "hello after the relaunch"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response["receipt"]["state"], "accepted");
    wait_for_assistant(&service, &interaction, "sdk-echo:hello after the relaunch").await;
    wait_for_turn_idle(&service, &interaction).await;

    assert!(
        manager
            .stop(&interaction, &relaunched.runtime_generation)
            .await
            .unwrap()
    );
    wait_for_process_absence(&second.provider_process);
    second_guard.0 = None;
}
