use super::*;
use dure_app::{GitCheckoutCaptureRequestV1, GitCheckoutRemovalPolicyV1, OperationIdV1};
use dure_git_checkout::{
    GIT_CHECKOUT_USE_SCHEMA_VERSION_V1, GitCheckoutRemovalRequestV1, GitCheckoutUseActionV1,
    GitCheckoutUseRequestV1, apply_git_checkout_use, capture_git_checkout_instance,
    release_git_checkout_registration, remove_git_checkout_instance,
};

#[tokio::test]
async fn frozen_registration_cannot_authorize_a_different_working_directory() {
    let root = repository().await;
    let request = request(root.path()).await;
    let acquirer = GitWorkspaceAcquirer::default();
    let owned = acquirer.acquire(request.clone()).await.unwrap();
    let mut linked_request = WorkspaceAcquireRequest {
        project_root: owned.root,
        policy: AgentSpawnWorktreePolicyV1::ProjectRoot,
        registration_id: OperationIdV1::new("linked-root-agent").unwrap(),
        ..request
    };
    let linked = acquirer.acquire(linked_request.clone()).await.unwrap();
    linked_request.registration = linked.registration;
    linked_request.project_root = root.path().into();
    assert_eq!(
        acquirer.resolve(linked_request).await.unwrap_err().code,
        "worktree_identity_changed"
    );
}

