//! One agent session's provider conversation, read and answered from the phone.
//!
//! # What this is
//!
//! The observer chat of the chat-view design: the phone reads the newest
//! user and agent messages of a native Claude Code or Codex session, and types
//! one prompt into that agent while it waits for input. It never owns the
//! provider process and never shares it — the terminal stays the other view of
//! the same agent.
//!
//! # Why the desktop answers
//!
//! The provider transcript and the idle-prompt admission both already live
//! there: the transcript reader is the one the desktop's own response view
//! uses, and the prompt goes through the Hmux Host's agent-prompt input, which
//! writes only when the Host itself observes the agent idle, without attention,
//! on the expected conversation. This document only carries the question and
//! the answer, so neither rule gains a second owner.
//!
//! # Why the cursor
//!
//! Re-reading a transcript means scanning a provider file that can be tens of
//! megabytes, and the phone polls while the chat is open. The answer carries a
//! [`ConversationCursor`] made of facts the Host already holds; a client that
//! echoes it as `after` gets `unchanged`, without the file being read, until a
//! turn completes or the process or conversation changes
//! ([`ConversationCursor::same_turns_as`]). Text the agent writes in the middle
//! of a turn shows when that turn completes.
//!
//! # Why the prompt is short
//!
//! The prompt rides in the greeting, whose frame is `MAX_HELLO_BYTES`, so it is
//! bounded by [`MAX_AGENT_PROMPT_BYTES`]; [`check_agent_prompt`] is the check
//! both sides apply. A longer prompt needs a data frame after the greeting, the
//! way `StageSessionFileV1` sends a file — that is milestone 2.
//!
//! # What does not cross
//!
//! Message text only: tool calls, tool results, file paths of the transcript
//! and anything about the provider account stay on the desktop.
//!
//! # Why a separate version
//!
//! Like `session_account`, so a phone that meets a desktop speaking another
//! version of this document loses the chat only, not the session list.

use crate::frame::{self, FrameError};
use serde::{Deserialize, Serialize};
use std::io::Read;

/// The version this build speaks.
pub const HUB_CONVERSATION_VERSION: u16 = 1;

/// One transcript answer's limit. It is the catalog's limit: a conversation is
/// at least as long as a session list, and the phone already reads that much.
pub const MAX_TRANSCRIPT_BYTES: usize = 4 * 1024 * 1024;

/// One prompt answer's limit. It never carries text.
pub const MAX_PROMPT_RESULT_BYTES: usize = 16 * 1024;

/// The most entries one answer carries, and the number an absent `limit` asks
/// for.
pub const MAX_TRANSCRIPT_ENTRIES: usize = 200;

/// The longest text one entry (or the final response) carries. Longer text is
/// cut on a character boundary and the entry says so, so one pasted log
/// cannot push every other message out of the frame.
pub const MAX_ENTRY_TEXT_BYTES: usize = 64 * 1024;

/// Room kept free for the fields around the entries when they are fitted to
/// the frame.
const FRAME_SLACK_BYTES: usize = 1024;

/// The longest prompt one `AgentPromptV1` carries, in UTF-8 bytes.
///
/// The prompt rides in the greeting next to the device token and the ids. A
/// prompt that passes [`check_agent_prompt`] at most doubles when written as
/// JSON (quotes, backslashes, line breaks and tabs are its only escaped
/// characters), so at this length the greeting always fits `MAX_HELLO_BYTES`
/// with ids of up to 256 bytes. A longer prompt needs a data frame after the
/// greeting (milestone 2).
pub const MAX_AGENT_PROMPT_BYTES: usize = 3 * 1024;

/// Who said it.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationRole {
    User,
    Agent,
}

