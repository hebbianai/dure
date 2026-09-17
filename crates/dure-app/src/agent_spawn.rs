use std::collections::BTreeSet;
use std::error::Error;
use std::fmt;

mod launch_selection;
mod worktree;
pub use launch_selection::{AgentSpawnEffortSelectionV1, AgentSpawnModelSelectionV1};
use worktree::validate_worktree;
pub use worktree::{AgentSpawnBranchModeV1, AgentSpawnWorktreePolicyV1, worktree_directory_name};

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    AgentClientMessageIdV1, AgentExecutionProfileV1, AgentIdV1, AgentInteractionBindingV1,
    AgentInteractionProfileV1, AgentInteractionSessionIdV1, AgentProviderConversationPlanV1,
    AgentProviderRuntimeFenceV1, AgentRuntimeBindingAuthorityV1, AgentRuntimeSelectionV1,
    AgentTimelineEpochV1, AgentTurnIdV1, CapabilityIdV1, DomainStoreFuture,
    GitCheckoutRegistrationV1, OperationEventIdV1, OperationIdV1, ProjectIdV1, ProviderIdV1,
    ProviderLaunchDefaultsResolutionV1, ProviderLaunchDefaultsV1,
    ProviderLaunchPermissionOverrideV1, ProviderPermissionModeV1, RuntimeKindIdV1,
    WorkflowSessionGenerationV1, WorkflowSessionPrelaunchCommandV1, WorkspaceIdV1,
};

fn is_false(value: &bool) -> bool {
    !value
}

pub const AGENT_SPAWN_SCHEMA_VERSION_V1: u16 = 1;
const MAX_AGENT_NAME_BYTES: usize = 64;
const MAX_BRANCH_BYTES: usize = 256;
const MAX_WORKTREE_DIRECTORY_BYTES: usize = 256;
const MAX_CAPABILITIES: usize = 32;
const MAX_EVENTS: usize = 16_384;
const MAX_TOKEN_BYTES: usize = 160;

macro_rules! sha256_value {
    ($name:ident, $field:literal) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, AgentSpawnContractErrorV1> {
                let value = value.into();
                if !valid_sha256(&value) {
                    return Err(invalid_plan(
                        $field,
                        "must be sha256: followed by 64 lowercase hexadecimal characters",
                    ));
                }
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
    };
}

sha256_value!(AgentSpawnPromptDigestV1, "promptDigest");
sha256_value!(AgentSpawnPlanTokenV1, "planToken");

impl AgentSpawnPromptDigestV1 {
    pub fn sha256(value: impl AsRef<[u8]>) -> Self {
        let digest = Sha256::digest(value.as_ref());
        Self(format!("sha256:{digest:x}"))
    }
}

pub type AgentSpawnPermissionModeV1 = ProviderPermissionModeV1;

