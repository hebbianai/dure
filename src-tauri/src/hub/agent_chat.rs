//! A phone reads and drives one chat-owned agent's conversation (#562).
//!
//! # Who decides what
//!
//! - **The backend** owns the timeline, the turns, the queue and the pending
//!   requests (`agent_conversation.*`). This module asks it exactly what the
//!   desktop's structured chat asks (`src/lib/ipc/dureAgentConversation.ts`),
//!   on the backend profile the screen published for the agent.
//! - **The send rule** is the desktop composer's
//!   (`AgentChatSessionController.steerOrQueue` and `send`): a message starts
//!   a turn when none runs, steers the running turn, and waits behind it when
//!   the provider cannot be steered.
//! - **This module** routes (this desktop's box, agents the sidebar listed),
//!   projects the timeline to what may cross to the phone
//!   (`dure_hub_protocol::agent_chat`), and names the backend ids after the
//!   phone's action id, so a retried press finds what it already did instead
//!   of doing it twice.

use super::conversation::BoxRoute;
use super::layout::LayoutState;
use dure_app::{
    AgentInputReceiptV1, AgentInteractionBindingV1, AgentPendingAnswerReceiptV1,
    AgentPendingAnswerStateV1, AgentPendingRequestKindV1, AgentPendingRequestV1,
    AgentTimelineItemBodyV1, AgentTimelineLifecycleStateV1, AgentTimelineMessageRoleV1,
    AgentTimelinePageV1, AgentTimelineReadV1, AgentTimelineTextKindV1, AgentTimelineToolStateV1,
    AgentTurnEffectReceiptV1, AgentTurnEffectStateV1,
};
use dure_hub_protocol::agent_chat::{
    encode_action, encode_timeline, valid_action_id, AgentChatAnswer, AgentChatDelivery,
    AgentChatItem, AgentChatOption, AgentChatPending, AgentChatPendingKind, AgentChatQuestion,
    AgentChatQueued, AgentChatRefusal, AgentChatRole, AgentChatStatus, AgentChatTimeline,
    AgentChatToolState, AgentChatTurn, HubAgentChatActionResult, HubAgentChatTimelineResult,
    MAX_AGENT_CHAT_ITEMS,
};
use dure_hub_protocol::conversation::normalize_agent_prompt;
use dure_hub_protocol::frame::FrameError;
use dure_hub_protocol::hello::HubRequest;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// A failed backend request, by the backend's or the transport's code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackendFailure {
    pub code: String,
    pub message: String,
}

/// The side that carries one request to a backend profile and returns the
/// operation's result. The desktop's backend transport in the app; a script
/// in the tests.
pub trait ChatBackend: Send + Sync {
    fn request(
        &self,
        profile_id: &str,
        operation: &str,
        body: Value,
    ) -> Result<Value, BackendFailure>;
}

/// One write the phone asks for, named by its press. A message's text is
/// already normalized (`normalize_agent_prompt`) when it gets here.
#[derive(Clone, Copy, Debug)]
pub enum ChatAction<'a> {
    Send {
        text: &'a str,
    },
    Interrupt {
        turn_id: &'a str,
    },
    Answer {
        request_id: &'a str,
        answer: &'a AgentChatAnswer,
    },
}

/// The side that answers the phone's chat requests.
pub trait AgentChatSink: Send + Sync {
    fn timeline(
        &self,
        agent_id: &str,
        before: Option<u64>,
        limit: Option<u32>,
    ) -> HubAgentChatTimelineResult;
    fn act(
        &self,
        agent_id: &str,
        action_id: &str,
        action: ChatAction<'_>,
    ) -> HubAgentChatActionResult;
}

type Refusal = (AgentChatRefusal, String);