/// One message of the conversation, oldest first in an answer.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationEntry {
    pub role: ConversationRole,
    pub text: String,
    /// The text was longer than [`MAX_ENTRY_TEXT_BYTES`] and was cut.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// What the desktop observed when it answered. Echo it back as `after`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConversationCursor {
    /// The provider process. Moves when it is replaced.
    pub terminal_epoch: String,
    /// Moves when the provider starts another conversation in the same
    /// process.
    pub conversation_id: String,
    /// Moves when a turn completes.
    pub turn_completed_count: u64,
    /// The Host's agent runtime revision. Reported, not compared: it moves on
    /// every runtime change, progress included, so deciding `unchanged` on it
    /// would re-read the transcript on every poll while the agent works. A
    /// client can use it to see that the agent's state moved (a turn started,
    /// attention was raised) without asking for the transcript again.
    pub runtime_revision: u64,
}

impl ConversationCursor {
    /// Nothing the transcript depends on moved between `self` and `other`:
    /// the same process, the same conversation, no turn completed. This is
    /// the rule the desktop answers `unchanged` by.
    #[must_use]
    pub fn same_turns_as(&self, other: &Self) -> bool {
        self.terminal_epoch == other.terminal_epoch
            && self.conversation_id == other.conversation_id
            && self.turn_completed_count == other.turn_completed_count
    }
}

/// Why the desktop did not answer with a transcript, or did not write a prompt.
///
/// The screen branches on this; `detail` is for a person. A code a later
/// build adds reads as [`Self::Unknown`] instead of breaking the answer.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationRefusal {
    /// This desktop serves no such session.
    SessionNotFound,
    /// The session runs on a remote host this desktop reaches over SSH; its
    /// conversation is not served yet.
    RemoteUnsupported,
    /// The session is not a native Claude Code or Codex agent (a shell, for
    /// example), or its Host cannot take an agent prompt.
    UnsupportedRuntime,
    /// The agent has not reported which conversation it is on yet.
    ConversationUnknown,
    /// The provider's transcript could not be read.
    TranscriptUnavailable,
    /// The agent is working, starting or has exited; nothing was written.
    NotIdle,
    /// The agent is waiting for an approval or an answer in the terminal;
    /// nothing was written.
    AttentionPending,
    /// The provider process or its conversation is no longer the one the
    /// request expected; nothing was written.
    IdentityChanged,
    /// Someone has typed into the terminal without submitting; nothing was
    /// written, so their draft is not merged with the prompt.
    InputDraftPending,
    /// The request itself is unusable (an empty or too long prompt, for
    /// example).
    InvalidRequest,
    /// The desktop could not observe or attach to the session's Host in time,
    /// or its transport did not answer. The agent may well be alive — on a
    /// busy desktop this happens — so ask again; nothing was written.
    ProbeTimeout,
    /// The desktop could not reach the session or answer at all (the session
    /// exited, for example).
    Unavailable,
    #[serde(other)]
    Unknown,
}

/// What a transcript answer holds.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptOutcome {
    /// Here are the newest entries.
    Transcript,
    /// Nothing moved since the cursor the request carried. No entries.
    Unchanged,
    /// No transcript. `code` says why.
    Refused,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubConversationTranscriptResult {
    pub hub_conversation_version: u16,
    pub outcome: TranscriptOutcome,
    /// The provider id the Host reported (`claude`, `codex`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// Oldest first. Empty unless the outcome is `transcript`.
    #[serde(default)]
    pub entries: Vec<ConversationEntry>,
    /// The agent's last answer when its latest turn is complete; absent while
    /// a turn is open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_response: Option<String>,
    /// `entries` start at the beginning of the conversation: nothing older
    /// was left out by `limit`, by the frame, or by the provider reader.
    #[serde(default)]
    pub history_complete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<ConversationCursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<ConversationRefusal>,
    /// A sentence for a person. The screen branches on `code`, not on this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The parts of a transcript before they are fitted to one answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranscriptParts {
    pub provider: String,
    pub conversation_id: String,
    /// Oldest first, as the provider reader returns them.
    pub entries: Vec<ConversationEntry>,
    pub final_response: Option<String>,
    pub history_complete: bool,
    pub cursor: ConversationCursor,
}

