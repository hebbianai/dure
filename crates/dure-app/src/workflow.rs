use std::{fmt, future::Future, path::Path, pin::Pin};

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use crate::domain_store::{validate_domain_id, validate_label, validate_token};
use crate::{
    AgentCheckpointBindingAuthorityV1, AgentIdV1, ContributionIdV2, DomainIdErrorV1,
    DomainStoreErrorV1, DomainStoreFuture, ProviderIdV1, ProviderPermissionModeV1, RuntimeKindIdV1,
    agent_provider_launch_prompt_is_valid,
};

pub const DELEGATE_ONCE_SCHEMA_VERSION_V1: u16 = 1;
const MAX_TASK_INSTRUCTIONS_BYTES_V1: usize = 16 * 1024;
const MAX_WORKFLOW_PATH_BYTES_V1: usize = 4 * 1024;
const MAX_WORKFLOW_PROVIDER_ARGUMENTS_V1: usize = 64;
const MAX_WORKFLOW_PROVIDER_ARGUMENT_BYTES_V1: usize = 4 * 1024;
const MAX_WORKFLOW_PROVIDER_ARGUMENTS_BYTES_V1: usize = 16 * 1024;
const MAX_WORKFLOW_PRELAUNCH_COMMAND_BYTES_V1: usize = 4 * 1024;
const MAX_WORKFLOW_HANDOFF_BYTES_V1: usize = 32 * 1024;
const MAX_WORKFLOW_RESULT_BYTES_V1: usize = 16 * 1024;

macro_rules! workflow_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
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

workflow_id!(RunIdV1);
workflow_id!(TaskIdV1);
workflow_id!(DispatchIdV1);

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct WorkflowSessionPrelaunchCommandV1(String);

