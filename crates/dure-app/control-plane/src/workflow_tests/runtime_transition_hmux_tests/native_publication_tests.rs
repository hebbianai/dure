use super::*;
use hmux_client::{
    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER, ManagedRehostRecipe, ManagedRehostReplacement,
    ManagedRehostRequest, ManagedRehostResolution, ManagedSessionRehoster, PermissionMode,
    TerminalEnvironment,
};

#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn native_rehost_publication_uses_real_hmux() {
    publication_uses_real_hmux(false).await;
    publication_uses_real_hmux(true).await;
}

async fn publication_uses_real_hmux(automatic: bool) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let starts = root.path().join("provider-starts");
    let provider = root.path().join("codex-fixture");
    fs::write(
        &provider,
        format!(
            "#!/bin/sh\nprintf 'started\\n' >> '{}'\nexec sleep 120\n",
            starts.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&provider, fs::Permissions::from_mode(0o700)).unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let native_launcher = Arc::clone(&state.credential_aware_workflow_launcher);
    let agent_id = AgentIdV1::new("native-publication-agent").unwrap();
    let source = launch(&state, &hmux, "native-publication-source").await;
    wait_for_provider_starts(&starts, 1).await;
    bind_source(&state, &agent_id, &source).await;
    let runtime = state.hmux_identity.runtime_executable_path.clone();
    let rehost = ManagedRehostRequest::new(
        "native-publication-operation",
        &source.session_id,
        &source.workspace_id,
        &source.runner_principal,
        &source.runner_instance,
        source.channel_epoch.parse().unwrap(),
        &source.host_instance_id,
        &source.terminal_epoch,
        true,
    )
    .unwrap()
    .with_replacement(
        ManagedRehostReplacement::new(
            "codex",
            PermissionMode::Default,
            &hmux.root,
            24,
            80,
            TerminalEnvironment::default(),
            None,
            ProviderStateEnvironment::default(),
            ManagedRehostRecipe::new(
                vec![
                    provider.to_str().unwrap().into(),
                    "resume".into(),
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                ],
                None,
            )
            .unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    let receipt = ManagedSessionRehoster::new(&runtime, &hmux.root)
        .with_discovery_root(&hmux.discovery)
        .rehost(rehost)
        .unwrap();
    let target = replacement_session(&receipt);
    let before = hmux.session(&target);
    wait_for_provider_starts(&starts, 2).await;
    assert_eq!(fs::read_to_string(&starts).unwrap().lines().count(), 2);
    assert_eq!(receipt.conversation_id(), Some(CONVERSATION));
    // Native execution is complete. Publication has no authority to invoke it again.
    let invoked = hmux.root.join("publication-invoked-runtime");
    let unavailable_runtime = hmux.root.join("unavailable-runtime");
    fs::write(
        &unavailable_runtime,
        format!(
            "#!/bin/sh\nprintf invoked > '{}'\nexit 91\n",
            invoked.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&unavailable_runtime, fs::Permissions::from_mode(0o700)).unwrap();
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &state.hmux_identity.executable_path,
        &unavailable_runtime,
        &hmux.discovery,
    )
    .unwrap();
    let database = hmux.root.join("application-state.sqlite3");
    // The direct-dispatch fixture uses a non-serving database/descriptor. Give
    // the real transport a coherent canonical service without relaxing admission.
    let original = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(hmux.root.join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query("VACUUM INTO ?1")
        .bind(database.to_str().unwrap())
        .execute(&original)
        .await
        .unwrap();
    original.close().await;
    fs::set_permissions(&database, fs::Permissions::from_mode(0o600)).unwrap();
    let (mut state, _) = reopen_fixture_service_state(&state, &database).await;
    state.descriptor.database_path = database.clone();
    publish_fixture_descriptor(&mut state);
    let fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(&database),
    )
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER fail_native_publication BEFORE UPDATE ON agent_runtime_selections
        BEGIN SELECT RAISE(ABORT, 'fault-injected publication'); END",
    )
    .execute(&fault_pool)
    .await
    .unwrap();
    let state = publication_state(state);
    let server = PublicationServer::start(Arc::clone(&state));
    let failed = publish_cli(Arc::clone(&state), &hmux.root, &agent_id, &receipt).await;
    assert_eq!(failed["ok"], false);
    assert_eq!(
        failed["error"]["remoteCode"],
        "agent_runtime_native_rehost_store_failed"
    );
    assert_eq!(failed["nativeExecution"], "not_requested");
    assert!(!invoked.exists());
    assert!(before.same_generation(&hmux.session(&target)));
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .binding
            .session_id,
        source.session_id
    );
    sqlx::query("DROP TRIGGER fail_native_publication")
        .execute(&fault_pool)
        .await
        .unwrap();
    fault_pool.close().await;
    drop(server);
    let (recovered, _) = reopen_fixture_service_state(&state, &database).await;
    let recovered = publication_state(recovered);
    let server = PublicationServer::start(Arc::clone(&recovered));
    if automatic {
        recovered
            .runtime_idle
            .configure(
                &recovered,
                serde_json::from_value(json!({
                    "schemaVersion": 1, "expectedRevision": 0,
                    "policy": {"mode": "enabled", "afterMs": 86400000},
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        let status = observe_automatic_publication(Arc::clone(&recovered)).await;
        assert!(!invoked.exists(), "Publication invoked the native runtime");
        assert_eq!(fs::read_to_string(&starts).unwrap().lines().count(), 2);
        assert!(before.same_generation(&hmux.session(&target)));
        assert_eq!(
            recovered
                .store
                .agent_checkpoint_binding_authority(&agent_id)
                .await
                .unwrap()
                .unwrap()
                .binding
                .session_id,
            target.session_id,
            "The idle coordinator inspected a retired source instead of its completed successor: {status}"
        );
        assert_eq!(inspect(&recovered, &agent_id).await["state"], "stable");
        let selection = recovered
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap();
        let authority = recovered
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap()
            .unwrap();
        {
            let _guard = recovered.agent_operations.acquire(&agent_id).await;
            assert!(
                !agent_runtime_native_rehost::request::publish_completed_successor_locked(
                    &recovered, &selection, &authority,
                )
                .await
                .unwrap(),
                "No lineage must not invent a successor"
            );
            let mut stale = authority.clone();
            stale.host_instance_id = "different-host".into();
            assert_eq!(
                agent_runtime_native_rehost::request::publish_completed_successor_locked(
                    &recovered, &selection, &stale,
                )
                .await
                .unwrap_err()
                .code,
                "agent_runtime_native_rehost_conflict"
            );
        }

        // Leave two more completed edges unpublished. The coordinator must
        // publish the final target once, not replay either native operation.
        let mut latest = target;
        for index in 0..2 {
            let request = ManagedRehostRequest::new(
                format!("automatic-publication-chain-{index}"),
                &latest.session_id,
                &latest.workspace_id,
                &latest.runner_principal,
                &latest.runner_instance,
                latest.channel_epoch.parse().unwrap(),
                &latest.host_instance_id,
                &latest.terminal_epoch,
                true,
            )
            .unwrap();
            let next = ManagedSessionRehoster::new(&runtime, &hmux.root)
                .with_discovery_root(&hmux.discovery)
                .rehost(request)
                .unwrap();
            latest = replacement_session(&next);
            wait_for_provider_starts(&starts, index + 3).await;
        }
        state_reporter::report(
            &hmux,
            &latest,
            hmux_client::AgentRuntimeActivity::Working,
            hmux_client::AgentRuntimeAttention::None,
            false,
        );
        let current = hmux.session(&latest);
        drop(server);
        let (reopened, _) = reopen_fixture_service_state(&recovered, &database).await;
        let reopened = publication_state(reopened);
        let _server = PublicationServer::start(Arc::clone(&reopened));
        for _ in 0..2 {
            let status = observe_automatic_publication(Arc::clone(&reopened)).await;
            assert_eq!(status["agents"][0]["state"], "protected", "{status}");
            let projection = inspect(&reopened, &agent_id).await;
            assert_eq!(
                projection["receipt"]["selectionRevision"], 3,
                "{projection}"
            );
            assert_eq!(
                reopened
                    .store
                    .agent_checkpoint_binding_authority(&agent_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .binding
                    .session_id,
                latest.session_id
            );
            assert!(current.same_generation(&hmux.session(&latest)));
            assert_eq!(fs::read_to_string(&starts).unwrap().lines().count(), 4);
            assert!(!invoked.exists());
        }
        // Publication is now proven not to execute the runtime. Restore the
        // exact fixture runtime for a separate natural idle-stop/wake phase.
        drop(_server);
        let (mut resumed, _) = reopen_fixture_service_state(&reopened, &database).await;
        resumed.hmux_identity = resolve_hmux_toolchain_identity(
            &resumed.hmux_identity.executable_path,
            &runtime,
            &hmux.discovery,
        )
        .unwrap();
        resumed.runtime_adapters = Arc::new(runtime_extension::local_hmux_runtime_registry(
            resumed.hmux_identity.clone(),
        ));
        resumed.credential_aware_workflow_launcher = native_launcher;
        publish_fixture_descriptor(&mut resumed);
        let resumed = publication_state(resumed);
        let _server = PublicationServer::start(Arc::clone(&resumed));
        resumed
            .runtime_idle
            .configure(
                &resumed,
                serde_json::from_value(json!({
                    "schemaVersion": 1, "expectedRevision": 1,
                    "policy": {"mode": "enabled", "afterMs": 1000},
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        state_reporter::report(
            &hmux,
            &latest,
            hmux_client::AgentRuntimeActivity::Waiting,
            hmux_client::AgentRuntimeAttention::None,
            true,
        );
        let mut workers = tokio::task::JoinSet::new();
        workers.spawn(agent_runtime_transition_apply::deferred::idle::run(
            Arc::clone(&resumed),
        ));
        let asleep = tokio::time::timeout(std::time::Duration::from_secs(40), async {
            loop {
                let projection = inspect(&resumed, &agent_id).await;
                if projection["deferredTarget"]["state"] == "waiting" {
                    break projection;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await;
        workers.abort_all();
        while workers.join_next().await.is_some() {}
        let asleep = asleep.unwrap_or_else(|error| {
            panic!("The recovered successor was not automatically hibernated: {error}")
        });
        assert_eq!(asleep["stage"], "source_stopped");
        RealHmux::assert_exited(&current).await;
        assert_eq!(fs::read_to_string(&starts).unwrap().lines().count(), 4);
        let body = serde_json::from_value(json!({
            "schemaVersion": 1, "agentId": agent_id,
            "operationId": asleep["operationId"],
            "expectedJournalRevision": asleep["journalRevision"],
            "expectedProviderConversationRef": CONVERSATION,
        }))
        .unwrap();
        let awake = agent_runtime_transition_apply::deferred::wake(
            &resumed,
            "wake-published-successor",
            body,
        )
        .await
        .unwrap();
        let awake = serde_json::to_value(awake).unwrap();
        assert_eq!(awake["receipt"]["providerConversationRef"], CONVERSATION);
        wait_for_provider_starts(&starts, 5).await;
        assert_eq!(
            hmux.requests().len(),
            2,
            "Only the explicit wake creates a new provider"
        );
        agent_runtime_close_apply::apply(
            &resumed,
            "close-published-successor",
            agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
                schema_version: 1,
                agent_id,
            },
        )
        .await
        .unwrap();
        return;
    }
    // Discard the successful client's output, then reopen the service and replay.
    let published = publish_cli(Arc::clone(&recovered), &hmux.root, &agent_id, &receipt).await;
    assert_eq!(published["ok"], true, "{published}");
    assert_eq!(published["result"]["receipt"]["selectionRevision"], 2);
    drop(server);
    let (reopened, launcher) = reopen_fixture_service_state(&recovered, &database).await;
    let reopened = publication_state(reopened);
    let _server = PublicationServer::start(Arc::clone(&reopened));
    let (left, right) = tokio::join!(
        publish_cli(Arc::clone(&reopened), &hmux.root, &agent_id, &receipt),
        publish_cli(Arc::clone(&reopened), &hmux.root, &agent_id, &receipt),
    );
    for replay in [left, right] {
        assert_eq!(replay["ok"], true, "{replay}");
        assert_eq!(replay["result"], published["result"]);
    }
    assert!(!invoked.exists());
    assert!(launcher.requests().is_empty());
    assert_eq!(hmux.requests().len(), 1);
    assert_eq!(fs::read_to_string(&starts).unwrap().lines().count(), 2);
    let after = hmux.session(&target);
    assert!(before.same_generation(&after));
    assert_eq!(before.provider_process, after.provider_process);
    assert_eq!(after.lifecycle, hmux_client::SessionLifecycle::Ready);
    assert_eq!(
        hmux.session(&source).lifecycle,
        hmux_client::SessionLifecycle::Exited
    );
    assert_eq!(
        reopened
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .binding
            .session_id,
        target.session_id,
    );
    // A name is only an initial selector. Its stale session projection cannot
    // replace the backend source, and preview cannot execute the runtime.
    let (succeeded, preview) = run_cli(
        &reopened,
        &hmux.root,
        &[
            "hmux",
            "rehost",
            "--name",
            "worker",
            "--backend",
            "fixture",
            "--json",
        ],
        Some(
            json!({"agents": [{"id": agent_id, "name": "worker", "sessionId": source.session_id}]}),
        ),
        None,
    )
    .await;
    assert!(succeeded, "{preview}");
    assert_eq!(preview["state"], "preview");
    assert_eq!(preview["nativeExecution"], "not_requested");
    assert_eq!(
        preview["continuation"]["sourceSessionId"],
        target.session_id
    );
    assert!(!invoked.exists());
    assert_eq!(fs::read_to_string(&starts).unwrap().lines().count(), 2);

    // Explicitly execute the saved continuation after the name points elsewhere.
    // A later old publication must not move this next generation back or restart it.
    let args: Vec<&str> = preview["continuation"]["start"]
        .as_array()
        .unwrap()
        .iter()
        .map(|arg| arg.as_str().unwrap())
        .collect();
    let (succeeded, next) = run_cli(
        &reopened,
        &hmux.root,
        &args,
        Some(json!({"agents": [{"id": "different-agent", "name": "worker", "sessionId": "unrelated"}]})),
        Some(&runtime),
    )
    .await;
    assert!(succeeded, "{next}");
    let next: hmux_client::ManagedRehostReceipt = serde_json::from_value(next).unwrap();
    let latest = replacement_session(&next);
    wait_for_provider_starts(&starts, 3).await;
    let latest_process = hmux.session(&latest);
    let latest_publication = publish_cli(Arc::clone(&reopened), &hmux.root, &agent_id, &next).await;
    assert_eq!(latest_publication["ok"], true, "{latest_publication}");
    assert_eq!(
        latest_publication["result"]["receipt"]["selectionRevision"],
        3
    );
    let stale = publish_cli(Arc::clone(&reopened), &hmux.root, &agent_id, &receipt).await;
    assert_eq!(stale["ok"], false, "{stale}");
    assert_eq!(
        stale["error"]["remoteCode"],
        "agent_runtime_native_rehost_conflict"
    );
    assert_eq!(
        reopened
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .binding
            .session_id,
        latest.session_id
    );
    assert_eq!(
        reopened
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        3
    );
    assert!(latest_process.same_generation(&hmux.session(&latest)));
    assert_eq!(
        latest_process.provider_process,
        hmux.session(&latest).provider_process
    );
    assert_eq!(fs::read_to_string(&starts).unwrap().lines().count(), 3);
    assert!(!invoked.exists());
    hmux.stop(&latest);
}

async fn observe_automatic_publication(state: Arc<ServiceState>) -> Value {
    let previous = serde_json::to_value(state.runtime_idle.inspect().await).unwrap();
    let mut workers = tokio::task::JoinSet::new();
    workers.spawn(agent_runtime_transition_apply::deferred::idle::run(
        Arc::clone(&state),
    ));
    let sampled = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let status = serde_json::to_value(state.runtime_idle.inspect().await).unwrap();
            if !status["observedAtMs"].is_null()
                && status["observedAtMs"] != previous["observedAtMs"]
                && !status["agents"].as_array().unwrap().is_empty()
            {
                break status;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await;
    workers.abort_all();
    while workers.join_next().await.is_some() {}
    sampled.expect("The actual idle coordinator did not publish its first scan")
}

fn replacement_session(receipt: &hmux_client::ManagedRehostReceipt) -> WorkflowSessionGenerationV1 {
    let resolution = ManagedRehostResolution::from_receipts(
        receipt.operation_id(),
        receipt.source_stop_receipt(),
        receipt.replacement_receipt(),
    )
    .unwrap();
    let generation = resolution.current_generation();
    WorkflowSessionGenerationV1 {
        session_id: generation.session_id().into(),
        workspace_id: generation.workspace_id().into(),
        provider_id: ProviderIdV1::new(receipt.replacement_receipt().provider_id()).unwrap(),
        runner_principal: generation.runner_principal().into(),
        runner_instance: generation.runner_instance().into(),
        channel_epoch: generation.channel_epoch().to_string(),
        host_instance_id: generation.host_instance_id().into(),
        terminal_epoch: generation.terminal_epoch().into(),
    }
}

async fn publish_cli(
    state: Arc<ServiceState>,
    root: &std::path::Path,
    agent_id: &AgentIdV1,
    receipt: &hmux_client::ManagedRehostReceipt,
) -> Value {
    let (succeeded, report) = run_cli(
        &state,
        root,
        &[
            "hmux",
            "rehost",
            "publish",
            agent_id.as_str(),
            "--from-session",
            receipt.source_stop_receipt().session_id(),
            "--workspace",
            receipt.source_stop_receipt().workspace_id(),
            "--operation-id",
            receipt.operation_id(),
            "--backend",
            "fixture",
            "--json",
        ],
        None,
        None,
    )
    .await;
    assert_eq!(succeeded, report["ok"].as_bool().unwrap());
    report
}

async fn run_cli(
    state: &ServiceState,
    root: &std::path::Path,
    args: &[&str],
    registry: Option<Value>,
    runtime: Option<&std::path::Path>,
) -> (bool, Value) {
    let client = tempfile::tempdir_in(root).unwrap();
    let socket = &state.descriptor.socket_path;
    let profiles = client.path().join("backend-profiles.json");
    fs::write(&profiles, serde_json::to_vec(&json!({
        "schemaVersion": 1, "kind": "dure.backend_profiles", "profiles": [{
            "id": "fixture", "default": true,
            "transport": { "kind": "local", "endpoint": { "kind": "unix_socket", "path": socket } },
            "auth": { "kind": "peer" }, "trust": { "kind": "local_peer" },
            "expected": {
                "backendId": state.descriptor.backend_id, "generation": state.descriptor.generation,
                "protocol": { "minimum": { "major": 1, "minor": 0 }, "maximum": { "major": 1, "minor": 0 } },
                "capabilities": ["agent_runtime.native_rehost.reconcile", "agent_runtime.projection.inspect"],
            }, "deadlineMs": 15000,
        }],
    })).unwrap()).unwrap();
    fs::set_permissions(profiles, fs::Permissions::from_mode(0o600)).unwrap();
    if let Some(registry) = &registry {
        fs::write(
            client.path().join("agents.json"),
            serde_json::to_vec(registry).unwrap(),
        )
        .unwrap();
    }
    let mut command = tokio::process::Command::new("node");
    command
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../cli/dure.mjs"))
        .args(args)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("HOME", client.path())
        .env("DURE_HOME", client.path())
        .env("DURE_APP_CHANNEL", "stable")
        .env("DURE_HMUX_BIN", client.path().join("must-not-execute-hmux"))
        .current_dir(client.path())
        .kill_on_drop(true);
    if let Some(runtime) = runtime {
        command
            .env("DURE_HMUX_BIN", &state.hmux_identity.executable_path)
            .env("HMUX_RUNTIME", runtime)
            .env("HMUX_DISCOVERY_ROOT", &state.hmux_identity.discovery_root);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(20), command.output())
        .await
        .expect("CLI request did not complete");
    let output = output.unwrap();
    let response = if output.status.success() {
        &output.stdout
    } else {
        &output.stderr
    };
    let report: Value = serde_json::from_slice(response).unwrap_or_else(|error| {
        panic!(
            "CLI request returned invalid JSON: {error}: {}",
            String::from_utf8_lossy(response)
        )
    });
    assert!(!client.path().join("server.json").exists());
    let observed = fs::read(client.path().join("agents.json"))
        .ok()
        .map(|bytes| serde_json::from_slice::<Value>(&bytes).unwrap());
    assert_eq!(observed, registry);
    (output.status.success(), report)
}

struct PublicationServer {
    task: tokio::task::JoinHandle<()>,
    socket: PathBuf,
}

fn publication_state(mut state: ServiceState) -> Arc<ServiceState> {
    // Match serving capacity; the direct-dispatch fixture reserves just one slot.
    state.request_slots = Arc::new(Semaphore::new(MAX_ACTIVE_REQUESTS));
    Arc::new(state)
}

impl PublicationServer {
    fn start(state: Arc<ServiceState>) -> Self {
        assert!(state.is_mutation_authority());
        let socket = state.descriptor.socket_path.clone();
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        let task = tokio::spawn(async move {
            let mut requests = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let state = Arc::clone(&state);
                        requests.spawn(async move { handle_connection(state, stream).await.unwrap() });
                    }
                    Some(result) = requests.join_next(), if !requests.is_empty() => { result.unwrap(); }
                }
            }
        });
        Self { task, socket }
    }
}

impl Drop for PublicationServer {
    fn drop(&mut self) {
        self.task.abort();
        fs::remove_file(&self.socket).unwrap();
    }
}

fn publish_fixture_descriptor(state: &mut ServiceState) {
    let identity = &state.hmux_identity;
    let descriptor = &mut state.descriptor;
    descriptor.hmux_executable_path = Some(identity.executable_path.clone());
    descriptor.hmux_executable_device = Some(identity.executable_device.clone());
    descriptor.hmux_executable_inode = Some(identity.executable_inode.clone());
    descriptor.hmux_executable_size = Some(identity.executable_size.clone());
    descriptor.hmux_executable_modified = Some(identity.executable_modified.clone());
    descriptor.hmux_executable_sha256 = Some(identity.executable_sha256.clone());
    descriptor.hmux_runtime_executable_path = Some(identity.runtime_executable_path.clone());
    descriptor.hmux_runtime_executable_device = Some(identity.runtime_executable_device.clone());
    descriptor.hmux_runtime_executable_inode = Some(identity.runtime_executable_inode.clone());
    descriptor.hmux_runtime_executable_size = Some(identity.runtime_executable_size.clone());
    descriptor.hmux_runtime_executable_modified =
        Some(identity.runtime_executable_modified.clone());
    descriptor.hmux_runtime_executable_sha256 = Some(identity.runtime_executable_sha256.clone());
    descriptor.hmux_discovery_root = Some(identity.discovery_root.clone());
    descriptor.hmux_discovery_device = Some(identity.discovery_device.clone());
    descriptor.hmux_discovery_inode = Some(identity.discovery_inode.clone());
    write_descriptor(&state.canonical_descriptor_path, descriptor).unwrap();
    assert_eq!(
        read_descriptor(&state.canonical_descriptor_path)
            .unwrap()
            .as_ref(),
        Some(&*descriptor)
    );
}

async fn wait_for_provider_starts(path: &std::path::Path, expected: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let count = match fs::read_to_string(path) {
                Ok(starts) => starts.lines().count(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
                Err(error) => panic!("fixture start marker: {error}"),
            };
            if count >= expected {
                assert_eq!(count, expected);
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture provider did not reach its startup marker");
}