impl HubConversationTranscriptResult {
    /// The newest `limit` entries that fit in one frame.
    ///
    /// Absent `limit` asks for [`MAX_TRANSCRIPT_ENTRIES`]; a larger one reads
    /// as that maximum, and zero returns the cursor and the final response
    /// only. Leaving older entries out clears `history_complete`.
    #[must_use]
    pub fn transcript(parts: TranscriptParts, limit: Option<u32>) -> Self {
        let TranscriptParts {
            provider,
            conversation_id,
            entries,
            final_response,
            mut history_complete,
            cursor,
        } = parts;
        let limit = effective_limit(limit);
        let skipped = entries.len().saturating_sub(limit);
        history_complete &= skipped == 0;
        let mut entries: Vec<ConversationEntry> =
            entries.into_iter().skip(skipped).map(bounded).collect();
        let final_response = final_response.map(|mut text| {
            truncate_on_char_boundary(&mut text, MAX_ENTRY_TEXT_BYTES);
            text
        });
        let mut result = Self {
            hub_conversation_version: HUB_CONVERSATION_VERSION,
            outcome: TranscriptOutcome::Transcript,
            provider: Some(provider),
            conversation_id: Some(conversation_id),
            entries: Vec::new(),
            final_response,
            history_complete,
            cursor: Some(cursor),
            code: None,
            detail: None,
        };
        // Fill from the newest entry backwards until the frame is full.
        let budget =
            MAX_TRANSCRIPT_BYTES.saturating_sub(serialized_len(&result) + FRAME_SLACK_BYTES);
        let mut used = 0usize;
        let mut first_kept = entries.len();
        for (index, entry) in entries.iter().enumerate().rev() {
            // One more for the separating comma.
            let size = entry_json_len(entry).saturating_add(1);
            if used.saturating_add(size) > budget {
                break;
            }
            used += size;
            first_kept = index;
        }
        if first_kept > 0 {
            entries.drain(..first_kept);
            result.history_complete = false;
        }
        result.entries = entries;
        result
    }

    /// Nothing moved since `cursor`.
    #[must_use]
    pub fn unchanged(
        provider: String,
        conversation_id: String,
        cursor: ConversationCursor,
    ) -> Self {
        Self {
            hub_conversation_version: HUB_CONVERSATION_VERSION,
            outcome: TranscriptOutcome::Unchanged,
            provider: Some(provider),
            conversation_id: Some(conversation_id),
            entries: Vec::new(),
            final_response: None,
            history_complete: false,
            cursor: Some(cursor),
            code: None,
            detail: None,
        }
    }

    #[must_use]
    pub fn refused(code: ConversationRefusal, detail: impl Into<String>) -> Self {
        Self {
            hub_conversation_version: HUB_CONVERSATION_VERSION,
            outcome: TranscriptOutcome::Refused,
            provider: None,
            conversation_id: None,
            entries: Vec::new(),
            final_response: None,
            history_complete: false,
            cursor: None,
            code: Some(code),
            detail: Some(detail.into()),
        }
    }
}

/// What happened to a prompt.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentPromptState {
    /// The Host admitted the prompt and wrote it, with its submit, to the
    /// agent's terminal. It shows as the next user turn of the transcript.
    WrittenToPty,
    /// Nothing was written. `code` says why.
    Refused,
    /// The answer was lost after writing may have started. Read the
    /// transcript before sending the same prompt again.
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubAgentPromptResult {
    pub hub_conversation_version: u16,
    pub state: AgentPromptState,
    /// The Host's terminal record that carried the prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    /// The provider process the prompt reached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_epoch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<ConversationRefusal>,
    /// A sentence for a person. The screen branches on `state` and `code`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl HubAgentPromptResult {
    #[must_use]
    pub fn written(terminal_epoch: impl Into<String>, record_id: impl Into<String>) -> Self {
        Self {
            hub_conversation_version: HUB_CONVERSATION_VERSION,
            state: AgentPromptState::WrittenToPty,
            record_id: Some(record_id.into()),
            terminal_epoch: Some(terminal_epoch.into()),
            code: None,
            detail: None,
        }
    }

    #[must_use]
    pub fn refused(code: ConversationRefusal, detail: impl Into<String>) -> Self {
        Self {
            hub_conversation_version: HUB_CONVERSATION_VERSION,
            state: AgentPromptState::Refused,
            record_id: None,
            terminal_epoch: None,
            code: Some(code),
            detail: Some(detail.into()),
        }
    }

    #[must_use]
    pub fn unknown(detail: impl Into<String>) -> Self {
        Self {
            hub_conversation_version: HUB_CONVERSATION_VERSION,
            state: AgentPromptState::Unknown,
            record_id: None,
            terminal_epoch: None,
            code: None,
            detail: Some(detail.into()),
        }
    }
}