impl WorkflowSessionPrelaunchCommandV1 {
    pub fn new(value: impl Into<String>) -> Result<Self, DomainStoreErrorV1> {
        let value = value.into();
        if value.trim().is_empty()
            || value.len() > MAX_WORKFLOW_PRELAUNCH_COMMAND_BYTES_V1
            || value
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
        {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "prelaunchCommand",
                reason: "must be a bounded non-empty shell command without control bytes".into(),
            });
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for WorkflowSessionPrelaunchCommandV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCoordinatorBindingV1 {
    pub agent_id: AgentIdV1,
    pub session_id: String,
    pub binding_generation: i64,
}

impl WorkflowCoordinatorBindingV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_token("coordinator.sessionId", &self.session_id)?;
        if self.binding_generation < 1 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "coordinator.bindingGeneration",
                reason: "must be positive".into(),
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegateOnceTaskSpecV1 {
    pub summary: String,
    pub instructions: String,
}

impl DelegateOnceTaskSpecV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_label("task.summary", &self.summary)?;
        if self.instructions.is_empty()
            || self.instructions.len() > MAX_TASK_INSTRUCTIONS_BYTES_V1
            || self
                .instructions
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
        {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "task.instructions",
                reason: format!(
                    "must be non-empty, at most {MAX_TASK_INSTRUCTIONS_BYTES_V1} UTF-8 bytes, and contain only newline or tab control characters"
                ),
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegateOnceRequestV1 {
    pub schema_version: u16,
    pub contribution_id: ContributionIdV2,
    pub coordinator: WorkflowCoordinatorBindingV1,
    pub task: DelegateOnceTaskSpecV1,
    pub provider_id: ProviderIdV1,
    pub runtime_kind_id: RuntimeKindIdV1,
    pub target_reference: String,
    pub idempotency_key: String,
    pub created_at_ms: i64,
}

impl DelegateOnceRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema_version(self.schema_version)?;
        self.coordinator.validate()?;
        self.task.validate()?;
        validate_token("targetReference", &self.target_reference)?;
        validate_token("idempotencyKey", &self.idempotency_key)?;
        validate_timestamp("createdAtMs", self.created_at_ms)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowDispatchStateV1 {
    Starting,
    Active,
    StartFailed,
    Completed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSessionGenerationV1 {
    pub session_id: String,
    pub workspace_id: String,
    pub provider_id: ProviderIdV1,
    pub runner_principal: String,
    pub runner_instance: String,
    pub channel_epoch: String,
    pub host_instance_id: String,
    pub terminal_epoch: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowPromptDeliveryStateV1 {
    Pending,
    Uncertain,
    WrittenToPty,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowPromptActivityStateV1 {
    Observed,
    Stalled,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowPromptActivityReceiptV1 {
    pub state: WorkflowPromptActivityStateV1,
    pub observed_output_seq: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

impl WorkflowPromptActivityReceiptV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_canonical_decimal(
            "promptDelivery.activity.observedOutputSeq",
            &self.observed_output_seq,
        )?;
        if let Some(error_code) = &self.error_code {
            validate_token("promptDelivery.activity.errorCode", error_code)?;
        }
        if matches!(self.state, WorkflowPromptActivityStateV1::Observed)
            != self.error_code.is_none()
        {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "promptDelivery.activity.state",
                reason: "observed must have no error and non-observed outcomes require one".into(),
            });
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowPromptDeliveryOperationV1 {
    #[serde(rename = "initial_agent_prompt", alias = "agent_prompt")]
    AgentPrompt,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAgentPromptDeliveryEvidenceV1 {
    pub operation: WorkflowPromptDeliveryOperationV1,
    pub terminal_epoch: String,
    pub record_id: String,
    pub input_baseline_output_sequence: String,
    #[serde(
        default,
        rename = "initialAgentRuntimeRevision",
        alias = "admittedAgentRuntimeRevision",
        skip_serializing_if = "Option::is_none"
    )]
    pub admitted_agent_runtime_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<WorkflowPromptActivityReceiptV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowControllerPromptDeliveryEvidenceV1 {
    pub provider_ready_revision: String,
    pub provider_ready_output_seq: String,
    pub body_request_id: String,
    pub submit_request_id: String,
    pub controller_generation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<WorkflowPromptActivityReceiptV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum WorkflowPromptDeliveryEvidenceV1 {
    AgentPrompt(WorkflowAgentPromptDeliveryEvidenceV1),
    LegacyController(WorkflowControllerPromptDeliveryEvidenceV1),
}

impl WorkflowPromptDeliveryEvidenceV1 {
    #[must_use]
    pub fn agent_prompt(
        terminal_epoch: impl Into<String>,
        record_id: impl Into<String>,
        input_baseline_output_sequence: impl Into<String>,
        admitted_agent_runtime_revision: Option<String>,
    ) -> Self {
        Self::AgentPrompt(WorkflowAgentPromptDeliveryEvidenceV1 {
            operation: WorkflowPromptDeliveryOperationV1::AgentPrompt,
            terminal_epoch: terminal_epoch.into(),
            record_id: record_id.into(),
            input_baseline_output_sequence: input_baseline_output_sequence.into(),
            admitted_agent_runtime_revision,
            activity: None,
        })
    }

    #[must_use]
    pub fn legacy_controller(
        provider_ready_revision: impl Into<String>,
        provider_ready_output_seq: impl Into<String>,
        body_request_id: impl Into<String>,
        submit_request_id: impl Into<String>,
        controller_generation: impl Into<String>,
    ) -> Self {
        Self::LegacyController(WorkflowControllerPromptDeliveryEvidenceV1 {
            provider_ready_revision: provider_ready_revision.into(),
            provider_ready_output_seq: provider_ready_output_seq.into(),
            body_request_id: body_request_id.into(),
            submit_request_id: submit_request_id.into(),
            controller_generation: controller_generation.into(),
            activity: None,
        })
    }

    #[must_use]
    pub fn activity(&self) -> Option<&WorkflowPromptActivityReceiptV1> {
        match self {
            Self::AgentPrompt(evidence) => evidence.activity.as_ref(),
            Self::LegacyController(evidence) => evidence.activity.as_ref(),
        }
    }

    pub fn set_activity(&mut self, activity: WorkflowPromptActivityReceiptV1) {
        match self {
            Self::AgentPrompt(evidence) => evidence.activity = Some(activity),
            Self::LegacyController(evidence) => evidence.activity = Some(activity),
        }
    }

    pub fn clear_activity(&mut self) {
        match self {
            Self::AgentPrompt(evidence) => evidence.activity = None,
            Self::LegacyController(evidence) => evidence.activity = None,
        }
    }

    #[must_use]
    pub fn input_baseline_output_sequence(&self) -> &str {
        match self {
            Self::AgentPrompt(evidence) => &evidence.input_baseline_output_sequence,
            Self::LegacyController(evidence) => &evidence.provider_ready_output_seq,
        }
    }

    #[must_use]
    pub fn delivery_identity_parts(&self) -> Vec<&str> {
        match self {
            Self::AgentPrompt(evidence) => vec![&evidence.terminal_epoch, &evidence.record_id],
            Self::LegacyController(evidence) => vec![
                &evidence.body_request_id,
                &evidence.submit_request_id,
                &evidence.controller_generation,
            ],
        }
    }

    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        match self {
            Self::AgentPrompt(evidence) => {
                validate_token("promptDelivery.terminalEpoch", &evidence.terminal_epoch)?;
                validate_canonical_decimal("promptDelivery.recordId", &evidence.record_id)?;
                validate_canonical_decimal(
                    "promptDelivery.inputBaselineOutputSequence",
                    &evidence.input_baseline_output_sequence,
                )?;
                if let Some(revision) = &evidence.admitted_agent_runtime_revision {
                    validate_canonical_decimal(
                        "promptDelivery.admittedAgentRuntimeRevision",
                        revision,
                    )?;
                }
            }
            Self::LegacyController(evidence) => {
                for (field, value) in [
                    ("promptDelivery.bodyRequestId", &evidence.body_request_id),
                    (
                        "promptDelivery.submitRequestId",
                        &evidence.submit_request_id,
                    ),
                    (
                        "promptDelivery.controllerGeneration",
                        &evidence.controller_generation,
                    ),
                ] {
                    validate_token(field, value)?;
                }
                validate_canonical_decimal(
                    "promptDelivery.providerReadyRevision",
                    &evidence.provider_ready_revision,
                )?;
                validate_canonical_decimal(
                    "promptDelivery.providerReadyOutputSeq",
                    &evidence.provider_ready_output_seq,
                )?;
            }
        }
        if let Some(activity) = self.activity() {
            activity.validate()?;
            let observed = decimal_value(&activity.observed_output_seq)?;
            let baseline = decimal_value(self.input_baseline_output_sequence())?;
            if observed < baseline
                || (activity.state == WorkflowPromptActivityStateV1::Observed
                    && observed == baseline)
            {
                return Err(DomainStoreErrorV1::InvalidRecord {
                    field: "promptDelivery.activity.observedOutputSeq",
                    reason: "observed activity must advance beyond the input baseline output sequence; other outcomes must not precede it".into(),
                });
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowPromptDeliveryReceiptV1 {
    pub idempotency_key: String,
    pub state: WorkflowPromptDeliveryStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<WorkflowPromptDeliveryEvidenceV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

impl WorkflowPromptDeliveryReceiptV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_token("promptDelivery.idempotencyKey", &self.idempotency_key)?;
        if let Some(evidence) = &self.evidence {
            evidence.validate()?;
        }
        if let Some(error_code) = &self.error_code {
            validate_token("promptDelivery.errorCode", error_code)?;
        }
        let shape_is_valid = match self.state {
            WorkflowPromptDeliveryStateV1::Pending | WorkflowPromptDeliveryStateV1::Uncertain => {
                self.evidence.is_none() && self.error_code.is_none()
            }
            WorkflowPromptDeliveryStateV1::WrittenToPty => {
                self.evidence.is_some() && self.error_code.is_none()
            }
            WorkflowPromptDeliveryStateV1::Failed => {
                self.evidence.is_none() && self.error_code.is_some()
            }
        };
        if !shape_is_valid {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "promptDelivery.state",
                reason: "must agree with exactly one terminal evidence or failure".into(),
            });
        }
        Ok(())
    }
}

impl WorkflowSessionGenerationV1 {
    pub fn from_checkpoint_authority(
        authority: &AgentCheckpointBindingAuthorityV1,
        provider_id: &ProviderIdV1,
    ) -> Self {
        Self {
            session_id: authority.binding.session_id.clone(),
            workspace_id: authority.runtime_workspace_id.clone(),
            provider_id: provider_id.clone(),
            runner_principal: authority.runner_principal.clone(),
            runner_instance: authority.runner_instance.clone(),
            channel_epoch: authority.channel_epoch.clone(),
            host_instance_id: authority.host_instance_id.clone(),
            terminal_epoch: authority.terminal_epoch.clone(),
        }
    }

    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        for (field, value) in [
            ("session.sessionId", &self.session_id),
            ("session.workspaceId", &self.workspace_id),
            ("session.runnerPrincipal", &self.runner_principal),
            ("session.runnerInstance", &self.runner_instance),
            ("session.channelEpoch", &self.channel_epoch),
            ("session.hostInstanceId", &self.host_instance_id),
            ("session.terminalEpoch", &self.terminal_epoch),
        ] {
            validate_token(field, value)?;
        }
        Ok(())
    }

    /// Validates an effective managed-create generation against the immutable
    /// launch scope. Its session ID may differ from the requested preference
    /// when the runtime advances to an authoritative successor.
    pub fn validate_for_launch_scope(
        &self,
        workspace_id: &str,
        provider_id: &ProviderIdV1,
    ) -> Result<(), DomainStoreErrorV1> {
        self.validate()?;
        if self.workspace_id != workspace_id {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "session.workspaceId",
                reason: "must match the launch workspace".into(),
            });
        }
        if &self.provider_id != provider_id {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "session.providerId",
                reason: "must match the launch provider".into(),
            });
        }
        Ok(())
    }
}

/// The effective identity returned by one managed launch. The create key and
/// Session generation form one inseparable receipt: an authoritative advance
/// may replace both values from the prepared request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowSessionLaunchReceiptV1 {
    pub launch_idempotency_key: String,
    pub session: WorkflowSessionGenerationV1,
}

impl WorkflowSessionLaunchReceiptV1 {
    pub fn validate_for_request(
        &self,
        request: &WorkflowSessionLaunchRequestV1,
    ) -> Result<(), DomainStoreErrorV1> {
        request.validate()?;
        self.session
            .validate_for_launch_scope(&request.workspace_id, &request.provider_id)?;
        validate_workflow_effective_launch_identity(
            &request.session_id,
            &request.launch_idempotency_key,
            &self.session,
            &self.launch_idempotency_key,
        )
    }
}

pub fn validate_workflow_effective_launch_identity(
    prepared_session_id: &str,
    prepared_launch_idempotency_key: &str,
    effective_session: &WorkflowSessionGenerationV1,
    effective_launch_idempotency_key: &str,
) -> Result<(), DomainStoreErrorV1> {
    validate_token("preparedSessionId", prepared_session_id)?;
    validate_token("launchIdempotencyKey", prepared_launch_idempotency_key)?;
    effective_session.validate()?;
    validate_token(
        "effectiveLaunchIdempotencyKey",
        effective_launch_idempotency_key,
    )?;
    if (effective_session.session_id == prepared_session_id)
        != (effective_launch_idempotency_key == prepared_launch_idempotency_key)
    {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "effectiveLaunchIdempotencyKey",
            reason: "must remain the prepared key exactly for the prepared Session and change exactly for an advanced successor Session".into(),
        });
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegateOnceReceiptV1 {
    pub schema_version: u16,
    pub idempotency_key: String,
    pub run_id: RunIdV1,
    pub task_id: TaskIdV1,
    pub dispatch_id: DispatchIdV1,
    pub generation: i64,
    pub status: WorkflowDispatchStateV1,
    pub launch_idempotency_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_launch_idempotency_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<WorkflowSessionGenerationV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_delivery: Option<WorkflowPromptDeliveryReceiptV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl DelegateOnceReceiptV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema_version(self.schema_version)?;
        validate_token("idempotencyKey", &self.idempotency_key)?;
        if self.generation < 1 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "generation",
                reason: "must be positive".into(),
            });
        }
        validate_token("launchIdempotencyKey", &self.launch_idempotency_key)?;
        if let Some(key) = &self.effective_launch_idempotency_key {
            if let Some(session) = &self.session {
                let prepared_session_id = workflow_prepared_session_id(&self.dispatch_id)?;
                validate_workflow_effective_launch_identity(
                    &prepared_session_id,
                    &self.launch_idempotency_key,
                    session,
                    key,
                )?;
            } else {
                validate_token("effectiveLaunchIdempotencyKey", key)?;
            }
        }
        if let Some(session) = &self.session {
            session.validate()?;
        }
        if let Some(error_code) = &self.start_error_code {
            validate_token("startErrorCode", error_code)?;
        }
        let launch_shape_is_valid = match self.status {
            WorkflowDispatchStateV1::Starting => {
                self.session.is_none()
                    && self.effective_launch_idempotency_key.is_none()
                    && self.start_error_code.is_none()
                    && self.prompt_delivery.is_none()
            }
            WorkflowDispatchStateV1::Active | WorkflowDispatchStateV1::Completed => {
                self.session.is_some()
                    && self.start_error_code.is_none()
                    && self.prompt_delivery.is_some()
            }
            WorkflowDispatchStateV1::StartFailed => {
                self.session.is_none()
                    && self.effective_launch_idempotency_key.is_none()
                    && self.start_error_code.is_some()
                    && self.prompt_delivery.is_none()
            }
        };
        if !launch_shape_is_valid {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "status",
                reason: "must agree with exactly one Session generation or start failure".into(),
            });
        }
        if let Some(prompt_delivery) = &self.prompt_delivery {
            prompt_delivery.validate()?;
        }
        if let Some(result) = &self.result {
            validate_workflow_result(result)?;
            if self.status != WorkflowDispatchStateV1::Completed {
                return Err(DomainStoreErrorV1::InvalidRecord {
                    field: "result",
                    reason: "is valid only for a completed Dispatch".into(),
                });
            }
        }
        validate_timestamp("createdAtMs", self.created_at_ms)?;
        validate_timestamp("updatedAtMs", self.updated_at_ms)?;
        if self.updated_at_ms < self.created_at_ms {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "updatedAtMs",
                reason: "must not precede createdAtMs".into(),
            });
        }
        Ok(())
    }

    /// Returns the effective create key. Legacy receipts omitted the additive
    /// field; their prepared key is safe only when the stored Session is still
    /// the deterministic prepared Session rather than an advanced successor.
    pub fn effective_launch_key(&self) -> Result<&str, DomainStoreErrorV1> {
        if let Some(key) = self.effective_launch_idempotency_key.as_deref() {
            return Ok(key);
        }
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| DomainStoreErrorV1::InvalidRecord {
                field: "effectiveLaunchIdempotencyKey",
                reason: "requires an active Session".into(),
            })?;
        let prepared_session_id = workflow_prepared_session_id(&self.dispatch_id)?;
        if session.session_id == prepared_session_id {
            Ok(&self.launch_idempotency_key)
        } else {
            Err(DomainStoreErrorV1::InvalidRecord {
                field: "effectiveLaunchIdempotencyKey",
                reason: "is required for an advanced successor Session".into(),
            })
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowEffectiveLaunchRepairRequestV1 {
    pub schema_version: u16,
    pub task_id: TaskIdV1,
    pub dispatch_id: DispatchIdV1,
    pub generation: i64,
    pub session: WorkflowSessionGenerationV1,
    pub effective_launch_idempotency_key: String,
    pub repaired_at_ms: i64,
}

impl WorkflowEffectiveLaunchRepairRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema_version(self.schema_version)?;
        validate_dispatch_generation(self.generation)?;
        self.session.validate()?;
        validate_token(
            "effectiveLaunchIdempotencyKey",
            &self.effective_launch_idempotency_key,
        )?;
        validate_timestamp("repairedAtMs", self.repaired_at_ms)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegateOnceSessionBindingRequestV1 {
    pub schema_version: u16,
    pub task_id: TaskIdV1,
    pub dispatch_id: DispatchIdV1,
    pub generation: i64,
    pub launch_idempotency_key: String,
    pub effective_launch_idempotency_key: String,
    pub session: WorkflowSessionGenerationV1,
    pub bound_at_ms: i64,
}

impl DelegateOnceSessionBindingRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema_version(self.schema_version)?;
        validate_dispatch_generation(self.generation)?;
        let prepared_session_id = workflow_prepared_session_id(&self.dispatch_id)?;
        validate_workflow_effective_launch_identity(
            &prepared_session_id,
            &self.launch_idempotency_key,
            &self.session,
            &self.effective_launch_idempotency_key,
        )?;
        validate_timestamp("boundAtMs", self.bound_at_ms)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegateOnceStartFailureRequestV1 {
    pub schema_version: u16,
    pub task_id: TaskIdV1,
    pub dispatch_id: DispatchIdV1,
    pub generation: i64,
    pub launch_idempotency_key: String,
    pub error_code: String,
    pub failed_at_ms: i64,
}

impl DelegateOnceStartFailureRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema_version(self.schema_version)?;
        validate_dispatch_generation(self.generation)?;
        validate_token("launchIdempotencyKey", &self.launch_idempotency_key)?;
        validate_token("errorCode", &self.error_code)?;
        validate_timestamp("failedAtMs", self.failed_at_ms)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSessionResumePlanV1 {
    pub arguments: Vec<String>,
    /// Opaque credential-owner reference, never credential material or a new selection.
    pub launch_reference: Option<String>,
}

impl WorkflowSessionResumePlanV1 {
    pub fn from_arguments(
        arguments: Option<Vec<String>>,
        profile: &crate::AgentExecutionProfileV1,
    ) -> Option<Self> {
        arguments.map(|arguments| Self {
            arguments,
            launch_reference: match profile {
                crate::AgentExecutionProfileV1::ProviderDefault => None,
                crate::AgentExecutionProfileV1::CredentialReference { reference_id, .. } => {
                    Some(reference_id.clone())
                }
            },
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSessionLaunchRequestV1 {
    pub runtime_kind_id: RuntimeKindIdV1,
    pub launch_idempotency_key: String,
    pub session_id: String,
    pub workspace_id: String,
    pub provider_id: ProviderIdV1,
    pub provider_conversation_ref: Option<String>,
    pub permission_mode: ProviderPermissionModeV1,
    pub provider_executable: String,
    pub provider_arguments: Vec<String>,
    pub provider_resume: Option<WorkflowSessionResumePlanV1>,
    pub initial_prompt: Option<String>,
    pub working_directory: String,
    pub prelaunch_command: Option<WorkflowSessionPrelaunchCommandV1>,
}

impl WorkflowSessionLaunchRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_token("launchIdempotencyKey", &self.launch_idempotency_key)?;
        validate_token("sessionId", &self.session_id)?;
        validate_token("workspaceId", &self.workspace_id)?;
        if let Some(provider_conversation_ref) = &self.provider_conversation_ref {
            validate_token("providerConversationRef", provider_conversation_ref)?;
        }
        if self.provider_executable.is_empty()
            || self.provider_executable.len() > MAX_WORKFLOW_PATH_BYTES_V1
            || self.provider_executable.contains('\0')
            || !Path::new(&self.provider_executable).is_absolute()
        {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "providerExecutable",
                reason: "must be a bounded absolute executable path".into(),
            });
        }
        if self.provider_arguments.len() > MAX_WORKFLOW_PROVIDER_ARGUMENTS_V1
            || self.provider_arguments.iter().any(|argument| {
                argument.len() > MAX_WORKFLOW_PROVIDER_ARGUMENT_BYTES_V1 || argument.contains('\0')
            })
            || self
                .provider_arguments
                .iter()
                .map(String::len)
                .sum::<usize>()
                > MAX_WORKFLOW_PROVIDER_ARGUMENTS_BYTES_V1
        {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "providerArguments",
                reason: "must be bounded arguments without null bytes".into(),
            });
        }
        if let Some(prompt) = &self.initial_prompt {
            if !agent_provider_launch_prompt_is_valid(prompt) {
                return Err(DomainStoreErrorV1::InvalidRecord {
                    field: "initialPrompt",
                    reason:
                        "must be non-empty, at most 16384 UTF-8 bytes, and contain no null bytes"
                            .into(),
                });
            }
        }
        if self.working_directory.is_empty()
            || self.working_directory.len() > MAX_WORKFLOW_PATH_BYTES_V1
            || self.working_directory.contains('\0')
            || !Path::new(&self.working_directory).is_absolute()
        {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "workingDirectory",
                reason: "must be a bounded absolute directory path".into(),
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowSessionLaunchFailureV1 {
    pub code: String,
    pub disposition: WorkflowSessionLaunchFailureDispositionV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkflowSessionLaunchFailureDispositionV1 {
    Retryable,
    Rejected,
}

impl WorkflowSessionLaunchFailureV1 {
    pub fn new(code: impl Into<String>) -> Result<Self, DomainStoreErrorV1> {
        Self::with_disposition(code, WorkflowSessionLaunchFailureDispositionV1::Retryable)
    }

    pub fn rejected(code: impl Into<String>) -> Result<Self, DomainStoreErrorV1> {
        Self::with_disposition(code, WorkflowSessionLaunchFailureDispositionV1::Rejected)
    }

    fn with_disposition(
        code: impl Into<String>,
        disposition: WorkflowSessionLaunchFailureDispositionV1,
    ) -> Result<Self, DomainStoreErrorV1> {
        let code = code.into();
        validate_token("launchFailure.code", &code)?;
        Ok(Self { code, disposition })
    }
}

pub type WorkflowSessionLaunchFutureV1 = Pin<
    Box<
        dyn Future<Output = Result<WorkflowSessionLaunchReceiptV1, WorkflowSessionLaunchFailureV1>>
            + Send
            + 'static,
    >,
>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegateOncePromptClaimRequestV1 {
    pub schema_version: u16,
    pub task_id: TaskIdV1,
    pub dispatch_id: DispatchIdV1,
    pub generation: i64,
    pub delivery_idempotency_key: String,
    pub session: WorkflowSessionGenerationV1,
    pub claimed_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowPromptDeliveryClaimV1 {
    pub claimed: bool,
    pub receipt: DelegateOnceReceiptV1,
}

impl DelegateOncePromptClaimRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema_version(self.schema_version)?;
        validate_dispatch_generation(self.generation)?;
        validate_token(
            "promptDelivery.idempotencyKey",
            &self.delivery_idempotency_key,
        )?;
        self.session.validate()?;
        validate_timestamp("claimedAtMs", self.claimed_at_ms)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "state", content = "value")]
pub enum WorkflowPromptDeliveryOutcomeV1 {
    WrittenToPty(WorkflowPromptDeliveryEvidenceV1),
    Failed { error_code: String },
}

impl WorkflowPromptDeliveryOutcomeV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        match self {
            Self::WrittenToPty(evidence) => {
                evidence.validate()?;
                if evidence.activity().is_some() {
                    return Err(DomainStoreErrorV1::InvalidRecord {
                        field: "promptDelivery.activity",
                        reason: "must be recorded through the activity observation boundary".into(),
                    });
                }
                Ok(())
            }
            Self::Failed { error_code } => validate_token("promptDelivery.errorCode", error_code),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegateOncePromptOutcomeRequestV1 {
    pub schema_version: u16,
    pub task_id: TaskIdV1,
    pub dispatch_id: DispatchIdV1,
    pub generation: i64,
    pub delivery_idempotency_key: String,
    pub session: WorkflowSessionGenerationV1,
    pub outcome: WorkflowPromptDeliveryOutcomeV1,
    pub recorded_at_ms: i64,
}

impl DelegateOncePromptOutcomeRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema_version(self.schema_version)?;
        validate_dispatch_generation(self.generation)?;
        validate_token(
            "promptDelivery.idempotencyKey",
            &self.delivery_idempotency_key,
        )?;
        self.session.validate()?;
        self.outcome.validate()?;
        validate_timestamp("recordedAtMs", self.recorded_at_ms)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkflowPromptDeliveryIntentV1 {
    FreshAgent,
    ExistingConversation { provider_conversation_id: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowPromptDeliveryRequestV1 {
    pub runtime_kind_id: RuntimeKindIdV1,
    pub delivery_idempotency_key: String,
    pub session: WorkflowSessionGenerationV1,
    pub intent: WorkflowPromptDeliveryIntentV1,
    pub handoff: String,
}

impl WorkflowPromptDeliveryRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_token(
            "promptDelivery.idempotencyKey",
            &self.delivery_idempotency_key,
        )?;
        self.session.validate()?;
        if let WorkflowPromptDeliveryIntentV1::ExistingConversation {
            provider_conversation_id,
        } = &self.intent
        {
            validate_token(
                "promptDelivery.providerConversationId",
                provider_conversation_id,
            )?;
        }
        if self.handoff.is_empty()
            || self.handoff.len() > MAX_WORKFLOW_HANDOFF_BYTES_V1
            || self
                .handoff
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
        {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "handoff",
                reason: format!(
                    "must be non-empty, at most {MAX_WORKFLOW_HANDOFF_BYTES_V1} UTF-8 bytes, and terminal-safe"
                ),
            });
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowPromptDeliveryFailureV1 {
    pub code: String,
    pub may_have_written: bool,
}

impl WorkflowPromptDeliveryFailureV1 {
    pub fn new(
        code: impl Into<String>,
        may_have_written: bool,
    ) -> Result<Self, DomainStoreErrorV1> {
        let code = code.into();
        validate_token("promptDeliveryFailure.code", &code)?;
        Ok(Self {
            code,
            may_have_written,
        })
    }
}

pub type WorkflowPromptDeliveryFutureV1 = Pin<
    Box<
        dyn Future<
                Output = Result<WorkflowPromptDeliveryEvidenceV1, WorkflowPromptDeliveryFailureV1>,
            > + Send
            + 'static,
    >,
>;

pub trait WorkflowPromptDeliverer: Send + Sync {
    fn deliver(&self, request: WorkflowPromptDeliveryRequestV1) -> WorkflowPromptDeliveryFutureV1;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowPromptActivityObservationRequestV1 {
    pub runtime_kind_id: RuntimeKindIdV1,
    pub session: WorkflowSessionGenerationV1,
    pub input_baseline_output_sequence: String,
}

impl WorkflowPromptActivityObservationRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        self.session.validate()?;
        validate_canonical_decimal(
            "inputBaselineOutputSequence",
            &self.input_baseline_output_sequence,
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowPromptActivityFailureV1 {
    pub code: String,
    pub observed_output_seq: String,
}

impl WorkflowPromptActivityFailureV1 {
    pub fn new(
        code: impl Into<String>,
        observed_output_seq: impl Into<String>,
    ) -> Result<Self, DomainStoreErrorV1> {
        let code = code.into();
        let observed_output_seq = observed_output_seq.into();
        validate_token("promptActivityFailure.code", &code)?;
        validate_canonical_decimal(
            "promptActivityFailure.observedOutputSeq",
            &observed_output_seq,
        )?;
        Ok(Self {
            code,
            observed_output_seq,
        })
    }
}

pub type WorkflowPromptActivityFutureV1 = Pin<
    Box<
        dyn Future<
                Output = Result<WorkflowPromptActivityReceiptV1, WorkflowPromptActivityFailureV1>,
            > + Send
            + 'static,
    >,
>;

pub trait WorkflowPromptActivityObserver: Send + Sync {
    fn observe(
        &self,
        request: WorkflowPromptActivityObservationRequestV1,
    ) -> WorkflowPromptActivityFutureV1;
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegateOncePromptActivityRequestV1 {
    pub schema_version: u16,
    pub task_id: TaskIdV1,
    pub dispatch_id: DispatchIdV1,
    pub generation: i64,
    pub delivery_idempotency_key: String,
    pub session: WorkflowSessionGenerationV1,
    pub activity: WorkflowPromptActivityReceiptV1,
    pub observed_at_ms: i64,
}

impl DelegateOncePromptActivityRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema_version(self.schema_version)?;
        validate_dispatch_generation(self.generation)?;
        validate_token(
            "promptDelivery.idempotencyKey",
            &self.delivery_idempotency_key,
        )?;
        self.session.validate()?;
        self.activity.validate()?;
        validate_timestamp("observedAtMs", self.observed_at_ms)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegateOnceCompletionRequestV1 {
    pub schema_version: u16,
    pub task_id: TaskIdV1,
    pub dispatch_id: DispatchIdV1,
    pub generation: i64,
    pub session: WorkflowSessionGenerationV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    pub completed_at_ms: i64,
}

impl DelegateOnceCompletionRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema_version(self.schema_version)?;
        if self.generation < 1 {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "generation",
                reason: "must be positive".into(),
            });
        }
        self.session.validate()?;
        if let Some(result) = &self.result {
            validate_workflow_result(result)?;
        }
        validate_timestamp("completedAtMs", self.completed_at_ms)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DelegateOncePreparedV1 {
    pub request_digest: String,
    pub receipt: DelegateOnceReceiptV1,
}

pub fn prepare_delegate_once(
    request: &DelegateOnceRequestV1,
) -> Result<DelegateOncePreparedV1, DomainStoreErrorV1> {
    request.validate()?;
    let bytes = serde_json::to_vec(request).map_err(|error| DomainStoreErrorV1::Storage {
        code: "serialization",
        detail: format!("could not canonicalize delegate_once request: {error}"),
    })?;
    let request_digest = hex_digest(Sha256::digest(bytes));
    let receipt = DelegateOnceReceiptV1 {
        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
        idempotency_key: request.idempotency_key.clone(),
        run_id: RunIdV1::new(format!("run.{request_digest}"))
            .expect("SHA-256 workflow Run ID is valid"),
        task_id: TaskIdV1::new(format!("task.{request_digest}"))
            .expect("SHA-256 workflow Task ID is valid"),
        dispatch_id: DispatchIdV1::new(format!("dispatch.{request_digest}"))
            .expect("SHA-256 workflow Dispatch ID is valid"),
        generation: 1,
        status: WorkflowDispatchStateV1::Starting,
        launch_idempotency_key: format!("workflow:{request_digest}"),
        effective_launch_idempotency_key: None,
        session: None,
        start_error_code: None,
        prompt_delivery: None,
        result: None,
        created_at_ms: request.created_at_ms,
        updated_at_ms: request.created_at_ms,
    };
    receipt.validate()?;
    Ok(DelegateOncePreparedV1 {
        request_digest,
        receipt,
    })
}

pub fn workflow_prepared_session_id(
    dispatch_id: &DispatchIdV1,
) -> Result<String, DomainStoreErrorV1> {
    let digest = dispatch_id
        .as_str()
        .strip_prefix("dispatch.")
        .and_then(|digest| digest.get(..32))
        .ok_or_else(|| DomainStoreErrorV1::InvalidRecord {
            field: "dispatchId",
            reason: "does not contain a workflow request digest".into(),
        })?;
    Ok(format!("workflow-{digest}"))
}

pub trait WorkflowStore: Send + Sync {
    /// Retains the first prepared launch before runtime mutation. Concurrent
    /// preparations of the same delegate request return the winning input.
    fn prepare_delegate_once_launch<'a>(
        &'a self,
        request: &'a DelegateOnceRequestV1,
        launch: &'a WorkflowSessionLaunchRequestV1,
    ) -> DomainStoreFuture<'a, WorkflowSessionLaunchRequestV1>;

    fn delegate_once_launch<'a>(
        &'a self,
        idempotency_key: &'a str,
    ) -> DomainStoreFuture<'a, Option<WorkflowSessionLaunchRequestV1>>;

    fn create_delegate_once<'a>(
        &'a self,
        request: &'a DelegateOnceRequestV1,
    ) -> DomainStoreFuture<'a, DelegateOnceReceiptV1>;

    fn delegate_once_receipt<'a>(
        &'a self,
        idempotency_key: &'a str,
    ) -> DomainStoreFuture<'a, Option<DelegateOnceReceiptV1>>;

    fn delegate_once_receipt_for_dispatch<'a>(
        &'a self,
        task_id: &'a TaskIdV1,
        dispatch_id: &'a DispatchIdV1,
        generation: i64,
    ) -> DomainStoreFuture<'a, DelegateOnceReceiptV1>;

    fn bind_delegate_once_session<'a>(
        &'a self,
        request: &'a DelegateOnceSessionBindingRequestV1,
    ) -> DomainStoreFuture<'a, DelegateOnceReceiptV1>;

    fn fail_delegate_once_start<'a>(
        &'a self,
        request: &'a DelegateOnceStartFailureRequestV1,
    ) -> DomainStoreFuture<'a, DelegateOnceReceiptV1>;

    fn claim_delegate_once_prompt<'a>(
        &'a self,
        request: &'a DelegateOncePromptClaimRequestV1,
    ) -> DomainStoreFuture<'a, WorkflowPromptDeliveryClaimV1>;

    fn record_delegate_once_prompt_outcome<'a>(
        &'a self,
        request: &'a DelegateOncePromptOutcomeRequestV1,
    ) -> DomainStoreFuture<'a, DelegateOnceReceiptV1>;

    fn record_delegate_once_prompt_activity<'a>(
        &'a self,
        request: &'a DelegateOncePromptActivityRequestV1,
    ) -> DomainStoreFuture<'a, DelegateOnceReceiptV1>;
}

