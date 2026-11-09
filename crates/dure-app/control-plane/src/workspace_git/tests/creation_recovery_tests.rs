use super::*;
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

const ROOT_ENV: &str = "DURE_CHECKOUT_CREATION_CRASH_FIXTURE_ROOT";

async fn reject_ref_transaction(root: &Path, reference: &str) -> PathBuf {
    let hooks = root.join("hooks");
    std::fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("reference-transaction");
    std::fs::write(
        &hook,
        format!(
            r##"#!/bin/sh
[ "$1" = prepared ] || exit 0
while read -r old new reference; do
  if [ "$reference" = "{reference}" ]; then
    printf rejected >> "$(git rev-parse --git-common-dir)/rejected-creation"
    exit 1
  fi
done
"##
        ),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        git_output(
            root,
            ["config", "core.hooksPath", hooks.to_str().unwrap()],
            None
        )
        .await
        .unwrap()
        .status
        .success()
    );
    hook
}

#[tokio::test]
async fn failed_ownership_transaction_retires_only_its_creation_reservation() {
    let root = repository().await;
    let mut request = request(root.path()).await;
    let hook = reject_ref_transaction(root.path(), "refs/heads/agent/feature-x").await;
    assert!(
        GitWorkspaceAcquirer::default()
            .acquire(request.clone())
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(root.path().join(".git/rejected-creation")).unwrap(),
        b"rejected"
    );
    assert!(!root.path().join(".worktrees/feature-x").exists());
    assert!(
        read_ref(root.path(), &lease_ref(&request.workspace_id))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        read_ref(root.path(), "refs/heads/agent/feature-x")
            .await
            .unwrap()
            .is_none()
    );
    std::fs::rename(&hook, hook.with_extension("disabled")).unwrap();
    request.registration_id = OperationIdV1::new("fresh-after-ref-failure").unwrap();
    let result = GitWorkspaceAcquirer::default().acquire(request).await;
    assert!(
        result.is_ok(),
        "a rejected Git transaction stranded its creator: {result:?}"
    );
}

#[tokio::test]
async fn failed_worktree_creation_preserves_owned_refs_and_allows_a_fresh_registration() {
    let root = repository().await;
    let mut request = request(root.path()).await;
    let hook = reject_ref_transaction(root.path(), "HEAD").await;
    assert!(
        GitWorkspaceAcquirer::default()
            .acquire(request.clone())
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(root.path().join(".git/rejected-creation")).unwrap(),
        b"rejected"
    );
    assert!(!root.path().join(".worktrees/feature-x").exists());
    assert_eq!(list_worktrees(root.path()).await.unwrap().len(), 1);
    let lease_ref = lease_ref(&request.workspace_id);
    let lease_before = read_ref(root.path(), &lease_ref).await.unwrap().unwrap();
    let branch_before = read_ref(root.path(), "refs/heads/agent/feature-x")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease_before, branch_before);
    std::fs::rename(&hook, hook.with_extension("disabled")).unwrap();
    request.registration_id = OperationIdV1::new("fresh-after-checkout-failure").unwrap();
    let result = GitWorkspaceAcquirer::default().acquire(request).await;
    assert!(
        result.is_ok(),
        "a failed physical Git creator stranded its successor: {result:?}"
    );
    assert_eq!(
        read_ref(root.path(), &lease_ref).await.unwrap().as_deref(),
        Some(lease_before.as_str())
    );
    assert_eq!(
        read_ref(root.path(), "refs/heads/agent/feature-x")
            .await
            .unwrap()
            .as_deref(),
        Some(branch_before.as_str())
    );
}

