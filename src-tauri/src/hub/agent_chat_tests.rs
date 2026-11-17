use super::*;
use crate::hub::layout::{ChatAgent, SessionPlacement, SidebarLayout};
use dure_hub_protocol::agent_chat::{
    read_action, read_timeline, AgentChatActionState, AgentChatTimelineOutcome,
};
use std::collections::BTreeMap;
use std::sync::Mutex;

type Handler = Box<dyn Fn(&str, &Value) -> Result<Value, BackendFailure> + Send + Sync>;

/// A backend that answers from a script and records what it was asked.
struct Scripted {
    calls: Mutex<Vec<(String, String, Value)>>,
    handler: Handler,
}

impl Scripted {
    fn new(
        handler: impl Fn(&str, &Value) -> Result<Value, BackendFailure> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            handler: Box::new(handler),
        })
    }

    fn operations(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|(_, operation, _)| operation.clone())
            .collect()
    }

    fn body_of(&self, operation: &str) -> Value {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .find(|(_, called, _)| called == operation)
            .map(|(_, _, body)| body.clone())
            .unwrap_or_else(|| panic!("{operation} was not called"))
    }
}

impl ChatBackend for Scripted {
    fn request(
        &self,
        profile_id: &str,
        operation: &str,
        body: Value,
    ) -> Result<Value, BackendFailure> {
        self.calls.lock().unwrap().push((
            profile_id.to_string(),
            operation.to_string(),
            body.clone(),
        ));
        (self.handler)(operation, &body)
    }
}

fn failure(code: &str) -> BackendFailure {
    BackendFailure {
        code: code.to_string(),
        message: "refused".to_string(),
    }
}

fn binding() -> Value {
    json!({
        "schemaVersion": 1,
        "interactionSessionId": "interaction-1",
        "agentId": "agent-1",
        "providerId": "claude",
        "executionProfile": {"kind": "provider_default"},
        "providerConversationRef": null,
        "runtime": {"runtimeGeneration": "runtime-1", "providerEpoch": "provider-1"},
        "timelineEpoch": "timeline-1",
        "bindingRevision": 1,
        "historyComplete": true,
        "createdAtMs": 1,
        "updatedAtMs": 1,
    })
}

fn row(sequence: i64, body: Value) -> Value {
    json!({
        "cursor": {"epoch": "timeline-1", "sequence": sequence},
        "item": {
            "itemId": format!("item-{sequence}"),
            "turnId": null,
            "clientMessageId": null,
            "providerMessageId": null,
            "body": body,
            "createdAtMs": 1,
        },
    })
}

const SECRET: &str = "rm -rf /home/someone/secret";

fn permission() -> Value {
    json!({
        "interactionSessionId": "interaction-1",
        "runtime": {"runtimeGeneration": "runtime-1", "providerEpoch": "provider-1"},
        "request": {
            "requestId": "request-1",
            "kind": "permission",
            "turnId": "turn-a",
            "clientMessageId": "message-a",
            "payload": {
                "toolName": "Bash",
                "input": {"command": SECRET},
                "presentation": {
                    "title": format!("Claude wants to run {SECRET}"),
                    "displayName": "Run command",
                    "description": SECRET,
                    "blockedPath": "/home/someone/secret",
                },
            },
            "createdAtMs": 1,
        },
    })
}

fn question() -> Value {
    json!({
        "interactionSessionId": "interaction-1",
        "runtime": {"runtimeGeneration": "runtime-1", "providerEpoch": "provider-1"},
        "request": {
            "requestId": "request-2",
            "kind": "question",
            "turnId": "turn-a",
            "clientMessageId": "message-a",
            "payload": {"input": {"questions": [{
                "question": "Which database?",
                "header": "Storage",
                "options": [{"label": "SQLite", "description": "One file"}, {"label": "Postgres"}],
            }]}},
            "createdAtMs": 1,
        },
    })
}

