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
async fn upstream_readiness_still_stops_waiting_after_ten_seconds() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("server.sock");
    let (mut child, input) = readiness_child();
    let (expired_early, result) = {
        let connection = connect_upstream(&path, &mut child);
        tokio::pin!(connection);
        assert!(futures_util::poll!(&mut connection).is_pending());
        tokio::time::advance(Duration::from_secs(9)).await;
        if let std::task::Poll::Ready(result) = futures_util::poll!(&mut connection) {
            (true, result)
        } else {
            tokio::time::advance(Duration::from_secs(1)).await;
            let std::task::Poll::Ready(result) = futures_util::poll!(&mut connection) else {
                panic!("an absent endpoint must time out after ten seconds");
            };
            (false, result)
        }
    };
    drop(input);
    child.wait().await.unwrap();
    assert!(
        !expired_early,
        "readiness must not time out before ten seconds"
    );
    assert_eq!(result.unwrap_err().reason, "upstream_readiness_failed");
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
