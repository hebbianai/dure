use super::*;

pub(super) async fn exercise() {
    for (finish_before_restart, legacy) in [(true, false), (false, false), (false, true)] {
        exercise_restart(finish_before_restart, legacy).await;
    }
}

async fn exercise_restart(finish_before_restart: bool, legacy: bool) {
    let node = required_executable("DURE_NODE_BIN");
    let hmux = required_executable("DURE_HMUX_RUNTIME_BIN");
    let relay = required_executable("DURE_CLAUDE_PROCESS_RELAY_BIN");
    let root = tempfile::Builder::new()
        .prefix("dqrt-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    fs::set_permissions(root.as_path(), fs::Permissions::from_mode(0o700)).unwrap();
    let workspace = root.as_path().join("workspace");
    let discovery_root = root.as_path().join("discovery");
    let host_state_root = root.as_path().join("host-state");
    let host_runtime_root = root.as_path().join("host-runtime");
    let runtime_state_root = root.as_path().join("runtime-state");
    for directory in [
        &workspace,
        &discovery_root,
        &host_state_root,
        &host_runtime_root,
        &runtime_state_root,
    ] {
        fs::create_dir(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let workspace = workspace.canonicalize().unwrap();
    let store = Arc::new(
        SqliteDomainStore::open(root.as_path().join("domain.sqlite3"))
            .await
            .unwrap(),
    );
    let project_id = ProjectIdV1::new("project-query-retired").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-query-retired").unwrap();
    let agent_id = AgentIdV1::new("agent-query-retired").unwrap();
    let provider_id = ProviderIdV1::new(CLAUDE_PROVIDER_ID).unwrap();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: workspace.to_string_lossy().into_owned(),
            display_name: "Query retired".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: workspace_id.clone(),
            project_id,
            root_path: workspace.to_string_lossy().into_owned(),
            base_commit_sha: None,
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: workspace_id.clone(),
            provider_id: provider_id.clone(),
            display_name: "Query retired".into(),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();
    let binding = AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-query-retired")
            .unwrap(),
        agent_id,
        provider_id,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("99999999-8888-4777-8666-555555555555".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-query-retired".into(),
            provider_epoch: "epoch-query-retired".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-query-retired").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 4,
        updated_at_ms: 4,
    };
    let conversation_service = Arc::new(AgentConversationService::new(Arc::clone(&store)));
    conversation_service.create(&binding).await.unwrap();
    let source_selection = AgentRuntimeSelectionV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        agent_id: binding.agent_id.clone(),
        provider_id: binding.provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: binding.execution_profile.clone(),
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 4,
    };
    store
        .initialize_agent_runtime_selection(&source_selection)
        .await
        .unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let driver = Path::new(env!("CARGO_MANIFEST_DIR")).join("provider-drivers/claude");
    let install = Command::new(&node)
        .arg(driver.join("claude-runtime-install.mjs"))
        .arg("--runtime-root")
        .arg(&host_runtime_root)
        .arg("--source")
        .arg(fixture.join("fake-claude-agent-sdk-cli.mjs"))
        .env_clear()
        .env("HOME", root.as_path())
        .env("PATH", std::env::var_os("PATH").unwrap())
        .output()
        .unwrap();
    assert!(
        install.status.success(),
        "runtime adoption failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );
    let close_count = root.as_path().join("query-close-count");
    let start_count = root.as_path().join("provider-start-count");
    let refusal = root.as_path().join("refuse-stop");
    let stop_events = root.as_path().join("stop-events");
    let broker = root.as_path().join("hmux-proxy");
    fs::write(
        broker.with_extension("json"),
        serde_json::to_vec(&serde_json::json!({
            "runtime": hmux, "home": root.as_path(), "discoveryRoot": discovery_root,
            "refusal": refusal, "events": stop_events,
        }))
        .unwrap(),
    )
    .unwrap();
    write_executable(
        &broker,
        &format!(
            "#!/bin/sh\nexec {} {} {} \"$@\"\n",
            shell_path(&node),
            shell_path(&fixture.join("query-retirement-broker-proxy.mjs")),
            shell_path(&broker.with_extension("json"))
        ),
    );
    // The real relay and SDK child exit normally. Its owned launch shell stays
    // alive to model delayed relay quiescence until the exact Hmux stop wins.
    let held_relay = root.as_path().join("held-relay");
    write_executable(
        &held_relay,
        &format!(
            "#!/bin/sh\n{} \"$@\" || exit $?\nIFS= read -r fixture_hold\n",
            shell_path(&relay)
        ),
    );
    let entrypoint = fixture
        .join("claude-actual-query-retirement-fixture.mjs")
        .canonicalize()
        .unwrap();
    let host_configuration = || {
        ClaudeSdkHostSupervisorConfiguration::new(
            &node,
            &entrypoint,
            &host_state_root,
            &host_runtime_root,
            "host-query-retired",
            vec![
                (
                    "DURE_QUERY_CLOSE_COUNT_FILE".into(),
                    close_count.to_string_lossy().into_owned(),
                ),
                ("HOME".into(), root.as_path().to_string_lossy().into_owned()),
                ("PATH".into(), std::env::var("PATH").unwrap()),
            ],
        )
        .unwrap()
    };
    let host = Arc::new(
        ClaudeConversationHost::new(
            host_configuration(),
            "client-query-retired",
            Arc::clone(&conversation_service),
            Arc::new(AgentConversationRuntimeRegistry::default()),
        )
        .unwrap(),
    );
    let configuration = ClaudeStructuredRuntimeConfiguration::new(
        "backend-query-retired",
        broker.clone(),
        discovery_root.clone(),
        held_relay,
        runtime_state_root,
        BTreeMap::from([
            ("HOME".into(), root.as_path().to_string_lossy().into_owned()),
            ("PATH".into(), std::env::var("PATH").unwrap()),
            (
                "HEBBIAN_TEST_CLAUDE_START_LOG_FILE".into(),
                start_count.to_string_lossy().into_owned(),
            ),
        ]),
    )
    .unwrap();
    let credential_profiles = Arc::new(ProviderCredentialProfileRegistry::new(
        root.as_path().to_path_buf(),
        Arc::clone(&store),
    ));
    let manager = ClaudeStructuredRuntimeManager::new(
        configuration.clone(),
        Arc::clone(&credential_profiles),
        Arc::clone(&conversation_service),
        Arc::clone(&host),
        Arc::clone(&store),
    );
    manager
        .launch(ClaudeStructuredLaunchRequestV1 {
            interaction_session_id: binding.interaction_session_id.clone(),
        })
        .await
        .unwrap();
    let prepared = manager
        .read_runtime(&binding, workspace_id.as_str(), &workspace)
        .unwrap()
        .unwrap();
    let descriptor = prepared.journal.descriptor().unwrap().clone();
    let _cleanup = ExactRelayCleanup {
        runtime: broker,
        refusal: refusal.clone(),
        cwd: workspace.clone(),
        discovery_root: discovery_root.clone(),
        descriptor: descriptor.clone(),
    };
    let identity = prepared.journal.query_identity();
    let source_host = u32::try_from(
        serde_json::to_value(&prepared.journal).unwrap()["hostProcessId"]
            .as_u64()
            .unwrap(),
    )
    .unwrap();
    let source_process = hmux_client::exact_local_process_generation(source_host).unwrap();
    let binding = conversation_service
        .binding(&binding.interaction_session_id)
        .await
        .unwrap()
        .unwrap();
    let transition = store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            operation_id: OperationIdV1::new("transition-query-retired").unwrap(),
            idempotency_key: "transition-query-retired-key".into(),
            source: source_selection,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: binding.clone(),
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "99999999-8888-4777-8666-555555555555",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            target_execution_profile: binding.execution_profile.clone(),
            target_launch_selection: None,
            requested_at_ms: 5,
        })
        .await
        .unwrap();

    assert_eq!(fs::read_to_string(&start_count).unwrap().lines().count(), 1);
    let provider_process = hmux_client::exact_local_process_generation(
        fs::read_to_string(&start_count)
            .unwrap()
            .trim()
            .parse()
            .unwrap(),
    )
    .unwrap();
    assert!(!close_count.exists());
    assert_eq!(
        probe_local_process_generation(&descriptor.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    // A real Query closes before the durable control-plane checkpoint. Replaying
    // this crash cut must consume the exact host receipt without closing twice.
    host.retire_idle(&binding, &identity, None).await.unwrap();
    assert_eq!(
        read_journal(&prepared.files.runtime_directory)
            .unwrap()
            .state(),
        ClaudeRuntimeLaunchStateV1::Attached
    );
    assert_eq!(fs::read(&close_count).unwrap(), b"x");
    assert_eq!(
        probe_local_process_generation(&provider_process).unwrap(),
        LocalProcessGenerationStatus::Absent,
        "the real relay reaped the SDK child"
    );
    fs::write(&refusal, b"refuse exact stop").unwrap();
    for attempt in 0..2 {
        eprintln!(
            "stop attempt={attempt}, journal={:?}",
            read_journal(&prepared.files.runtime_directory)
                .unwrap()
                .state()
        );
        assert_eq!(
            manager
                .stop_replacement_source(&transition)
                .await
                .unwrap_err(),
            ClaudeStructuredRuntimeErrorV1::StopFailed
        );
        let journal = read_journal(&prepared.files.runtime_directory).unwrap();
        assert_eq!(
            journal.state(),
            ClaudeRuntimeLaunchStateV1::StopCleanupPending
        );
        assert!(journal.retirement_authority().is_some());
        assert_eq!(fs::read(&close_count).unwrap(), b"x");
        assert_eq!(
            probe_local_process_generation(&descriptor.provider_process).unwrap(),
            LocalProcessGenerationStatus::Live
        );
        assert_eq!(
            store
                .agent_runtime_transition(&transition.intent.operation_id)
                .await
                .unwrap()
                .unwrap()
                .state,
            AgentRuntimeTransitionStateV1::Admitted
        );
        assert_eq!(
            fs::read_to_string(&start_count).unwrap().lines().count(),
            1,
            "no target provider started while source stop was refused"
        );
        assert_eq!(
            LocalSessionCatalog::new(&discovery_root)
                .list()
                .unwrap()
                .len(),
            1
        );
    }
    let events = fs::read_to_string(&stop_events).unwrap();
    assert_eq!(events.lines().count(), 2);
    assert!(
        events
            .lines()
            .all(|line| line == "hmux_managed_stop_unavailable"),
        "{events}"
    );
    if finish_before_restart {
        fs::remove_file(&refusal).unwrap();
        manager.stop_replacement_source(&transition).await.unwrap();
        manager.stop_replacement_source(&transition).await.unwrap();
        assert_eq!(
            read_journal(&prepared.files.runtime_directory)
                .unwrap()
                .state(),
            ClaudeRuntimeLaunchStateV1::Stopped
        );
        assert_eq!(
            probe_local_process_generation(&descriptor.provider_process).unwrap(),
            LocalProcessGenerationStatus::Absent
        );
    }
    if legacy {
        // Upgrade from v4 QueryRetired predates the durable host receipt.
        let path = prepared.files.runtime_directory.join("launch.json");
        let mut journal: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        journal["schemaVersion"] = 4.into();
        journal["state"] = "query_retired".into();
        journal["retainRetirementFence"] = false.into();
        journal
            .as_object_mut()
            .unwrap()
            .remove("providerRetirementAuthority");
        journal
            .as_object_mut()
            .unwrap()
            .remove("managedCreateIdentity");
        fs::write(path, serde_json::to_vec(&journal).unwrap()).unwrap();
    }
    drop(manager);
    drop(host);
    let deadline = Instant::now() + Duration::from_secs(5);
    while probe_local_process_generation(&source_process).unwrap()
        == LocalProcessGenerationStatus::Live
        && Instant::now() < deadline
    {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        probe_local_process_generation(&source_process).unwrap(),
        LocalProcessGenerationStatus::Absent,
        "recovery requires a fresh SDK host"
    );
    if !finish_before_restart {
        fs::remove_file(&refusal).unwrap();
    }
    let restarted_host = Arc::new(
        ClaudeConversationHost::new(
            host_configuration(),
            "client-query-retired-restarted",
            Arc::clone(&conversation_service),
            Arc::new(AgentConversationRuntimeRegistry::default()),
        )
        .unwrap(),
    );
    let restarted = ClaudeStructuredRuntimeManager::new(
        configuration,
        credential_profiles,
        conversation_service,
        restarted_host,
        store,
    );
    restarted
        .stop_replacement_source(&transition)
        .await
        .unwrap();
    restarted
        .stop_replacement_source(&transition)
        .await
        .unwrap();
    assert_eq!(fs::read(&close_count).unwrap(), b"x");
    assert_eq!(
        read_journal(&prepared.files.runtime_directory)
            .unwrap()
            .state(),
        ClaudeRuntimeLaunchStateV1::Stopped
    );
    assert_eq!(
        probe_local_process_generation(&descriptor.provider_process).unwrap(),
        LocalProcessGenerationStatus::Absent
    );
    assert_eq!(
        probe_local_process_generation(&descriptor.host_process).unwrap(),
        LocalProcessGenerationStatus::Absent
    );
    assert_eq!(fs::read_to_string(&start_count).unwrap().lines().count(), 1);
    assert_eq!(
        fs::read_to_string(&stop_events).unwrap().lines().count(),
        3,
        "completed replay does not repeat the broker stop"
    );
    let fresh_host_processes = fs::read_dir(&host_state_root)
        .unwrap()
        .map(Result::unwrap)
        .filter(|entry| entry.file_type().unwrap().is_dir())
        .map(|entry| {
            let bytes = fs::read(entry.path().join("host.json")).unwrap();
            let marker: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            hmux_client::exact_local_process_generation(
                u32::try_from(marker["pid"].as_u64().unwrap()).unwrap(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    drop(restarted);
    drop(_cleanup);
    for process in fresh_host_processes {
        let deadline = Instant::now() + Duration::from_secs(5);
        while probe_local_process_generation(&process).unwrap()
            == LocalProcessGenerationStatus::Live
            && Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            probe_local_process_generation(&process).unwrap(),
            LocalProcessGenerationStatus::Absent
        );
    }
    // A failure retains this owned root for diagnosis; successful cleanup only
    // removes it after every recorded native and SDK-host generation is absent.
    fs::remove_dir_all(&root).unwrap();
    eprintln!(
        "actual SDK Query + native relay/broker: finish_before_restart={finish_before_restart}, legacy={legacy}, close=1, refused=2, source quiescent, retry converged, all owned processes absent"
    );
}

fn required_executable(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} required")))
        .canonicalize()
        .unwrap()
}

fn shell_path(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\"'\"'"))
}

fn write_executable(path: &Path, source: &str) {
    fs::write(path, source).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

struct ExactRelayCleanup {
    runtime: PathBuf,
    refusal: PathBuf,
    cwd: PathBuf,
    discovery_root: PathBuf,
    descriptor: SessionDescriptor,
}

impl Drop for ExactRelayCleanup {
    fn drop(&mut self) {
        if [
            &self.descriptor.host_process,
            &self.descriptor.provider_process,
        ]
        .iter()
        .all(|process| {
            probe_local_process_generation(process).ok()
                == Some(LocalProcessGenerationStatus::Absent)
        }) {
            return;
        }
        let _ = fs::remove_file(&self.refusal);
        let request = ManagedStopRequest::new(
            "fixture-final-cleanup",
            &self.descriptor.session_id,
            &self.descriptor.workspace_id,
        )
        .unwrap()
        .with_expected_fence(
            &self.descriptor.runner_principal,
            &self.descriptor.runner_instance,
            self.descriptor.channel_epoch.parse().unwrap(),
            &self.descriptor.host_instance_id,
            &self.descriptor.terminal_epoch,
        )
        .unwrap();
        let result = ManagedSessionStopper::new(&self.runtime, &self.cwd)
            .with_discovery_root(&self.discovery_root)
            .stop(request);
        if let Err(error) = result {
            eprintln!("owned exact relay cleanup: {error}");
        }
    }
}
