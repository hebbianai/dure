//! One retained recovery intent linking the runtime and turn-effect journals.

use serde::{Deserialize, Serialize};

use crate::{
    AgentContinueTurnRequestV1, AgentExecutionProfileV1, AgentIdV1, AgentInteractionBindingV1,
    AgentInteractionProfileV1, AgentTimelineFailureV1, AgentTurnEffectReceiptV1,
    AgentTurnFailureReasonV1, DomainIdErrorV1, DomainStoreFuture, OperationIdV1,
    ProviderCredentialProfileV1, ProviderIdV1, ProviderRecoveryAccountV1, ProviderRecoveryPolicyV1,
    WorkflowPromptDeliveryEvidenceV1, agent_runtime_transition_identity,
};

/// The provider evidence kind a runtime records in the failed turn, before
/// its failure, with `{"resetsAtMs": <unix ms>}`: when the provider said the
/// limit that refused the turn resets.
pub const AGENT_USAGE_LIMIT_RESET_EVIDENCE_KIND_V1: &str = "usage_limit_reset";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRecoveryRecordV1 {
    pub schema_version: u16,
    pub attempt_id: String,
    pub source: AgentInteractionBindingV1,
    pub source_selection_revision: i64,
    pub failure: AgentTimelineFailureV1,
    pub input: String,
    pub is_goal_continuation: bool,
    pub goal_revision: Option<u64>,
    pub policy_revision: u64,
    pub target: Option<ProviderRecoveryAccountV1>,
    /// Logins this attempt found it cannot use, in the order they were set
    /// aside: signed out, the source's own login, or a target that failed to
    /// start. Selection skips them for the rest of the attempt.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unusable_targets: Vec<ProviderCredentialProfileV1>,
    /// With no target, when the same account resends the input: the reset
    /// the provider reported for this failure plus a stable jitter. A turn
    /// sent this way never waits again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_at_ms: Option<i64>,
    /// Once present, the existing turn-effect receipt owns the send outcome.
    pub continuation: Option<AgentContinueTurnRequestV1>,
    pub stopped: Option<AgentRecoveryStopV1>,
    pub created_at_ms: i64,
}

/// A native terminal turn its Host saw settle on a typed API failure: the
/// exact error episode (terminal epoch and attention) and why it failed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentNativeTurnFailureV1 {
    pub terminal_epoch: String,
    pub attention_id: String,
    pub reason: AgentTurnFailureReasonV1,
    pub observed_at_ms: i64,
    /// How many turns the Host saw complete in this terminal before the
    /// failure. Equal counts mean no turn completed between two failures.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_completed_count: Option<u64>,
    /// When the failed login's limit resets, as its provider last reported
    /// the fuller current window to this host. Both are read only when
    /// continuing after a reset is on, so other observations keep their
    /// stored shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_resets_at_ms: Option<i64>,
}

/// Where the one continuation prompt of a native recovery stands. It is
/// claimed before the prompt is written, so a prompt that may already have
/// been written is never written again.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentNativeRecoveryContinuationV1 {
    NotStarted,
    Claimed {
        #[serde(rename = "deliveryIdempotencyKey")]
        delivery_idempotency_key: String,
    },
    Delivered {
        evidence: WorkflowPromptDeliveryEvidenceV1,
    },
}

/// The recovery of a native terminal Agent: the same runtime replacement as
/// a conversation recovery, keyed by the Host's failure episode instead of a
/// timeline row, and continued with one prompt to the resumed conversation.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentNativeRecoveryRecordV1 {
    pub schema_version: u16,
    pub attempt_id: String,
    pub agent_id: AgentIdV1,
    pub provider_id: ProviderIdV1,
    pub source_execution_profile: AgentExecutionProfileV1,
    pub source_selection_revision: i64,
    pub native_failure: AgentNativeTurnFailureV1,
    pub policy_revision: u64,
    pub target: Option<ProviderRecoveryAccountV1>,
    /// Logins this attempt found it cannot use, in the order they were set
    /// aside: signed out, the source's own login, or a target that failed to
    /// start. Selection skips them for the rest of the attempt.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unusable_targets: Vec<ProviderCredentialProfileV1>,
    /// With no target, when the same terminal receives the continuation: the
    /// reported reset plus a stable jitter. A terminal that fails again
    /// before completing another turn never waits again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_at_ms: Option<i64>,
    /// Always present, so queries written before native recoveries (which
    /// select `$.continuation IS NULL`) never take a native row for theirs.
    pub continuation: AgentNativeRecoveryContinuationV1,
    pub stopped: Option<AgentRecoveryStopV1>,
    pub created_at_ms: i64,
}

