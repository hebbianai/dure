//! One chat-owned agent's conversation, read and driven from the phone (#562).
//!
//! # What this is
//!
//! A chat-owned (structured) agent has no terminal: the desktop's backend owns
//! its provider process and keeps its conversation as a timeline
//! (`agent_conversation.*`). This document carries the phone's four questions
//! about one such agent — read the timeline, send a message, interrupt the
//! running turn, answer a pending request — and the desktop's answers. The
//! desktop hub asks its backend exactly what the desktop's own chat asks, so
//! neither the timeline nor the turn rules gain a second owner.
//!
//! # Why the phone names an agent, not a session
//!
//! A chat-owned agent is not an Hmux session, so the catalog lists it apart
//! from the sessions ([`HubChatSession`]) and the phone names it by the
//! `agent_id` that entry gave. The desktop only serves agents it listed.
//!
//! # What does not cross
//!
//! The privacy ruling of #359: tool inputs and outputs stay on the desktop.
//! A tool row carries its name and state only ([`AgentChatItem::Tool`]); a
//! permission request carries the tool's name and the provider's short display
//! name, not its title or description, which quote the input
//! ([`AgentChatPendingKind::Permission`]). A question the agent asks the
//! person crosses with its choices: it is addressed to them and cannot be
//! answered unseen. Reasoning, plans and provider evidence stay too.
//!
//! # Being told of a change
//!
//! While the phone shows the chat it holds one `AgentChatWatchV1` stream open
//! ([`HubAgentChatWatchEvent`]). The desktop subscribes to the conversation
//! the way its own chat does and writes [`AgentChatWatchSignal::Changed`] when
//! it changes, at most once per coalescing window; the phone then reads the
//! newest page again, exactly as a poll would. The stream carries no
//! conversation text, so it adds nothing to what crosses. The phone keeps its
//! interval as the fallback, and only watches an agent whose catalog entry
//! says the desktop answers ([`HubChatSession::watch`]).
//!
//! # Why a separate version
//!
//! Like `conversation`, so a phone that meets a desktop speaking another
//! version of this document loses the chat only, not the session list. A
//! desktop that predates these requests reads them as
//! [`crate::hello::HubRequest::Unsupported`] and closes after the greeting; it
//! also never lists a [`HubChatSession`], so the phone asks only a desktop that
//! answers.

use crate::catalog::SessionPresentation;
use crate::conversation::{
    ConversationError, read_versioned_as, serialized_len, truncate_on_char_boundary,
};
use crate::frame::{self, FrameError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;

/// The version this build speaks.
pub const HUB_AGENT_CHAT_VERSION: u16 = 1;

/// One timeline answer's limit, the transcript's.
pub const MAX_AGENT_CHAT_TIMELINE_BYTES: usize = crate::conversation::MAX_TRANSCRIPT_BYTES;

/// One action answer's limit. It never carries conversation text.
pub const MAX_AGENT_CHAT_ACTION_RESULT_BYTES: usize = 16 * 1024;

/// The most items one timeline answer carries, and the number an absent
/// `limit` asks for. The backend pages at most this many rows at a time.
pub const MAX_AGENT_CHAT_ITEMS: usize = 128;

/// The longest text one message carries. Longer text is cut on a character
/// boundary and the item says so.
pub const MAX_AGENT_CHAT_TEXT_BYTES: usize = crate::conversation::MAX_ENTRY_TEXT_BYTES;

/// The longest name, label or question one field carries.
pub const MAX_AGENT_CHAT_LABEL_BYTES: usize = 2 * 1024;

/// The most queued messages one answer previews.
pub const MAX_AGENT_CHAT_QUEUED: usize = 32;

/// One watch event's limit. It never carries conversation text.
pub const MAX_AGENT_CHAT_WATCH_EVENT_BYTES: usize = 4 * 1024;

/// The longest identifier the phone may send: an action id becomes part of the
/// backend's turn and message ids, which are bounded at 160 bytes.
pub const MAX_AGENT_CHAT_ACTION_ID_BYTES: usize = 64;

/// Room kept free for the fields around the items when they are fitted.
const FRAME_SLACK_BYTES: usize = 1024;

/// A chat-owned agent this desktop lists next to its sessions.
///
/// Rides in `HubCatalog::chat_sessions`, which an older phone ignores, so an
/// older phone never draws a row it cannot open.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubChatSession {
    /// The desktop's agent id. Every request about this agent names it.
    pub agent_id: String,
    /// The provider (`claude`, `codex`, `opencode`, `pi`).
    pub provider_id: String,
    /// The title the desktop's sidebar draws.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<SessionPresentation>,
    /// The box the agent runs on. Only this desktop's own box serves it.
    pub box_id: String,
    pub box_label: String,
    /// This desktop answers `AgentChatWatchV1` for this agent: the chat may be
    /// told when the conversation changes instead of only asking on an
    /// interval. Absent from older desktops, so a phone never opens a watch
    /// that would close without a word; an older phone ignores it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub watch: bool,
}

