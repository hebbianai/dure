use dure_app::{
    AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1, AgentIdV1, DomainStore, ProjectIdV1, ProviderIdV1,
    WorkspaceIdV1,
};
use serde::Serialize;

use crate::ServiceState;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRuntimeProjectionContextV1 {
    schema_version: u16,
    identity: AgentRuntimeProjectionIdentityV1,
    agent: AgentRuntimeProjectionAgentV1,
    workspace: AgentRuntimeProjectionWorkspaceV1,
    project: AgentRuntimeProjectionProjectV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AgentRuntimeProjectionIdentityV1 {
    Registered,
    CheckpointBootstrap {
        #[serde(rename = "runtimeWorkspaceId")]
        runtime_workspace_id: WorkspaceIdV1,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRuntimeProjectionAgentV1 {
    agent_id: AgentIdV1,
    workspace_id: WorkspaceIdV1,
    provider_id: ProviderIdV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRuntimeProjectionWorkspaceV1 {
    workspace_id: WorkspaceIdV1,
    project_id: ProjectIdV1,
    root_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRuntimeProjectionProjectV1 {
    project_id: ProjectIdV1,
    root_path: String,
}

pub(crate) async fn read(
    state: &ServiceState,
    agent_id: &AgentIdV1,
    provider_id: &ProviderIdV1,
) -> Result<AgentRuntimeProjectionContextV1, String> {
    let context = read_agent(state, agent_id).await?;
    if context.agent.provider_id != *provider_id {
        return Err("agent_runtime_projection_identity_mismatch".into());
    }
    Ok(context)
}

pub(crate) async fn read_agent(
    state: &ServiceState,
    agent_id: &AgentIdV1,
) -> Result<AgentRuntimeProjectionContextV1, String> {
    let agent = state
        .store
        .agent(agent_id)
        .await
        .map_err(|_| "agent_runtime_projection_identity_read_failed")?
        .ok_or("agent_runtime_projection_identity_unavailable")?;
    let workspace = state
        .store
        .workspace(&agent.workspace_id)
        .await
        .map_err(|_| "agent_runtime_projection_identity_read_failed")?
        .ok_or("agent_runtime_projection_identity_unavailable")?;
    let project = state
        .store
        .project(&workspace.project_id)
        .await
        .map_err(|_| "agent_runtime_projection_identity_read_failed")?
        .ok_or("agent_runtime_projection_identity_unavailable")?;

    let identity = match dure_app::agent_bootstrap_runtime_workspace(
        &agent.agent_id,
        &workspace.workspace_id,
        &project.project_id,
    )
    .map_err(|_| "agent_runtime_projection_identity_mismatch")?
    {
        Some(runtime_workspace_id) => AgentRuntimeProjectionIdentityV1::CheckpointBootstrap {
            runtime_workspace_id,
        },
        None => AgentRuntimeProjectionIdentityV1::Registered,
    };

    Ok(AgentRuntimeProjectionContextV1 {
        schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
        identity,
        agent: AgentRuntimeProjectionAgentV1 {
            agent_id: agent.agent_id,
            workspace_id: agent.workspace_id,
            provider_id: agent.provider_id,
        },
        workspace: AgentRuntimeProjectionWorkspaceV1 {
            workspace_id: workspace.workspace_id,
            project_id: workspace.project_id,
            root_path: workspace.root_path,
        },
        project: AgentRuntimeProjectionProjectV1 {
            project_id: project.project_id,
            root_path: project.root_path,
        },
    })
}
