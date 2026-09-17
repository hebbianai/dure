use super::*;
use dure_app::{GitCheckoutCaptureRequestV1, GitCheckoutReferenceV1};
use dure_git_checkout::{
    GitCheckoutRemovalOperation, GitCheckoutRemovalRequestV1, capture_git_checkout_instance,
    release_git_checkout_registration,
};

pub(crate) async fn selected_checkout(root: &Path) -> GitCheckoutReferenceV1 {
    let root = root.canonicalize().unwrap();
    let checkout = root.join("preexisting-checkout");
    assert!(
        git_output(
            &root,
            [
                "worktree",
                "add",
                "-b",
                "user/work",
                checkout.to_str().unwrap(),
                "HEAD"
            ],
            None,
        )
        .await
        .unwrap()
        .status
        .success()
    );
    let instance = capture_git_checkout_instance(&GitCheckoutCaptureRequestV1 {
        repository_path: root.to_str().unwrap().into(),
        checkout_path: checkout.to_str().unwrap().into(),
    })
    .unwrap();
    GitCheckoutReferenceV1 {
        canonical_path: instance.canonical_path,
        git_common_dir: instance.git_common_dir,
        git_dir: instance.git_dir,
        branch: "user/work".into(),
        head: resolve_base_commit(&checkout, None).await.unwrap(),
    }
}

async fn selected_request(root: &Path) -> WorkspaceAcquireRequest {
    let reference = selected_checkout(root).await;
    WorkspaceAcquireRequest {
        policy: capture_existing_checkout(root, reference).await.unwrap(),
        ..request(root).await
    }
}

#[tokio::test]
async fn existing_checkout_adoption_preserves_dirty_work_and_later_commits_on_recovery() {
    let root = repository().await;
    let mut request = selected_request(root.path()).await;
    let AgentSpawnWorktreePolicyV1::ExistingCheckout { instance, .. } = &request.policy else {
        panic!("existing checkout policy required");
    };
    let checkout = PathBuf::from(&instance.canonical_path);
    std::fs::write(checkout.join("README.md"), "existing work\n").unwrap();
    std::fs::write(checkout.join("untracked.txt"), "keep\n").unwrap();
    let acquirer = GitWorkspaceAcquirer::default();
    let handle = acquirer.acquire(request.clone()).await.unwrap();
    assert_eq!(handle.root, checkout);
    assert_eq!(
        handle.disposition,
        AgentSpawnStageDispositionV1::AdoptedExisting
    );
    assert!(handle.lease.is_none());
    assert_eq!(&handle.registration.as_ref().unwrap().instance, instance);
    assert_eq!(
        std::fs::read_to_string(checkout.join("README.md")).unwrap(),
        "existing work\n"
    );
    assert!(
        git_output(&checkout, ["commit", "-am", "later work"], None)
            .await
            .unwrap()
            .status
            .success()
    );
    let advanced = resolve_base_commit(&checkout, None).await.unwrap();
    request.registration = handle.registration.clone();
    assert_eq!(acquirer.resolve(request.clone()).await.unwrap(), handle);
    assert_eq!(acquirer.acquire(request).await.unwrap(), handle);
    assert_eq!(
        resolve_base_commit(&checkout, None).await.unwrap(),
        advanced
    );
    assert_eq!(
        std::fs::read_to_string(checkout.join("untracked.txt")).unwrap(),
        "keep\n"
    );
    assert_eq!(list_worktrees(root.path()).await.unwrap().len(), 2);
    assert!(
        read_ref(
            root.path(),
            &lease_ref(&WorkspaceIdV1::new("workspace-fixture").unwrap())
        )
        .await
        .unwrap()
        .is_none()
    );
}

