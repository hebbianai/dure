use super::*;
use dure_app::{AgentSpawnBranchModeV1, AgentSpawnJournalStore, GitCheckoutReferenceV1};

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum AgentSpawnPreviewWorktree {
    ProjectRoot,
    Dedicated {
        #[serde(default, deserialize_with = "deserialize_optional_string")]
        base_commit_sha: Option<String>,
        branch: String,
        #[serde(default)]
        branch_mode: AgentSpawnBranchModeV1,
        #[serde(default, deserialize_with = "deserialize_optional_string")]
        checkout_path: Option<String>,
    },
    ExistingWorkspace {
        source_agent_id: AgentIdV1,
        workspace_id: WorkspaceIdV1,
    },
    ExistingCheckout {
        reference: GitCheckoutReferenceV1,
    },
}

fn deserialize_optional_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

pub(super) async fn normalize_agent_spawn_worktree(
    state: &ServiceState,
    project: &project_catalog::ProjectAuthority,
    idempotency_key: &str,
    worktree: AgentSpawnPreviewWorktree,
) -> Result<AgentSpawnWorktreePolicyV1, String> {
    match worktree {
        AgentSpawnPreviewWorktree::ProjectRoot => Ok(AgentSpawnWorktreePolicyV1::ProjectRoot),
        AgentSpawnPreviewWorktree::ExistingCheckout { reference } => {
            // Recover the admitted observation from the same durable journal.
            // Re-observing Git here would reject ordinary edits on a retry or
            // silently select a new incarnation at the same path.
            if let Some(receipt) = state
                .store
                .agent_spawn_receipt_by_idempotency_key(idempotency_key)
                .await
                .map_err(agent_spawn_support::store_error)?
            {
                let policy = receipt.plan.request.worktree;
                if let AgentSpawnWorktreePolicyV1::ExistingCheckout {
                    instance,
                    branch,
                    base_commit_sha,
                } = &policy
                    && reference.canonical_path == instance.canonical_path
                    && reference.git_common_dir == instance.git_common_dir
                    && reference.git_dir == instance.git_dir
                    && reference.branch == *branch
                    && reference.head == *base_commit_sha
                {
                    return Ok(policy);
                }
                return Err("agent_spawn_idempotency_conflict".into());
            }
            workspace_git::capture_existing_checkout(project.root(), reference).await
        }
        AgentSpawnPreviewWorktree::Dedicated {
            base_commit_sha,
            branch,
            branch_mode,
            checkout_path,
        } => {
            let base_commit_sha = match base_commit_sha {
                Some(base_commit_sha) => base_commit_sha,
                None => match branch_mode {
                    AgentSpawnBranchModeV1::Create => {
                        workspace_git::resolve_base_commit(project.root(), None).await?
                    }
                    AgentSpawnBranchModeV1::Existing => {
                        workspace_git::resolve_branch_base(project.root(), &branch).await?
                    }
                },
            };
            Ok(AgentSpawnWorktreePolicyV1::Dedicated {
                base_commit_sha,
                branch,
                branch_mode,
                checkout_path,
            })
        }
        AgentSpawnPreviewWorktree::ExistingWorkspace {
            source_agent_id,
            workspace_id,
        } => {
            let source_agent = state
                .store
                .agent(&source_agent_id)
                .await
                .map_err(|_| "agent_spawn_source_authority_unavailable".to_string())?
                .ok_or_else(|| "agent_spawn_source_authority_unavailable".to_string())?;
            let workspace = state
                .store
                .workspace(&workspace_id)
                .await
                .map_err(|_| "agent_spawn_source_authority_unavailable".to_string())?
                .ok_or_else(|| "agent_spawn_source_authority_unavailable".to_string())?;
            let (runtime_selection, runtime_binding) =
                match agent_runtime_projection::read_locked(state, &source_agent_id).await? {
                    agent_runtime_projection::AgentRuntimeObservedV1::Stable {
                        selection,
                        authority,
                    } => (*selection, *authority),
                    _ => return Err("agent_spawn_source_runtime_unstable".into()),
                };
            if source_agent.workspace_id != workspace_id
                || workspace.project_id.as_str() != project.projection().id
            {
                return Err("agent_spawn_source_authority_mismatch".into());
            }
            let source = agent_spawn_api::existing_workspace_authority(
                &source_agent,
                &workspace,
                &runtime_selection,
                &runtime_binding,
            )?;
            Ok(AgentSpawnWorktreePolicyV1::ExistingWorkspace {
                source: Box::new(source),
            })
        }
    }
}
