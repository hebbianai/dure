//! Provider-neutral durable structured-agent timeline contracts.
//!
//! Provider adapters normalize their private streams into these mutations. The
//! store is the only canonical sequencer; provider replay cursors and live text
//! heads are recovery inputs, never competing transcript authorities.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::domain_store::{validate_domain_id, validate_token};
use crate::{AgentIdV1, DomainIdErrorV1, DomainStoreErrorV1, DomainStoreFuture, ProviderIdV1};

pub const AGENT_TIMELINE_SCHEMA_VERSION_V1: u16 = 1;
pub const MAX_AGENT_TIMELINE_PAGE_ITEMS_V1: usize = 128;
pub const MAX_AGENT_TIMELINE_EVENT_MUTATIONS_V1: usize = 64;
pub const MAX_AGENT_TIMELINE_LIVE_TEXT_HEADS_V1: usize = 64;
pub const MAX_AGENT_TIMELINE_TEXT_BYTES_V1: usize = 256 * 1024;
pub const MAX_AGENT_TIMELINE_JSON_BYTES_V1: usize = 128 * 1024;
pub const MAX_AGENT_PENDING_REQUESTS_V1: usize = 32;
pub const MAX_AGENT_HISTORY_ITEMS_V1: usize = 2_048;

macro_rules! timeline_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, DomainIdErrorV1> {
                let value = value.into();
                validate_domain_id(&value)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(serde::de::Error::custom)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

timeline_id!(AgentInteractionSessionIdV1);
timeline_id!(AgentTimelineEpochV1);
timeline_id!(AgentTimelineItemIdV1);
timeline_id!(AgentTimelineStreamIdV1);
timeline_id!(AgentTurnIdV1);
timeline_id!(AgentClientMessageIdV1);
timeline_id!(AgentProviderMessageIdV1);
timeline_id!(AgentInteractionRequestIdV1);

/// Provider-neutral process interaction shape. Execution location and
/// credential selection are independent facts and must not be encoded here.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentInteractionProfileV1 {
    NativeCli,
    StructuredProtocol,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentExecutionProfileV1 {
    ProviderDefault,
    CredentialReference {
        reference_id: String,
        credential_generation: Option<String>,
    },
}

impl AgentExecutionProfileV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        match self {
            Self::ProviderDefault => Ok(()),
            Self::CredentialReference {
                reference_id,
                credential_generation,
            } => {
                validate_token("executionProfile.referenceId", reference_id)?;
                if let Some(generation) = credential_generation {
                    validate_token("executionProfile.credentialGeneration", generation)?;
                }
                Ok(())
            }
        }
    }
}

/// Exact provider-runtime fence. `provider_epoch` is provider-neutral; Claude
/// maps its private Query epoch here while another adapter may use a channel or
/// process epoch with equivalent stale-callback semantics.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProviderRuntimeFenceV1 {
    pub runtime_generation: String,
    pub provider_epoch: String,
}

