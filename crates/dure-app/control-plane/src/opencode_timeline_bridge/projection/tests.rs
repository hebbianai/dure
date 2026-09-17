use super::*;

#[test]
fn provider_replies_keep_the_admitted_turn_without_duplicating_dure_input() {
    let context = TurnContext {
        turn_id: AgentTurnIdV1::new("turn-exact").unwrap(),
        client_message_id: AgentClientMessageIdV1::new("client-exact").unwrap(),
    };
    let user = user_message_id(&context.client_message_id);
    let mut turns = BTreeMap::from([(user.clone(), context.clone())]);
    let (input, _) = message_items(
        &json!({
            "info": {"id": user, "role": "user", "time": {"created": 1}},
            "parts": [{"id": "part_user", "type": "text", "text": "한글 input"}],
        }),
        &mut turns,
    )
    .unwrap();
    assert!(
        input
            .iter()
            .all(|item| !matches!(item.body, AgentTimelineItemBodyV1::Message { .. }))
    );
    let (reply, completed) = message_items(&json!({
        "info": {"id": "msg_reply", "parentID": user, "role": "assistant", "finish": "stop", "time": {"created": 2, "completed": 3}},
        "parts": [{"id": "part_answer", "type": "text", "text": "Exact answer"}],
    }), &mut turns).unwrap();
    assert_eq!(completed, Some(user));
    assert_eq!(reply.len(), 2);
    assert!(
        reply
            .iter()
            .all(|item| item.turn_id.as_ref() == Some(&context.turn_id)
                && item.client_message_id.as_ref() == Some(&context.client_message_id))
    );
}

#[test]
fn tool_completion_does_not_complete_the_conversation_turn() {
    let mut turns = BTreeMap::new();
    let mut message = json!({
        "info": {"id": "msg_tool", "parentID": "msg_user", "role": "assistant", "finish": "tool-calls", "time": {"created": 2, "completed": 3}},
        "parts": [{"id": "part_tool", "type": "tool", "callID": "call_exact", "tool": "bash", "state": {"status": "running", "input": {"command": "pwd"}}}],
    });
    let (running, completed) = message_items(&message, &mut turns).unwrap();
    assert_eq!(completed, None);
    message["parts"][0]["state"]["status"] = json!("completed");
    message["parts"][0]["state"]["output"] = json!("/fixture");
    let (finished, completed) = message_items(&message, &mut turns).unwrap();
    assert_eq!(completed, None);
    assert_ne!(running[0].item_id, finished[0].item_id);
    assert_eq!(
        running[0].provider_message_id,
        finished[0].provider_message_id
    );
    assert!(matches!(
        finished[0].body,
        AgentTimelineItemBodyV1::Tool {
            state: AgentTimelineToolStateV1::Completed,
            ..
        }
    ));
}

#[test]
fn ordered_questions_and_permission_decisions_use_provider_reply_shapes() {
    assert_eq!(
        pending_answer(
            PendingKind::Permission,
            &json!({}),
            &json!({"decision": "deny"})
        )
        .unwrap(),
        json!({"reply": "reject"})
    );
    assert!(
        pending_answer(
            PendingKind::Permission,
            &json!({}),
            &json!({"decision": "invalid"})
        )
        .is_err()
    );
    let request = json!({"questions": [{"question": "First?"}, {"question": "Second?"}]});
    assert_eq!(
        pending_answer(
            PendingKind::Question,
            &request,
            &json!({"answers": {"q1": "B", "q0": "A"}})
        )
        .unwrap(),
        json!({"answers": [["A"], ["B"]]})
    );
    assert!(
        pending_answer(
            PendingKind::Question,
            &request,
            &json!({"answers": {"q0": "A"}})
        )
        .is_err()
    );
}
