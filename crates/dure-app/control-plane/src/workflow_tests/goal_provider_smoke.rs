//! Shared behavioral observations for actual-provider goal QA.
use crate::ServiceState;
use dure_app::{
    AgentGoalStatusV1, AgentGoalStore, AgentInteractionBindingV1, AgentTimelineItemBodyV1,
    AgentTimelineLifecycleStateV1, AgentTimelineReadDirectionV1, AgentTimelineReadRequestV1,
    AgentTimelineReadV1, AgentTimelineStore,
};
use std::{collections::BTreeSet, fs, path::Path, sync::Arc, time::Duration};
use tokio::{net::UnixListener, task::JoinHandle};

pub(crate) const HUMAN_INPUT: &str = "Create a Dure Pro goal to determine the total parcels from first.txt and second.txt, using the installed dure-orchestration MCP goal tools. In this first segment, read only first.txt, report its count with SEGMENT_ONE, and end the turn with the Dure goal still active. In the next automatic segment, read second.txt, combine the observed values, report the verified total with SEGMENT_TWO, and complete the Dure goal using those tools. Do not use a shell client for goal control. Do not write files or ask a person to choose the next step.";

pub(crate) fn serve(state: Arc<ServiceState>, endpoint: &Path) -> JoinHandle<()> {
    let listener = UnixListener::bind(endpoint).unwrap();
    let server_state = state;
    tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (stream, _) = accepted.unwrap();
                    connections.spawn(crate::handle_connection(Arc::clone(&server_state), stream));
                }
                done = connections.join_next(), if !connections.is_empty() => { done.unwrap().unwrap().unwrap(); }
            }
        }
    })
}

pub(crate) async fn start(state: &ServiceState, binding: &AgentInteractionBindingV1) {
    assert!(!HUMAN_INPUT.contains(binding.agent_id.as_str()));
    assert!(
        state
            .store
            .agent_goal(&binding.agent_id)
            .await
            .unwrap()
            .is_none()
    );
    state.agent_conversations.dispatch("agent_conversation.start_turn", &serde_json::json!({
        "schemaVersion": 1, "interactionSessionId": binding.interaction_session_id,
        "runtime": binding.runtime, "turnId": "qa-first-human-request", "clientMessageId": "qa-first-human-request",
        "input": HUMAN_INPUT, "requestedAtMs": crate::now_ms().unwrap(),
    })).await.unwrap().unwrap();
}

