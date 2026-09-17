use super::*;

#[derive(Clone, Copy)]
enum Reconnection {
    HostCrash,
    ControllerReplacement,
    ControllerOverlap,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires built Hmux, the pinned Node executable, and Claude driver dependencies"]
async fn manager_reconnects_instead_of_reusing_receipt_after_shared_host_crash() {
    exercise_reconnection(Reconnection::HostCrash).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires built Hmux, the pinned Node executable, and Claude driver dependencies"]
async fn controller_replacement_preserves_exact_hmux_host_and_query() {
    exercise_reconnection(Reconnection::ControllerReplacement).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires built Hmux, the pinned Node executable, and Claude driver dependencies"]
async fn overlapping_controller_cannot_retire_the_live_query() {
    exercise_reconnection(Reconnection::ControllerOverlap).await;
}

async fn exercise_reconnection(mode: Reconnection) {
    let crash_host = matches!(mode, Reconnection::HostCrash);
    let node = required_executable("DURE_NODE_BIN");
    let hmux_runtime = required_executable("DURE_HMUX_RUNTIME_BIN");
    let relay = PathBuf::from(env!("CARGO_BIN_EXE_dure-claude-process-relay"))
        .canonicalize()
        .unwrap();
    let entrypoint = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/claude-conversation-host-fixture.mjs")
        .canonicalize()
        .unwrap();
    let temporary = tempfile::Builder::new()
        .prefix("dure-claude-host-crash-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let discovery_root = temporary.path().join("discovery");
    let host_state_root = temporary.path().join("host-state");
    let relay_state_root = temporary.path().join("relay-state");
    let runtime_root = temporary.path().join("runtime");
    for directory in [
        &discovery_root,
        &host_state_root,
        &relay_state_root,
        &runtime_root,
    ] {
        owner_directory(directory);
    }

    let store = Arc::new(
        SqliteDomainStore::open(temporary.path().join("domain.sqlite3"))
            .await
            .unwrap(),
    );
    seed(&store, temporary.path()).await;
    let service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    let controller = |generation: &str| {
        let registry = Arc::new(AgentConversationRuntimeRegistry::default());
        let host = Arc::new(
            ClaudeConversationHost::new(
                ClaudeSdkHostSupervisorConfiguration::new(
                    &node,
                    &entrypoint,
                    &host_state_root,
                    &runtime_root,
                    format!("host-{generation}"),
                    Vec::new(),
                )
                .unwrap(),
                format!("client-{generation}"),
                Arc::clone(&service),
                Arc::clone(&registry),
            )
            .unwrap(),
        );
        let credential_profiles = Arc::new(ProviderCredentialProfileRegistry::new(
            temporary.path().to_path_buf(),
            Arc::clone(&store),
        ));
        let manager = ClaudeStructuredRuntimeManager::new(
            ClaudeStructuredRuntimeConfiguration::new(
                generation,
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
            credential_profiles,
            Arc::clone(&service),
            Arc::clone(&host),
            Arc::clone(&store),
        );
        (registry, host, manager)
    };
    let (mut registry, mut host, mut manager) = controller("backend-managed-crash-1");
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
    assert_eq!(host.host_launch_count().unwrap(), 1);
    assert_eq!(host.client_attach_count(), 1);
    let descriptor = LocalSessionCatalog::new(&discovery_root)
        .list()
        .unwrap()
        .into_iter()
        .find(|descriptor| descriptor.provider_id == "claude")
        .unwrap();
    let mut session_guard = ExactSessionGuard(Some(descriptor.clone()));

    let mut api = AgentConversationApi::new(Arc::clone(&service), Arc::clone(&registry));
    let first_turn = api
        .dispatch(
            START_TURN_OPERATION,
            &serde_json::to_value(AgentStartTurnIntentV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: opened.binding.interaction_session_id.clone(),
                runtime: opened.binding.runtime.clone(),
                turn_id: AgentTurnIdV1::new("turn-managed-host-crash-before").unwrap(),
                client_message_id: AgentClientMessageIdV1::new("message-managed-host-crash-before")
                    .unwrap(),
                input: "hello before shared host crash".into(),
                requested_at_ms: 10,
            })
            .unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first_turn["receipt"]["state"], "accepted");
    wait_for_assistant(
        &service,
        &opened.binding.interaction_session_id,
        "hello before shared host crash",
    )
    .await;
    wait_for_turn_idle(&service, &opened.binding.interaction_session_id).await;
    let committed_before_crash = service
        .provider_cursor(
            &opened.binding.interaction_session_id,
            &opened.binding.runtime,
        )
        .await
        .unwrap()
        .committed_through_sequence;
    assert!(committed_before_crash > 0);

    let crashed_host_process_id = shared_sdk_host_process_id(&host_state_root);
    if matches!(mode, Reconnection::ControllerOverlap) {
        let (_, _, candidate) = controller("backend-overlapping-controller");
        assert!(
            candidate
                .launch(ClaudeStructuredLaunchRequestV1 {
                    interaction_session_id: opened.binding.interaction_session_id.clone(),
                })
                .await
                .is_err()
        );
        assert_eq!(
            probe_local_process_generation(&descriptor.provider_process).unwrap(),
            LocalProcessGenerationStatus::Live,
            "a controller connection conflict cannot authorize Query retirement"
        );
        drop(candidate);
    }
    if crash_host {
        assert_eq!(
            unsafe { libc::kill(crashed_host_process_id as libc::pid_t, libc::SIGKILL) },
            0,
            "failed to crash the exact shared Claude SDK Host"
        );
        wait_for_process_exit_state(crashed_host_process_id).await;
    } else {
        drop(api);
        drop(manager);
        drop(host);
        drop(registry);
        tokio::time::sleep(Duration::from_millis(100)).await;
        (registry, host, manager) = controller("backend-managed-crash-2");
        api = AgentConversationApi::new(Arc::clone(&service), Arc::clone(&registry));
    }
    let recovered = manager
        .launch(ClaudeStructuredLaunchRequestV1 {
            interaction_session_id: opened.binding.interaction_session_id.clone(),
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
            panic!("reconnection failed: {error:?}; {failures:?}");
        });
    assert_eq!(
        host.host_launch_count().unwrap(),
        if crash_host { 2 } else { 0 },
        "controller replacement must adopt; a crashed Host must be replaced"
    );
    assert_eq!(host.client_attach_count(), if crash_host { 2 } else { 1 });
    assert_eq!(process_is_live(crashed_host_process_id), !crash_host);
    assert_eq!(
        recovered.runtime_generation,
        opened.launch.runtime_generation
    );
    assert_eq!(recovered.query_epoch, opened.launch.query_epoch);
    assert_eq!(
        shared_sdk_host_process_id(&host_state_root) == crashed_host_process_id,
        !crash_host,
    );
    if !crash_host {
        let current = LocalSessionCatalog::new(&discovery_root)
            .list()
            .unwrap()
            .into_iter()
            .find(|value| value.session_id == descriptor.session_id)
            .unwrap();
        assert_eq!(current.host_process, descriptor.host_process);
        assert_eq!(current.provider_process, descriptor.provider_process);
    }

    let turn = api
        .dispatch(
            START_TURN_OPERATION,
            &serde_json::to_value(AgentStartTurnIntentV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: opened.binding.interaction_session_id.clone(),
                runtime: opened.binding.runtime.clone(),
                turn_id: AgentTurnIdV1::new("turn-managed-host-crash-1").unwrap(),
                client_message_id: AgentClientMessageIdV1::new("message-managed-host-crash-1")
                    .unwrap(),
                input: "hello after shared host crash".into(),
                requested_at_ms: 20,
            })
            .unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(turn["receipt"]["state"], "accepted");
    wait_for_assistant(
        &service,
        &opened.binding.interaction_session_id,
        "hello after shared host crash",
    )
    .await;
    wait_for_turn_idle(&service, &opened.binding.interaction_session_id).await;
    let committed_after_recovery = service
        .provider_cursor(
            &opened.binding.interaction_session_id,
            &opened.binding.runtime,
        )
        .await
        .unwrap()
        .committed_through_sequence;
    assert!(committed_after_recovery > committed_before_crash);
    assert!(
        manager
            .stop(
                &opened.binding.interaction_session_id,
                &recovered.runtime_generation,
            )
            .await
            .unwrap()
    );
    wait_for_process_absence(&descriptor.provider_process);
    wait_for_process_absence(&descriptor.host_process);
    session_guard.0 = None;
}