fn page(active: bool) -> Value {
    json!({
        "type": "page",
        "page": {
            "binding": binding(),
            "rows": [
                row(4, json!({"type": "message", "role": "user", "markdown": "Fix the build"})),
                row(5, json!({"type": "reasoning", "text": "private thoughts"})),
                row(6, json!({"type": "tool", "tool_call_id": "call-1", "name": "Bash", "state": "running", "input": {"command": SECRET}, "output": null})),
                row(7, json!({"type": "tool_input", "json_text": SECRET})),
                row(8, json!({"type": "tool", "tool_call_id": "call-1", "name": "Bash", "state": "completed", "input": {"command": SECRET}, "output": "secret output"})),
                row(9, json!({"type": "message", "role": "assistant", "markdown": "Done."})),
                row(10, json!({"type": "lifecycle", "state": "turn_completed", "detail": null})),
                row(11, json!({"type": "lifecycle", "state": "turn_canceled", "detail": null})),
            ],
            "liveText": [{
                "streamId": "stream-1", "itemId": "item-live", "kind": "assistant",
                "text": "Looking at it", "turnId": "turn-a", "clientMessageId": "message-a",
                "providerMessageId": "provider-message-1", "updatedAtMs": 2,
            }],
            "pendingRequests": [permission(), question()],
            "activeTurn": if active { json!({"turnId": "turn-a", "clientMessageId": "message-a"}) } else { Value::Null },
            "latestFailure": null,
            "recovery": null,
            "goal": null,
            "queuedInputs": {"interactionSessionId": "interaction-1", "inputs": [
                {"clientMessageId": "queued-1", "sequence": 1, "preview": "then run lint"},
            ], "nextAfter": null},
            "finalCursor": {"epoch": "timeline-1", "sequence": 11},
            "hasMore": true,
        },
    })
}

fn receipt(body: &Value, state: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "receipt": {
            "intent": body,
            "state": state,
            "providerReceipt": if state == "failed" { json!({"errorCode": "usage_limit", "errorDetail": "Try later"}) } else { Value::Null },
            "timelineCursor": {"epoch": "timeline-1", "sequence": 12},
            "newlyPrepared": true,
            "updatedAtMs": 2,
        },
    })
}

/// A backend with one listed agent, an active turn or none, and `writes` for
/// the write operations.
fn backend(
    active: bool,
    writes: impl Fn(&str, &Value) -> Result<Value, BackendFailure> + Send + Sync + 'static,
) -> Arc<Scripted> {
    Scripted::new(move |operation, body| match operation {
        "agent_conversation.inspect" => Ok(json!({"schemaVersion": 1, "binding": binding()})),
        "agent_conversation.read" => Ok(json!({"schemaVersion": 1, "read": page(active)})),
        "agent_conversation.inspect_input" => Ok(json!({"schemaVersion": 1, "input": null})),
        other => writes(other, body),
    })
}

fn layout() -> Arc<LayoutState> {
    let state = LayoutState::default();
    state.set(SidebarLayout {
        placements: HashMap::from([(
            "agent-1".to_string(),
            SessionPlacement {
                desktop: "Workspace".to_string(),
                project: "dure".to_string(),
                title: "Fix the build".to_string(),
                order: 0,
                branch: None,
                presentation: None,
            },
        )]),
        desktop_order: vec!["Workspace".to_string()],
        chat_agents: vec![ChatAgent {
            agent_id: "agent-1".to_string(),
            backend_profile_id: "local".to_string(),
            provider_id: "claude".to_string(),
        }],
        ..Default::default()
    });
    Arc::new(state)
}

fn chats(backend: &Arc<Scripted>) -> BackendAgentChats {
    BackendAgentChats {
        layout: layout(),
        backend: Arc::clone(backend) as Arc<dyn ChatBackend>,
        now_ms: || 1_700_000_000_000,
    }
}

fn shown(result: HubAgentChatTimelineResult) -> AgentChatTimeline {
    assert_eq!(
        result.outcome,
        AgentChatTimelineOutcome::Timeline,
        "{result:?}"
    );
    result.timeline.expect("a timeline")
}

/// The frame the hub writes for one request, served the way `server.rs`
/// serves it: `this-laptop` is this desktop's box.
fn served(sink: Option<&dyn AgentChatSink>, route: BoxRoute, request: HubRequest) -> Vec<u8> {
    answer_request(sink, |_| route, &request)
        .expect("a chat request")
        .expect("encodes")
}