/// Commits a file whose checkout runs `smudge`. Only the attribute is committed;
/// the filter itself is local configuration a later attempt can drop.
async fn install_checkout_filter(root: &Path, smudge: &str) {
    std::fs::write(root.join(".gitattributes"), "payload filter=dure-fixture\n").unwrap();
    std::fs::write(root.join("payload"), "payload\n").unwrap();
    for arguments in [
        vec!["add", ".gitattributes", "payload"],
        vec!["commit", "-m", "add filtered payload"],
        vec!["config", "filter.dure-fixture.smudge", smudge],
    ] {
        assert!(
            git_output(root, arguments, None)
                .await
                .unwrap()
                .status
                .success()
        );
    }
}

async fn remove_checkout_filter(root: &Path) {
    assert!(
        git_output(
            root,
            ["config", "--unset", "filter.dure-fixture.smudge"],
            None
        )
        .await
        .unwrap()
        .status
        .success()
    );
}

fn another_run(mut request: WorkspaceAcquireRequest) -> WorkspaceAcquireRequest {
    request.workspace_id = WorkspaceIdV1::new("workspace-next-run").unwrap();
    request.registration_id = OperationIdV1::new("spawn-next-run").unwrap();
    request
}

async fn assert_rolled_back_and_the_name_is_free(root: &Path, request: WorkspaceAcquireRequest) {
    assert!(
        !root.join(".worktrees/feature-x").exists(),
        "the partial checkout was left behind"
    );
    assert_eq!(list_worktrees(root).await.unwrap().len(), 1);
    assert!(
        read_ref(root, &lease_ref(&request.workspace_id))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        read_ref(root, "refs/heads/agent/feature-x")
            .await
            .unwrap()
            .is_none()
    );

    remove_checkout_filter(root).await;
    let created = GitWorkspaceAcquirer::default()
        .acquire(another_run(request))
        .await
        .expect("the same worktree name must be usable after a rollback");
    assert_eq!(
        std::fs::read(created.root.join("payload")).unwrap(),
        b"payload\n"
    );
}

#[tokio::test]
async fn killed_checkout_is_never_adopted_and_rolls_back() {
    let root = repository().await;
    // Killing Git's whole group leaves what the bounded timeout leaves: Git
    // gets no chance to clean up and stays locked `initializing`.
    install_checkout_filter(root.path(), "kill -9 0").await;
    let request = request(root.path()).await;

    let failure = GitWorkspaceAcquirer::default()
        .acquire(request.clone())
        .await
        .expect_err("a checkout Git never finished must not be adopted");

    assert_eq!(failure.code, "workspace_checkout_interrupted");
    assert_rolled_back_and_the_name_is_free(root.path(), request).await;
}

#[tokio::test]
async fn timed_out_checkout_reports_the_timeout_and_rolls_back() {
    let root = repository().await;
    // Outlasts the real 20 second limit; the runner kills the filter with Git.
    install_checkout_filter(root.path(), "sleep 40").await;
    let request = request(root.path()).await;

    let failure = GitWorkspaceAcquirer::default()
        .acquire(request.clone())
        .await
        .unwrap_err();

    assert_eq!(failure.code, "workspace_git_timeout");
    assert_eq!(failure.detail, None);
    assert_rolled_back_and_the_name_is_free(root.path(), request).await;
}

#[tokio::test]
async fn failed_creation_without_physical_effects_does_not_block_a_fresh_registration() {
    rejected_preflight_allows_a_fresh_registration(false).await;
}

#[tokio::test]
async fn rejected_recovery_retires_its_own_absent_started_creation() {
    rejected_preflight_allows_a_fresh_registration(true).await;
}