/// How many entries a request's `limit` asks for.
#[must_use]
pub fn effective_limit(limit: Option<u32>) -> usize {
    limit.map_or(MAX_TRANSCRIPT_ENTRIES, |limit| {
        usize::try_from(limit).map_or(MAX_TRANSCRIPT_ENTRIES, |limit| {
            limit.min(MAX_TRANSCRIPT_ENTRIES)
        })
    })
}

fn bounded(mut entry: ConversationEntry) -> ConversationEntry {
    entry.truncated |= truncate_on_char_boundary(&mut entry.text, MAX_ENTRY_TEXT_BYTES);
    entry
}

/// Cut `text` to at most `limit` bytes without splitting a character.
fn truncate_on_char_boundary(text: &mut String, limit: usize) -> bool {
    if text.len() <= limit {
        return false;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    true
}

fn serialized_len<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

/// The bytes `serde_json` writes for one entry, counted without writing it.
fn entry_json_len(entry: &ConversationEntry) -> usize {
    let role = match entry.role {
        ConversationRole::User => "user".len(),
        ConversationRole::Agent => "agent".len(),
    };
    // {"role":"<role>","text":<text>} and, when cut, ,"truncated":true
    let truncated = if entry.truncated {
        r#","truncated":true"#.len()
    } else {
        0
    };
    r#"{"role":"","text":}"#.len() + role + json_string_len(&entry.text) + truncated
}

/// The bytes `serde_json` writes for `text` as a JSON string, quotes included.
fn json_string_len(text: &str) -> usize {
    2 + text
        .chars()
        .map(|character| match character {
            '"' | '\\' | '\u{08}' | '\u{0c}' | '\n' | '\r' | '\t' => 2,
            control if u32::from(control) < 0x20 => 6,
            other => other.len_utf8(),
        })
        .sum::<usize>()
}

/// Why a prompt cannot be sent as written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentPromptTextError {
    /// Nothing but whitespace.
    Empty,
    /// A control character other than a line break or a tab. Such bytes act
    /// on the agent's terminal rather than reading as text.
    ControlCharacter,
    /// Longer than [`MAX_AGENT_PROMPT_BYTES`].
    TooLong { length: usize, limit: usize },
}

impl std::fmt::Display for AgentPromptTextError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => write!(formatter, "The prompt is empty"),
            Self::ControlCharacter => write!(
                formatter,
                "The prompt contains a control character other than a line break or a tab"
            ),
            Self::TooLong { length, limit } => write!(
                formatter,
                "The prompt is {length} bytes; a prompt sent to an agent can be at most \
                 {limit} bytes. Paste longer text in the terminal"
            ),
        }
    }
}

impl std::error::Error for AgentPromptTextError {}

/// The check a client applies before sending an `AgentPromptV1`, and the hub
/// applies again before the Host hears of it.
///
/// # Errors
/// When the prompt is empty, carries a control character other than a line
/// break or a tab, or is longer than [`MAX_AGENT_PROMPT_BYTES`].
pub fn check_agent_prompt(text: &str) -> Result<(), AgentPromptTextError> {
    if text.trim().is_empty() {
        return Err(AgentPromptTextError::Empty);
    }
    if text
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(AgentPromptTextError::ControlCharacter);
    }
    if text.len() > MAX_AGENT_PROMPT_BYTES {
        return Err(AgentPromptTextError::TooLong {
            length: text.len(),
            limit: MAX_AGENT_PROMPT_BYTES,
        });
    }
    Ok(())
}