#[tokio::test]
async fn linked_checkout_of_a_bare_repository_keeps_launch_supported() {
    let root = repository().await;
    let mut request = request(root.path()).await;
    let bare = root.path().join("bare.git");
    let linked = root.path().join("bare-linked");
    for arguments in [
        vec![
            "clone",
            "--bare",
            root.path().to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
        vec![
            "-C",
            bare.to_str().unwrap(),
            "worktree",
            "add",
            "--detach",
            linked.to_str().unwrap(),
            "HEAD",
        ],
    ] {
        assert!(
            git_output(root.path(), arguments, None)
                .await
                .unwrap()
                .status
                .success()
        );
    }
    request.project_root = linked;
    request.policy = AgentSpawnWorktreePolicyV1::ProjectRoot;
    let handle = GitWorkspaceAcquirer::default()
        .acquire(request)
        .await
        .unwrap();
    let registration = handle.registration.unwrap();
    assert_eq!(
        Path::new(&registration.repository_path),
        std::fs::canonicalize(bare).unwrap()
    );
    assert_eq!(
        remove_git_checkout_instance(&GitCheckoutRemovalRequestV1 {
            repository_path: registration.repository_path,
            instance: registration.instance,
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        })
        .unwrap_err()
        .code,
        "checkout_use_in_use"
    );
}

#[tokio::test]
async fn frozen_registration_does_not_adopt_a_same_path_replacement() {
    let root = repository().await;
    let mut request = request(root.path()).await;
    let handle = GitWorkspaceAcquirer::default()
        .acquire(request.clone())
        .await
        .unwrap();
    request.registration = handle.registration.clone();
    let target = handle.root.to_str().unwrap();
    for arguments in [
        vec!["worktree", "remove", target],
        vec!["worktree", "add", target, "agent/feature-x"],
    ] {
        assert!(
            git_output(root.path(), arguments, None)
                .await
                .unwrap()
                .status
                .success()
        );
    }
    assert_eq!(
        GitWorkspaceAcquirer::default()
            .resolve(request)
            .await
            .unwrap_err()
            .code,
        "worktree_identity_changed"
    );
    assert!(handle.root.is_dir());
}

#[tokio::test]
async fn releasing_a_removed_registration_preserves_the_same_path_newcomer() {
    let root = repository().await;
    let request = request(root.path()).await;
    let original = GitWorkspaceAcquirer::default()
        .acquire(request.clone())
        .await
        .unwrap();
    let registration = original.registration.unwrap();
    dure_git_checkout::GitCheckoutRemovalOperation::new(
        &GitCheckoutRemovalRequestV1 {
            repository_path: registration.repository_path.clone(),
            instance: registration.instance.clone(),
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
        &OperationIdV1::new("remove-original-checkout").unwrap(),
    )
    .unwrap()
    .retiring_registration(&request.registration_id)
    .admit()
    .unwrap()
    .remove()
    .unwrap();
    let newcomer_request = WorkspaceAcquireRequest {
        registration_id: OperationIdV1::new("spawn-new-checkout-incarnation").unwrap(),
        ..request.clone()
    };
    let newcomer = GitWorkspaceAcquirer::default()
        .acquire(newcomer_request.clone())
        .await
        .unwrap();
    release_git_checkout_registration(
        &registration,
        &request.registration_id,
        &OperationIdV1::new("late-preserve-original").unwrap(),
    )
    .unwrap();
    let reopened = GitWorkspaceAcquirer::default()
        .resolve(WorkspaceAcquireRequest {
            registration: newcomer.registration.clone(),
            ..newcomer_request
        })
        .await
        .unwrap();
    assert_eq!(reopened, newcomer);
    assert_ne!(
        newcomer.registration.unwrap().instance,
        registration.instance
    );
}

async fn removed_checkout() -> (tempfile::TempDir, WorkspaceAcquireRequest, PathBuf) {
    let root = repository().await;
    let mut request = request(root.path()).await;
    let handle = GitWorkspaceAcquirer::default()
        .acquire(request.clone())
        .await
        .unwrap();
    request.registration = handle.registration.clone();
    let registration = handle.registration.unwrap();
    dure_git_checkout::GitCheckoutRemovalOperation::new(
        &GitCheckoutRemovalRequestV1 {
            repository_path: registration.repository_path,
            instance: registration.instance,
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
        &OperationIdV1::new("remove-before-workspace-recovery").unwrap(),
    )
    .unwrap()
    .retiring_registration(&request.registration_id)
    .admit()
    .unwrap()
    .remove()
    .unwrap();
    assert!(!handle.root.exists());
    (root, request, handle.root)
}

#[tokio::test]
async fn resolving_a_removed_checkout_does_not_recreate_it() {
    let (root, request, checkout) = removed_checkout().await;
    let result = GitWorkspaceAcquirer::default().resolve(request).await;

    assert!(result.is_err(), "a removed incarnation is not resumable");
    assert!(
        !checkout.exists(),
        "resolution recreated the retired checkout"
    );
    assert_eq!(list_worktrees(root.path()).await.unwrap().len(), 1);
}

#[tokio::test]
async fn acquiring_a_frozen_removed_checkout_does_not_recreate_it() {
    let (root, request, checkout) = removed_checkout().await;
    let result = GitWorkspaceAcquirer::default().acquire(request).await;

    assert!(
        result.is_err(),
        "a frozen registration is not creation authority"
    );
    assert!(
        !checkout.exists(),
        "acquisition recreated the retired checkout"
    );
    assert_eq!(list_worktrees(root.path()).await.unwrap().len(), 1);
}

#[tokio::test]
async fn resolving_a_legacy_removed_checkout_does_not_recreate_it() {
    let (root, mut request, checkout) = removed_checkout().await;
    request.registration = None;
    let result = GitWorkspaceAcquirer::default().resolve(request).await;

    assert!(
        result.is_err(),
        "legacy resolution is not creation authority"
    );
    assert!(
        !checkout.exists(),
        "legacy resolution recreated the retired checkout"
    );
    assert_eq!(list_worktrees(root.path()).await.unwrap().len(), 1);
}

#[tokio::test]
async fn frozen_workspace_resolution_preserves_later_commits() {
    let root = repository().await;
    let mut request = request(root.path()).await;
    let acquirer = GitWorkspaceAcquirer::default();
    let handle = acquirer.acquire(request.clone()).await.unwrap();
    request.registration = handle.registration.clone();
    let before = resolve_base_commit(&handle.root, None).await.unwrap();
    std::fs::write(handle.root.join("README.md"), "agent work\n").unwrap();
    assert!(
        git_output(&handle.root, ["commit", "-am", "agent work"], None)
            .await
            .unwrap()
            .status
            .success()
    );
    let after = resolve_base_commit(&handle.root, None).await.unwrap();
    assert_ne!(before, after);

    assert_eq!(acquirer.resolve(request.clone()).await.unwrap(), handle);
    assert_eq!(acquirer.acquire(request).await.unwrap(), handle);
    assert_eq!(
        resolve_base_commit(&handle.root, None).await.unwrap(),
        after
    );
}

#[tokio::test]
async fn linked_project_root_keeps_distinct_registration_incarnations() {
    let root = repository().await;
    let request = request(root.path()).await;
    let acquirer = GitWorkspaceAcquirer::default();
    let owned = acquirer.acquire(request.clone()).await.unwrap();
    let linked = acquirer
        .acquire(WorkspaceAcquireRequest {
            project_root: owned.root.clone(),
            registration_id: OperationIdV1::new("spawn-second-incarnation").unwrap(),
            policy: AgentSpawnWorktreePolicyV1::ProjectRoot,
            ..request.clone()
        })
        .await
        .unwrap();
    assert_eq!(linked.registration, owned.registration);
    assert_eq!(
        linked.disposition,
        AgentSpawnStageDispositionV1::AdoptedExisting
    );
    assert!(linked.lease.is_none());
    let registration = owned.registration.unwrap();
    release_git_checkout_registration(
        &registration,
        &request.registration_id,
        &OperationIdV1::new("release-first-incarnation").unwrap(),
    )
    .unwrap();
    assert_eq!(
        remove_git_checkout_instance(&GitCheckoutRemovalRequestV1 {
            repository_path: registration.repository_path,
            instance: registration.instance,
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        })
        .unwrap_err()
        .code,
        "checkout_use_in_use"
    );
}

#[tokio::test]
async fn primary_and_non_git_project_roots_do_not_claim_linked_checkout_ownership() {
    let root = repository().await;
    let mut request = request(root.path()).await;
    request.policy = AgentSpawnWorktreePolicyV1::ProjectRoot;
    let plain = tempfile::tempdir().unwrap();
    for directory in [root.path(), plain.path()] {
        request.project_root = directory.into();
        let handle = GitWorkspaceAcquirer::default()
            .acquire(request.clone())
            .await
            .unwrap();
        assert!(handle.registration.is_none());
        assert!(handle.lease.is_none());
        assert_eq!(
            handle.disposition,
            AgentSpawnStageDispositionV1::AdoptedExisting
        );
    }
}

#[tokio::test]
async fn released_registration_cannot_replay_as_a_launchable_workspace() {
    let root = repository().await;
    let request = request(root.path()).await;
    let handle = GitWorkspaceAcquirer::default()
        .acquire(request.clone())
        .await
        .unwrap();
    release_git_checkout_registration(
        handle.registration.as_ref().unwrap(),
        &request.registration_id,
        &OperationIdV1::new("release-fixture-registration").unwrap(),
    )
    .unwrap();

    assert_eq!(
        GitWorkspaceAcquirer::default()
            .resolve(request)
            .await
            .unwrap_err()
            .code,
        "checkout_use_phase_conflict",
        "a historical claim receipt cannot revive a stopped registration"
    );
}

#[tokio::test]
async fn retiring_registration_cannot_replay_as_a_launchable_workspace() {
    let root = repository().await;
    let request = request(root.path()).await;
    let handle = GitWorkspaceAcquirer::default()
        .acquire(request.clone())
        .await
        .unwrap();
    let instance = capture_git_checkout_instance(&GitCheckoutCaptureRequestV1 {
        repository_path: root.path().to_string_lossy().into_owned(),
        checkout_path: handle.root.to_string_lossy().into_owned(),
    })
    .unwrap();
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: root.path().to_string_lossy().into_owned(),
        operation_id: OperationIdV1::new("retire-fixture-registration").unwrap(),
        action: GitCheckoutUseActionV1::AcquireRemovalPermit {
            instance,
            retiring_claim_ids: vec![request.registration_id.clone()],
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
    })
    .unwrap();

    assert_eq!(
        GitWorkspaceAcquirer::default()
            .resolve(request)
            .await
            .unwrap_err()
            .code,
        "checkout_use_phase_conflict",
        "removal authority must also fence retries of the retiring registration"
    );
}

#[tokio::test]
async fn acquired_agent_checkout_membership_prevents_plain_removal() {
    let root = repository().await;
    let request = request(root.path()).await;
    let acquirer = GitWorkspaceAcquirer::default();
    let acquired = acquirer.acquire(request).await.unwrap();
    let instance = capture_git_checkout_instance(&GitCheckoutCaptureRequestV1 {
        repository_path: root.path().to_string_lossy().into_owned(),
        checkout_path: acquired.root.to_string_lossy().into_owned(),
    })
    .unwrap();

    let removal = remove_git_checkout_instance(&GitCheckoutRemovalRequestV1 {
        repository_path: root.path().to_string_lossy().into_owned(),
        instance,
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    });

    assert_eq!(
        removal
            .expect_err("a canonical Agent checkout must hold a use claim before launch")
            .code,
        "checkout_use_in_use"
    );
    assert!(acquired.root.is_dir());
}

#[tokio::test]
async fn prior_removal_permit_prevents_agent_checkout_resolution() {
    let root = repository().await;
    let mut request = request(root.path()).await;
    request.project_root = canonical_project_root(&request).unwrap();
    let AgentSpawnWorktreePolicyV1::Dedicated {
        base_commit_sha,
        branch,
        ..
    } = &request.policy
    else {
        panic!("fixture must request a dedicated checkout");
    };
    let lease = AgentSpawnWorkspaceLeaseV1::for_dedicated(&request.workspace_id, branch).unwrap();
    let target = dedicated_path(&request.project_root, &lease.directory_name);
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
    ensure_worktree_root(&request.project_root).unwrap();
    assert!(
        git_output(
            root.path(),
            [
                "worktree",
                "add",
                "--no-guess-remote",
                target.to_str().unwrap(),
                branch
            ],
            None,
        )
        .await
        .unwrap()
        .status
        .success()
    );
    let instance = capture_git_checkout_instance(&GitCheckoutCaptureRequestV1 {
        repository_path: root.path().to_string_lossy().into_owned(),
        checkout_path: target.to_string_lossy().into_owned(),
    })
    .unwrap();
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: root.path().to_string_lossy().into_owned(),
        operation_id: OperationIdV1::new("prior-checkout-removal").unwrap(),
        action: GitCheckoutUseActionV1::AcquireRemovalPermit {
            instance,
            retiring_claim_ids: Vec::new(),
            policy: GitCheckoutRemovalPolicyV1::RequireClean,
        },
    })
    .unwrap();

    let result = GitWorkspaceAcquirer::default().resolve(request).await;

    assert_eq!(
        result
            .expect_err("a checkout under removal must not resolve to a launchable handle")
            .code,
        "checkout_use_phase_conflict"
    );
    assert!(target.is_dir());
}

