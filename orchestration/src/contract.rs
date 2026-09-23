//! Versioned transport-neutral request and response contract.

mod event_inspection;
mod interaction_progress;
pub use event_inspection::InspectEventsRequest;
pub use interaction_progress::*;

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::domain::{
    Audience, AudienceGrant, AuthorityScope, CapabilityRef, DecisionAnswer, DeliveryReceiptId,
    DispatchState, EventCursor, Generation, INTERACTION_SCHEMA_VERSION,
    IntegrationCapabilityReceipt, InteractionCommon, InteractionId, InteractionRecord,
    InteractionTarget, MessagePurpose, ParticipantRef, ResponseSpec, Revision, RunTaskSpec,
    RuntimeRef, SessionIdentityRef, TargetReferenceRef, ValidationError, WakeEffectRef,
    WakeReasonCode, WorkerEndpointFence, WorkerEndpointRef, WorkerSessionGeneration,
    WorkflowKindRef, validate_idempotency_key, validate_timestamp,
};

pub const ORCHESTRATION_API_VERSION: &str = "dure.orchestration/v1";
pub const MAX_READ_EVENTS_BATCH_ITEMS: usize = 32;
const MAX_READ_EVENTS_CORRELATION_ID_BYTES: usize = 128;

fn active_dispatch_state() -> DispatchState {
    DispatchState::Active
}

/// Capability-bearing context returned after the serving adapter authenticates
/// and negotiates one exact worker session. It is transport-neutral and safe to
/// carry over the embedded socket, SSH gateway, or a future hosted API.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchContextReceipt {
    pub schema_version: u16,
    pub target: InteractionTarget,
    pub dispatch_revision: Revision,
    #[serde(default = "active_dispatch_state")]
    pub dispatch_state: DispatchState,
    #[serde(default)]
    pub successor_required: bool,
    pub participant: ParticipantRef,
    pub interaction_capability: CapabilityRef,
    pub completion_capability: CapabilityRef,
    pub delivery_capability: CapabilityRef,
    pub acknowledgement_capability: CapabilityRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_capability: Option<CapabilityRef>,
    pub endpoint_fence: WorkerEndpointFence,
    pub coordinator_grant: AudienceGrant,
    pub coordinator_reply_capability: CapabilityRef,
    pub integration_receipt: IntegrationCapabilityReceipt,
}

