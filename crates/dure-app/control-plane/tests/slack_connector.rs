#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use dure_control_plane::{
    ControlPlaneEndpoint, ServeOptions, agent_conversation_api::AgentConversationRuntimeRegistry,
    prepare_with_agent_conversation_runtimes,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::oneshot;
use tokio::time::timeout;

fn write(path: &Path, source: &str, mode: u32) {
    fs::write(path, source).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
}

async fn request(endpoint: &ControlPlaneEndpoint, operation: &str, body: Value) -> Value {
    let response = request_scoped(endpoint, operation, body, None).await;
    assert_eq!(
        response["kind"], "dure.backend.response",
        "backend rejected the QA operation: {}",
        response["error"]["code"]
    );
    response["result"].clone()
}

async fn request_scoped(
    endpoint: &ControlPlaneEndpoint,
    operation: &str,
    body: Value,
    scope: Option<&str>,
) -> Value {
    let mut required = if operation == "slack.connector" {
        vec!["slack.connector.v1"]
    } else {
        vec![]
    };
    if operation == "backend.scope" || scope.is_some() {
        required.push("backend.scope.v1");
    }
    let mut message = json!({ "schemaVersion": 1, "apiVersion": "dure.backend-transport/v1",
        "kind": "dure.backend.request", "requestId": "slack-native-qa", "operation": operation,
        "expected": { "backendId": endpoint.backend_id, "generation": endpoint.generation,
            "protocol": { "minimum": { "major": 1, "minor": 0 }, "maximum": { "major": 1, "minor": 0 } },
            "requiredCapabilities": required }, "body": body });
    if let Some(scope) = scope {
        message["expected"]["scopeId"] = json!(scope);
    }
    timeout(Duration::from_secs(45), async {
        let mut socket = UnixStream::connect(&endpoint.socket_path).await.unwrap();
        socket
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap();
        let mut source = Vec::new();
        socket.read_to_end(&mut source).await.unwrap();
        serde_json::from_slice(&source).unwrap()
    })
    .await
    .expect("backend operation deadline")
}

