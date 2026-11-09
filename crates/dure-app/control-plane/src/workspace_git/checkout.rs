use super::*;
use dure_git_checkout::{
    AdmittedGitCheckoutCreation, GitCheckoutCreationOperation, GitCheckoutUseError,
};

pub(super) async fn acquire_workspace(
    request: WorkspaceAcquireRequest,
    creation_owners: Option<&dyn CreationOwnerLedger>,
) -> Result<WorkspaceHandle, WorkspaceFailure> {
    // A frozen registration identifies an existing checkout incarnation.
    // Resolving it can claim that checkout, but cannot create another.
    if request.registration.is_some() {
        return resolve_workspace(request).await;
    }
    let (base_commit_sha, branch, branch_mode, checkout_path) = match &request.policy {
        AgentSpawnWorktreePolicyV1::Dedicated {
            base_commit_sha,
            branch,
            branch_mode,
            checkout_path,
        } => (
            base_commit_sha,
            branch,
            branch_mode,
            checkout_path.as_deref(),
        ),
        AgentSpawnWorktreePolicyV1::ProjectRoot => {
            return Ok(project_root_handle(request.project_root));
        }
        AgentSpawnWorktreePolicyV1::ExistingCheckout { instance, .. } => {
            return Ok(project_root_handle(PathBuf::from(&instance.canonical_path)));
        }
        AgentSpawnWorktreePolicyV1::ExistingWorkspace { source } => {
            return Ok(project_root_handle(
                std::fs::canonicalize(&source.workspace_root)
                    .map_err(|_| WorkspaceFailure::new("workspace_root_unavailable"))?,
            ));
        }
    };

    validate_branch(&request.project_root, branch).await?;
    resolve_base_commit(&request.project_root, Some(base_commit_sha))
        .await
        .map_err(|_| WorkspaceFailure::new("workspace_base_commit_changed"))?;
    let lease = AgentSpawnWorkspaceLeaseV1::for_dedicated(&request.workspace_id, branch)
        .map_err(|_| WorkspaceFailure::new("workspace_lease_invalid"))?;
    let target =
        prepare_workspace_destination(&request.project_root, &lease.directory_name, checkout_path)?;
    let creation = {
        let repository = request.project_root.clone();
        let target = target.clone();
        let registration_id = request.registration_id.clone();
        let mut inputs = vec![
            base_commit_sha.clone(),
            branch.clone(),
            lease_ref(&request.workspace_id),
        ];
        if *branch_mode == AgentSpawnBranchModeV1::Existing {
            inputs.push("existing".into());
        }
        tokio::task::spawn_blocking(move || {
            dure_git_checkout::prepare_git_checkout_creation(
                &repository,
                &target,
                &registration_id,
                &inputs.iter().map(String::as_str).collect::<Vec<_>>(),
            )
        })
        .await
        .map_err(|_| WorkspaceFailure::new("workspace_claim_unavailable"))?
        .map_err(|error| WorkspaceFailure::with_detail(error.code, &error.message))?
    };
    // No creation permission means another generation owns the path. Only a
    // workspace that already published its lease may resolve that checkout;
    // a fresh workspace has collided with a foreign owner.
    let Some(creation) = creation else {
        if read_ref(&request.project_root, &lease_ref(&request.workspace_id))
            .await?
            .is_none()
        {
            return Err(WorkspaceFailure::new("workspace_identity_conflict"));
        }
        return resolve_workspace(request).await;
    };
    let plan = match prepare_checkout(&request, &target, &lease).await {
        Ok(plan) => plan,
        Err(failure) => {
            return Err(roll_back_creation(move || creation.abort(), &request, failure).await);
        }
    };
    let creation = retire_finished_creation_owner(creation, creation_owners).await?;
    let creation = tokio::task::spawn_blocking(move || creation.admit())
        .await
        .map_err(|_| WorkspaceFailure::new("workspace_claim_unavailable"))?
        .map_err(|error| WorkspaceFailure::with_detail(error.code, &error.message))?;
    let handle = match materialize_workspace(plan, &request, &target, &lease, &creation).await {
        Ok(handle) => handle,
        Err(failure) => {
            return Err(
                roll_back_creation(move || creation.abort_if_absent(), &request, failure).await,
            );
        }
    };
    tokio::task::spawn_blocking(move || creation.activate())
        .await
        .map_err(|_| WorkspaceFailure::new("workspace_claim_unavailable"))?
        .map_err(|error| WorkspaceFailure::with_detail(error.code, &error.message))?;
    Ok(handle)
}