/// One retained recovery attempt, of a conversation or a native terminal.
/// The shapes have distinct required fields (`source` and `nativeFailure`),
/// so every stored row decodes as exactly one of them.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(untagged)]
pub enum AgentRecoveryAttemptV1 {
    Conversation(Box<AgentRecoveryRecordV1>),
    Native(Box<AgentNativeRecoveryRecordV1>),
}

impl AgentRecoveryAttemptV1 {
    /// The conversation attempt, or `None` for a native one.
    #[must_use]
    pub fn into_conversation(self) -> Option<AgentRecoveryRecordV1> {
        match self {
            Self::Conversation(record) => Some(*record),
            Self::Native(_) => None,
        }
    }

    #[must_use]
    pub fn attempt_id(&self) -> &str {
        match self {
            Self::Conversation(record) => &record.attempt_id,
            Self::Native(record) => &record.attempt_id,
        }
    }

    #[must_use]
    pub fn agent_id(&self) -> &AgentIdV1 {
        match self {
            Self::Conversation(record) => &record.source.agent_id,
            Self::Native(record) => &record.agent_id,
        }
    }

    #[must_use]
    pub fn provider_id(&self) -> &ProviderIdV1 {
        match self {
            Self::Conversation(record) => &record.source.provider_id,
            Self::Native(record) => &record.provider_id,
        }
    }

    /// The runtime mode the failure happened in; recovery keeps it.
    #[must_use]
    pub fn source_interaction_profile(&self) -> AgentInteractionProfileV1 {
        match self {
            Self::Conversation(_) => AgentInteractionProfileV1::StructuredProtocol,
            Self::Native(_) => AgentInteractionProfileV1::NativeCli,
        }
    }

    #[must_use]
    pub fn source_execution_profile(&self) -> &AgentExecutionProfileV1 {
        match self {
            Self::Conversation(record) => &record.source.execution_profile,
            Self::Native(record) => &record.source_execution_profile,
        }
    }

    #[must_use]
    pub fn source_selection_revision(&self) -> i64 {
        match self {
            Self::Conversation(record) => record.source_selection_revision,
            Self::Native(record) => record.source_selection_revision,
        }
    }

    #[must_use]
    pub fn target(&self) -> Option<&ProviderRecoveryAccountV1> {
        match self {
            Self::Conversation(record) => record.target.as_ref(),
            Self::Native(record) => record.target.as_ref(),
        }
    }

    #[must_use]
    pub fn unusable_targets(&self) -> &[ProviderCredentialProfileV1] {
        match self {
            Self::Conversation(record) => &record.unusable_targets,
            Self::Native(record) => &record.unusable_targets,
        }
    }

    /// The runtime transition that applies the current target. Each login
    /// set aside starts a new one, so a failed target's journal is replaced
    /// rather than replayed; the first target keeps the attempt's own key.
    #[must_use]
    pub fn runtime_attempt_id(&self) -> String {
        runtime_attempt_at(self.attempt_id(), self.unusable_targets().len())
    }

    pub fn runtime_operation_id(&self) -> Result<OperationIdV1, DomainIdErrorV1> {
        agent_runtime_transition_identity(&self.runtime_attempt_id()).map(|(id, _)| id)
    }

    /// Whether a runtime transition applied one of this attempt's targets.
    #[must_use]
    pub fn owns_runtime_operation(&self, operation_id: &OperationIdV1) -> bool {
        (0..=self.unusable_targets().len()).any(|index| {
            agent_runtime_transition_identity(&runtime_attempt_at(self.attempt_id(), index))
                .is_ok_and(|(id, _)| &id == operation_id)
        })
    }

    #[must_use]
    pub fn stopped(&self) -> Option<&AgentRecoveryStopV1> {
        match self {
            Self::Conversation(record) => record.stopped.as_ref(),
            Self::Native(record) => record.stopped.as_ref(),
        }
    }

    /// When the failure happened, which a recovery policy must predate.
    #[must_use]
    pub fn failure_created_at_ms(&self) -> i64 {
        match self {
            Self::Conversation(record) => record.failure.created_at_ms,
            Self::Native(record) => record.native_failure.observed_at_ms,
        }
    }

    /// With no target, when the same account continues after its reset.
    #[must_use]
    pub fn resume_at_ms(&self) -> Option<i64> {
        match self {
            Self::Conversation(record) => record.resume_at_ms,
            Self::Native(record) => record.resume_at_ms,
        }
    }

    /// Whether `policy` still permits this attempt's plan.
    #[must_use]
    pub fn permitted_by(&self, policy: &ProviderRecoveryPolicyV1) -> bool {
        policy.permits(
            self.failure_created_at_ms(),
            self.target(),
            self.resume_at_ms().is_some(),
        )
    }
}