impl AgentProviderRuntimeFenceV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_token("runtimeGeneration", &self.runtime_generation)?;
        validate_token("providerEpoch", &self.provider_epoch)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentInteractionBindingV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub agent_id: AgentIdV1,
    pub provider_id: ProviderIdV1,
    pub execution_profile: AgentExecutionProfileV1,
    pub provider_conversation_ref: Option<String>,
    pub runtime: AgentProviderRuntimeFenceV1,
    pub timeline_epoch: AgentTimelineEpochV1,
    pub binding_revision: i64,
    pub history_complete: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl AgentInteractionBindingV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        self.execution_profile.validate()?;
        if let Some(reference) = &self.provider_conversation_ref {
            validate_token("providerConversationRef", reference)?;
        }
        self.runtime.validate()?;
        positive("bindingRevision", self.binding_revision)?;
        timestamp("createdAtMs", self.created_at_ms)?;
        timestamp("updatedAtMs", self.updated_at_ms)?;
        if self.updated_at_ms < self.created_at_ms {
            return invalid("updatedAtMs", "must not precede createdAtMs");
        }
        Ok(())
    }

    /// Whether two binding snapshots authorize commands against the same
    /// provider runtime. The provider conversation reference and revision may
    /// advance after the runtime commits its initialization event; credential,
    /// provider, agent, timeline, and runtime fences may not. A known provider
    /// reference also cannot change to a different known reference.
    #[must_use]
    pub fn same_runtime_authority(&self, other: &Self) -> bool {
        self.schema_version == other.schema_version
            && self.interaction_session_id == other.interaction_session_id
            && self.agent_id == other.agent_id
            && self.provider_id == other.provider_id
            && self.execution_profile == other.execution_profile
            && (self.provider_conversation_ref.is_none()
                || other.provider_conversation_ref.is_none()
                || self.provider_conversation_ref == other.provider_conversation_ref)
            && self.runtime == other.runtime
            && self.timeline_epoch == other.timeline_epoch
            && self.created_at_ms == other.created_at_ms
    }

    /// Whether two snapshots identify the same exact provider-history seed.
    /// History completion and observation time may advance after commit; the
    /// provider conversation and binding revision may not.
    #[must_use]
    pub fn same_history_authority(&self, other: &Self) -> bool {
        self.same_runtime_authority(other)
            && self.provider_conversation_ref == other.provider_conversation_ref
            && self.binding_revision == other.binding_revision
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRuntimeReplacementV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub expected_binding_revision: i64,
    pub source: AgentProviderRuntimeFenceV1,
    pub source_execution_profile: AgentExecutionProfileV1,
    pub target: AgentProviderRuntimeFenceV1,
    pub target_execution_profile: AgentExecutionProfileV1,
    pub provider_conversation_ref: Option<String>,
    pub replaced_at_ms: i64,
}