/// The phone's answer to a pending request.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentChatAnswer {
    /// Allow or deny the tool once, the two buttons of the desktop's card.
    Permission { allow: bool },
    /// The answer to each question, by the question's id: the chosen labels
    /// joined with ", ", or the person's own words.
    Question { answers: BTreeMap<String, String> },
}

/// Who said it.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentChatRole {
    User,
    Agent,
}

/// Where one tool call is.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentChatToolState {
    Running,
    Completed,
    Failed,
    Canceled,
    #[serde(other)]
    Unknown,
}

/// A turn or the agent's session ended other than by completing.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentChatStatus {
    TurnFailed,
    TurnCanceled,
    SessionFailed,
    SessionExited,
    #[serde(other)]
    Unknown,
}

/// One row of the conversation, oldest first in an answer.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentChatItem {
    Message {
        /// The timeline position. Pass the oldest one shown as `before` to
        /// read the page before it.
        sequence: u64,
        role: AgentChatRole,
        text: String,
        /// The text was longer than [`MAX_AGENT_CHAT_TEXT_BYTES`] and was cut.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        truncated: bool,
    },
    /// A tool call, by name and state only.
    Tool {
        sequence: u64,
        name: String,
        state: AgentChatToolState,
    },
    Status {
        sequence: u64,
        state: AgentChatStatus,
    },
    Error {
        sequence: u64,
        message: String,
    },
    /// A kind of row a later build sends.
    #[serde(other)]
    Unknown,
}

impl AgentChatItem {
    /// The timeline position, absent for a row this build cannot read.
    #[must_use]
    pub fn sequence(&self) -> Option<u64> {
        match self {
            Self::Message { sequence, .. }
            | Self::Tool { sequence, .. }
            | Self::Status { sequence, .. }
            | Self::Error { sequence, .. } => Some(*sequence),
            Self::Unknown => None,
        }
    }
}

/// The turn that is running. Name it to interrupt it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentChatTurn {
    pub turn_id: String,
}

/// One choice of a question.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentChatOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One question the agent asks the person.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentChatQuestion {
    /// The key of this question's answer in [`AgentChatAnswer::Question`].
    pub id: String,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default)]
    pub options: Vec<AgentChatOption>,
    #[serde(default)]
    pub multi_select: bool,
    /// The person may answer in their own words.
    #[serde(default)]
    pub allow_other: bool,
    /// The answer is a secret: do not echo it.
    #[serde(default)]
    pub is_secret: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentChatPendingKind {
    /// The agent asks to run a tool. Only its names cross (see the module).
    Permission {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
    },
    Question {
        questions: Vec<AgentChatQuestion>,
    },
    /// A kind of request a later build sends. Answer it on the desktop.
    #[serde(other)]
    Unknown,
}

/// A request waiting for the person.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentChatPending {
    /// Name it to answer this request.
    pub request_id: String,
    #[serde(flatten)]
    pub kind: AgentChatPendingKind,
}

