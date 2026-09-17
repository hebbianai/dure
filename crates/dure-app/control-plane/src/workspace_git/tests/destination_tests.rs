use super::*;

#[cfg(unix)]
#[tokio::test]
async fn default_checkout_destination_does_not_follow_a_redirected_worktree_root() {
    let root = repository().await;
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join(".worktrees")).unwrap();
    let request = request(root.path()).await;
    let result = GitWorkspaceAcquirer::default()
        .acquire(request.clone())
        .await;
    assert!(
        !outside.path().join("feature-x").exists(),
        "default creation followed a symlink outside its project: {result:?}"
    );
    assert_eq!(result.unwrap_err().code, "workspace_root_unsafe");
    assert_eq!(list_worktrees(root.path()).await.unwrap().len(), 1);
    assert_eq!(
        read_ref(root.path(), &lease_ref(&request.workspace_id))
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn explicit_checkout_destination_is_created_and_resolved_under_its_original_claim() {
    let root = repository().await;
    let mut request = request(root.path()).await;
    let destination = root.path().join("custom/nested/feature-x");
    if let AgentSpawnWorktreePolicyV1::Dedicated { checkout_path, .. } = &mut request.policy {
        *checkout_path = Some(destination.to_string_lossy().into_owned());
    }
    let acquirer = GitWorkspaceAcquirer::default();
    let created = acquirer.acquire(request.clone()).await.unwrap();
    let canonical_destination = destination.canonicalize().unwrap();
    assert_eq!(created.root, canonical_destination);
    assert!(destination.join(".git").is_file());
    assert!(!root.path().join(".worktrees/feature-x").exists());
    let registration = created.registration.clone().unwrap();
    assert_eq!(
        registration.instance.canonical_path,
        canonical_destination.to_str().unwrap()
    );
    request.registration = Some(registration.clone());
    let resumed = GitWorkspaceAcquirer::default()
        .acquire(request)
        .await
        .unwrap();
    assert_eq!(resumed.root, canonical_destination);
    assert_eq!(resumed.registration, Some(registration));
}

#[tokio::test]
async fn explicit_destination_outside_the_project_keeps_its_claim_through_exact_removal() {
    let root = repository().await;
    let sibling = tempfile::tempdir().unwrap();
    let destination = sibling.path().join("feature-x");
    let mut request = request(root.path()).await;
    if let AgentSpawnWorktreePolicyV1::Dedicated { checkout_path, .. } = &mut request.policy {
        *checkout_path = Some(destination.to_string_lossy().into_owned());
    }
    let created = GitWorkspaceAcquirer::default()
        .acquire(request.clone())
        .await
        .unwrap();
    let registration = created.registration.unwrap();
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
    assert!(destination.join(".git").is_file());
    dure_git_checkout::release_git_checkout_registration(
        &registration,
        &request.registration_id,
        &OperationIdV1::new("stop-custom-checkout").unwrap(),
    )
    .unwrap();
    dure_git_checkout::remove_git_checkout_instance(&removal).unwrap();
    assert!(!destination.exists());
    assert!(root.path().join("README.md").is_file());
    assert_eq!(list_worktrees(root.path()).await.unwrap().len(), 1);
}

#[tokio::test]
async fn explicit_destination_preserves_preexisting_user_data_on_creation_failure() {
    let root = repository().await;
    let destination = root.path().join("custom/feature-x");
    std::fs::create_dir_all(&destination).unwrap();
    std::fs::write(destination.join("user.txt"), "preserve this data").unwrap();
    let mut request = request(root.path()).await;
    if let AgentSpawnWorktreePolicyV1::Dedicated { checkout_path, .. } = &mut request.policy {
        *checkout_path = Some(destination.to_string_lossy().into_owned());
    }
    assert!(
        GitWorkspaceAcquirer::default()
            .acquire(request.clone())
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("user.txt")).unwrap(),
        "preserve this data"
    );
    assert_eq!(list_worktrees(root.path()).await.unwrap().len(), 1);
    assert_eq!(
        read_ref(root.path(), &lease_ref(&request.workspace_id))
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        read_ref(root.path(), "refs/heads/agent/feature-x")
            .await
            .unwrap(),
        None
    );
}
