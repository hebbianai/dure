use std::os::unix::fs::PermissionsExt;

use tempfile::TempDir;

use super::*;

#[tokio::test]
async fn native_share_forwards_exact_conversation_to_the_owned_connector() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (_root, service) = fixture();
    service.load().await.unwrap();
    let directory = ensure_owner_subdirectory(&service.root, "T1").unwrap();
    let request = json!({ "schemaVersion": 1, "kind": "share", "teamId": "T1",
        "requestId": "native-share-1", "agentId": "agent-1", "channelId": "C1",
        "interactionSessionId": "conversation-1" });
    assert!(service.dispatch(&request).await.is_err());
    for rejected in [false, true] {
        let mut request = request.clone();
        if rejected {
            request["backend"] = json!("worker-two");
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        private_record::write(
            &directory.join("config.json.connector.json"),
            &json!({
                "schemaVersion": 1, "kind": "dure.slack.connector", "teamId": "T1",
                "port": listener.local_addr().unwrap().port(), "token": "private-fixture-capability"
            }),
        )
        .unwrap();
        let receiver = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let body = loop {
                let mut buffer = [0; 4096];
                let read = socket.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&buffer[..read]);
                let source = String::from_utf8_lossy(&bytes);
                if let Some((headers, body)) = source.split_once("\r\n\r\n") {
                    assert!(headers.starts_with("POST /slack/share HTTP/1.1"));
                    assert!(headers.contains("authorization: Bearer private-fixture-capability"));
                    assert!(!headers.contains("origin:"));
                    if let Ok(body) = serde_json::from_str::<Value>(body) {
                        break body;
                    }
                }
            };
            let response = if rejected {
                json!({ "ok": false, "error": { "code": "slack_share_conversation_changed", "message": "private detail" } })
            } else {
                json!({ "ok": true, "result": { "state": "succeeded", "teamId": "T1",
                    "channelId": "C1", "threadTs": "200.001", "agentId": "agent-1",
                    "interactionSessionId": "conversation-1" } })
            }.to_string();
            let status = if rejected {
                "400 Bad Request"
            } else {
                "200 OK"
            };
            socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
            body
        });
        let result = service.dispatch(&request).await;
        if rejected {
            assert!(result.is_err());
            assert_eq!(result.unwrap_err().code, "slack_share_conversation_changed");
        } else {
            let result = result.unwrap();
            assert_eq!(result["schemaVersion"], 1);
            assert_eq!(result["share"]["interactionSessionId"], "conversation-1");
            assert!(!result.to_string().contains("private-fixture-capability"));
        }
        let mut expected = request.clone();
        expected.as_object_mut().unwrap().remove("kind");
        assert_eq!(receiver.await.unwrap(), expected);
    }
    let mut invalid = request;
    invalid["teamId"] = json!("../T1");
    assert!(service.dispatch(&invalid).await.is_err());
}

fn fixture() -> (TempDir, SlackConnectorService) {
    let root = tempfile::tempdir().unwrap();
    let backend = root.path().join("backend");
    std::fs::create_dir(&backend).unwrap();
    std::fs::set_permissions(&backend, std::fs::Permissions::from_mode(0o700)).unwrap();
    let cli = root.path().join("dure.mjs");
    std::fs::write(
        &cli,
        r#"#!/bin/sh
mkdir running || exit 8
trap 'rmdir running' EXIT
if [ "$DURE_SLACK_APP_TOKEN" = reject ]; then
  printf '%s\n' '{"event":"slack.failed","code":"slack_invalid_auth"}'
  exit 2
fi
if [ "$DURE_SLACK_APP_TOKEN" = report-failure ] && [ ! -f reported ]; then
  touch reported
  printf '%s\n' '{"event":"slack.failed","code":"slack_invalid_auth"}'
  cat > /dev/null
  exit 2
fi
printf '%s' "$DURE_SLACK_BOT_TOKEN" > received-token.fixture
printf '%s\n' '{"event":"slack.connected"}'
cat > /dev/null
cp settings.json retired-settings.fixture
printf '%s\n' '{"event":"slack.stopped"}'
"#,
    )
    .unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    let hmux = HmuxToolchainIdentity {
        executable_path: root.path().join("hmux"),
        executable_device: "1".into(),
        executable_inode: "1".into(),
        executable_size: "1".into(),
        executable_modified: "1".into(),
        executable_sha256: "0".repeat(64),
        runtime_executable_path: root.path().join("hmux-runtime"),
        runtime_executable_device: "1".into(),
        runtime_executable_inode: "2".into(),
        runtime_executable_size: "1".into(),
        runtime_executable_modified: "1".into(),
        runtime_executable_sha256: "0".repeat(64),
        discovery_root: root.path().join("discovery"),
        discovery_device: "1".into(),
        discovery_inode: "3".into(),
    };
    let service = SlackConnectorService::new(&backend, root.path(), cli, hmux);
    (root, service)
}

fn connect(team: &str) -> Value {
    json!({ "schemaVersion": 1, "kind": "connect",
        "config": { "schemaVersion": 1, "teamId": team, "channels": [] },
        "appToken": "fixture-app", "botToken": "fixture-bot" })
}