pub fn prepare_delegate_once_handoff(
    request: &DelegateOnceRequestV1,
    receipt: &DelegateOnceReceiptV1,
) -> Result<String, DomainStoreErrorV1> {
    let prepared = prepare_delegate_once(request)?;
    if receipt.idempotency_key != request.idempotency_key
        || receipt.run_id != prepared.receipt.run_id
        || receipt.task_id != prepared.receipt.task_id
        || receipt.dispatch_id != prepared.receipt.dispatch_id
        || receipt.generation != prepared.receipt.generation
        || receipt.session.is_none()
    {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_handoff",
            id: request.idempotency_key.clone(),
            reason: "request and active Dispatch receipt must identify the same generation".into(),
        });
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Handoff<'a> {
        schema_version: u16,
        task_id: &'a str,
        dispatch_id: &'a str,
        generation: i64,
        coordinator_agent_id: &'a str,
        coordinator_session_id: &'a str,
        summary: &'a str,
        instructions: &'a str,
        scope: &'static str,
        nested_delegation: bool,
        reporting: String,
    }

    let payload = Handoff {
        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
        task_id: receipt.task_id.as_str(),
        dispatch_id: receipt.dispatch_id.as_str(),
        generation: receipt.generation,
        coordinator_agent_id: request.coordinator.agent_id.as_str(),
        coordinator_session_id: &request.coordinator.session_id,
        summary: &request.task.summary,
        instructions: &request.task.instructions,
        scope: "current_workspace",
        nested_delegation: false,
        reporting: format!(
            "Return the bounded result in this Session, then run: dure workflow done --task {} --dispatch {} --generation {} --result \"<bounded summary>\"",
            receipt.task_id, receipt.dispatch_id, receipt.generation
        ),
    };
    let payload =
        serde_json::to_string_pretty(&payload).map_err(|error| DomainStoreErrorV1::Storage {
            code: "serialization",
            detail: format!("could not serialize delegate_once handoff: {error}"),
        })?;
    let handoff = format!("Dure delegated task v1\n{payload}");
    if handoff.len() > MAX_WORKFLOW_HANDOFF_BYTES_V1 {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "handoff",
            reason: format!("must not exceed {MAX_WORKFLOW_HANDOFF_BYTES_V1} UTF-8 bytes"),
        });
    }
    Ok(handoff)
}