fn read(
    chats: &BackendAgentChats,
    agent_id: &str,
    before: Option<u64>,
    limit: Option<u32>,
) -> HubAgentChatTimelineResult {
    let request = HubRequest::AgentChatTimelineV1 {
        box_id: "this-laptop".to_string(),
        agent_id: agent_id.to_string(),
        before,
        limit,
    };
    read_timeline(&mut served(Some(chats), BoxRoute::Local, request).as_slice()).expect("reads")
}

fn acted(chats: &BackendAgentChats, request: HubRequest) -> HubAgentChatActionResult {
    read_action(&mut served(Some(chats), BoxRoute::Local, request).as_slice()).expect("reads")
}

fn send(chats: &BackendAgentChats, action_id: &str, text: &str) -> HubAgentChatActionResult {
    acted(
        chats,
        HubRequest::AgentChatSendV1 {
            box_id: "this-laptop".to_string(),
            agent_id: "agent-1".to_string(),
            action_id: action_id.to_string(),
            text: text.to_string(),
        },
    )
}

fn interrupt(
    chats: &BackendAgentChats,
    action_id: &str,
    turn_id: &str,
) -> HubAgentChatActionResult {
    acted(
        chats,
        HubRequest::AgentChatInterruptV1 {
            box_id: "this-laptop".to_string(),
            agent_id: "agent-1".to_string(),
            action_id: action_id.to_string(),
            turn_id: turn_id.to_string(),
        },
    )
}

fn answer(
    chats: &BackendAgentChats,
    request_id: &str,
    answer: AgentChatAnswer,
) -> HubAgentChatActionResult {
    acted(
        chats,
        HubRequest::AgentChatAnswerV1 {
            box_id: "this-laptop".to_string(),
            agent_id: "agent-1".to_string(),
            action_id: "answer-1".to_string(),
            request_id: request_id.to_string(),
            answer,
        },
    )
}

#[test]
fn only_this_desktops_box_is_served() {
    let backend = backend(false, |_, _| unreachable!());
    let chats = chats(&backend);
    let timeline = || HubRequest::AgentChatTimelineV1 {
        box_id: "elsewhere".to_string(),
        agent_id: "agent-1".to_string(),
        before: None,
        limit: None,
    };
    let send = || HubRequest::AgentChatSendV1 {
        box_id: "elsewhere".to_string(),
        agent_id: "agent-1".to_string(),
        action_id: "press-1".to_string(),
        text: "hi".to_string(),
    };
    for (route, code) in [
        (BoxRoute::Remote, AgentChatRefusal::RemoteUnsupported),
        (BoxRoute::Unknown, AgentChatRefusal::AgentNotFound),
    ] {
        let read = read_timeline(&mut served(Some(&chats), route, timeline()).as_slice()).unwrap();
        assert_eq!(read.code, Some(code));
        let sent = read_action(&mut served(Some(&chats), route, send()).as_slice()).unwrap();
        assert_eq!(sent.code, Some(code));
    }
    let unserved =
        read_timeline(&mut served(None, BoxRoute::Local, timeline()).as_slice()).unwrap();
    assert_eq!(unserved.code, Some(AgentChatRefusal::Unavailable));
    assert!(backend.operations().is_empty());
}

#[test]
fn other_requests_are_not_chat_requests() {
    assert!(answer_request(None, |_| BoxRoute::Local, &HubRequest::Catalog).is_none());
}

/// The phone names what the catalog gave it; an agent the sidebar did not
/// list never reaches the backend.
#[test]
fn an_agent_the_sidebar_did_not_list_is_not_found() {
    let backend = backend(false, |_, _| unreachable!());
    let result = read(&chats(&backend), "agent-elsewhere", None, None);
    assert_eq!(result.code, Some(AgentChatRefusal::AgentNotFound));
    assert!(backend.operations().is_empty());
}

#[test]
fn an_agent_without_a_chat_is_not_found() {
    let backend = Scripted::new(|_, _| Ok(json!({"schemaVersion": 1, "binding": null})));
    let result = read(&chats(&backend), "agent-1", None, None);
    assert_eq!(result.code, Some(AgentChatRefusal::AgentNotFound));
}

