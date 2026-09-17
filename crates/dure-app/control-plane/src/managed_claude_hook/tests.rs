use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

mod http;

#[test]
fn source_sequence_shares_the_direct_python_hook_clock() {
    let before = source_sequence().unwrap();
    let output = std::process::Command::new("python3")
        .args([
            "-c",
            "import time; print(time.clock_gettime_ns(time.CLOCK_MONOTONIC))",
        ])
        .output()
        .unwrap();
    let after = source_sequence().unwrap();
    assert!(output.status.success());
    let python = std::str::from_utf8(&output.stdout)
        .unwrap()
        .trim()
        .parse::<u64>()
        .unwrap();
    assert!(
        before <= python && python <= after,
        "{before} <= {python} <= {after}"
    );
}

pub(super) fn environment() -> BTreeMap<String, String> {
    FENCE_HEADERS
        .iter()
        .map(|(_, key)| {
            (
                (*key).into(),
                if *key == "HMUX_CHANNEL_EPOCH" {
                    "1"
                } else {
                    "fixture-id"
                }
                .into(),
            )
        })
        .collect()
}

#[test]
fn requires_all_exact_fence_fields_before_reporting() {
    let original = environment();
    assert_eq!(fence_headers(&original).unwrap().len(), 7);
    for (_, variable) in FENCE_HEADERS {
        let mut missing = original.clone();
        missing.remove(variable);
        assert_eq!(fence_headers(&missing), Err(HookFailure::InvalidFence));
    }
    for epoch in ["0", "-1", "+1", "18446744073709551616"] {
        let mut invalid = original.clone();
        invalid.insert("HMUX_CHANNEL_EPOCH".into(), epoch.into());
        assert_eq!(fence_headers(&invalid), Err(HookFailure::InvalidFence));
    }
}

#[test]
fn carries_normal_input_exactly_and_bounds_large_tool_payloads() {
    let ordinary = br#"{ "hook_event_name": "SessionStart", "session_id": "fixture" }"#.to_vec();
    assert_eq!(bounded_body(ordinary.clone()).unwrap().body, ordinary);
    let oversized = serde_json::json!({
        "hook_event_name": "PreToolUse", "session_id": "fixture", "prompt_id": "prompt-id",
        "tool_name": "Write", "tool_input": { "content": "x".repeat(MAX_BODY_BYTES) },
        "prompt": "x".repeat(5_000),
        "transcript_path": "/fixture/conversation.jsonl",
    });
    let body = bounded_body(serde_json::to_vec(&oversized).unwrap()).unwrap();
    let body: Value = serde_json::from_slice(&body.body).unwrap();
    assert_eq!(body["hook_event_name"], "PreToolUse");
    assert_eq!(body["prompt_id"], "prompt-id");
    assert_eq!(body["prompt"].as_str().unwrap().len(), 4_096);
    assert!(body.get("tool_input").is_none());
    assert_eq!(body["transcript_path"], "/fixture/conversation.jsonl");
    for invalid in [
        Vec::new(),
        b"[1]".to_vec(),
        b"{".to_vec(),
        vec![b' '; MAX_INPUT_BYTES + 1],
    ] {
        assert_eq!(bounded_body(invalid), Err(HookFailure::InvalidInput));
    }
}

#[test]
fn oversized_stop_keeps_empty_registry_proof_but_never_invents_it() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../scripts/qa/fixtures/claude-background-work.json"
    ))
    .unwrap();
    for case in cases {
        let mut input = case["input"].clone();
        input["last_assistant_message"] = "x".repeat(MAX_BODY_BYTES).into();
        let result = bounded_body(serde_json::to_vec(&input).unwrap()).unwrap();
        let result: Value = serde_json::from_slice(&result.body).unwrap();
        for field in ["background_tasks", "session_crons"] {
            let was_empty = input
                .get(field)
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty);
            let is_empty = result
                .get(field)
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty);
            assert_eq!(is_empty, was_empty, "{}: {field}", case["name"]);
        }
        assert!(result.get("last_assistant_message").is_none());
    }
}

#[test]
fn refuses_unsafe_or_misrouted_descriptors_without_contacting_them() {
    let root = tempfile::tempdir().unwrap();
    let descriptor_path = root.path().join("server.json");
    let valid = serde_json::json!({
        "channel": "stable", "port": 12345, "processId": 1,
        "generation": "fixture-generation", "reportToken": "fixture-token",
    });
    std::fs::write(&descriptor_path, serde_json::to_vec(&valid).unwrap()).unwrap();
    std::fs::set_permissions(&descriptor_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(descriptor::read(root.path(), &descriptor_path).is_some());
    std::fs::set_permissions(&descriptor_path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(descriptor::read(root.path(), &descriptor_path).is_none());
    std::fs::set_permissions(&descriptor_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let link = root.path().join("alias.json");
    symlink(&descriptor_path, &link).unwrap();
    assert!(descriptor::read(root.path(), &link).is_none());
    let mut misrouted = valid;
    misrouted["channel"] = "another-channel".into();
    std::fs::write(&descriptor_path, serde_json::to_vec(&misrouted).unwrap()).unwrap();
    assert!(descriptor::read(root.path(), &descriptor_path).is_none());
}
