use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentExecutionProfileV1, AgentInteractionBindingV1,
    AgentInteractionProfileV1, AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1,
    AgentRecordV1, AgentRuntimeSelectionV1, AgentSpawnEffortSelectionV1,
    AgentSpawnModelSelectionV1, AgentTimelineEpochV1, ProviderPermissionModeV1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{CLAUDE_PROVIDER_ID, ClaudeStructuredLaunchReceiptV1, ClaudeStructuredRuntimeErrorV1};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClaudeConversationOpenBodyV1 {
    pub schema_version: u16,
    pub agent_id: dure_app::AgentIdV1,
    pub execution_profile: AgentExecutionProfileV1,
    #[serde(default)]
    pub provider_conversation_ref: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ClaudeStructuredOpenRequestV1 {
    pub agent_id: dure_app::AgentIdV1,
    pub execution_profile: AgentExecutionProfileV1,
    pub provider_conversation_ref: Option<String>,
    pub permission_mode: ProviderPermissionModeV1,
    pub model: Option<AgentSpawnModelSelectionV1>,
    pub effort: Option<AgentSpawnEffortSelectionV1>,
}

impl ClaudeStructuredOpenRequestV1 {
    pub(crate) fn from_committed_or_legacy(
        agent_id: dure_app::AgentIdV1,
        execution_profile: AgentExecutionProfileV1,
        provider_conversation_ref: Option<String>,
        selection: Option<&AgentRuntimeSelectionV1>,
    ) -> Result<Self, ClaudeStructuredRuntimeErrorV1> {
        let (permission_mode, model, effort) = match selection {
            None => (ProviderPermissionModeV1::Default, None, None),
            Some(selection) => {
                selection
                    .validate()
                    .map_err(|_| ClaudeStructuredRuntimeErrorV1::RuntimeConflict)?;
                if selection.agent_id != agent_id
                    || selection.provider_id.as_str() != CLAUDE_PROVIDER_ID
                    || selection.interaction_profile
                        != AgentInteractionProfileV1::StructuredProtocol
                    || selection.execution_profile != execution_profile
                {
                    return Err(ClaudeStructuredRuntimeErrorV1::RuntimeConflict);
                }
                (
                    selection.permission_mode.clone(),
                    selection.model.clone(),
                    selection.effort.clone(),
                )
            }
        };
        Ok(Self {
            agent_id,
            execution_profile,
            provider_conversation_ref,
            permission_mode,
            model,
            effort,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStructuredOpenReceiptV1 {
    pub schema_version: u16,
    pub binding: AgentInteractionBindingV1,
    pub launch: ClaudeStructuredLaunchReceiptV1,
}

pub(super) fn initial_binding(
    agent: &AgentRecordV1,
    request: &ClaudeStructuredOpenRequestV1,
    backend_generation: &str,
) -> Result<AgentInteractionBindingV1, ClaudeStructuredRuntimeErrorV1> {
    if agent.agent_id != request.agent_id || agent.provider_id.as_str() != CLAUDE_PROVIDER_ID {
        return Err(ClaudeStructuredRuntimeErrorV1::RequestInvalid);
    }
    request
        .execution_profile
        .validate()
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
    let execution_profile = serde_json::to_vec(&request.execution_profile)
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
    let digest = binding_digest(
        agent.agent_id.as_str(),
        backend_generation,
        &execution_profile,
        request.provider_conversation_ref.as_deref(),
    );
    let binding = AgentInteractionBindingV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: AgentInteractionSessionIdV1::new(format!(
            "claude-chat-{}",
            scoped_token("interaction", &digest)
        ))
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?,
        agent_id: agent.agent_id.clone(),
        provider_id: agent.provider_id.clone(),
        execution_profile: request.execution_profile.clone(),
        provider_conversation_ref: request.provider_conversation_ref.clone(),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: format!("claude-runtime-{}", scoped_token("runtime", &digest)),
            provider_epoch: format!("claude-query-{}", scoped_token("query", &digest)),
        },
        timeline_epoch: AgentTimelineEpochV1::new(format!(
            "claude-timeline-{}",
            scoped_token("timeline", &digest)
        ))
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?,
        binding_revision: 1,
        history_complete: request.provider_conversation_ref.is_none(),
        created_at_ms: agent.created_at_ms,
        updated_at_ms: agent.created_at_ms,
    };
    binding
        .validate()
        .map_err(|_| ClaudeStructuredRuntimeErrorV1::RequestInvalid)?;
    Ok(binding)
}

fn binding_digest(
    agent_id: &str,
    backend_generation: &str,
    execution_profile: &[u8],
    provider_conversation_ref: Option<&str>,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"claude-structured-open/v1\0");
    update_field(&mut digest, agent_id.as_bytes());
    update_field(&mut digest, backend_generation.as_bytes());
    update_field(&mut digest, execution_profile);
    update_field(
        &mut digest,
        provider_conversation_ref.unwrap_or_default().as_bytes(),
    );
    format!("{:x}", digest.finalize())
}

fn update_field(digest: &mut Sha256, value: &[u8]) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value);
}

fn scoped_token(scope: &str, seed: &str) -> String {
    let digest =
        Sha256::digest(format!("claude-structured-open-token/v1\0{scope}\0{seed}").as_bytes());
    format!("{digest:x}")[..24].into()
}
