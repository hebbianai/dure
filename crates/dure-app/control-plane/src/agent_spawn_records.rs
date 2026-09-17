use std::path::Path;

use dure_app::{
    AgentRecordV1, AgentSpawnJournalReceiptV1, AgentSpawnWorktreePolicyV1, DomainStore,
    ProjectRecordV1, WorkspaceRecordV1,
};
use dure_app_sqlite::SqliteDomainStore;

use crate::agent_spawn_support::store_error;

/// Prepare the durable ownership chain before either runtime can launch.
/// Retrying a launch repeats these upserts, including receipts from older
/// backends that launched a provider before recording its project.
pub(crate) async fn prepare(
    store: &SqliteDomainStore,
    receipt: &AgentSpawnJournalReceiptV1,
    project_root: &Path,
    project_display_name: &str,
    workspace_root: &str,
    observed_at_ms: i64,
) -> Result<(), String> {
    let project_id = &receipt.plan.authority.project_id;
    let existing_project = store.project(project_id).await.map_err(store_error)?;
    let project_root = project_root
        .to_str()
        .ok_or_else(|| "agent_spawn_project_path_invalid".to_string())?;
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: project_root.into(),
            display_name: project_display_name.into(),
            created_at_ms: existing_project
                .as_ref()
                .map_or(receipt.created_at_ms, |project| project.created_at_ms),
            updated_at_ms: observed_at_ms,
        })
        .await
        .map_err(store_error)?;
    let base_commit_sha = match &receipt.plan.request.worktree {
        AgentSpawnWorktreePolicyV1::ProjectRoot => None,
        AgentSpawnWorktreePolicyV1::Dedicated {
            base_commit_sha, ..
        }
        | AgentSpawnWorktreePolicyV1::ExistingCheckout {
            base_commit_sha, ..
        } => Some(base_commit_sha.clone()),
        AgentSpawnWorktreePolicyV1::ExistingWorkspace { .. } => {
            return persist_agent(store, receipt, observed_at_ms).await;
        }
    };
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: receipt.plan.workspace_id.clone(),
            project_id: project_id.clone(),
            root_path: workspace_root.into(),
            base_commit_sha,
            created_at_ms: receipt.created_at_ms,
            updated_at_ms: observed_at_ms,
        })
        .await
        .map_err(store_error)?;
    persist_agent(store, receipt, observed_at_ms).await
}

async fn persist_agent(
    store: &SqliteDomainStore,
    receipt: &AgentSpawnJournalReceiptV1,
    observed_at_ms: i64,
) -> Result<(), String> {
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: receipt.plan.agent_id.clone(),
            workspace_id: receipt.plan.workspace_id.clone(),
            provider_id: receipt.plan.request.provider_id.clone(),
            display_name: receipt.plan.request.agent_name.clone(),
            created_at_ms: receipt.created_at_ms,
            updated_at_ms: observed_at_ms,
        })
        .await
        .map_err(store_error)
}