async fn observed(service: &SlackConnectorService, team: &str, state: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = service.snapshot().await;
            if let Some(view) = snapshot["connections"]
                .as_array()
                .unwrap()
                .iter()
                .find(|view| view["config"]["teamId"] == team && view["connection"] == state)
            {
                return view.clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("connector observation timed out")
}

#[tokio::test]
async fn native_connection_owns_one_child_and_keeps_credentials_private() {
    let (_root, service) = fixture();
    let request = connect("T1");
    let (left, right) = tokio::join!(service.dispatch(&request), service.dispatch(&request));
    left.unwrap();
    right.unwrap();
    let connected = observed(&service, "T1", "connected").await;
    let again = service.dispatch(&request).await.unwrap();
    assert_eq!(
        again["connections"][0]["generation"],
        connected["generation"]
    );
    assert_eq!(connected["credentialsConfigured"], true);
    assert!(!connected.to_string().contains("fixture-app"));
    assert!(!connected.to_string().contains("fixture-bot"));
    let directory = service.root.join("T1");
    let saved = directory.join("settings.json");
    assert_eq!(
        std::fs::metadata(saved).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        !std::fs::read_to_string(directory.join("config.json"))
            .unwrap()
            .contains("fixture-bot")
    );
    assert_eq!(
        std::fs::read_to_string(directory.join("received-token.fixture")).unwrap(),
        "fixture-bot"
    );
    let mut changed = request.clone();
    changed.as_object_mut().unwrap().remove("appToken");
    changed.as_object_mut().unwrap().remove("botToken");
    changed["config"]["channels"] = json!([{ "channelId": "C1", "projectId": "project-team",
        "providerId": "claude", "backend": "worker-two", "objective": "Keep the release moving" }]);
    service.dispatch(&changed).await.unwrap();
    let updated = observed(&service, "T1", "connected").await;
    assert_ne!(updated["generation"], connected["generation"]);
    assert_eq!(updated["config"]["channels"][0]["backend"], "worker-two");
    let retired: Value =
        serde_json::from_slice(&std::fs::read(directory.join("retired-settings.fixture")).unwrap())
            .unwrap();
    assert_eq!(
        retired["config"], changed["config"],
        "replacement inputs must survive retirement of the old child"
    );
    assert_eq!(
        std::fs::read_to_string(directory.join("received-token.fixture")).unwrap(),
        "fixture-bot"
    );
    service
        .dispatch(&json!({ "schemaVersion": 1, "kind": "disconnect", "teamId": "T1" }))
        .await
        .unwrap();
    let disconnected = observed(&service, "T1", "stopped").await;
    assert_eq!(disconnected["enabled"], false);
    assert!(
        !directory.join("running").exists(),
        "old child must finish before its owner reports stopped"
    );
    service.restore().await.unwrap();
    assert_eq!(
        observed(&service, "T1", "stopped").await["generation"],
        updated["generation"]
    );
}

#[tokio::test]
async fn explicit_connect_retires_a_failed_child_before_starting_again() {
    let (_root, service) = fixture();
    let mut request = connect("T1");
    request["appToken"] = json!("report-failure");
    service.dispatch(&request).await.unwrap();
    let failed = observed(&service, "T1", "failed").await;
    let retried = service.dispatch(&request).await.unwrap();
    assert_ne!(
        failed["generation"],
        retried["connections"][0]["generation"]
    );
    observed(&service, "T1", "connected").await;
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn backend_retirement_preserves_enabled_connections_for_the_next_owner() {
    let (root, service) = fixture();
    service.dispatch(&connect("T1")).await.unwrap();
    service.dispatch(&connect("T2")).await.unwrap();
    let first = observed(&service, "T1", "connected").await;
    observed(&service, "T2", "connected").await;
    service.shutdown().await.unwrap();
    assert_eq!(observed(&service, "T1", "stopped").await["enabled"], true);
    assert!(!service.root.join("T1/running").exists());
    assert!(!service.root.join("T2/running").exists());
    let next = SlackConnectorService::new(
        &root.path().join("backend"),
        root.path(),
        service.cli.clone(),
        service.hmux.clone(),
    );
    next.restore().await.unwrap();
    let resumed = observed(&next, "T1", "connected").await;
    assert_ne!(first["generation"], resumed["generation"]);
    observed(&next, "T2", "connected").await;
    next.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_connections_stay_failed_across_backend_restart_until_explicit_connect() {
    let (root, service) = fixture();
    let mut request = connect("T1");
    request["appToken"] = json!("reject");
    service.dispatch(&request).await.unwrap();
    observed(&service, "T1", "failed").await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while service.connections.lock().await.entries["T1"]
            .running
            .is_some()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let failed = observed(&service, "T1", "failed").await;
    assert_eq!(failed["failure"], "slack_invalid_auth");
    assert_eq!(failed["enabled"], false);
    let next = SlackConnectorService::new(
        &root.path().join("backend"),
        root.path(),
        service.cli.clone(),
        service.hmux.clone(),
    );
    next.restore().await.unwrap();
    let retained = observed(&next, "T1", "failed").await;
    assert_eq!(retained["failure"], "slack_invalid_auth");
    assert_eq!(
        retained["generation"],
        Value::Null,
        "restoration must not launch a failed connector"
    );
    next.dispatch(&connect("T1")).await.unwrap();
    observed(&next, "T1", "connected").await;
    next.shutdown().await.unwrap();
}

#[tokio::test]
async fn actual_launch_failure_is_persisted_without_a_preflight_or_respawn() {
    let (_root, mut service) = fixture();
    service.cli = service.cli.with_file_name("not-installed");
    let response = service.dispatch(&connect("T1")).await.unwrap();
    assert_eq!(response["connections"][0]["connection"], "failed");
    assert_eq!(
        response["connections"][0]["failure"],
        "slack_connector_launch_failed"
    );
    service.restore().await.unwrap();
    assert_eq!(service.snapshot().await, response);
}
