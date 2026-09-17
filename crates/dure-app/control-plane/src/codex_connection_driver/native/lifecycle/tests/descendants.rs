use super::*;

fn start(thread: &str, parent: Option<&str>, status: &str) -> Value {
    json!({"method": "thread/started", "params": {"thread": {
        "id": thread, "parentThreadId": parent, "status": {"type": status}
    }}})
}

fn status(thread: &str, status: &str) -> Value {
    json!({"method": "thread/status/changed", "params": {
        "threadId": thread, "status": {"type": status}
    }})
}

fn completed_parent() -> Lifecycle {
    let mut projection = selected();
    projection
        .provider(
            1,
            &event("turn/started", "parent-turn", "inProgress"),
            &fence(),
        )
        .unwrap();
    projection
        .provider(
            1,
            &event("turn/completed", "parent-turn", "completed"),
            &fence(),
        )
        .unwrap();
    projection
}

#[test]
fn grandchild_work_survives_intermediate_parent_unload() {
    let mut projection = completed_parent();
    projection
        .provider(1, &start("child", Some("thread-main"), "idle"), &fence())
        .unwrap();
    let busy = projection
        .provider(1, &start("grandchild", Some("child"), "active"), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(busy.activity, AgentRuntimeActivity::Working);
    assert!(!busy.turn_completed);
    assert!(
        projection
            .provider(
                1,
                &json!({"method":"thread/closed", "params":{"threadId":"child"}}),
                &fence()
            )
            .unwrap()
            .is_none()
    );
    let request = projection.reconciliation_request(1).unwrap();
    let reconciled = projection
        .provider(
            1,
            &json!({"id": request["id"], "result": {"thread": {
                "id": "thread-main", "status": {"type":"idle"}
            }}}),
            &fence(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(reconciled.activity, AgentRuntimeActivity::Working);
    assert!(!reconciled.turn_completed);
    let settled = projection
        .provider(1, &status("grandchild", "idle"), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(settled.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(settled.turn_completion_id.as_deref(), Some("parent-turn"));
}

#[test]
fn last_working_sibling_controls_subtree_completion() {
    let mut projection = completed_parent();
    for child in ["child-a", "child-b"] {
        projection
            .provider(1, &start(child, Some("thread-main"), "active"), &fence())
            .unwrap();
    }
    assert!(
        projection
            .provider(1, &status("child-a", "idle"), &fence())
            .unwrap()
            .is_none()
    );
    // Picker copies and disconnection cannot end the selected stream's work.
    assert!(
        projection
            .provider(2, &status("child-b", "idle"), &fence())
            .unwrap()
            .is_none()
    );
    projection.disconnected(2);
    let report = projection
        .provider(1, &status("child-b", "idle"), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Waiting);
    assert!(
        projection
            .provider(1, &status("child-b", "idle"), &fence())
            .unwrap()
            .is_none()
    );
}

#[test]
fn idle_child_cannot_settle_a_parent_with_a_new_pending_turn() {
    let mut projection = completed_parent();
    projection
        .provider(1, &start("child", Some("thread-main"), "active"), &fence())
        .unwrap();
    projection
        .client(
            1,
            &json!({"id":42,"method":"turn/start","params":{"threadId":"thread-main"}}),
        )
        .unwrap();
    let report = projection
        .provider(1, &status("child", "idle"), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Working);
    assert!(!report.turn_completed);
}

#[test]
fn child_completion_does_not_settle_an_active_parent() {
    let mut projection = selected();
    projection
        .provider(
            1,
            &event("turn/started", "parent-turn", "inProgress"),
            &fence(),
        )
        .unwrap();
    projection
        .provider(1, &start("child", Some("thread-main"), "active"), &fence())
        .unwrap();
    let report = projection
        .provider(1, &status("child", "idle"), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Working);
    assert!(!report.turn_completed);
}

#[test]
fn unknown_ancestry_protects_work_until_an_unrelated_root_is_known() {
    let mut projection = completed_parent();
    let report = projection
        .provider(1, &status("unknown", "active"), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Working);
    let report = projection
        .provider(1, &start("unknown", None, "active"), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Waiting);
    assert!(
        projection
            .provider(
                1,
                &start("unrelated-child", Some("unknown"), "active"),
                &fence()
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn error_or_unknown_child_status_does_not_prove_idle() {
    let mut projection = completed_parent();
    projection
        .provider(1, &start("child", Some("thread-main"), "active"), &fence())
        .unwrap();
    for state in ["systemError", "future-status"] {
        assert!(
            projection
                .provider(1, &status("child", state), &fence())
                .unwrap()
                .is_none()
        );
    }
    let report = projection
        .provider(
            1,
            &event("turn/completed", "parent-turn", "completed"),
            &fence(),
        )
        .unwrap();
    assert!(report.is_none());
    let settled = projection
        .provider(1, &status("child", "notLoaded"), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(settled.activity, AgentRuntimeActivity::Waiting);
}