fn isolated_root() -> (tempfile::TempDir, PathBuf) {
    let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    let discovery = PathBuf::from(std::env::var_os("HMUX_DISCOVERY_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    let temporary = PathBuf::from(std::env::var_os("TMPDIR").unwrap())
        .canonicalize()
        .unwrap();
    assert_eq!(discovery.parent(), Some(guardian.as_path()));
    assert_eq!(temporary.parent(), Some(guardian.as_path()));
    let root = tempfile::Builder::new()
        .prefix("slack-backend-")
        .tempdir_in(temporary)
        .unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    (root, discovery)
}

async fn connected(endpoint: &ControlPlaneEndpoint) -> Value {
    timeout(Duration::from_secs(45), async {
        loop {
            let result = request(
                endpoint,
                "slack.connector",
                json!({ "schemaVersion": 1, "kind": "list" }),
            )
            .await;
            if let Some(connection) = result["connections"].as_array().unwrap().first() {
                assert_ne!(
                    connection["connection"], "failed",
                    "connector failed: {}",
                    connection["failure"]
                );
                if connection["connection"] == "connected" {
                    return connection.clone();
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("Slack hello deadline")
}

async fn serve(
    root: &Path,
    discovery: &Path,
    generation: Option<String>,
) -> (
    ControlPlaneEndpoint,
    tokio::task::JoinHandle<Result<(), dure_control_plane::ControlPlaneError>>,
) {
    let prepared = prepare_with_agent_conversation_runtimes(
        ServeOptions {
            home: root.to_owned(),
            hmux_bin: root.join("unused-hmux"),
            hmux_runtime_bin: root.join("unused-hmux"),
            hmux_discovery_root: discovery.to_owned(),
            claude_structured_runtime: None,
            launch_executable: Some(root.join("dure-control-plane")),
            expected_generation: generation,
            activation_source_generation: None,
            staged: false,
        },
        Arc::new(AgentConversationRuntimeRegistry::default()),
    )
    .await
    .unwrap();
    let (published, ready) = oneshot::channel();
    let server = tokio::spawn(prepared.serve_with_publication(published));
    (ready.await.unwrap(), server)
}

fn assert_retired(directory: &Path) {
    assert!(!directory.join("config.json.connector.json").exists());
    assert!(!directory.join("config.json.deliveries.json.lock").exists());
    let journal: Value =
        serde_json::from_slice(&fs::read(directory.join("config.json.deliveries.json")).unwrap())
            .unwrap();
    for key in ["threads", "inbox", "outbound"] {
        assert_eq!(journal[key], json!({}));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "connection-only QA requires the Hmux guardian and Node; existing Slack credentials are optional"]
async fn backend_owns_the_real_connector_across_client_close_and_server_restart() {
    let (root, discovery) = isolated_root();
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let node = PathBuf::from(std::env::var_os("DURE_NODE_BIN").unwrap())
        .canonicalize()
        .unwrap();
    let credentials = std::env::var_os("DURE_SLACK_QA_CREDENTIALS");
    let real = credentials.is_some();
    let team = if real {
        std::env::var("DURE_SLACK_QA_TEAM").unwrap()
    } else {
        "T1".into()
    };
    let tokens: Value = match credentials {
        Some(path) => {
            let metadata = fs::metadata(&path).unwrap();
            assert_eq!(metadata.permissions().mode() & 0o077, 0);
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
        }
        None => json!({ "appToken": "fixture-app", "botToken": "fixture-bot" }),
    };
    // Use the installed sibling layout. The backend itself derives dure.mjs;
    // this QA wrapper only pins Node/source and optionally the transport fixture.
    fs::hard_link(
        std::env::current_exe().unwrap(),
        root.path().join("dure-control-plane"),
    )
    .unwrap();
    let preload = if real {
        String::new()
    } else {
        format!(
            "--import {} ",
            quote(&source.join("scripts/fixtures/slack-connector-network.mjs"))
        )
    };
    write(
        &root.path().join("dure.mjs"),
        &format!(
            "#!/bin/sh\nexec {} {preload}{} \"$@\"\n",
            quote(&node),
            quote(&source.join("cli/dure.mjs"))
        ),
        0o700,
    );
    // No task route exists, so Hmux/provider execution must never occur.
    write(
        &root.path().join("unused-hmux"),
        "#!/bin/sh\nexit 99\n",
        0o700,
    );
    let (endpoint, server) = serve(root.path(), &discovery, None).await;
    let scope = request(&endpoint, "backend.scope", json!({ "schemaVersion": 1 })).await;
    let intent = json!({ "schemaVersion": 1, "kind": "connect",
        "config": { "schemaVersion": 1, "teamId": team, "channels": [] },
        "appToken": tokens["appToken"], "botToken": tokens["botToken"] });
    request(&endpoint, "slack.connector", intent).await;
    let first = connected(&endpoint).await;
    if !real {
        assert_eq!(first["filePermissions"], json!({ "read": true, "write": false }));
    }
    // Every request above closes its client socket. A later observation sees
    // the same live connector; the client never owns the stdin lifetime.
    assert_eq!(
        connected(&endpoint).await["generation"],
        first["generation"]
    );
    let directory = root.path().join("backend/slack").join(&team);
    let public = first.to_string();
    for key in ["appToken", "botToken"] {
        assert!(!public.contains(tokens[key].as_str().unwrap()));
        assert!(
            !fs::read_to_string(directory.join("config.json"))
                .unwrap()
                .contains(tokens[key].as_str().unwrap())
        );
    }
    request(
        &endpoint,
        "backend.shutdown",
        json!({ "schemaVersion": 2, "mode": "stop" }),
    )
    .await;
    timeout(Duration::from_secs(45), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_retired(&directory);
    let saved: Value =
        serde_json::from_slice(&fs::read(directory.join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["enabled"], true);
    let (resumed, server) = serve(root.path(), &discovery, Some(endpoint.generation.clone())).await;
    assert_eq!(
        request(&resumed, "backend.scope", json!({ "schemaVersion": 1 })).await,
        scope
    );
    let second = connected(&resumed).await;
    assert_ne!(second["generation"], first["generation"]);
    let disconnected = request(
        &resumed,
        "slack.connector",
        json!({ "schemaVersion": 1, "kind": "disconnect", "teamId": team }),
    )
    .await;
    assert_eq!(disconnected["connections"][0]["enabled"], false);
    assert_eq!(disconnected["connections"][0]["connection"], "stopped");
    assert_retired(&directory);
    request(
        &resumed,
        "backend.shutdown",
        json!({ "schemaVersion": 2, "mode": "stop" }),
    )
    .await;
    timeout(Duration::from_secs(45), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    println!(
        "{}",
        json!({ "realSlack": real, "realProvider": false, "threads": 0,
        "clientClosePreservesConnection": true, "backendRestartRestoresConnection": true,
        "explicitDisconnectStopsConnection": true, "journalPreserved": true,
        "firstGeneration": first["generation"], "secondGeneration": second["generation"],
        "testExecutableSha256": format!("{:x}", Sha256::digest(fs::read(std::env::current_exe().unwrap()).unwrap())),
        "cliSha256": format!("{:x}", Sha256::digest(fs::read(source.join("cli/dure.mjs")).unwrap())) })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "actual two-server scope QA requires the Hmux guardian"]
async fn equal_backend_family_ids_do_not_authorize_another_servers_mutations() {
    let (left, discovery) = isolated_root();
    let (right, _) = isolated_root();
    for root in [&left, &right] {
        fs::hard_link(
            std::env::current_exe().unwrap(),
            root.path().join("dure-control-plane"),
        )
        .unwrap();
        write(
            &root.path().join("unused-hmux"),
            "#!/bin/sh\nexit 99\n",
            0o700,
        );
    }
    let (a, serving_a) = serve(left.path(), &discovery, None).await;
    let (b, serving_b) = serve(right.path(), &discovery, None).await;
    assert_eq!(a.backend_id, b.backend_id);
    let scope_a = request(&a, "backend.scope", json!({ "schemaVersion": 1 })).await;
    let scope_b = request(&b, "backend.scope", json!({ "schemaVersion": 1 })).await;
    assert_ne!(scope_a["scopeId"], scope_b["scopeId"]);
    let intent = json!({ "schemaVersion": 1, "kind": "connect", "config": { "schemaVersion": 1, "teamId": "T1", "channels": [] } });
    let wrong = request_scoped(
        &b,
        "slack.connector",
        intent.clone(),
        scope_a["scopeId"].as_str(),
    )
    .await;
    assert_eq!(wrong["error"]["code"], "backend_scope_mismatch");
    assert_eq!(
        request(
            &b,
            "slack.connector",
            json!({ "schemaVersion": 1, "kind": "list" })
        )
        .await["connections"],
        json!([])
    );
    assert!(!right.path().join("backend/slack/T1").exists());
    let accepted = request_scoped(&b, "slack.connector", intent, scope_b["scopeId"].as_str()).await;
    assert_eq!(accepted["kind"], "dure.backend.response");
    assert_eq!(
        accepted["result"]["connections"][0]["config"]["teamId"],
        "T1"
    );
    assert_eq!(
        accepted["result"]["connections"][0]["failure"], "slack_connector_launch_failed",
        "the admitted operation reaches its actual launch without preflight"
    );
    for endpoint in [&a, &b] {
        request(
            endpoint,
            "backend.shutdown",
            json!({ "schemaVersion": 2, "mode": "stop" }),
        )
        .await;
    }
    timeout(Duration::from_secs(10), serving_a)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    timeout(Duration::from_secs(10), serving_b)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    println!(
        "{}",
        json!({ "actualServers": 2, "backendFamilyId": a.backend_id, "scopesDistinct": true,
        "wrongScopeMutationRejected": true, "correctScopeMutationExecuted": true, "realSlack": false, "realProvider": false })
    );
}