#[tokio::test]
async fn existing_checkout_selection_checks_mutable_state_only_at_admission() {
    let root = repository().await;
    let mut reference = selected_checkout(root.path()).await;
    let checkout = PathBuf::from(&reference.canonical_path);
    assert!(
        git_output(
            &checkout,
            ["commit", "--allow-empty", "-m", "advanced"],
            None
        )
        .await
        .unwrap()
        .status
        .success()
    );
    assert_eq!(
        capture_existing_checkout(root.path(), reference.clone())
            .await
            .unwrap_err(),
        "worktree_identity_changed"
    );
    reference.head = resolve_base_commit(&checkout, None).await.unwrap();
    assert!(
        git_output(&checkout, ["switch", "--detach"], None)
            .await
            .unwrap()
            .status
            .success()
    );
    assert_eq!(
        capture_existing_checkout(root.path(), reference.clone())
            .await
            .unwrap_err(),
        "worktree_identity_changed"
    );
    reference.branch = "(detached)".into();
    let policy = capture_existing_checkout(root.path(), reference)
        .await
        .unwrap();
    let handle = GitWorkspaceAcquirer::default()
        .acquire(WorkspaceAcquireRequest {
            policy,
            ..request(root.path()).await
        })
        .await
        .unwrap();
    assert_eq!(handle.root, checkout);
    assert!(handle.lease.is_none());
}

#[tokio::test]
async fn existing_checkout_frozen_selection_cannot_claim_a_same_path_successor() {
    let root = repository().await;
    let request = selected_request(root.path()).await;
    let AgentSpawnWorktreePolicyV1::ExistingCheckout { instance, .. } = &request.policy else {
        panic!("existing checkout policy required");
    };
    for args in [
        vec!["worktree", "remove", &instance.canonical_path],
        vec!["worktree", "add", &instance.canonical_path, "user/work"],
    ] {
        assert!(
            git_output(root.path(), args, None)
                .await
                .unwrap()
                .status
                .success()
        );
    }
    assert_eq!(
        GitWorkspaceAcquirer::default()
            .acquire(request.clone())
            .await
            .unwrap_err()
            .code,
        "worktree_identity_changed"
    );
    assert_eq!(
        GitWorkspaceAcquirer::default()
            .resolve(request)
            .await
            .unwrap_err()
            .code,
        "worktree_identity_changed"
    );
    assert_eq!(list_worktrees(root.path()).await.unwrap().len(), 2);
}

#[tokio::test]
async fn existing_checkout_claim_and_removal_share_the_same_admission_authority() {
    let root = repository().await;
    let request = selected_request(root.path()).await;
    let acquirer = GitWorkspaceAcquirer::default();
    let handle = acquirer.acquire(request.clone()).await.unwrap();
    let registration = handle.registration.unwrap();
    let removal = GitCheckoutRemovalRequestV1 {
        repository_path: registration.repository_path.clone(),
        instance: registration.instance.clone(),
        policy: Default::default(),
    };
    let removal_id = OperationIdV1::new("remove-existing-checkout").unwrap();
    let blocked = GitCheckoutRemovalOperation::new(&removal, &removal_id)
        .unwrap()
        .admit();
    assert_eq!(blocked.err().unwrap().code, "checkout_use_in_use");
    release_git_checkout_registration(
        &registration,
        &request.registration_id,
        &OperationIdV1::new("release-existing-checkout").unwrap(),
    )
    .unwrap();
    let admitted = GitCheckoutRemovalOperation::new(&removal, &removal_id)
        .unwrap()
        .admit()
        .unwrap();
    let next = acquirer
        .acquire(WorkspaceAcquireRequest {
            registration_id: OperationIdV1::new("second-existing-checkout-agent").unwrap(),
            ..request
        })
        .await;
    assert_eq!(
        next.unwrap_err().code,
        "checkout_use_phase_conflict",
        "removal admission must fence new registration before launch"
    );
    assert!(handle.root.exists());
    admitted.remove().unwrap();
    assert!(!handle.root.exists());
    assert!(
        read_ref(root.path(), "refs/heads/user/work")
            .await
            .unwrap()
            .is_some()
    );
}
