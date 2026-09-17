use super::*;
use dure_app::{GitCheckoutCaptureRequestV1, GitCheckoutReferenceV1};

/// Normalize a selection once. Subsequent claims use the frozen incarnation,
/// not mutable HEAD or branch values that may legitimately advance during work.
pub(crate) async fn capture_existing_checkout(
    project_root: &Path,
    reference: GitCheckoutReferenceV1,
) -> Result<AgentSpawnWorktreePolicyV1, String> {
    let capture = GitCheckoutCaptureRequestV1 {
        repository_path: project_root.to_string_lossy().into_owned(),
        checkout_path: reference.canonical_path.clone(),
    };
    let instance = tokio::task::spawn_blocking(move || {
        dure_git_checkout::capture_git_checkout_instance(&capture)
    })
    .await
    .map_err(|_| "workspace_claim_unavailable".to_string())?
    .map_err(|error| error.code.to_string())?;
    let entry = list_worktrees(project_root)
        .await
        .map_err(|error| error.code)?
        .into_iter()
        .find(|entry| entry.path == Path::new(&instance.canonical_path))
        .ok_or_else(|| "worktree_not_registered".to_string())?;
    let branch = entry
        .branch_ref
        .as_deref()
        .and_then(|branch| branch.strip_prefix("refs/heads/"))
        .unwrap_or("(detached)");
    if instance.canonical_path != reference.canonical_path
        || instance.git_common_dir != reference.git_common_dir
        || instance.git_dir != reference.git_dir
        || branch != reference.branch
        || entry.head != reference.head
    {
        return Err("worktree_identity_changed".into());
    }
    Ok(AgentSpawnWorktreePolicyV1::ExistingCheckout {
        instance,
        branch: reference.branch,
        base_commit_sha: reference.head,
    })
}