/// A creator can die, or have its abort refused over a partial directory,
/// leaving a reservation only its own operation could retire. `creation` holds
/// the execution lease throughout, so no writer of that reservation remains
/// while the ledger is asked whether its operation has ended.
async fn retire_finished_creation_owner(
    creation: GitCheckoutCreationOperation,
    creation_owners: Option<&dyn CreationOwnerLedger>,
) -> Result<GitCheckoutCreationOperation, WorkspaceFailure> {
    let Some(creation_owners) = creation_owners else {
        return Ok(creation);
    };
    let (creation, owner) = tokio::task::spawn_blocking(move || {
        let owner = creation.retirable_owner();
        (creation, owner)
    })
    .await
    .map_err(|_| WorkspaceFailure::new("workspace_claim_unavailable"))?;
    let owner = owner.map_err(|error| WorkspaceFailure::with_detail(error.code, &error.message))?;
    let Some(owner) = owner else {
        return Ok(creation);
    };
    if !creation_owners.has_finished(&owner).await {
        return Ok(creation);
    }
    tokio::task::spawn_blocking(move || creation.retire_finished_owner(&owner).map(|_| creation))
        .await
        .map_err(|_| WorkspaceFailure::new("workspace_claim_unavailable"))?
        .map_err(|error| WorkspaceFailure::with_detail(error.code, &error.message))
}

/// Retire a failed creator without letting its cleanup hide why it failed.
/// Returns that failure and whether an interrupted checkout was discarded.
async fn retire_creation(
    retire: impl FnOnce() -> Result<bool, GitCheckoutUseError> + Send + 'static,
    failure: WorkspaceFailure,
) -> (WorkspaceFailure, bool) {
    match tokio::task::spawn_blocking(retire).await {
        Ok(Ok(discarded)) => (failure, discarded),
        Ok(Err(error)) => (
            failure.with_cleanup_problem(&format!("{}: {}", error.code, error.message)),
            false,
        ),
        Err(_) => (
            failure.with_cleanup_problem("workspace_claim_unavailable"),
            false,
        ),
    }
}

/// A checkout Git was killed while creating takes the refs it needed with it,
/// which leaves its worktree name free for the next Run.
async fn roll_back_creation(
    retire: impl FnOnce() -> Result<bool, GitCheckoutUseError> + Send + 'static,
    request: &WorkspaceAcquireRequest,
    failure: WorkspaceFailure,
) -> WorkspaceFailure {
    let (failure, discarded) = retire_creation(retire, failure).await;
    if !discarded {
        return failure;
    }
    match release_ownership_refs(request).await {
        Ok(()) => failure,
        Err(problem) => {
            failure.with_cleanup_problem(problem.detail.as_deref().unwrap_or(&problem.code))
        }
    }
}

/// Each delete compares against the launch commit, so a branch that moved
/// stays, and a branch the Run adopted was never this attempt's to remove.
async fn release_ownership_refs(request: &WorkspaceAcquireRequest) -> Result<(), WorkspaceFailure> {
    let AgentSpawnWorktreePolicyV1::Dedicated {
        base_commit_sha,
        branch,
        branch_mode,
        ..
    } = &request.policy
    else {
        return Err(WorkspaceFailure::new("workspace_policy_invalid"));
    };
    let lease_ref = lease_ref(&request.workspace_id);
    let branch_delete = match branch_mode {
        AgentSpawnBranchModeV1::Create => {
            format!("delete refs/heads/{branch} {base_commit_sha}\n")
        }
        AgentSpawnBranchModeV1::Existing => String::new(),
    };
    let transaction =
        format!("start\ndelete {lease_ref} {base_commit_sha}\n{branch_delete}prepare\ncommit\n");
    let output = git_output(
        &request.project_root,
        ["update-ref", "--stdin"],
        Some(transaction.as_bytes()),
    )
    .await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(WorkspaceFailure::with_detail(
            "workspace_ref_release_failed",
            &String::from_utf8_lossy(&output.stderr),
        ))
    }
}