fn runtime_attempt_at(attempt_id: &str, index: usize) -> String {
    if index == 0 {
        attempt_id.to_owned()
    } else {
        format!("{attempt_id}-target-{index}")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentRecoveryStopV1 {
    Exhausted,
    Superseded,
    Failed { code: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// The latest recovery only while its original failure or retained turn owns
/// the current conversation boundary. Historical attempts remain in the journal.
pub struct AgentRecoveryObservationV1 {
    pub attempt_id: String,
    pub failure_item_id: crate::AgentTimelineItemIdV1,
    pub target: Option<ProviderRecoveryAccountV1>,
    /// Present only for a same-account continuation after the limit resets,
    /// so clients that predate it read an unchanged observation otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_at_ms: Option<i64>,
    pub stopped: Option<AgentRecoveryStopV1>,
    pub turn_state: Option<crate::AgentTurnEffectStateV1>,
    pub created_at_ms: i64,
}

/// An Agent whose unfinished recovery waits for its usage limit to reset:
/// the same account continues it at `resume_at_ms`, a Chat agent by resending
/// its failed turn and a terminal agent with one prompt in the same terminal.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRecoveryWaitV1 {
    pub agent_id: AgentIdV1,
    pub attempt_id: String,
    pub resume_at_ms: i64,
}

pub trait AgentRecoveryStore: Send + Sync {
    fn latest_agent_recovery<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentRecoveryObservationV1>>;

    /// Every Agent whose unfinished attempt waits for a reset, Chat and
    /// terminal alike, in Agent order. A wait that a person's input or a
    /// stop superseded leaves the list when its attempt is stopped.
    fn agent_recovery_waits(&self) -> DomainStoreFuture<'_, Vec<AgentRecoveryWaitV1>>;

    /// Resumes the Agent's unfinished attempt, or reads its current failure
    /// and selects from its owning backend's explicitly configured pool in
    /// the same transaction. `native` is the settled failure the Host showed
    /// for a native terminal Agent; a conversation's failure is its own.
    fn prepare_agent_recovery<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
        observed_at_ms: i64,
        native: Option<&'a AgentNativeTurnFailureV1>,
    ) -> DomainStoreFuture<'a, Option<AgentRecoveryAttemptV1>>;

    fn agent_recovery<'a>(
        &'a self,
        attempt_id: &'a str,
    ) -> DomainStoreFuture<'a, Option<AgentRecoveryAttemptV1>>;

    fn agents_with_recovery(&self) -> DomainStoreFuture<'_, Vec<AgentIdV1>>;

    /// Atomically retains the exact continuation and admits its existing
    /// turn effect. Replays never receive a fresh execution claim.
    fn prepare_agent_recovery_turn<'a>(
        &'a self,
        attempt_id: &'a str,
        observed_at_ms: i64,
    ) -> DomainStoreFuture<'a, Option<AgentTurnEffectReceiptV1>>;

    /// Sets `unusable` aside for an attempt that has not started its
    /// continuation and selects again from the policy with the same rule as
    /// the first choice, so fresh usage can also reorder it. Without a next
    /// account the attempt stops: `Failed` with `failure_code` when a target
    /// failed, otherwise `Exhausted`. Any other attempt is returned unchanged.
    fn reselect_agent_recovery_target<'a>(
        &'a self,
        attempt_id: &'a str,
        unusable: &'a [ProviderCredentialProfileV1],
        failure_code: Option<&'a str>,
        observed_at_ms: i64,
    ) -> DomainStoreFuture<'a, AgentRecoveryAttemptV1>;

    /// Stops an attempt whose continuation is not yet owned elsewhere: a
    /// conversation attempt before its turn is admitted, a native attempt
    /// before its prompt is delivered.
    fn stop_agent_recovery<'a>(
        &'a self,
        attempt_id: &'a str,
        reason: &'a AgentRecoveryStopV1,
    ) -> DomainStoreFuture<'a, AgentRecoveryAttemptV1>;

    /// Claims the one continuation prompt of an unstopped native attempt
    /// that has not started it. Returns the attempt as stored afterwards;
    /// only a `Claimed` continuation with this key may write the prompt.
    fn claim_native_agent_recovery_continuation<'a>(
        &'a self,
        attempt_id: &'a str,
        delivery_idempotency_key: &'a str,
    ) -> DomainStoreFuture<'a, AgentNativeRecoveryRecordV1>;

    /// Settles a claimed continuation: delivered with its evidence, or back
    /// to not started when nothing was written.
    fn settle_native_agent_recovery_continuation<'a>(
        &'a self,
        attempt_id: &'a str,
        evidence: Option<&'a WorkflowPromptDeliveryEvidenceV1>,
    ) -> DomainStoreFuture<'a, AgentNativeRecoveryRecordV1>;
}