fn validate_schema_version(schema_version: u16) -> Result<(), DomainStoreErrorV1> {
    if schema_version != DELEGATE_ONCE_SCHEMA_VERSION_V1 {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "schemaVersion",
            reason: format!("must equal {DELEGATE_ONCE_SCHEMA_VERSION_V1}"),
        });
    }
    Ok(())
}

fn validate_workflow_result(result: &str) -> Result<(), DomainStoreErrorV1> {
    if result.is_empty()
        || result.len() > MAX_WORKFLOW_RESULT_BYTES_V1
        || result
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "result",
            reason: format!(
                "must be non-empty, at most {MAX_WORKFLOW_RESULT_BYTES_V1} UTF-8 bytes, and contain only newline or tab control characters"
            ),
        });
    }
    Ok(())
}

fn validate_timestamp(field: &'static str, value: i64) -> Result<(), DomainStoreErrorV1> {
    if value < 0 {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field,
            reason: "must not be negative".into(),
        });
    }
    Ok(())
}

fn validate_dispatch_generation(generation: i64) -> Result<(), DomainStoreErrorV1> {
    if generation < 1 {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field: "generation",
            reason: "must be positive".into(),
        });
    }
    Ok(())
}

fn validate_canonical_decimal(field: &'static str, value: &str) -> Result<(), DomainStoreErrorV1> {
    let canonical = !value.is_empty()
        && value.len() <= 20
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
        && value.parse::<u64>().is_ok();
    if !canonical {
        return Err(DomainStoreErrorV1::InvalidRecord {
            field,
            reason: "must be a canonical unsigned decimal".into(),
        });
    }
    Ok(())
}

