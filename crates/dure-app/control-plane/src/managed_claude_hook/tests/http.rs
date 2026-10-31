use super::*;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    task::JoinHandle,
};

type RecordedPosts = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

struct Server {
    port: u16,
    posts: RecordedPosts,
    task: JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn server(ping: Value, post_status: u16) -> Server {
    server_replying(ping, post_status, Duration::ZERO, "{}").await
}

/// Like the app server, a POST reply can wait for the Host before it answers.
async fn server_replying(
    ping: Value,
    post_status: u16,
    post_delay: Duration,
    post_body: &'static str,
) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let posts = Arc::new(Mutex::new(Vec::new()));
    let received = posts.clone();
    let task = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                if stream.read_line(&mut line).await.unwrap() == 0 {
                    break;
                }
                headers.push_str(&line);
                if line == "\r\n" {
                    break;
                }
                assert!(headers.len() < 16_384);
            }
            let size = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::parse::<usize>)
                })
                .transpose()
                .unwrap()
                .unwrap_or(0);
            assert!(size <= MAX_BODY_BYTES);
            let mut body = vec![0; size];
            stream.read_exact(&mut body).await.unwrap();
            let (status, response) = if headers.starts_with("POST /hooks/claude ") {
                received.lock().unwrap().push((headers, body));
                tokio::time::sleep(post_delay).await;
                (post_status, post_body.to_string())
            } else {
                (200, ping.to_string())
            };
            let response = format!(
                "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    Server { port, posts, task }
}

fn ping() -> Value {
    serde_json::json!({ "ok": true, "channel": "stable", "generation": "fixture-generation", "processId": 1, "capabilities": [CAPABILITY] })
}