/// Answer one chat request as its frame, or `None` for any other request.
///
/// Only this desktop's own box serves chat, and only with a sink. `route`
/// names a box the way `Attach` does.
pub fn answer_request(
    sink: Option<&dyn AgentChatSink>,
    route: impl Fn(&str) -> BoxRoute,
    request: &HubRequest,
) -> Option<Result<Vec<u8>, FrameError>> {
    let admit = |box_id: &str| match route(box_id) {
        BoxRoute::Remote => Err((
            AgentChatRefusal::RemoteUnsupported,
            "Chat for agents on remote hosts is not served yet".to_string(),
        )),
        BoxRoute::Unknown => Err((
            AgentChatRefusal::AgentNotFound,
            "This desktop serves no such agent".to_string(),
        )),
        BoxRoute::Local => sink.ok_or((
            AgentChatRefusal::Unavailable,
            "This desktop cannot serve agent chat".to_string(),
        )),
    };
    let act = |box_id: &str, agent_id: &str, action_id: &str, action: ChatAction<'_>| {
        let result = match admit(box_id) {
            Ok(_) if !valid_action_id(action_id) => HubAgentChatActionResult::refused(
                AgentChatRefusal::InvalidRequest,
                "The press has no valid name",
            ),
            Ok(sink) => sink.act(agent_id, action_id, action),
            Err((code, detail)) => HubAgentChatActionResult::refused(code, detail),
        };
        encode_action(&result)
    };
    Some(match request {
        HubRequest::AgentChatTimelineV1 {
            box_id,
            agent_id,
            before,
            limit,
        } => {
            let result = match admit(box_id) {
                Ok(sink) => sink.timeline(agent_id, *before, *limit),
                Err((code, detail)) => HubAgentChatTimelineResult::refused(code, detail),
            };
            encode_timeline(&result)
        }
        // The same normalization the phone applied, so both sides agree on
        // the bytes and the limit; the refusal names the limit.
        HubRequest::AgentChatSendV1 {
            box_id,
            agent_id,
            action_id,
            text,
        } => match normalize_agent_prompt(text) {
            Ok(text) => act(
                box_id,
                agent_id,
                action_id,
                ChatAction::Send { text: &text },
            ),
            Err(error) => encode_action(&HubAgentChatActionResult::refused(
                AgentChatRefusal::InvalidRequest,
                error.to_string(),
            )),
        },
        HubRequest::AgentChatInterruptV1 {
            box_id,
            agent_id,
            action_id,
            turn_id,
        } => act(
            box_id,
            agent_id,
            action_id,
            ChatAction::Interrupt { turn_id },
        ),
        HubRequest::AgentChatAnswerV1 {
            box_id,
            agent_id,
            action_id,
            request_id,
            answer,
        } => act(
            box_id,
            agent_id,
            action_id,
            ChatAction::Answer { request_id, answer },
        ),
        _ => return None,
    })
}

/// Chat-owned agents the sidebar listed, served from their backend profile.
pub struct BackendAgentChats {
    pub layout: Arc<LayoutState>,
    pub backend: Arc<dyn ChatBackend>,
    /// The clock `requestedAtMs` is read from.
    pub now_ms: fn() -> i64,
}

/// The agent's binding and the profile its conversation lives on.
struct Bound {
    profile_id: String,
    binding: AgentInteractionBindingV1,
}

impl BackendAgentChats {
    fn call(
        &self,
        profile_id: &str,
        operation: &str,
        body: Value,
    ) -> Result<Value, BackendFailure> {
        self.backend.request(profile_id, operation, body)
    }

    fn bound(&self, agent_id: &str) -> Result<Bound, Refusal> {
        let Some(agent) = self.layout.chat_agent(agent_id) else {
            return Err((
                AgentChatRefusal::AgentNotFound,
                "This desktop lists no such chat agent".to_string(),
            ));
        };
        let result = self
            .call(
                &agent.backend_profile_id,
                "agent_conversation.inspect",
                json!({ "schemaVersion": 1, "agentId": agent.agent_id }),
            )
            .map_err(read_refusal)?;
        match result.get("binding") {
            None | Some(Value::Null) => Err((
                AgentChatRefusal::AgentNotFound,
                "This agent has no chat".to_string(),
            )),
            Some(binding) => serde_json::from_value::<AgentInteractionBindingV1>(binding.clone())
                .map(|binding| Bound {
                    profile_id: agent.backend_profile_id,
                    binding,
                })
                .map_err(|_| unreadable()),
        }
    }