/// A message waiting for the running turn to end.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentChatQueued {
    pub preview: String,
}

/// What the timeline shows now.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentChatTimeline {
    pub provider_id: String,
    /// Oldest first.
    #[serde(default)]
    pub items: Vec<AgentChatItem>,
    /// Older rows exist: pass this as `before` to read them. Absent when the
    /// items start at the beginning of what the desktop holds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub older: Option<u64>,
    /// The desktop holds the conversation from its beginning.
    #[serde(default)]
    pub history_complete: bool,
    /// The newest timeline position. It moves whenever a row is added, so a
    /// client can tell that nothing changed.
    pub latest: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<AgentChatTurn>,
    /// What the agent is writing in the running turn, before it is a message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_text: Option<String>,
    #[serde(default)]
    pub pending: Vec<AgentChatPending>,
    #[serde(default)]
    pub queued: Vec<AgentChatQueued>,
}

/// Why the desktop did not answer with a timeline, or did not act.
///
/// The screen branches on this; `detail` is for a person. A code a later
/// build adds reads as [`Self::Unknown`].
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentChatRefusal {
    /// This desktop lists no such agent, or it has no chat.
    AgentNotFound,
    /// The agent is on a box this desktop does not serve chat for.
    RemoteUnsupported,
    /// The request itself is unusable (an empty or too long message, a
    /// malformed id).
    InvalidRequest,
    /// The turn the request named is not the one running; nothing was done.
    TurnChanged,
    /// No turn is running; nothing was interrupted.
    NotRunning,
    /// The pending request is no longer pending; nothing was answered.
    RequestNotFound,
    /// The agent's runtime is not running, so it cannot take input now.
    RuntimeUnavailable,
    /// The backend or the provider refused the action.
    Rejected,
    /// The desktop could not reach its backend.
    Unavailable,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentChatTimelineOutcome {
    Timeline,
    Refused,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubAgentChatTimelineResult {
    pub hub_agent_chat_version: u16,
    pub outcome: AgentChatTimelineOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline: Option<AgentChatTimeline>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<AgentChatRefusal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl HubAgentChatTimelineResult {
    /// The newest items of `timeline` that fit one frame. Items left out make
    /// `older` point at the oldest item kept.
    #[must_use]
    pub fn timeline(timeline: AgentChatTimeline) -> Self {
        Self::timeline_within(timeline, MAX_AGENT_CHAT_TIMELINE_BYTES)
    }

    /// [`Self::timeline`] for a frame of at most `max_bytes`.
    #[must_use]
    pub fn timeline_within(mut timeline: AgentChatTimeline, max_bytes: usize) -> Self {
        let mut items = std::mem::take(&mut timeline.items);
        for item in &mut items {
            bound_item(item);
        }
        if let Some(text) = timeline.live_text.as_mut() {
            truncate_on_char_boundary(text, MAX_AGENT_CHAT_TEXT_BYTES);
        }
        timeline.queued.truncate(MAX_AGENT_CHAT_QUEUED);
        for queued in &mut timeline.queued {
            truncate_on_char_boundary(&mut queued.preview, MAX_AGENT_CHAT_LABEL_BYTES);
        }
        let mut result = Self {
            hub_agent_chat_version: HUB_AGENT_CHAT_VERSION,
            outcome: AgentChatTimelineOutcome::Timeline,
            timeline: Some(timeline),
            code: None,
            detail: None,
        };
        let budget = max_bytes.saturating_sub(serialized_len(&result) + FRAME_SLACK_BYTES);
        let mut used = 0usize;
        let mut first_kept = items.len();
        for (index, item) in items.iter().enumerate().rev() {
            let size = serialized_len(item).saturating_add(1);
            if used.saturating_add(size) > budget {
                break;
            }
            used += size;
            first_kept = index;
        }
        if first_kept > 0 {
            items.drain(..first_kept);
            if let Some(timeline) = result.timeline.as_mut() {
                timeline.history_complete = false;
                timeline.older = items
                    .first()
                    .and_then(AgentChatItem::sequence)
                    .or(timeline.older);
            }
        }
        if let Some(timeline) = result.timeline.as_mut() {
            timeline.items = items;
        }
        result
    }

    #[must_use]
    pub fn refused(code: AgentChatRefusal, detail: impl Into<String>) -> Self {
        Self {
            hub_agent_chat_version: HUB_AGENT_CHAT_VERSION,
            outcome: AgentChatTimelineOutcome::Refused,
            timeline: None,
            code: Some(code),
            detail: Some(detail.into()),
        }
    }
}

/// What happened to an action.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentChatActionState {
    /// The backend confirmed it.
    Done,
    /// Nothing was done. `code` says why.
    Refused,
    /// It may have happened: read the timeline before trying again.
    Unknown,
    #[serde(other)]
    Unrecognized,
}

/// Where a sent message went, the way the desktop's composer sends it.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentChatDelivery {
    /// No turn was running: the message started one.
    Started,
    /// A turn was running: the message steers it at its next boundary.
    Steered,
    /// A turn was running and the provider cannot be steered: the message
    /// waits for the turn to end.
    Queued,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubAgentChatActionResult {
    pub hub_agent_chat_version: u16,
    pub state: AgentChatActionState,
    /// Set for a done send.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<AgentChatDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<AgentChatRefusal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl HubAgentChatActionResult {
    #[must_use]
    pub fn done(delivery: Option<AgentChatDelivery>) -> Self {
        Self {
            hub_agent_chat_version: HUB_AGENT_CHAT_VERSION,
            state: AgentChatActionState::Done,
            delivery,
            code: None,
            detail: None,
        }
    }

    #[must_use]
    pub fn refused(code: AgentChatRefusal, detail: impl Into<String>) -> Self {
        Self {
            hub_agent_chat_version: HUB_AGENT_CHAT_VERSION,
            state: AgentChatActionState::Refused,
            delivery: None,
            code: Some(code),
            detail: Some(bounded_detail(detail.into())),
        }
    }

    #[must_use]
    pub fn unknown(detail: impl Into<String>) -> Self {
        Self {
            hub_agent_chat_version: HUB_AGENT_CHAT_VERSION,
            state: AgentChatActionState::Unknown,
            delivery: None,
            code: None,
            detail: Some(bounded_detail(detail.into())),
        }
    }
}

/// What one frame of a watch says.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentChatWatchSignal {
    /// The watch is open, and every change from here on is told. Read once
    /// now: a change between the last read and this point is told by nothing
    /// else.
    Watching,
    /// The conversation changed: read the newest page again.
    Changed,
    /// Nothing changed for a while. Written so a phone that left is noticed
    /// and its subscription let go, and so the phone can tell a quiet watch
    /// from a lost one.
    Quiet,
    /// The watch could not open. `code` says why; the stream ends.
    Refused,
    /// A signal a later desktop writes. Reading again is always safe.
    #[serde(other)]
    Unknown,
}

/// One frame on an `AgentChatWatchV1` stream. The stream ends when the
/// desktop's subscription ends or the phone closes it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubAgentChatWatchEvent {
    pub hub_agent_chat_version: u16,
    pub signal: AgentChatWatchSignal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<AgentChatRefusal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl HubAgentChatWatchEvent {
    #[must_use]
    pub fn signal(signal: AgentChatWatchSignal) -> Self {
        Self {
            hub_agent_chat_version: HUB_AGENT_CHAT_VERSION,
            signal,
            code: None,
            detail: None,
        }
    }

    #[must_use]
    pub fn refused(code: AgentChatRefusal, detail: impl Into<String>) -> Self {
        Self {
            hub_agent_chat_version: HUB_AGENT_CHAT_VERSION,
            signal: AgentChatWatchSignal::Refused,
            code: Some(code),
            detail: Some(bounded_detail(detail.into())),
        }
    }
}

/// Whether an action id can name backend ids: 1 to
/// [`MAX_AGENT_CHAT_ACTION_ID_BYTES`] of `A-Z a-z 0-9 . _ : -`, starting with a
/// letter or digit.
#[must_use]
pub fn valid_action_id(action_id: &str) -> bool {
    !action_id.is_empty()
        && action_id.len() <= MAX_AGENT_CHAT_ACTION_ID_BYTES
        && action_id.starts_with(|character: char| character.is_ascii_alphanumeric())
        && action_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
}

fn bound_item(item: &mut AgentChatItem) {
    match item {
        AgentChatItem::Message {
            text, truncated, ..
        } => {
            *truncated |= truncate_on_char_boundary(text, MAX_AGENT_CHAT_TEXT_BYTES);
        }
        AgentChatItem::Tool { name, .. } => {
            truncate_on_char_boundary(name, MAX_AGENT_CHAT_LABEL_BYTES);
        }
        AgentChatItem::Error { message, .. } => {
            truncate_on_char_boundary(message, MAX_AGENT_CHAT_LABEL_BYTES);
        }
        AgentChatItem::Status { .. } | AgentChatItem::Unknown => {}
    }
}

fn bounded_detail(mut detail: String) -> String {
    truncate_on_char_boundary(&mut detail, MAX_AGENT_CHAT_LABEL_BYTES);
    detail
}

/// Hub side: one timeline answer as a frame.
///
/// # Errors
/// When serialization fails or the answer exceeds the frame limit.
pub fn encode_timeline(result: &HubAgentChatTimelineResult) -> Result<Vec<u8>, FrameError> {
    frame::encode(result, MAX_AGENT_CHAT_TIMELINE_BYTES)
}

/// Hub side: one action answer as a frame.
///
/// # Errors
/// When serialization fails or the answer exceeds the frame limit.
pub fn encode_action(result: &HubAgentChatActionResult) -> Result<Vec<u8>, FrameError> {
    frame::encode(result, MAX_AGENT_CHAT_ACTION_RESULT_BYTES)
}

/// Hub side: one watch event as a frame.
///
/// # Errors
/// When serialization fails or the event exceeds the frame limit.
pub fn encode_watch_event(event: &HubAgentChatWatchEvent) -> Result<Vec<u8>, FrameError> {
    frame::encode(event, MAX_AGENT_CHAT_WATCH_EVENT_BYTES)
}

/// Phone side: read a timeline answer. Another version is refused.
///
/// # Errors
/// When the frame is broken, the version differs or the document is unreadable.
pub fn read_timeline<R: Read>(
    reader: &mut R,
) -> Result<HubAgentChatTimelineResult, ConversationError> {
    read_versioned(reader, MAX_AGENT_CHAT_TIMELINE_BYTES)
}

/// Phone side: read an action answer. Another version is refused.
///
/// # Errors
/// When the frame is broken, the version differs or the document is unreadable.
pub fn read_action<R: Read>(reader: &mut R) -> Result<HubAgentChatActionResult, ConversationError> {
    read_versioned(reader, MAX_AGENT_CHAT_ACTION_RESULT_BYTES)
}

/// Phone side: read the next watch event. Another version is refused.
///
/// # Errors
/// When the frame is broken, the version differs or the document is unreadable.
pub fn read_watch_event<R: Read>(
    reader: &mut R,
) -> Result<HubAgentChatWatchEvent, ConversationError> {
    read_versioned(reader, MAX_AGENT_CHAT_WATCH_EVENT_BYTES)
}

fn read_versioned<T: serde::de::DeserializeOwned, R: Read>(
    reader: &mut R,
    limit: usize,
) -> Result<T, ConversationError> {
    read_versioned_as(
        reader,
        limit,
        "hub_agent_chat_version",
        HUB_AGENT_CHAT_VERSION,
        "Could not read the chat answer",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(sequence: u64, text: &str) -> AgentChatItem {
        AgentChatItem::Message {
            sequence,
            role: AgentChatRole::Agent,
            text: text.to_string(),
            truncated: false,
        }
    }

    fn timeline(items: Vec<AgentChatItem>) -> AgentChatTimeline {
        AgentChatTimeline {
            provider_id: "claude".to_string(),
            items,
            older: None,
            history_complete: true,
            latest: 9,
            turn: Some(AgentChatTurn {
                turn_id: "turn-1".to_string(),
            }),
            live_text: None,
            pending: vec![
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
                            id: "db".to_string(),
                            question: "Which database?".to_string(),
                            header: None,
                            options: vec![AgentChatOption {
                                label: "SQLite".to_string(),
                                description: None,
                            }],
                            multi_select: false,
                            allow_other: true,
                            is_secret: false,
                        }],
                    },
                },
            ],
            queued: vec![AgentChatQueued {
                preview: "after that, run lint".to_string(),
            }],
        }
    }

    #[test]
    fn a_timeline_round_trips() {
        let result = HubAgentChatTimelineResult::timeline(timeline(vec![
            message(1, "hello"),
            AgentChatItem::Tool {
                sequence: 2,
                name: "Bash".to_string(),
                state: AgentChatToolState::Completed,
            },
            AgentChatItem::Status {
                sequence: 3,
                state: AgentChatStatus::TurnCanceled,
            },
        ]));
        let framed = encode_timeline(&result).expect("encodes");
        assert_eq!(
            read_timeline(&mut framed.as_slice()).expect("reads"),
            result
        );
    }

    /// The wire names the phone reads.
    #[test]
    fn the_pending_request_kinds_use_their_wire_names() {
        let value = serde_json::to_value(timeline(Vec::new()).pending).expect("to value");
        assert_eq!(
            value,
            serde_json::json!([
                {"request_id": "request-1", "kind": "permission", "tool_name": "Bash", "display_name": "Run command"},
                {"request_id": "request-2", "kind": "question", "questions": [{
                    "id": "db", "question": "Which database?",
                    "options": [{"label": "SQLite"}],
                    "multi_select": false, "allow_other": true, "is_secret": false,
                }]},
            ])
        );
    }

    /// A row or request kind a later build adds does not break the answer.
    #[test]
    fn kinds_a_later_build_adds_read_as_unknown() {
        let item: AgentChatItem =
            serde_json::from_value(serde_json::json!({"kind": "diagram", "sequence": 4}))
                .expect("reads");
        assert_eq!(item, AgentChatItem::Unknown);
        let pending: AgentChatPending = serde_json::from_value(
            serde_json::json!({"request_id": "r", "kind": "elicitation", "form": {}}),
        )
        .expect("reads");
        assert_eq!(pending.kind, AgentChatPendingKind::Unknown);
        let refusal: AgentChatRefusal =
            serde_json::from_value(serde_json::json!("quota_exceeded")).expect("reads");
        assert_eq!(refusal, AgentChatRefusal::Unknown);
    }

    /// A long conversation keeps its newest rows and says where the older
    /// ones start, so the phone can page back to them.
    #[test]
    fn a_timeline_that_does_not_fit_keeps_the_newest_items_and_points_at_the_rest() {
        let long = "x".repeat(10_000);
        let items: Vec<AgentChatItem> = (1..=20).map(|sequence| message(sequence, &long)).collect();
        let result = HubAgentChatTimelineResult::timeline_within(timeline(items), 50_000);
        let shown = result.timeline.expect("a timeline");
        assert!(!shown.items.is_empty() && shown.items.len() < 20);
        assert_eq!(
            shown.items.last().and_then(AgentChatItem::sequence),
            Some(20)
        );
        assert_eq!(
            shown.older,
            shown.items.first().and_then(AgentChatItem::sequence)
        );
        assert!(!shown.history_complete);
        let encoded = serde_json::to_vec(&HubAgentChatTimelineResult::timeline(shown)).unwrap();
        assert!(encoded.len() <= 50_000);
    }

    #[test]
    fn a_long_message_is_cut_and_marked() {
        let text = "가".repeat(MAX_AGENT_CHAT_TEXT_BYTES);
        let result = HubAgentChatTimelineResult::timeline(timeline(vec![message(1, &text)]));
        match &result.timeline.expect("a timeline").items[0] {
            AgentChatItem::Message {
                text, truncated, ..
            } => {
                assert!(*truncated);
                assert!(text.len() <= MAX_AGENT_CHAT_TEXT_BYTES);
            }
            other => panic!("not a message: {other:?}"),
        }
    }

    #[test]
    fn actions_round_trip() {
        for result in [
            HubAgentChatActionResult::done(Some(AgentChatDelivery::Steered)),
            HubAgentChatActionResult::refused(AgentChatRefusal::TurnChanged, "moved"),
            HubAgentChatActionResult::unknown("lost"),
        ] {
            let framed = encode_action(&result).expect("encodes");
            assert_eq!(read_action(&mut framed.as_slice()).expect("reads"), result);
        }
    }

    #[test]
    fn another_version_is_refused_by_name() {
        let mut result = HubAgentChatActionResult::done(None);
        result.hub_agent_chat_version = HUB_AGENT_CHAT_VERSION + 1;
        let framed = encode_action(&result).expect("encodes");
        assert!(matches!(
            read_action(&mut framed.as_slice()),
            Err(ConversationError::UnsupportedVersion { .. })
        ));
    }

    #[test]
    fn watch_events_follow_each_other_on_one_stream() {
        let events = [
            HubAgentChatWatchEvent::signal(AgentChatWatchSignal::Watching),
            HubAgentChatWatchEvent::signal(AgentChatWatchSignal::Changed),
            HubAgentChatWatchEvent::signal(AgentChatWatchSignal::Quiet),
            HubAgentChatWatchEvent::refused(AgentChatRefusal::Unavailable, "no backend"),
        ];
        let mut stream = Vec::new();
        for event in &events {
            stream.extend(encode_watch_event(event).expect("encodes"));
        }
        let mut reader = stream.as_slice();
        for event in &events {
            assert_eq!(&read_watch_event(&mut reader).expect("reads"), event);
        }
        assert!(reader.is_empty());
        assert_eq!(
            serde_json::to_value(&events[1]).expect("to value"),
            serde_json::json!({ "hub_agent_chat_version": HUB_AGENT_CHAT_VERSION, "signal": "changed" })
        );
    }

    #[test]
    fn a_watch_signal_a_later_desktop_adds_reads_as_unknown() {
        let event: HubAgentChatWatchEvent = serde_json::from_value(serde_json::json!({
            "hub_agent_chat_version": HUB_AGENT_CHAT_VERSION,
            "signal": "compacted",
        }))
        .expect("reads");
        assert_eq!(event.signal, AgentChatWatchSignal::Unknown);
    }

    /// An older phone reads a catalog that offers a watch; an older desktop's
    /// catalog offers none.
    #[test]
    fn the_watch_capability_is_optional_both_ways() {
        let session = HubChatSession {
            agent_id: "agent-1".to_string(),
            provider_id: "claude".to_string(),
            display_title: None,
            presentation: None,
            box_id: "this-laptop".to_string(),
            box_label: "Laptop".to_string(),
            watch: false,
        };
        let older = serde_json::to_value(&session).expect("to value");
        assert!(older.get("watch").is_none());
        let read: HubChatSession = serde_json::from_value(older).expect("reads");
        assert!(!read.watch);
        let offered = serde_json::to_value(HubChatSession {
            watch: true,
            ..session
        })
        .expect("to value");
        assert_eq!(offered["watch"], serde_json::json!(true));
    }

    #[test]
    fn action_ids_must_be_able_to_name_backend_ids() {
        assert!(valid_action_id("send-1f3a.2:b_c"));
        assert!(!valid_action_id(""));
        assert!(!valid_action_id("-leading"));
        assert!(!valid_action_id("has space"));
        assert!(!valid_action_id("slash/inside"));
        assert!(!valid_action_id(
            &"a".repeat(MAX_AGENT_CHAT_ACTION_ID_BYTES + 1)
        ));
    }
}
