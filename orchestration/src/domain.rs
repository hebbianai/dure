//! Canonical durable workflow and interaction model.

pub mod graph;

use std::collections::BTreeSet;
use std::fmt;

use serde::{Deserialize, Serialize};

pub const INTERACTION_SCHEMA_VERSION: u16 = 1;
pub const MAX_REFERENCE_BYTES: usize = 256;
pub const MAX_IDEMPOTENCY_KEY_BYTES: usize = 128;
pub const MAX_TITLE_BYTES: usize = 512;
pub const MAX_MARKDOWN_BYTES: usize = 64 * 1024;
pub const MAX_TEXT_ANSWER_BYTES: usize = 16 * 1024;
pub const MAX_TASK_INSTRUCTIONS_BYTES: usize = 16 * 1024;
pub const MAX_AUDIENCE_MEMBERS: usize = 64;
pub const MAX_ROLES_PER_PARTICIPANT: usize = 16;
pub const MAX_CAPABILITIES_PER_PARTICIPANT: usize = 16;
pub const MAX_SELECT_OPTIONS: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidationError {
    pub field: &'static str,
    pub code: &'static str,
}

impl fmt::Display for ValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.field, self.code)
    }
}

impl std::error::Error for ValidationError {}

macro_rules! bounded_reference {
    ($name:ident, $field:literal) => {
        #[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
                let value = value.into();
                validate_reference($field, &value)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub(crate) fn validate(&self) -> Result<(), ValidationError> {
                validate_reference($field, &self.0)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

bounded_reference!(RunId, "runId");
bounded_reference!(TaskId, "taskId");
bounded_reference!(DispatchId, "dispatchId");
bounded_reference!(InteractionId, "interactionId");
bounded_reference!(DeliveryReceiptId, "deliveryReceiptId");
bounded_reference!(WakeEffectRef, "wake.effectRef");
bounded_reference!(WakeReasonCode, "wake.reasonCode");
bounded_reference!(MembershipRef, "membershipRef");
bounded_reference!(WorkspaceId, "workspaceId");
bounded_reference!(TenantRef, "tenantRef");
bounded_reference!(ParticipantRef, "participantRef");
bounded_reference!(RoleRef, "roleRef");
bounded_reference!(CapabilityRef, "capabilityRef");
bounded_reference!(OptionId, "optionId");
bounded_reference!(WorkerEndpointRef, "workerEndpointRef");
bounded_reference!(SessionIdentityRef, "sessionIdentityRef");
bounded_reference!(InstallRootRef, "installRootRef");
bounded_reference!(IntegrationVersion, "integrationVersion");
bounded_reference!(IntegrationChannel, "integrationChannel");
bounded_reference!(WorkflowKindRef, "workflowKindRef");
bounded_reference!(RuntimeRef, "runtimeRef");
bounded_reference!(TargetReferenceRef, "targetReference");
bounded_reference!(SessionRef, "session.sessionId");
bounded_reference!(ProviderRef, "session.providerId");
bounded_reference!(RunnerPrincipalRef, "session.runnerPrincipal");
bounded_reference!(RunnerInstanceRef, "session.runnerInstance");
bounded_reference!(ChannelEpochRef, "session.channelEpoch");
bounded_reference!(HostInstanceRef, "session.hostInstanceId");
bounded_reference!(TerminalEpochRef, "session.terminalEpoch");

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Sha256Digest(String);

impl Sha256Digest {
    pub fn new(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        let valid = value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));
        if !valid {
            return Err(invalid("sha256Digest", "invalid"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn validate(&self) -> Result<(), ValidationError> {
        Self::new(self.0.clone()).map(|_| ())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct Generation(u64);

impl Generation {
    pub fn new(value: u64) -> Result<Self, ValidationError> {
        if value == 0 {
            return Err(invalid("generation", "must_be_positive"));
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u64 {
        self.0
    }

    pub(crate) fn validate(self) -> Result<(), ValidationError> {
        Self::new(self.0).map(|_| ())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct Revision(u64);

impl Revision {
    pub const INITIAL: Self = Self(1);

    pub fn new(value: u64) -> Result<Self, ValidationError> {
        if value == 0 {
            return Err(invalid("revision", "must_be_positive"));
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u64 {
        self.0
    }

    pub(crate) fn validate(self) -> Result<(), ValidationError> {
        Self::new(self.0).map(|_| ())
    }

    pub fn checked_next(self) -> Option<Self> {
        self.0.checked_add(1).map(Self)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct EventCursor(u64);

impl EventCursor {
    pub const BEGINNING: Self = Self(0);

    pub fn new(value: u64) -> Self {
        Self(value)
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityScope {
    pub workspace_id: WorkspaceId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_ref: Option<TenantRef>,
}

impl AuthorityScope {
    pub fn validate(&self) -> Result<(), ValidationError> {
        self.workspace_id.validate()?;
        if let Some(tenant_ref) = &self.tenant_ref {
            tenant_ref.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionTarget {
    pub authority: AuthorityScope,
    pub run_id: RunId,
    pub task_id: TaskId,
    pub dispatch_id: DispatchId,
    pub generation: Generation,
}

impl InteractionTarget {
    pub fn validate(&self) -> Result<(), ValidationError> {
        self.authority.validate()?;
        self.run_id.validate()?;
        self.task_id.validate()?;
        self.dispatch_id.validate()?;
        self.generation.validate()
    }
}

/// Exact, transport-neutral generation receipt for one worker session.
///
/// The fields are opaque fencing evidence. The core never interprets them as
/// local paths, SSH identities, runtime-specific state, or provider semantics.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerSessionGeneration {
    pub session_id: SessionRef,
    pub workspace_id: WorkspaceId,
    pub provider_id: ProviderRef,
    pub runner_principal: RunnerPrincipalRef,
    pub runner_instance: RunnerInstanceRef,
    pub channel_epoch: ChannelEpochRef,
    pub host_instance_id: HostInstanceRef,
    pub terminal_epoch: TerminalEpochRef,
}

impl WorkerSessionGeneration {
    pub fn validate(&self) -> Result<(), ValidationError> {
        self.session_id.validate()?;
        self.workspace_id.validate()?;
        self.provider_id.validate()?;
        self.runner_principal.validate()?;
        self.runner_instance.validate()?;
        self.channel_epoch.validate()?;
        self.host_instance_id.validate()?;
        self.terminal_epoch.validate()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunTaskSpec {
    pub summary: String,
    pub instructions: String,
}

impl RunTaskSpec {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_plain_text("task.summary", &self.summary, MAX_TITLE_BYTES, false)?;
        if self.instructions.is_empty() || self.instructions.len() > MAX_TASK_INSTRUCTIONS_BYTES {
            return Err(invalid("task.instructions", "size_out_of_bounds"));
        }
        validate_control_free("task.instructions", &self.instructions, true)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerEndpoint {
    pub endpoint_ref: WorkerEndpointRef,
    pub participant: ParticipantRef,
    pub session_identity: SessionIdentityRef,
    pub generation: Generation,
    pub delivery_capability: CapabilityRef,
    pub acknowledgement_capability: CapabilityRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_capability: Option<CapabilityRef>,
    pub integration_receipt: IntegrationCapabilityReceipt,
}

impl WorkerEndpoint {
    pub fn validate(&self) -> Result<(), ValidationError> {
        self.endpoint_ref.validate()?;
        self.participant.validate()?;
        self.session_identity.validate()?;
        self.generation.validate()?;
        self.delivery_capability.validate()?;
        self.acknowledgement_capability.validate()?;
        if let Some(wake_capability) = &self.wake_capability {
            wake_capability.validate()?;
        }
        self.integration_receipt.validate()?;
        if !self
            .integration_receipt
            .capabilities
            .iter()
            .any(|capability| capability.as_str() == "event_cursor_v1")
            || !self
                .integration_receipt
                .capabilities
                .iter()
                .any(|capability| capability.as_str() == "idempotent_delivery_receipt_v1")
        {
            return Err(invalid(
                "workerEndpoint.integrationReceipt",
                "capability_missing",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationCapabilityReceipt {
    pub install_root_ref: InstallRootRef,
    pub version: IntegrationVersion,
    pub digest: Sha256Digest,
    pub channel: IntegrationChannel,
    pub capabilities: Vec<CapabilityRef>,
}

impl IntegrationCapabilityReceipt {
    pub fn validate(&self) -> Result<(), ValidationError> {
        self.install_root_ref.validate()?;
        self.version.validate()?;
        self.digest.validate()?;
        self.channel.validate()?;
        validate_unique_bounded(
            "integrationReceipt.capabilities",
            &self.capabilities,
            MAX_CAPABILITIES_PER_PARTICIPANT,
            CapabilityRef::validate,
        )?;
        if self.capabilities.is_empty() {
            return Err(invalid(
                "integrationReceipt.capabilities",
                "size_out_of_bounds",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerEndpointFence {
    pub endpoint_ref: WorkerEndpointRef,
    pub session_identity: SessionIdentityRef,
    pub generation: Generation,
    pub delivery_capability: CapabilityRef,
    pub acknowledgement_capability: CapabilityRef,
}

impl WorkerEndpointFence {
    pub fn validate(&self) -> Result<(), ValidationError> {
        self.endpoint_ref.validate()?;
        self.session_identity.validate()?;
        self.generation.validate()?;
        self.delivery_capability.validate()?;
        self.acknowledgement_capability.validate()
    }

    pub fn matches(&self, endpoint: &WorkerEndpoint) -> bool {
        self.endpoint_ref == endpoint.endpoint_ref
            && self.session_identity == endpoint.session_identity
            && self.generation == endpoint.generation
            && self.delivery_capability == endpoint.delivery_capability
            && self.acknowledgement_capability == endpoint.acknowledgement_capability
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudienceGrant {
    pub membership_ref: MembershipRef,
    pub participant: ParticipantRef,
    #[serde(default)]
    pub roles: Vec<RoleRef>,
    pub capabilities: Vec<CapabilityRef>,
    pub delivery_capability: CapabilityRef,
}

impl AudienceGrant {
    fn validate(&self, author: &ParticipantRef) -> Result<(), ValidationError> {
        self.membership_ref.validate()?;
        self.participant.validate()?;
        validate_unique_bounded(
            "audience.roles",
            &self.roles,
            MAX_ROLES_PER_PARTICIPANT,
            RoleRef::validate,
        )?;
        validate_unique_bounded(
            "audience.capabilities",
            &self.capabilities,
            MAX_CAPABILITIES_PER_PARTICIPANT,
            CapabilityRef::validate,
        )?;
        self.delivery_capability.validate()?;
        if !self.grants(&self.delivery_capability) {
            return Err(invalid("audience.deliveryCapability", "capability_missing"));
        }
        if &self.participant != author && self.roles.is_empty() {
            return Err(invalid("audience.roles", "membership_role_required"));
        }
        Ok(())
    }

    pub fn grants(&self, capability: &CapabilityRef) -> bool {
        self.capabilities.contains(capability)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Audience {
    pub grants: Vec<AudienceGrant>,
}

impl Audience {
    pub fn validate(&self, author: &ParticipantRef) -> Result<(), ValidationError> {
        if self.grants.is_empty() || self.grants.len() > MAX_AUDIENCE_MEMBERS {
            return Err(invalid("audience", "size_out_of_bounds"));
        }
        let mut participants = BTreeSet::new();
        for grant in &self.grants {
            grant.validate(author)?;
            if !participants.insert(grant.participant.clone()) {
                return Err(invalid("audience", "duplicate_participant"));
            }
        }
        Ok(())
    }

    pub fn grant_for(&self, participant: &ParticipantRef) -> Option<&AudienceGrant> {
        self.grants
            .iter()
            .find(|grant| &grant.participant == participant)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MessagePurpose {
    Update,
    CompletionReport,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectOption {
    pub id: OptionId,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description_markdown: Option<String>,
}

impl SelectOption {
    fn validate(&self) -> Result<(), ValidationError> {
        self.id.validate()?;
        validate_plain_text(
            "response.options.label",
            &self.label,
            MAX_TITLE_BYTES,
            false,
        )?;
        if let Some(description) = &self.description_markdown {
            validate_markdown("response.options.descriptionMarkdown", description)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum ResponseSpec {
    Text {
        min_bytes: usize,
        max_bytes: usize,
    },
    Select {
        options: Vec<SelectOption>,
        min_selections: usize,
        max_selections: usize,
    },
}

impl ResponseSpec {
    pub fn validate(&self) -> Result<(), ValidationError> {
        match self {
            Self::Text {
                min_bytes,
                max_bytes,
            } => {
                if *max_bytes == 0 || *max_bytes > MAX_TEXT_ANSWER_BYTES || min_bytes > max_bytes {
                    return Err(invalid("response.text", "bounds_invalid"));
                }
            }
            Self::Select {
                options,
                min_selections,
                max_selections,
            } => {
                if options.is_empty() || options.len() > MAX_SELECT_OPTIONS {
                    return Err(invalid("response.options", "size_out_of_bounds"));
                }
                if min_selections > max_selections
                    || *max_selections > options.len()
                    || *max_selections == 0
                {
                    return Err(invalid("response.select", "bounds_invalid"));
                }
                let mut option_ids = BTreeSet::new();
                for option in options {
                    option.validate()?;
                    if !option_ids.insert(option.id.clone()) {
                        return Err(invalid("response.options", "duplicate_option_id"));
                    }
                }
            }
        }
        Ok(())
    }

    pub fn validate_answer(&self, answer: &DecisionAnswer) -> Result<(), ValidationError> {
        match (self, answer) {
            (
                Self::Text {
                    min_bytes,
                    max_bytes,
                },
                DecisionAnswer::Text { value },
            ) => {
                validate_control_free("answer.value", value, true)?;
                let size = value.len();
                if size < *min_bytes || size > *max_bytes {
                    return Err(invalid("answer.value", "size_out_of_bounds"));
                }
            }
            (
                Self::Select {
                    options,
                    min_selections,
                    max_selections,
                },
                DecisionAnswer::Select { option_ids },
            ) => {
                if option_ids.len() < *min_selections || option_ids.len() > *max_selections {
                    return Err(invalid("answer.optionIds", "selection_count_out_of_bounds"));
                }
                let allowed: BTreeSet<_> = options.iter().map(|option| &option.id).collect();
                let mut selected = BTreeSet::new();
                for option_id in option_ids {
                    option_id.validate()?;
                    if !allowed.contains(option_id) {
                        return Err(invalid("answer.optionIds", "unknown_option"));
                    }
                    if !selected.insert(option_id) {
                        return Err(invalid("answer.optionIds", "duplicate_option"));
                    }
                }
            }
            _ => return Err(invalid("answer", "response_kind_mismatch")),
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum DecisionAnswer {
    Text { value: String },
    Select { option_ids: Vec<OptionId> },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchState {
    Active,
    Blocked,
    Completed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchRecord {
    pub target: InteractionTarget,
    pub revision: Revision,
    pub state: DispatchState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<InteractionId>,
    pub interaction_capability: CapabilityRef,
    pub completion_capability: CapabilityRef,
    pub worker_endpoint: WorkerEndpoint,
}

impl DispatchRecord {
    pub fn validate(&self) -> Result<(), ValidationError> {
        self.target.validate()?;
        self.revision.validate()?;
        self.interaction_capability.validate()?;
        self.completion_capability.validate()?;
        self.worker_endpoint.validate()?;
        if self.worker_endpoint.generation != self.target.generation {
            return Err(invalid("dispatch.workerEndpoint", "generation_mismatch"));
        }
        match (self.state, &self.blocked_by) {
            (DispatchState::Blocked, Some(interaction_id)) => interaction_id.validate(),
            (DispatchState::Active | DispatchState::Completed, None) => Ok(()),
            _ => Err(invalid("dispatch.blockedBy", "state_mismatch")),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnswerRecord {
    pub answered_by: ParticipantRef,
    pub answer: DecisionAnswer,
    pub answered_at_ms: i64,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum DecisionState {
    Open,
    Answered { receipt: AnswerRecord },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionCommon {
    pub id: InteractionId,
    pub target: InteractionTarget,
    pub author: ParticipantRef,
    pub audience: Audience,
    pub title: String,
    pub description_markdown: String,
    pub revision: Revision,
    pub created_at_ms: i64,
}

impl InteractionCommon {
    pub fn validate(&self) -> Result<(), ValidationError> {
        self.id.validate()?;
        self.target.validate()?;
        self.author.validate()?;
        self.audience.validate(&self.author)?;
        self.revision.validate()?;
        validate_plain_text("title", &self.title, MAX_TITLE_BYTES, false)?;
        validate_markdown("descriptionMarkdown", &self.description_markdown)?;
        validate_timestamp("createdAtMs", self.created_at_ms)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum InteractionRecord {
    Message {
        common: InteractionCommon,
        purpose: MessagePurpose,
    },
    Decision {
        common: InteractionCommon,
        response: ResponseSpec,
        reply_capability: CapabilityRef,
        state: DecisionState,
    },
}

impl InteractionRecord {
    pub fn common(&self) -> &InteractionCommon {
        match self {
            Self::Message { common, .. } | Self::Decision { common, .. } => common,
        }
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        self.common().validate()?;
        if let Self::Decision {
            common,
            response,
            reply_capability,
            state,
        } = self
        {
            response.validate()?;
            reply_capability.validate()?;
            if !common
                .audience
                .grants
                .iter()
                .any(|grant| grant.grants(reply_capability))
            {
                return Err(invalid("audience", "reply_capability_missing"));
            }
            if let DecisionState::Answered { receipt } = state {
                receipt.answered_by.validate()?;
                validate_idempotency_key(&receipt.idempotency_key)?;
                validate_timestamp("answeredAtMs", receipt.answered_at_ms)?;
                response.validate_answer(&receipt.answer)?;
            }
        }
        Ok(())
    }
}

pub fn validate_idempotency_key(value: &str) -> Result<(), ValidationError> {
    if value.is_empty()
        || value.len() > MAX_IDEMPOTENCY_KEY_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
    {
        return Err(invalid("idempotencyKey", "invalid"));
    }
    Ok(())
}

pub fn validate_timestamp(field: &'static str, value: i64) -> Result<(), ValidationError> {
    if value < 0 {
        return Err(invalid(field, "must_be_nonnegative"));
    }
    Ok(())
}

pub fn validate_markdown(field: &'static str, value: &str) -> Result<(), ValidationError> {
    if value.len() > MAX_MARKDOWN_BYTES {
        return Err(invalid(field, "too_large"));
    }
    validate_control_free(field, value, true)
}

fn validate_reference(field: &'static str, value: &str) -> Result<(), ValidationError> {
    if value.is_empty() || value.len() > MAX_REFERENCE_BYTES {
        return Err(invalid(field, "size_out_of_bounds"));
    }
    validate_control_free(field, value, false)?;
    if matches!(
        field,
        "installRootRef" | "workerEndpointRef" | "sessionIdentityRef"
    ) && (value.starts_with('/')
        || value.starts_with('~')
        || value.contains('\\')
        || value.contains("./")
        || value.contains("../"))
    {
        return Err(invalid(field, "must_be_opaque"));
    }
    Ok(())
}

fn validate_plain_text(
    field: &'static str,
    value: &str,
    max_bytes: usize,
    allow_empty: bool,
) -> Result<(), ValidationError> {
    if (!allow_empty && value.is_empty()) || value.len() > max_bytes {
        return Err(invalid(field, "size_out_of_bounds"));
    }
    validate_control_free(field, value, false)
}

fn validate_control_free(
    field: &'static str,
    value: &str,
    allow_layout: bool,
) -> Result<(), ValidationError> {
    if value.chars().any(|character| {
        character.is_control() && !(allow_layout && matches!(character, '\n' | '\r' | '\t'))
    }) {
        return Err(invalid(field, "control_character"));
    }
    Ok(())
}

fn validate_unique_bounded<T: Ord>(
    field: &'static str,
    values: &[T],
    maximum: usize,
    validate: impl Fn(&T) -> Result<(), ValidationError>,
) -> Result<(), ValidationError> {
    if values.len() > maximum {
        return Err(invalid(field, "too_many"));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        validate(value)?;
        if !unique.insert(value) {
            return Err(invalid(field, "duplicate"));
        }
    }
    Ok(())
}

fn invalid(field: &'static str, code: &'static str) -> ValidationError {
    ValidationError { field, code }
}
