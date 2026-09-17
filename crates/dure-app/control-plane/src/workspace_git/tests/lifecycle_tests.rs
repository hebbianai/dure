use super::*;
use dure_git_checkout::release_git_checkout_registration;

#[tokio::test]
async fn creates_and_reopens_one_owned_worktree() {
    let root = repository().await;
    let request = request(root.path()).await;
    let acquirer = GitWorkspaceAcquirer::default();
    let first = acquirer.acquire(request.clone()).await.unwrap();
    let second = acquirer.acquire(request.clone()).await.unwrap();
    let reopened = acquirer.resolve(request).await.unwrap();

    assert_eq!(first, second);
    assert_eq!(second, reopened);
    assert_eq!(
        first.disposition,
        AgentSpawnStageDispositionV1::CreatedDureOwned
    );
    assert_eq!(
        first.root,
        std::fs::canonicalize(root.path())
            .unwrap()
            .join(".worktrees/feature-x")
    );
    assert!(first.root.is_dir());
    assert_eq!(list_worktrees(root.path()).await.unwrap().len(), 2);
}

#[tokio::test]
async fn independent_acquirers_converge_on_the_same_owned_worktree() {
    let root = repository().await;
    let request = request(root.path()).await;
    let acquirer = GitWorkspaceAcquirer::default();
    let other_acquirer = GitWorkspaceAcquirer::default();

    let (first, second) = tokio::join!(
        acquirer.acquire(request.clone()),
        other_acquirer.acquire(request.clone())
    );

    assert!(first.is_ok() && second.is_ok(), "{first:?} {second:?}");
    assert_eq!(first.unwrap(), second.unwrap());
    assert_eq!(list_worktrees(root.path()).await.unwrap().len(), 2);
}

#[cfg(unix)]
#[tokio::test]
async fn resolve_refuses_a_checkout_replaced_by_a_symlink() {
    use std::os::unix::fs::symlink;

    let root = repository().await;
    let request = request(root.path()).await;
    let acquirer = GitWorkspaceAcquirer::default();
    let created = acquirer.acquire(request.clone()).await.unwrap();
    let redirect = root.path().join("redirect");
    std::fs::create_dir(&redirect).unwrap();
    std::fs::remove_dir_all(&created.root).unwrap();
    symlink(&redirect, &created.root).unwrap();

    let failure = acquirer.resolve(request).await.unwrap_err();

    assert_eq!(failure.code, "workspace_checkout_identity_mismatch");
}

#[tokio::test]
async fn resumes_after_ownership_refs_were_committed_before_checkout() {
    let root = repository().await;
    let request = request(root.path()).await;
    let AgentSpawnWorktreePolicyV1::Dedicated {
        base_commit_sha,
        branch,
        ..
    } = &request.policy
    else {
        unreachable!();
    };
    create_ownership_refs(
        root.path(),
        &lease_ref(&request.workspace_id),
        &format!("refs/heads/{branch}"),
        base_commit_sha,
        AgentSpawnBranchModeV1::Create,
        &[],
    )
    .await
    .unwrap();

    let resumed = GitWorkspaceAcquirer::default()
        .acquire(request)
        .await
        .unwrap();

    assert!(resumed.root.is_dir());
    assert_eq!(list_worktrees(root.path()).await.unwrap().len(), 2);
}

#[tokio::test]
async fn refuses_an_unowned_branch_without_mutating_it() {
    let root = repository().await;
    let request = request(root.path()).await;
    let AgentSpawnWorktreePolicyV1::Dedicated {
        base_commit_sha,
        branch,
        ..
    } = &request.policy
    else {
        unreachable!();
    };
    let branch_ref = format!("refs/heads/{branch}");
    assert!(
        git_output(
            root.path(),
            ["update-ref", &branch_ref, base_commit_sha],
            None
        )
        .await
        .unwrap()
        .status
        .success()
    );

    let failure = GitWorkspaceAcquirer::default()
        .acquire(request.clone())
        .await
        .unwrap_err();

    assert_eq!(failure.code, "workspace_identity_conflict");
    assert_eq!(
        read_ref(root.path(), &lease_ref(&request.workspace_id))
            .await
            .unwrap(),
        None
    );
    assert!(!root.path().join(".worktrees/feature-x").exists());
}

#[tokio::test]
async fn ownership_ref_transaction_rolls_back_when_branch_create_conflicts() {
    let root = repository().await;
    let request = request(root.path()).await;
    let AgentSpawnWorktreePolicyV1::Dedicated {
        base_commit_sha,
        branch,
        ..
    } = &request.policy
    else {
        unreachable!();
    };
    let branch_ref = format!("refs/heads/{branch}");
    assert!(
        git_output(
            root.path(),
            ["update-ref", &branch_ref, base_commit_sha],
            None
        )
        .await
        .unwrap()
        .status
        .success()
    );

    let failure = create_ownership_refs(
        root.path(),
        &lease_ref(&request.workspace_id),
        &branch_ref,
        base_commit_sha,
        AgentSpawnBranchModeV1::Create,
        &[],
    )
    .await
    .unwrap_err();

    assert_eq!(failure.code, "workspace_identity_conflict");
    assert_eq!(
        read_ref(root.path(), &lease_ref(&request.workspace_id))
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        read_ref(root.path(), &branch_ref).await.unwrap().as_deref(),
        Some(base_commit_sha.as_str())
    );
}

/// A preserved worktree removed out of band (its branch too) must be
/// recreatable by a new workspace under the same name, and a foreign-owned
/// path must never be reported as a moved lease.
#[tokio::test]
async fn recreates_a_preserved_worktree_removed_out_of_band() {
    let root = repository().await;
    let request = request(root.path()).await;
    let original = GitWorkspaceAcquirer::default()
        .acquire(request.clone())
        .await
        .unwrap();
    let registration = original.registration.clone().unwrap();
    let newcomer_request = WorkspaceAcquireRequest {
        workspace_id: WorkspaceIdV1::new("workspace-newcomer").unwrap(),
        registration_id: OperationIdV1::new("spawn-newcomer").unwrap(),
        ..request.clone()
    };

    // While the original still holds the checkout, the newcomer collides.
    let failure = GitWorkspaceAcquirer::default()
        .acquire(newcomer_request.clone())
        .await
        .unwrap_err();
    assert_eq!(failure.code, "workspace_identity_conflict");

    // Preserve-stop releases the claim; the checkout then disappears out of band.
    release_git_checkout_registration(
        &registration,
        &request.registration_id,
        &OperationIdV1::new("preserve-original").unwrap(),
    )
    .unwrap();
    for arguments in [
        vec![
            "worktree",
            "remove",
            "--force",
            original.root.to_str().unwrap(),
        ],
        vec!["branch", "-D", "agent/feature-x"],
    ] {
        assert!(
            git_output(root.path(), arguments, None)
                .await
                .unwrap()
                .status
                .success()
        );
    }
    assert!(!original.root.exists());

    let newcomer = GitWorkspaceAcquirer::default()
        .acquire(newcomer_request)
        .await
        .unwrap();
    assert_eq!(newcomer.root, original.root);
    assert!(newcomer.root.is_dir());
    assert_eq!(
        newcomer.disposition,
        AgentSpawnStageDispositionV1::CreatedDureOwned
    );
}