/// Hub side: one transcript answer as a frame.
///
/// # Errors
/// When serialization fails or the answer exceeds the frame limit.
pub fn encode_transcript(result: &HubConversationTranscriptResult) -> Result<Vec<u8>, FrameError> {
    frame::encode(result, MAX_TRANSCRIPT_BYTES)
}

/// Hub side: one prompt answer as a frame.
///
/// # Errors
/// When serialization fails or the answer exceeds the frame limit.
pub fn encode_prompt(result: &HubAgentPromptResult) -> Result<Vec<u8>, FrameError> {
    frame::encode(result, MAX_PROMPT_RESULT_BYTES)
}

/// Phone side: read a transcript answer. Another version is refused.
///
/// # Errors
/// When the frame is broken, the version differs or the document is unreadable.
pub fn read_transcript<R: Read>(
    reader: &mut R,
) -> Result<HubConversationTranscriptResult, ConversationError> {
    read_versioned(reader, MAX_TRANSCRIPT_BYTES)
}

/// Phone side: read a prompt answer. Another version is refused.
///
/// # Errors
/// When the frame is broken, the version differs or the document is unreadable.
pub fn read_prompt<R: Read>(reader: &mut R) -> Result<HubAgentPromptResult, ConversationError> {
    read_versioned(reader, MAX_PROMPT_RESULT_BYTES)
}

fn read_versioned<T: serde::de::DeserializeOwned, R: Read>(
    reader: &mut R,
    limit: usize,
) -> Result<T, ConversationError> {
    let payload = frame::read_bytes(reader, limit)?;
    // The loose probe reads the version first, so a document from another
    // version says "update one side" rather than "malformed".
    let probe: VersionProbe = serde_json::from_slice(&payload).map_err(|_| {
        ConversationError::Frame(FrameError::Malformed(
            "Could not read the conversation answer",
        ))
    })?;
    let found = probe
        .hub_conversation_version
        .ok_or(ConversationError::Frame(FrameError::Malformed(
            "Missing version",
        )))?;
    if found != HUB_CONVERSATION_VERSION {
        return Err(ConversationError::UnsupportedVersion { found });
    }
    serde_json::from_slice(&payload).map_err(|_| {
        ConversationError::Frame(FrameError::Malformed(
            "Could not read the conversation answer",
        ))
    })
}

#[derive(Deserialize)]
struct VersionProbe {
    hub_conversation_version: Option<u16>,
}

#[derive(Debug)]
pub enum ConversationError {
    Frame(FrameError),
    UnsupportedVersion { found: u16 },
}

impl From<FrameError> for ConversationError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

impl std::fmt::Display for ConversationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Frame(error) => write!(formatter, "{error}"),
            Self::UnsupportedVersion { found } => write!(
                formatter,
                "This computer speaks conversation answer version {found}. Update one side"
            ),
        }
    }
}

