use super::*;

#[test]
fn message_turn_is_correlated_to_exact_request_not_unrelated_activity() {
    let mut projection = selected();
    projection
        .provider(
            1,
            &event("turn/started", "unrelated", "inProgress"),
            &fence(),
        )
        .unwrap();
    let wake = "Dure inbox message: receipt-1\nRead and acknowledge it with the installed dure-orchestration tools.";
    projection.client(1, &json!({"id": 41, "method": "turn/start", "params": {"threadId":"thread-main", "input":[{"type":"text", "text":wake}]}})).unwrap();
    assert!(
        projection
            .provider(
                2,
                &json!({"id":41,"result":{"turn":{"id":"wrong-helper"}}}),
                &fence()
            )
            .unwrap()
            .is_none()
    );
    let report = projection
        .provider(
            1,
            &json!({"id":41,"result":{"turn":{"id":"actual-turn"}}}),
            &fence(),
        )
        .unwrap()
        .unwrap();
    let progress = report.progress.unwrap();
    assert_eq!(progress.message_turns.len(), 1);
    assert_eq!(progress.message_turns[0].delivery_receipt_id, "receipt-1");
    assert_eq!(progress.message_turns[0].turn_id, "actual-turn");
    assert!(!report.turn_completed);
}

#[test]
fn progress_delta_is_scoped_and_throttled_without_fabricating_completion() {
    let mut projection = selected();
    let first = projection
        .provider(
            1,
            &event("turn/started", "turn-main", "inProgress"),
            &fence(),
        )
        .unwrap()
        .unwrap();
    assert!(first.progress.unwrap().is_valid());
    let tool = json!({"method":"item/started", "params":{"threadId":"thread-main","turnId":"turn-main","item":{"id":"tool-1","type":"commandExecution"}}});
    let report = projection.provider(1, &tool, &fence()).unwrap().unwrap();
    assert_eq!(
        report.progress.unwrap().phase,
        hmux_client::AgentProgressPhase::ToolRunning
    );
    assert!(!report.turn_completed);
    let delta = json!({"method":"item/commandExecution/outputDelta", "params":{"threadId":"thread-main","turnId":"turn-main","delta":"content"}});
    for _ in 0..100 {
        assert!(projection.provider(1, &delta, &fence()).unwrap().is_none());
    }
    let completed = json!({"method":"item/completed", "params":{"threadId":"thread-main","turnId":"turn-main","item":{"id":"tool-1","type":"commandExecution"}}});
    let report = projection
        .provider(1, &completed, &fence())
        .unwrap()
        .unwrap();
    assert_eq!(
        report.progress.unwrap().phase,
        hmux_client::AgentProgressPhase::Thinking
    );
    assert!(!report.turn_completed);
}
