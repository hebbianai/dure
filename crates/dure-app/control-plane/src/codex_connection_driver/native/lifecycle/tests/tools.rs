use super::*;

fn completed() -> Lifecycle {
    let mut projection = selected();
    for (method, status) in [
        ("turn/started", "inProgress"),
        ("turn/completed", "completed"),
    ] {
        projection
            .provider(1, &event(method, "parent-turn", status), &fence())
            .unwrap();
    }
    projection
}

fn tool_call(projection: &mut Lifecycle, connection: u64) -> Value {
    let request = json!({"id": 42, "method": "mcpServer/tool/call", "params": {
        "threadId": "thread-main", "server": "fixture", "tool": "counter", "arguments": {}
    }});
    projection.client(connection, &request).unwrap();
    let report = projection
        .tool_call_report(connection, &request, &fence())
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Working);
    assert!(!report.identity_only);
    assert!(!report.turn_completed);
    projection.admitted(&report);
    request
}

#[test]
fn tool_completion_before_the_first_turn_restores_activity_without_a_completion() {
    let mut projection = selected();
    tool_call(&mut projection, 2);
    let report = projection
        .provider(2, &json!({"id":42,"result":{}}), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Waiting);
    assert!(!report.identity_only);
    assert!(!report.turn_completed);
}