fn decimal_value(value: &str) -> Result<u64, DomainStoreErrorV1> {
    value
        .parse()
        .map_err(|_| DomainStoreErrorV1::InvalidRecord {
            field: "promptDelivery.outputSeq",
            reason: "must be a canonical unsigned decimal".into(),
        })
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let bytes = bytes.as_ref();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> DelegateOnceRequestV1 {
        DelegateOnceRequestV1 {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            contribution_id: ContributionIdV2::new("dure.core.delegate-once").unwrap(),
            coordinator: WorkflowCoordinatorBindingV1 {
                agent_id: AgentIdV1::new("agent-1").unwrap(),
                session_id: "session-1".into(),
                binding_generation: 2,
            },
            task: DelegateOnceTaskSpecV1 {
                summary: "Review the bounded change".into(),
                instructions: "Inspect only the requested files and report findings.".into(),
            },
            provider_id: ProviderIdV1::new("codex").unwrap(),
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            target_reference: "backend-profile:local".into(),
            idempotency_key: "delegate-once-1".into(),
            created_at_ms: 1_000,
        }
    }

    #[test]
    fn preparation_is_deterministic_and_versioned() {
        let first = prepare_delegate_once(&request()).unwrap();
        let second = prepare_delegate_once(&request()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.request_digest.len(), 64);
        assert_eq!(first.receipt.generation, 1);
        assert_eq!(first.receipt.status, WorkflowDispatchStateV1::Starting);
        assert_eq!(
            first.receipt.launch_idempotency_key,
            format!("workflow:{}", first.request_digest)
        );

        let encoded = serde_json::to_string(&request()).unwrap();
        assert_eq!(
            serde_json::from_str::<DelegateOnceRequestV1>(&encoded).unwrap(),
            request()
        );
    }

    #[test]
    fn preparation_rejects_unbounded_or_reused_input_shapes() {
        let mut invalid = request();
        invalid.task.instructions = "x".repeat(MAX_TASK_INSTRUCTIONS_BYTES_V1 + 1);
        assert!(matches!(
            prepare_delegate_once(&invalid),
            Err(DomainStoreErrorV1::InvalidRecord {
                field: "task.instructions",
                ..
            })
        ));

        let mut future = serde_json::to_value(request()).unwrap();
        future["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<DelegateOnceRequestV1>(future).is_err());

        let mut terminal_escape = request();
        terminal_escape.task.instructions = "safe\u{1b}[201~submit something else".into();
        assert!(prepare_delegate_once(&terminal_escape).is_err());
    }

    #[test]
    fn receipt_status_requires_exactly_one_launch_outcome() {
        let mut receipt = prepare_delegate_once(&request()).unwrap().receipt;
        receipt.status = WorkflowDispatchStateV1::Active;
        assert!(matches!(
            receipt.validate(),
            Err(DomainStoreErrorV1::InvalidRecord {
                field: "status",
                ..
            })
        ));

        receipt.status = WorkflowDispatchStateV1::StartFailed;
        receipt.start_error_code = Some("provider_unavailable".into());
        assert!(receipt.validate().is_ok());
        receipt.session = Some(WorkflowSessionGenerationV1 {
            session_id: "session-1".into(),
            workspace_id: "workspace-1".into(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            runner_principal: "runner-1".into(),
            runner_instance: "instance-1".into(),
            channel_epoch: "channel-1".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        });
        assert!(receipt.validate().is_err());
    }

    #[test]
    fn launch_request_requires_absolute_non_secret_paths() {
        let mut launch = WorkflowSessionLaunchRequestV1 {
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            launch_idempotency_key: "workflow:abc".into(),
            session_id: "session-1".into(),
            workspace_id: "workspace-1".into(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            provider_conversation_ref: None,
            permission_mode: ProviderPermissionModeV1::Default,
            provider_executable: "/usr/bin/codex".into(),
            provider_arguments: Vec::new(),
            provider_resume: None,
            initial_prompt: None,
            working_directory: "/tmp/workspace".into(),
            prelaunch_command: Some(
                WorkflowSessionPrelaunchCommandV1::new("pnpm install").unwrap(),
            ),
        };
        assert!(launch.validate().is_ok());
        launch.initial_prompt = Some("ship it\nnow".into());
        assert!(launch.validate().is_ok());
        launch.initial_prompt = Some("bad\0prompt".into());
        assert!(matches!(
            launch.validate(),
            Err(DomainStoreErrorV1::InvalidRecord {
                field: "initialPrompt",
                ..
            })
        ));
        launch.initial_prompt = Some("x".repeat(16385));
        assert!(matches!(
            launch.validate(),
            Err(DomainStoreErrorV1::InvalidRecord {
                field: "initialPrompt",
                ..
            })
        ));
        launch.initial_prompt = None;
        launch.provider_executable = "codex".into();
        assert!(matches!(
            launch.validate(),
            Err(DomainStoreErrorV1::InvalidRecord {
                field: "providerExecutable",
                ..
            })
        ));
    }

    #[test]
    fn launch_receipts_keep_prepared_and_effective_identity_pairs_distinct() {
        let launch = WorkflowSessionLaunchRequestV1 {
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            launch_idempotency_key: "workflow:root".into(),
            session_id: "prepared-session".into(),
            workspace_id: "workspace-1".into(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            provider_conversation_ref: None,
            permission_mode: ProviderPermissionModeV1::Default,
            provider_executable: "/usr/bin/codex".into(),
            provider_arguments: Vec::new(),
            provider_resume: None,
            initial_prompt: None,
            working_directory: "/tmp/workspace".into(),
            prelaunch_command: None,
        };
        let generation = |session_id: &str| WorkflowSessionGenerationV1 {
            session_id: session_id.into(),
            workspace_id: launch.workspace_id.clone(),
            provider_id: launch.provider_id.clone(),
            runner_principal: "runner-1".into(),
            runner_instance: "instance-1".into(),
            channel_epoch: "channel-1".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        };
        assert!(
            WorkflowSessionLaunchReceiptV1 {
                launch_idempotency_key: launch.launch_idempotency_key.clone(),
                session: generation(&launch.session_id),
            }
            .validate_for_request(&launch)
            .is_ok()
        );
        assert!(
            WorkflowSessionLaunchReceiptV1 {
                launch_idempotency_key: "workflow:successor".into(),
                session: generation("successor-session"),
            }
            .validate_for_request(&launch)
            .is_ok()
        );
        for receipt in [
            WorkflowSessionLaunchReceiptV1 {
                launch_idempotency_key: "workflow:successor".into(),
                session: generation(&launch.session_id),
            },
            WorkflowSessionLaunchReceiptV1 {
                launch_idempotency_key: launch.launch_idempotency_key.clone(),
                session: generation("successor-session"),
            },
        ] {
            assert!(receipt.validate_for_request(&launch).is_err());
        }
    }

    #[test]
    fn delegate_receipt_rejects_mixed_prepared_and_successor_identity() {
        let mut receipt = prepare_delegate_once(&request()).unwrap().receipt;
        let prepared_session_id = workflow_prepared_session_id(&receipt.dispatch_id).unwrap();
        receipt.status = WorkflowDispatchStateV1::Active;
        receipt.session = Some(WorkflowSessionGenerationV1 {
            session_id: prepared_session_id,
            workspace_id: "workspace-1".into(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            runner_principal: "runner-1".into(),
            runner_instance: "instance-1".into(),
            channel_epoch: "channel-1".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        });
        receipt.prompt_delivery = Some(WorkflowPromptDeliveryReceiptV1 {
            idempotency_key: format!("prompt:{}", receipt.launch_idempotency_key),
            state: WorkflowPromptDeliveryStateV1::Pending,
            evidence: None,
            error_code: None,
        });
        receipt.effective_launch_idempotency_key = Some(receipt.launch_idempotency_key.clone());
        assert!(receipt.validate().is_ok());

        receipt.effective_launch_idempotency_key = Some("workflow:successor".into());
        assert!(receipt.validate().is_err());
        receipt.session.as_mut().unwrap().session_id = "successor-session".into();
        assert!(receipt.validate().is_ok());
        receipt.effective_launch_idempotency_key = Some(receipt.launch_idempotency_key.clone());
        assert!(receipt.validate().is_err());
    }

    #[test]
    fn handoff_is_deterministic_bounded_and_bound_to_the_active_generation() {
        let input = request();
        let mut receipt = prepare_delegate_once(&input).unwrap().receipt;
        receipt.status = WorkflowDispatchStateV1::Active;
        receipt.session = Some(WorkflowSessionGenerationV1 {
            session_id: "worker-session".into(),
            workspace_id: "workspace-1".into(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            runner_principal: "runner-1".into(),
            runner_instance: "instance-1".into(),
            channel_epoch: "channel-1".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        });
        receipt.prompt_delivery = Some(WorkflowPromptDeliveryReceiptV1 {
            idempotency_key: format!("prompt:{}", receipt.launch_idempotency_key),
            state: WorkflowPromptDeliveryStateV1::Pending,
            evidence: None,
            error_code: None,
        });
        let handoff = prepare_delegate_once_handoff(&input, &receipt).unwrap();
        assert_eq!(
            prepare_delegate_once_handoff(&input, &receipt).unwrap(),
            handoff
        );
        assert!(handoff.contains(receipt.task_id.as_str()));
        assert!(handoff.contains(receipt.dispatch_id.as_str()));
        assert!(handoff.contains("Inspect only the requested files"));
        assert!(handoff.contains(&format!(
            "dure workflow done --task {} --dispatch {} --generation {} --result",
            receipt.task_id, receipt.dispatch_id, receipt.generation
        )));
        assert!(handoff.len() <= MAX_WORKFLOW_HANDOFF_BYTES_V1);

        let mut replacement = receipt;
        replacement.generation = 2;
        assert!(matches!(
            prepare_delegate_once_handoff(&input, &replacement),
            Err(DomainStoreErrorV1::IdentityConflict {
                entity: "workflow_handoff",
                ..
            })
        ));
    }

    #[test]
    fn prompt_activity_is_additive_and_requires_canonical_progress_evidence() {
        let legacy = serde_json::json!({
            "providerReadyRevision": "4",
            "providerReadyOutputSeq": "8",
            "bodyRequestId": "body-1",
            "submitRequestId": "submit-1",
            "controllerGeneration": "3"
        });
        let mut evidence: WorkflowPromptDeliveryEvidenceV1 =
            serde_json::from_value(legacy).unwrap();
        assert!(matches!(
            &evidence,
            WorkflowPromptDeliveryEvidenceV1::LegacyController(_)
        ));
        assert!(evidence.activity().is_none());
        evidence.validate().unwrap();

        let agent_without_revision =
            WorkflowPromptDeliveryEvidenceV1::agent_prompt("terminal-1", "12", "8", None);
        agent_without_revision.validate().unwrap();
        assert_eq!(
            serde_json::to_value(&agent_without_revision).unwrap(),
            serde_json::json!({
                "operation": "initial_agent_prompt",
                "terminalEpoch": "terminal-1",
                "recordId": "12",
                "inputBaselineOutputSequence": "8"
            })
        );

        let agent = WorkflowPromptDeliveryEvidenceV1::agent_prompt(
            "terminal-1",
            "12",
            "8",
            Some("5".into()),
        );
        let renamed_wip: WorkflowPromptDeliveryEvidenceV1 =
            serde_json::from_value(serde_json::json!({
                "operation": "agent_prompt",
                "mode": "existing_conversation",
                "terminalEpoch": "terminal-1",
                "recordId": "12",
                "inputBaselineOutputSequence": "8",
                "admittedAgentRuntimeRevision": "5"
            }))
            .unwrap();
        assert_eq!(renamed_wip, agent);
        assert_eq!(
            serde_json::to_value(&agent).unwrap(),
            serde_json::json!({
                "operation": "initial_agent_prompt",
                "terminalEpoch": "terminal-1",
                "recordId": "12",
                "inputBaselineOutputSequence": "8",
                "initialAgentRuntimeRevision": "5"
            })
        );
        assert_eq!(agent.delivery_identity_parts(), ["terminal-1", "12"]);

        evidence.set_activity(WorkflowPromptActivityReceiptV1 {
            state: WorkflowPromptActivityStateV1::Observed,
            observed_output_seq: "9".into(),
            error_code: None,
        });
        evidence.validate().unwrap();
        evidence.set_activity(WorkflowPromptActivityReceiptV1 {
            state: WorkflowPromptActivityStateV1::Observed,
            observed_output_seq: "8".into(),
            error_code: None,
        });
        assert!(matches!(
            evidence.validate(),
            Err(DomainStoreErrorV1::InvalidRecord {
                field: "promptDelivery.activity.observedOutputSeq",
                ..
            })
        ));
        evidence.set_activity(WorkflowPromptActivityReceiptV1 {
            state: WorkflowPromptActivityStateV1::Observed,
            observed_output_seq: "08".into(),
            error_code: None,
        });
        assert!(matches!(
            evidence.validate(),
            Err(DomainStoreErrorV1::InvalidRecord {
                field: "promptDelivery.activity.observedOutputSeq",
                ..
            })
        ));
    }
}