enum CheckoutPlan {
    Adopt(Box<WorkspaceHandle>),
    CheckoutOwnedBranch,
    PublishOwnership,
}

async fn prepare_checkout(
    request: &WorkspaceAcquireRequest,
    target: &Path,
    lease: &AgentSpawnWorkspaceLeaseV1,
) -> Result<CheckoutPlan, WorkspaceFailure> {
    let AgentSpawnWorktreePolicyV1::Dedicated {
        base_commit_sha,
        branch,
        branch_mode,
        ..
    } = &request.policy
    else {
        return Err(WorkspaceFailure::new("workspace_policy_invalid"));
    };
    let lease_ref = lease_ref(&request.workspace_id);
    let branch_ref = format!("refs/heads/{branch}");
    let current_lease = read_ref(&request.project_root, &lease_ref).await?;

    if let Some(current) = current_lease.as_deref() {
        if current != base_commit_sha {
            return Err(WorkspaceFailure::new("workspace_lease_identity_mismatch"));
        }
        return Ok(
            match inspect_owned_checkout(
                &request.project_root,
                target,
                lease,
                &branch_ref,
                Some(base_commit_sha),
            )
            .await?
            {
                Some(handle) => CheckoutPlan::Adopt(Box::new(handle)),
                None => CheckoutPlan::CheckoutOwnedBranch,
            },
        );
    }
    let current_branch = read_ref(&request.project_root, &branch_ref).await?;
    let entries = list_worktrees(&request.project_root).await?;
    let branch_matches = match branch_mode {
        AgentSpawnBranchModeV1::Create => current_branch.is_none(),
        AgentSpawnBranchModeV1::Existing => current_branch.as_deref() == Some(base_commit_sha),
    };
    if !branch_matches
        || entries.iter().any(|entry| entry.path == target)
        || entries
            .iter()
            .any(|entry| entry.branch_ref.as_deref() == Some(branch_ref.as_str()))
        || target.exists()
    {
        return Err(WorkspaceFailure::new("workspace_identity_conflict"));
    }

    Ok(CheckoutPlan::PublishOwnership)
}

async fn materialize_workspace(
    plan: CheckoutPlan,
    request: &WorkspaceAcquireRequest,
    target: &Path,
    lease: &AgentSpawnWorkspaceLeaseV1,
    creation: &AdmittedGitCheckoutCreation,
) -> Result<WorkspaceHandle, WorkspaceFailure> {
    match plan {
        CheckoutPlan::Adopt(handle) => return Ok(*handle),
        CheckoutPlan::CheckoutOwnedBranch => {
            let AgentSpawnWorktreePolicyV1::Dedicated {
                base_commit_sha, ..
            } = &request.policy
            else {
                return Err(WorkspaceFailure::new("workspace_policy_invalid"));
            };
            return acquire_owned_checkout(request, target, lease, creation, Some(base_commit_sha))
                .await;
        }
        CheckoutPlan::PublishOwnership => {}
    }
    let AgentSpawnWorktreePolicyV1::Dedicated {
        base_commit_sha,
        branch,
        branch_mode,
        ..
    } = &request.policy
    else {
        return Err(WorkspaceFailure::new("workspace_policy_invalid"));
    };
    let lease_ref = lease_ref(&request.workspace_id);
    let branch_ref = format!("refs/heads/{branch}");
    let create_failure = create_ownership_refs(
        &request.project_root,
        &lease_ref,
        &branch_ref,
        base_commit_sha,
        *branch_mode,
        &[creation
            .execution_anchor()
            .map_err(|_| WorkspaceFailure::new("workspace_git_unavailable"))?],
    )
    .await
    .err();
    let current_lease = read_ref(&request.project_root, &lease_ref).await?;
    let current_branch = read_ref(&request.project_root, &branch_ref).await?;
    if current_lease.as_deref() != Some(base_commit_sha)
        || current_branch.as_deref() != Some(base_commit_sha)
    {
        return Err(
            create_failure.unwrap_or_else(|| WorkspaceFailure::new("workspace_identity_conflict"))
        );
    }
    acquire_owned_checkout(request, target, lease, creation, Some(base_commit_sha)).await
}

