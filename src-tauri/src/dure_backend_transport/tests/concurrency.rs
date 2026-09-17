use super::*;
use tokio::sync::{oneshot, Notify};
use tokio::task::JoinSet;

async fn independent_request_progress(operation: &'static str, ssh: bool) {
    let temporary = tempfile::Builder::new()
        .prefix("dure-independent-request-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = temporary.path();
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let socket = root.join("backend.sock");
    let mut profile = local_profile(&socket);
    profile["expected"]["capabilities"]
        .as_array_mut()
        .unwrap()
        .push(json!("browser.resource.v1"));
    let config = if ssh {
        profile["transport"] = json!({
            "kind": "ssh", "host": "build.example.test", "port": 22,
            "user": "dure_runner",
            "endpoint": { "kind": "unix_socket", "path": socket }
        });
        profile["auth"] = json!({ "kind": "ssh_agent" });
        profile["trust"] = json!({
            "kind": "known_hosts", "reference": "known-hosts-profile:local"
        });
        profile["expected"]["capabilities"]
            .as_array_mut()
            .unwrap()
            .push(json!(SSH_GATEWAY_CAPABILITY));
        let known_hosts = root.join("known-hosts");
        write_owner_file(&known_hosts, b"disposable fixture\n", false);
        let bridge = root.join("ssh-fixture");
        write_owner_file(
            &bridge,
            format!(
                r#"#!/usr/bin/env python3
import socket, sys
with socket.socket(socket.AF_UNIX) as peer:
    peer.connect({socket:?})
    with peer.makefile('rb') as responses:
        for request in sys.stdin.buffer:
            peer.sendall(request)
            response = responses.readline()
            if not response:
                break
            sys.stdout.buffer.write(response)
            sys.stdout.buffer.flush()
"#,
                socket = socket.to_str().unwrap(),
            )
            .as_bytes(),
            true,
        );
        RuntimeConfig {
            ssh_command: bridge,
            profile_selector_override: Some("local".into()),
            ssh_reference_profile_override: Some("local".into()),
            known_hosts_override: Some(known_hosts),
            identity_override: None,
        }
    } else {
        RuntimeConfig::default()
    };
    write_catalog(root, profile);
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let release = Arc::new(Notify::new());
    let (entered, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let (closed, mut closed_connections) = tokio::sync::mpsc::unbounded_channel();
    let (stop, mut stopped) = oneshot::channel();
    let held = Arc::clone(&release);
    let server = tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            let stream = tokio::select! {
                _ = &mut stopped => break,
                accepted = listener.accept() => accepted.unwrap().0,
            };
            let held = Arc::clone(&held);
            let entered = entered.clone();
            let closed = closed.clone();
            connections.spawn(async move {
                let mut stream = BufReader::new(stream);
                let mut was_held = false;
                loop {
                    let mut line = String::new();
                    if stream.read_line(&mut line).await.unwrap() == 0 {
                        break;
                    }
                    let request: Value = serde_json::from_str(&line).unwrap();
                    assert_eq!(request["connection"]["mode"], "persistent_v1");
                    if request["body"]["held"] == true {
                        was_held = true;
                        entered.send(()).unwrap();
                        held.notified().await;
                    }
                    let mut response: Value = serde_json::from_slice(&response_for(
                        &request,
                        "dure-local",
                        "local-v1-11111111111111111111111111111111",
                    ))
                    .unwrap();
                    response["backend"]["capabilities"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!("browser.resource.v1"));
                    if ssh {
                        response["backend"]["capabilities"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!(SSH_GATEWAY_CAPABILITY));
                    }
                    response["result"]["held"] = request["body"]["held"].clone();
                    stream
                        .get_mut()
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .unwrap();
                }
                closed.send(was_held).unwrap();
            });
        }
        while let Some(result) = connections.join_next().await {
            result.unwrap();
        }
    });
    let state = Arc::new(DureBackendTransportState {
        config,
        ..DureBackendTransportState::default()
    });
    let slow_state = Arc::clone(&state);
    let slow_root = root.to_path_buf();
    let slow = tokio::spawn(async move {
        slow_state
            .request(
                &slow_root,
                &selected_route("local"),
                operation,
                json!({ "held": true }),
            )
            .await
    });
    let admitted = tokio::time::timeout(Duration::from_secs(1), observed.recv()).await;
    let independent = tokio::time::timeout(
        Duration::from_millis(500),
        state.request(
            root,
            &selected_route("local"),
            operation,
            json!({ "held": false }),
        ),
    )
    .await;
    let concurrent_ssh_closed = if ssh {
        tokio::time::timeout(Duration::from_millis(500), closed_connections.recv())
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    release.notify_one();
    let slow_result = slow.await.unwrap();
    state.close().await;
    stop.send(()).unwrap();
    server.await.unwrap();

    assert_eq!(admitted.unwrap(), Some(()));
    assert_eq!(slow_result.unwrap().result["held"], true);
    assert_eq!(
        independent
            .expect("an independent request must finish before the held response is released")
            .unwrap()
            .result["held"],
        false
    );
    if ssh {
        assert_eq!(
            concurrent_ssh_closed,
            Some(false),
            "the concurrent SSH exchange must close before the cached request completes"
        );
    }
}

#[tokio::test]
async fn browser_control_can_progress_while_a_browser_observation_waits() {
    independent_request_progress("browser.resource", false).await;
}

#[tokio::test]
async fn client_view_read_can_progress_while_another_view_waits() {
    independent_request_progress("client_view.authority.read", false).await;
}

#[tokio::test]
async fn concurrent_ssh_exchange_closes_without_interrupting_the_cached_request() {
    independent_request_progress("client_view.authority.read", true).await;
}
