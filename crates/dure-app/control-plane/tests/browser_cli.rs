#![cfg(unix)]

#[path = "browser_cli/basic_actions.rs"]
mod basic_actions;
#[path = "browser_cli/captures.rs"]
mod captures;
#[path = "browser_cli/clipboard.rs"]
mod clipboard;
#[path = "browser_cli/console.rs"]
mod console;
#[path = "browser_cli/credentials.rs"]
mod credentials;
#[path = "browser_cli/current_page.rs"]
mod current_page;
#[path = "browser_cli/data.rs"]
mod data;
#[path = "browser_cli/desktop.rs"]
mod desktop;
#[path = "browser_cli/dialog.rs"]
mod dialog;
#[path = "browser_cli/diff.rs"]
mod diff;
#[path = "browser_cli/diff_screenshot.rs"]
mod diff_screenshot;
#[path = "browser_cli/downloads.rs"]
mod downloads;
#[path = "browser_cli/environment.rs"]
mod environment;
#[path = "browser_cli/files.rs"]
mod files;
#[path = "browser_cli/finding.rs"]
mod finding;
#[path = "browser_cli/har.rs"]
mod har;
#[path = "browser_cli/har_recovery.rs"]
mod har_recovery;
#[path = "browser_cli/har_sources.rs"]
mod har_sources;
#[path = "browser_cli/highlight.rs"]
mod highlight;
#[path = "browser_cli/installation.rs"]
mod installation;
#[path = "browser_cli/intercept.rs"]
mod intercept;
#[path = "browser_cli/keyboard.rs"]
mod keyboard;
#[path = "browser_cli/mouse.rs"]
mod mouse;
#[path = "browser_cli/network.rs"]
mod network;
#[path = "browser_cli/policy.rs"]
mod policy;
#[path = "browser_cli/profiles.rs"]
mod profiles;
#[path = "browser_cli/queries.rs"]
mod queries;
#[path = "browser_cli/react.rs"]
mod react;
#[path = "browser_cli/tab_labels.rs"]
mod tab_labels;
#[path = "browser_cli/tracing.rs"]
mod tracing;
#[path = "browser_cli/vitals.rs"]
mod vitals;
#[path = "browser_cli/waiting.rs"]
mod waiting;
#[path = "browser_cli/workspace_context.rs"]
mod workspace_context;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use dure_app::{
    DomainStore, OperationIdV1, ProjectIdV1, ProjectRecordV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;
use dure_control_plane::{
    ControlPlaneEndpoint, ServeOptions, agent_conversation_api::AgentConversationRuntimeRegistry,
    prepare_with_agent_conversation_runtimes,
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio::time::timeout;

fn owner_file(path: &Path, data: &[u8], mode: u32) {
    fs::write(path, data).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

async fn cli(home: &Path, arguments: &[&str]) -> Result<Value, String> {
    cli_from(home, arguments, None).await
}

async fn cli_from(home: &Path, arguments: &[&str], cwd: Option<&Path>) -> Result<Value, String> {
    cli_with_environment(home, arguments, cwd, None).await
}

async fn cli_with_environment(
    home: &Path,
    arguments: &[&str],
    cwd: Option<&Path>,
    encryption: Option<(&str, &str)>,
) -> Result<Value, String> {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../cli/dure.mjs");
    let mut command = Command::new("node");
    command
        .env_remove("DURE_BROWSER_ENCRYPTION_KEY")
        .env_remove("AGENT_BROWSER_ENCRYPTION_KEY");
    if let Some((name, value)) = encryption {
        command.env(name, value);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = timeout(
        Duration::from_secs(50),
        command
            .arg(script)
            .arg("browser")
            .args(["--backend", "browser-test"])
            .args(arguments)
            .env("DURE_HOME", home)
            .env("DURE_APP_CHANNEL", "browser-cli-proof")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "CLI deadline".to_string())?
    .map_err(|error| error.to_string())?;
    let result: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "CLI JSON: {error}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })?;
    if !output.status.success() {
        return Err(format!("CLI {} rejected: {result}", arguments[0]));
    }
    Ok(result)
}

fn envelope(endpoint: &ControlPlaneEndpoint, operation: &str, body: Value) -> Value {
    json!({
        "schemaVersion":1,"apiVersion":"dure.backend-transport/v1","kind":"dure.backend.request",
        "requestId":"browser-fixture-shutdown","operation":operation,
        "expected":{"backendId":endpoint.backend_id,"generation":endpoint.generation,
            "protocol":{"minimum":{"major":1,"minor":0},"maximum":{"major":1,"minor":0}},"requiredCapabilities":[]},
        "body":body,
    })
}

async fn backend(endpoint: &ControlPlaneEndpoint, operation: &str, body: Value) -> Value {
    let mut socket = UnixStream::connect(&endpoint.socket_path).await.unwrap();
    let request = envelope(endpoint, operation, body);
    socket
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    let mut response = String::new();
    BufReader::new(socket)
        .read_line(&mut response)
        .await
        .unwrap();
    serde_json::from_str(&response).unwrap()
}

async fn fixture() -> (
    std::path::PathBuf,
    ControlPlaneEndpoint,
    tokio::task::JoinHandle<Result<(), dure_control_plane::ControlPlaneError>>,
) {
    fixture_with_installation(Some(json!({
        "engineExecutable":std::env::var("DURE_BROWSER_TEST_BINARY").unwrap(),
        "chromiumExecutable":std::env::var("DURE_BROWSER_TEST_CHROMIUM").unwrap(),
    })))
    .await
}

async fn fixture_with_installation(
    installation: Option<Value>,
) -> (
    std::path::PathBuf,
    ControlPlaneEndpoint,
    tokio::task::JoinHandle<Result<(), dure_control_plane::ControlPlaneError>>,
) {
    let root = tempfile::Builder::new()
        .prefix("dure-browser-cli-")
        .tempdir_in("/tmp")
        .unwrap()
        .keep();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    for name in ["backend", "discovery", "browser"] {
        fs::create_dir(root.join(name)).unwrap();
        fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o700)).unwrap();
    }
    let hmux = root.join("unused-hmux");
    owner_file(&hmux, b"#!/bin/sh\nexit 1\n", 0o700);
    if let Some(installation) = installation {
        owner_file(
            &root.join("browser/installation.json"),
            installation.to_string().as_bytes(),
            0o600,
        );
    }
    let database = root.join("backend/application-state.sqlite3");
    let store = SqliteDomainStore::open(&database).await.unwrap();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: ProjectIdV1::new("project-browser").unwrap(),
            root_path: root.to_string_lossy().into(),
            display_name: "Browser fixture".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new("workspace-browser").unwrap(),
            project_id: ProjectIdV1::new("project-browser").unwrap(),
            root_path: root.to_string_lossy().into(),
            base_commit_sha: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store.close().await;
    fs::set_permissions(&database, fs::Permissions::from_mode(0o600)).unwrap();
    let (endpoint, server) = serve_fixture(&root, None).await;
    (root, endpoint, server)
}

async fn serve_fixture(
    root: &Path,
    expected_generation: Option<String>,
) -> (
    ControlPlaneEndpoint,
    tokio::task::JoinHandle<Result<(), dure_control_plane::ControlPlaneError>>,
) {
    let hmux = root.join("unused-hmux");
    let prepared = prepare_with_agent_conversation_runtimes(
        ServeOptions {
            home: root.to_owned(),
            hmux_bin: hmux.clone(),
            hmux_runtime_bin: hmux.clone(),
            hmux_discovery_root: root.join("discovery"),
            claude_structured_runtime: None,
            launch_executable: None,
            expected_generation,
            activation_source_generation: None,
            staged: false,
        },
        Arc::new(AgentConversationRuntimeRegistry::default()),
    )
    .await
    .unwrap();
    let (ready_tx, ready_rx) = oneshot::channel();
    let server = tokio::spawn(prepared.serve_with_publication(ready_tx));
    let endpoint = ready_rx.await.unwrap();
    owner_file(&root.join("backend-profiles.json"), json!({
        "schemaVersion":1,"kind":"dure.backend_profiles","profiles":[{
            "id":"browser-test","transport":{"kind":"local","endpoint":{"kind":"unix_socket","path":endpoint.socket_path}},
            "auth":{"kind":"peer"},"trust":{"kind":"local_peer"},
            "expected":{"backendId":endpoint.backend_id,"generation":endpoint.generation,
                "protocol":{"minimum":{"major":1,"minor":0},"maximum":{"major":1,"minor":0}},"capabilities":["browser.resource.v1","browser.query.v1","browser.wait.v1","browser.network.v1","browser.find.v1","browser.capture.v1","browser.files.v1","browser.tracing.v1"]},
            "deadlineMs":45000,
        }],
    }).to_string().as_bytes(), 0o600);

    (endpoint, server)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the pinned native engine, Chromium, and Node"]
async fn real_cli_uses_backend_host_and_durable_operation_journal() {
    let (root, endpoint, server) = fixture().await;
    let database = root.join("backend/application-state.sqlite3");
    let hmux = root.join("unused-hmux");
    let evidence: Result<_, String> = async {
        let created = cli(&root, &["create", "--workspace", "workspace-browser", "--idempotency-key", "create-browser-proof"]).await?;
        let resource = created["result"]["control"]["resource"]["resource_id"].as_str().ok_or_else(|| format!("create: {created}"))?;
        let replayed = cli(&root, &["create", "--workspace", "workspace-browser", "--idempotency-key", "create-browser-proof"]).await?;
        let listed = cli(&root, &["list", "--workspace", "workspace-browser"]).await?;
        let shown = cli(&root, &["show", resource]).await?;
        let page = shown["result"]["pages"][0]["page"]["page_id"].as_str().ok_or("page missing")?;
        queries::without_controller(&root, resource, page).await?;
        let controlled = cli(&root, &["control", resource, "--controller", "agent-proof"]).await?;
        let epoch = controlled["result"]["controller"]["epoch"].as_str().ok_or("epoch missing")?;
        let shared = ["--page", page, "--controller", "agent-proof", "--epoch", epoch];
        dialog::exercise(&root, resource, page, epoch, &endpoint).await?;
        let mut setup = vec!["eval", resource, "document.documentElement.style.background='white';document.body.style.color='black';document.body.innerHTML='<input aria-label=Plain id=plain><div contenteditable=true id=rich>Initial</div><button onclick=\"window.writes++\">Increment</button>';window.writes=0"];
        setup.extend(shared);
        cli(&root, &setup).await?;
        let mut fill = vec!["fill", resource, "#rich", "한글 CLI 검증"];
        fill.extend(shared);
        cli(&root, &fill).await?;
        let mut literal = vec!["fill", resource];
        literal.extend(shared);
        literal.extend(["--", "#plain", "--help"]);
        cli(&root, &literal).await?;
        let snapshot = cli(&root, &["snapshot", resource, "--page", page]).await?;
        let reference = snapshot["references"].as_object().ok_or_else(|| format!("refs: {snapshot}"))?.iter().find(|(_, entry)| entry["name"] == "Increment").ok_or("button missing")?.0;
        let mut click = vec!["click", resource, reference.as_str(), "--controller", "agent-proof", "--epoch", epoch, "--idempotency-key", "click-browser-proof"];
        let clicked = cli(&root, &click).await?;
        let duplicate = cli(&root, &click).await;
        click.clear();
        let mut read = vec!["eval", resource, "({plain:document.querySelector('#plain').value,rich:document.querySelector('#rich').textContent,writes:window.writes})"];
        read.extend(shared);
        let state = cli(&root, &read).await?;
        let current = cli(&root, &["show", resource]).await?;
        let control = &current["result"]["control"];
        let lost = envelope(&endpoint, "browser.resource", json!({
            "kind":"action","caller":"agent-proof",
            "authority":{"lease":control["controller"],"page":current["result"]["pages"][0]["page"],
                "operation_id":"lost-client-browser-proof","command_sequence":control["next_command_sequence"]},
            "action":{"kind":"evaluate","script":"new Promise(resolve=>setTimeout(()=>resolve(window.lostClientWrites=(window.lostClientWrites||0)+1),150))"},
        }));
        let mut disconnected = UnixStream::connect(&endpoint.socket_path).await.map_err(|error| error.to_string())?;
        disconnected.write_all(format!("{lost}\n").as_bytes()).await.map_err(|error| error.to_string())?;
        drop(disconnected);
        timeout(Duration::from_secs(15), async {
            loop {
                let receipt = cli(&root, &["receipt", "lost-client-browser-proof"]).await?;
                if receipt["receipt"]["state"] == "succeeded" { return Ok::<_, String>(()); }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.map_err(|_| "disconnected client's receipt did not complete".to_string())??;
        let mut read_loss = vec!["eval", resource, "window.lostClientWrites"];
        read_loss.extend(shared);
        let loss_effect = cli(&root, &read_loss).await?;
        let capture_path = root.join("capture.png");
        let capture = cli(&root, &["screenshot", resource, "--page", page, "--output", capture_path.to_str().unwrap()]).await?;
        let receipt = cli(&root, &["receipt", "click-browser-proof"]).await?;
        captures::exercise(&root, resource, page, epoch, &endpoint).await?;
        basic_actions::exercise(&root, resource, page, epoch).await?;
        finding::exercise(&root, resource, page, epoch).await?;
        queries::exercise(&root, resource, page, epoch, &endpoint).await?;
        files::exercise(&root, resource, page, epoch).await?;
        downloads::exercise(&root, resource, page, epoch, &endpoint).await?;
        data::exercise(&root, resource, page, epoch, &endpoint).await?;
        environment::exercise(&root, resource, page, epoch, &endpoint).await?;
        policy::exercise(&root, resource, page, epoch, &endpoint).await?;
        let keyboard_epoch = keyboard::exercise(&root, resource, page, epoch, &endpoint).await?;
        let mouse_epoch = mouse::exercise(&root, resource, page, &keyboard_epoch, &endpoint).await?;
        waiting::exercise(&root, resource, page, &mouse_epoch).await?;
        cli(&root, &["close", resource]).await?;
        captures::recover(&root).await?;
        downloads::recover(&root).await?;
        Ok((replayed, listed, clicked, duplicate, state, loss_effect, capture, receipt, capture_path))
    }.await;
    let stopped = backend(
        &endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    timeout(Duration::from_secs(40), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(stopped["kind"], "dure.backend.response");
    let (replayed, listed, clicked, duplicate, state, loss_effect, capture, receipt, capture_path) =
        evidence.unwrap();
    assert_eq!(replayed["replayed"], true);
    assert_eq!(listed["result"]["resources"].as_array().unwrap().len(), 1);
    assert_eq!(clicked["result"]["response"]["success"], true);
    assert!(
        duplicate
            .unwrap_err()
            .contains("browser_operation_conflict")
    );
    assert_eq!(
        state["result"]["response"]["data"]["result"]["rich"],
        "한글 CLI 검증"
    );
    assert_eq!(
        state["result"]["response"]["data"]["result"]["plain"],
        "--help"
    );
    assert_eq!(state["result"]["response"]["data"]["result"]["writes"], 1);
    assert_eq!(loss_effect["result"]["response"]["data"]["result"], 1);
    assert_eq!(capture["result"]["mimeType"], "image/png");
    assert_eq!(&fs::read(capture_path).unwrap()[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(receipt["receipt"]["state"], "succeeded");
    let reopened = SqliteDomainStore::open(&database).await.unwrap();
    let durable = reopened
        .operation_receipt(&OperationIdV1::new("click-browser-proof").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(durable.state.as_str(), "succeeded");
    reopened.close().await;
    let replacement = prepare_with_agent_conversation_runtimes(
        ServeOptions {
            home: root.clone(),
            hmux_bin: hmux.clone(),
            hmux_runtime_bin: hmux,
            hmux_discovery_root: root.join("discovery"),
            claude_structured_runtime: None,
            launch_executable: None,
            expected_generation: Some(endpoint.generation.clone()),
            activation_source_generation: None,
            staged: false,
        },
        Arc::new(AgentConversationRuntimeRegistry::default()),
    )
    .await
    .unwrap();
    let (replacement_tx, replacement_rx) = oneshot::channel();
    let replacement_server = tokio::spawn(replacement.serve_with_publication(replacement_tx));
    let replacement_endpoint = replacement_rx.await.unwrap();
    let mut profile: Value =
        serde_json::from_slice(&fs::read(root.join("backend-profiles.json")).unwrap()).unwrap();
    profile["profiles"][0]["transport"]["endpoint"]["path"] =
        json!(replacement_endpoint.socket_path);
    profile["profiles"][0]["expected"]["generation"] = json!(replacement_endpoint.generation);
    owner_file(
        &root.join("backend-profiles.json"),
        &serde_json::to_vec(&profile).unwrap(),
        0o600,
    );
    let recovered = captures::recover(&root).await;
    let recovered_downloads = downloads::recover(&root).await;
    backend(
        &replacement_endpoint,
        "backend.shutdown",
        json!({"schemaVersion":2,"mode":"stop"}),
    )
    .await;
    timeout(Duration::from_secs(40), replacement_server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    recovered.unwrap();
    recovered_downloads.unwrap();
    println!(
        "BROWSER_ARTIFACT_RESTART_EVIDENCE {}",
        json!({"root":root,"generation":replacement_endpoint.generation,"serviceReopened":true,"identicalArtifacts":8})
    );
    println!(
        "BROWSER_CLI_EVIDENCE {}",
        json!({"state":state,"receipt":receipt,"root":root})
    );
}