fn default_execution_profile() -> AgentExecutionProfileV1 {
    AgentExecutionProfileV1::ProviderDefault
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpawnSourceSelectionAuthorityV1 {
    pub revision: i64,
    pub interaction_profile: AgentInteractionProfileV1,
    pub execution_profile: AgentExecutionProfileV1,
    pub permission_mode: ProviderPermissionModeV1,
    pub model: Option<AgentSpawnModelSelectionV1>,
    pub effort: Option<AgentSpawnEffortSelectionV1>,
}

impl AgentSpawnSourceSelectionAuthorityV1 {
    pub fn from_selection(selection: &AgentRuntimeSelectionV1) -> Self {
        Self {
            revision: selection.revision,
            interaction_profile: selection.interaction_profile,
            execution_profile: selection.execution_profile.clone(),
            permission_mode: selection.permission_mode.clone(),
            model: selection.model.clone(),
            effort: selection.effort.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "interactionProfile",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentSpawnSourceRuntimeAuthorityV1 {
    NativeCli {
        runtime_kind_id: RuntimeKindIdV1,
        session_id: String,
        provider_conversation_ref: Option<String>,
        credential_reference_id: Option<String>,
        binding_generation: i64,
        runtime_workspace_id: String,
        runner_principal: String,
        runner_instance: String,
        channel_epoch: String,
        host_instance_id: String,
        terminal_epoch: String,
    },
    StructuredProtocol {
        interaction_session_id: AgentInteractionSessionIdV1,
        provider_conversation_ref: Option<String>,
        runtime: AgentProviderRuntimeFenceV1,
        timeline_epoch: AgentTimelineEpochV1,
        binding_revision: i64,
    },
}

impl AgentSpawnSourceRuntimeAuthorityV1 {
    pub fn from_authority(authority: &AgentRuntimeBindingAuthorityV1) -> Self {
        match authority {
            AgentRuntimeBindingAuthorityV1::NativeCli { authority } => Self::NativeCli {
                runtime_kind_id: authority.binding.runtime_kind_id.clone(),
                session_id: authority.binding.session_id.clone(),
                provider_conversation_ref: authority.binding.provider_conversation_id.clone(),
                credential_reference_id: authority.binding.credential_reference_id.clone(),
                binding_generation: authority.binding.binding_generation,
                runtime_workspace_id: authority.runtime_workspace_id.clone(),
                runner_principal: authority.runner_principal.clone(),
                runner_instance: authority.runner_instance.clone(),
                channel_epoch: authority.channel_epoch.clone(),
                host_instance_id: authority.host_instance_id.clone(),
                terminal_epoch: authority.terminal_epoch.clone(),
            },
            AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => {
                Self::StructuredProtocol {
                    interaction_session_id: binding.interaction_session_id.clone(),
                    provider_conversation_ref: binding.provider_conversation_ref.clone(),
                    runtime: binding.runtime.clone(),
                    timeline_epoch: binding.timeline_epoch.clone(),
                    binding_revision: binding.binding_revision,
                }
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpawnExistingWorkspaceAuthorityV1 {
    pub source_agent_id: AgentIdV1,
    pub workspace_id: WorkspaceIdV1,
    pub project_id: ProjectIdV1,
    pub provider_id: ProviderIdV1,
    pub workspace_root: String,
    pub workspace_base_commit_sha: Option<String>,
    pub runtime_selection: AgentSpawnSourceSelectionAuthorityV1,
    pub runtime_binding: AgentSpawnSourceRuntimeAuthorityV1,
}

impl AgentSpawnExistingWorkspaceAuthorityV1 {
    pub fn validate(&self) -> Result<(), AgentSpawnContractErrorV1> {
        if self.workspace_root.is_empty() || self.workspace_root.contains('\0') {
            return Err(invalid_plan("sourceWorkspaceRoot", "path is invalid"));
        }
        if self.runtime_selection.revision < 1 {
            return Err(invalid_plan("sourceSelectionRevision", "must be positive"));
        }
        self.runtime_selection
            .execution_profile
            .validate()
            .map_err(|_| invalid_plan("sourceExecutionProfile", "is invalid"))?;
        if let Some(base_commit_sha) = &self.workspace_base_commit_sha {
            validate_token("sourceWorkspaceBaseCommitSha", base_commit_sha)?;
        }
        let profile_matches = matches!(
            (
                &self.runtime_selection.interaction_profile,
                &self.runtime_binding
            ),
            (
                AgentInteractionProfileV1::NativeCli,
                AgentSpawnSourceRuntimeAuthorityV1::NativeCli { .. }
            ) | (
                AgentInteractionProfileV1::StructuredProtocol,
                AgentSpawnSourceRuntimeAuthorityV1::StructuredProtocol { .. }
            )
        );
        if !profile_matches {
            return Err(invalid_plan(
                "sourceAuthority",
                "runtime binding must match the selected interaction profile",
            ));
        }
        if let AgentSpawnSourceRuntimeAuthorityV1::NativeCli {
            binding_generation,
            runtime_workspace_id,
            session_id,
            provider_conversation_ref,
            credential_reference_id,
            runner_principal,
            runner_instance,
            channel_epoch,
            host_instance_id,
            terminal_epoch,
            ..
        } = &self.runtime_binding
        {
            if *binding_generation < 1 || runtime_workspace_id != self.workspace_id.as_str() {
                return Err(invalid_plan("sourceBinding", "native binding is invalid"));
            }
            for (field, value) in [
                ("sourceSessionId", session_id),
                ("sourceRuntimeWorkspaceId", runtime_workspace_id),
                ("sourceRunnerPrincipal", runner_principal),
                ("sourceRunnerInstance", runner_instance),
                ("sourceChannelEpoch", channel_epoch),
                ("sourceHostInstanceId", host_instance_id),
                ("sourceTerminalEpoch", terminal_epoch),
            ] {
                validate_token(field, value)?;
            }
            if let Some(value) = provider_conversation_ref {
                AgentProviderConversationPlanV1::resume(value.clone())
                    .map_err(|_| invalid_plan("sourceProviderConversationRef", "is invalid"))?;
            }
            if let Some(value) = credential_reference_id {
                validate_token("sourceCredentialReferenceId", value)?;
            }
        }
        if let AgentSpawnSourceRuntimeAuthorityV1::StructuredProtocol {
            binding_revision,
            provider_conversation_ref,
            runtime,
            ..
        } = &self.runtime_binding
        {
            if *binding_revision < 1 {
                return Err(invalid_plan(
                    "sourceBinding",
                    "structured binding is invalid",
                ));
            }
            runtime
                .validate()
                .map_err(|_| invalid_plan("sourceRuntime", "is invalid"))?;
            if let Some(value) = provider_conversation_ref {
                AgentProviderConversationPlanV1::resume(value.clone())
                    .map_err(|_| invalid_plan("sourceProviderConversationRef", "is invalid"))?;
            }
        }
        Ok(())
    }
}

/// Caller preference for the interaction surface. Absent keeps the provider
/// default (structured chat when the provider offers it). `native_cli` pins
/// the spawn to a PTY terminal run — the basic interface mode's creation
/// contract (owner decision 2026-08-31).
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSpawnInteractionPreferenceV1 {
    NativeCli,
}

impl AgentSpawnInteractionPreferenceV1 {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentSpawnInteractionPreferenceV1::NativeCli => "native_cli",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpawnPreviewRequestV1 {
    pub schema_version: u16,
    pub idempotency_key: String,
    pub project_id: ProjectIdV1,
    pub provider_id: ProviderIdV1,
    #[serde(default = "default_execution_profile")]
    pub execution_profile: AgentExecutionProfileV1,
    pub agent_name: String,
    pub worktree: AgentSpawnWorktreePolicyV1,
    #[serde(default)]
    pub provider_conversation_ref: AgentProviderConversationPlanV1,
    pub permission_mode: AgentSpawnPermissionModeV1,
    pub prompt_digest: Option<AgentSpawnPromptDigestV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_command: Option<WorkflowSessionPrelaunchCommandV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<AgentSpawnModelSelectionV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<AgentSpawnEffortSelectionV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_preference: Option<AgentSpawnInteractionPreferenceV1>,
}

/// Caller-owned preview intent. An omitted permission override inherits from
/// the backend profile's revisioned provider defaults document.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpawnPreviewIntentV1 {
    pub schema_version: u16,
    pub idempotency_key: String,
    pub project_id: ProjectIdV1,
    pub provider_id: ProviderIdV1,
    #[serde(default = "default_execution_profile")]
    pub execution_profile: AgentExecutionProfileV1,
    pub agent_name: String,
    pub worktree: AgentSpawnWorktreePolicyV1,
    #[serde(default)]
    pub provider_conversation_ref: AgentProviderConversationPlanV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_override: Option<ProviderLaunchPermissionOverrideV1>,
    pub prompt_digest: Option<AgentSpawnPromptDigestV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_command: Option<WorkflowSessionPrelaunchCommandV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<AgentSpawnModelSelectionV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<AgentSpawnEffortSelectionV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_preference: Option<AgentSpawnInteractionPreferenceV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpawnAuthorityV1 {
    pub backend_id: String,
    pub backend_generation: String,
    pub project_id: ProjectIdV1,
    pub root_id: String,
    pub repository_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpawnRuntimePlanV1 {
    pub runtime_kind_id: RuntimeKindIdV1,
    pub required_capabilities: Vec<CapabilityIdV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "interactionProfile",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AgentSpawnLaunchPlanV1 {
    NativeCli {
        session_id: String,
        runtime: AgentSpawnRuntimePlanV1,
    },
    StructuredProtocol,
}

impl AgentSpawnLaunchPlanV1 {
    pub fn interaction_profile(&self) -> crate::AgentInteractionProfileV1 {
        match self {
            Self::NativeCli { .. } => crate::AgentInteractionProfileV1::NativeCli,
            Self::StructuredProtocol => crate::AgentInteractionProfileV1::StructuredProtocol,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpawnPlanDraftV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub authority: AgentSpawnAuthorityV1,
    pub request: AgentSpawnPreviewRequestV1,
    pub agent_id: AgentIdV1,
    pub workspace_id: WorkspaceIdV1,
    pub launch: AgentSpawnLaunchPlanV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_launch_defaults: Option<ProviderLaunchDefaultsResolutionV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpawnPlanIntentDraftV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub authority: AgentSpawnAuthorityV1,
    pub request: AgentSpawnPreviewIntentV1,
    pub agent_id: AgentIdV1,
    pub workspace_id: WorkspaceIdV1,
    pub launch: AgentSpawnLaunchPlanV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpawnPlanV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub authority: AgentSpawnAuthorityV1,
    pub request: AgentSpawnPreviewRequestV1,
    pub agent_id: AgentIdV1,
    pub workspace_id: WorkspaceIdV1,
    pub launch: AgentSpawnLaunchPlanV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_launch_defaults: Option<ProviderLaunchDefaultsResolutionV1>,
    pub plan_token: AgentSpawnPlanTokenV1,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentSpawnPlanWireV1 {
    schema_version: u16,
    operation_id: OperationIdV1,
    authority: AgentSpawnAuthorityV1,
    request: AgentSpawnPreviewRequestV1,
    agent_id: AgentIdV1,
    workspace_id: WorkspaceIdV1,
    #[serde(default)]
    launch: Option<AgentSpawnLaunchPlanV1>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    runtime: Option<AgentSpawnRuntimePlanV1>,
    #[serde(default)]
    provider_launch_defaults: Option<ProviderLaunchDefaultsResolutionV1>,
    plan_token: AgentSpawnPlanTokenV1,
}

impl<'de> Deserialize<'de> for AgentSpawnPlanV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = AgentSpawnPlanWireV1::deserialize(deserializer)?;
        let launch = match (wire.launch, wire.session_id, wire.runtime) {
            (Some(launch), None, None) => launch,
            (None, Some(session_id), Some(runtime)) => AgentSpawnLaunchPlanV1::NativeCli {
                session_id,
                runtime,
            },
            _ => {
                return Err(serde::de::Error::custom(
                    "spawn plan must carry exactly one launch shape",
                ));
            }
        };
        let plan = Self {
            schema_version: wire.schema_version,
            operation_id: wire.operation_id,
            authority: wire.authority,
            request: wire.request,
            agent_id: wire.agent_id,
            workspace_id: wire.workspace_id,
            launch,
            provider_launch_defaults: wire.provider_launch_defaults,
            plan_token: wire.plan_token,
        };
        plan.validate().map_err(serde::de::Error::custom)?;
        Ok(plan)
    }
}

impl AgentSpawnPlanV1 {
    pub fn validate(&self) -> Result<(), AgentSpawnContractErrorV1> {
        let draft = AgentSpawnPlanDraftV1 {
            schema_version: self.schema_version,
            operation_id: self.operation_id.clone(),
            authority: self.authority.clone(),
            request: self.request.clone(),
            agent_id: self.agent_id.clone(),
            workspace_id: self.workspace_id.clone(),
            launch: self.launch.clone(),
            provider_launch_defaults: self.provider_launch_defaults.clone(),
        };
        validate_draft(&draft)?;
        if plan_token(&draft) != self.plan_token {
            return Err(invalid_plan(
                "planToken",
                "does not bind the exact normalized spawn plan",
            ));
        }
        Ok(())
    }

    pub fn with_launch(
        self,
        launch: AgentSpawnLaunchPlanV1,
    ) -> Result<Self, AgentSpawnContractErrorV1> {
        create_agent_spawn_plan_v1(AgentSpawnPlanDraftV1 {
            schema_version: self.schema_version,
            operation_id: self.operation_id,
            authority: self.authority,
            request: self.request,
            agent_id: self.agent_id,
            workspace_id: self.workspace_id,
            launch,
            provider_launch_defaults: self.provider_launch_defaults,
        })
    }
}

pub fn create_agent_spawn_plan_v1(
    draft: AgentSpawnPlanDraftV1,
) -> Result<AgentSpawnPlanV1, AgentSpawnContractErrorV1> {
    validate_draft(&draft)?;
    let token = plan_token(&draft);
    Ok(AgentSpawnPlanV1 {
        schema_version: draft.schema_version,
        operation_id: draft.operation_id,
        authority: draft.authority,
        request: draft.request,
        agent_id: draft.agent_id,
        workspace_id: draft.workspace_id,
        launch: draft.launch,
        provider_launch_defaults: draft.provider_launch_defaults,
        plan_token: token,
    })
}

pub fn create_agent_spawn_plan_from_defaults_v1(
    draft: AgentSpawnPlanIntentDraftV1,
    defaults: &ProviderLaunchDefaultsV1,
) -> Result<AgentSpawnPlanV1, AgentSpawnContractErrorV1> {
    defaults
        .validate()
        .map_err(|_| invalid_plan("providerLaunchDefaults", "document is invalid"))?;
    let permission_mode = defaults.resolve_permission_mode(
        &draft.request.provider_id,
        draft.request.permission_override,
    );
    create_agent_spawn_plan_v1(AgentSpawnPlanDraftV1 {
        schema_version: draft.schema_version,
        operation_id: draft.operation_id,
        authority: draft.authority,
        request: AgentSpawnPreviewRequestV1 {
            schema_version: draft.request.schema_version,
            idempotency_key: draft.request.idempotency_key,
            project_id: draft.request.project_id,
            provider_id: draft.request.provider_id,
            execution_profile: draft.request.execution_profile,
            agent_name: draft.request.agent_name,
            worktree: draft.request.worktree,
            provider_conversation_ref: draft.request.provider_conversation_ref,
            permission_mode,
            prompt_digest: draft.request.prompt_digest,
            setup_command: draft.request.setup_command,
            model: draft.request.model,
            effort: draft.request.effort,
            interaction_preference: draft.request.interaction_preference,
        },
        agent_id: draft.agent_id,
        workspace_id: draft.workspace_id,
        launch: draft.launch,
        provider_launch_defaults: Some(ProviderLaunchDefaultsResolutionV1::from_document(
            defaults,
            draft.request.permission_override,
        )),
    })
}

pub fn validate_agent_spawn_plan_intent_v1(
    draft: &AgentSpawnPlanIntentDraftV1,
) -> Result<(), AgentSpawnContractErrorV1> {
    let permission_mode = draft
        .request
        .permission_override
        .map_or(ProviderPermissionModeV1::Default, |value| value.concrete());
    validate_draft(&AgentSpawnPlanDraftV1 {
        schema_version: draft.schema_version,
        operation_id: draft.operation_id.clone(),
        authority: draft.authority.clone(),
        request: AgentSpawnPreviewRequestV1 {
            schema_version: draft.request.schema_version,
            idempotency_key: draft.request.idempotency_key.clone(),
            project_id: draft.request.project_id.clone(),
            provider_id: draft.request.provider_id.clone(),
            execution_profile: draft.request.execution_profile.clone(),
            agent_name: draft.request.agent_name.clone(),
            worktree: draft.request.worktree.clone(),
            provider_conversation_ref: draft.request.provider_conversation_ref.clone(),
            permission_mode,
            prompt_digest: draft.request.prompt_digest.clone(),
            setup_command: draft.request.setup_command.clone(),
            model: draft.request.model.clone(),
            effort: draft.request.effort.clone(),
            interaction_preference: draft.request.interaction_preference,
        },
        agent_id: draft.agent_id.clone(),
        workspace_id: draft.workspace_id.clone(),
        launch: draft.launch.clone(),
        provider_launch_defaults: None,
    })
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSpawnStageV1 {
    Worktree,
    RuntimeLaunch,
    PromptDelivery,
    StructuredLaunch,
    StructuredPromptDelivery,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentSpawnStageInputsV1 {
    Worktree {
        workspace_id: WorkspaceIdV1,
        project_root_id: String,
        repository_id: String,
        policy: AgentSpawnWorktreePolicyV1,
    },
    RuntimeLaunch {
        agent_id: AgentIdV1,
        workspace_id: WorkspaceIdV1,
        session_id: String,
        runtime_kind_id: RuntimeKindIdV1,
        provider_id: ProviderIdV1,
        #[serde(default)]
        provider_conversation_ref: AgentProviderConversationPlanV1,
        permission_mode: AgentSpawnPermissionModeV1,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        setup_command: Option<WorkflowSessionPrelaunchCommandV1>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<AgentSpawnModelSelectionV1>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<AgentSpawnEffortSelectionV1>,
    },
    PromptDelivery {
        session_id: String,
        prompt_digest: AgentSpawnPromptDigestV1,
    },
    StructuredLaunch {
        agent_id: AgentIdV1,
        workspace_id: WorkspaceIdV1,
        provider_id: ProviderIdV1,
        execution_profile: AgentExecutionProfileV1,
        #[serde(default)]
        provider_conversation_ref: AgentProviderConversationPlanV1,
    },
    StructuredPromptDelivery {
        interaction_session_id: AgentInteractionSessionIdV1,
        runtime: AgentProviderRuntimeFenceV1,
        turn_id: AgentTurnIdV1,
        client_message_id: AgentClientMessageIdV1,
        prompt_digest: AgentSpawnPromptDigestV1,
    },
}

impl AgentSpawnStageInputsV1 {
    pub fn stage(&self) -> AgentSpawnStageV1 {
        match self {
            Self::Worktree { .. } => AgentSpawnStageV1::Worktree,
            Self::RuntimeLaunch { .. } => AgentSpawnStageV1::RuntimeLaunch,
            Self::PromptDelivery { .. } => AgentSpawnStageV1::PromptDelivery,
            Self::StructuredLaunch { .. } => AgentSpawnStageV1::StructuredLaunch,
            Self::StructuredPromptDelivery { .. } => AgentSpawnStageV1::StructuredPromptDelivery,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSpawnStageDispositionV1 {
    CreatedDureOwned,
    AdoptedExisting,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AgentSpawnWorkspaceLeaseV1 {
    pub lease_id: String,
    pub directory_name: String,
    pub retirement_id: String,
}

impl AgentSpawnWorkspaceLeaseV1 {
    pub fn for_dedicated(
        workspace_id: &WorkspaceIdV1,
        branch: &str,
    ) -> Result<Self, AgentSpawnContractErrorV1> {
        let lease = Self {
            lease_id: format!("workspace-lease:{}", workspace_id.as_str()),
            directory_name: worktree_directory_name(branch),
            retirement_id: format!("workspace-retire:{}", workspace_id.as_str()),
        };
        validate_workspace_lease(workspace_id, branch, &lease)?;
        Ok(lease)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentSpawnStageEvidenceV1 {
    Worktree {
        workspace_id: WorkspaceIdV1,
        disposition: AgentSpawnStageDispositionV1,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lease: Option<AgentSpawnWorkspaceLeaseV1>,
    },
    RuntimeLaunch {
        session: WorkflowSessionGenerationV1,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        launch_idempotency_key: Option<String>,
        #[serde(default, skip_serializing_if = "is_false")]
        initial_prompt_accepted: bool,
    },
    PromptDelivery {
        session_id: String,
        delivery_id: String,
    },
    StructuredLaunch {
        binding: AgentInteractionBindingV1,
    },
    StructuredPromptDelivery {
        interaction_session_id: AgentInteractionSessionIdV1,
        runtime: AgentProviderRuntimeFenceV1,
        turn_id: AgentTurnIdV1,
        client_message_id: AgentClientMessageIdV1,
    },
}

impl AgentSpawnStageEvidenceV1 {
    pub fn stage(&self) -> AgentSpawnStageV1 {
        match self {
            Self::Worktree { .. } => AgentSpawnStageV1::Worktree,
            Self::RuntimeLaunch { .. } => AgentSpawnStageV1::RuntimeLaunch,
            Self::PromptDelivery { .. } => AgentSpawnStageV1::PromptDelivery,
            Self::StructuredLaunch { .. } => AgentSpawnStageV1::StructuredLaunch,
            Self::StructuredPromptDelivery { .. } => AgentSpawnStageV1::StructuredPromptDelivery,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSpawnTerminalOutcomeV1 {
    Failed,
    ManualInterventionRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentSpawnJournalEventBodyV1 {
    Planned {
        plan: Box<AgentSpawnPlanV1>,
    },
    StagePrepared {
        attempt: u32,
        inputs: AgentSpawnStageInputsV1,
    },
    StageCommitted {
        attempt: u32,
        evidence: AgentSpawnStageEvidenceV1,
    },
    CheckoutClaimed {
        registration: GitCheckoutRegistrationV1,
    },
    StageFailed {
        stage: AgentSpawnStageV1,
        attempt: u32,
        error_code: String,
        /// Free-form evidence behind `error_code` — bounded, single-line, and
        /// never machine-matched. Optional so every receipt written before it
        /// existed still parses, and skipped when absent so an ordinary
        /// failure serialises exactly as it did.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_detail: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        may_have_written: Option<bool>,
    },
    RetryAuthorized {
        stage: AgentSpawnStageV1,
        failed_attempt: u32,
    },
    Terminated {
        outcome: AgentSpawnTerminalOutcomeV1,
        error_code: String,
    },
    Succeeded,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpawnJournalEventV1 {
    pub event_id: OperationEventIdV1,
    pub operation_id: OperationIdV1,
    pub sequence: u32,
    pub plan_token: AgentSpawnPlanTokenV1,
    pub body: AgentSpawnJournalEventBodyV1,
    pub recorded_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpawnStageReceiptV1 {
    pub stage: AgentSpawnStageV1,
    pub attempt: u32,
    pub inputs: AgentSpawnStageInputsV1,
    pub evidence: AgentSpawnStageEvidenceV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSpawnJournalStateV1 {
    Applying,
    ReadyToSucceed,
    InspectBeforeRetry,
    RetryRequired,
    PromptDeliveryUncertain,
    Succeeded,
    Failed,
    ManualInterventionRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentSpawnRecoveryDirectiveV1 {
    Continue {
        stage: AgentSpawnStageV1,
        next_attempt: u32,
    },
    Finish,
    InspectBeforeRetry {
        attempt: u32,
        inputs: AgentSpawnStageInputsV1,
    },
    RetryRequired {
        stage: AgentSpawnStageV1,
        failed_attempt: u32,
        error_code: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_detail: Option<String>,
        inputs: AgentSpawnStageInputsV1,
    },
    DoNotReplayPrompt {
        attempt: u32,
        inputs: AgentSpawnStageInputsV1,
        error_code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_detail: Option<String>,
    },
    None,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSpawnJournalReceiptV1 {
    pub schema_version: u16,
    pub operation_id: OperationIdV1,
    pub plan: AgentSpawnPlanV1,
    pub state: AgentSpawnJournalStateV1,
    pub last_sequence: u32,
    pub completed: Vec<AgentSpawnStageReceiptV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkout_registration: Option<GitCheckoutRegistrationV1>,
    pub recovery: AgentSpawnRecoveryDirectiveV1,
    pub terminal_code: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentSpawnCommittedWorkspaceV1<'a> {
    AdoptedProjectRoot {
        workspace_id: &'a WorkspaceIdV1,
    },
    DureOwned {
        workspace_id: &'a WorkspaceIdV1,
        lease: &'a AgentSpawnWorkspaceLeaseV1,
    },
}

impl AgentSpawnJournalReceiptV1 {
    /// Returns workspace ownership only after the journal fold committed that stage.
    pub fn committed_workspace_ownership(&self) -> Option<AgentSpawnCommittedWorkspaceV1<'_>> {
        self.completed
            .iter()
            .find_map(|stage| match &stage.evidence {
                AgentSpawnStageEvidenceV1::Worktree {
                    workspace_id,
                    disposition: AgentSpawnStageDispositionV1::AdoptedExisting,
                    lease: None,
                } => Some(AgentSpawnCommittedWorkspaceV1::AdoptedProjectRoot { workspace_id }),
                AgentSpawnStageEvidenceV1::Worktree {
                    workspace_id,
                    disposition: AgentSpawnStageDispositionV1::CreatedDureOwned,
                    lease: Some(lease),
                } => Some(AgentSpawnCommittedWorkspaceV1::DureOwned {
                    workspace_id,
                    lease,
                }),
                _ => None,
            })
    }
}

pub trait AgentSpawnJournalStore: Send + Sync {
    fn append_agent_spawn_event<'a>(
        &'a self,
        event: &'a AgentSpawnJournalEventV1,
    ) -> DomainStoreFuture<'a, AgentSpawnJournalReceiptV1>;

    fn agent_spawn_receipt<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentSpawnJournalReceiptV1>>;

    fn agent_spawn_receipt_by_idempotency_key<'a>(
        &'a self,
        idempotency_key: &'a str,
    ) -> DomainStoreFuture<'a, Option<AgentSpawnJournalReceiptV1>>;

    fn agent_spawn_receipt_by_agent_id<'a>(
        &'a self,
        agent_id: &'a AgentIdV1,
    ) -> DomainStoreFuture<'a, Option<AgentSpawnJournalReceiptV1>>;

    fn rebuild_agent_spawn_receipts(&self) -> DomainStoreFuture<'_, usize>;
}

struct RecordedStageFailure {
    stage: AgentSpawnStageV1,
    attempt: u32,
    error_code: String,
    error_detail: Option<String>,
    inputs: AgentSpawnStageInputsV1,
    may_have_written: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentSpawnContractErrorV1 {
    InvalidPlan { field: &'static str, reason: String },
    InvalidStream { reason: String },
}

impl fmt::Display for AgentSpawnContractErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPlan { field, reason } => {
                write!(
                    formatter,
                    "invalid agent spawn plan field {field}: {reason}"
                )
            }
            Self::InvalidStream { reason } => {
                write!(formatter, "invalid agent spawn event stream: {reason}")
            }
        }
    }
}

impl Error for AgentSpawnContractErrorV1 {}

pub fn fold_agent_spawn_journal_v1(
    events: &[AgentSpawnJournalEventV1],
) -> Result<AgentSpawnJournalReceiptV1, AgentSpawnContractErrorV1> {
    if events.len() > MAX_EVENTS {
        return Err(invalid_stream(format!(
            "operation exceeds {MAX_EVENTS} journal events"
        )));
    }
    let first = events
        .first()
        .ok_or_else(|| invalid_stream("operation has no events"))?;
    validate_event_record(first)?;
    if first.sequence != 1 {
        return Err(invalid_stream("the first event sequence must be 1"));
    }
    let AgentSpawnJournalEventBodyV1::Planned { plan } = &first.body else {
        return Err(invalid_stream("sequence 1 must be agent spawn planned"));
    };
    let plan = plan.as_ref();
    plan.validate()?;
    if first.operation_id != plan.operation_id || first.plan_token != plan.plan_token {
        return Err(invalid_stream(
            "the planned event must match its operation and plan token",
        ));
    }

    let stages = planned_stages(plan);
    let mut completed = Vec::with_capacity(stages.len());
    let mut attempts = vec![0_u32; stages.len()];
    let mut in_flight: Option<(u32, AgentSpawnStageInputsV1)> = None;
    let mut failure: Option<RecordedStageFailure> = None;
    let mut state = AgentSpawnJournalStateV1::Applying;
    let mut terminal_code = None;
    let mut checkout_registration = None;
    let mut updated_at_ms = first.recorded_at_ms;
    let mut event_ids = BTreeSet::from([first.event_id.clone()]);

    for (offset, event) in events.iter().enumerate().skip(1) {
        validate_event_record(event)?;
        let expected_sequence =
            u32::try_from(offset + 1).map_err(|_| invalid_stream("event stream is too large"))?;
        if event.sequence != expected_sequence {
            return Err(invalid_stream(format!(
                "expected sequence {expected_sequence}, found {}",
                event.sequence
            )));
        }
        if !event_ids.insert(event.event_id.clone()) {
            return Err(invalid_stream("journal event ids must be unique"));
        }
        if event.operation_id != plan.operation_id || event.plan_token != plan.plan_token {
            return Err(invalid_stream(
                "every event must match the planned operation and token",
            ));
        }
        if event.recorded_at_ms < updated_at_ms {
            return Err(invalid_stream("event timestamps must be monotonic"));
        }
        if matches!(
            state,
            AgentSpawnJournalStateV1::Succeeded
                | AgentSpawnJournalStateV1::Failed
                | AgentSpawnJournalStateV1::ManualInterventionRequired
        ) {
            return Err(invalid_stream("events cannot follow a terminal event"));
        }

        match &event.body {
            AgentSpawnJournalEventBodyV1::Planned { .. } => {
                return Err(invalid_stream(
                    "agent spawn planned may only appear at sequence 1",
                ));
            }
            AgentSpawnJournalEventBodyV1::StagePrepared { attempt, inputs } => {
                if in_flight.is_some() || failure.is_some() {
                    return Err(invalid_stream(
                        "a stage cannot prepare while another outcome is unresolved",
                    ));
                }
                let stage_index = completed.len();
                let expected_stage = stages
                    .get(stage_index)
                    .ok_or_else(|| invalid_stream("all planned stages are already complete"))?;
                if inputs.stage() != *expected_stage {
                    return Err(invalid_stream("stage preparation is out of plan order"));
                }
                validate_stage_inputs(plan, &completed, inputs)?;
                let expected_attempt = attempts[stage_index]
                    .checked_add(1)
                    .ok_or_else(|| invalid_stream("stage attempt overflowed"))?;
                if *attempt != expected_attempt {
                    return Err(invalid_stream(format!(
                        "expected stage attempt {expected_attempt}, found {attempt}"
                    )));
                }
                attempts[stage_index] = *attempt;
                in_flight = Some((*attempt, inputs.clone()));
            }
            AgentSpawnJournalEventBodyV1::StageCommitted { attempt, evidence } => {
                let (prepared_attempt, inputs) = in_flight
                    .take()
                    .ok_or_else(|| invalid_stream("stage commit has no prepared inputs"))?;
                if prepared_attempt != *attempt || inputs.stage() != evidence.stage() {
                    return Err(invalid_stream(
                        "stage commit does not match the prepared stage attempt",
                    ));
                }
                validate_stage_evidence(plan, &inputs, evidence)?;
                completed.push(AgentSpawnStageReceiptV1 {
                    stage: inputs.stage(),
                    attempt: *attempt,
                    inputs,
                    evidence: evidence.clone(),
                });
            }
            AgentSpawnJournalEventBodyV1::CheckoutClaimed { registration } => {
                let workspace_prepared = in_flight
                    .as_ref()
                    .is_some_and(|(_, inputs)| inputs.stage() == AgentSpawnStageV1::Worktree)
                    || completed
                        .first()
                        .is_some_and(|stage| stage.stage == AgentSpawnStageV1::Worktree);
                if !workspace_prepared || checkout_registration.is_some() {
                    return Err(invalid_stream(
                        "checkout registration must be recorded once after workspace preparation",
                    ));
                }
                if let AgentSpawnWorktreePolicyV1::ExistingCheckout { instance, .. } =
                    &plan.request.worktree
                {
                    if instance != &registration.instance {
                        return Err(invalid_stream(
                            "checkout claim must match the selected instance",
                        ));
                    }
                }
                checkout_registration = Some(registration.clone());
            }
            AgentSpawnJournalEventBodyV1::StageFailed {
                stage,
                attempt,
                error_code,
                error_detail,
                may_have_written,
            } => {
                validate_stream_token("errorCode", error_code)?;
                // The code is a machine token; the detail is evidence written
                // for a human, so it is bounded and single-line rather than
                // token-shaped. Rejecting it outright would put us back to a
                // code with no cause.
                if let Some(detail) = error_detail {
                    validate_error_detail(detail)?;
                }
                if !matches!(
                    stage,
                    AgentSpawnStageV1::PromptDelivery | AgentSpawnStageV1::StructuredPromptDelivery
                ) && may_have_written.is_some()
                {
                    return Err(invalid_stream(
                        "only prompt delivery can record prompt write certainty",
                    ));
                }
                let (prepared_attempt, inputs) = in_flight
                    .take()
                    .ok_or_else(|| invalid_stream("stage failure has no prepared inputs"))?;
                if prepared_attempt != *attempt || inputs.stage() != *stage {
                    return Err(invalid_stream(
                        "stage failure does not match the prepared stage attempt",
                    ));
                }
                failure = Some(RecordedStageFailure {
                    stage: *stage,
                    attempt: *attempt,
                    error_code: error_code.clone(),
                    error_detail: error_detail.clone(),
                    inputs,
                    may_have_written: *may_have_written,
                });
            }
            AgentSpawnJournalEventBodyV1::RetryAuthorized {
                stage,
                failed_attempt,
            } => {
                let failed = failure
                    .take()
                    .ok_or_else(|| invalid_stream("retry has no recorded stage failure"))?;
                if failed.stage != *stage || failed.attempt != *failed_attempt {
                    return Err(invalid_stream("retry does not match the recorded failure"));
                }
                if prompt_write_is_uncertain(failed.inputs.stage(), failed.may_have_written) {
                    return Err(invalid_stream(
                        "an uncertain prompt delivery must never be replayed",
                    ));
                }
            }
            AgentSpawnJournalEventBodyV1::Terminated {
                outcome,
                error_code,
            } => {
                validate_stream_token("errorCode", error_code)?;
                if failure.is_none() && in_flight.is_none() {
                    return Err(invalid_stream(
                        "termination requires a failed or uncertain prepared stage",
                    ));
                }
                let mutation_uncertain = in_flight.is_some()
                    || failure.as_ref().is_some_and(|failed| {
                        prompt_write_is_uncertain(failed.stage, failed.may_have_written)
                    });
                if mutation_uncertain
                    && outcome != &AgentSpawnTerminalOutcomeV1::ManualInterventionRequired
                {
                    return Err(invalid_stream(
                        "an uncertain prepared stage requires manual intervention",
                    ));
                }
                terminal_code = Some(error_code.clone());
                state = match outcome {
                    AgentSpawnTerminalOutcomeV1::Failed => AgentSpawnJournalStateV1::Failed,
                    AgentSpawnTerminalOutcomeV1::ManualInterventionRequired => {
                        AgentSpawnJournalStateV1::ManualInterventionRequired
                    }
                };
            }
            AgentSpawnJournalEventBodyV1::Succeeded => {
                if in_flight.is_some() || failure.is_some() || completed.len() != stages.len() {
                    return Err(invalid_stream(
                        "spawn cannot succeed before every planned stage is committed",
                    ));
                }
                state = AgentSpawnJournalStateV1::Succeeded;
            }
        }
        updated_at_ms = event.recorded_at_ms;
    }

    let recovery = if matches!(
        state,
        AgentSpawnJournalStateV1::Succeeded
            | AgentSpawnJournalStateV1::Failed
            | AgentSpawnJournalStateV1::ManualInterventionRequired
    ) {
        AgentSpawnRecoveryDirectiveV1::None
    } else if let Some(failure) = failure {
        let RecordedStageFailure {
            stage,
            attempt: failed_attempt,
            error_code,
            error_detail,
            inputs,
            may_have_written,
        } = failure;
        if prompt_write_is_uncertain(stage, may_have_written) {
            state = AgentSpawnJournalStateV1::PromptDeliveryUncertain;
            AgentSpawnRecoveryDirectiveV1::DoNotReplayPrompt {
                attempt: failed_attempt,
                inputs,
                error_code: Some(error_code),
                error_detail,
            }
        } else {
            state = AgentSpawnJournalStateV1::RetryRequired;
            AgentSpawnRecoveryDirectiveV1::RetryRequired {
                stage,
                failed_attempt,
                error_code,
                error_detail,
                inputs,
            }
        }
    } else if let Some((attempt, inputs)) = in_flight {
        if inputs.stage() == AgentSpawnStageV1::PromptDelivery {
            state = AgentSpawnJournalStateV1::PromptDeliveryUncertain;
            AgentSpawnRecoveryDirectiveV1::DoNotReplayPrompt {
                attempt,
                inputs,
                // The attempt is still in flight: nobody reported a reason yet.
                error_code: None,
                error_detail: None,
            }
        } else {
            state = AgentSpawnJournalStateV1::InspectBeforeRetry;
            AgentSpawnRecoveryDirectiveV1::InspectBeforeRetry { attempt, inputs }
        }
    } else if completed.len() == stages.len() {
        state = AgentSpawnJournalStateV1::ReadyToSucceed;
        AgentSpawnRecoveryDirectiveV1::Finish
    } else {
        let stage = stages[completed.len()];
        AgentSpawnRecoveryDirectiveV1::Continue {
            stage,
            next_attempt: attempts[completed.len()] + 1,
        }
    };

    Ok(AgentSpawnJournalReceiptV1 {
        schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
        operation_id: plan.operation_id.clone(),
        plan: plan.clone(),
        state,
        last_sequence: events.last().map_or(0, |event| event.sequence),
        completed,
        checkout_registration,
        recovery,
        terminal_code,
        created_at_ms: first.recorded_at_ms,
        updated_at_ms,
    })
}

fn prompt_write_is_uncertain(stage: AgentSpawnStageV1, may_have_written: Option<bool>) -> bool {
    // Structured prompt effects carry a stable client-message identity and are
    // safely inspected through the canonical effect journal after response
    // loss. Native PTY paste has no equivalent receipt and stays fail-closed.
    stage == AgentSpawnStageV1::PromptDelivery && may_have_written != Some(false)
}

fn planned_stages(plan: &AgentSpawnPlanV1) -> Vec<AgentSpawnStageV1> {
    let (launch, prompt) = match plan.launch {
        AgentSpawnLaunchPlanV1::NativeCli { .. } => (
            AgentSpawnStageV1::RuntimeLaunch,
            AgentSpawnStageV1::PromptDelivery,
        ),
        AgentSpawnLaunchPlanV1::StructuredProtocol => (
            AgentSpawnStageV1::StructuredLaunch,
            AgentSpawnStageV1::StructuredPromptDelivery,
        ),
    };
    let mut stages = vec![AgentSpawnStageV1::Worktree, launch];
    if plan.request.prompt_digest.is_some() {
        stages.push(prompt);
    }
    stages
}

fn validate_draft(draft: &AgentSpawnPlanDraftV1) -> Result<(), AgentSpawnContractErrorV1> {
    if draft.schema_version != AGENT_SPAWN_SCHEMA_VERSION_V1
        || draft.request.schema_version != AGENT_SPAWN_SCHEMA_VERSION_V1
    {
        return Err(invalid_plan("schemaVersion", "must equal 1"));
    }
    validate_token("idempotencyKey", &draft.request.idempotency_key)?;
    validate_token("backendId", &draft.authority.backend_id)?;
    validate_token("backendGeneration", &draft.authority.backend_generation)?;
    validate_identity("rootId", &draft.authority.root_id, "root_")?;
    validate_identity("repositoryId", &draft.authority.repository_id, "repo_")?;
    if draft.authority.project_id != draft.request.project_id {
        return Err(invalid_plan(
            "projectId",
            "request must match the backend project authority",
        ));
    }
    if !valid_agent_name(&draft.request.agent_name) {
        return Err(invalid_plan(
            "agentName",
            "must be a bounded lowercase stable name",
        ));
    }
    validate_worktree(&draft.request.worktree)?;
    if let AgentSpawnWorktreePolicyV1::ExistingWorkspace { source } = &draft.request.worktree {
        source.validate()?;
        if source.workspace_id != draft.workspace_id
            || source.project_id != draft.request.project_id
            || source.provider_id != draft.request.provider_id
            || source.runtime_selection.execution_profile != draft.request.execution_profile
        {
            return Err(invalid_plan(
                "sourceAuthority",
                "must match the exact target project, workspace, provider, and execution profile",
            ));
        }
    }
    draft
        .request
        .execution_profile
        .validate()
        .map_err(|_| invalid_plan("executionProfile", "is invalid"))?;
    if matches!(
        draft.request.execution_profile,
        AgentExecutionProfileV1::CredentialReference {
            credential_generation: None,
            ..
        }
    ) {
        return Err(invalid_plan(
            "executionProfile",
            "credential references require an exact generation",
        ));
    }
    if let Some(resolution) = &draft.provider_launch_defaults {
        resolution
            .validate()
            .map_err(|_| invalid_plan("providerLaunchDefaults", "resolution is invalid"))?;
        if resolution
            .permission_override
            .is_some_and(|value| value.concrete() != draft.request.permission_mode)
        {
            return Err(invalid_plan(
                "permissionMode",
                "does not match the explicit one-run override",
            ));
        }
    }
    if draft.request.setup_command.is_some()
        && !matches!(
            draft.request.worktree,
            AgentSpawnWorktreePolicyV1::Dedicated { .. }
        )
    {
        return Err(invalid_plan(
            "setupCommand",
            "requires a dedicated Dure-owned workspace",
        ));
    }
    if let AgentSpawnLaunchPlanV1::NativeCli {
        session_id,
        runtime,
    } = &draft.launch
    {
        validate_token("sessionId", session_id)?;
        if runtime.required_capabilities.is_empty()
            || runtime.required_capabilities.len() > MAX_CAPABILITIES
            || runtime
                .required_capabilities
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
        {
            return Err(invalid_plan(
                "requiredCapabilities",
                "must be a sorted unique bounded non-empty capability set",
            ));
        }
    }
    Ok(())
}

fn validate_stage_inputs(
    plan: &AgentSpawnPlanV1,
    completed: &[AgentSpawnStageReceiptV1],
    inputs: &AgentSpawnStageInputsV1,
) -> Result<(), AgentSpawnContractErrorV1> {
    let matches = match inputs {
        AgentSpawnStageInputsV1::Worktree {
            workspace_id,
            project_root_id,
            repository_id,
            policy,
        } => {
            workspace_id == &plan.workspace_id
                && project_root_id == &plan.authority.root_id
                && repository_id == &plan.authority.repository_id
                && policy == &plan.request.worktree
        }
        AgentSpawnStageInputsV1::RuntimeLaunch {
            agent_id,
            workspace_id,
            session_id,
            runtime_kind_id,
            provider_id,
            provider_conversation_ref,
            permission_mode,
            setup_command,
            model,
            effort,
        } => match &plan.launch {
            AgentSpawnLaunchPlanV1::NativeCli {
                session_id: planned_session_id,
                runtime,
            } => {
                agent_id == &plan.agent_id
                    && workspace_id == &plan.workspace_id
                    && session_id == planned_session_id
                    && runtime_kind_id == &runtime.runtime_kind_id
                    && provider_id == &plan.request.provider_id
                    && provider_conversation_ref == &plan.request.provider_conversation_ref
                    && permission_mode == &plan.request.permission_mode
                    && setup_command == &plan.request.setup_command
                    && model == &plan.request.model
                    && effort == &plan.request.effort
            }
            AgentSpawnLaunchPlanV1::StructuredProtocol => false,
        },
        AgentSpawnStageInputsV1::PromptDelivery {
            session_id,
            prompt_digest,
        } => {
            matches!(plan.launch, AgentSpawnLaunchPlanV1::NativeCli { .. })
                && completed_runtime_session(completed)
                    .is_some_and(|session| session_id == &session.session_id)
                && plan.request.prompt_digest.as_ref() == Some(prompt_digest)
        }
        AgentSpawnStageInputsV1::StructuredLaunch {
            agent_id,
            workspace_id,
            provider_id,
            execution_profile,
            provider_conversation_ref,
        } => {
            matches!(plan.launch, AgentSpawnLaunchPlanV1::StructuredProtocol)
                && agent_id == &plan.agent_id
                && workspace_id == &plan.workspace_id
                && provider_id == &plan.request.provider_id
                && execution_profile == &plan.request.execution_profile
                && provider_conversation_ref == &plan.request.provider_conversation_ref
        }
        AgentSpawnStageInputsV1::StructuredPromptDelivery {
            interaction_session_id,
            runtime,
            turn_id,
            client_message_id,
            prompt_digest,
        } => {
            matches!(plan.launch, AgentSpawnLaunchPlanV1::StructuredProtocol)
                && plan.request.prompt_digest.as_ref() == Some(prompt_digest)
                && completed_structured_binding(completed).is_some_and(|binding| {
                    interaction_session_id == &binding.interaction_session_id
                        && runtime == &binding.runtime
                })
                && structured_prompt_identity(&plan.operation_id).is_some_and(|identity| {
                    turn_id == &identity.0 && client_message_id == &identity.1
                })
        }
    };
    if !matches {
        return Err(invalid_stream(
            "prepared stage inputs must exactly match the immutable plan",
        ));
    }
    Ok(())
}

fn validate_stage_evidence(
    plan: &AgentSpawnPlanV1,
    inputs: &AgentSpawnStageInputsV1,
    evidence: &AgentSpawnStageEvidenceV1,
) -> Result<(), AgentSpawnContractErrorV1> {
    let matches = match evidence {
        AgentSpawnStageEvidenceV1::Worktree {
            workspace_id,
            disposition,
            lease,
        } => {
            match &plan.request.worktree {
                AgentSpawnWorktreePolicyV1::ProjectRoot
                | AgentSpawnWorktreePolicyV1::ExistingCheckout { .. } => {
                    if *disposition != AgentSpawnStageDispositionV1::AdoptedExisting
                        || lease.is_some()
                    {
                        return Err(invalid_stream(
                            "an adopted checkout cannot have a Dure-owned workspace lease",
                        ));
                    }
                }
                AgentSpawnWorktreePolicyV1::Dedicated { branch, .. } => {
                    if *disposition != AgentSpawnStageDispositionV1::CreatedDureOwned {
                        return Err(invalid_stream(
                            "a dedicated workspace must carry Dure ownership",
                        ));
                    }
                    let lease = lease.as_ref().ok_or_else(|| {
                        invalid_stream("a dedicated workspace must carry its durable lease")
                    })?;
                    validate_workspace_lease(workspace_id, branch, lease)?;
                }
                AgentSpawnWorktreePolicyV1::ExistingWorkspace { source } => {
                    if *disposition != AgentSpawnStageDispositionV1::AdoptedExisting
                        || lease.is_some()
                        || workspace_id != &source.workspace_id
                    {
                        return Err(invalid_stream(
                            "an existing source workspace must be adopted without a lease",
                        ));
                    }
                }
            }
            workspace_id == &plan.workspace_id
        }
        AgentSpawnStageEvidenceV1::RuntimeLaunch {
            session,
            launch_idempotency_key,
            initial_prompt_accepted,
        } => {
            session
                .validate_for_launch_scope(plan.workspace_id.as_str(), &plan.request.provider_id)
                .map_err(|_| invalid_stream("runtime launch evidence is invalid"))?;
            let launch_identity_matches = match &plan.launch {
                AgentSpawnLaunchPlanV1::NativeCli {
                    session_id: prepared_session_id,
                    ..
                } => {
                    let prepared_launch_idempotency_key =
                        format!("spawn-runtime:{}", plan.operation_id.as_str());
                    let is_prepared_session = session.session_id == *prepared_session_id;
                    match launch_idempotency_key {
                        Some(key) => {
                            validate_stream_token("launchIdempotencyKey", key).is_ok()
                                && is_prepared_session == (key == &prepared_launch_idempotency_key)
                        }
                        None => is_prepared_session,
                    }
                }
                AgentSpawnLaunchPlanV1::StructuredProtocol => false,
            };
            launch_identity_matches
                && (!*initial_prompt_accepted || plan.request.prompt_digest.is_some())
        }
        AgentSpawnStageEvidenceV1::PromptDelivery {
            session_id,
            delivery_id,
        } => {
            validate_stream_token("deliveryId", delivery_id)?;
            matches!(
                inputs,
                AgentSpawnStageInputsV1::PromptDelivery {
                    session_id: prepared_session_id,
                    ..
                } if session_id == prepared_session_id
            ) && plan.request.prompt_digest.is_some()
        }
        AgentSpawnStageEvidenceV1::StructuredLaunch { binding } => {
            binding
                .validate()
                .map_err(|_| invalid_stream("structured launch evidence is invalid"))?;
            matches!(plan.launch, AgentSpawnLaunchPlanV1::StructuredProtocol)
                && binding.agent_id == plan.agent_id
                && binding.provider_id == plan.request.provider_id
                && binding.execution_profile == plan.request.execution_profile
                && plan
                    .request
                    .provider_conversation_ref
                    .as_option()
                    .is_none_or(|expected| {
                        binding.provider_conversation_ref.as_deref() == Some(expected)
                    })
        }
        AgentSpawnStageEvidenceV1::StructuredPromptDelivery {
            interaction_session_id,
            runtime,
            turn_id,
            client_message_id,
        } => {
            matches!(plan.launch, AgentSpawnLaunchPlanV1::StructuredProtocol)
                && plan.request.prompt_digest.is_some()
                && matches!(
                    inputs,
                    AgentSpawnStageInputsV1::StructuredPromptDelivery {
                        interaction_session_id: prepared_interaction,
                        runtime: prepared_runtime,
                        turn_id: prepared_turn,
                        client_message_id: prepared_message,
                        ..
                    } if interaction_session_id == prepared_interaction
                        && runtime == prepared_runtime
                        && turn_id == prepared_turn
                        && client_message_id == prepared_message
                )
        }
    };
    if !matches {
        return Err(invalid_stream(
            "stage evidence must exactly match the immutable plan",
        ));
    }
    Ok(())
}

fn completed_structured_binding(
    completed: &[AgentSpawnStageReceiptV1],
) -> Option<&AgentInteractionBindingV1> {
    completed.iter().find_map(|stage| match &stage.evidence {
        AgentSpawnStageEvidenceV1::StructuredLaunch { binding } => Some(binding),
        _ => None,
    })
}

fn completed_runtime_session(
    completed: &[AgentSpawnStageReceiptV1],
) -> Option<&WorkflowSessionGenerationV1> {
    completed.iter().find_map(|stage| match &stage.evidence {
        AgentSpawnStageEvidenceV1::RuntimeLaunch { session, .. } => Some(session),
        _ => None,
    })
}

pub fn structured_prompt_identity(
    operation_id: &OperationIdV1,
) -> Option<(AgentTurnIdV1, AgentClientMessageIdV1)> {
    let digest =
        Sha256::digest(format!("dure.agent_spawn.structured-prompt/v1\0{operation_id}").as_bytes());
    let token = format!("{digest:x}");
    Some((
        AgentTurnIdV1::new(format!("spawn-turn-{}", &token[..24])).ok()?,
        AgentClientMessageIdV1::new(format!("spawn-message-{}", &token[..24])).ok()?,
    ))
}

fn hash_execution_profile(hash: &mut Sha256, profile: &AgentExecutionProfileV1) {
    match profile {
        AgentExecutionProfileV1::ProviderDefault => {
            hash_field(hash, "execution_profile", "provider_default");
        }
        AgentExecutionProfileV1::CredentialReference {
            reference_id,
            credential_generation,
        } => {
            hash_field(hash, "execution_profile", "credential_reference");
            hash_field(hash, "credential_reference", reference_id);
            hash_field(
                hash,
                "credential_generation",
                credential_generation.as_deref().unwrap_or("missing"),
            );
        }
    }
}

fn plan_token(draft: &AgentSpawnPlanDraftV1) -> AgentSpawnPlanTokenV1 {
    let mut hash = Sha256::new();
    hash_field(&mut hash, "contract", "dure.agent_spawn.plan/v1");
    hash_field(&mut hash, "operation", draft.operation_id.as_str());
    hash_field(&mut hash, "backend", &draft.authority.backend_id);
    hash_field(
        &mut hash,
        "backend_generation",
        &draft.authority.backend_generation,
    );
    hash_field(&mut hash, "project", draft.authority.project_id.as_str());
    hash_field(&mut hash, "root", &draft.authority.root_id);
    hash_field(&mut hash, "repository", &draft.authority.repository_id);
    hash_field(&mut hash, "idempotency", &draft.request.idempotency_key);
    hash_field(&mut hash, "provider", draft.request.provider_id.as_str());
    hash_field(&mut hash, "agent_name", &draft.request.agent_name);
    hash_field(
        &mut hash,
        "permission",
        draft.request.permission_mode.as_str(),
    );
    if let Some(resolution) = &draft.provider_launch_defaults {
        hash_field(
            &mut hash,
            "provider_defaults_revision",
            &resolution.revision.to_string(),
        );
        hash_field(
            &mut hash,
            "provider_defaults_fingerprint",
            resolution.fingerprint.as_str(),
        );
        hash_field(
            &mut hash,
            "permission_override",
            resolution
                .permission_override
                .map_or("inherit", ProviderLaunchPermissionOverrideV1::as_str),
        );
    }
    worktree::hash_worktree(&mut hash, &draft.request.worktree);
    if let Some(provider_conversation_ref) = draft.request.provider_conversation_ref.as_option() {
        hash_field(&mut hash, "provider_conversation_intent", "resume");
        hash_field(
            &mut hash,
            "provider_conversation_ref",
            provider_conversation_ref,
        );
    }
    hash_field(
        &mut hash,
        "prompt_digest",
        draft
            .request
            .prompt_digest
            .as_ref()
            .map_or("none", AgentSpawnPromptDigestV1::as_str),
    );
    if let Some(setup_command) = draft.request.setup_command.as_ref() {
        hash_field(&mut hash, "setup_command", setup_command.as_str());
    }
    if let Some(model) = draft.request.model.as_ref() {
        hash_field(&mut hash, "model", model.as_str());
    }
    if let Some(effort) = draft.request.effort.as_ref() {
        hash_field(&mut hash, "effort", effort.as_str());
    }
    if let Some(preference) = draft.request.interaction_preference.as_ref() {
        hash_field(&mut hash, "interaction_preference", preference.as_str());
    }
    hash_field(&mut hash, "agent", draft.agent_id.as_str());
    hash_field(&mut hash, "workspace", draft.workspace_id.as_str());
    match &draft.launch {
        AgentSpawnLaunchPlanV1::NativeCli {
            session_id,
            runtime,
        } => {
            hash_field(&mut hash, "session", session_id);
            hash_field(&mut hash, "runtime", runtime.runtime_kind_id.as_str());
            for capability in &runtime.required_capabilities {
                hash_field(&mut hash, "capability", capability.as_str());
            }
            if !matches!(
                draft.request.execution_profile,
                AgentExecutionProfileV1::ProviderDefault
            ) {
                hash_execution_profile(&mut hash, &draft.request.execution_profile);
            }
        }
        AgentSpawnLaunchPlanV1::StructuredProtocol => {
            hash_field(&mut hash, "interaction_profile", "structured_protocol");
            hash_execution_profile(&mut hash, &draft.request.execution_profile);
        }
    }
    AgentSpawnPlanTokenV1(format!("sha256:{:x}", hash.finalize()))
}

fn hash_field(hash: &mut Sha256, name: &str, value: &str) {
    hash.update((name.len() as u64).to_be_bytes());
    hash.update(name.as_bytes());
    hash.update((value.len() as u64).to_be_bytes());
    hash.update(value.as_bytes());
}

fn validate_event_record(
    event: &AgentSpawnJournalEventV1,
) -> Result<(), AgentSpawnContractErrorV1> {
    if event.sequence < 1 {
        return Err(invalid_stream("journal sequence must be positive"));
    }
    if event.recorded_at_ms < 0 {
        return Err(invalid_stream("journal timestamp must be non-negative"));
    }
    Ok(())
}

fn validate_workspace_lease(
    workspace_id: &WorkspaceIdV1,
    branch: &str,
    lease: &AgentSpawnWorkspaceLeaseV1,
) -> Result<(), AgentSpawnContractErrorV1> {
    let expected_directory = worktree_directory_name(branch);
    if lease.lease_id != format!("workspace-lease:{}", workspace_id.as_str())
        || lease.retirement_id != format!("workspace-retire:{}", workspace_id.as_str())
        || lease.directory_name != expected_directory
        || lease.directory_name.is_empty()
        || lease.directory_name.len() > MAX_WORKTREE_DIRECTORY_BYTES
        || lease.directory_name.contains(['/', '\0'])
        || lease.directory_name == "."
        || lease.directory_name == ".."
    {
        return Err(invalid_stream(
            "workspace lease must match the immutable workspace and branch",
        ));
    }
    Ok(())
}

fn validate_identity(
    field: &'static str,
    value: &str,
    prefix: &str,
) -> Result<(), AgentSpawnContractErrorV1> {
    let Some(hex) = value.strip_prefix(prefix) else {
        return Err(invalid_plan(field, format!("must use the {prefix} prefix")));
    };
    if hex.len() != 32
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid_plan(
            field,
            "must contain 32 lowercase hexadecimal characters",
        ));
    }
    Ok(())
}

fn validate_token(field: &'static str, value: &str) -> Result<(), AgentSpawnContractErrorV1> {
    if !valid_token(value) {
        return Err(invalid_plan(field, "must be a bounded stable token"));
    }
    Ok(())
}

fn validate_stream_token(
    field: &'static str,
    value: &str,
) -> Result<(), AgentSpawnContractErrorV1> {
    if !valid_token(value) {
        return Err(invalid_stream(format!(
            "{field} must be a bounded stable token"
        )));
    }
    Ok(())
}

/// Evidence is prose, not a token: it may contain spaces and punctuation but
/// must stay one bounded line, so a receipt can never grow a log dump or smuggle
/// a newline into a journal record. The producer already collapses whitespace
/// and truncates (claude_sdk_host_supervisor::read_stderr_tail); this is the
/// boundary that makes it true of anything else that tries.
const MAX_ERROR_DETAIL_BYTES: usize = 1024;

fn validate_error_detail(value: &str) -> Result<(), AgentSpawnContractErrorV1> {
    if value.is_empty()
        || value.len() > MAX_ERROR_DETAIL_BYTES
        || value.chars().any(|character| {
            character.is_control() || character == '\u{2028}' || character == '\u{2029}'
        })
    {
        return Err(invalid_stream(
            "errorDetail must be one bounded line of evidence",
        ));
    }
    Ok(())
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TOKEN_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_agent_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_AGENT_NAME_BYTES
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        && value
            .bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn invalid_plan(field: &'static str, reason: impl Into<String>) -> AgentSpawnContractErrorV1 {
    AgentSpawnContractErrorV1::InvalidPlan {
        field,
        reason: reason.into(),
    }
}

fn invalid_stream(reason: impl Into<String>) -> AgentSpawnContractErrorV1 {
    AgentSpawnContractErrorV1::InvalidStream {
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    mod checkout_registration_tests;
    mod destination_tests;

    fn draft() -> AgentSpawnPlanDraftV1 {
        AgentSpawnPlanDraftV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("spawn-1").unwrap(),
            authority: AgentSpawnAuthorityV1 {
                backend_id: "backend-a".into(),
                backend_generation: "generation-1".into(),
                project_id: ProjectIdV1::new("dure").unwrap(),
                root_id: "root_0123456789abcdef0123456789abcdef".into(),
                repository_id: "repo_fedcba9876543210fedcba9876543210".into(),
            },
            request: AgentSpawnPreviewRequestV1 {
                schema_version: 1,
                idempotency_key: "request-1".into(),
                project_id: ProjectIdV1::new("dure").unwrap(),
                provider_id: ProviderIdV1::new("codex").unwrap(),
                execution_profile: AgentExecutionProfileV1::ProviderDefault,
                agent_name: "codex-1".into(),
                worktree: AgentSpawnWorktreePolicyV1::Dedicated {
                    base_commit_sha: "a".repeat(40),
                    branch: "agent/codex-1".into(),
                    branch_mode: Default::default(),
                    checkout_path: None,
                },
                provider_conversation_ref: AgentProviderConversationPlanV1::fresh(),
                permission_mode: AgentSpawnPermissionModeV1::Default,
                prompt_digest: Some(AgentSpawnPromptDigestV1::sha256("secret prompt")),
                setup_command: None,
                model: None,
                effort: None,
                interaction_preference: None,
            },
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            launch: AgentSpawnLaunchPlanV1::NativeCli {
                session_id: "session-1".into(),
                runtime: AgentSpawnRuntimePlanV1 {
                    runtime_kind_id: RuntimeKindIdV1::new("hmux-managed").unwrap(),
                    required_capabilities: vec![
                        CapabilityIdV1::new("provider-launch").unwrap(),
                        CapabilityIdV1::new("session-create").unwrap(),
                    ],
                },
            },
            provider_launch_defaults: None,
        }
    }

    fn native_launch(plan: &AgentSpawnPlanV1) -> (&str, &AgentSpawnRuntimePlanV1) {
        match &plan.launch {
            AgentSpawnLaunchPlanV1::NativeCli {
                session_id,
                runtime,
            } => (session_id, runtime),
            AgentSpawnLaunchPlanV1::StructuredProtocol => panic!("expected native test plan"),
        }
    }

    fn event(
        plan: &AgentSpawnPlanV1,
        sequence: u32,
        body: AgentSpawnJournalEventBodyV1,
    ) -> AgentSpawnJournalEventV1 {
        AgentSpawnJournalEventV1 {
            event_id: OperationEventIdV1::new(format!("spawn-event-{sequence}")).unwrap(),
            operation_id: plan.operation_id.clone(),
            sequence,
            plan_token: plan.plan_token.clone(),
            body,
            recorded_at_ms: i64::from(sequence),
        }
    }

    fn inputs(plan: &AgentSpawnPlanV1, stage: AgentSpawnStageV1) -> AgentSpawnStageInputsV1 {
        match stage {
            AgentSpawnStageV1::Worktree => AgentSpawnStageInputsV1::Worktree {
                workspace_id: plan.workspace_id.clone(),
                project_root_id: plan.authority.root_id.clone(),
                repository_id: plan.authority.repository_id.clone(),
                policy: plan.request.worktree.clone(),
            },
            AgentSpawnStageV1::RuntimeLaunch => AgentSpawnStageInputsV1::RuntimeLaunch {
                agent_id: plan.agent_id.clone(),
                workspace_id: plan.workspace_id.clone(),
                session_id: native_launch(plan).0.into(),
                runtime_kind_id: native_launch(plan).1.runtime_kind_id.clone(),
                provider_id: plan.request.provider_id.clone(),
                provider_conversation_ref: plan.request.provider_conversation_ref.clone(),
                permission_mode: plan.request.permission_mode.clone(),
                setup_command: plan.request.setup_command.clone(),
                model: plan.request.model.clone(),
                effort: plan.request.effort.clone(),
            },
            AgentSpawnStageV1::PromptDelivery => AgentSpawnStageInputsV1::PromptDelivery {
                session_id: native_launch(plan).0.into(),
                prompt_digest: plan.request.prompt_digest.clone().unwrap(),
            },
            AgentSpawnStageV1::StructuredLaunch | AgentSpawnStageV1::StructuredPromptDelivery => {
                panic!("expected native test stage")
            }
        }
    }

    fn evidence(plan: &AgentSpawnPlanV1, stage: AgentSpawnStageV1) -> AgentSpawnStageEvidenceV1 {
        match stage {
            AgentSpawnStageV1::Worktree => {
                let (disposition, lease) = match &plan.request.worktree {
                    AgentSpawnWorktreePolicyV1::Dedicated { branch, .. } => (
                        AgentSpawnStageDispositionV1::CreatedDureOwned,
                        Some(
                            AgentSpawnWorkspaceLeaseV1::for_dedicated(&plan.workspace_id, branch)
                                .unwrap(),
                        ),
                    ),
                    AgentSpawnWorktreePolicyV1::ProjectRoot
                    | AgentSpawnWorktreePolicyV1::ExistingCheckout { .. }
                    | AgentSpawnWorktreePolicyV1::ExistingWorkspace { .. } => {
                        (AgentSpawnStageDispositionV1::AdoptedExisting, None)
                    }
                };
                AgentSpawnStageEvidenceV1::Worktree {
                    workspace_id: plan.workspace_id.clone(),
                    disposition,
                    lease,
                }
            }
            AgentSpawnStageV1::RuntimeLaunch => AgentSpawnStageEvidenceV1::RuntimeLaunch {
                launch_idempotency_key: Some(format!(
                    "spawn-runtime:{}",
                    plan.operation_id.as_str()
                )),
                session: WorkflowSessionGenerationV1 {
                    session_id: native_launch(plan).0.into(),
                    workspace_id: plan.workspace_id.as_str().into(),
                    provider_id: plan.request.provider_id.clone(),
                    runner_principal: "runner-principal-1".into(),
                    runner_instance: "runner-instance-1".into(),
                    channel_epoch: "1".into(),
                    host_instance_id: "host-instance-1".into(),
                    terminal_epoch: "terminal-epoch-1".into(),
                },
                initial_prompt_accepted: false,
            },
            AgentSpawnStageV1::PromptDelivery => AgentSpawnStageEvidenceV1::PromptDelivery {
                session_id: native_launch(plan).0.into(),
                delivery_id: "delivery-1".into(),
            },
            AgentSpawnStageV1::StructuredLaunch | AgentSpawnStageV1::StructuredPromptDelivery => {
                panic!("expected native test stage")
            }
        }
    }

    fn completed_events(plan: &AgentSpawnPlanV1) -> Vec<AgentSpawnJournalEventV1> {
        let mut events = vec![event(
            plan,
            1,
            AgentSpawnJournalEventBodyV1::Planned {
                plan: Box::new(plan.clone()),
            },
        )];
        for stage in planned_stages(plan) {
            let sequence = events.len() as u32 + 1;
            events.push(event(
                plan,
                sequence,
                AgentSpawnJournalEventBodyV1::StagePrepared {
                    attempt: 1,
                    inputs: inputs(plan, stage),
                },
            ));
            events.push(event(
                plan,
                sequence + 1,
                AgentSpawnJournalEventBodyV1::StageCommitted {
                    attempt: 1,
                    evidence: evidence(plan, stage),
                },
            ));
        }
        events
    }

    #[test]
    fn plan_token_is_stable_and_binds_every_authority_and_execution_input() {
        let plan = create_agent_spawn_plan_v1(draft()).unwrap();
        assert_eq!(plan, create_agent_spawn_plan_v1(draft()).unwrap());
        assert_eq!(
            plan.plan_token.as_str(),
            "sha256:86c1d20b95b068995c144845e8412f718a18493528b6d140ede705e6ae681b08"
        );

        let mut variants = Vec::new();
        let mut changed = draft();
        changed.authority.backend_generation = "generation-2".into();
        variants.push(changed);
        let mut changed = draft();
        changed.authority.root_id = "root_1123456789abcdef0123456789abcdef".into();
        variants.push(changed);
        let mut changed = draft();
        changed.authority.repository_id = "repo_eedcba9876543210fedcba9876543210".into();
        variants.push(changed);
        let mut changed = draft();
        changed.request.provider_id = ProviderIdV1::new("claude").unwrap();
        variants.push(changed);
        let mut changed = draft();
        changed.request.permission_mode = AgentSpawnPermissionModeV1::SkipPermissions;
        variants.push(changed);
        let mut changed = draft();
        changed.request.prompt_digest = None;
        variants.push(changed);
        let mut changed = draft();
        changed.request.setup_command =
            Some(WorkflowSessionPrelaunchCommandV1::new("pnpm install").unwrap());
        variants.push(changed);
        let mut changed = draft();
        changed.request.worktree = AgentSpawnWorktreePolicyV1::ProjectRoot;
        variants.push(changed);
        let mut changed = draft();
        changed.agent_id = AgentIdV1::new("agent-2").unwrap();
        variants.push(changed);
        let mut changed = draft();
        changed.workspace_id = WorkspaceIdV1::new("workspace-2").unwrap();
        variants.push(changed);
        let mut changed = draft();
        if let AgentSpawnLaunchPlanV1::NativeCli { session_id, .. } = &mut changed.launch {
            *session_id = "session-2".into();
        }
        variants.push(changed);
        let mut changed = draft();
        if let AgentSpawnLaunchPlanV1::NativeCli { runtime, .. } = &mut changed.launch {
            runtime.runtime_kind_id = RuntimeKindIdV1::new("remote-hmux").unwrap();
        }
        variants.push(changed);
        let mut changed = draft();
        if let AgentSpawnLaunchPlanV1::NativeCli { runtime, .. } = &mut changed.launch {
            runtime.required_capabilities = vec![
                CapabilityIdV1::new("provider-launch").unwrap(),
                CapabilityIdV1::new("session-attach").unwrap(),
            ];
        }
        variants.push(changed);

        for variant in variants {
            assert_ne!(
                create_agent_spawn_plan_v1(variant).unwrap().plan_token,
                plan.plan_token
            );
        }
        let mut tampered = plan.clone();
        if let AgentSpawnLaunchPlanV1::NativeCli { session_id, .. } = &mut tampered.launch {
            *session_id = "session-tampered".into();
        }
        assert!(tampered.validate().is_err());
    }

    #[test]
    fn model_binds_the_plan_token_and_absent_model_preserves_legacy_tokens() {
        let mut selected = draft();
        selected.request.model = Some(AgentSpawnModelSelectionV1::parse("opus").unwrap());
        let absent = create_agent_spawn_plan_v1(draft()).unwrap();
        let selected = create_agent_spawn_plan_v1(selected).unwrap();

        // A plan drafted before this field existed must still recompute to its
        // original token, so an absent model stays out of the hash entirely.
        assert_eq!(
            absent.plan_token.as_str(),
            "sha256:86c1d20b95b068995c144845e8412f718a18493528b6d140ede705e6ae681b08"
        );
        assert_ne!(absent.plan_token, selected.plan_token);

        let document = serde_json::to_value(&absent).unwrap();
        assert!(document["request"].get("model").is_none());
        assert_eq!(
            serde_json::from_value::<AgentSpawnPlanV1>(document).unwrap(),
            absent
        );
        assert_eq!(
            serde_json::to_value(&selected).unwrap()["request"]["model"],
            json!("opus")
        );
    }

    #[test]
    fn exact_conversation_intent_binds_the_plan_token_without_colliding_with_fresh() {
        let fresh = create_agent_spawn_plan_v1(draft()).unwrap();
        let mut resumed = draft();
        resumed.request.provider_conversation_ref =
            AgentProviderConversationPlanV1::resume("fresh").unwrap();
        let resumed = create_agent_spawn_plan_v1(resumed).unwrap();

        assert_ne!(fresh.plan_token, resumed.plan_token);
        assert_eq!(fresh.request.provider_conversation_ref.as_option(), None);
        assert_eq!(
            resumed.request.provider_conversation_ref.as_option(),
            Some("fresh")
        );
    }

    #[test]
    fn model_selection_rejects_invalid_values() {
        assert!(AgentSpawnModelSelectionV1::parse("opus[1m]").is_ok());
        assert!(AgentSpawnModelSelectionV1::parse("gpt-5.2-codex").is_ok());
        assert!(AgentSpawnModelSelectionV1::parse("").is_err());
        assert!(AgentSpawnModelSelectionV1::parse("-bad").is_err());
        assert!(AgentSpawnModelSelectionV1::parse(&"x".repeat(256)).is_ok());
        assert!(AgentSpawnModelSelectionV1::parse(&"x".repeat(257)).is_err());
        assert!(AgentSpawnModelSelectionV1::parse("has space").is_err());
        assert!(serde_json::from_value::<AgentSpawnModelSelectionV1>(json!("has space")).is_err());
    }

    #[test]
    fn effort_binds_the_plan_token_and_absent_effort_preserves_legacy_tokens() {
        let mut selected = draft();
        selected.request.effort = Some(AgentSpawnEffortSelectionV1::parse("xhigh").unwrap());
        let absent = create_agent_spawn_plan_v1(draft()).unwrap();
        let selected = create_agent_spawn_plan_v1(selected).unwrap();

        // Plans drafted before the effort field existed must recompute to
        // their original token, so an absent effort stays out of the hash.
        assert_eq!(
            absent.plan_token.as_str(),
            "sha256:86c1d20b95b068995c144845e8412f718a18493528b6d140ede705e6ae681b08"
        );
        assert_ne!(absent.plan_token, selected.plan_token);

        let document = serde_json::to_value(&absent).unwrap();
        assert!(document["request"].get("effort").is_none());
        assert_eq!(
            serde_json::from_value::<AgentSpawnPlanV1>(document).unwrap(),
            absent
        );
        assert_eq!(
            serde_json::to_value(&selected).unwrap()["request"]["effort"],
            json!("xhigh")
        );
    }

    #[test]
    fn effort_selection_rejects_invalid_values() {
        assert!(AgentSpawnEffortSelectionV1::parse("xhigh").is_ok());
        assert!(AgentSpawnEffortSelectionV1::parse("max").is_ok());
        assert!(AgentSpawnEffortSelectionV1::parse("").is_err());
        assert!(AgentSpawnEffortSelectionV1::parse("-bad").is_err());
        assert!(AgentSpawnEffortSelectionV1::parse(&"x".repeat(65)).is_err());
        assert!(AgentSpawnEffortSelectionV1::parse("has space").is_err());
        assert!(serde_json::from_value::<AgentSpawnEffortSelectionV1>(json!("has space")).is_err());
    }

    #[test]
    fn wire_contract_excludes_prompt_credentials_and_presentation_state() {
        let plan = create_agent_spawn_plan_v1(draft()).unwrap();
        let source = serde_json::to_string(&plan).unwrap();
        assert!(!source.contains("secret prompt"));
        assert!(!source.contains("credential"));
        assert!(!source.contains("pane"));
        assert!(!source.contains("layout"));
        assert!(!source.contains("focus"));

        let mut value = serde_json::to_value(&plan).unwrap();
        value["pane"] = json!({ "id": "forbidden" });
        assert!(serde_json::from_value::<AgentSpawnPlanV1>(value).is_err());

        let mut tampered = serde_json::to_value(&plan).unwrap();
        tampered["sessionId"] = json!("session-tampered");
        assert!(serde_json::from_value::<AgentSpawnPlanV1>(tampered).is_err());
    }

    #[test]
    fn legacy_native_wire_normalizes_without_changing_its_plan_token() {
        let plan = create_agent_spawn_plan_v1(draft()).unwrap();
        let mut legacy = serde_json::to_value(&plan).unwrap();
        let launch = legacy.as_object_mut().unwrap().remove("launch").unwrap();
        legacy["sessionId"] = launch["sessionId"].clone();
        legacy["runtime"] = launch["runtime"].clone();
        legacy["request"]
            .as_object_mut()
            .unwrap()
            .remove("executionProfile");

        let normalized: AgentSpawnPlanV1 = serde_json::from_value(legacy).unwrap();
        assert_eq!(normalized, plan);
        assert_eq!(normalized.plan_token, plan.plan_token);
    }

    #[test]
    fn rejects_git_ref_edge_cases_before_the_plan_can_be_authority() {
        for branch in [
            ".hidden",
            "agent/.hidden",
            "agent/has space",
            "agent/topic.lock",
            "agent/topic~1",
            "agent\\topic",
            "agent//topic",
            "agent/topic..next",
        ] {
            let mut invalid = draft();
            invalid.request.worktree = AgentSpawnWorktreePolicyV1::Dedicated {
                base_commit_sha: "a".repeat(40),
                branch: branch.into(),
                branch_mode: Default::default(),
                checkout_path: None,
            };
            assert!(create_agent_spawn_plan_v1(invalid).is_err(), "{branch}");
        }
    }

    #[test]
    fn setup_is_bounded_and_requires_a_dedicated_workspace() {
        let mut valid = draft();
        valid.request.setup_command =
            Some(WorkflowSessionPrelaunchCommandV1::new("pnpm install").unwrap());
        assert!(create_agent_spawn_plan_v1(valid).is_ok());

        for setup_command in ["", " \t ", "pnpm\u{0}install", "pnpm\u{80}install"] {
            assert!(WorkflowSessionPrelaunchCommandV1::new(setup_command).is_err());
        }

        assert!(WorkflowSessionPrelaunchCommandV1::new("x".repeat(4 * 1024 + 1)).is_err());

        let mut project_root = draft();
        project_root.request.worktree = AgentSpawnWorktreePolicyV1::ProjectRoot;
        project_root.request.setup_command =
            Some(WorkflowSessionPrelaunchCommandV1::new("pnpm install").unwrap());
        assert!(create_agent_spawn_plan_v1(project_root).is_err());
    }

    #[test]
    fn folds_a_complete_spawn_and_requires_an_explicit_terminal_event() {
        let plan = create_agent_spawn_plan_v1(draft()).unwrap();
        let mut events = completed_events(&plan);
        let ready = fold_agent_spawn_journal_v1(&events).unwrap();
        assert_eq!(ready.state, AgentSpawnJournalStateV1::ReadyToSucceed);
        assert_eq!(ready.recovery, AgentSpawnRecoveryDirectiveV1::Finish);
        assert_eq!(ready.completed.len(), 3);

        events.push(event(
            &plan,
            events.len() as u32 + 1,
            AgentSpawnJournalEventBodyV1::Succeeded,
        ));
        let receipt = fold_agent_spawn_journal_v1(&events).unwrap();
        assert_eq!(receipt.state, AgentSpawnJournalStateV1::Succeeded);
        assert_eq!(receipt.recovery, AgentSpawnRecoveryDirectiveV1::None);
    }

    #[test]
    fn committed_workspace_distinguishes_pending_adopted_and_owned() {
        let dedicated = create_agent_spawn_plan_v1(draft()).unwrap();
        let dedicated_events = completed_events(&dedicated);
        let prepared = fold_agent_spawn_journal_v1(&dedicated_events[..2]).unwrap();
        assert_eq!(prepared.committed_workspace_ownership(), None);

        let committed = fold_agent_spawn_journal_v1(&dedicated_events[..3]).unwrap();
        let AgentSpawnCommittedWorkspaceV1::DureOwned {
            workspace_id,
            lease,
        } = committed.committed_workspace_ownership().unwrap()
        else {
            panic!("dedicated worktree must be Dure-owned");
        };
        assert_eq!(workspace_id, &dedicated.workspace_id);
        assert_eq!(
            lease,
            &AgentSpawnWorkspaceLeaseV1::for_dedicated(&dedicated.workspace_id, "agent/codex-1",)
                .unwrap()
        );

        let mut project_root_draft = draft();
        project_root_draft.request.worktree = AgentSpawnWorktreePolicyV1::ProjectRoot;
        let project_root = create_agent_spawn_plan_v1(project_root_draft).unwrap();
        let project_root_events = completed_events(&project_root);
        let committed = fold_agent_spawn_journal_v1(&project_root_events[..3]).unwrap();
        assert_eq!(
            committed.committed_workspace_ownership(),
            Some(AgentSpawnCommittedWorkspaceV1::AdoptedProjectRoot {
                workspace_id: &project_root.workspace_id,
            })
        );
    }

    #[test]
    fn rejects_duplicate_reordered_mismatched_and_post_terminal_events() {
        let plan = create_agent_spawn_plan_v1(draft()).unwrap();
        let mut reordered = completed_events(&plan);
        reordered[2].sequence = 9;
        assert!(fold_agent_spawn_journal_v1(&reordered).is_err());

        let mut duplicate = completed_events(&plan);
        duplicate[2].event_id = duplicate[1].event_id.clone();
        assert!(fold_agent_spawn_journal_v1(&duplicate).is_err());

        let mut mismatched = completed_events(&plan);
        mismatched[1].body = AgentSpawnJournalEventBodyV1::StagePrepared {
            attempt: 1,
            inputs: AgentSpawnStageInputsV1::Worktree {
                workspace_id: plan.workspace_id.clone(),
                project_root_id: "root_1123456789abcdef0123456789abcdef".into(),
                repository_id: plan.authority.repository_id.clone(),
                policy: plan.request.worktree.clone(),
            },
        };
        assert!(fold_agent_spawn_journal_v1(&mismatched).is_err());

        let mut mismatched_lease = completed_events(&plan);
        let AgentSpawnJournalEventBodyV1::StageCommitted {
            evidence: AgentSpawnStageEvidenceV1::Worktree { lease, .. },
            ..
        } = &mut mismatched_lease[2].body
        else {
            unreachable!();
        };
        lease.as_mut().unwrap().directory_name = "another-directory".into();
        assert!(fold_agent_spawn_journal_v1(&mismatched_lease).is_err());

        let mut terminal = completed_events(&plan);
        terminal.push(event(
            &plan,
            terminal.len() as u32 + 1,
            AgentSpawnJournalEventBodyV1::Succeeded,
        ));
        terminal.push(event(
            &plan,
            terminal.len() as u32 + 1,
            AgentSpawnJournalEventBodyV1::Succeeded,
        ));
        assert!(fold_agent_spawn_journal_v1(&terminal).is_err());
    }

    #[test]
    fn runtime_launch_evidence_rejects_mixed_prepared_and_successor_identity() {
        let plan = create_agent_spawn_plan_v1(draft()).unwrap();
        let mut current_with_successor_key = completed_events(&plan);
        let AgentSpawnJournalEventBodyV1::StageCommitted {
            evidence:
                AgentSpawnStageEvidenceV1::RuntimeLaunch {
                    launch_idempotency_key,
                    ..
                },
            ..
        } = &mut current_with_successor_key[4].body
        else {
            unreachable!();
        };
        *launch_idempotency_key = Some("spawn-runtime:successor".into());
        assert!(fold_agent_spawn_journal_v1(&current_with_successor_key).is_err());

        let mut successor_with_root_key = completed_events(&plan);
        let AgentSpawnJournalEventBodyV1::StageCommitted {
            evidence:
                AgentSpawnStageEvidenceV1::RuntimeLaunch {
                    session,
                    launch_idempotency_key,
                    ..
                },
            ..
        } = &mut successor_with_root_key[4].body
        else {
            unreachable!();
        };
        session.session_id = "successor-session".into();
        *launch_idempotency_key = Some(format!("spawn-runtime:{}", plan.operation_id.as_str()));
        assert!(fold_agent_spawn_journal_v1(&successor_with_root_key).is_err());
    }

    #[test]
    fn recovery_never_blindly_replays_an_uncertain_prompt_write() {
        let plan = create_agent_spawn_plan_v1(draft()).unwrap();
        let mut events = completed_events(&plan);
        events.pop();
        let receipt = fold_agent_spawn_journal_v1(&events).unwrap();
        assert_eq!(
            receipt.state,
            AgentSpawnJournalStateV1::PromptDeliveryUncertain
        );
        assert!(matches!(
            receipt.recovery,
            AgentSpawnRecoveryDirectiveV1::DoNotReplayPrompt { attempt: 1, .. }
        ));
    }

    /// A failed stage may carry one line of evidence beside its code, and the
    /// fold must hand it to the receipt: a code alone sent an operator digging
    /// through per-spawn logs the backend had already truncated (2026-08-31).
    /// The code stays a token; the evidence is bounded prose, and a receipt
    /// cannot smuggle a log dump or a newline through it.
    #[test]
    fn a_failed_stage_carries_its_evidence_into_the_receipt() {
        let plan = create_agent_spawn_plan_v1(draft()).unwrap();
        let prefix = vec![
            event(
                &plan,
                1,
                AgentSpawnJournalEventBodyV1::Planned {
                    plan: Box::new(plan.clone()),
                },
            ),
            event(
                &plan,
                2,
                AgentSpawnJournalEventBodyV1::StagePrepared {
                    attempt: 1,
                    inputs: inputs(&plan, AgentSpawnStageV1::Worktree),
                },
            ),
        ];
        let failed = |detail: Option<&str>| {
            let mut events = prefix.clone();
            events.push(event(
                &plan,
                3,
                AgentSpawnJournalEventBodyV1::StageFailed {
                    stage: AgentSpawnStageV1::Worktree,
                    attempt: 1,
                    error_code: "worktree_unavailable".into(),
                    error_detail: detail.map(str::to_owned),
                    may_have_written: None,
                },
            ));
            fold_agent_spawn_journal_v1(&events)
        };

        let receipt = failed(Some("host_exited_before_ready: capability boundary"))
            .expect("evidence is admissible");
        let AgentSpawnRecoveryDirectiveV1::RetryRequired { error_detail, .. } = receipt.recovery
        else {
            panic!("a failed stage must ask for a retry");
        };
        assert_eq!(
            error_detail.as_deref(),
            Some("host_exited_before_ready: capability boundary")
        );

        assert!(
            failed(Some("first line\nsecond line")).is_err(),
            "evidence must stay one line"
        );
        assert!(failed(Some("")).is_err(), "empty evidence is not evidence");
    }

    #[test]
    fn retry_is_explicit_and_increments_the_stage_attempt() {
        let plan = create_agent_spawn_plan_v1(draft()).unwrap();
        let mut events = vec![event(
            &plan,
            1,
            AgentSpawnJournalEventBodyV1::Planned {
                plan: Box::new(plan.clone()),
            },
        )];
        events.push(event(
            &plan,
            2,
            AgentSpawnJournalEventBodyV1::StagePrepared {
                attempt: 1,
                inputs: inputs(&plan, AgentSpawnStageV1::Worktree),
            },
        ));
        events.push(event(
            &plan,
            3,
            AgentSpawnJournalEventBodyV1::StageFailed {
                stage: AgentSpawnStageV1::Worktree,
                attempt: 1,
                error_code: "worktree_unavailable".into(),
                error_detail: None,
                may_have_written: None,
            },
        ));
        assert!(matches!(
            fold_agent_spawn_journal_v1(&events).unwrap().recovery,
            AgentSpawnRecoveryDirectiveV1::RetryRequired {
                failed_attempt: 1,
                ..
            }
        ));
        events.push(event(
            &plan,
            4,
            AgentSpawnJournalEventBodyV1::RetryAuthorized {
                stage: AgentSpawnStageV1::Worktree,
                failed_attempt: 1,
            },
        ));
        events.push(event(
            &plan,
            5,
            AgentSpawnJournalEventBodyV1::StagePrepared {
                attempt: 2,
                inputs: inputs(&plan, AgentSpawnStageV1::Worktree),
            },
        ));
        assert!(matches!(
            fold_agent_spawn_journal_v1(&events).unwrap().recovery,
            AgentSpawnRecoveryDirectiveV1::InspectBeforeRetry { attempt: 2, .. }
        ));
    }

    #[test]
    fn even_an_explicit_retry_cannot_replay_a_failed_prompt_delivery() {
        let plan = create_agent_spawn_plan_v1(draft()).unwrap();
        let mut events = completed_events(&plan);
        events.pop();
        events.push(event(
            &plan,
            events.len() as u32 + 1,
            AgentSpawnJournalEventBodyV1::StageFailed {
                stage: AgentSpawnStageV1::PromptDelivery,
                attempt: 1,
                error_code: "prompt_write_uncertain".into(),
                error_detail: None,
                may_have_written: Some(true),
            },
        ));
        let receipt = fold_agent_spawn_journal_v1(&events).unwrap();
        assert_eq!(
            receipt.state,
            AgentSpawnJournalStateV1::PromptDeliveryUncertain
        );
        events.push(event(
            &plan,
            events.len() as u32 + 1,
            AgentSpawnJournalEventBodyV1::RetryAuthorized {
                stage: AgentSpawnStageV1::PromptDelivery,
                failed_attempt: 1,
            },
        ));
        assert!(fold_agent_spawn_journal_v1(&events).is_err());
    }

    #[test]
    fn legacy_prompt_failure_without_write_certainty_remains_uncertain() {
        let plan = create_agent_spawn_plan_v1(draft()).unwrap();
        let mut body = serde_json::to_value(AgentSpawnJournalEventBodyV1::StageFailed {
            stage: AgentSpawnStageV1::PromptDelivery,
            attempt: 1,
            error_code: "legacy_prompt_failure".into(),
            error_detail: None,
            may_have_written: Some(false),
        })
        .unwrap();
        body.as_object_mut().unwrap().remove("may_have_written");
        let legacy_body = serde_json::from_value(body).unwrap();
        let mut events = completed_events(&plan);
        events.pop();
        events.push(event(&plan, events.len() as u32 + 1, legacy_body));

        let receipt = fold_agent_spawn_journal_v1(&events).unwrap();
        assert_eq!(
            receipt.state,
            AgentSpawnJournalStateV1::PromptDeliveryUncertain
        );
        assert!(matches!(
            receipt.recovery,
            AgentSpawnRecoveryDirectiveV1::DoNotReplayPrompt { .. }
        ));
    }

    #[test]
    fn an_uncertain_destructive_stage_can_only_terminate_for_manual_intervention() {
        let plan = create_agent_spawn_plan_v1(draft()).unwrap();
        let mut uncertain = completed_events(&plan);
        uncertain.pop();
        let mut failed = uncertain.clone();
        failed.push(event(
            &plan,
            failed.len() as u32 + 1,
            AgentSpawnJournalEventBodyV1::Terminated {
                outcome: AgentSpawnTerminalOutcomeV1::Failed,
                error_code: "prompt_delivery_unknown".into(),
            },
        ));
        assert!(fold_agent_spawn_journal_v1(&failed).is_err());

        uncertain.push(event(
            &plan,
            uncertain.len() as u32 + 1,
            AgentSpawnJournalEventBodyV1::Terminated {
                outcome: AgentSpawnTerminalOutcomeV1::ManualInterventionRequired,
                error_code: "prompt_delivery_unknown".into(),
            },
        ));
        assert_eq!(
            fold_agent_spawn_journal_v1(&uncertain).unwrap().state,
            AgentSpawnJournalStateV1::ManualInterventionRequired
        );
    }
}