    /// One timeline page: the newest, or the one before `before`.
    fn page(
        &self,
        bound: &Bound,
        before: Option<u64>,
        limit: usize,
    ) -> Result<AgentTimelinePageV1, Refusal> {
        let (direction, cursor) = match before {
            None => ("tail", Value::Null),
            Some(sequence) => (
                "before",
                json!({ "epoch": bound.binding.timeline_epoch, "sequence": sequence }),
            ),
        };
        let result = self
            .call(
                &bound.profile_id,
                "agent_conversation.read",
                json!({
                    "schemaVersion": 1,
                    "interactionSessionId": bound.binding.interaction_session_id,
                    "direction": direction,
                    "cursor": cursor,
                    "limit": limit,
                }),
            )
            .map_err(read_refusal)?;
        match field::<AgentTimelineReadV1>(&result, "read").ok_or_else(unreadable)? {
            AgentTimelineReadV1::Page { page } => Ok(*page),
            AgentTimelineReadV1::Reset { .. } => Err((
                AgentChatRefusal::Unavailable,
                "The conversation was reset. Read it again".to_string(),
            )),
        }
    }

    /// What every action is decided on: the agent's binding and its current
    /// page, with the running turn and the pending requests.
    fn current(&self, agent_id: &str) -> Result<(Bound, AgentTimelinePageV1), Refusal> {
        let bound = self.bound(agent_id)?;
        let page = self.page(&bound, None, 1)?;
        Ok((bound, page))
    }

    /// What became of a message this press already sent, if anything.
    fn earlier_send(
        &self,
        bound: &Bound,
        message_id: &str,
        turn_id: &str,
    ) -> Result<Option<HubAgentChatActionResult>, Refusal> {
        let result = self
            .call(
                &bound.profile_id,
                "agent_conversation.inspect_input",
                json!({
                    "schemaVersion": 1,
                    "interactionSessionId": bound.binding.interaction_session_id,
                    "clientMessageId": message_id,
                }),
            )
            .map_err(read_refusal)?;
        if result.get("input").is_none_or(Value::is_null) {
            return Ok(None);
        }
        Ok(Some(
            match field::<AgentInputReceiptV1>(&result, "input").ok_or_else(unreadable)? {
                AgentInputReceiptV1::Queued { .. } => {
                    HubAgentChatActionResult::done(Some(AgentChatDelivery::Queued))
                }
                AgentInputReceiptV1::Turn { receipt } => {
                    let delivery = if receipt.intent.turn_id.as_str() == turn_id {
                        AgentChatDelivery::Started
                    } else {
                        AgentChatDelivery::Steered
                    };
                    turn_outcome(Some(&receipt), delivery)
                }
            },
        ))
    }

    fn send_message(
        &self,
        bound: &Bound,
        page: &AgentTimelinePageV1,
        action_id: &str,
        input: &str,
    ) -> HubAgentChatActionResult {
        let turn_id = format!("phone-turn-{action_id}");
        let message_id = format!("phone-message-{action_id}");
        match self.earlier_send(bound, &message_id, &turn_id) {
            Ok(Some(earlier)) => return earlier,
            Ok(None) => {}
            Err((code, detail)) => return HubAgentChatActionResult::refused(code, detail),
        }
        let intent = |turn_id: &str| {
            json!({
                "schemaVersion": 1,
                "interactionSessionId": bound.binding.interaction_session_id,
                "runtime": bound.binding.runtime,
                "turnId": turn_id,
                "clientMessageId": message_id,
                "input": input,
                "requestedAtMs": (self.now_ms)(),
            })
        };
        let write = |operation: &str, turn_id: &str| {
            self.call(&bound.profile_id, operation, intent(turn_id))
        };
        let Some(active) = &page.active_turn else {
            return write("agent_conversation.start_turn", &turn_id).map_or_else(
                |failure| write_failure(&failure),
                |result| {
                    turn_outcome(
                        field(&result, "receipt").as_ref(),
                        AgentChatDelivery::Started,
                    )
                },
            );
        };
        match write("agent_conversation.steer_turn", active.turn_id.as_str()) {
            Ok(result) => turn_outcome(
                field(&result, "receipt").as_ref(),
                AgentChatDelivery::Steered,
            ),
            // The provider has no steering channel: wait behind the turn, as
            // the desktop composer does.
            Err(failure) if failure.code == "agent_conversation_steer_unsupported" => {
                write("agent_conversation.enqueue_turn", &turn_id).map_or_else(
                    |failure| write_failure(&failure),
                    |_| HubAgentChatActionResult::done(Some(AgentChatDelivery::Queued)),
                )
            }
            Err(failure) => write_failure(&failure),
        }
    }

