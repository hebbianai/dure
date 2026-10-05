use super::*;
use serde_json::json;

fn notification(method: &str, extra: Value) -> Value {
    let mut params = json!({"threadId":"thread-main", "turnId":"turn-main", "itemId":"item-main"});
    params
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    json!({"method":method, "params":params})
}

fn started(now: Instant) -> Progress {
    let mut progress = Progress::default();
    assert!(progress.observe(&notification("turn/started", json!({})), "thread-main", now));
    progress.take(now, false).unwrap();
    progress
}

fn patch(diff: &str) -> Value {
    json!({"changes":[{"path":"example.rs", "kind":{"type":"update"}, "diff":diff}]})
}

fn tokens(output: u64, reasoning: u64) -> Value {
    json!({"tokenUsage":{"total":{"outputTokens":output, "reasoningOutputTokens":reasoning}}})
}

#[test]
fn provider_work_notifications_advance_progress_without_completing_the_turn() {
    let now = Instant::now();
    for (method, extra) in [
        ("item/fileChange/patchUpdated", patch("+first")),
        ("turn/diff/updated", json!({"diff":"+first"})),
        ("item/plan/delta", json!({"delta":"First, inspect"})),
        (
            "item/fileChange/outputDelta",
            json!({"delta":"Updating file"}),
        ),
        (
            "item/mcpToolCall/progress",
            json!({"message":"Processed first page"}),
        ),
    ] {
        let mut progress = started(now);
        let initial = progress.sequence;
        let later = now + Duration::from_secs(3);
        assert!(
            progress.observe(&notification(method, extra), "thread-main", later),
            "{method}"
        );
        let report = progress.take(later, false).unwrap();
        assert!(report.sequence > initial, "{method}");
        assert_eq!(report.turn_id.as_deref(), Some("turn-main"));
        assert_eq!(report.phase, AgentProgressPhase::Thinking);
    }
}

#[test]
fn snapshots_must_change_even_after_the_report_throttle_expires() {
    let now = Instant::now();
    for (method, first, second) in [
        (
            "item/fileChange/patchUpdated",
            patch("+first"),
            patch("+second"),
        ),
        (
            "turn/diff/updated",
            json!({"diff":"+first"}),
            json!({"diff":"+second"}),
        ),
        (
            "item/mcpToolCall/progress",
            json!({"message":"Page 1"}),
            json!({"message":"Page 2"}),
        ),
    ] {
        let mut progress = started(now);
        // Even a suppressed snapshot is observed: repeating it later is not new work.
        let first = notification(method, first);
        assert!(!progress.observe(&first, "thread-main", now));
        assert!(
            !progress.observe(&first, "thread-main", now + Duration::from_secs(3)),
            "{method}"
        );
        let changed = notification(method, second);
        assert!(
            progress.observe(&changed, "thread-main", now + Duration::from_secs(3)),
            "{method}"
        );
        progress.take(now + Duration::from_secs(3), false);
        assert!(
            !progress.observe(&changed, "thread-main", now + Duration::from_secs(30)),
            "{method}"
        );
    }
}

#[test]
fn token_usage_requires_increasing_generated_tokens_in_the_current_turn() {
    let now = Instant::now();
    let mut progress = started(now);
    let later = now + Duration::from_secs(3);
    let event = |value| notification("thread/tokenUsage/updated", value);
    // The first cumulative total can include earlier turns, so it is only a baseline.
    assert!(!progress.observe(&event(tokens(50, 5)), "thread-main", later));
    let mut input_only = tokens(50, 5);
    input_only["tokenUsage"]["total"]["inputTokens"] = json!(2000);
    input_only["tokenUsage"]["modelContextWindow"] = json!(100000);
    assert!(!progress.observe(&event(input_only), "thread-main", later));
    assert!(!progress.observe(&event(tokens(50, 5)), "thread-main", later));
    assert!(progress.observe(&event(tokens(51, 5)), "thread-main", later));
    progress.take(later, false);
    assert!(!progress.observe(
        &event(tokens(51, 5)),
        "thread-main",
        later + Duration::from_secs(3)
    ));
    assert!(!progress.observe(
        &event(tokens(2, 1)),
        "thread-main",
        later + Duration::from_secs(3)
    ));
    assert!(!progress.observe(
        &event(tokens(51, 5)),
        "thread-main",
        later + Duration::from_secs(3)
    ));
    assert!(progress.observe(
        &event(tokens(51, 6)),
        "thread-main",
        later + Duration::from_secs(3)
    ));
}

#[test]
fn empty_wrong_turn_and_completed_turn_notifications_do_not_refresh_progress() {
    let now = Instant::now();
    let later = now + Duration::from_secs(3);
    let mut progress = started(now);
    let initial = progress.sequence;
    for (method, extra) in [
        ("item/fileChange/patchUpdated", json!({"changes":[]})),
        ("turn/diff/updated", json!({"diff":""})),
        ("item/plan/delta", json!({"delta":""})),
        ("item/mcpToolCall/progress", json!({"message":""})),
        ("thread/tokenUsage/updated", json!({"tokenUsage":{}})),
    ] {
        assert!(
            !progress.observe(&notification(method, extra), "thread-main", later),
            "{method}"
        );
    }
    let mut delta = notification("item/plan/delta", json!({"delta":"First, inspect"}));
    assert!(!progress.observe(&delta, "other-thread", later));
    delta["params"]["turnId"] = json!("stale-turn");
    assert!(!progress.observe(&delta, "thread-main", later));
    assert_eq!(progress.sequence, initial);
    assert!(progress.observe(
        &notification("turn/completed", json!({})),
        "thread-main",
        later
    ));
    progress.take(later, false);
    assert!(!progress.observe(
        &notification("item/plan/delta", json!({"delta":"late"})),
        "thread-main",
        later + Duration::from_secs(3)
    ));
    assert!(!progress.observe(
        &notification("item/agentMessage/delta", json!({"delta":"late"})),
        "thread-main",
        later + Duration::from_secs(3)
    ));
}

