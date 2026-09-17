use serde_json::{json, Map, Value};

use super::{fold, validate_event_payload};

fn event(kind: &str, step: Option<&str>, extra: Value) -> Map<String, Value> {
    let mut event = Map::new();
    event.insert("event".into(), json!(kind));
    event.insert("at".into(), json!(1000u64));
    if let Some(step) = step {
        event.insert("step".into(), json!(step));
    }
    if let Some(extra) = extra.as_object() {
        event.extend(extra.clone());
    }
    event
}

fn saga_created(digest: &str) -> Map<String, Value> {
    event(
        "saga_created",
        None,
        json!({
            "receiptId": "sp_host_atomic",
            "request": { "promptDigest": digest, "promptLen": 7 }
        }),
    )
}

fn prompt_started() -> Map<String, Value> {
    event(
        "step_started",
        Some("prompt_delivery"),
        json!({ "detail": { "deliveryContract": "host_atomic_v1" } }),
    )
}

fn prompt_success(digest: &str, receipt: Value) -> Map<String, Value> {
    event(
        "step_succeeded",
        Some("prompt_delivery"),
        json!({
            "detail": {
                "deliveryContract": "host_atomic_v1",
                "promptDigest": digest,
                "promptLen": 7,
                "receipt": receipt
            }
        }),
    )
}

#[test]
fn host_atomic_success_commits_step_and_exact_host_receipt_together() {
    let digest = format!("sha256:{}", "e".repeat(64));
    let mut events = vec![saga_created(&digest), prompt_started()];
    let success = prompt_success(
        &digest,
        json!({
            "terminalEpoch": "terminal-1",
            "recordId": "9",
            "inputBaselineOutputSequence": "0"
        }),
    );
    let before_success = fold(&events);
    assert!(validate_event_payload("step_succeeded", &success, &before_success).is_ok());
    events.push(success);

    let receipt = fold(&events);
    let step = &receipt["steps"][5];
    assert_eq!(step["status"], "ok");
    assert_eq!(step["delivery"]["state"], "written_to_pty");
    assert_eq!(step["delivery"]["receipt"]["terminalEpoch"], "terminal-1");
    assert_eq!(step["delivery"]["receipt"]["recordId"], "9");
    assert_eq!(
        step["delivery"]["receipt"]["inputBaselineOutputSequence"],
        "0"
    );
    assert!(step["delivery"]["receipt"]
        .get("initialAgentRuntimeRevision")
        .is_none());
    assert_eq!(step["evidence"]["level"], "written_to_pty");
}

#[test]
fn host_atomic_receipt_does_not_lower_existing_legacy_evidence() {
    let digest = format!("sha256:{}", "d".repeat(64));
    let mut events = vec![
        saga_created(&digest),
        event(
            "evidence",
            None,
            json!({ "evidence": { "level": "provider_ready" } }),
        ),
        prompt_started(),
    ];
    events.push(prompt_success(
        &digest,
        json!({
            "terminalEpoch": "terminal-1",
            "recordId": "9",
            "inputBaselineOutputSequence": "0"
        }),
    ));

    let receipt = fold(&events);
    assert_eq!(receipt["steps"][5]["evidence"]["level"], "provider_ready");
    assert_eq!(receipt["steps"][5]["delivery"]["receipt"]["recordId"], "9");
}

#[test]
fn host_atomic_success_requires_a_matching_running_step_and_valid_receipt() {
    let digest = format!("sha256:{}", "f".repeat(64));
    let started = vec![saga_created(&digest), prompt_started()];
    let receipt = fold(&started);
    for invalid in [
        json!({
            "terminalEpoch": "terminal-1",
            "recordId": "0",
            "inputBaselineOutputSequence": "0"
        }),
        json!({
            "terminalEpoch": "terminal-1",
            "recordId": "9",
            "inputBaselineOutputSequence": "00"
        }),
        json!({
            "terminalEpoch": "terminal-1",
            "recordId": "9",
            "inputBaselineOutputSequence": "0",
            "initialAgentRuntimeRevision": "0"
        }),
    ] {
        assert!(validate_event_payload(
            "step_succeeded",
            &prompt_success(&digest, invalid),
            &receipt,
        )
        .is_err());
    }

    let valid = prompt_success(
        &digest,
        json!({
            "terminalEpoch": "terminal-1",
            "recordId": "9",
            "inputBaselineOutputSequence": "0",
            "initialAgentRuntimeRevision": "4"
        }),
    );
    let without_start = fold(&started[..1]);
    assert!(validate_event_payload("step_succeeded", &valid, &without_start).is_err());

    let mut after_failure = started;
    after_failure.push(event(
        "step_failed",
        Some("prompt_delivery"),
        json!({ "error": { "code": "not_written", "message": "retry" } }),
    ));
    assert!(validate_event_payload("step_succeeded", &valid, &fold(&after_failure)).is_err());
}

#[test]
fn host_atomic_retry_clears_stale_error_and_sticky_unknown_is_projected() {
    let digest = format!("sha256:{}", "c".repeat(64));
    let events = vec![
        saga_created(&digest),
        prompt_started(),
        event(
            "step_failed",
            Some("prompt_delivery"),
            json!({
                "error": {
                    "code": "hmux_prompt_receipt_timeout",
                    "message": "connection lost",
                    "deliveryState": "unknown"
                }
            }),
        ),
    ];
    let failed = fold(&events);
    assert_eq!(failed["steps"][5]["delivery"]["state"], "unverified");
    assert_eq!(failed["steps"][5]["delivery"]["promptLen"], 7);
    assert_eq!(
        failed["steps"][5]["error"]["code"],
        "hmux_prompt_receipt_timeout"
    );
    assert_eq!(failed["steps"][5]["error"]["deliveryState"], "unknown");

    let mut malformed = events.clone();
    malformed[2]["error"]["deliveryState"] = Value::Null;
    assert_eq!(
        fold(&malformed)["steps"][5]["delivery"]["state"],
        "unverified"
    );

    let mut retryable = events;
    retryable[2]["error"]["deliveryState"] = json!("not_written");
    retryable.push(prompt_started());
    let retried = fold(&retryable);
    assert_eq!(retried["steps"][5]["status"], "running");
    assert!(retried["steps"][5].get("error").is_none());
    assert!(retried["steps"][5].get("endedAt").is_none());
}

#[test]
fn non_prompt_failure_does_not_project_prompt_delivery() {
    let digest = format!("sha256:{}", "d".repeat(64));
    let events = vec![
        saga_created(&digest),
        event(
            "step_failed",
            Some("runtime_session"),
            json!({
                "error": {
                    "code": "runtime_transport_unknown",
                    "message": "runtime state is unavailable",
                    "deliveryState": "unknown"
                }
            }),
        ),
    ];

    assert!(fold(&events)["steps"][2].get("delivery").is_none());
}
