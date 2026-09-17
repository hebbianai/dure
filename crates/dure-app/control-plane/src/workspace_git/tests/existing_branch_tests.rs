use super::*;

async fn existing_request(root: &Path) -> WorkspaceAcquireRequest {
    let base = branch_behind_head(root, "agent/feature-x").await;
    let mut request = request(root).await;
    if let AgentSpawnWorktreePolicyV1::Dedicated {
        base_commit_sha,
        branch_mode,
        ..
    } = &mut request.policy
    {
        *base_commit_sha = base;
        *branch_mode = AgentSpawnBranchModeV1::Existing;
    }
    request
}

#[tokio::test]
async fn existing_branch_checkout_preserves_branch_through_recovery_and_removal() {
    let root = repository().await;
    let mut request = existing_request(root.path()).await;
    let expected_base = resolve_branch_base(root.path(), "agent/feature-x")
        .await
        .unwrap();
    let created = GitWorkspaceAcquirer::default()
        .acquire(request.clone())
        .await
        .unwrap();
    assert_eq!(
        resolve_base_commit(&created.root, None).await.unwrap(),
        expected_base
    );
    let registration = created.registration.unwrap();
    request.registration = Some(registration.clone());
    assert_eq!(
        GitWorkspaceAcquirer::default()
            .acquire(request.clone())
            .await
            .unwrap()
            .registration,
        Some(registration.clone())
    );

    assert!(
        git_output(
            &created.root,
            ["commit", "--allow-empty", "-m", "agent progress"],
            None
        )
        .await
        .unwrap()
        .status
        .success()
    );
    let advanced = resolve_base_commit(&created.root, None).await.unwrap();
    assert_ne!(advanced, expected_base);
    let resumed = GitWorkspaceAcquirer::default()
        .resolve(request.clone())
        .await
        .unwrap();
    assert_eq!(
        resolve_base_commit(&resumed.root, None).await.unwrap(),
        advanced
    );

    let removal = dure_git_checkout::GitCheckoutRemovalRequestV1 {
        repository_path: registration.repository_path.clone(),
        instance: registration.instance.clone(),
        policy: dure_app::GitCheckoutRemovalPolicyV1::RequireClean,
    };
    assert_eq!(
        dure_git_checkout::remove_git_checkout_instance(&removal)
            .unwrap_err()
            .code,
        "checkout_use_in_use"
    );
    dure_git_checkout::release_git_checkout_registration(
        &registration,
        &request.registration_id,
        &OperationIdV1::new("stop-existing-branch").unwrap(),
    )
    .unwrap();
    dure_git_checkout::remove_git_checkout_instance(&removal).unwrap();
    assert!(!created.root.exists());
    assert_eq!(
        resolve_branch_base(root.path(), "agent/feature-x")
            .await
            .unwrap(),
        advanced
    );
    assert!(root.path().join("README.md").is_file());
}

#[tokio::test]
async fn existing_branch_advance_before_creation_is_not_reset_or_claimed() {
    let root = repository().await;
    let request = existing_request(root.path()).await;
    let advanced = resolve_base_commit(root.path(), None).await.unwrap();
    assert!(
        git_output(
            root.path(),
            ["update-ref", "refs/heads/agent/feature-x", &advanced],
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
    assert!(!root.path().join(".worktrees/feature-x").exists());
    assert_eq!(
        read_ref(root.path(), &lease_ref(&request.workspace_id))
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        resolve_branch_base(root.path(), "agent/feature-x")
            .await
            .unwrap(),
        advanced
    );
}

#[tokio::test]
async fn existing_branch_verification_rolls_back_the_whole_ownership_transaction() {
    let root = repository().await;
    let request = existing_request(root.path()).await;
    let actual = resolve_branch_base(root.path(), "agent/feature-x")
        .await
        .unwrap();
    let wrong_base = resolve_base_commit(root.path(), None).await.unwrap();
    assert!(
        create_ownership_refs(
            root.path(),
            &lease_ref(&request.workspace_id),
            "refs/heads/agent/feature-x",
            &wrong_base,
            AgentSpawnBranchModeV1::Existing,
            &[]
        )
        .await
        .is_err()
    );
    assert_eq!(
        read_ref(root.path(), &lease_ref(&request.workspace_id))
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        resolve_branch_base(root.path(), "agent/feature-x")
            .await
            .unwrap(),
        actual
    );
}
