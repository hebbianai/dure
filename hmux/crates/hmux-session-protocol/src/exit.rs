//! Serialized exit observations shared by discovery and session consumers.

use crate::{Exit, ProcessProof, SessionFence};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderExitKind {
    Normal,
    UsageLimit,
    AuthenticationFailed,
    ProviderError,
    Signaled,
}

impl ProviderExitKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::UsageLimit => "usage_limit",
            Self::AuthenticationFailed => "authentication_failed",
            Self::ProviderError => "provider_error",
            Self::Signaled => "signaled",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionFailurePhase {
    ConversationIdentity,
    ProviderRuntime,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionFailureRetryPosture {
    Never,
}

/// One bounded, sanitized terminal failure retained by the runtime authority.
/// Terminal bytes, provider environment, and credential material never enter
/// this record; provider adapters must reduce any provider-specific detail to
/// a safe code and summary before it reaches Hmux.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SessionFailureCapsule {
    pub correlation_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub terminal_epoch: String,
    pub code: String,
    pub phase: SessionFailurePhase,
    pub summary: String,
    pub exit_kind: ProviderExitKind,
    pub exit_code: Option<i32>,
    pub occurred_unix_ms: u64,
    pub retry_posture: SessionFailureRetryPosture,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExitTombstone {
    pub fence: SessionFence,
    pub provider_process: ProcessProof,
    pub exit: Exit,
    pub exit_kind: ProviderExitKind,
    pub created_unix_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<SessionFailureCapsule>,
}
