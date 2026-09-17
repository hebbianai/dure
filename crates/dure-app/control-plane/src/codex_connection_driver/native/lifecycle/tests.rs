use super::*;
use serde_json::json;
use std::fs;

mod descendants;
mod tools;

fn durable_thread_path() -> String {
    std::env::current_exe()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn fence() -> SessionFence {
    SessionFence {
        workspace_id: "fixture-workspace".into(),
        session_id: "fixture-session".into(),
        runner_principal: "fixture-user".into(),
        runner_instance: "fixture-runner".into(),
        channel_epoch: 1,
        host_instance_id: "fixture-host".into(),
        terminal_epoch: "fixture-terminal".into(),
    }
}

fn selected() -> Lifecycle {
    let mut projection = Lifecycle::default();
    projection
        .client(1, &json!({"id": 1, "method": "thread/start", "params": {}}))
        .unwrap();
    let report = projection
        .provider(
            1,
            &json!({"id": 1, "result": {"thread": {"id": "thread-main", "path": durable_thread_path()}}}),
            &fence(),
        )
        .unwrap()
        .unwrap();
    assert!(report.identity_only);
    assert_eq!(
        report.conversation_identity.unwrap().expected_fence,
        Some(fence())
    );
    projection
}

#[test]
fn active_wait_flags_project_attention_and_clear_after_the_answer() {
    let mut projection = selected();
    projection
        .provider(
            1,
            &event("turn/started", "turn-main", "inProgress"),
            &fence(),
        )
        .unwrap();
    for (flags, activity, attention) in [
        (
            json!(["waitingOnApproval"]),
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::ApprovalRequired,
        ),
        (
            json!(["waitingOnUserInput"]),
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::InputRequired,
        ),
        (
            json!(["waitingOnUserInput", "waitingOnApproval"]),
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::ApprovalRequired,
        ),
        (
            json!([]),
            AgentRuntimeActivity::Working,
            AgentRuntimeAttention::None,
        ),
    ] {
        let message = json!({"method": "thread/status/changed", "params": {
            "threadId": "thread-main", "status": {"type": "active", "activeFlags": flags}
        }});
        assert!(
            projection
                .provider(2, &message, &fence())
                .unwrap()
                .is_none()
        );
        let report = projection
            .provider(1, &message, &fence())
            .unwrap()
            .expect("the selected provider's waiting state must reach the Host");
        assert_eq!(report.activity, activity);
        assert_eq!(report.attention, attention);
        assert!(!report.identity_only);
        assert!(!report.turn_completed);
    }
}

#[test]
fn active_resume_and_reconciliation_retain_approval_attention() {
    let mut projection = Lifecycle::default();
    projection
        .client(
            1,
            &json!({"id": 1, "method": "thread/resume", "params": {"threadId": "thread-main"}}),
        )
        .unwrap();
    let thread = json!({"id": "thread-main", "path": durable_thread_path(),
        "status": {"type": "active", "activeFlags": ["waitingOnApproval"]},
        "turns": [{"id": "turn-main", "status": "inProgress"}]});
    let resumed = projection
        .provider(1, &json!({"id": 1, "result": {"thread": thread}}), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(resumed.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(resumed.attention, AgentRuntimeAttention::ApprovalRequired);
    assert!(!resumed.identity_only);
    let request = projection.reconciliation_request(1).unwrap();
    let reply = json!({"id": request["id"], "result": {"thread": thread}});
    let report = projection.provider(1, &reply, &fence()).unwrap().unwrap();
    assert_eq!(report.attention, AgentRuntimeAttention::ApprovalRequired);
    let stale = projection.reconciliation_request(1).unwrap();
    projection
        .provider(
            1,
            &json!({"method": "thread/status/changed", "params": {
                "threadId": "thread-main", "status": {"type": "active", "activeFlags": []}
            }}),
            &fence(),
        )
        .unwrap();
    assert!(
        projection
            .provider(
                1,
                &json!({"id": stale["id"], "result": {"thread": thread}}),
                &fence()
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn working_descendant_keeps_completed_parent_working() {
    let mut projection = selected();
    projection
        .provider(1, &event("turn/started", "parent-turn", "inProgress"), &fence())
        .unwrap();
    projection
        .provider(1, &json!({"method": "thread/started", "params": {"thread": {
            "id": "child", "parentThreadId": "thread-main", "status": {"type": "active"}
        }}}), &fence())
        .unwrap();
    let report = projection
        .provider(1, &event("turn/completed", "parent-turn", "completed"), &fence())
        .unwrap().unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Working,
        "parent completion must not declare the still-working subtree idle");
    assert!(!report.turn_completed);
    let report = projection
        .provider(1, &json!({"method": "thread/status/changed", "params": {
            "threadId": "child", "status": {"type": "idle"}
        }}), &fence())
        .unwrap().unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(report.turn_completion_id.as_deref(), Some("parent-turn"));
}

#[test]
fn fresh_thread_path_must_exist_before_publishing_resume_identity() {
    let root = tempfile::tempdir().unwrap();
    let thread_path = root.path().join("fresh-thread.jsonl");
    let mut projection = Lifecycle::default();
    projection
        .client(1, &json!({"id": 1, "method": "thread/start", "params": {}}))
        .unwrap();
    assert!(
        projection
            .provider(
                1,
                &json!({"id": 1, "result": {"thread": {"id": "thread-main", "path": thread_path.to_string_lossy()}}}),
                &fence()
            )
            .unwrap()
            .is_none(),
        "a fresh Codex thread is not exact-resumable until its announced file exists"
    );

    fs::write(&thread_path, "{}\n").unwrap();
    let report = projection
        .provider(
            1,
            &event("turn/started", "turn-main", "inProgress"),
            &fence(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Working);
    assert_eq!(
        report.conversation_identity.unwrap().conversation_id,
        "thread-main"
    );
}

#[test]
fn picker_initialization_cannot_consume_the_tuis_pending_selection() {
    let mut projection = selected();
    projection
        .provider(
            1,
            &event("turn/started", "turn-one", "inProgress"),
            &fence(),
        )
        .unwrap();
    projection
        .client(
            1,
            &json!({"id": 7, "method": "thread/resume", "params": {"threadId": "thread-next"}}),
        )
        .unwrap();
    projection
        .client(2, &json!({"id": 7, "method": "initialize", "params": {}}))
        .unwrap();
    assert!(
        projection
            .provider(
                2,
                &json!({"id": 7, "result": {"userAgent": "picker"}}),
                &fence()
            )
            .unwrap()
            .is_none()
    );
    let selected = projection
        .provider(
            1,
            &json!({"id": 7, "result": {"thread": {"id": "thread-next", "path": durable_thread_path()}}}),
            &fence(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        selected.conversation_identity.unwrap().conversation_id,
        "thread-next"
    );
    assert!(projection.is_selected_connection(1));
}

#[test]
fn helper_notifications_and_disconnect_do_not_settle_the_selected_turn() {
    let mut projection = selected();
    projection
        .provider(
            1,
            &event("turn/started", "turn-one", "inProgress"),
            &fence(),
        )
        .unwrap();
    assert!(
        projection
            .provider(
                2,
                &event("turn/completed", "turn-one", "completed"),
                &fence()
            )
            .unwrap()
            .is_none()
    );
    projection.disconnected(2);
    assert!(projection.is_selected_connection(1));
    let completed = projection
        .provider(
            1,
            &event("turn/completed", "turn-one", "completed"),
            &fence(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(completed.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(completed.turn_completion_id.as_deref(), Some("turn-one"));
}

#[test]
fn temporary_clients_retire_pending_requests_and_a_new_selection_owns_events() {
    let mut projection = selected();
    for connection in 2..40 {
        projection
            .client(
                connection,
                &json!({"id": 0, "method": "initialize", "params": {}}),
            )
            .unwrap();
        projection.disconnected(connection);
    }
    projection.disconnected(1);
    assert!(projection.reconciliation_request(1).is_none());
    projection
        .client(
            40,
            &json!({"id": 0, "method": "thread/resume", "params": {"threadId": "thread-main"}}),
        )
        .unwrap();
    projection
        .provider(
            40,
            &json!({"id": 0, "result": {"thread": {"id": "thread-main", "path": durable_thread_path()}}}),
            &fence(),
        )
        .unwrap();
    assert!(
        projection
            .provider(
                1,
                &event("turn/started", "stale-turn", "inProgress"),
                &fence()
            )
            .unwrap()
            .is_none()
    );
    let started = projection
        .provider(
            40,
            &event("turn/started", "new-turn", "inProgress"),
            &fence(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(started.activity, AgentRuntimeActivity::Working);
    assert_eq!(
        started.conversation_identity.unwrap().conversation_id,
        "thread-main"
    );
}

#[test]
fn reconciliation_is_private_to_the_selected_connection() {
    let mut projection = selected();
    assert!(projection.reconciliation_request(2).is_none());
    let request = projection.reconciliation_request(1).unwrap();
    let reply = json!({"id": request["id"], "result": {"thread": {"id": "thread-main", "status": {"type": "idle"}}}});
    assert!(projection.provider(2, &reply, &fence()).unwrap().is_none());
    assert!(projection.provider(1, &reply, &fence()).unwrap().is_some());
}

#[test]
fn fresh_server_initialization_establishes_input_readiness_before_the_lazy_thread() {
    let mut projection = Lifecycle::default();
    projection
        .client(1, &json!({"id": 0, "method": "initialize", "params": {}}))
        .unwrap();
    let report = projection
        .provider(
            1,
            &json!({"id": 0, "result": {"userAgent": "codex"}}),
            &fence(),
        )
        .unwrap();
    assert!(
        report.is_some(),
        "first Enter needs an authoritative runtime baseline"
    );
    let report = report.unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Waiting);
    assert!(!report.identity_only);
    assert!(report.conversation_identity.is_none());
    projection
        .client(2, &json!({"id": 0, "method": "initialize", "params": {}}))
        .unwrap();
    assert!(
        projection
            .provider(
                2,
                &json!({"id": 0, "result": {"userAgent": "picker"}}),
                &fence()
            )
            .unwrap()
            .is_none(),
        "a helper must not publish another fresh-server boundary over subsequent input"
    );
}

fn event(method: &str, id: &str, status: &str) -> Value {
    json!({"method": method, "params": {"threadId": "thread-main", "turn": {"id": id, "status": status}}})
}

fn goal(status: &str) -> Value {
    json!({"method": "thread/goal/updated", "params": {"threadId": "thread-main", "goal": {"threadId": "thread-main", "status": status}}})
}

#[test]
fn failed_and_interrupted_turns_settle_an_active_goal_without_completing_it() {
    for status in ["failed", "interrupted"] {
        let mut projection = selected();
        projection.provider(1, &goal("active"), &fence()).unwrap();
        let working = projection
            .provider(
                1,
                &event("turn/started", "turn-one", "inProgress"),
                &fence(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(working.activity, AgentRuntimeActivity::Working);
        let mut ended = event("turn/completed", "turn-one", status);
        ended["params"]["turn"]["error"] = json!({"codexErrorInfo": "usageLimitExceeded"});
        let idle = projection.provider(1, &ended, &fence()).unwrap().unwrap();
        assert_eq!(idle.activity, AgentRuntimeActivity::Waiting);
        assert_eq!(idle.attention, AgentRuntimeAttention::None);
        assert!(!idle.turn_completed);
        assert_eq!(idle.turn_completion_id, None);
    }
}

#[test]
fn only_successful_nonactive_goal_boundaries_count_as_completion() {
    for (goal_state, activity, completed) in [
        ("none", AgentRuntimeActivity::Waiting, true),
        ("complete", AgentRuntimeActivity::Waiting, true),
        ("active", AgentRuntimeActivity::Working, false),
        ("usageLimited", AgentRuntimeActivity::Waiting, false),
        ("budgetLimited", AgentRuntimeActivity::Waiting, false),
        ("unknown-future-state", AgentRuntimeActivity::Working, false),
    ] {
        let mut projection = selected();
        projection.provider(1, &goal(goal_state), &fence()).unwrap();
        projection
            .provider(
                1,
                &event("turn/started", "turn-one", "inProgress"),
                &fence(),
            )
            .unwrap();
        let report = projection
            .provider(
                1,
                &event("turn/completed", "turn-one", "completed"),
                &fence(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(report.activity, activity);
        assert_eq!(report.turn_completed, completed);
    }
}

#[test]
fn another_threads_failure_does_not_settle_the_selected_pane() {
    let mut projection = selected();
    let mut failure = event("turn/completed", "child-turn", "failed");
    failure["params"]["threadId"] = json!("thread-child");
    assert!(
        projection
            .provider(1, &failure, &fence())
            .unwrap()
            .is_none()
    );
}

#[test]
fn older_completion_cannot_overwrite_a_newer_active_turn() {
    let mut projection = selected();
    projection
        .provider(
            1,
            &event("turn/started", "turn-one", "inProgress"),
            &fence(),
        )
        .unwrap();
    projection
        .provider(
            1,
            &event("turn/started", "turn-two", "inProgress"),
            &fence(),
        )
        .unwrap();
    assert!(
        projection
            .provider(1, &event("turn/completed", "turn-one", "failed"), &fence())
            .unwrap()
            .is_none()
    );
}

#[test]
fn old_success_cannot_complete_a_newer_failed_turn() {
    let mut projection = selected();
    projection
        .provider(
            1,
            &event("turn/started", "turn-old", "inProgress"),
            &fence(),
        )
        .unwrap();
    projection
        .provider(
            1,
            &event("turn/started", "turn-current", "inProgress"),
            &fence(),
        )
        .unwrap();
    projection
        .provider(
            1,
            &event("turn/completed", "turn-current", "failed"),
            &fence(),
        )
        .unwrap();
    assert!(
        projection
            .provider(
                1,
                &event("turn/completed", "turn-old", "completed"),
                &fence()
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn repeated_start_cannot_reopen_an_already_ended_turn() {
    let mut projection = selected();
    projection
        .provider(
            1,
            &event("turn/started", "turn-current", "inProgress"),
            &fence(),
        )
        .unwrap();
    projection
        .provider(
            1,
            &event("turn/completed", "turn-current", "interrupted"),
            &fence(),
        )
        .unwrap();
    assert!(
        projection
            .provider(
                1,
                &event("turn/started", "turn-current", "inProgress"),
                &fence()
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn late_goal_read_cannot_replace_a_newer_goal_notification() {
    let mut projection = selected();
    projection
        .client(
            1,
            &json!({"id": 2, "method": "thread/goal/get", "params": {"threadId": "thread-main"}}),
        )
        .unwrap();
    projection.provider(1, &goal("active"), &fence()).unwrap();
    projection
        .provider(1, &json!({"id": 2, "result": {"goal": null}}), &fence())
        .unwrap();
    projection
        .provider(
            1,
            &event("turn/started", "turn-one", "inProgress"),
            &fence(),
        )
        .unwrap();
    let report = projection
        .provider(
            1,
            &event("turn/completed", "turn-one", "completed"),
            &fence(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Working);
    assert!(!report.turn_completed);
}

#[test]
fn ephemeral_title_thread_does_not_replace_the_native_conversation() {
    let mut projection = selected();
    projection
        .client(
            1,
            &json!({"id": 2, "method": "thread/start", "params": {"ephemeral": true}}),
        )
        .unwrap();
    assert!(
        projection
            .provider(
                1,
                &json!({"id": 2, "result": {"thread": {"id": "title-thread", "ephemeral": true}}}),
                &fence()
            )
            .unwrap()
            .is_none()
    );
    projection
        .provider(
            1,
            &event("turn/started", "turn-main", "inProgress"),
            &fence(),
        )
        .unwrap();
    let report = projection
        .provider(1, &event("turn/completed", "turn-main", "failed"), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(
        report.conversation_identity.unwrap().conversation_id,
        "thread-main"
    );
}

#[test]
fn server_request_ids_cannot_consume_client_response_correlations() {
    let mut projection = Lifecycle::default();
    projection
        .client(1, &json!({"id": 1, "method": "thread/start", "params": {}}))
        .unwrap();
    assert!(projection.provider(1, &json!({"id": 1, "method": "item/commandExecution/requestApproval", "params": {"threadId": "other-thread"}}), &fence()).unwrap().is_none());
    let report = projection
        .provider(
            1,
            &json!({"id": 1, "result": {"thread": {"id": "thread-main", "path": durable_thread_path()}}}),
            &fence(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        report.conversation_identity.unwrap().conversation_id,
        "thread-main"
    );
}

#[test]
fn goal_completion_after_the_turn_settles_the_same_completion_once() {
    let mut projection = selected();
    projection.provider(1, &goal("active"), &fence()).unwrap();
    projection
        .provider(
            1,
            &event("turn/started", "turn-main", "inProgress"),
            &fence(),
        )
        .unwrap();
    let ended = projection
        .provider(
            1,
            &event("turn/completed", "turn-main", "completed"),
            &fence(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(ended.activity, AgentRuntimeActivity::Working);
    assert!(!ended.turn_completed);
    let complete = projection
        .provider(1, &goal("complete"), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(complete.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(complete.turn_completion_id.as_deref(), Some("turn-main"));
    projection
        .provider(
            1,
            &event("turn/started", "turn-next", "inProgress"),
            &fence(),
        )
        .unwrap();
    assert!(
        projection
            .provider(1, &goal("complete"), &fence())
            .unwrap()
            .is_none()
    );
}

#[test]
fn resumed_active_turn_is_not_projected_as_idle() {
    let mut projection = Lifecycle::default();
    projection
        .client(
            1,
            &json!({"id": 1, "method": "thread/resume", "params": {"threadId": "thread-main"}}),
        )
        .unwrap();
    let report = projection.provider(1, &json!({"id": 1, "result": {"thread": {"id": "thread-main", "path": durable_thread_path(), "status": {"type": "active", "activeFlags": []}, "turns": [{"id": "turn-main", "status": "inProgress"}]}}}), &fence()).unwrap().unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Working);
    assert!(!report.identity_only);
    let report = projection
        .provider(
            1,
            &event("turn/completed", "turn-main", "completed"),
            &fence(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        report.activity,
        AgentRuntimeActivity::Working,
        "unknown goal cannot prove a safe idle boundary"
    );
    projection
        .client(
            1,
            &json!({"id": 2, "method": "thread/goal/get", "params": {"threadId": "thread-main"}}),
        )
        .unwrap();
    let report = projection
        .provider(1, &json!({"id": 2, "result": {"goal": null}}), &fence())
        .unwrap()
        .unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Waiting);
    assert!(report.turn_completed);
}

fn reconciliation(projection: &mut Lifecycle, status: &str) -> Value {
    let id = "dure/native-state/1";
    projection
        .client(
            1,
            &json!({"id": id, "method": "thread/read", "params": {
                "threadId": "thread-main", "includeTurns": false
            }}),
        )
        .unwrap();
    json!({"id": id, "result": {"thread": {"id": "thread-main", "status": {"type": status}}}})
}

#[test]
fn reconciliation_confirms_the_failed_turn_without_fabricating_completion() {
    let mut projection = selected();
    projection
        .provider(
            1,
            &event("turn/started", "turn-one", "inProgress"),
            &fence(),
        )
        .unwrap();
    projection
        .provider(1, &event("turn/completed", "turn-one", "failed"), &fence())
        .unwrap();
    let reply = reconciliation(&mut projection, "idle");
    let report = projection.provider(1, &reply, &fence()).unwrap();
    assert!(
        report.is_some(),
        "recover a failed admission from the current provider state"
    );
    let report = report.unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Waiting);
    assert!(!report.turn_completed);
    assert_eq!(
        report.conversation_identity.unwrap().expected_fence,
        Some(fence())
    );
    let reply = reconciliation(&mut projection, "systemError");
    let report = projection.provider(1, &reply, &fence()).unwrap().unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Waiting);
    assert!(!report.turn_completed);
}

#[test]
fn reconciliation_never_replays_waiting_over_a_newer_turn() {
    let mut projection = selected();
    projection
        .provider(
            1,
            &event("turn/started", "turn-one", "inProgress"),
            &fence(),
        )
        .unwrap();
    projection
        .provider(1, &event("turn/completed", "turn-one", "failed"), &fence())
        .unwrap();
    let stale = reconciliation(&mut projection, "idle");
    projection
        .provider(
            1,
            &event("turn/started", "turn-two", "inProgress"),
            &fence(),
        )
        .unwrap();
    assert!(projection.provider(1, &stale, &fence()).unwrap().is_none());
    let current = reconciliation(&mut projection, "active");
    let report = projection.provider(1, &current, &fence()).unwrap();
    assert!(
        report.is_some(),
        "reconcile the newer active turn, not the old failure"
    );
    let report = report.unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Working);
    assert!(!report.turn_completed);
}

#[test]
fn reconciliation_refuses_unknown_identity_status_and_unconfirmed_termination() {
    let mut projection = selected();
    projection
        .provider(
            1,
            &event("turn/started", "turn-one", "inProgress"),
            &fence(),
        )
        .unwrap();
    for status in ["idle", "notLoaded", "systemError", "unknown"] {
        let reply = reconciliation(&mut projection, status);
        assert!(projection.provider(1, &reply, &fence()).unwrap().is_none());
    }
    let mut other = reconciliation(&mut projection, "active");
    other["result"]["thread"]["id"] = json!("other-thread");
    assert!(projection.provider(1, &other, &fence()).unwrap().is_none());
}

#[test]
fn fresh_idle_reconciliation_confirms_runtime_without_a_fake_completion() {
    let mut projection = selected();
    let reply = reconciliation(&mut projection, "idle");
    let report = projection.provider(1, &reply, &fence()).unwrap().unwrap();
    assert_eq!(report.activity, AgentRuntimeActivity::Waiting);
    assert!(
        !report.identity_only,
        "a current idle read settles runtime admission, not just identity"
    );
    assert!(!report.turn_completed);
}

#[test]
fn submitting_a_successor_invalidates_idle_reads_before_its_start_event_arrives() {
    let mut projection = selected();
    projection
        .provider(
            1,
            &event("turn/started", "turn-one", "inProgress"),
            &fence(),
        )
        .unwrap();
    projection
        .provider(1, &event("turn/completed", "turn-one", "failed"), &fence())
        .unwrap();
    let stale = reconciliation(&mut projection, "idle");
    projection
        .client(
            1,
            &json!({"id": 2, "method": "turn/start", "params": {"threadId": "thread-main"}}),
        )
        .unwrap();
    assert!(
        projection.provider(1, &stale, &fence()).unwrap().is_none(),
        "input intent invalidates an earlier idle read"
    );
    let pending = reconciliation(&mut projection, "idle");
    assert!(
        projection
            .provider(1, &pending, &fence())
            .unwrap()
            .is_none(),
        "pending native start is not confirmed idle"
    );
    projection
        .provider(1, &json!({"id": 2, "error": {"code": -1}}), &fence())
        .unwrap();
    let refused = reconciliation(&mut projection, "idle");
    assert_eq!(
        projection
            .provider(1, &refused, &fence())
            .unwrap()
            .unwrap()
            .activity,
        AgentRuntimeActivity::Waiting
    );
}
