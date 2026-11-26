use super::child_result_delivery_tests::{
    ChatConversation, move_child_to_chat, spawn_linked_child,
};
use super::*;
use dure_app::{
    AgentPendingRequestKindV1, AgentTimelineLifecycleStateV1, AgentTimelineMessageRoleV1,
};

const OBSERVATION_CAPABILITY: &str = "agent_spawn.conversation_observation.v1";

/// Reads a Run's status as `dure wait` does when it watches a child.
async fn run_status(state: &ServiceState, operation_id: &OperationIdV1, observe: bool) -> Value {
    let mut wire = orchestration_backend_request(state, "observe-run", "", Value::Null);
    wire.operation = "agent_spawn.status".into();
    wire.expected.required_capabilities = vec!["agent_spawn.status".into()];
    wire.body = json!({ "schemaVersion": 1, "operationId": operation_id });
    if observe {
        wire.expected
            .required_capabilities
            .push(OBSERVATION_CAPABILITY.into());
        wire.body["observeConversation"] = json!(true);
    }
    dispatch(state, &wire).await.unwrap()
}

#[tokio::test]
async fn a_runs_status_tells_a_watcher_what_its_chat_agent_is_doing() {
    let (_root, state, _launcher, _prompt_deliverer) =
        fixture_with_delivery(vec![LaunchOutcome::Succeed], Vec::new()).await;
    let (child, _repository) = spawn_linked_child(&state).await;
    let run = &child.operation_id;

    // A client that does not ask reads the status exactly as before.
    let plain = run_status(&state, run, false).await;
    assert_eq!(plain["receipt"]["operationId"], json!(run));
    assert!(plain.get("conversation").is_none());

    // In a terminal the Host is the authority, so there is no conversation.
    assert_eq!(
        run_status(&state, run, true).await["conversation"],
        Value::Null
    );

    // Moved into Chat, the agent is observed through its conversation, on
    // the runtime it runs on now rather than the one it was launched on.
    let binding = move_child_to_chat(&state, &child.plan.agent_id).await;
    let mut chat = ChatConversation {
        binding,
        sequence: 0,
    };
    chat.commit(
        &state,
        vec![
            chat.message("user-1", AgentTimelineMessageRoleV1::User, "Fix #12"),
            chat.lifecycle("started-1", AgentTimelineLifecycleStateV1::TurnStarted),
        ],
    )
    .await;
    let working = run_status(&state, run, true).await["conversation"].clone();
    assert_eq!(working["state"], "observed");
    assert_eq!(working["interactionSessionId"], "child-chat");
    assert_eq!(working["timelineEpoch"], "child-chat-timeline");
    assert_eq!(working["attention"], "none");
    assert_eq!(working["quiescent"], false);
    assert_eq!(working["turnCompletedSequence"], Value::Null);

    chat.commit(
        &state,
        vec![chat.ask("permission-1", AgentPendingRequestKindV1::Permission)],
    )
    .await;
    assert_eq!(
        run_status(&state, run, true).await["conversation"]["attention"],
        "approval_required"
    );

    chat.commit(
        &state,
        vec![
            chat.answer("permission-1"),
            chat.message("answer-1", AgentTimelineMessageRoleV1::Assistant, "Fixed"),
            chat.lifecycle("completed-1", AgentTimelineLifecycleStateV1::TurnCompleted),
        ],
    )
    .await;
    let finished = run_status(&state, run, true).await["conversation"].clone();
    assert_eq!(finished["activity"], "waiting");
    assert_eq!(finished["attention"], "none");
    assert_eq!(finished["quiescent"], true);
    let first = finished["turnCompletedSequence"]
        .as_str()
        .unwrap()
        .to_owned();

    // The next finished turn has a larger position in the same timeline.
    chat.commit(
        &state,
        vec![
            chat.message("user-2", AgentTimelineMessageRoleV1::User, "And #13"),
            chat.lifecycle("started-2", AgentTimelineLifecycleStateV1::TurnStarted),
            chat.lifecycle("completed-2", AgentTimelineLifecycleStateV1::TurnCompleted),
        ],
    )
    .await;
    let next = run_status(&state, run, true).await["conversation"]["turnCompletedSequence"]
        .as_str()
        .unwrap()
        .parse::<i64>()
        .unwrap();
    assert!(next > first.parse::<i64>().unwrap());

    // A stopped chat runtime says so instead of reading as unobservable.
    chat.stop(&state).await;
    assert_eq!(
        run_status(&state, run, true).await["conversation"],
        json!({ "state": "stopped" })
    );
}