    fn interrupt_turn(
        &self,
        bound: &Bound,
        page: &AgentTimelinePageV1,
        action_id: &str,
        turn_id: &str,
    ) -> HubAgentChatActionResult {
        let Some(active) = &page.active_turn else {
            return HubAgentChatActionResult::refused(
                AgentChatRefusal::NotRunning,
                "No turn is running",
            );
        };
        if active.turn_id.as_str() != turn_id {
            return HubAgentChatActionResult::refused(
                AgentChatRefusal::TurnChanged,
                "Another turn is running now. Read the conversation again",
            );
        }
        self.call(
            &bound.profile_id,
            "agent_conversation.interrupt_turn",
            json!({
                "schemaVersion": 1,
                "interactionSessionId": bound.binding.interaction_session_id,
                "runtime": bound.binding.runtime,
                "turnId": active.turn_id,
                "clientMessageId": active.client_message_id,
                "interruptRequestId": format!("phone-interrupt-{action_id}"),
                "requestedAtMs": (self.now_ms)(),
            }),
        )
        .map_or_else(
            |failure| write_failure(&failure),
            |_| HubAgentChatActionResult::done(None),
        )
    }

    fn answer_pending(
        &self,
        bound: &Bound,
        page: &AgentTimelinePageV1,
        action_id: &str,
        request_id: &str,
        answer: &AgentChatAnswer,
    ) -> HubAgentChatActionResult {
        let Some(pending) = page
            .pending_requests
            .iter()
            .find(|pending| pending.request.request_id.as_str() == request_id)
        else {
            return HubAgentChatActionResult::refused(
                AgentChatRefusal::RequestNotFound,
                "The request is no longer waiting for an answer",
            );
        };
        let answer = match provider_answer(pending, answer) {
            Ok(answer) => answer,
            Err(detail) => {
                return HubAgentChatActionResult::refused(AgentChatRefusal::InvalidRequest, detail)
            }
        };
        let body = json!({
            "schemaVersion": 1,
            "interactionSessionId": pending.interaction_session_id,
            "runtime": pending.runtime,
            "requestId": pending.request.request_id,
            "clientMessageId": pending.request.client_message_id,
            "idempotencyKey": format!("phone-answer-{action_id}"),
            "answer": answer,
            "requestedAtMs": (self.now_ms)(),
        });
        match self.call(&bound.profile_id, "agent_conversation.answer_pending", body) {
            Ok(result) => {
                let receipt = field::<AgentPendingAnswerReceiptV1>(&result, "receipt");
                let effect = receipt
                    .as_ref()
                    .map_or(Effect::Unconfirmed, |receipt| match receipt.state {
                        AgentPendingAnswerStateV1::Succeeded => Effect::Done,
                        AgentPendingAnswerStateV1::Failed => Effect::Failed,
                        AgentPendingAnswerStateV1::Prepared
                        | AgentPendingAnswerStateV1::Uncertain => Effect::Unconfirmed,
                    });
                effect_result(
                    effect,
                    receipt
                        .as_ref()
                        .and_then(|receipt| receipt.provider_receipt.as_ref()),
                    None,
                )
            }
            Err(failure) => write_failure(&failure),
        }
    }
}

impl AgentChatSink for BackendAgentChats {
    fn timeline(
        &self,
        agent_id: &str,
        before: Option<u64>,
        limit: Option<u32>,
    ) -> HubAgentChatTimelineResult {
        let limit = limit
            .and_then(|limit| usize::try_from(limit).ok())
            .map_or(MAX_AGENT_CHAT_ITEMS, |limit| {
                limit.clamp(1, MAX_AGENT_CHAT_ITEMS)
            });
        let read = self
            .bound(agent_id)
            .and_then(|bound| self.page(&bound, before, limit).map(|page| (bound, page)));
        match read {
            Ok((bound, page)) => {
                HubAgentChatTimelineResult::timeline(project(&bound.binding, page))
            }
            Err((code, detail)) => HubAgentChatTimelineResult::refused(code, detail),
        }
    }