#[test]
fn resource_completion_after_admission_publishes_activity_not_a_duplicate_turn() {
    for descendant in [false, true] {
        let mut projection = completed();
        let completion = projection.own_report.clone().unwrap();
        projection.admitted(&completion);
        let settled = if descendant {
            let working = projection
                .provider(
                    1,
                    &json!({"method":"thread/started","params":{"thread": {
                        "id":"child","parentThreadId":"thread-main","status":{"type":"active"}
                    }}}),
                    &fence(),
                )
                .unwrap()
                .unwrap();
            projection.admitted(&working);
            projection
                .provider(
                    1,
                    &json!({"method":"thread/status/changed","params": {
                        "threadId":"child","status":{"type":"idle"}
                    }}),
                    &fence(),
                )
                .unwrap()
                .unwrap()
        } else {
            tool_call(&mut projection, 2);
            projection
                .provider(2, &json!({"id":42,"result":{}}), &fence())
                .unwrap()
                .unwrap()
        };
        assert_eq!(settled.activity, AgentRuntimeActivity::Waiting);
        assert!(!settled.identity_only);
        assert!(!settled.turn_completed);
        assert!(settled.turn_completion_id.is_none());

        // A failed activity delivery must recover without replaying the
        // already-admitted parent completion, even after the helper disconnects.
        projection.disconnected(2);
        let request = projection.reconciliation_request(1).unwrap();
        let recovered = projection
            .provider(
                1,
                &json!({"id":request["id"],"result": {
                    "thread":{"id":"thread-main","status":{"type":"idle"}}
                }}),
                &fence(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(recovered.activity, AgentRuntimeActivity::Waiting);
        assert!(!recovered.turn_completed);
        assert!(recovered.turn_completion_id.is_none());
    }
}

#[test]
fn admission_keeps_completion_retries_until_later_activity_supersedes_them() {
    let mut projection = completed();
    projection.admitted(&projection.own_report.clone().unwrap());
    // NoOp may mean the Host is still settling this completion. A metadata
    // retry must not replace that candidate with an uncounted waiting report.
    let report = projection.completion_report(&fence()).unwrap();
    assert!(report.turn_completed);
    assert_eq!(report.turn_completion_id.as_deref(), Some("parent-turn"));
    assert_eq!(
        projection.own_report.unwrap().turn_completion_id,
        report.turn_completion_id
    );
}

#[test]
fn a_new_turn_still_publishes_its_own_completion_after_the_previous_admission() {
    let mut projection = completed();
    projection.admitted(&projection.own_report.clone().unwrap());
    projection
        .provider(
            1,
            &event("turn/started", "next-turn", "inProgress"),
            &fence(),
        )
        .unwrap();
    let report = projection
        .provider(
            1,
            &event("turn/completed", "next-turn", "completed"),
            &fence(),
        )
        .unwrap()
        .unwrap();
    assert!(report.turn_completed);
    assert_eq!(report.turn_completion_id.as_deref(), Some("next-turn"));
}

#[test]
fn auxiliary_tool_holds_idle_parent_until_its_exact_response() {
    let mut projection = completed();
    tool_call(&mut projection, 2);
    let metadata = projection.reconciliation_request(1).unwrap();
    let report = projection
        .provider(
            1,
            &json!({"id": metadata["id"], "result": {
                "thread": {"id": "thread-main", "status": {"type": "idle"}}
            }}),
            &fence(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Working);
    assert!(!report.turn_completed);
    assert!(
        projection
            .provider(3, &json!({"id":42,"result":{}}), &fence())
            .unwrap()
            .is_none()
    );
    let report = projection
        .provider(2, &json!({"id":42,"result":{}}), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(report.turn_completion_id.as_deref(), Some("parent-turn"));
}

#[test]
fn helper_disconnect_does_not_drop_inflight_tool_ownership() {
    let mut projection = completed();
    tool_call(&mut projection, 2);
    projection.disconnected(2);
    assert!(projection.has_pending_tools(2));
    let report = projection
        .provider(2, &json!({"id":42,"error":{"code":-32603}}), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Waiting);
    assert!(!projection.has_pending_tools(2));
}

#[test]
fn concurrent_helpers_reusing_ids_hold_until_the_last_tool_finishes() {
    let mut projection = completed();
    tool_call(&mut projection, 2);
    tool_call(&mut projection, 3);
    assert!(
        projection
            .provider(2, &json!({"id":42,"result":{}}), &fence())
            .unwrap()
            .is_none()
    );
    let report = projection
        .provider(3, &json!({"id":42,"result":{}}), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Waiting);
}

#[test]
fn tool_completion_cannot_settle_a_new_parent_turn_or_working_descendant() {
    for child in [false, true] {
        let mut projection = completed();
        tool_call(&mut projection, 2);
        let message = if child {
            json!({"method":"thread/started","params":{"thread": {
                "id":"child","parentThreadId":"thread-main","status":{"type":"active"}
            }}})
        } else {
            event("turn/started", "next-turn", "inProgress")
        };
        projection.provider(1, &message, &fence()).unwrap();
        if let Some(report) = projection
            .provider(2, &json!({"id":42,"result":{}}), &fence())
            .unwrap()
        {
            assert_eq!(report.activity, AgentRuntimeActivity::Working);
            assert!(!report.turn_completed);
        }
        assert_eq!(
            projection
                .protect_report(projection.own_report.clone().unwrap())
                .activity,
            AgentRuntimeActivity::Working
        );
    }
}

#[test]
fn only_unforwarded_rejections_can_release_locally_owned_requests() {
    let mut projection = completed();
    let request = tool_call(&mut projection, 2);
    projection.reject_unforwarded_tool(3, &request);
    assert!(projection.has_pending_tools(2));
    projection.reject_unforwarded_tool(2, &request);
    assert!(!projection.has_pending_tools(2));
    assert_eq!(
        projection
            .protect_report(projection.own_report.clone().unwrap())
            .activity,
        AgentRuntimeActivity::Waiting
    );
}

#[test]
fn malformed_response_cannot_release_inflight_work() {
    let mut projection = completed();
    tool_call(&mut projection, 2);
    for message in [
        json!({"id":42}),
        json!({"id":42,"error":null}),
        json!({"id":42,"result":{},"error":{}}),
    ] {
        assert!(
            projection
                .provider(2, &message, &fence())
                .unwrap()
                .is_none()
        );
        assert!(projection.has_pending_tools(2));
    }
}

#[test]
fn duplicate_request_cannot_replace_a_running_tool() {
    let mut projection = completed();
    let request = tool_call(&mut projection, 2);
    assert!(projection.client(2, &request).is_err());
    assert!(projection.has_pending_tools(2));
}
