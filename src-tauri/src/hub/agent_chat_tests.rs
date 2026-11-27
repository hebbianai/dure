use super::*;
use crate::hub::layout::{ChatAgent, SessionPlacement, SidebarLayout};
use dure_hub_protocol::agent_chat::{
    read_action, read_timeline, read_watch_event, AgentChatActionState, AgentChatTimelineOutcome,
};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;

type Handler = Box<dyn Fn(&str, &Value) -> Result<Value, BackendFailure> + Send + Sync>;

/// A backend that answers from a script and records what it was asked.
struct Scripted {
    calls: Mutex<Vec<(String, String, Value)>>,
    handler: Handler,
    /// What the next subscription delivers; none refuses it.
    subscription: Mutex<Option<ChatChanges>>,
}

impl Scripted {
    fn new(
        handler: impl Fn(&str, &Value) -> Result<Value, BackendFailure> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            handler: Box::new(handler),
            subscription: Mutex::new(None),
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

    fn subscribe(&self, profile_id: &str, body: Value) -> Result<ChatChanges, BackendFailure> {
        self.calls.lock().unwrap().push((
            profile_id.to_string(),
            "agent_conversation.subscribe".to_string(),
            body,
        ));
        self.subscription
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| failure("backend_subscription_capacity"))
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

/// The provider behind the chat ended. The message waits in the
/// conversation's queue, which makes the backend relaunch the provider on the
/// same conversation and then start it, whether or not a turn was showing.
#[test]
fn a_message_to_an_agent_whose_provider_ended_waits_for_its_relaunch() {
    for active in [false, true] {
        let backend = backend(active, |operation, body| match operation {
            "agent_conversation.start_turn" | "agent_conversation.steer_turn" => {
                Err(failure("agent_conversation_runtime_unavailable"))
            }
            "agent_conversation.enqueue_turn" => {
                Ok(json!({"schemaVersion": 1, "receipt": {"intent": body}}))
            }
            other => panic!("unexpected {other}"),
        });
        let result = send(&chats(&backend), "press-1", "are you still there?");
        assert_eq!(result.state, AgentChatActionState::Done, "{result:?}");
        assert_eq!(result.delivery, Some(AgentChatDelivery::Relaunching));
        let queued = backend.body_of("agent_conversation.enqueue_turn");
        assert_eq!(queued["turnId"], "phone-turn-press-1");
        assert_eq!(queued["clientMessageId"], "phone-message-press-1");
        assert_eq!(queued["input"], "are you still there?");
        assert_eq!(
            queued["runtime"],
            json!({"runtimeGeneration": "runtime-1", "providerEpoch": "provider-1"})
        );
        assert_eq!(
            backend.operations().last().map(String::as_str),
            Some("agent_conversation.enqueue_turn")
        );
    }
}

/// Queuing it can fail too; that is reported like any other write.
#[test]
fn a_message_the_queue_refuses_after_the_provider_ended_is_refused() {
    let backend = backend(false, |operation, _| match operation {
        "agent_conversation.start_turn" => Err(failure("agent_conversation_runtime_unavailable")),
        "agent_conversation.enqueue_turn" => Err(failure("agent_conversation_not_found")),
        other => panic!("unexpected {other}"),
    });
    let result = send(&chats(&backend), "press-1", "hi");
    assert_eq!(result.state, AgentChatActionState::Refused, "{result:?}");
    assert_eq!(result.code, Some(AgentChatRefusal::AgentNotFound));
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

/// Set when the watch let its subscription go.
struct Released(Arc<AtomicBool>);

impl Drop for Released {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Give `backend` one subscription, fed by the returned sender.
fn subscribed(backend: &Scripted) -> (Sender<Value>, Arc<AtomicBool>) {
    let (events, receiver) = channel();
    let released = Arc::new(AtomicBool::new(false));
    *backend.subscription.lock().unwrap() =
        Some(ChatChanges::new(receiver, Released(Arc::clone(&released))));
    (events, released)
}

fn changed() -> Value {
    json!({"kind": "event", "event": {"topic": "agent_conversation.changed"}})
}

/// The phone end of a watch: what reached it, until it leaves after `stays`
/// frames.
struct Phone {
    received: Vec<u8>,
    stays: usize,
}

impl Phone {
    fn staying() -> Self {
        Self {
            received: Vec::new(),
            stays: usize::MAX,
        }
    }

    fn signals(&self) -> Vec<AgentChatWatchSignal> {
        let mut reader = self.received.as_slice();
        let mut signals = Vec::new();
        while !reader.is_empty() {
            signals.push(read_watch_event(&mut reader).expect("a frame").signal);
        }
        signals
    }
}

impl Write for Phone {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if self.stays == 0 {
            return Err(std::io::ErrorKind::BrokenPipe.into());
        }
        self.stays -= 1;
        self.received.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

const PACE: WatchPace = WatchPace {
    coalesce: Duration::from_millis(200),
    quiet: Duration::from_secs(30),
};

/// Serve `agent-1`'s watch on this desktop's box to `phone`.
fn watch(backend: &Arc<Scripted>, phone: &mut Phone, pace: WatchPace) {
    serve_watch(
        phone,
        Some(&chats(backend)),
        BoxRoute::Local,
        "agent-1",
        pace,
    );
}

#[test]
fn a_watch_subscribes_to_the_agents_conversation_and_says_it_is_watching() {
    let backend = backend(false, |_, _| unreachable!());
    let (events, released) = subscribed(&backend);
    drop(events);
    let mut phone = Phone::staying();
    watch(&backend, &mut phone, PACE);
    assert_eq!(phone.signals(), [AgentChatWatchSignal::Watching]);
    assert_eq!(
        backend.body_of("agent_conversation.subscribe"),
        json!({
            "schemaVersion": 1,
            "interactionSessionId": "interaction-1",
            "direction": "tail",
            "cursor": null,
            "limit": 1,
        })
    );
    assert_eq!(backend.calls.lock().unwrap()[1].0, "local");
    assert!(released.load(Ordering::Acquire));
}

/// A burst of deltas is told at once and once more at the end of the
/// window, never once per delta, and the last change is not left untold.
#[test]
fn a_burst_of_changes_is_told_twice() {
    let backend = backend(false, |_, _| unreachable!());
    let (events, _released) = subscribed(&backend);
    for _ in 0..50 {
        events.send(changed()).unwrap();
    }
    drop(events);
    let mut phone = Phone::staying();
    watch(&backend, &mut phone, PACE);
    assert_eq!(
        phone.signals(),
        [
            AgentChatWatchSignal::Watching,
            AgentChatWatchSignal::Changed,
            AgentChatWatchSignal::Changed,
        ]
    );
}

#[test]
fn a_lone_change_is_told_once() {
    let backend = backend(false, |_, _| unreachable!());
    let (events, _released) = subscribed(&backend);
    events.send(changed()).unwrap();
    drop(events);
    let mut phone = Phone::staying();
    watch(&backend, &mut phone, PACE);
    assert_eq!(
        phone.signals(),
        [
            AgentChatWatchSignal::Watching,
            AgentChatWatchSignal::Changed
        ]
    );
}

/// A quiet watch says so, and a phone that left is noticed on the next write,
/// which lets the subscription go.
#[test]
fn a_quiet_watch_says_so_and_lets_go_when_the_phone_leaves() {
    let backend = backend(false, |_, _| unreachable!());
    let (_events, released) = subscribed(&backend);
    let mut phone = Phone {
        received: Vec::new(),
        stays: 3,
    };
    let pace = WatchPace {
        coalesce: Duration::from_millis(200),
        quiet: Duration::from_millis(5),
    };
    watch(&backend, &mut phone, pace);
    assert_eq!(
        phone.signals(),
        [
            AgentChatWatchSignal::Watching,
            AgentChatWatchSignal::Quiet,
            AgentChatWatchSignal::Quiet,
        ]
    );
    assert!(released.load(Ordering::Acquire));
}

/// The transport's terminal error ends the subscription, and the stream with
/// it: the phone keeps asking on its interval and watches again later.
#[test]
fn a_watch_ends_with_its_subscription() {
    let backend = backend(false, |_, _| unreachable!());
    let (events, _released) = subscribed(&backend);
    events
        .send(json!({"kind": "error", "error": {"code": "backend_unavailable"}}))
        .unwrap();
    let mut phone = Phone::staying();
    watch(&backend, &mut phone, PACE);
    assert_eq!(phone.signals(), [AgentChatWatchSignal::Watching]);
}

#[test]
fn a_watch_that_cannot_open_is_refused_with_its_reason() {
    let refused = |chats: Option<&BackendAgentChats>, route: BoxRoute, agent_id: &str| {
        let mut phone = Phone::staying();
        serve_watch(
            &mut phone,
            chats.map(|chats| chats as &dyn AgentChatSink),
            route,
            agent_id,
            PACE,
        );
        let mut reader = phone.received.as_slice();
        let event = read_watch_event(&mut reader).expect("a frame");
        assert!(reader.is_empty(), "the refusal is the only frame");
        assert_eq!(event.signal, AgentChatWatchSignal::Refused);
        event.code.expect("a reason")
    };
    let backend = backend(false, |_, _| unreachable!());
    let chats = chats(&backend);
    assert_eq!(
        refused(Some(&chats), BoxRoute::Remote, "agent-1"),
        AgentChatRefusal::RemoteUnsupported
    );
    assert_eq!(
        refused(Some(&chats), BoxRoute::Unknown, "agent-1"),
        AgentChatRefusal::AgentNotFound
    );
    assert_eq!(
        refused(None, BoxRoute::Local, "agent-1"),
        AgentChatRefusal::Unavailable
    );
    assert_eq!(
        refused(Some(&chats), BoxRoute::Local, "agent-unlisted"),
        AgentChatRefusal::AgentNotFound
    );
    assert!(!backend
        .operations()
        .contains(&"agent_conversation.subscribe".to_string()));
    // The backend refused the subscription itself.
    assert_eq!(
        refused(Some(&chats), BoxRoute::Local, "agent-1"),
        AgentChatRefusal::Unavailable
    );
}

/// The listener serves a watch on a paired phone's TLS stream like any other
/// request — the greeting, the ack, then the signals — and closes it when the
/// subscription ends.
#[test]
fn a_paired_phone_watches_over_tls() {
    use crate::hub::catalog::{HubCatalog, HUB_CATALOG_VERSION};
    use crate::hub::devices::DeviceRegistry;
    use crate::hub::identity;
    use crate::hub::server::{CatalogSource, GatewayProcess, HubServer, HubServices};
    use dure_hub_protocol::hello;
    use std::io::Read as _;
    use std::net::TcpStream;

    struct NoSessions;
    impl CatalogSource for NoSessions {
        fn catalog(&self) -> HubCatalog {
            HubCatalog {
                chat_sessions: Vec::new(),
                hub_catalog_version: HUB_CATALOG_VERSION,
                layout: None,
                push_registration: None,
                sessions: Vec::new(),
                unreachable: Vec::new(),
            }
        }
    }

    let _ = rustls::crypto::ring::default_provider().install_default();
    let root = tempfile::tempdir().unwrap();
    let certificate = identity::load_or_create_certificate(root.path()).unwrap();
    let registry = Arc::new(DeviceRegistry::new(root.path()));
    let token = registry.register("test phone".into()).unwrap().token;
    let backend = backend(false, |_, _| unreachable!());
    let (events, released) = subscribed(&backend);
    let server = HubServer::default();
    let services = HubServices::with_gateway(
        Arc::new(NoSessions),
        GatewayProcess {
            box_id: "this-laptop".to_string(),
            binary: std::path::PathBuf::new(),
            discovery_root: root.path().to_path_buf(),
        },
    )
    .serving_agent_chats(Arc::new(chats(&backend)));
    let port = server
        .start_with_gateway("127.0.0.1", 0, &certificate, registry, services)
        .unwrap()
        .port
        .unwrap();

    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(certificate.der))
        .unwrap();
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut tls = rustls::StreamOwned::new(
        rustls::ClientConnection::new(Arc::new(config), "hebbian-hub.local".try_into().unwrap())
            .unwrap(),
        socket,
    );
    let greeting = hello::encode_hello_for(
        &token,
        HubRequest::AgentChatWatchV1 {
            box_id: "this-laptop".to_string(),
            agent_id: "agent-1".to_string(),
        },
    )
    .unwrap();
    tls.write_all(&greeting).unwrap();
    tls.flush().unwrap();
    hello::read_ack(&mut tls).unwrap();

    assert_eq!(
        read_watch_event(&mut tls).unwrap().signal,
        AgentChatWatchSignal::Watching
    );
    events.send(changed()).unwrap();
    assert_eq!(
        read_watch_event(&mut tls).unwrap().signal,
        AgentChatWatchSignal::Changed
    );

    drop(events);
    let mut rest = Vec::new();
    let _ = tls.read_to_end(&mut rest);
    assert!(
        rest.is_empty(),
        "nothing follows the end of the subscription"
    );
    assert!(released.load(Ordering::Acquire));
    server.stop();
}