    fn act(
        &self,
        agent_id: &str,
        action_id: &str,
        action: ChatAction<'_>,
    ) -> HubAgentChatActionResult {
        let (bound, page) = match self.current(agent_id) {
            Ok(current) => current,
            Err((code, detail)) => return HubAgentChatActionResult::refused(code, detail),
        };
        match action {
            ChatAction::Send { text } => self.send_message(&bound, &page, action_id, text),
            ChatAction::Interrupt { turn_id } => {
                self.interrupt_turn(&bound, &page, action_id, turn_id)
            }
            ChatAction::Answer { request_id, answer } => {
                self.answer_pending(&bound, &page, action_id, request_id, answer)
            }
        }
    }
}

/// The answer in the shape the desktop's pending card sends.
fn provider_answer(
    pending: &AgentPendingRequestV1,
    answer: &AgentChatAnswer,
) -> Result<Value, String> {
    match (&pending.request.kind, answer) {
        (AgentPendingRequestKindV1::Permission, AgentChatAnswer::Permission { allow }) => {
            Ok(json!({ "decision": if *allow { "allow" } else { "deny" } }))
        }
        (AgentPendingRequestKindV1::Question, AgentChatAnswer::Question { answers }) => {
            let Some(questions) = questions(&pending.request.payload) else {
                return Err("This question can be answered on the desktop only".to_string());
            };
            if questions.iter().any(|question| {
                answers
                    .get(&question.id)
                    .is_none_or(|answer| answer.trim().is_empty())
            }) || answers
                .keys()
                .any(|id| !questions.iter().any(|question| &question.id == id))
            {
                return Err("Answer every question, and only those asked".to_string());
            }
            Ok(json!({ "answers": answers }))
        }
        _ => Err("The answer does not fit the request".to_string()),
    }
}

/// The timeline as it may cross to the phone.
fn project(binding: &AgentInteractionBindingV1, page: AgentTimelinePageV1) -> AgentChatTimeline {
    let sequence = |value: i64| u64::try_from(value).unwrap_or(0);
    let older = page
        .has_more
        .then(|| page.rows.first().map(|row| sequence(row.cursor.sequence)))
        .flatten();
    let mut items: Vec<AgentChatItem> = Vec::new();
    // A tool call's later rows report its later state; the phone shows one row
    // per call, where it started.
    let mut tools: HashMap<String, usize> = HashMap::new();
    for row in page.rows {
        let at = sequence(row.cursor.sequence);
        match row.item.body {
            AgentTimelineItemBodyV1::Message { role, markdown } => {
                if markdown.trim().is_empty() {
                    continue;
                }
                items.push(AgentChatItem::Message {
                    sequence: at,
                    role: match role {
                        AgentTimelineMessageRoleV1::User => AgentChatRole::User,
                        AgentTimelineMessageRoleV1::Assistant => AgentChatRole::Agent,
                    },
                    text: markdown,
                    truncated: false,
                });
            }
            AgentTimelineItemBodyV1::Tool {
                tool_call_id,
                name,
                state,
                ..
            } => {
                let state = tool_state(&state);
                if let Some(AgentChatItem::Tool { state: shown, .. }) = tools
                    .get(&tool_call_id)
                    .and_then(|index| items.get_mut(*index))
                {
                    *shown = state;
                    continue;
                }
                tools.insert(tool_call_id, items.len());
                items.push(AgentChatItem::Tool {
                    sequence: at,
                    name,
                    state,
                });
            }
            AgentTimelineItemBodyV1::Lifecycle { state, .. } => {
                let state = match state {
                    AgentTimelineLifecycleStateV1::TurnFailed => AgentChatStatus::TurnFailed,
                    AgentTimelineLifecycleStateV1::TurnCanceled => AgentChatStatus::TurnCanceled,
                    AgentTimelineLifecycleStateV1::SessionFailed => AgentChatStatus::SessionFailed,
                    AgentTimelineLifecycleStateV1::SessionExited => AgentChatStatus::SessionExited,
                    _ => continue,
                };
                items.push(AgentChatItem::Status {
                    sequence: at,
                    state,
                });
            }
            AgentTimelineItemBodyV1::Error { message, .. } => {
                items.push(AgentChatItem::Error {
                    sequence: at,
                    message,
                });
            }
            // Reasoning, plans, tool inputs, answers already given and the
            // provider's evidence stay on the desktop.
            _ => {}
        }
    }
    let turn = page.active_turn.as_ref().map(|turn| AgentChatTurn {
        turn_id: turn.turn_id.to_string(),
    });
    let live_text = page.active_turn.as_ref().and_then(|_| {
        page.live_text
            .iter()
            .filter(|head| {
                head.kind == AgentTimelineTextKindV1::Assistant && !head.text.trim().is_empty()
            })
            .max_by_key(|head| head.updated_at_ms)
            .map(|head| head.text.clone())
    });
    AgentChatTimeline {
        provider_id: binding.provider_id.as_str().to_string(),
        items,
        older,
        history_complete: binding.history_complete,
        latest: sequence(page.final_cursor.sequence),
        turn,
        live_text,
        pending: page
            .pending_requests
            .iter()
            .map(pending_for_phone)
            .collect(),
        queued: page
            .queued_inputs
            .inputs
            .into_iter()
            .map(|input| AgentChatQueued {
                preview: input.preview,
            })
            .collect(),
    }
}

