use super::{AgentRuntimeBindingAuthorityV1, DomainStoreErrorV1, invalid};
use serde::{Deserialize, Serialize};

/// Stop permission is durable intent, not a replaceable inspection. An idle
/// policy binds its observation to the intent's exact native source authority.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentRuntimeSourceStopPolicyV1 {
    #[default]
    /// Preserve active work and retained input; a fresh idle observation may
    /// reconcile a manual request whose first stop was refused.
    Preserve,
    /// Do not substitute a later quiescent observation after admission. A new
    /// runtime revision or output invalidates the caller's entire idle window.
    PreserveObserved {
        runtime_revision: u64,
        observed_through_output_seq: u64,
    },
    /// Explicit authorization to discard current work or retained input.
    Discard,
}

impl AgentRuntimeSourceStopPolicyV1 {
    #[must_use]
    pub fn requires_idle(self) -> bool {
        self != Self::Discard
    }

    pub(super) fn is_preserve(&self) -> bool {
        *self == Self::Preserve
    }

    pub(super) fn validate(
        self,
        authority: &AgentRuntimeBindingAuthorityV1,
    ) -> Result<(), DomainStoreErrorV1> {
        if let Self::PreserveObserved {
            runtime_revision, ..
        } = self
            && (runtime_revision == 0
                || !matches!(authority, AgentRuntimeBindingAuthorityV1::NativeCli { .. }))
        {
            return Err(invalid(
                "sourceStopPolicy",
                "observed stop requires a positive native revision",
            ));
        }
        Ok(())
    }

    #[must_use]
    pub fn accepts_observation(self, runtime_revision: u64, output_seq: u64) -> bool {
        match self {
            Self::PreserveObserved {
                runtime_revision: expected,
                observed_through_output_seq,
            } => expected == runtime_revision && observed_through_output_seq == output_seq,
            Self::Preserve | Self::Discard => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observed_idle_stop_keeps_its_original_fence_after_journal_round_trip() {
        let policy = AgentRuntimeSourceStopPolicyV1::PreserveObserved {
            runtime_revision: 12,
            observed_through_output_seq: 99,
        };
        let recovered: AgentRuntimeSourceStopPolicyV1 =
            serde_json::from_str(&serde_json::to_string(&policy).unwrap()).unwrap();
        assert!(recovered.requires_idle());
        assert!(recovered.accepts_observation(12, 99));
        assert!(!recovered.accepts_observation(13, 99));
        assert!(!recovered.accepts_observation(12, 100));
        assert!(!recovered.accepts_observation(11, 99));
    }

    #[test]
    fn ordinary_manual_stop_policy_keeps_its_existing_wire_and_behavior() {
        for (policy, encoded, idle) in [
            (
                AgentRuntimeSourceStopPolicyV1::Preserve,
                "\"preserve\"",
                true,
            ),
            (
                AgentRuntimeSourceStopPolicyV1::Discard,
                "\"discard\"",
                false,
            ),
        ] {
            assert_eq!(serde_json::to_string(&policy).unwrap(), encoded);
            assert_eq!(
                serde_json::from_str::<AgentRuntimeSourceStopPolicyV1>(encoded).unwrap(),
                policy
            );
            assert_eq!(policy.requires_idle(), idle);
            assert!(policy.accepts_observation(100, 200));
        }
    }
}
