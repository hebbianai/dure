use super::*;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::{fs::PermissionsExt, net::UnixListener};
use std::time::{SystemTime, UNIX_EPOCH};

fn observation(source: &hmux_client::SessionDescriptor) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1, "state": "stable",
        "receipt": {
            "schemaVersion": 1, "agentId": "agent-1", "selectionRevision": 1,
            "providerId": "codex", "executionProfile": {
                "kind": "credential_reference", "reference_id": "credential-named", "credential_generation": null
            },
            "permissionMode": "skip_permissions", "providerConversationRef": "conversation-named",
            "launchIdempotencyKey": null,
            "authority": {"interactionProfile": "native_cli", "authority": {
                "schemaVersion": 1,
                "binding": {
                    "agentId": "agent-1", "runtimeKindId": "runtime.hmux",
                    "sessionId": source.session_id, "providerConversationId": "conversation-named",
                    "credentialReferenceId": "credential-named", "bindingGeneration": 1, "boundAtMs": 1
                },
                "runtimeWorkspaceId": source.workspace_id,
                "runnerPrincipal": source.runner_principal, "runnerInstance": source.runner_instance,
                "channelEpoch": source.channel_epoch, "hostInstanceId": source.host_instance_id,
                "terminalEpoch": source.terminal_epoch, "updatedAtMs": 1
            }}
        },
        "projectionContext": {
            "schemaVersion": 1, "identity": {"kind": "registered"},
            "agent": {"agentId": "agent-1", "workspaceId": "workspace-1", "providerId": "codex"},
            "workspace": {"workspaceId": "workspace-1", "projectId": "project-1", "rootPath": "/fixture"},
            "project": {"projectId": "project-1", "rootPath": "/fixture"}
        }
    })
}