impl AgentRuntimeReplacementV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        positive("expectedBindingRevision", self.expected_binding_revision)?;
        self.source.validate()?;
        self.source_execution_profile.validate()?;
        self.target.validate()?;
        self.target_execution_profile.validate()?;
        if self.source == self.target {
            return invalid("target", "must identify a new provider runtime");
        }
        if let Some(reference) = &self.provider_conversation_ref {
            validate_token("providerConversationRef", reference)?;
        }
        timestamp("replacedAtMs", self.replaced_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineCursorV1 {
    pub epoch: AgentTimelineEpochV1,
    pub sequence: i64,
}

impl AgentTimelineCursorV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        non_negative("sequence", self.sequence)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTimelineMessageRoleV1 {
    User,
    Assistant,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTimelineLifecycleStateV1 {
    SessionReady,
    SessionFailed,
    SessionExited,
    TurnStarted,
    TurnCompleted,
    TurnFailed,
    TurnCanceled,
}

/// Why a turn ended in `TurnFailed`. Both provider bridges write it as the
/// lifecycle `detail` token, so every consumer parses one closed vocabulary
/// instead of provider prose; the chat surface keys its recovery actions on
/// this token and never on inference from a generic failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentTurnFailureReasonV1 {
    UsageLimit,
    RateLimit,
    AuthenticationFailed,
    ContextWindowExceeded,
    ProviderError,
    RuntimeReplaced,
}

impl AgentTurnFailureReasonV1 {
    pub const fn as_token(self) -> &'static str {
        match self {
            Self::UsageLimit => "usage_limit",
            Self::RateLimit => "rate_limit",
            Self::AuthenticationFailed => "authentication_failed",
            Self::ContextWindowExceeded => "context_window_exceeded",
            Self::ProviderError => "provider_error",
            Self::RuntimeReplaced => "runtime_replaced",
        }
    }

    pub fn from_token(token: &str) -> Option<Self> {
        match token {
            "usage_limit" => Some(Self::UsageLimit),
            "rate_limit" => Some(Self::RateLimit),
            "authentication_failed" => Some(Self::AuthenticationFailed),
            "context_window_exceeded" => Some(Self::ContextWindowExceeded),
            "provider_error" => Some(Self::ProviderError),
            "runtime_replaced" => Some(Self::RuntimeReplaced),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTimelineToolStateV1 {
    Running,
    Completed,
    Failed,
    Canceled,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentTimelineItemBodyV1 {
    Lifecycle {
        state: AgentTimelineLifecycleStateV1,
        detail: Option<String>,
    },
    Message {
        role: AgentTimelineMessageRoleV1,
        markdown: String,
    },
    GoalContinuation {
        objective: String,
        goal_revision: u64,
    },
    QueuedInput {
        state: crate::AgentQueuedTurnStateV1,
    },
    PendingAnswer {
        idempotency_key: String,
        request: Box<AgentPendingRequestV1>,
        answer: Value,
    },
    Reasoning {
        text: String,
    },
    Tool {
        tool_call_id: String,
        name: String,
        state: AgentTimelineToolStateV1,
        input: Option<Value>,
        output: Option<Value>,
    },
    ToolInput {
        json_text: String,
    },
    Plan {
        value: Value,
    },
    Error {
        code: String,
        message: String,
    },
    HistoryBoundary {
        reason: String,
        requested_after_provider_sequence: i64,
        dropped_through_provider_sequence: i64,
    },
    ProviderEvidence {
        namespace: String,
        kind: String,
        value: Value,
    },
}

impl AgentTimelineItemBodyV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        match self {
            Self::Lifecycle { detail, .. } => {
                if let Some(detail) = detail {
                    bounded_text("lifecycle.detail", detail)?;
                }
            }
            Self::Message { markdown, .. } => bounded_text("message.markdown", markdown)?,
            Self::QueuedInput { .. } => {}
            Self::GoalContinuation { objective, goal_revision } => {
                bounded_text("goalContinuation.objective", objective)?;
                if *goal_revision == 0 {
                    return invalid("goalContinuation.goalRevision", "must be positive");
                }
            }
            Self::PendingAnswer {
                idempotency_key,
                request,
                answer,
            } => {
                validate_token("pendingAnswer.idempotencyKey", idempotency_key)?;
                request.runtime.validate()?;
                request.request.validate()?;
                bounded_json("pendingAnswer.answer", answer)?;
                // The retained request and answer each keep their accepted bounds.
                // Composing their history must not shrink either input's limit.
                return Ok(());
            }
            Self::Reasoning { text } => bounded_text("reasoning.text", text)?,
            Self::Tool {
                tool_call_id,
                name,
                input,
                output,
                ..
            } => {
                validate_token("tool.toolCallId", tool_call_id)?;
                bounded_text("tool.name", name)?;
                bounded_optional_json("tool.input", input.as_ref())?;
                bounded_optional_json("tool.output", output.as_ref())?;
            }
            Self::ToolInput { json_text } => bounded_text("toolInput.jsonText", json_text)?,
            Self::Plan { value } => bounded_json("plan.value", value)?,
            Self::Error { code, message } => {
                validate_token("error.code", code)?;
                bounded_text("error.message", message)?;
            }
            Self::HistoryBoundary {
                reason,
                requested_after_provider_sequence,
                dropped_through_provider_sequence,
            } => {
                validate_token("historyBoundary.reason", reason)?;
                non_negative(
                    "historyBoundary.requestedAfterProviderSequence",
                    *requested_after_provider_sequence,
                )?;
                if dropped_through_provider_sequence <= requested_after_provider_sequence {
                    return invalid(
                        "historyBoundary.droppedThroughProviderSequence",
                        "must follow requestedAfterProviderSequence",
                    );
                }
            }
            Self::ProviderEvidence {
                namespace,
                kind,
                value,
            } => {
                validate_token("providerEvidence.namespace", namespace)?;
                validate_token("providerEvidence.kind", kind)?;
                bounded_json("providerEvidence.value", value)?;
            }
        }
        bounded_json(
            "timelineItem",
            &serde_json::to_value(self).map_err(|error| DomainStoreErrorV1::InvalidRecord {
                field: "timelineItem",
                reason: error.to_string(),
            })?,
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineItemDraftV1 {
    pub item_id: AgentTimelineItemIdV1,
    pub turn_id: Option<AgentTurnIdV1>,
    pub client_message_id: Option<AgentClientMessageIdV1>,
    pub provider_message_id: Option<AgentProviderMessageIdV1>,
    pub body: AgentTimelineItemBodyV1,
    pub created_at_ms: i64,
}

impl AgentTimelineItemDraftV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        self.body.validate()?;
        timestamp("createdAtMs", self.created_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineRowV1 {
    pub cursor: AgentTimelineCursorV1,
    pub item: AgentTimelineItemDraftV1,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTimelineTextKindV1 {
    Assistant,
    Reasoning,
    ToolInput,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineTextFragmentV1 {
    pub stream_id: AgentTimelineStreamIdV1,
    pub item_id: AgentTimelineItemIdV1,
    pub kind: AgentTimelineTextKindV1,
    pub fragment: String,
    pub turn_id: Option<AgentTurnIdV1>,
    pub client_message_id: Option<AgentClientMessageIdV1>,
    pub provider_message_id: AgentProviderMessageIdV1,
    pub observed_at_ms: i64,
}

impl AgentTimelineTextFragmentV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        bounded_text("textFragment.fragment", &self.fragment)?;
        timestamp("textFragment.observedAtMs", self.observed_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineLiveTextV1 {
    pub stream_id: AgentTimelineStreamIdV1,
    pub item_id: AgentTimelineItemIdV1,
    pub kind: AgentTimelineTextKindV1,
    pub text: String,
    pub turn_id: Option<AgentTurnIdV1>,
    pub client_message_id: Option<AgentClientMessageIdV1>,
    pub provider_message_id: AgentProviderMessageIdV1,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentPendingRequestKindV1 {
    Permission,
    Question,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPendingRequestDraftV1 {
    pub request_id: AgentInteractionRequestIdV1,
    pub kind: AgentPendingRequestKindV1,
    pub turn_id: Option<AgentTurnIdV1>,
    pub client_message_id: AgentClientMessageIdV1,
    pub payload: Value,
    pub created_at_ms: i64,
}

impl AgentPendingRequestDraftV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        bounded_json("pendingRequest.payload", &self.payload)?;
        timestamp("pendingRequest.createdAtMs", self.created_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPendingRequestV1 {
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub runtime: AgentProviderRuntimeFenceV1,
    pub request: AgentPendingRequestDraftV1,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentTimelineMutationV1 {
    EstablishProviderConversation {
        provider_conversation_ref: String,
        established_at_ms: i64,
    },
    Append {
        item: AgentTimelineItemDraftV1,
    },
    AppendText {
        fragment: AgentTimelineTextFragmentV1,
    },
    FinishTextForProviderMessage {
        provider_message_id: AgentProviderMessageIdV1,
        finished_at_ms: i64,
    },
    PutPending {
        request: AgentPendingRequestDraftV1,
    },
    ResolvePending {
        request_id: AgentInteractionRequestIdV1,
        outcome: Value,
        resolved_at_ms: i64,
    },
    CancelPending {
        request_id: AgentInteractionRequestIdV1,
        reason: String,
        canceled_at_ms: i64,
    },
}

impl AgentTimelineMutationV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        match self {
            Self::EstablishProviderConversation {
                provider_conversation_ref,
                established_at_ms,
            } => {
                validate_token("providerConversationRef", provider_conversation_ref)?;
                timestamp("establishedAtMs", *established_at_ms)
            }
            Self::Append { item } => item.validate(),
            Self::AppendText { fragment } => fragment.validate(),
            Self::FinishTextForProviderMessage { finished_at_ms, .. } => {
                timestamp("finishedAtMs", *finished_at_ms)
            }
            Self::PutPending { request } => request.validate(),
            Self::ResolvePending {
                outcome,
                resolved_at_ms,
                ..
            } => {
                bounded_json("pendingOutcome", outcome)?;
                timestamp("resolvedAtMs", *resolved_at_ms)
            }
            Self::CancelPending {
                reason,
                canceled_at_ms,
                ..
            } => {
                validate_token("pendingCancelReason", reason)?;
                timestamp("canceledAtMs", *canceled_at_ms)
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProviderEventIdentityV1 {
    pub runtime: AgentProviderRuntimeFenceV1,
    pub sequence: i64,
}

impl AgentProviderEventIdentityV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        self.runtime.validate()?;
        positive("providerEvent.sequence", self.sequence)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProviderEventCommitV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub event: AgentProviderEventIdentityV1,
    /// Stable digest of the validated provider-private source event. This is
    /// what makes replay idempotent even when adapter-observation timestamps
    /// differ after a control-plane replacement.
    pub source_fingerprint: String,
    pub mutations: Vec<AgentTimelineMutationV1>,
    pub recorded_at_ms: i64,
}

impl AgentProviderEventCommitV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        self.event.validate()?;
        validate_token("sourceFingerprint", &self.source_fingerprint)?;
        if self.mutations.len() > MAX_AGENT_TIMELINE_EVENT_MUTATIONS_V1 {
            return invalid("mutations", "exceeds the per-event mutation limit");
        }
        for mutation in &self.mutations {
            mutation.validate()?;
        }
        timestamp("recordedAtMs", self.recorded_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProviderCursorV1 {
    pub runtime: AgentProviderRuntimeFenceV1,
    pub committed_through_sequence: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineCommitReceiptV1 {
    pub provider_cursor: AgentProviderCursorV1,
    pub timeline_cursor: AgentTimelineCursorV1,
    pub duplicate: bool,
    pub timeline_changed: bool,
    pub pending_changed: bool,
    pub live_text_changed: bool,
}

/// One complete provider-owned history snapshot for the exact current binding.
/// The store is the sole durable sequencer: adapters collect the full bounded
/// snapshot before presenting it here and never advance a live provider cursor.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentHistorySnapshotV1 {
    pub schema_version: u16,
    pub binding: AgentInteractionBindingV1,
    pub items: Vec<AgentTimelineItemDraftV1>,
    pub observed_at_ms: i64,
}

impl AgentHistorySnapshotV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        self.binding.validate()?;
        if self.binding.history_complete {
            return invalid(
                "binding.historyComplete",
                "history snapshot must target an incomplete binding",
            );
        }
        if self.binding.provider_conversation_ref.is_none() {
            return invalid(
                "binding.providerConversationRef",
                "history snapshot requires an exact provider conversation",
            );
        }
        if self.items.len() > MAX_AGENT_HISTORY_ITEMS_V1 {
            return invalid("items", "must be a bounded complete history");
        }
        let mut item_ids = std::collections::BTreeSet::new();
        for item in &self.items {
            item.validate()?;
            if item.turn_id.is_some() || item.client_message_id.is_some() {
                return invalid(
                    "items",
                    "provider history cannot claim a Dure turn or client message",
                );
            }
            if !item_ids.insert(&item.item_id) {
                return invalid("items", "contains duplicate stable item IDs");
            }
        }
        timestamp("observedAtMs", self.observed_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentHistorySnapshotReceiptV1 {
    pub binding: AgentInteractionBindingV1,
    pub timeline_cursor: AgentTimelineCursorV1,
    pub newly_completed: bool,
    pub timeline_changed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentHistoryHydrationDispositionV1 {
    Complete,
    Seedable,
    KnownGap,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentHistoryHydrationAuthorityV1 {
    pub binding: AgentInteractionBindingV1,
    pub disposition: AgentHistoryHydrationDispositionV1,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProviderGapV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub runtime: AgentProviderRuntimeFenceV1,
    pub requested_after_sequence: i64,
    pub dropped_through_sequence: i64,
    pub observed_at_ms: i64,
}

impl AgentProviderGapV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        self.runtime.validate()?;
        non_negative("requestedAfterSequence", self.requested_after_sequence)?;
        if self.dropped_through_sequence <= self.requested_after_sequence {
            return invalid(
                "droppedThroughSequence",
                "must follow requestedAfterSequence",
            );
        }
        timestamp("observedAtMs", self.observed_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPendingSnapshotV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub runtime: AgentProviderRuntimeFenceV1,
    pub observed_through_sequence: i64,
    pub requests: Vec<AgentPendingRequestDraftV1>,
    pub observed_at_ms: i64,
}

impl AgentPendingSnapshotV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        self.runtime.validate()?;
        non_negative("observedThroughSequence", self.observed_through_sequence)?;
        if self.requests.len() > MAX_AGENT_PENDING_REQUESTS_V1 {
            return invalid("requests", "exceeds the pending-request limit");
        }
        let mut ids = std::collections::BTreeSet::new();
        for request in &self.requests {
            request.validate()?;
            if !ids.insert(&request.request_id) {
                return invalid("requests", "contains duplicate request IDs");
            }
        }
        timestamp("observedAtMs", self.observed_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTurnEffectStateV1 {
    Prepared,
    Accepted,
    Failed,
    Uncertain,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentStartTurnIntentV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub runtime: AgentProviderRuntimeFenceV1,
    pub turn_id: AgentTurnIdV1,
    pub client_message_id: AgentClientMessageIdV1,
    pub input: String,
    pub requested_at_ms: i64,
}

impl AgentStartTurnIntentV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        self.runtime.validate()?;
        bounded_text("input", &self.input)?;
        timestamp("requestedAtMs", self.requested_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnEffectReceiptV1 {
    pub intent: AgentStartTurnIntentV1,
    pub state: AgentTurnEffectStateV1,
    pub provider_receipt: Option<Value>,
    pub timeline_cursor: AgentTimelineCursorV1,
    pub newly_prepared: bool,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCompleteTurnEffectV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub runtime: AgentProviderRuntimeFenceV1,
    pub client_message_id: AgentClientMessageIdV1,
    pub state: AgentTurnEffectStateV1,
    pub provider_receipt: Option<Value>,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentInterruptTurnRequestV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub runtime: AgentProviderRuntimeFenceV1,
    pub turn_id: AgentTurnIdV1,
    pub client_message_id: AgentClientMessageIdV1,
    pub interrupt_request_id: String,
    pub requested_at_ms: i64,
}

impl AgentInterruptTurnRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        self.runtime.validate()?;
        validate_token("interruptRequestId", &self.interrupt_request_id)?;
        timestamp("requestedAtMs", self.requested_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentInterruptTurnReceiptV1 {
    pub request: AgentInterruptTurnRequestV1,
    pub provider_receipt: Value,
    pub completed_at_ms: i64,
}

impl AgentCompleteTurnEffectV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        self.runtime.validate()?;
        if !matches!(
            self.state,
            AgentTurnEffectStateV1::Accepted | AgentTurnEffectStateV1::Failed
        ) {
            return invalid("state", "completion must be accepted or failed");
        }
        bounded_optional_json("providerReceipt", self.provider_receipt.as_ref())?;
        timestamp("updatedAtMs", self.updated_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPendingAnswerIntentV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub runtime: AgentProviderRuntimeFenceV1,
    pub request_id: AgentInteractionRequestIdV1,
    pub client_message_id: AgentClientMessageIdV1,
    pub idempotency_key: String,
    pub answer: Value,
    pub requested_at_ms: i64,
}

impl AgentPendingAnswerIntentV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        self.runtime.validate()?;
        validate_token("idempotencyKey", &self.idempotency_key)?;
        bounded_json("answer", &self.answer)?;
        timestamp("requestedAtMs", self.requested_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentPendingAnswerStateV1 {
    Prepared,
    Succeeded,
    Failed,
    Uncertain,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPendingAnswerReceiptV1 {
    pub intent: AgentPendingAnswerIntentV1,
    pub request: AgentPendingRequestV1,
    pub state: AgentPendingAnswerStateV1,
    pub provider_receipt: Option<Value>,
    pub newly_prepared: bool,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCompletePendingAnswerV1 {
    pub schema_version: u16,
    pub idempotency_key: String,
    pub state: AgentPendingAnswerStateV1,
    pub provider_receipt: Option<Value>,
    pub updated_at_ms: i64,
}

impl AgentCompletePendingAnswerV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        validate_token("idempotencyKey", &self.idempotency_key)?;
        if !matches!(
            self.state,
            AgentPendingAnswerStateV1::Succeeded | AgentPendingAnswerStateV1::Failed
        ) {
            return invalid("state", "completion must be succeeded or failed");
        }
        bounded_optional_json("providerReceipt", self.provider_receipt.as_ref())?;
        timestamp("updatedAtMs", self.updated_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTimelineReadDirectionV1 {
    After,
    Before,
    Tail,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineReadRequestV1 {
    pub schema_version: u16,
    pub interaction_session_id: AgentInteractionSessionIdV1,
    pub direction: AgentTimelineReadDirectionV1,
    pub cursor: Option<AgentTimelineCursorV1>,
    pub limit: usize,
}

impl AgentTimelineReadRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        if self.limit == 0 || self.limit > MAX_AGENT_TIMELINE_PAGE_ITEMS_V1 {
            return invalid("limit", "must be within the bounded page limit");
        }
        if let Some(cursor) = &self.cursor {
            cursor.validate()?;
        }
        match self.direction {
            AgentTimelineReadDirectionV1::After | AgentTimelineReadDirectionV1::Before
                if self.cursor.is_none() =>
            {
                invalid("cursor", "is required for before/after reads")
            }
            AgentTimelineReadDirectionV1::Tail if self.cursor.is_some() => {
                invalid("cursor", "must be absent for tail reads")
            }
            _ => Ok(()),
        }
    }
}

/// Store-derived current-turn fence, independent of the bounded row window.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelineActiveTurnV1 {
    pub turn_id: AgentTurnIdV1,
    pub client_message_id: AgentClientMessageIdV1,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTimelinePageV1 {
    pub binding: AgentInteractionBindingV1,
    pub rows: Vec<AgentTimelineRowV1>,
    pub live_text: Vec<AgentTimelineLiveTextV1>,
    pub pending_requests: Vec<AgentPendingRequestV1>,
    pub active_turn: Option<AgentTimelineActiveTurnV1>,
    pub goal: Option<crate::AgentGoalRecordV1>,
    pub queued_inputs: crate::AgentQueuedInputPageV1,
    pub final_cursor: AgentTimelineCursorV1,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentTimelineReadV1 {
    Page {
        page: AgentTimelinePageV1,
    },
    Reset {
        binding: AgentInteractionBindingV1,
        reason: String,
    },
}

pub trait AgentTimelineStore: Send + Sync {
    fn create_agent_interaction<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
    ) -> DomainStoreFuture<'a, AgentInteractionBindingV1>;

    fn agent_interaction<'a>(
        &'a self,
        interaction_session_id: &'a AgentInteractionSessionIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentInteractionBindingV1>>;

    fn agent_interaction_for_agent<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentInteractionBindingV1>>;

    fn replace_agent_interaction_runtime<'a>(
        &'a self,
        replacement: &'a AgentRuntimeReplacementV1,
    ) -> DomainStoreFuture<'a, AgentInteractionBindingV1>;

    fn agent_provider_cursor<'a>(
        &'a self,
        interaction_session_id: &'a AgentInteractionSessionIdV1,
        runtime: &'a AgentProviderRuntimeFenceV1,
    ) -> DomainStoreFuture<'a, AgentProviderCursorV1>;

    fn apply_agent_provider_event<'a>(
        &'a self,
        event: &'a AgentProviderEventCommitV1,
    ) -> DomainStoreFuture<'a, AgentTimelineCommitReceiptV1>;

    fn record_agent_provider_gap<'a>(
        &'a self,
        gap: &'a AgentProviderGapV1,
    ) -> DomainStoreFuture<'a, AgentTimelineCommitReceiptV1>;

    fn agent_history_hydration_authority<'a>(
        &'a self,
        interaction_session_id: &'a AgentInteractionSessionIdV1,
    ) -> DomainStoreFuture<'a, AgentHistoryHydrationAuthorityV1>;

    fn reconcile_agent_history<'a>(
        &'a self,
        snapshot: &'a AgentHistorySnapshotV1,
    ) -> DomainStoreFuture<'a, AgentHistorySnapshotReceiptV1>;

    fn reconcile_agent_pending_snapshot<'a>(
        &'a self,
        snapshot: &'a AgentPendingSnapshotV1,
    ) -> DomainStoreFuture<'a, AgentTimelineCommitReceiptV1>;

    fn record_agent_turn_intent<'a>(
        &'a self,
        intent: &'a AgentStartTurnIntentV1,
    ) -> DomainStoreFuture<'a, AgentTurnEffectReceiptV1>;

    /// Journals a mid-turn steer: the durable user row joins the RUNNING
    /// turn (no TurnStarted row), with the same idempotent effect tracking
    /// a turn intent gets.
    fn record_agent_steer_intent<'a>(
        &'a self,
        intent: &'a AgentStartTurnIntentV1,
    ) -> DomainStoreFuture<'a, AgentTurnEffectReceiptV1>;

    fn complete_agent_turn_effect<'a>(
        &'a self,
        completion: &'a AgentCompleteTurnEffectV1,
    ) -> DomainStoreFuture<'a, AgentTurnEffectReceiptV1>;

    fn prepare_agent_pending_answer<'a>(
        &'a self,
        intent: &'a AgentPendingAnswerIntentV1,
    ) -> DomainStoreFuture<'a, AgentPendingAnswerReceiptV1>;

    fn complete_agent_pending_answer<'a>(
        &'a self,
        completion: &'a AgentCompletePendingAnswerV1,
    ) -> DomainStoreFuture<'a, AgentPendingAnswerReceiptV1>;

    fn read_agent_timeline<'a>(
        &'a self,
        request: &'a AgentTimelineReadRequestV1,
    ) -> DomainStoreFuture<'a, AgentTimelineReadV1>;
}

fn validate_schema(schema_version: u16) -> Result<(), DomainStoreErrorV1> {
    if schema_version != AGENT_TIMELINE_SCHEMA_VERSION_V1 {
        return invalid("schemaVersion", "unsupported Agent timeline schema");
    }
    Ok(())
}

fn bounded_text(field: &'static str, value: &str) -> Result<(), DomainStoreErrorV1> {
    if value.len() > MAX_AGENT_TIMELINE_TEXT_BYTES_V1 || value.contains('\0') {
        return invalid(field, "must be bounded and free of NUL bytes");
    }
    Ok(())
}

fn bounded_optional_json(
    field: &'static str,
    value: Option<&Value>,
) -> Result<(), DomainStoreErrorV1> {
    if let Some(value) = value {
        bounded_json(field, value)?;
    }
    Ok(())
}

fn bounded_json(field: &'static str, value: &Value) -> Result<(), DomainStoreErrorV1> {
    let bytes = serde_json::to_vec(value).map_err(|error| DomainStoreErrorV1::InvalidRecord {
        field,
        reason: error.to_string(),
    })?;
    if bytes.len() > MAX_AGENT_TIMELINE_JSON_BYTES_V1 {
        return invalid(field, "exceeds the bounded JSON size");
    }
    Ok(())
}

fn timestamp(field: &'static str, value: i64) -> Result<(), DomainStoreErrorV1> {
    non_negative(field, value)
}

fn non_negative(field: &'static str, value: i64) -> Result<(), DomainStoreErrorV1> {
    if value < 0 {
        return invalid(field, "must be non-negative");
    }
    Ok(())
}

fn positive(field: &'static str, value: i64) -> Result<(), DomainStoreErrorV1> {
    if value < 1 {
        return invalid(field, "must be positive");
    }
    Ok(())
}

fn invalid<T>(field: &'static str, reason: &'static str) -> Result<T, DomainStoreErrorV1> {
    Err(DomainStoreErrorV1::InvalidRecord {
        field,
        reason: reason.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> AgentInteractionBindingV1 {
        AgentInteractionBindingV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            provider_id: ProviderIdV1::new("claude").unwrap(),
            execution_profile: AgentExecutionProfileV1::CredentialReference {
                reference_id: "credential-a".into(),
                credential_generation: Some("generation-a".into()),
            },
            provider_conversation_ref: None,
            runtime: AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-1".into(),
                provider_epoch: "epoch-1".into(),
            },
            timeline_epoch: AgentTimelineEpochV1::new("timeline-1").unwrap(),
            binding_revision: 1,
            history_complete: true,
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    #[test]
    fn read_pages_and_provider_payloads_are_bounded() {
        let session = AgentInteractionSessionIdV1::new("interaction-1").unwrap();
        assert!(
            AgentTimelineReadRequestV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: session,
                direction: AgentTimelineReadDirectionV1::Tail,
                cursor: None,
                limit: MAX_AGENT_TIMELINE_PAGE_ITEMS_V1 + 1,
            }
            .validate()
            .is_err()
        );
        assert!(
            AgentTimelineItemBodyV1::ProviderEvidence {
                namespace: "provider.fake".into(),
                kind: "oversized".into(),
                value: Value::String("x".repeat(MAX_AGENT_TIMELINE_JSON_BYTES_V1)),
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn provider_reference_may_advance_without_weakening_runtime_authority() {
        let source = binding();
        let mut established = source.clone();
        established.provider_conversation_ref = Some("session-1".into());
        established.binding_revision = 2;
        established.updated_at_ms = 2;
        established.history_complete = false;
        assert!(source.same_runtime_authority(&established));
        assert!(!source.same_history_authority(&established));

        let mut completed = established.clone();
        completed.history_complete = true;
        completed.updated_at_ms = 3;
        assert!(established.same_history_authority(&completed));

        let mut changed_provider_conversation = established.clone();
        changed_provider_conversation.provider_conversation_ref = Some("session-2".into());
        assert!(!established.same_runtime_authority(&changed_provider_conversation));

        let mut changed_credential = established.clone();
        changed_credential.execution_profile = AgentExecutionProfileV1::ProviderDefault;
        assert!(!source.same_runtime_authority(&changed_credential));

        let mut changed_runtime = established;
        changed_runtime.runtime.runtime_generation = "runtime-2".into();
        assert!(!source.same_runtime_authority(&changed_runtime));
    }
}
