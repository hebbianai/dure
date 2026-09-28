use serde::{Deserialize, Serialize};

pub const AGENT_PROGRESS_CAPABILITY: &str = "agent_progress_v1";
pub const AGENT_PROGRESS_QUIET_MS: u64 = 300_000;
pub const AGENT_PROGRESS_MESSAGES_MAX: usize = 32;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentProgressPhase {
    Thinking,
    ToolRunning,
    Waiting,
}

/// A provider response associated with one durable inbox wake, not proof that
/// the inbox contents were read or that the requested work completed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentMessageTurn {
    pub delivery_receipt_id: String,
    pub turn_id: String,
}

/// Sequence advances only for actual provider activity, never a status poll.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentProgressReport {
    pub source_id: String,
    #[serde(with = "crate::json_u64")]
    pub sequence: u64,
    pub phase: AgentProgressPhase,
    pub turn_id: Option<String>,
    pub message_turns: Vec<AgentMessageTurn>,
}

impl AgentProgressReport {
    pub fn is_valid(&self) -> bool {
        fn id(value: &str) -> bool {
            !value.is_empty()
                && value.len() <= 256
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._:+-".contains(&byte))
        }
        id(&self.source_id)
            && self.sequence > 0
            && self.turn_id.as_deref().is_none_or(id)
            && self.message_turns.len() <= AGENT_PROGRESS_MESSAGES_MAX
            && self
                .message_turns
                .iter()
                .all(|entry| id(&entry.delivery_receipt_id) && id(&entry.turn_id))
    }
}

/// Host-owned attention is separate from lifecycle and never authorizes stop.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentProgressProjection {
    pub report: AgentProgressReport,
    #[serde(with = "crate::json_u64")]
    pub last_activity_unix_ms: u64,
    #[serde(with = "crate::json_u64")]
    pub quiet_threshold_ms: u64,
    pub progress_unconfirmed: bool,
}
