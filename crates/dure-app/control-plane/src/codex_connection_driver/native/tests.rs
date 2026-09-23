use super::*;
use std::os::unix::process::ExitStatusExt;

fn readiness_child() -> (Child, tokio::process::ChildStdin) {
    let mut child = Command::new("/bin/cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap();
    (child, input)
}

#[tokio::test(start_paused = true)]
async fn upstream_readiness_connects_when_the_server_takes_six_seconds() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("server.sock");
    let (mut child, input) = readiness_child();
    let result = {
        let connection = connect_upstream(&path, &mut child);
        tokio::pin!(connection);
        assert!(futures_util::poll!(&mut connection).is_pending());
        tokio::time::advance(Duration::from_secs(6)).await;
        if let std::task::Poll::Ready(result) = futures_util::poll!(&mut connection) {
            result
        } else {
            let listener = bind_endpoint(&path).unwrap();
            tokio::time::advance(UPSTREAM_READY_INTERVAL).await;
            let (accepted, connected) = tokio::join!(
                async {
                    let (stream, _) = listener.accept().await.unwrap();
                    accept_async_with_config(stream, Some(websocket_configuration())).await
                },
                connection
            );
            accepted.unwrap();
            connected
        }
    };
    drop(input);
    child.wait().await.unwrap();
    result.expect("a server becoming ready after six seconds must still connect");
}

#[tokio::test(start_paused = true)]
async fn upstream_readiness_waits_while_a_live_server_backfills_its_session_history() {
    // Codex holds a 15-minute backfill lease while its first startup indexes
    // the rollout history. Stopping the server mid-backfill leaves that lease
    // running and blocks every Codex session sharing the account.
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("server.sock");
    let (mut child, input) = readiness_child();
    let result = {
        let connection = connect_upstream(&path, &mut child);
        tokio::pin!(connection);
        assert!(futures_util::poll!(&mut connection).is_pending());
        tokio::time::advance(Duration::from_secs(5 * 60)).await;
        if let std::task::Poll::Ready(result) = futures_util::poll!(&mut connection) {
            result
        } else {
            let listener = bind_endpoint(&path).unwrap();
            tokio::time::advance(UPSTREAM_READY_INTERVAL).await;
            let (accepted, connected) = tokio::join!(
                async {
                    let (stream, _) = listener.accept().await.unwrap();
                    accept_async_with_config(stream, Some(websocket_configuration())).await
                },
                connection
            );
            accepted.unwrap();
            connected
        }
    };
    drop(input);
    child.wait().await.unwrap();
    result.expect("a live server finishing its history backfill must still connect");
}

#[tokio::test]
async fn upstream_readiness_reports_a_server_that_exits_before_listening() {
    // Codex waiting on another process's backfill exits after its own 30
    // seconds; the long readiness ceiling must not hide that exit.
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("server.sock");
    let mut child = Command::new("/bin/sh")
        .args(["-c", "exit 1"])
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), connect_upstream(&path, &mut child))
        .await
        .expect("a server exit must end readiness without waiting for the ceiling");
    assert_eq!(result.unwrap_err().reason, "upstream_exited");
}

#[tokio::test(start_paused = true)]
async fn upstream_readiness_still_stops_waiting_after_the_backfill_lease() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("server.sock");
    let (mut child, input) = readiness_child();
    let (expired_early, result) = {
        let connection = connect_upstream(&path, &mut child);
        tokio::pin!(connection);
        assert!(futures_util::poll!(&mut connection).is_pending());
        tokio::time::advance(UPSTREAM_READY_TIMEOUT - Duration::from_secs(1)).await;
        if let std::task::Poll::Ready(result) = futures_util::poll!(&mut connection) {
            (true, result)
        } else {
            tokio::time::advance(Duration::from_secs(1)).await;
            let std::task::Poll::Ready(result) = futures_util::poll!(&mut connection) else {
                panic!("an absent endpoint must time out after the backfill lease");
            };
            (false, result)
        }
    };
    drop(input);
    child.wait().await.unwrap();
    assert!(
        !expired_early,
        "readiness must not time out before the backfill lease"
    );
    assert_eq!(result.unwrap_err().reason, "upstream_readiness_failed");
}

fn private_directory(mode: u32) -> tempfile::TempDir {
    // Under /tmp so a 64-hex socket name stays within the Unix path limit.
    let directory = tempfile::Builder::new().tempdir_in("/tmp").unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(mode)).unwrap();
    directory
}

