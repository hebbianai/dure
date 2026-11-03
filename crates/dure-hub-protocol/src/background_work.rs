//! An agent's running background work, for the paired phone.
//!
//! # What it is
//!
//! The subagents, workflows, background shells and monitors an agent runs,
//! as the chat's line above the composer shows them. The desktop decides the
//! list from the provider's records behind the Host's facts and answers
//! [`crate::hello::HubRequest::AgentBackgroundWorkV1`] with it.
//!
//! # Why its own request
//!
//! The transcript answer stays `unchanged` while no turn starts or completes
//! (`ConversationCursor::same_turns_as`), and background work moves without
//! turns. Asking for it separately keeps that rule and the transcript's cost
//! as they are.
//!
//! # What crosses
//!
//! Each item's model-written description, kind, start time, recorded steps
//! and token count. Never a command line, a tool input or output, or a path.
//!
//! # Version
//!
//! It shares `HUB_CONVERSATION_VERSION` with the transcript: both belong to
//! the chat, and a phone that cannot read one cannot use the other.
use crate::conversation::{
    ConversationError, ConversationRefusal, HUB_CONVERSATION_VERSION, read_versioned,
};
use crate::frame::{self, FrameError};
use serde::{Deserialize, Serialize};
use std::io::Read;

/// Bounds one answer, with room for every item at its bound.
pub const MAX_BACKGROUND_WORK_RESULT_BYTES: usize = 64 * 1024;
pub const MAX_BACKGROUND_WORK_ITEMS: usize = 64;
pub const MAX_BACKGROUND_WORK_LABEL_CHARS: usize = 120;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HubBackgroundWorkKind {
    Subagent,
    Workflow,
    Shell,
    Monitor,
    /// A kind a newer desktop sends; shown by its count only.
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubBackgroundWorkSteps {
    pub done: u32,
    pub total: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubBackgroundWorkItem {
    pub id: String,
    pub kind: HubBackgroundWorkKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub started_unix_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<HubBackgroundWorkSteps>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubBackgroundWorkCounts {
    #[serde(default)]
    pub subagents: u32,
    #[serde(default)]
    pub workflows: u32,
    #[serde(default)]
    pub shells: u32,
    #[serde(default)]
    pub monitors: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundWorkOutcome {
    /// Here is what runs; an empty list means nothing does.
    Listed,
    /// No list. `code` says why.
    Refused,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubAgentBackgroundWorkResult {
    pub hub_conversation_version: u16,
    pub outcome: BackgroundWorkOutcome,
    /// Newest first, at most [`MAX_BACKGROUND_WORK_ITEMS`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<HubBackgroundWorkItem>,
    /// Every running item, including those cut from `items`.
    #[serde(default)]
    pub counts: HubBackgroundWorkCounts,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<ConversationRefusal>,
    /// A sentence for a person. The screen branches on `code`, not on this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl HubAgentBackgroundWorkResult {
    /// A list fitted to the answer's bounds: at most
    /// [`MAX_BACKGROUND_WORK_ITEMS`] items, labels cut on a character boundary.
    #[must_use]
    pub fn listed(
        mut items: Vec<HubBackgroundWorkItem>,
        counts: HubBackgroundWorkCounts,
        truncated: bool,
    ) -> Self {
        let cut = items.len() > MAX_BACKGROUND_WORK_ITEMS;
        items.truncate(MAX_BACKGROUND_WORK_ITEMS);
        for item in &mut items {
            if let Some(label) = &mut item.label {
                if label.chars().count() > MAX_BACKGROUND_WORK_LABEL_CHARS {
                    *label = label
                        .chars()
                        .take(MAX_BACKGROUND_WORK_LABEL_CHARS)
                        .collect();
                }
            }
        }
        Self {
            hub_conversation_version: HUB_CONVERSATION_VERSION,
            outcome: BackgroundWorkOutcome::Listed,
            items,
            counts,
            truncated: truncated || cut,
            code: None,
            detail: None,
        }
    }

    #[must_use]
    pub fn refused(code: ConversationRefusal, detail: impl Into<String>) -> Self {
        Self {
            hub_conversation_version: HUB_CONVERSATION_VERSION,
            outcome: BackgroundWorkOutcome::Refused,
            items: Vec::new(),
            counts: HubBackgroundWorkCounts::default(),
            truncated: false,
            code: Some(code),
            detail: Some(detail.into()),
        }
    }
}

/// Hub side: one background-work answer as a frame.
///
/// # Errors
/// When serialization fails or the answer exceeds the frame limit.
pub fn encode_background_work(
    result: &HubAgentBackgroundWorkResult,
) -> Result<Vec<u8>, FrameError> {
    frame::encode(result, MAX_BACKGROUND_WORK_RESULT_BYTES)
}

/// Phone side: read a background-work answer. Another version is refused.
///
/// # Errors
/// When the frame is broken, the version differs or the document is unreadable.
pub fn read_background_work<R: Read>(
    reader: &mut R,
) -> Result<HubAgentBackgroundWorkResult, ConversationError> {
    read_versioned(reader, MAX_BACKGROUND_WORK_RESULT_BYTES)
}

#[cfg(test)]
#[path = "background_work_tests.rs"]
mod tests;
