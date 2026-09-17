use super::*;

fn request(id: u64, method: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":method,"params":{"uri":"memory://knowledge-graph"}})
}

fn response(id: u64) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":{}})
}

fn initialized() -> State {
    State {
        initialized: true,
        ..State::default()
    }
}

#[test]
fn pending_and_cancelled_calls_are_not_idle() {
    let mut state = initialized();
    assert!(state.can_retire());
    state.request(&request(1, "tools/call")).unwrap();
    assert!(!state.can_retire());
    state.notification(
        &json!({"method":"notifications/cancelled","params":{"requestId":1}}),
        true,
    );
    assert!(!state.can_retire());
    state.response(&response(1)).unwrap();
    assert!(state.can_retire());
}

#[test]
fn subscription_pins_until_its_successful_unsubscribe() {
    let mut state = initialized();
    state.request(&request(1, "resources/subscribe")).unwrap();
    assert!(!state.can_retire());
    state.response(&response(1)).unwrap();
    assert!(!state.can_retire());
    state.notification(&json!({"method":"notifications/resources/updated"}), false);
    assert!(!state.can_retire());
    state.request(&request(2, "resources/unsubscribe")).unwrap();
    assert!(!state.can_retire());
    state.response(&response(2)).unwrap();
    assert!(state.can_retire());
}

#[test]
fn overlapping_subscription_order_is_not_guessed() {
    let mut state = initialized();
    state.request(&request(1, "resources/subscribe")).unwrap();
    state.request(&request(2, "resources/unsubscribe")).unwrap();
    state.response(&response(1)).unwrap();
    state.response(&response(2)).unwrap();
    assert!(!state.can_retire());
}

#[test]
fn failed_unsubscribe_cannot_release_a_subscription() {
    let mut state = initialized();
    state.request(&request(1, "resources/subscribe")).unwrap();
    state.response(&response(1)).unwrap();
    state.request(&request(2, "resources/unsubscribe")).unwrap();
    state
        .response(&json!({"jsonrpc":"2.0","id":2,"error":{"code":-1,"message":"failed"}}))
        .unwrap();
    assert!(!state.can_retire());
}

#[test]
fn stateful_extensions_never_inherit_memory_restart_authority() {
    for method in ["logging/setLevel", "tasks/get", "future/stateful-method"] {
        let mut state = initialized();
        state.request(&request(1, method)).unwrap();
        state.response(&response(1)).unwrap();
        assert!(!state.can_retire());
    }
    let mut state = initialized();
    state.notification(&json!({"method":"notifications/tools/list_changed"}), false);
    assert!(!state.can_retire());
}

#[test]
fn no_retirement_before_initialization_or_on_ambiguous_responses() {
    let mut state = State::default();
    assert!(!state.can_retire());
    state.request(&request(1, "tools/call")).unwrap();
    assert!(state.response(&response(2)).is_err());
    assert!(
        state
            .response(&json!({"jsonrpc":"2.0","id":1,"result":{},"error":{}}))
            .is_err()
    );
    assert!(!state.can_retire());
    assert!(state.request(&request(1, "tools/call")).is_err());
}

#[test]
fn every_inflight_request_must_settle() {
    let mut state = initialized();
    state.request(&request(1, "tools/call")).unwrap();
    state.request(&request(2, "resources/read")).unwrap();
    state.response(&response(2)).unwrap();
    assert!(!state.can_retire());
    state.response(&response(1)).unwrap();
    assert!(state.can_retire());
}

#[test]
fn unknown_capabilities_fail_before_client_initialization() {
    for capabilities in [
        json!({"tools":{}}),
        json!({"tools":{"listChanged":true},"resources":{"listChanged":true,"subscribe":true},"tasks":{}}),
    ] {
        let mut state = State::default();
        state.request(&request(1, "initialize")).unwrap();
        assert!(state.response(&json!({"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"memory-server","version":"0.6.3"},"protocolVersion":"2025-11-25","capabilities":capabilities}})).is_err());
        assert!(!state.can_retire());
    }
}

#[test]
fn explicit_absolute_graph_path_is_required() {
    let root = std::env::temp_dir();
    let arguments = vec![
        "--node".into(),
        root.join("node").to_string_lossy().into_owned(),
        "--worker".into(),
        root.join("worker.js").to_string_lossy().into_owned(),
    ];
    assert!(Options::parse(arguments.clone().into_iter()).is_err());
    for value in ["graph.jsonl".into(), String::new()] {
        assert!(
            Options::parse(
                arguments
                    .clone()
                    .into_iter()
                    .chain(["--memory-file".into(), value])
            )
            .is_err()
        );
    }
    let valid: Vec<_> = arguments
        .into_iter()
        .chain([
            "--memory-file".into(),
            root.join("graph.jsonl").to_string_lossy().into_owned(),
        ])
        .collect();
    assert_eq!(
        Options::parse(valid.clone().into_iter()).unwrap().idle,
        Duration::from_millis(DEFAULT_IDLE_MS)
    );
    for extra in [
        ["--idle-ms", "0"],
        ["--idle-ms", "86400001"],
        ["--memory-file", "/another.jsonl"],
    ] {
        assert!(Options::parse(valid.clone().into_iter().chain(extra.map(str::to_owned))).is_err());
    }
}

#[test]
fn unrecognized_server_source_is_not_started() {
    let root = tempfile::tempdir().unwrap();
    let worker = root.path().join("other.js");
    std::fs::write(&worker, "unknown MCP worker").unwrap();
    let options = Options {
        node: root.path().join("nonexistent-node"),
        worker,
        memory_file: root.path().join("graph.jsonl"),
        idle: Duration::from_millis(1),
    };
    let error = options.spawn().err().unwrap();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
}