/// Re-attach an owned branch whose checkout was removed because nothing on it
/// could be lost. The branch may have advanced since launch, so its tip is
/// adopted instead of being compared with the launch commit.
pub(super) async fn restore_workspace(
    request: WorkspaceAcquireRequest,
) -> Result<WorkspaceHandle, WorkspaceFailure> {
    let AgentSpawnWorktreePolicyV1::Dedicated {
        base_commit_sha,
        branch,
        checkout_path,
        ..
    } = &request.policy
    else {
        return Err(WorkspaceFailure::new("workspace_policy_invalid"));
    };
    let lease = AgentSpawnWorkspaceLeaseV1::for_dedicated(&request.workspace_id, branch)
        .map_err(|_| WorkspaceFailure::new("workspace_lease_invalid"))?;
    let lease_ref = lease_ref(&request.workspace_id);
    if read_ref(&request.project_root, &lease_ref)
        .await?
        .as_deref()
        != Some(base_commit_sha)
    {
        return Err(WorkspaceFailure::new("workspace_lease_identity_mismatch"));
    }
    let target = prepare_workspace_destination(
        &request.project_root,
        &lease.directory_name,
        checkout_path.as_deref(),
    )?;
    let creation = {
        let repository = request.project_root.clone();
        let target = target.clone();
        let registration_id = request.registration_id.clone();
        let inputs = [base_commit_sha.clone(), branch.clone(), lease_ref];
        tokio::task::spawn_blocking(move || {
            dure_git_checkout::prepare_git_checkout_creation(
                &repository,
                &target,
                &registration_id,
                &inputs.iter().map(String::as_str).collect::<Vec<_>>(),
            )
        })
        .await
        .map_err(|_| WorkspaceFailure::new("workspace_claim_unavailable"))?
        .map_err(|error| WorkspaceFailure::with_detail(error.code, &error.message))?
        .ok_or_else(|| WorkspaceFailure::new("workspace_identity_conflict"))?
    };
    let creation = tokio::task::spawn_blocking(move || creation.admit())
        .await
        .map_err(|_| WorkspaceFailure::new("workspace_claim_unavailable"))?
        .map_err(|error| WorkspaceFailure::with_detail(error.code, &error.message))?;
    let handle = match acquire_owned_checkout(&request, &target, &lease, &creation, None).await {
        Ok(handle) => handle,
        // The branch may hold work from before its checkout was removed.
        Err(failure) => {
            return Err(retire_creation(move || creation.abort_if_absent(), failure)
                .await
                .0);
        }
    };
    tokio::task::spawn_blocking(move || creation.activate())
        .await
        .map_err(|_| WorkspaceFailure::new("workspace_claim_unavailable"))?
        .map_err(|error| WorkspaceFailure::with_detail(error.code, &error.message))?;
    Ok(handle)
}

pub(super) async fn resolve_workspace(
    request: WorkspaceAcquireRequest,
) -> Result<WorkspaceHandle, WorkspaceFailure> {
    let (base_commit_sha, branch, checkout_path) = match &request.policy {
        AgentSpawnWorktreePolicyV1::Dedicated {
            base_commit_sha,
            branch,
            checkout_path,
            ..
        } => (base_commit_sha, branch, checkout_path.as_deref()),
        AgentSpawnWorktreePolicyV1::ProjectRoot => {
            return Ok(project_root_handle(request.project_root));
        }
        AgentSpawnWorktreePolicyV1::ExistingCheckout { instance, .. } => {
            return Ok(project_root_handle(PathBuf::from(&instance.canonical_path)));
        }
        AgentSpawnWorktreePolicyV1::ExistingWorkspace { source } => {
            return Ok(project_root_handle(
                std::fs::canonicalize(&source.workspace_root)
                    .map_err(|_| WorkspaceFailure::new("workspace_root_unavailable"))?,
            ));
        }
    };
    let lease = AgentSpawnWorkspaceLeaseV1::for_dedicated(&request.workspace_id, branch)
        .map_err(|_| WorkspaceFailure::new("workspace_lease_invalid"))?;
    let target =
        resolve_workspace_destination(&request.project_root, &lease.directory_name, checkout_path)?;
    let lease_ref = lease_ref(&request.workspace_id);
    if read_ref(&request.project_root, &lease_ref)
        .await?
        .as_deref()
        != Some(base_commit_sha)
    {
        return Err(WorkspaceFailure::new("workspace_lease_identity_mismatch"));
    }
    let branch_ref = format!("refs/heads/{branch}");
    inspect_owned_checkout(&request.project_root, &target, &lease, &branch_ref, None)
        .await?
        .ok_or_else(|| WorkspaceFailure::new("workspace_checkout_identity_mismatch"))
}