#[test]
fn the_timeline_crosses_as_messages_and_tool_names() {
    let backend = backend(true, |_, _| unreachable!());
    let timeline = shown(read(&chats(&backend), "agent-1", None, Some(50)));
    assert_eq!(
        timeline.items,
        vec![
            AgentChatItem::Message {
                sequence: 4,
                role: AgentChatRole::User,
                text: "Fix the build".to_string(),
                truncated: false,
            },
            AgentChatItem::Tool {
                sequence: 6,
                name: "Bash".to_string(),
                state: AgentChatToolState::Completed,
            },
            AgentChatItem::Message {
                sequence: 9,
                role: AgentChatRole::Agent,
                text: "Done.".to_string(),
                truncated: false,
            },
            AgentChatItem::Status {
                sequence: 11,
                state: AgentChatStatus::TurnCanceled,
            },
        ]
    );
    assert_eq!(timeline.provider_id, "claude");
    assert_eq!(timeline.older, Some(4));
    assert!(timeline.history_complete);
    assert_eq!(timeline.latest, 11);
    assert_eq!(
        timeline.turn,
        Some(AgentChatTurn {
            turn_id: "turn-a".to_string()
        })
    );
    assert_eq!(timeline.live_text.as_deref(), Some("Looking at it"));
    assert_eq!(
        timeline.queued,
        vec![AgentChatQueued {
            preview: "then run lint".to_string()
        }]
    );
    let read = backend.body_of("agent_conversation.read");
    assert_eq!(read["direction"], "tail");
    assert_eq!(read["limit"], 50);
    assert_eq!(read["interactionSessionId"], "interaction-1");
}

/// The privacy ruling of #359: tool inputs and outputs, a permission's title
/// and description (which quote the input) and reasoning stay on the desktop.
#[test]
fn tool_inputs_and_reasoning_never_cross() {
    let backend = backend(true, |_, _| unreachable!());
    let result = read(&chats(&backend), "agent-1", None, None);
    let encoded = String::from_utf8(serde_json::to_vec(&result).unwrap()).unwrap();
    for private in [
        SECRET,
        "secret output",
        "private thoughts",
        "Claude wants to run",
        "/home/someone",
    ] {
        assert!(!encoded.contains(private), "{private} crossed: {encoded}");
    }
    let timeline = shown(result);
    assert_eq!(
        timeline.pending,
        vec![
            AgentChatPending {
                request_id: "request-1".to_string(),
                kind: AgentChatPendingKind::Permission {
                    tool_name: Some("Bash".to_string()),
                    display_name: Some("Run command".to_string()),
                },
            },
            AgentChatPending {
                request_id: "request-2".to_string(),
                kind: AgentChatPendingKind::Question {
                    questions: vec![AgentChatQuestion {
                        id: "Which database?".to_string(),
                        question: "Which database?".to_string(),
                        header: Some("Storage".to_string()),
                        options: vec![
                            AgentChatOption {
                                label: "SQLite".to_string(),
                                description: Some("One file".to_string()),
                            },
                            AgentChatOption {
                                label: "Postgres".to_string(),
                                description: None,
                            },
                        ],
                        multi_select: false,
                        allow_other: false,
                        is_secret: false,
                    }],
                },
            },
        ]
    );
}

#[test]
fn an_older_page_is_read_before_the_named_item_on_the_current_epoch() {
    let backend = backend(false, |_, _| unreachable!());
    shown(read(&chats(&backend), "agent-1", Some(4), None));
    let read = backend.body_of("agent_conversation.read");
    assert_eq!(read["direction"], "before");
    assert_eq!(
        read["cursor"],
        json!({"epoch": "timeline-1", "sequence": 4})
    );
    assert_eq!(read["limit"], MAX_AGENT_CHAT_ITEMS);
}

#[test]
fn a_message_starts_a_turn_when_none_runs() {
    let backend = backend(false, |operation, body| match operation {
        "agent_conversation.start_turn" => Ok(receipt(body, "accepted")),
        other => panic!("unexpected {other}"),
    });
    let result = send(&chats(&backend), "press-1", "Run the tests\r\nplease");
    assert_eq!(result.state, AgentChatActionState::Done, "{result:?}");
    assert_eq!(result.delivery, Some(AgentChatDelivery::Started));
    let start = backend.body_of("agent_conversation.start_turn");
    assert_eq!(start["turnId"], "phone-turn-press-1");
    assert_eq!(start["clientMessageId"], "phone-message-press-1");
    assert_eq!(start["input"], "Run the tests\nplease");
    assert_eq!(
        start["runtime"],
        json!({"runtimeGeneration": "runtime-1", "providerEpoch": "provider-1"})
    );
    let inspect = backend.body_of("agent_conversation.inspect_input");
    assert_eq!(inspect["clientMessageId"], "phone-message-press-1");
}