impl DispatchContextReceipt {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_schema(self.schema_version)?;
        self.target.validate()?;
        self.dispatch_revision.validate()?;
        if self.successor_required && self.dispatch_state != DispatchState::Completed {
            return Err(ValidationError {
                field: "successorRequired",
                code: "dispatch_not_completed",
            });
        }
        self.participant.validate()?;
        self.interaction_capability.validate()?;
        self.completion_capability.validate()?;
        self.delivery_capability.validate()?;
        self.acknowledgement_capability.validate()?;
        if let Some(wake_capability) = &self.wake_capability {
            wake_capability.validate()?;
        }
        self.endpoint_fence.validate()?;
        self.integration_receipt.validate()?;
        self.coordinator_reply_capability.validate()?;
        if self.endpoint_fence.generation != self.target.generation
            || self.endpoint_fence.delivery_capability != self.delivery_capability
            || self.endpoint_fence.acknowledgement_capability != self.acknowledgement_capability
        {
            return Err(ValidationError {
                field: "endpointFence",
                code: "context_mismatch",
            });
        }
        let audience = Audience {
            grants: vec![self.coordinator_grant.clone()],
        };
        audience.validate(&self.participant)?;
        if !self
            .coordinator_grant
            .grants(&self.coordinator_reply_capability)
        {
            return Err(ValidationError {
                field: "coordinatorGrant",
                code: "reply_capability_missing",
            });
        }
        if self.coordinator_grant.participant == self.participant {
            return Err(ValidationError {
                field: "coordinatorGrant.participant",
                code: "worker_participant_reused",
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRunRequest {
    pub schema_version: u16,
    pub authority: AuthorityScope,
    pub workflow_kind_ref: WorkflowKindRef,
    pub task: RunTaskSpec,
    pub session: WorkerSessionGeneration,
    pub integration_receipt: IntegrationCapabilityReceipt,
    pub runtime_ref: RuntimeRef,
    pub target_reference: TargetReferenceRef,
    pub idempotency_key: String,
    pub created_at_ms: i64,
}

impl CreateRunRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_schema(self.schema_version)?;
        self.authority.validate()?;
        self.workflow_kind_ref.validate()?;
        self.task.validate()?;
        self.session.validate()?;
        self.integration_receipt.validate()?;
        self.runtime_ref.validate()?;
        self.target_reference.validate()?;
        validate_idempotency_key(&self.idempotency_key)?;
        validate_timestamp("createdAtMs", self.created_at_ms)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionDraftCommon {
    pub id: InteractionId,
    pub target: InteractionTarget,
    pub author: ParticipantRef,
    pub audience: Audience,
    pub title: String,
    pub description_markdown: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum InteractionDraft {
    Message {
        common: InteractionDraftCommon,
        purpose: MessagePurpose,
    },
    Decision {
        common: InteractionDraftCommon,
        response: ResponseSpec,
        reply_capability: CapabilityRef,
    },
}

impl InteractionDraft {
    pub fn common(&self) -> &InteractionDraftCommon {
        match self {
            Self::Message { common, .. } | Self::Decision { common, .. } => common,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenInteractionRequest {
    pub schema_version: u16,
    pub idempotency_key: String,
    pub write_capability: CapabilityRef,
    pub expected_dispatch_revision: Revision,
    pub opened_at_ms: i64,
    pub interaction: InteractionDraft,
}

impl OpenInteractionRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_schema(self.schema_version)?;
        validate_idempotency_key(&self.idempotency_key)?;
        self.write_capability.validate()?;
        self.expected_dispatch_revision.validate()?;
        validate_timestamp("openedAtMs", self.opened_at_ms)?;
        let common = self.interaction.common();
        let record = match &self.interaction {
            InteractionDraft::Message { purpose, .. } => InteractionRecord::Message {
                common: common.clone().into_record(self.opened_at_ms),
                purpose: *purpose,
            },
            InteractionDraft::Decision {
                response,
                reply_capability,
                ..
            } => InteractionRecord::Decision {
                common: common.clone().into_record(self.opened_at_ms),
                response: response.clone(),
                reply_capability: reply_capability.clone(),
                state: crate::domain::DecisionState::Open,
            },
        };
        record.validate()
    }
}

impl InteractionDraftCommon {
    pub(crate) fn into_record(self, created_at_ms: i64) -> crate::domain::InteractionCommon {
        crate::domain::InteractionCommon {
            id: self.id,
            target: self.target,
            author: self.author,
            audience: self.audience,
            title: self.title,
            description_markdown: self.description_markdown,
            revision: Revision::INITIAL,
            created_at_ms,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetInteractionRequest {
    pub schema_version: u16,
    pub authority: AuthorityScope,
    pub interaction_id: InteractionId,
    pub participant: ParticipantRef,
    pub read_capability: CapabilityRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_fence: Option<WorkerEndpointFence>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnswerDecisionRequest {
    pub schema_version: u16,
    pub idempotency_key: String,
    pub interaction_id: InteractionId,
    pub target: InteractionTarget,
    pub expected_revision: Revision,
    pub expected_dispatch_revision: Revision,
    pub answered_by: ParticipantRef,
    pub reply_capability: CapabilityRef,
    pub answer: DecisionAnswer,
    pub answered_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompleteDispatchRequest {
    pub schema_version: u16,
    pub idempotency_key: String,
    pub message_id: InteractionId,
    pub target: InteractionTarget,
    pub expected_dispatch_revision: Revision,
    pub completed_by: ParticipantRef,
    pub endpoint_fence: WorkerEndpointFence,
    pub audience: Audience,
    pub completion_capability: CapabilityRef,
    pub title: String,
    pub result_markdown: String,
    pub completed_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadEventsRequest {
    pub schema_version: u16,
    pub authority: AuthorityScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<InteractionTarget>,
    pub participant: ParticipantRef,
    pub delivery_capability: CapabilityRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_fence: Option<WorkerEndpointFence>,
    pub after: EventCursor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acknowledgement: Option<EventAcknowledgement>,
    pub limit: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadEventsBatchItemRequest {
    pub correlation_id: String,
    pub request: ReadEventsRequest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadEventsBatchRequest {
    pub schema_version: u16,
    pub authority: AuthorityScope,
    pub requests: Vec<ReadEventsBatchItemRequest>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventAcknowledgement {
    pub through: EventCursor,
    pub idempotency_key: String,
    pub acknowledgement_capability: CapabilityRef,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    Queued,
    Observed,
    Acknowledged,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryWakeState {
    Pending,
    Uncertain,
    Triggered,
    QueuedUntilNextTurn,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryWakeReceipt {
    pub state: DeliveryWakeState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect_ref: Option<WakeEffectRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<WakeReasonCode>,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryReceipt {
    pub receipt_id: DeliveryReceiptId,
    pub event_cursor: EventCursor,
    pub participant: ParticipantRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<DeliveryEndpointReceipt>,
    pub state: DeliveryState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake: Option<DeliveryWakeReceipt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "transition"
)]
pub enum DeliveryWakeTransition {
    Request,
    Claim,
    Triggered { effect_ref: WakeEffectRef },
    QueuedUntilNextTurn { reason_code: WakeReasonCode },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransitionDeliveryWakeRequest {
    pub schema_version: u16,
    pub authority: AuthorityScope,
    pub receipt_id: DeliveryReceiptId,
    pub endpoint_fence: WorkerEndpointFence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_capability: Option<CapabilityRef>,
    pub transition: DeliveryWakeTransition,
    pub transitioned_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransitionDeliveryWakeReceipt {
    pub delivery: DeliveryReceipt,
    pub applied: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventAcknowledgementReceipt {
    pub through: EventCursor,
    pub delivery: DeliveryReceipt,
    pub idempotent: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryEndpointReceipt {
    pub endpoint_ref: WorkerEndpointRef,
    pub session_identity: SessionIdentityRef,
    pub generation: Generation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum EventKind {
    RunCreated { workflow_kind_ref: WorkflowKindRef },
    InteractionOpened { interaction_id: InteractionId },
    DispatchBlocked { decision_id: InteractionId },
    DecisionAnswered { decision_id: InteractionId },
    DispatchUnblocked { decision_id: InteractionId },
    DispatchCompleted { message_id: InteractionId },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub cursor: EventCursor,
    pub target: InteractionTarget,
    pub actor: ParticipantRef,
    pub kind: EventKind,
    pub recorded_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenInteractionReceipt {
    pub interaction: InteractionRecord,
    pub dispatch_state: DispatchState,
    pub events: Vec<Event>,
    pub deliveries: Vec<DeliveryReceipt>,
    pub idempotent: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRunReceipt {
    pub context: DispatchContextReceipt,
    pub event: Event,
    pub deliveries: Vec<DeliveryReceipt>,
    pub idempotent: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnswerDecisionReceipt {
    pub interaction: InteractionRecord,
    pub dispatch_state: DispatchState,
    pub events: Vec<Event>,
    pub deliveries: Vec<DeliveryReceipt>,
    pub idempotent: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompleteDispatchReceipt {
    pub message: InteractionRecord,
    pub dispatch_state: DispatchState,
    pub events: Vec<Event>,
    pub deliveries: Vec<DeliveryReceipt>,
    pub idempotent: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadEventsReceipt {
    pub events: Vec<Event>,
    pub deliveries: Vec<DeliveryReceipt>,
    pub next_cursor: EventCursor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acknowledgement: Option<Box<EventAcknowledgementReceipt>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReadEventsBatchItemOutcome {
    Read(ReadEventsReceipt),
    Failed(ServiceError),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadEventsBatchItemReceipt {
    pub correlation_id: String,
    pub outcome: ReadEventsBatchItemOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadEventsBatchReceipt {
    pub schema_version: u16,
    pub authority: AuthorityScope,
    pub results: Vec<ReadEventsBatchItemReceipt>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ServiceError {
    Invalid {
        field: &'static str,
        code: &'static str,
    },
    NotFound {
        resource: &'static str,
    },
    IdempotencyConflict,
    GenerationConflict,
    RevisionConflict,
    CapabilityDenied,
    StateConflict {
        code: &'static str,
    },
    StorageUnavailable {
        code: &'static str,
    },
    StorageCorrupt {
        code: &'static str,
    },
}

impl From<ValidationError> for ServiceError {
    fn from(error: ValidationError) -> Self {
        Self::Invalid {
            field: error.field,
            code: error.code,
        }
    }
}

impl CompleteDispatchRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_schema(self.schema_version)?;
        validate_idempotency_key(&self.idempotency_key)?;
        self.expected_dispatch_revision.validate()?;
        self.endpoint_fence.validate()?;
        self.completion_capability.validate()?;
        InteractionRecord::Message {
            common: InteractionCommon {
                id: self.message_id.clone(),
                target: self.target.clone(),
                author: self.completed_by.clone(),
                audience: self.audience.clone(),
                title: self.title.clone(),
                description_markdown: self.result_markdown.clone(),
                revision: Revision::INITIAL,
                created_at_ms: self.completed_at_ms,
            },
            purpose: MessagePurpose::CompletionReport,
        }
        .validate()
    }
}

impl AnswerDecisionRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_schema(self.schema_version)?;
        validate_idempotency_key(&self.idempotency_key)?;
        self.interaction_id.validate()?;
        self.target.validate()?;
        self.expected_revision.validate()?;
        self.expected_dispatch_revision.validate()?;
        self.answered_by.validate()?;
        self.reply_capability.validate()?;
        validate_timestamp("answeredAtMs", self.answered_at_ms)?;
        match &self.answer {
            DecisionAnswer::Text { value } => {
                if value.len() > crate::domain::MAX_TEXT_ANSWER_BYTES {
                    return Err(ValidationError {
                        field: "answer.value",
                        code: "size_out_of_bounds",
                    });
                }
            }
            DecisionAnswer::Select { option_ids } => {
                if option_ids.len() > crate::domain::MAX_SELECT_OPTIONS {
                    return Err(ValidationError {
                        field: "answer.optionIds",
                        code: "selection_count_out_of_bounds",
                    });
                }
            }
        }
        Ok(())
    }
}

impl ReadEventsRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_schema(self.schema_version)?;
        self.authority.validate()?;
        self.participant.validate()?;
        self.delivery_capability.validate()?;
        if self.limit == 0 || self.limit > 128 {
            return Err(ValidationError {
                field: "limit",
                code: "size_out_of_bounds",
            });
        }
        if let Some(target) = &self.target {
            target.validate()?;
            if target.authority != self.authority {
                return Err(ValidationError {
                    field: "target.authority",
                    code: "scope_mismatch",
                });
            }
        }
        if let Some(fence) = &self.endpoint_fence {
            fence.validate()?;
            if self.target.is_none() {
                return Err(ValidationError {
                    field: "endpointFence",
                    code: "target_required",
                });
            }
            if fence.delivery_capability != self.delivery_capability {
                return Err(ValidationError {
                    field: "endpointFence.deliveryCapability",
                    code: "capability_mismatch",
                });
            }
        }
        if let Some(acknowledgement) = &self.acknowledgement {
            validate_idempotency_key(&acknowledgement.idempotency_key)?;
            acknowledgement.acknowledgement_capability.validate()?;
            if acknowledgement.through == EventCursor::BEGINNING {
                return Err(ValidationError {
                    field: "acknowledgement.through",
                    code: "must_be_positive",
                });
            }
            if acknowledgement.through > self.after {
                return Err(ValidationError {
                    field: "acknowledgement.through",
                    code: "ahead_of_cursor",
                });
            }
            if let Some(fence) = &self.endpoint_fence {
                if acknowledgement.acknowledgement_capability != fence.acknowledgement_capability {
                    return Err(ValidationError {
                        field: "acknowledgement.acknowledgementCapability",
                        code: "capability_mismatch",
                    });
                }
            } else if acknowledgement.acknowledgement_capability != self.delivery_capability {
                return Err(ValidationError {
                    field: "acknowledgement.acknowledgementCapability",
                    code: "capability_mismatch",
                });
            }
        }
        Ok(())
    }
}

impl ReadEventsBatchRequest {
    pub fn validate_envelope(&self) -> Result<(), ValidationError> {
        validate_schema(self.schema_version)?;
        self.authority.validate()?;
        if self.requests.is_empty() || self.requests.len() > MAX_READ_EVENTS_BATCH_ITEMS {
            return Err(ValidationError {
                field: "requests",
                code: "size_out_of_bounds",
            });
        }
        let mut correlations = BTreeSet::new();
        for item in &self.requests {
            if item.correlation_id.is_empty()
                || item.correlation_id.len() > MAX_READ_EVENTS_CORRELATION_ID_BYTES
                || !item.correlation_id.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':')
                })
            {
                return Err(ValidationError {
                    field: "requests.correlationId",
                    code: "invalid",
                });
            }
            if !correlations.insert(item.correlation_id.as_str()) {
                return Err(ValidationError {
                    field: "requests.correlationId",
                    code: "duplicate",
                });
            }
        }
        Ok(())
    }
}

impl DeliveryEndpointReceipt {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        self.endpoint_ref.validate()?;
        self.session_identity.validate()?;
        self.generation.validate()
    }
}

impl DeliveryReceipt {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        self.receipt_id.validate()?;
        self.participant.validate()?;
        if let Some(endpoint) = &self.endpoint {
            endpoint.validate()?;
        }
        if let Some(wake) = &self.wake {
            wake.validate()?;
            if self.endpoint.is_none() {
                return Err(ValidationError {
                    field: "delivery.wake",
                    code: "endpoint_missing",
                });
            }
        }
        Ok(())
    }
}

impl DeliveryWakeReceipt {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        validate_timestamp("wake.updatedAtMs", self.updated_at_ms)?;
        if let Some(effect_ref) = &self.effect_ref {
            effect_ref.validate()?;
        }
        if let Some(reason_code) = &self.reason_code {
            reason_code.validate()?;
        }
        let shape_is_valid = match self.state {
            DeliveryWakeState::Pending | DeliveryWakeState::Uncertain => {
                self.effect_ref.is_none() && self.reason_code.is_none()
            }
            DeliveryWakeState::Triggered => self.effect_ref.is_some() && self.reason_code.is_none(),
            DeliveryWakeState::QueuedUntilNextTurn => {
                self.effect_ref.is_none() && self.reason_code.is_some()
            }
        };
        if !shape_is_valid {
            return Err(ValidationError {
                field: "delivery.wake",
                code: "state_shape_invalid",
            });
        }
        Ok(())
    }
}

impl DeliveryWakeTransition {
    fn validate(&self) -> Result<(), ValidationError> {
        match self {
            Self::Request | Self::Claim => Ok(()),
            Self::Triggered { effect_ref } => effect_ref.validate(),
            Self::QueuedUntilNextTurn { reason_code } => reason_code.validate(),
        }
    }
}

impl TransitionDeliveryWakeRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_schema(self.schema_version)?;
        self.authority.validate()?;
        self.receipt_id.validate()?;
        self.endpoint_fence.validate()?;
        if let Some(wake_capability) = &self.wake_capability {
            wake_capability.validate()?;
        }
        self.transition.validate()?;
        validate_timestamp("transitionedAtMs", self.transitioned_at_ms)?;
        if !matches!(self.transition, DeliveryWakeTransition::Request)
            && self.wake_capability.is_none()
        {
            return Err(ValidationError {
                field: "wakeCapability",
                code: "capability_missing",
            });
        }
        Ok(())
    }
}

impl Event {
    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        self.target.validate()?;
        self.actor.validate()?;
        validate_timestamp("recordedAtMs", self.recorded_at_ms)?;
        match &self.kind {
            EventKind::RunCreated { workflow_kind_ref } => workflow_kind_ref.validate(),
            EventKind::InteractionOpened { interaction_id } => interaction_id.validate(),
            EventKind::DispatchBlocked { decision_id }
            | EventKind::DecisionAnswered { decision_id }
            | EventKind::DispatchUnblocked { decision_id } => decision_id.validate(),
            EventKind::DispatchCompleted { message_id } => message_id.validate(),
        }
    }
}

pub(crate) fn validate_schema(schema_version: u16) -> Result<(), ValidationError> {
    if schema_version != INTERACTION_SCHEMA_VERSION {
        return Err(ValidationError {
            field: "schemaVersion",
            code: "unsupported",
        });
    }
    Ok(())
}