#[test]
fn generation_and_turn_changes_reset_snapshot_and_token_evidence() {
    let now = Instant::now();
    let later = now + Duration::from_secs(3);
    let mut progress = started(now);
    let source = progress.source.clone();
    let snapshot = notification("turn/diff/updated", json!({"diff":"+same"}));
    assert!(progress.observe(&snapshot, "thread-main", later));
    let usage = notification("thread/tokenUsage/updated", tokens(10, 1));
    assert!(!progress.observe(&usage, "thread-main", later));

    let mut start = notification("turn/started", json!({}));
    start["params"]["turnId"] = json!("next-turn");
    assert!(progress.observe(&start, "thread-main", later));
    assert!(!progress.observe(&snapshot, "thread-main", later));
    let mut next_snapshot = snapshot.clone();
    next_snapshot["params"]["turnId"] = json!("next-turn");
    assert!(progress.observe(&next_snapshot, "thread-main", later));
    let mut next_usage = notification("thread/tokenUsage/updated", tokens(11, 2));
    next_usage["params"]["turnId"] = json!("next-turn");
    assert!(!progress.observe(&next_usage, "thread-main", later));

    progress.reset();
    assert_ne!(progress.source, source);
    assert!(progress.take(later, false).is_none());
    assert!(!progress.observe(&snapshot, "thread-main", later));
    assert!(progress.observe(
        &notification("turn/started", json!({})),
        "thread-main",
        later
    ));
    assert!(progress.observe(&snapshot, "thread-main", later));
    assert!(!progress.observe(&usage, "thread-main", later));
}

#[test]
fn snapshot_tracking_is_per_item_and_bounded_for_one_turn() {
    let now = Instant::now();
    let later = now + Duration::from_secs(3);
    let mut progress = started(now);
    for index in 0..128 {
        let mut event = notification("item/mcpToolCall/progress", json!({"message":"Starting"}));
        event["params"]["itemId"] = json!(format!("tool-{index}"));
        assert!(progress.observe(&event, "thread-main", later));
    }
    // Saturation fails quiet instead of retaining unbounded provider content.
    let unknown = notification("item/mcpToolCall/progress", json!({"message":"Starting"}));
    assert!(!progress.observe(&unknown, "thread-main", later));
    let known = notification(
        "item/mcpToolCall/progress",
        json!({"itemId":"tool-0", "message":"Page 2"}),
    );
    assert!(progress.observe(&known, "thread-main", later));
    assert!(!progress.observe(&known, "thread-main", later));
}

#[test]
fn observed_work_keeps_tool_and_approval_phases_and_respects_publication_throttle() {
    let now = Instant::now();
    let mut progress = started(now);
    let tool = notification(
        "item/started",
        json!({"item":{"id":"tool", "type":"mcpToolCall"}}),
    );
    assert!(progress.observe(&tool, "thread-main", now));
    progress.take(now, false);
    let delta = notification("item/plan/delta", json!({"delta":"Plan"}));
    assert!(!progress.observe(&delta, "thread-main", now + Duration::from_millis(1999)));
    let later = now + Duration::from_secs(2);
    assert!(progress.observe(&delta, "thread-main", later));
    assert_eq!(
        progress.take(later, false).unwrap().phase,
        AgentProgressPhase::ToolRunning
    );
    progress.activity(false);
    assert!(progress.observe(&delta, "thread-main", later + Duration::from_secs(2)));
    assert_eq!(
        progress
            .take(later + Duration::from_secs(2), false)
            .unwrap()
            .phase,
        AgentProgressPhase::Waiting
    );
}

#[test]
fn malformed_snapshots_and_incidental_metadata_do_not_prove_work() {
    let now = Instant::now();
    let later = now + Duration::from_secs(3);
    let mut progress = started(now);
    for extra in [
        json!({"itemId":"", "message":"page"}),
        json!({"itemId":"bad id", "message":"page"}),
        json!({"message":"  "}),
    ] {
        assert!(!progress.observe(
            &notification("item/mcpToolCall/progress", extra),
            "thread-main",
            later
        ));
    }
    for extra in [
        patch(""),
        json!({"changes":[{"path":"", "kind":{"type":"update"}, "diff":"+first"}]}),
        json!({"changes":[{"path":"file", "kind":{"type":"unknown"}, "diff":"+first"}]}),
    ] {
        assert!(!progress.observe(
            &notification("item/fileChange/patchUpdated", extra),
            "thread-main",
            later
        ));
    }
    let mut event = notification("item/fileChange/patchUpdated", patch("+first"));
    assert!(progress.observe(&event, "thread-main", later));
    event["params"]["changes"][0]["timestamp"] = json!(123);
    assert!(!progress.observe(&event, "thread-main", later + Duration::from_secs(3)));
    let malformed = notification(
        "thread/tokenUsage/updated",
        json!({"tokenUsage":{"total":{"outputTokens":-1, "reasoningOutputTokens":0}}}),
    );
    assert!(!progress.observe(&malformed, "thread-main", later));
}