async fn acquire_owned_checkout(
    request: &WorkspaceAcquireRequest,
    target: &Path,
    lease: &AgentSpawnWorkspaceLeaseV1,
    creation: &AdmittedGitCheckoutCreation,
    expected_head: Option<&str>,
) -> Result<WorkspaceHandle, WorkspaceFailure> {
    let AgentSpawnWorktreePolicyV1::Dedicated {
        branch,
        checkout_path,
        ..
    } = &request.policy
    else {
        return Err(WorkspaceFailure::new("workspace_policy_invalid"));
    };
    let branch_ref = format!("refs/heads/{branch}");
    if checkout_path.is_none() {
        ensure_worktree_root(&request.project_root)?;
    }
    let repository = request.project_root.clone();
    let excluded = if checkout_path.is_none() {
        target
            .parent()
            .expect("dedicated worktree parent")
            .to_path_buf()
    } else {
        target.to_path_buf()
    };
    tokio::task::spawn_blocking(move || {
        dure_git_checkout::exclude_worktree_directory(&repository, &excluded)
    })
    .await
    .map_err(|_| WorkspaceFailure::new("workspace_exclude_unavailable"))?
    .map_err(|error| WorkspaceFailure::with_detail(error.code, &error.message))?;
    let target_text = target
        .to_str()
        .ok_or_else(|| WorkspaceFailure::new("workspace_path_invalid"))?;
    let output = git_output_bound(
        &request.project_root,
        ["worktree", "add", "--no-guess-remote", target_text, branch],
        None,
        &[creation
            .execution_anchor()
            .map_err(|_| WorkspaceFailure::new("workspace_git_unavailable"))?],
    )
    .await?;
    let checkout_succeeded = output.status.success();
    if let Some(handle) = inspect_owned_checkout(
        &request.project_root,
        target,
        lease,
        &branch_ref,
        expected_head,
    )
    .await?
    {
        return Ok(handle);
    }
    Err(WorkspaceFailure::new(if checkout_succeeded {
        "workspace_checkout_identity_mismatch"
    } else {
        "workspace_checkout_create_failed"
    }))
}

async fn inspect_owned_checkout(
    project_root: &Path,
    target: &Path,
    lease: &AgentSpawnWorkspaceLeaseV1,
    branch_ref: &str,
    expected_head: Option<&str>,
) -> Result<Option<WorkspaceHandle>, WorkspaceFailure> {
    let current_branch = read_ref(project_root, branch_ref).await?;
    let entries = list_worktrees(project_root).await?;
    if entries
        .iter()
        .any(|entry| entry.path != target && entry.branch_ref.as_deref() == Some(branch_ref))
    {
        return Err(WorkspaceFailure::new(
            "workspace_branch_already_checked_out",
        ));
    }
    if let Some(entry) = entries.iter().find(|entry| entry.path == target) {
        // A killed `worktree add` still lists a valid branch and HEAD.
        if entry.initializing {
            return Err(WorkspaceFailure::new("workspace_checkout_interrupted"));
        }
        if entry.branch_ref.as_deref() != Some(branch_ref)
            || expected_head.is_some_and(|head| entry.head != head)
            || current_branch.as_deref() != Some(entry.head.as_str())
            || !is_exact_directory(target)
        {
            return Err(WorkspaceFailure::new(
                "workspace_checkout_identity_mismatch",
            ));
        }
        return Ok(Some(dedicated_handle(target.to_path_buf(), lease.clone())));
    }
    if expected_head.is_some_and(|head| current_branch.as_deref() != Some(head)) || target.exists()
    {
        return Err(WorkspaceFailure::new(
            "workspace_checkout_identity_mismatch",
        ));
    }
    Ok(None)
}
