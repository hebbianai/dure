//! Compatibility identity for Agents first seen through a native pane or
//! registration request. Existing registered backend identities remain owners.

use crate::{AgentIdV1, DomainStoreErrorV1, ProjectIdV1, ProviderIdV1, WorkspaceIdV1};
use serde::{Deserialize, Serialize};

const PROJECT_PREFIX: &str = "hmux-project:";
const WORKSPACE_PREFIX: &str = "agent-workspace:";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentBootstrapV1 {
    pub agent_id: AgentIdV1,
    pub runtime_workspace_id: WorkspaceIdV1,
    pub provider_id: ProviderIdV1,
    pub working_directory: String,
    pub display_name: String,
}

pub fn agent_bootstrap_project_id(
    runtime_workspace_id: &str,
) -> Result<ProjectIdV1, DomainStoreErrorV1> {
    ProjectIdV1::new(format!("{PROJECT_PREFIX}{runtime_workspace_id}")).map_err(invalid)
}

pub fn agent_bootstrap_workspace_id(
    agent_id: &AgentIdV1,
) -> Result<WorkspaceIdV1, DomainStoreErrorV1> {
    WorkspaceIdV1::new(format!("{WORKSPACE_PREFIX}{agent_id}")).map_err(invalid)
}

pub fn agent_bootstrap_runtime_workspace(
    agent_id: &AgentIdV1,
    workspace_id: &WorkspaceIdV1,
    project_id: &ProjectIdV1,
) -> Result<Option<WorkspaceIdV1>, DomainStoreErrorV1> {
    if workspace_id != &agent_bootstrap_workspace_id(agent_id)? {
        return Ok(None);
    }
    let runtime_workspace_id = project_id
        .as_str()
        .strip_prefix(PROJECT_PREFIX)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("invalid bootstrap project"))?;
    WorkspaceIdV1::new(runtime_workspace_id)
        .map(Some)
        .map_err(invalid)
}

fn invalid(error: impl std::fmt::Display) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::InvalidRecord {
        field: "agentBootstrap",
        reason: error.to_string(),
    }
}