#[tokio::test]
async fn prior_creation_reservation_prevents_competing_checkout_side_effects() {
    let root = repository().await;
    let mut request = request(root.path()).await;
    request.project_root = canonical_project_root(&request).unwrap();
    let AgentSpawnWorktreePolicyV1::Dedicated { branch, .. } = &request.policy else {
        panic!("fixture must request a dedicated checkout");
    };
    let branch_ref = format!("refs/heads/{branch}");
    let ownership_ref = lease_ref(&request.workspace_id);
    let lease = AgentSpawnWorkspaceLeaseV1::for_dedicated(&request.workspace_id, branch).unwrap();
    ensure_worktree_root(&request.project_root).unwrap();
    let target = dedicated_path(&request.project_root, &lease.directory_name);
    let reservation_request = GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: request.project_root.to_string_lossy().into_owned(),
        operation_id: OperationIdV1::new("prior-checkout-creation").unwrap(),
        action: GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: target.to_string_lossy().into_owned(),
            owner_id: OperationIdV1::new("other-checkout-creator").unwrap(),
        },
    };
    let reservation = apply_git_checkout_use(&reservation_request).unwrap();

    let result = GitWorkspaceAcquirer::default().acquire(request).await;
    let worktree_count = list_worktrees(root.path()).await.unwrap().len();
    let actual_branch = read_ref(root.path(), &branch_ref).await.unwrap();
    let actual_ownership = read_ref(root.path(), &ownership_ref).await.unwrap();
    assert!(
        !target.exists(),
        "competing acquisition materialized a reserved path: result={result:?}, \
         worktrees={worktree_count}, branch={actual_branch:?}, ownership={actual_ownership:?}"
    );
    assert_eq!(worktree_count, 1);
    assert_eq!(actual_branch, None);
    assert_eq!(actual_ownership, None);
    assert!(result.is_err());
    assert_eq!(
        apply_git_checkout_use(&reservation_request).unwrap(),
        reservation,
        "a rejected competing create must preserve the prior reservation"
    );
}