pub(crate) async fn observe(
    state: &ServiceState,
    binding: &AgentInteractionBindingV1,
    root: &Path,
    expected: AgentGoalStatusV1,
) {
    let mut shown = BTreeSet::new();
    loop {
        let read = state
            .store
            .read_agent_timeline(&AgentTimelineReadRequestV1 {
                schema_version: 1,
                interaction_session_id: binding.interaction_session_id.clone(),
                direction: AgentTimelineReadDirectionV1::Tail,
                cursor: None,
                limit: 100,
            })
            .await
            .unwrap();
        let AgentTimelineReadV1::Page { page } = read else {
            panic!("goal conversation changed")
        };
        if let Some(failed) = page.rows.iter().find(|row| {
            matches!(
                row.item.body,
                AgentTimelineItemBodyV1::Lifecycle {
                    state: AgentTimelineLifecycleStateV1::TurnFailed
                        | AgentTimelineLifecycleStateV1::TurnCanceled,
                    ..
                }
            )
        }) {
            panic!("actual provider segment failed: {:?}", failed.item.body);
        }
        for pending in &page.pending_requests {
            let key = pending.request.request_id.as_str();
            let answer_path = root.join("permission-answer.json");
            if shown.insert(key.to_owned()) {
                println!(
                    "goal-permission-review: {}",
                    serde_json::json!({"key": key, "request": pending, "answerFile": answer_path})
                );
            }
            if let Ok(source) = fs::read(&answer_path) {
                let answer: serde_json::Value = serde_json::from_slice(&source).unwrap();
                assert_eq!(answer["key"], key);
                assert!(matches!(
                    answer["decision"].as_str(),
                    Some("allow" | "deny")
                ));
                fs::remove_file(answer_path).unwrap();
                state.agent_conversations.dispatch("agent_conversation.answer_pending", &serde_json::json!({
                        "schemaVersion": 1, "interactionSessionId": pending.interaction_session_id,
                        "runtime": pending.runtime, "requestId": pending.request.request_id,
                        "clientMessageId": pending.request.client_message_id,
                        "idempotencyKey": format!("qa-goal-answer-{key}"),
                        "answer": {"decision": answer["decision"]}, "requestedAtMs": crate::now_ms().unwrap(),
                    })).await.unwrap().unwrap();
            }
        }
        let Some(goal) = state.store.agent_goal(&binding.agent_id).await.unwrap() else {
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        };
        assert!(
            !matches!(
                goal.status,
                AgentGoalStatusV1::Paused | AgentGoalStatusV1::Failed
            ),
            "goal stopped: {goal:?}"
        );
        if expected == AgentGoalStatusV1::Active
            && page.active_turn.is_none()
            && page.rows.iter().any(|row| {
                matches!(
                    row.item.body,
                    AgentTimelineItemBodyV1::Lifecycle {
                        state: AgentTimelineLifecycleStateV1::TurnCompleted,
                        ..
                    }
                )
            })
        {
            assert_eq!(goal.status, AgentGoalStatusV1::Active);
            assert!(!page.rows.iter().any(|row| matches!(
                row.item.body,
                AgentTimelineItemBodyV1::GoalContinuation { .. }
            )));
            println!(
                "goal-backend-restart-boundary: {}",
                serde_json::json!({"generation": state.descriptor.generation, "goal": goal})
            );
            break;
        }
        if goal.status == AgentGoalStatusV1::Complete && page.active_turn.is_none() {
            let automatic = page
                .rows
                .iter()
                .filter(|row| {
                    matches!(
                        row.item.body,
                        AgentTimelineItemBodyV1::GoalContinuation { .. }
                    )
                })
                .count();
            assert_eq!(
                automatic, 1,
                "one automatic continuation must follow the initial human request"
            );
            let finished = page
                .rows
                .iter()
                .filter(|row| {
                    matches!(
                        row.item.body,
                        AgentTimelineItemBodyV1::Lifecycle {
                            state: AgentTimelineLifecycleStateV1::TurnCompleted,
                            ..
                        }
                    )
                })
                .count();
            assert_eq!(finished, 2, "both actual provider turns must finish");
            let first_completion = page
                .rows
                .iter()
                .position(|row| {
                    matches!(
                        row.item.body,
                        AgentTimelineItemBodyV1::Lifecycle {
                            state: AgentTimelineLifecycleStateV1::TurnCompleted,
                            ..
                        }
                    )
                })
                .unwrap();
            let continuation = page
                .rows
                .iter()
                .position(|row| {
                    matches!(
                        row.item.body,
                        AgentTimelineItemBodyV1::GoalContinuation { .. }
                    )
                })
                .unwrap();
            assert!(
                first_completion < continuation,
                "the second turn starts only after the first is complete"
            );
            let output = page
                .rows
                .iter()
                .filter_map(|row| match &row.item.body {
                    AgentTimelineItemBodyV1::Message {
                        role: dure_app::AgentTimelineMessageRoleV1::Assistant,
                        markdown,
                    } => Some(markdown.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                output.contains("CONFIG_PRESERVED"),
                "configured developer instructions were lost: {output}"
            );
            assert!(
                output.contains("SEGMENT_ONE")
                    && output.contains("SEGMENT_TWO")
                    && output.contains("43"),
                "missing observed result: {output}"
            );
            let completed_goal_tools = page
                .rows
                .iter()
                .filter_map(|row| match &row.item.body {
                    AgentTimelineItemBodyV1::Tool {
                        name,
                        state: dure_app::AgentTimelineToolStateV1::Completed,
                        input: Some(input),
                        output: Some(output),
                        ..
                    } if output["error"].is_null() => {
                        if name == "mcpToolCall" {
                            input["tool"].as_str()
                        } else {
                            name.strip_prefix("mcp__dure-orchestration__")
                        }
                    }
                    _ => None,
                })
                .collect::<BTreeSet<_>>();
            assert!(
                completed_goal_tools.contains("agent_goal_get"),
                "missing installed MCP goal read: {completed_goal_tools:?}"
            );
            assert!(
                completed_goal_tools.contains("agent_goal_put"),
                "missing installed MCP goal write: {completed_goal_tools:?}"
            );
            println!(
                "goal-real-provider: {}",
                serde_json::json!({"agentId": binding.agent_id, "conversation": binding.interaction_session_id, "runtime": binding.runtime, "providerTurns": finished, "automaticContinuations": automatic, "goal": goal.status, "installedTools": completed_goal_tools, "total": 43})
            );
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