impl std::error::Error for ConversationError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn cursor() -> ConversationCursor {
        ConversationCursor {
            terminal_epoch: "terminal-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            turn_completed_count: 3,
            runtime_revision: 17,
        }
    }

    fn entry(role: ConversationRole, text: impl Into<String>) -> ConversationEntry {
        ConversationEntry {
            role,
            text: text.into(),
            truncated: false,
        }
    }

    fn parts(entries: Vec<ConversationEntry>) -> TranscriptParts {
        TranscriptParts {
            provider: "claude".to_string(),
            conversation_id: "conversation-1".to_string(),
            entries,
            final_response: Some("Done.".to_string()),
            history_complete: true,
            cursor: cursor(),
        }
    }

    #[test]
    fn a_transcript_round_trips_between_the_two_halves() {
        let sent = HubConversationTranscriptResult::transcript(
            parts(vec![
                entry(ConversationRole::User, "Fix the build"),
                entry(ConversationRole::Agent, "Done."),
            ]),
            None,
        );
        let framed = encode_transcript(&sent).expect("encode");
        let read = read_transcript(&mut framed.as_slice()).expect("read");
        assert_eq!(read, sent);
        assert_eq!(read.outcome, TranscriptOutcome::Transcript);
        assert!(read.history_complete);
        assert_eq!(read.cursor, Some(cursor()));
    }

    /// The wire names are the contract the phone matches on.
    #[test]
    fn the_wire_shape_uses_snake_case_names() {
        let value = serde_json::to_value(HubConversationTranscriptResult::transcript(
            parts(vec![entry(ConversationRole::Agent, "Done.")]),
            None,
        ))
        .expect("to value");
        assert_eq!(value["outcome"], "transcript");
        assert_eq!(
            value["entries"][0],
            serde_json::json!({ "role": "agent", "text": "Done." })
        );
        assert_eq!(
            value["cursor"],
            serde_json::json!({
                "terminal_epoch": "terminal-1",
                "conversation_id": "conversation-1",
                "turn_completed_count": 3,
                "runtime_revision": 17,
            })
        );
    }

    #[test]
    fn unchanged_carries_the_cursor_and_no_entries() {
        let sent = HubConversationTranscriptResult::unchanged(
            "codex".to_string(),
            "conversation-1".to_string(),
            cursor(),
        );
        let framed = encode_transcript(&sent).expect("encode");
        let read = read_transcript(&mut framed.as_slice()).expect("read");
        assert_eq!(read.outcome, TranscriptOutcome::Unchanged);
        assert!(read.entries.is_empty());
        assert_eq!(read.cursor, Some(cursor()));
    }

    #[test]
    fn the_newest_entries_are_kept_and_the_window_says_it_is_partial() {
        let entries = (0..10)
            .map(|index| entry(ConversationRole::User, format!("message {index}")))
            .collect();
        let read = HubConversationTranscriptResult::transcript(parts(entries), Some(3));
        let texts: Vec<_> = read
            .entries
            .iter()
            .map(|entry| entry.text.as_str())
            .collect();
        assert_eq!(texts, ["message 7", "message 8", "message 9"]);
        assert!(!read.history_complete);
    }

    #[test]
    fn a_limit_is_bounded_and_zero_returns_only_the_cursor() {
        assert_eq!(effective_limit(None), MAX_TRANSCRIPT_ENTRIES);
        assert_eq!(effective_limit(Some(u32::MAX)), MAX_TRANSCRIPT_ENTRIES);
        assert_eq!(effective_limit(Some(5)), 5);
        let read = HubConversationTranscriptResult::transcript(
            parts(vec![entry(ConversationRole::User, "hi")]),
            Some(0),
        );
        assert!(read.entries.is_empty());
        assert_eq!(read.final_response.as_deref(), Some("Done."));
        assert!(!read.history_complete);
    }

    #[test]
    fn a_long_message_is_cut_on_a_character_boundary() {
        let text = "가".repeat(MAX_ENTRY_TEXT_BYTES);
        let read = HubConversationTranscriptResult::transcript(
            parts(vec![entry(ConversationRole::Agent, text)]),
            None,
        );
        let kept = &read.entries[0];
        assert!(kept.truncated);
        assert!(kept.text.len() <= MAX_ENTRY_TEXT_BYTES);
        assert!(kept.text.chars().all(|character| character == '가'));
        // A cut entry alone does not hide older messages.
        assert!(read.history_complete);
    }

    /// The largest conversation still fits in one frame: the oldest entries
    /// give way rather than the answer failing to encode.
    #[test]
    fn the_largest_conversation_still_fits_in_one_frame() {
        // Quotes double in JSON, so this is the worst escaping a message has.
        let text = "\"".repeat(MAX_ENTRY_TEXT_BYTES);
        let entries = (0..MAX_TRANSCRIPT_ENTRIES)
            .map(|_| entry(ConversationRole::Agent, text.clone()))
            .collect();
        let mut long = parts(entries);
        long.final_response = Some(text.clone());
        let sent = HubConversationTranscriptResult::transcript(long, None);
        let framed = encode_transcript(&sent).expect("fits in one frame");
        let read = read_transcript(&mut framed.as_slice()).expect("read");
        assert!(!read.entries.is_empty());
        assert!(read.entries.len() < MAX_TRANSCRIPT_ENTRIES);
        assert!(!read.history_complete);
    }

    #[test]
    fn a_refusal_carries_a_code_the_screen_can_branch_on() {
        let framed = encode_transcript(&HubConversationTranscriptResult::refused(
            ConversationRefusal::RemoteUnsupported,
            "Remote sessions are not served yet",
        ))
        .expect("encode");
        let read = read_transcript(&mut framed.as_slice()).expect("read");
        assert_eq!(read.outcome, TranscriptOutcome::Refused);
        assert_eq!(read.code, Some(ConversationRefusal::RemoteUnsupported));
        assert!(read.cursor.is_none());
    }

    /// A code from a later build is still an answer, not a broken frame.
    #[test]
    fn a_refusal_code_this_build_does_not_know_reads_as_unknown() {
        let framed = frame::encode(
            &serde_json::json!({
                "hub_conversation_version": HUB_CONVERSATION_VERSION,
                "state": "refused",
                "code": "a_reason_from_a_later_build",
            }),
            MAX_PROMPT_RESULT_BYTES,
        )
        .expect("encode");
        let read = read_prompt(&mut framed.as_slice()).expect("read");
        assert_eq!(read.state, AgentPromptState::Refused);
        assert_eq!(read.code, Some(ConversationRefusal::Unknown));
    }

    #[test]
    fn the_refusal_codes_are_the_names_the_phone_matches_on() {
        let names: Vec<_> = [
            ConversationRefusal::NotIdle,
            ConversationRefusal::AttentionPending,
            ConversationRefusal::IdentityChanged,
            ConversationRefusal::UnsupportedRuntime,
            ConversationRefusal::RemoteUnsupported,
            ConversationRefusal::InputDraftPending,
        ]
        .into_iter()
        .map(|code| serde_json::to_value(code).expect("to value"))
        .collect();
        assert_eq!(
            names,
            [
                "not_idle",
                "attention_pending",
                "identity_changed",
                "unsupported_runtime",
                "remote_unsupported",
                "input_draft_pending",
            ]
        );
    }

    #[test]
    fn a_written_prompt_round_trips_with_its_record() {
        let sent = HubAgentPromptResult::written("terminal-1", "42");
        let framed = encode_prompt(&sent).expect("encode");
        let read = read_prompt(&mut framed.as_slice()).expect("read");
        assert_eq!(read, sent);
        assert_eq!(
            serde_json::to_value(&read).expect("to value"),
            serde_json::json!({
                "hub_conversation_version": HUB_CONVERSATION_VERSION,
                "state": "written_to_pty",
                "record_id": "42",
                "terminal_epoch": "terminal-1",
            })
        );
    }

    #[test]
    fn a_refused_prompt_carries_no_record() {
        let read = HubAgentPromptResult::refused(ConversationRefusal::NotIdle, "Agent is working");
        let value = serde_json::to_value(&read).expect("to value");
        assert_eq!(value["state"], "refused");
        assert_eq!(value["code"], "not_idle");
        assert!(value.get("record_id").is_none());
    }

    /// The frame is filled by counting, not by writing every entry twice; the
    /// count must be exactly what `serde_json` writes.
    #[test]
    fn entries_are_measured_exactly_as_serde_json_writes_them() {
        for text in [
            "",
            "plain",
            "quote \" and backslash \\",
            "lines\nand\ttabs\r\n",
            "bell \u{07} escape \u{1b} nul \u{0} backspace \u{08} form \u{0c}",
            "한국어 텍스트와 emoji 🚀",
            "del \u{7f} and next-line \u{85} and line-separator \u{2028}",
        ] {
            for role in [ConversationRole::User, ConversationRole::Agent] {
                for truncated in [false, true] {
                    let entry = ConversationEntry {
                        role,
                        text: text.to_string(),
                        truncated,
                    };
                    assert_eq!(entry_json_len(&entry), serialized_len(&entry), "{text:?}");
                }
            }
        }
    }

    #[test]
    fn a_prompt_is_checked_with_the_limit_named() {
        assert_eq!(
            check_agent_prompt("Run the tests\n\tthen report\r\n"),
            Ok(())
        );
        assert_eq!(
            check_agent_prompt(&"가".repeat(MAX_AGENT_PROMPT_BYTES / 3)),
            Ok(())
        );
        assert_eq!(
            check_agent_prompt(" \n\t"),
            Err(AgentPromptTextError::Empty)
        );
        for text in [
            "clear \u{1b}[2J",
            "interrupt \u{03}",
            "nul \u{0}",
            "csi \u{9b}",
        ] {
            assert_eq!(
                check_agent_prompt(text),
                Err(AgentPromptTextError::ControlCharacter),
                "{text:?}"
            );
        }
        let long = "x".repeat(MAX_AGENT_PROMPT_BYTES + 1);
        let error = check_agent_prompt(&long).expect_err("too long");
        assert_eq!(
            error,
            AgentPromptTextError::TooLong {
                length: MAX_AGENT_PROMPT_BYTES + 1,
                limit: MAX_AGENT_PROMPT_BYTES,
            }
        );
        assert!(
            error
                .to_string()
                .contains(&MAX_AGENT_PROMPT_BYTES.to_string()),
            "{error}"
        );
    }

    /// Progress moves the runtime revision on every event; the transcript
    /// only changes when a turn completes or the identity moves.
    #[test]
    fn the_same_turns_ignore_the_runtime_revision() {
        let mut progressed = cursor();
        progressed.runtime_revision += 40;
        assert!(cursor().same_turns_as(&progressed));
        let mut completed = cursor();
        completed.turn_completed_count += 1;
        assert!(!cursor().same_turns_as(&completed));
        let mut other = cursor();
        other.conversation_id = "conversation-2".to_string();
        assert!(!cursor().same_turns_as(&other));
        let mut replaced = cursor();
        replaced.terminal_epoch = "terminal-2".to_string();
        assert!(!cursor().same_turns_as(&replaced));
    }

    #[test]
    fn a_probe_timeout_has_its_own_wire_name() {
        assert_eq!(
            serde_json::to_value(ConversationRefusal::ProbeTimeout).expect("to value"),
            "probe_timeout"
        );
    }

    /// A broken answer and an answer without a version are different
    /// failures, and say so.
    #[test]
    fn a_broken_answer_is_not_reported_as_a_missing_version() {
        let unversioned = frame::encode(
            &serde_json::json!({ "state": "refused" }),
            MAX_PROMPT_RESULT_BYTES,
        )
        .expect("encode");
        assert!(matches!(
            read_prompt(&mut unversioned.as_slice()),
            Err(ConversationError::Frame(FrameError::Malformed(
                "Missing version"
            )))
        ));
        let mut broken = 5_u32.to_be_bytes().to_vec();
        broken.extend_from_slice(b"{\"hub");
        assert!(matches!(
            read_prompt(&mut broken.as_slice()),
            Err(ConversationError::Frame(FrameError::Malformed(
                "Could not read the conversation answer"
            )))
        ));
    }

    #[test]
    fn a_newer_document_is_refused_rather_than_guessed() {
        for limit in [MAX_TRANSCRIPT_BYTES, MAX_PROMPT_RESULT_BYTES] {
            let framed = frame::encode(
                &serde_json::json!({ "hub_conversation_version": HUB_CONVERSATION_VERSION + 1 }),
                limit,
            )
            .expect("encode");
            let error = if limit == MAX_TRANSCRIPT_BYTES {
                read_transcript(&mut framed.as_slice()).err()
            } else {
                read_prompt(&mut framed.as_slice()).err()
            };
            assert!(matches!(
                error,
                Some(ConversationError::UnsupportedVersion { .. })
            ));
        }
    }
}