#[test]
#[ignore = "run pnpm test:hmux-rehost-cli with the isolated test guardian and built CLI"]
fn confirmed_name_pins_execution_and_publication() {
    let state = std::path::PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    let cwd = state.join("named");
    let app = cwd.join("app");
    fs::create_dir_all(&app).unwrap();
    let discovery = cwd.join("discovery");
    let marker = cwd.join("conversation");
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery)
        .create(rehostable_create_request(&cwd, &marker, "named"))
        .unwrap();
    let source = created.session().descriptor().clone();
    let observation = observation(&source);
    let socket = cwd.join("b.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
    let backend = serde_json::json!({
        "id": "fixture", "generation": "generation-1", "protocol": {"major": 1, "minor": 0},
        "capabilities": ["agent_runtime.projection.inspect", "agent_runtime.native_rehost.reconcile"],
        "observedAtMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
    });
    let profiles = app.join("backend-profiles.json");
    fs::write(
        &profiles,
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "kind": "dure.backend_profiles", "profiles": [{
                "id": "fixture", "default": true,
                "transport": {"kind": "local", "endpoint": {"kind": "unix_socket", "path": socket}},
                "auth": {"kind": "peer"}, "trust": {"kind": "local_peer"},
                "expected": {"backendId": backend["id"], "generation": backend["generation"],
                    "protocol": {"minimum": backend["protocol"], "maximum": backend["protocol"]},
                    "capabilities": backend["capabilities"]}, "deadlineMs": 1000
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    fs::set_permissions(&profiles, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(
        app.join("agents.json"),
        br#"{"agents":[{"id":"agent-1","name":"worker","sessionId":"stale-source"}]}"#,
    )
    .unwrap();

    // Only metadata/publication transport is a fixture; execution uses real native binaries.
    let server = thread::spawn(move || {
        let mut requests = Vec::new();
        for attempt in 0..3 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut line = String::new();
            BufReader::new(&stream).read_line(&mut line).unwrap();
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            requests.push(request.clone());
            if attempt == 1 {
                continue; // Discard the first publication response after native success.
            }
            let result = if attempt == 0 {
                observation.clone()
            } else {
                serde_json::json!({"schemaVersion": 1, "receipt": {
                    "schemaVersion": 1, "agentId": "agent-1", "selectionRevision": 2,
                    "operationId": request["body"]["operationId"]
                }})
            };
            writeln!(
                stream,
                "{}",
                serde_json::json!({
                    "schemaVersion": 1, "apiVersion": "dure.backend-transport/v1",
                    "kind": "dure.backend.response", "requestId": request["requestId"],
                    "backend": backend, "result": result
                })
            )
            .unwrap();
        }
        requests
    });
    let dure = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../cli/dure.mjs");
    let run = |args: &[String]| {
        Command::new("node")
            .arg(&dure)
            .args(args)
            .current_dir(&cwd)
            .env("HOME", &cwd)
            .env("DURE_HOME", &app)
            .env("DURE_APP_CHANNEL", "stable")
            .env_remove("HEBBIAN_APP_CHANNEL")
            .env_remove("DURE_BACKEND_PROFILE")
            .env(
                "DURE_HMUX_BIN",
                std::env::var_os("DURE_QA_HMUX_BIN").unwrap(),
            )
            .env("HMUX_DISCOVERY_ROOT", &discovery)
            .env("HMUX_RUNTIME", env!("CARGO_BIN_EXE_hmux-runtime"))
            .env_remove(MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV)
            .output()
            .unwrap()
    };
    let result = run(&[
        "hmux",
        "rehost",
        "--name",
        "worker",
        "--confirm-restart",
        "--backend",
        "fixture",
        "--json",
    ]
    .map(String::from));
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["nativeExecution"], "completed");
    assert_eq!(report["publication"], "unconfirmed");
    let receipt: hmux_client::ManagedRehostReceipt =
        serde_json::from_value(report["receipt"].clone()).unwrap();
    receipt.validate().unwrap();
    wait_for_exited(&discovery, &source.session_id, &source.workspace_id);
    fs::write(
        app.join("agents.json"),
        br#"{"agents":[{"id":"different-agent","name":"worker","sessionId":"different-source"}]}"#,
    )
    .unwrap();
    for action in ["retry", "status", "publish"] {
        let args = report["continuation"][action]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        let replay = run(&args);
        assert!(
            replay.status.success(),
            "{}",
            String::from_utf8_lossy(&replay.stderr)
        );
        if action == "retry" {
            let mut expected = report["receipt"].clone();
            expected["replayed"] = true.into();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&replay.stdout).unwrap(),
                expected
            );
        }
    }
    let requests = server.join().unwrap();
    assert_eq!(requests[0]["operation"], "agent_runtime.projection.inspect");
    assert_eq!(
        requests[1]["operation"],
        "agent_runtime.native_rehost.reconcile"
    );
    assert_eq!(requests[2]["body"], requests[1]["body"]);
    assert_eq!(requests[1]["body"]["agentId"], "agent-1");
    assert_eq!(requests[1]["body"]["sourceSessionId"], source.session_id);
    assert_eq!(requests[1]["body"]["operationId"], receipt.operation_id());
    assert!(!app.join("server.json").exists());
    wait_for_file_content(&marker, b"conversation-named");
    assert_eq!(
        fs::read(&marker).unwrap(),
        b"conversation-named",
        "only one provider launch"
    );
    let catalog = LocalSessionCatalog::new(&discovery);
    let target = catalog
        .find(&SessionSelector::new(
            receipt.replacement_receipt().session_id(),
            Some(source.workspace_id),
        ))
        .unwrap();
    assert_eq!(
        catalog
            .list()
            .unwrap()
            .iter()
            .filter(|entry| entry.lifecycle == SessionLifecycle::Ready)
            .count(),
        1
    );
    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery)
        .stop(exact_managed_stop_request("named-cli-cleanup", &target))
        .unwrap();
    wait_for_exited(&discovery, &target.session_id, &target.workspace_id);
}