fn tool_state(state: &AgentTimelineToolStateV1) -> AgentChatToolState {
    match state {
        AgentTimelineToolStateV1::Running => AgentChatToolState::Running,
        AgentTimelineToolStateV1::Completed => AgentChatToolState::Completed,
        AgentTimelineToolStateV1::Failed => AgentChatToolState::Failed,
        AgentTimelineToolStateV1::Canceled => AgentChatToolState::Canceled,
    }
}

fn text_field(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string)
}

/// A pending request with only what may cross: a permission's names, or a
/// question and its choices.
fn pending_for_phone(pending: &AgentPendingRequestV1) -> AgentChatPending {
    let payload = &pending.request.payload;
    let kind = match pending.request.kind {
        AgentPendingRequestKindV1::Permission => AgentChatPendingKind::Permission {
            tool_name: text_field(payload.get("toolName")),
            display_name: text_field(payload.pointer("/presentation/displayName")),
        },
        AgentPendingRequestKindV1::Question => match questions(payload) {
            Some(questions) => AgentChatPendingKind::Question { questions },
            None => AgentChatPendingKind::Unknown,
        },
    };
    AgentChatPending {
        request_id: pending.request.request_id.to_string(),
        kind,
    }
}

/// The provider-normalized questions, read the way the desktop's card reads
/// them (`cli/lib/contracts/agent-pending-presentation.mjs`).
fn questions(payload: &Value) -> Option<Vec<AgentChatQuestion>> {
    let listed = payload.pointer("/input/questions")?.as_array()?;
    if listed.is_empty() {
        return None;
    }
    listed
        .iter()
        .map(|question| {
            let text = text_field(question.get("question"))?;
            let options = question
                .get("options")?
                .as_array()?
                .iter()
                .map(|option| {
                    Some(AgentChatOption {
                        label: text_field(option.get("label"))?,
                        description: text_field(option.get("description")),
                    })
                })
                .collect::<Option<Vec<_>>>()?;
            let flag = |name: &str| question.get(name).and_then(Value::as_bool) == Some(true);
            Some(AgentChatQuestion {
                id: text_field(question.get("id")).unwrap_or_else(|| text.clone()),
                header: text_field(question.get("header")),
                multi_select: flag("multiSelect"),
                allow_other: flag("allowOther") || options.is_empty(),
                is_secret: flag("isSecret"),
                question: text,
                options,
            })
        })
        .collect()
}