fn publish(root: &std::path::Path, port: u16) {
    let descriptor = serde_json::json!({ "channel": "stable", "port": port, "processId": 1, "generation": "fixture-generation", "reportToken": "fixture-token" });
    let path = root.join("server.json");
    std::fs::write(&path, descriptor.to_string()).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

async fn send(
    root: &std::path::Path,
    event: &str,
    epoch: &str,
    writable: bool,
) -> Result<(), HookFailure> {
    let mut env = environment();
    env.insert("HMUX_TERMINAL_EPOCH".into(), epoch.into());
    let input = serde_json::json!({"hook_event_name":event, "session_id":"conversation", "prompt":"fixture-prompt"});
    let root = descriptor::AppRoot {
        path: root.into(),
        writable,
    };
    let mut headers = fence_headers(&env).unwrap();
    headers.insert(
        SOURCE_SEQUENCE_HEADER,
        HeaderValue::from_static("123456789"),
    );
    deliver(
        root,
        headers,
        serde_json::to_vec(&input).unwrap(),
        Instant::now() + TOTAL_TIMEOUT,
    )
    .await
}

#[tokio::test]
async fn exact_delivery_preserves_prompt_and_only_coalesces_tool_reports_in_one_generation() {
    let server = server(ping(), 200).await;
    let root = tempfile::tempdir().unwrap();
    publish(root.path(), server.port);
    for event in [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PreToolUse",
        "Stop",
    ] {
        send(root.path(), event, "epoch-1", true).await.unwrap();
    }
    send(root.path(), "PreToolUse", "epoch-2", true)
        .await
        .unwrap();
    let posts = server.posts.lock().unwrap();
    let events: Vec<Value> = posts
        .iter()
        .map(|(_, body)| serde_json::from_slice(body).unwrap())
        .collect();
    assert_eq!(
        events
            .iter()
            .map(|event| event["hook_event_name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "Stop",
            "PreToolUse"
        ]
    );
    assert_eq!(events[1]["prompt"], "fixture-prompt");
    for (headers, _) in posts.iter() {
        assert!(headers.contains("x-hebbian-hmux-source-sequence: 123456789\r\n"));
        assert!(headers.contains("authorization: Bearer fixture-token\r\n"));
        for (key, value) in fence_headers(&environment()).unwrap().iter() {
            if key != "x-hebbian-hmux-terminal-epoch" {
                assert!(headers.contains(&format!("{}: {}\r\n", key, value.to_str().unwrap())));
            }
        }
    }
}

#[tokio::test]
async fn refused_delivery_and_legacy_read_only_discovery_do_not_suppress_the_next_report() {
    let root = tempfile::tempdir().unwrap();
    let refused = server(ping(), 503).await;
    publish(root.path(), refused.port);
    assert_eq!(
        send(root.path(), "PreToolUse", "epoch-1", true).await,
        Err(HookFailure::Unavailable)
    );
    assert!(!root.path().join("hook-throttle").exists());
    let ready = server(ping(), 200).await;
    publish(root.path(), ready.port);
    for _ in 0..2 {
        send(root.path(), "PreToolUse", "epoch-1", false)
            .await
            .unwrap();
    }
    assert_eq!(ready.posts.lock().unwrap().len(), 2);
    assert!(!root.path().join("hook-throttle").exists());
}

#[tokio::test]
async fn authenticates_the_selected_generation_and_capability_before_posting() {
    for (field, wrong) in [
        ("generation", "stale".into()),
        ("channel", "other".into()),
        ("processId", 2.into()),
        ("capabilities", serde_json::json!([])),
        (
            "capabilities",
            serde_json::json!(["managed_claude_host_report_v1"]),
        ),
        ("ok", false.into()),
    ] {
        let mut response = ping();
        response[field] = wrong;
        let server = server(response, 200).await;
        let root = tempfile::tempdir().unwrap();
        publish(root.path(), server.port);
        assert_eq!(
            send(root.path(), "SessionStart", "epoch-1", true).await,
            Err(HookFailure::Unavailable)
        );
        assert!(server.posts.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn waits_for_the_app_servers_accepted_reply_after_a_slow_host_report() {
    // The app answers 202 once its Host report has not finished within 1.5 s
    // (`dispatch_claude_hook_request`). A hook that stops waiting at that same
    // instant reports a delivered prompt as unavailable.
    let server = server_replying(
        ping(),
        202,
        Duration::from_millis(1_700),
        r#"{"ok":true,"accepted":true}"#,
    )
    .await;
    let root = tempfile::tempdir().unwrap();
    publish(root.path(), server.port);
    assert_eq!(
        send(root.path(), "UserPromptSubmit", "epoch-1", true).await,
        Ok(())
    );
    assert_eq!(server.posts.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_report_the_app_never_answers_still_ends_within_the_hook_budget() {
    let server = server_replying(ping(), 202, Duration::from_secs(30), "{}").await;
    let root = tempfile::tempdir().unwrap();
    publish(root.path(), server.port);
    let started = Instant::now();
    let delivered = tokio::time::timeout_at(
        tokio::time::Instant::from_std(started + TOTAL_TIMEOUT),
        send(root.path(), "UserPromptSubmit", "epoch-1", true),
    )
    .await;
    assert!(
        matches!(
            delivered,
            Err(_) | Ok(Err(HookFailure::Unavailable | HookFailure::Timeout))
        ),
        "{delivered:?}"
    );
    assert!(started.elapsed() < TOTAL_TIMEOUT + Duration::from_millis(250));
}

#[test]
fn names_only_an_identifier_reason_from_a_refused_report() {
    assert_eq!(
        rejection_code(br#"{"ok":false,"error":{"code":"hmux_runtime_unavailable","message":"/private/path"}}"#),
        Some("hmux_runtime_unavailable".into())
    );
    for body in [
        &br#"{"ok":false,"error":{"code":"has spaces /private/path"}}"#[..],
        br#"{"ok":false,"error":{"message":"no code"}}"#,
        br#"{"ok":false,"error":"flat"}"#,
        b"not json",
    ] {
        assert_eq!(rejection_code(body), None);
    }
}