#[test]
fn a_message_steers_the_running_turn() {
    let backend = backend(true, |operation, body| match operation {
        "agent_conversation.steer_turn" => Ok(receipt(body, "accepted")),
        other => panic!("unexpected {other}"),
    });
    let result = send(&chats(&backend), "press-1", "also update the docs");
    assert_eq!(
        result.delivery,
        Some(AgentChatDelivery::Steered),
        "{result:?}"
    );
    assert_eq!(
        backend.body_of("agent_conversation.steer_turn")["turnId"],
        "turn-a"
    );
}

/// The desktop composer's fallback: a provider without steering queues.
#[test]
fn a_message_waits_behind_a_turn_the_provider_cannot_steer() {
    let backend = backend(true, |operation, body| match operation {
        "agent_conversation.steer_turn" => Err(failure("agent_conversation_steer_unsupported")),
        "agent_conversation.enqueue_turn" => {
            Ok(json!({"schemaVersion": 1, "receipt": {"intent": body}}))
        }
        other => panic!("unexpected {other}"),
    });
    let result = send(&chats(&backend), "press-1", "after this, run lint");
    assert_eq!(
        result.delivery,
        Some(AgentChatDelivery::Queued),
        "{result:?}"
    );
    let queued = backend.body_of("agent_conversation.enqueue_turn");
    assert_eq!(queued["turnId"], "phone-turn-press-1");
    assert_eq!(queued["clientMessageId"], "phone-message-press-1");
}

/// A retry after a lost answer finds the message instead of sending another.
#[test]
fn a_retried_press_reports_the_message_it_already_sent() {
    let backend = Scripted::new(|operation, _| match operation {
        "agent_conversation.inspect" => Ok(json!({"schemaVersion": 1, "binding": binding()})),
        "agent_conversation.read" => Ok(json!({"schemaVersion": 1, "read": page(false)})),
        "agent_conversation.inspect_input" => {
            let intent = json!({
                "schemaVersion": 1, "interactionSessionId": "interaction-1",
                "runtime": {"runtimeGeneration": "runtime-1", "providerEpoch": "provider-1"},
                "turnId": "phone-turn-press-1", "clientMessageId": "phone-message-press-1",
                "input": "hi", "requestedAtMs": 1,
            });
            Ok(
                json!({"schemaVersion": 1, "input": {"kind": "turn", "receipt": receipt(&intent, "accepted")["receipt"]}}),
            )
        }
        other => panic!("unexpected {other}"),
    });
    let result = send(&chats(&backend), "press-1", "hi");
    assert_eq!(
        result.delivery,
        Some(AgentChatDelivery::Started),
        "{result:?}"
    );
    assert_eq!(
        backend.operations(),
        [
            "agent_conversation.inspect",
            "agent_conversation.read",
            "agent_conversation.inspect_input"
        ]
    );
}

#[test]
fn a_turn_the_provider_failed_is_refused_with_its_reason() {
    let backend = backend(false, |_, body| Ok(receipt(body, "failed")));
    let result = send(&chats(&backend), "press-1", "hi");
    assert_eq!(result.code, Some(AgentChatRefusal::Rejected));
    assert_eq!(result.detail.as_deref(), Some("usage_limit: Try later"));
}

/// A write whose answer was lost may have happened: say so rather than
/// inviting a second send.
#[test]
fn a_write_the_transport_lost_is_unknown() {
    let backend = backend(false, |_, _| Err(failure("backend_transport_unavailable")));
    let result = send(&chats(&backend), "press-1", "hi");
    assert_eq!(result.state, AgentChatActionState::Unknown);
}