#[tokio::test]
async fn upstream_readiness_follows_the_codex_rendezvous_alias_to_its_protected_socket() {
    // Codex 0.156 listens in its per-user daemon directory and publishes the
    // requested path as a symlink to that deterministic socket.
    let listen = private_directory(0o700);
    let daemon = private_directory(0o700);
    let alias = listen.path().join("server.sock");
    let physical = codex_protected_socket_path(&alias, daemon.path()).unwrap();
    let listener = bind_endpoint(&physical).unwrap();
    std::os::unix::fs::symlink(&physical, &alias).unwrap();
    let (mut child, input) = readiness_child();
    let (accepted, connected) = tokio::join!(
        async {
            let (stream, _) = listener.accept().await.unwrap();
            accept_async_with_config(stream, Some(websocket_configuration())).await
        },
        connect_upstream_in(&alias, &mut child, daemon.path())
    );
    accepted.unwrap();
    drop(input);
    child.wait().await.unwrap();
    connected.expect("the deterministic Codex alias must connect to its protected socket");
}

#[tokio::test]
async fn upstream_readiness_rejects_an_alias_to_any_other_socket() {
    let listen = private_directory(0o700);
    let daemon = private_directory(0o700);
    let elsewhere = private_directory(0o700);
    let alias = listen.path().join("server.sock");
    let other = elsewhere.path().join("other.sock");
    let _listener = bind_endpoint(&other).unwrap();
    std::os::unix::fs::symlink(&other, &alias).unwrap();
    let (mut child, input) = readiness_child();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        connect_upstream_in(&alias, &mut child, daemon.path()),
    )
    .await
    .expect("an untrusted alias must be refused before any handshake");
    drop(input);
    child.wait().await.unwrap();
    assert_eq!(result.unwrap_err().reason, "upstream_socket_unsafe");
}

#[tokio::test]
async fn upstream_readiness_rejects_an_alias_into_a_shared_daemon_directory() {
    let listen = private_directory(0o700);
    let daemon = private_directory(0o755);
    let alias = listen.path().join("server.sock");
    let physical = codex_protected_socket_path(&alias, daemon.path()).unwrap();
    let _listener = bind_endpoint(&physical).unwrap();
    std::os::unix::fs::symlink(&physical, &alias).unwrap();
    let (mut child, input) = readiness_child();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        connect_upstream_in(&alias, &mut child, daemon.path()),
    )
    .await
    .expect("an untrusted alias must be refused before any handshake");
    drop(input);
    child.wait().await.unwrap();
    assert_eq!(result.unwrap_err().reason, "upstream_socket_unsafe");
}

#[test]
fn native_tui_failure_is_not_reported_as_a_successful_exit() {
    assert!(tui_exited(Ok(std::process::ExitStatus::from_raw(0))).is_ok());
    assert!(tui_exited(Ok(std::process::ExitStatus::from_raw(256))).is_err());
}

fn options(arguments: &[&str]) -> Options {
    Options::parse(
        ["--runtime", "/fixture/runtime", "--", "/fixture/codex"]
            .into_iter()
            .chain(arguments.iter().copied())
            .map(OsString::from),
    )
    .unwrap()
}

#[test]
fn server_inherits_config_without_reinterpreting_the_native_prompt() {
    let arguments = [
        "-c",
        "notify=[]",
        "--enable",
        "hooks",
        "--config=model_provider=fixture",
        "--disable=web_search",
        "--",
        "--remote=opaque-prompt",
    ];
    let options = options(&arguments);
    assert_eq!(options.arguments, arguments.map(OsString::from));
    assert_eq!(
        options.server_arguments().unwrap(),
        arguments[..6]
            .iter()
            .map(OsString::from)
            .collect::<Vec<_>>()
    );
}

#[test]
fn private_native_endpoint_cannot_be_replaced_by_user_flags() {
    for argument in [
        "--remote",
        "--remote=unix://other",
        "--remote-auth-token-env",
        "--remote-auth-token-env=TOKEN",
    ] {
        assert_eq!(
            options(&[argument]).server_arguments().unwrap_err().reason,
            "native_endpoint_owned"
        );
    }
}

