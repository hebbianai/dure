use dure_app::{
    AgentBootstrapV1, AgentRecordV1, DomainStoreErrorV1, ProjectRecordV1, WorkspaceRecordV1,
    agent_bootstrap_project_id, agent_bootstrap_workspace_id,
};
use sqlx::SqliteConnection;

use crate::error::{identity_conflict, map_sqlx};
use crate::{SqliteDomainStore, records};

#[cfg(test)]
mod tests;

impl SqliteDomainStore {
    /// Compatibility adoption and fresh Agent registration share this policy.
    /// Failed publication rolls back its parents; no runtime is manufactured.
    pub async fn ensure_agent_identity(
        &self,
        request: &AgentBootstrapV1,
        timestamp: i64,
    ) -> Result<(), DomainStoreErrorV1> {
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| map_sqlx("bootstrap_agent", error))?;
        ensure_on(&mut transaction, request, timestamp).await?;
        transaction
            .commit()
            .await
            .map_err(|error| map_sqlx("bootstrap_agent", error))
    }
}

pub(crate) async fn ensure_on(
    connection: &mut SqliteConnection,
    request: &AgentBootstrapV1,
    timestamp: i64,
) -> Result<(), DomainStoreErrorV1> {
    let existing = records::agent(&mut *connection, &request.agent_id).await?;
    let workspace_id = if let Some(agent) = &existing {
        if agent.provider_id != request.provider_id {
            return Err(identity_conflict(
                "agent provider",
                request.agent_id.as_str(),
                "provider identity changed",
            ));
        }
        let workspace = records::workspace_on(connection, &agent.workspace_id)
            .await?
            .ok_or_else(|| DomainStoreErrorV1::NotFound {
                entity: "workspace",
                id: agent.workspace_id.to_string(),
            })?;
        if std::path::Path::new(&workspace.root_path)
            != std::path::Path::new(&request.working_directory)
        {
            return Err(identity_conflict(
                "agent workspace",
                request.agent_id.as_str(),
                "working directory changed",
            ));
        }
        agent.workspace_id.clone()
    } else {
        let project_id = agent_bootstrap_project_id(request.runtime_workspace_id.as_str())?;
        let workspace_id = agent_bootstrap_workspace_id(&request.agent_id)?;
        let project = records::project(&mut *connection, &project_id).await?;
        // A bootstrap project describes the first pane; later Agents may each
        // have their own checkout. Preserve that registered project verbatim.
        if project.is_none() {
            records::upsert_project(
                &mut *connection,
                &ProjectRecordV1 {
                    project_id: project_id.clone(),
                    root_path: request.working_directory.clone(),
                    display_name: request.runtime_workspace_id.to_string(),
                    created_at_ms: timestamp,
                    updated_at_ms: timestamp,
                },
            )
            .await?;
        }
        let workspace = records::workspace_on(connection, &workspace_id).await?;
        records::upsert_workspace(
            &mut *connection,
            &WorkspaceRecordV1 {
                workspace_id: workspace_id.clone(),
                project_id,
                root_path: request.working_directory.clone(),
                base_commit_sha: workspace
                    .as_ref()
                    .and_then(|record| record.base_commit_sha.clone()),
                created_at_ms: workspace
                    .as_ref()
                    .map_or(timestamp, |record| record.created_at_ms),
                updated_at_ms: timestamp,
            },
        )
        .await?;
        workspace_id
    };
    records::upsert_agent(
        &mut *connection,
        &AgentRecordV1 {
            agent_id: request.agent_id.clone(),
            workspace_id,
            provider_id: request.provider_id.clone(),
            display_name: request.display_name.clone(),
            created_at_ms: existing
                .as_ref()
                .map_or(timestamp, |record| record.created_at_ms),
            updated_at_ms: timestamp,
        },
    )
    .await
}