async fn rejected_preflight_allows_a_fresh_registration(recovering: bool) {
    let root = repository().await;
    let mut request = request(root.path()).await;
    let AgentSpawnWorktreePolicyV1::Dedicated {
        base_commit_sha,
        branch,
        ..
    } = &request.policy
    else {
        panic!("dedicated fixture required");
    };
    let branch_ref = format!("refs/heads/{branch}");
    if recovering {
        // Recovery setup uses the same canonical root as production acquisition.
        let project_root = canonical_project_root(&request).unwrap();
        ensure_worktree_root(&project_root).unwrap();
        drop(
            dure_git_checkout::prepare_git_checkout_creation(
                &project_root,
                &project_root.join(".worktrees/feature-x"),
                &request.registration_id,
                &[base_commit_sha, branch, &lease_ref(&request.workspace_id)],
            )
            .unwrap()
            .unwrap()
            .admit()
            .unwrap(),
        );
    }
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
    assert_eq!(
        GitWorkspaceAcquirer::default()
            .acquire(request.clone())
            .await
            .unwrap_err()
            .code,
        "workspace_identity_conflict"
    );
    assert!(!root.path().join(".worktrees/feature-x").exists());
    assert!(
        read_ref(root.path(), &lease_ref(&request.workspace_id))
            .await
            .unwrap()
            .is_none()
    );

    // Remove only the exact branch value created by this isolated fixture.
    assert!(
        git_output(
            root.path(),
            ["update-ref", "-d", &branch_ref, base_commit_sha],
            None
        )
        .await
        .unwrap()
        .status
        .success()
    );
    request.registration_id = OperationIdV1::new("fresh-after-rejected-create").unwrap();
    let result = GitWorkspaceAcquirer::default().acquire(request).await;
    assert!(
        result.is_ok(),
        "an effect-free failed creator left a permanent reservation: {result:?}"
    );
}

struct FinishedOwners(&'static [&'static str]);

impl CreationOwnerLedger for FinishedOwners {
    fn has_finished<'a>(&'a self, operation: &'a OperationIdV1) -> CreationOwnerFuture<'a> {
        Box::pin(async move { self.0.contains(&operation.as_str()) })
    }
}

/// `git worktree add` can fail after writing the directory. The creator's own
/// abort is then refused, so the reservation outlives it. A later run reuses
/// the name only once that directory is gone and the creator has ended.
#[tokio::test]
async fn partial_creation_yields_its_name_only_to_a_run_that_can_prove_it_ended() {
    let root = repository().await;
    let first = request(root.path()).await;
    let hooks = root.path().join("hooks");
    std::fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("post-checkout");
    std::fs::write(
        &hook,
        b"#!/bin/sh\nrm -rf \"$(git rev-parse --absolute-git-dir)\"\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        git_output(
            root.path(),
            ["config", "core.hooksPath", hooks.to_str().unwrap()],
            None
        )
        .await
        .unwrap()
        .status
        .success()
    );
    assert_eq!(
        GitWorkspaceAcquirer::default()
            .acquire(first.clone())
            .await
            .unwrap_err()
            .code,
        "workspace_checkout_identity_mismatch"
    );
    let partial = root.path().join(".worktrees/feature-x");
    assert!(partial.is_dir());
    std::fs::remove_dir_all(&partial).unwrap();
    std::fs::rename(&hook, hook.with_extension("disabled")).unwrap();

    let mut later = first;
    later.workspace_id = WorkspaceIdV1::new("workspace-later-run").unwrap();
    later.registration_id = OperationIdV1::new("spawn-later-run").unwrap();
    let AgentSpawnWorktreePolicyV1::Dedicated { branch_mode, .. } = &mut later.policy else {
        panic!("dedicated fixture required");
    };
    *branch_mode = AgentSpawnBranchModeV1::Existing;

    for unproven in [
        GitWorkspaceAcquirer::default(),
        GitWorkspaceAcquirer::with_creation_owners(Arc::new(FinishedOwners(&["spawn-other"]))),
    ] {
        assert_eq!(
            unproven.acquire(later.clone()).await.unwrap_err().code,
            "checkout_use_phase_conflict"
        );
        assert!(!partial.exists());
    }

    let result =
        GitWorkspaceAcquirer::with_creation_owners(Arc::new(FinishedOwners(&["spawn-fixture"])))
            .acquire(later)
            .await;
    assert!(
        result.is_ok(),
        "a finished creator stranded its path: {result:?}"
    );
    assert!(partial.is_dir());
}