#[tokio::test]
async fn picker_connections_can_overlap_reopen_and_close_without_stopping_the_tui() {
    use tokio::io::AsyncReadExt;

    let directory = tempfile::tempdir().unwrap();
    let upstream_path = directory.path().join("server.sock");
    let listener = bind_endpoint(&upstream_path).unwrap();
    let echo_server = tokio::spawn(async move {
        let mut peers = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (stream, _) = accepted.unwrap();
                    peers.spawn(async move {
                        let mut socket = accept_async_with_config(stream, Some(websocket_configuration())).await.unwrap();
                        while let Some(Ok(message)) = socket.next().await {
                            if message.is_close() || socket.send(message).await.is_err() { break }
                        }
                    });
                }
                _ = peers.join_next(), if !peers.is_empty() => {}
            }
        }
    });
    // These direct children exit on stdin EOF; the test sends no process signals.
    let child = || {
        Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    };
    let mut server = child();
    let mut tui = child();
    let server_input = server.stdin.take().unwrap();
    let tui_input = tui.stdin.take().unwrap();
    let upstream = connect_upstream(&upstream_path, &mut server).await.unwrap();
    let endpoint = directory.path().join("client.sock");
    let listener = bind_endpoint(&endpoint).unwrap();
    let lifecycle = ManagedLifecycle {
        guidance: None,
        reporter: ManagedAgentStateReporter::new("/usr/bin/false", directory.path()),
        request: ManagedAttachRequest::new("fixture-session", "fixture-workspace").unwrap(),
        fence: SessionFence {
            session_id: "fixture-session".into(),
            workspace_id: "fixture-workspace".into(),
            runner_principal: "fixture".into(),
            runner_instance: "fixture-runner".into(),
            channel_epoch: 1,
            host_instance_id: "fixture-host".into(),
            terminal_epoch: "fixture-terminal".into(),
        },
        diagnostics: None,
        projection: Lifecycle::default(),
        recovery: None,
        recovery_changed: Arc::default(),
    };
    let driver = tokio::spawn(async move {
        let result = serve(
            listener,
            upstream_path,
            upstream,
            &mut server,
            &mut tui,
            lifecycle,
        )
        .await;
        drop(server_input);
        server.wait().await.unwrap();
        result
    });
    let interactions = async {
        let mut primary = open_upstream(&endpoint).await.unwrap();
        // A client that never upgrades cannot hold the accept loop hostage.
        let mut stalled = UnixStream::connect(&endpoint).await.unwrap();
        for index in 0..3 {
            let mut picker = open_upstream(&endpoint).await.unwrap();
            let primary_message = Message::Text(
                json!({"id": 0, "method": "fixture/echo", "params": "primary"})
                    .to_string()
                    .into(),
            );
            let picker_message = Message::Binary(
                json!({"id": 0, "method": "fixture/echo", "params": index})
                    .to_string()
                    .into_bytes()
                    .into(),
            );
            primary.send(primary_message.clone()).await.unwrap();
            picker.send(picker_message.clone()).await.unwrap();
            assert_eq!(picker.next().await.unwrap().unwrap(), picker_message);
            assert_eq!(primary.next().await.unwrap().unwrap(), primary_message);
            picker.close(None).await.unwrap();
        }
        // A temporary initial connection may also retire before the next client.
        primary.close(None).await.unwrap();
        let mut replacement = open_upstream(&endpoint).await.unwrap();
        let message = Message::Text(
            json!({"id": 0, "method": "fixture/echo"})
                .to_string()
                .into(),
        );
        replacement.send(message.clone()).await.unwrap();
        assert_eq!(replacement.next().await.unwrap().unwrap(), message);
        drop(tui_input);
        driver.await.unwrap().unwrap();
        assert_eq!(stalled.read(&mut [0]).await.unwrap(), 0);
        assert!(!matches!(replacement.next().await, Some(Ok(message)) if !message.is_close()));
    };
    let result = tokio::time::timeout(Duration::from_secs(5), interactions).await;
    echo_server.abort();
    let _ = echo_server.await;
    result.expect("picker connections must remain responsive");
}

fn thread_request(method: &str, params: serde_json::Value) -> Value {
    json!({"id": 7, "method": method, "params": params})
}

#[test]
fn thread_start_receives_the_checkout_guidance() {
    let mut payload = thread_request("thread/start", json!({"cwd": "/work"}));
    assert!(inject_thread_developer_guidance(&mut payload, "keep main"));
    assert_eq!(payload["params"]["developerInstructions"], "keep main");
    assert_eq!(payload["params"]["cwd"], "/work");
}

