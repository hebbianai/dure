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

/// One tool call or message over the timeline's item bound fits by the shared
/// rule instead of failing the whole message, which fails the history an
/// attach seeds and ends the live event loop.
#[test]
fn oversized_parts_fit_the_timeline_instead_of_failing_the_message() {
    let large = "x".repeat(MAX_AGENT_TIMELINE_JSON_BYTES_V1 + 1);
    let mut turns = BTreeMap::new();
    let tool = |id: &str, input: Value, output: Value| {
        json!({"id": id, "type": "tool", "callID": format!("call_{id}"), "tool": "write",
            "state": {"status": "completed", "input": input, "output": output}})
    };
    let (items, _) = message_items(
        &json!({
            "info": {"id": "msg_large", "parentID": "msg_user", "role": "assistant", "finish": "stop", "time": {"created": 2, "completed": 3}},
            "parts": [
                tool("part_input", json!({"filePath": "/fixture/a", "content": large}), json!("Wrote file")),
                tool("part_output", json!({"filePath": "/fixture/b"}), json!(large)),
                tool("part_both", json!({"content": large}), json!(large)),
                {"id": "part_text", "type": "text", "text": format!("Answer {large}")},
            ],
        }),
        &mut turns,
    )
    .unwrap();
    let tools = items
        .iter()
        .filter_map(|item| match &item.body {
            AgentTimelineItemBodyV1::Tool {
                tool_call_id,
                input,
                output,
                ..
            } => Some((tool_call_id.as_str(), input.clone(), output.clone())),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        tools,
        [
            ("call_part_input", None, Some(json!("Wrote file"))),
            (
                "call_part_output",
                Some(json!({"filePath": "/fixture/b"})),
                None
            ),
            ("call_part_both", None, None),
        ]
    );
    let text = items
        .iter()
        .find_map(|item| match &item.body {
            AgentTimelineItemBodyV1::Message { markdown, .. } => Some(markdown),
            _ => None,
        })
        .unwrap();
    assert!(text.starts_with("Answer xxx") && text.ends_with('…'));
    for item in &items {
        item.validate().unwrap();
    }
}