#[tokio::test]
async fn creation_child() {
    let Some(root) = std::env::var_os(ROOT_ENV) else {
        return;
    };
    let request = request(Path::new(&root)).await;
    GitWorkspaceAcquirer::default()
        .acquire(request)
        .await
        .unwrap();
}

struct CreationChild {
    root: PathBuf,
    child: Child,
}

impl Drop for CreationChild {
    fn drop(&mut self) {
        let _ = std::fs::write(self.root.join("hook-release"), b"release");
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        eprintln!(
            "retained isolated creation recovery fixture: {}",
            self.root.display()
        );
    }
}

#[tokio::test]
async fn parent_loss_waits_for_original_git_then_recovers_one_checkout() {
    // Parent loss deliberately orphans Git; keep its repository even if a
    // later observation fails instead of deleting a possibly active cwd.
    let root = repository().await.keep();
    let request = request(&root).await;
    let hooks = root.join("hooks");
    std::fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("post-checkout");
    std::fs::write(
        &hook,
        br##"#!/bin/sh
printf ready > "$DURE_CHECKOUT_CREATION_CRASH_FIXTURE_ROOT/hook-ready"
i=0
while [ ! -f "$DURE_CHECKOUT_CREATION_CRASH_FIXTURE_ROOT/hook-release" ]; do
  i=$((i+1))
  [ "$i" -lt 1000 ] || exit 1
  sleep 0.01
done
printf x >> "$DURE_CHECKOUT_CREATION_CRASH_FIXTURE_ROOT/hook-count"
printf late > "$DURE_CHECKOUT_CREATION_CRASH_FIXTURE_ROOT/.worktrees/feature-x/late-write"
"##,
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        git_output(
            &root,
            ["config", "core.hooksPath", hooks.to_str().unwrap()],
            None
        )
        .await
        .unwrap()
        .status
        .success()
    );
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "workspace_git::tests::creation_recovery_tests::creation_child",
            "--nocapture",
        ])
        .env(ROOT_ENV, &root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut fixture = CreationChild { root, child };
    tokio::time::timeout(Duration::from_secs(10), async {
        while !fixture.root.join("hook-ready").exists() {
            assert!(
                fixture.child.try_wait().unwrap().is_none(),
                "creator exited before Git hook entry"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(fixture.child.try_wait().unwrap().is_none());
    // Only this test's exact Child handle is signalled, after Git acknowledged
    // hook entry. Neither a process-name match nor a borrowed PID is used.
    fixture.child.kill().unwrap();
    fixture.child.wait().unwrap();
    let mut recovery = GitWorkspaceAcquirer::default().acquire(request.clone());
    let early = tokio::time::timeout(Duration::from_millis(200), &mut recovery).await;
    assert!(
        !fixture
            .root
            .join(".worktrees/feature-x/late-write")
            .exists()
    );
    std::fs::write(fixture.root.join("hook-release"), b"release").unwrap();
    let (recovered, returned_before_release) = match early {
        Ok(result) => (result, true),
        Err(_) => (recovery.await, false),
    };
    assert!(
        !returned_before_release,
        "recovery returned before original Git finished: {recovered:?}"
    );
    let recovered = recovered.unwrap();
    assert_eq!(
        std::fs::read(fixture.root.join("hook-count")).unwrap(),
        b"x"
    );
    assert_eq!(
        std::fs::read(recovered.root.join("late-write")).unwrap(),
        b"late"
    );
    assert_eq!(list_worktrees(&fixture.root).await.unwrap().len(), 2);
    assert_eq!(
        GitWorkspaceAcquirer::default()
            .resolve(WorkspaceAcquireRequest {
                registration: recovered.registration.clone(),
                ..request
            })
            .await
            .unwrap(),
        recovered
    );
}
