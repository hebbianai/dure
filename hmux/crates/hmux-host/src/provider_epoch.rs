use crate::local_protocol::ScreenSnapshot;
pub use hmux_session_protocol::exit::{
    ExitTombstone, ProviderExitKind, SessionFailureCapsule, SessionFailurePhase,
    SessionFailureRetryPosture,
};

pub const PROCESS_SESSION_CLEANUP_INCOMPLETE_REASON: &str = "process_session_cleanup_incomplete";
pub const PROCESS_SESSION_CLEANUP_STAGE_REASON_PREFIX: &str = "process_session_cleanup_stage_v1=";

#[must_use]
pub fn process_session_cleanup_is_incomplete(reason: &str) -> bool {
    reason
        .split("; ")
        .any(|token| token == PROCESS_SESSION_CLEANUP_INCOMPLETE_REASON)
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ProcessSessionCleanupStage {
    ProviderIdentity,
    ProcessGroupCensus,
    ProcessGroupSignal,
    FreezeVerification,
    DescendantDrain,
}

impl ProcessSessionCleanupStage {
    pub const fn stable_name(self) -> &'static str {
        match self {
            Self::ProviderIdentity => "provider_identity",
            Self::ProcessGroupCensus => "process_group_census",
            Self::ProcessGroupSignal => "process_group_signal",
            Self::FreezeVerification => "freeze_verification",
            Self::DescendantDrain => "descendant_drain",
        }
    }

    pub fn reason_token(self) -> String {
        format!(
            "{PROCESS_SESSION_CLEANUP_STAGE_REASON_PREFIX}{}",
            self.stable_name()
        )
    }

    pub fn from_reason_token(token: &str) -> Option<Self> {
        match token.strip_prefix(PROCESS_SESSION_CLEANUP_STAGE_REASON_PREFIX)? {
            "provider_identity" => Some(Self::ProviderIdentity),
            "process_group_census" => Some(Self::ProcessGroupCensus),
            "process_group_signal" => Some(Self::ProcessGroupSignal),
            "freeze_verification" => Some(Self::FreezeVerification),
            "descendant_drain" => Some(Self::DescendantDrain),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletedProviderEpoch {
    pub tombstone: ExitTombstone,
    pub final_snapshot: ScreenSnapshot,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderExitStatus {
    pub exit_code: Option<i32>,
    pub platform_status: Option<String>,
    pub kind: ProviderExitKind,
    pub reason: String,
    pub created_unix_ms: u64,
    pub failure: Option<SessionFailureCapsule>,
}

#[cfg(test)]
mod tests {
    use super::{ProcessSessionCleanupStage, process_session_cleanup_is_incomplete};

    #[test]
    fn process_session_cleanup_completeness_uses_exact_reason_tokens() {
        assert!(process_session_cleanup_is_incomplete(
            "provider_exit; process_session_cleanup_incomplete"
        ));
        assert!(!process_session_cleanup_is_incomplete(
            "provider_exit; process_session_cleanup_incomplete_suffix"
        ));
    }

    #[test]
    fn process_session_cleanup_stage_tokens_are_versioned_and_round_trip() {
        for stage in [
            ProcessSessionCleanupStage::ProviderIdentity,
            ProcessSessionCleanupStage::ProcessGroupCensus,
            ProcessSessionCleanupStage::ProcessGroupSignal,
            ProcessSessionCleanupStage::FreezeVerification,
            ProcessSessionCleanupStage::DescendantDrain,
        ] {
            let token = stage.reason_token();
            assert!(token.starts_with("process_session_cleanup_stage_v1="));
            assert_eq!(
                ProcessSessionCleanupStage::from_reason_token(&token),
                Some(stage)
            );
        }
        assert_eq!(
            ProcessSessionCleanupStage::from_reason_token(
                "process_session_cleanup_stage_v2=process_group_census"
            ),
            None
        );
    }
}