#[test]
fn thread_resume_receives_the_checkout_guidance() {
    let mut payload = thread_request("thread/resume", json!({"threadId": "t-1"}));
    assert!(inject_thread_developer_guidance(&mut payload, "keep main"));
    assert_eq!(payload["params"]["developerInstructions"], "keep main");
}

#[test]
fn existing_developer_instructions_are_kept_ahead_of_guidance() {
    let mut payload = thread_request(
        "thread/start",
        json!({"developerInstructions": "user rules"}),
    );
    assert!(inject_thread_developer_guidance(&mut payload, "keep main"));
    assert_eq!(
        payload["params"]["developerInstructions"],
        "user rules\n\nkeep main"
    );
}

#[test]
fn ephemeral_and_system_threads_keep_their_payload() {
    for params in [
        json!({"ephemeral": true}),
        json!({"threadSource": "system"}),
    ] {
        let mut payload = thread_request("thread/start", params.clone());
        assert!(!inject_thread_developer_guidance(&mut payload, "keep main"));
        assert_eq!(payload["params"], params);
    }
}

#[test]
fn other_methods_and_shapeless_requests_keep_their_payload() {
    for mut payload in [
        thread_request("turn/start", json!({"threadId": "t-1"})),
        json!({"id": 7, "method": "thread/start"}),
        json!({"id": 7, "method": "thread/start", "params": ["cwd"]}),
    ] {
        let before = payload.clone();
        assert!(!inject_thread_developer_guidance(&mut payload, "keep main"));
        assert_eq!(payload, before);
    }
}

#[tokio::test]
async fn relay_forwards_thread_start_with_the_checkout_guidance() {
    let directory = tempfile::tempdir().unwrap();
    let upstream_path = directory.path().join("server.sock");
    let listener = bind_endpoint(&upstream_path).unwrap();
    let echo_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_async_with_config(stream, Some(websocket_configuration()))
            .await
            .unwrap();
        while let Some(Ok(message)) = socket.next().await {
            if message.is_close() || socket.send(message).await.is_err() {
                break;
            }
        }
    });
    let child = || {
        Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    };
    let mut server = child();
    let mut tui = child();
    let server_input = server.stdin.take().unwrap();
    let tui_input = tui.stdin.take().unwrap();
    let upstream = connect_upstream(&upstream_path, &mut server).await.unwrap();
    let endpoint = directory.path().join("client.sock");
    let listener = bind_endpoint(&endpoint).unwrap();
    let lifecycle = ManagedLifecycle {
        guidance: Some("keep main".into()),
        reporter: ManagedAgentStateReporter::new("/usr/bin/false", directory.path()),
        request: ManagedAttachRequest::new("fixture-session", "fixture-workspace").unwrap(),
        fence: SessionFence {
            session_id: "fixture-session".into(),
            workspace_id: "fixture-workspace".into(),
            runner_principal: "fixture".into(),
            runner_instance: "fixture-runner".into(),
            channel_epoch: 1,
            host_instance_id: "fixture-host".into(),
            terminal_epoch: "fixture-terminal".into(),
        },
        diagnostics: None,
        projection: Lifecycle::default(),
        recovery: None,
        recovery_changed: Arc::default(),
    };
    let driver = tokio::spawn(async move {
        let result = serve(
            listener,
            upstream_path,
            upstream,
            &mut server,
            &mut tui,
            lifecycle,
        )
        .await;
        drop(server_input);
        server.wait().await.unwrap();
        result
    });
    let interactions = async {
        let mut client = open_upstream(&endpoint).await.unwrap();
        client
            .send(Message::Text(
                json!({"id": 0, "method": "thread/start", "params": {"cwd": "/work"}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let echoed = message_json(client.next().await.unwrap().unwrap()).unwrap();
        assert_eq!(echoed["params"]["developerInstructions"], "keep main");
        assert_eq!(echoed["params"]["cwd"], "/work");
        // Requests outside a thread selection keep their exact payload.
        let passthrough = json!({"id": 1, "method": "thread/start",
            "params": {"ephemeral": true}});
        client
            .send(Message::Text(passthrough.to_string().into()))
            .await
            .unwrap();
        assert_eq!(
            message_json(client.next().await.unwrap().unwrap()).unwrap(),
            passthrough
        );
        drop(tui_input);
        driver.await.unwrap().unwrap();
    };
    tokio::time::timeout(Duration::from_secs(5), interactions)
        .await
        .unwrap();
    echo_server.abort();
    let _ = echo_server.await;
}