/// One field of a backend result, in its domain type.
fn field<T: serde::de::DeserializeOwned>(result: &Value, name: &str) -> Option<T> {
    result
        .get(name)
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

/// Where a write the backend answered ended up, whatever its receipt type.
enum Effect {
    Done,
    Failed,
    /// Prepared, uncertain, or a receipt this desktop could not read.
    Unconfirmed,
}

fn effect_result(
    effect: Effect,
    provider_receipt: Option<&Value>,
    delivery: Option<AgentChatDelivery>,
) -> HubAgentChatActionResult {
    match effect {
        Effect::Done => HubAgentChatActionResult::done(delivery),
        Effect::Failed => HubAgentChatActionResult::refused(
            AgentChatRefusal::Rejected,
            provider_detail(provider_receipt),
        ),
        Effect::Unconfirmed => HubAgentChatActionResult::unknown(
            "Delivery could not be confirmed. Read the conversation before trying again",
        ),
    }
}

/// A turn receipt as the phone hears it.
fn turn_outcome(
    receipt: Option<&AgentTurnEffectReceiptV1>,
    delivery: AgentChatDelivery,
) -> HubAgentChatActionResult {
    let effect = receipt.map_or(Effect::Unconfirmed, |receipt| match receipt.state {
        AgentTurnEffectStateV1::Accepted => Effect::Done,
        AgentTurnEffectStateV1::Failed => Effect::Failed,
        AgentTurnEffectStateV1::Prepared | AgentTurnEffectStateV1::Uncertain => Effect::Unconfirmed,
    });
    effect_result(
        effect,
        receipt.and_then(|receipt| receipt.provider_receipt.as_ref()),
        Some(delivery),
    )
}

/// What the provider said when it failed, as the desktop shows it.
fn provider_detail(receipt: Option<&Value>) -> String {
    let code = receipt.and_then(|receipt| text_field(receipt.get("errorCode")));
    let detail = receipt.and_then(|receipt| text_field(receipt.get("errorDetail")));
    match (code, detail) {
        (Some(code), Some(detail)) => format!("{code}: {detail}"),
        (None, Some(detail)) => detail,
        (Some(code), None) => code,
        (None, None) => "The agent did not take it".to_string(),
    }
}

fn unreadable() -> Refusal {
    (
        AgentChatRefusal::Unavailable,
        "The desktop could not read its backend's answer".to_string(),
    )
}

/// The backend's own refusals: nothing was done.
fn backend_refusal(code: &str) -> Option<AgentChatRefusal> {
    match code {
        "agent_conversation_not_found" => Some(AgentChatRefusal::AgentNotFound),
        "agent_conversation_request_invalid" => Some(AgentChatRefusal::InvalidRequest),
        "agent_conversation_runtime_unavailable" => Some(AgentChatRefusal::RuntimeUnavailable),
        "agent_conversation_provider_failed" | "agent_conversation_steer_unsupported" => {
            Some(AgentChatRefusal::Rejected)
        }
        _ => None,
    }
}

fn failure_detail(failure: &BackendFailure) -> String {
    format!("{} ({})", failure.message, failure.code)
}

/// A read that failed. Nothing was changed, so every failure is a refusal.
fn read_refusal(failure: BackendFailure) -> Refusal {
    (
        backend_refusal(&failure.code).unwrap_or(AgentChatRefusal::Unavailable),
        failure_detail(&failure),
    )
}

/// A write that failed. The backend's own refusals did nothing; anything else
/// — the transport broke, a conflict with an earlier attempt — may have.
fn write_failure(failure: &BackendFailure) -> HubAgentChatActionResult {
    match backend_refusal(&failure.code) {
        Some(code) => HubAgentChatActionResult::refused(code, failure_detail(failure)),
        None => HubAgentChatActionResult::unknown(format!(
            "The desktop could not confirm it ({}). Read the conversation before trying again",
            failure.code
        )),
    }
}

/// The desktop's backend transport, for the hub's threads.
pub struct TransportBackend {
    pub app: tauri::AppHandle,
}

impl ChatBackend for TransportBackend {
    fn request(
        &self,
        profile_id: &str,
        operation: &str,
        body: Value,
    ) -> Result<Value, BackendFailure> {
        use tauri::Manager;
        let state = self
            .app
            .state::<crate::dure_backend_transport::DureBackendTransportState>();
        // The hub serves each phone on its own thread, outside the async
        // runtime, so it may wait here.
        tauri::async_runtime::block_on(state.request_result(profile_id, operation, body)).map_err(
            |error| BackendFailure {
                code: error.code().to_string(),
                message: error.message().to_string(),
            },
        )
    }
}

#[cfg(test)]
#[path = "agent_chat_tests.rs"]
mod tests;