#[test]
fn an_unusable_message_or_press_is_refused_before_the_backend_hears_of_it() {
    let backend = backend(false, |_, _| unreachable!());
    let chats = chats(&backend);
    let long = "x".repeat(4096);
    for (action, text) in [
        ("press-1", "   "),
        ("press-1", "bell\u{7}"),
        ("bad press", "hi"),
        ("press-1", long.as_str()),
    ] {
        let result = send(&chats, action, text);
        assert_eq!(
            result.code,
            Some(AgentChatRefusal::InvalidRequest),
            "{action} {text:?}"
        );
    }
    assert!(backend.operations().is_empty());
}

#[test]
fn an_interrupt_names_the_turn_it_saw() {
    let backend = backend(true, |operation, _| match operation {
        "agent_conversation.interrupt_turn" => Ok(json!({"schemaVersion": 1, "receipt": {}})),
        other => panic!("unexpected {other}"),
    });
    let chats = chats(&backend);
    let moved = interrupt(&chats, "stop-1", "turn-old");
    assert_eq!(moved.code, Some(AgentChatRefusal::TurnChanged));
    assert!(!backend
        .operations()
        .contains(&"agent_conversation.interrupt_turn".to_string()));
    let stopped = interrupt(&chats, "stop-1", "turn-a");
    assert_eq!(stopped.state, AgentChatActionState::Done, "{stopped:?}");
    let body = backend.body_of("agent_conversation.interrupt_turn");
    assert_eq!(body["turnId"], "turn-a");
    assert_eq!(body["clientMessageId"], "message-a");
    assert_eq!(body["interruptRequestId"], "phone-interrupt-stop-1");
}

#[test]
fn nothing_to_interrupt_when_no_turn_runs() {
    let backend = backend(false, |_, _| unreachable!());
    let result = interrupt(&chats(&backend), "stop-1", "turn-a");
    assert_eq!(result.code, Some(AgentChatRefusal::NotRunning));
}

fn answered(body: &Value) -> Result<Value, BackendFailure> {
    Ok(json!({"schemaVersion": 1, "receipt": {
        "intent": body,
        "request": permission(),
        "state": "succeeded",
        "providerReceipt": null,
        "newlyPrepared": true,
        "updatedAtMs": 2,
    }}))
}

#[test]
fn a_permission_is_answered_the_way_the_desktop_card_answers_it() {
    let backend = backend(true, |operation, body| match operation {
        "agent_conversation.answer_pending" => answered(body),
        other => panic!("unexpected {other}"),
    });
    let result = answer(
        &chats(&backend),
        "request-1",
        AgentChatAnswer::Permission { allow: false },
    );
    assert_eq!(result.state, AgentChatActionState::Done, "{result:?}");
    let body = backend.body_of("agent_conversation.answer_pending");
    assert_eq!(body["answer"], json!({"decision": "deny"}));
    assert_eq!(body["requestId"], "request-1");
    assert_eq!(body["clientMessageId"], "message-a");
    assert_eq!(body["idempotencyKey"], "phone-answer-answer-1");
}

#[test]
fn a_question_is_answered_by_question_id() {
    let backend = backend(true, |operation, body| match operation {
        "agent_conversation.answer_pending" => answered(body),
        other => panic!("unexpected {other}"),
    });
    let chats = chats(&backend);
    let partial = answer(
        &chats,
        "request-2",
        AgentChatAnswer::Question {
            answers: BTreeMap::new(),
        },
    );
    assert_eq!(partial.code, Some(AgentChatRefusal::InvalidRequest));
    let wrong_kind = answer(
        &chats,
        "request-2",
        AgentChatAnswer::Permission { allow: true },
    );
    assert_eq!(wrong_kind.code, Some(AgentChatRefusal::InvalidRequest));
    let answers = BTreeMap::from([("Which database?".to_string(), "SQLite".to_string())]);
    let result = answer(&chats, "request-2", AgentChatAnswer::Question { answers });
    assert_eq!(result.state, AgentChatActionState::Done, "{result:?}");
    assert_eq!(
        backend.body_of("agent_conversation.answer_pending")["answer"],
        json!({"answers": {"Which database?": "SQLite"}})
    );
}

#[test]
fn a_request_no_longer_pending_is_not_found() {
    let backend = backend(true, |_, _| unreachable!());
    let result = answer(
        &chats(&backend),
        "request-gone",
        AgentChatAnswer::Permission { allow: true },
    );
    assert_eq!(result.code, Some(AgentChatRefusal::RequestNotFound));
}
