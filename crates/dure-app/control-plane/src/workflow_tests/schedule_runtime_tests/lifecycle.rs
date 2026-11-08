use super::*;
use dure_app::AgentSpawnWorktreePolicyV1;
use schedule_runtime::lifecycle;
use std::path::PathBuf;

struct Launched {
    operation: OperationIdV1,
    agent: AgentIdV1,
    checkout: PathBuf,
    branch: String,
}

fn git(directory: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
        ])
        .args(args)
        .current_dir(directory)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

async fn launch(root: &TempDir, state: &ServiceState) -> Launched {
    prepare_schedule(root, state).await;
    git(root.path(), &["branch", "main"]);
    schedule_runtime::tick(state, 120_000).await.unwrap();
    let (operation, agent) = state
        .store
        .scheduled_agent_spawns(None, 10)
        .await
        .unwrap()
        .remove(0);
    let spawn = state
        .store
        .agent_spawn_receipt(&operation)
        .await
        .unwrap()
        .unwrap();
    let AgentSpawnWorktreePolicyV1::Dedicated { branch, .. } = spawn.plan.request.worktree else {
        panic!("a default schedule uses a dedicated worktree");
    };
    let workspace = state
        .store
        .workspace(&spawn.plan.workspace_id)
        .await
        .unwrap()
        .unwrap();
    Launched {
        operation,
        agent,
        checkout: PathBuf::from(workspace.root_path),
        branch,
    }
}

async fn remove(state: &ServiceState, launched: &Launched) -> bool {
    lifecycle::remove_checkout_if_disposable(
        state,
        &launched.operation,
        launched.checkout.clone(),
        launched.branch.clone(),
    )
    .await
}

#[tokio::test]
async fn scheduled_spawns_are_paged_and_resolved_by_agent() {
    let (root, state, _, _) = fixture(vec![LaunchOutcome::Succeed]).await;
    let launched = launch(&root, &state).await;
    assert_eq!(
        state
            .store
            .scheduled_spawn_for_agent(&launched.agent)
            .await
            .unwrap(),
        Some(launched.operation.clone())
    );
    assert_eq!(
        state
            .store
            .scheduled_spawn_for_agent(&AgentIdV1::new("started-by-a-person").unwrap())
            .await
            .unwrap(),
        None,
        "an agent no schedule started is not covered"
    );
    assert!(
        state
            .store
            .scheduled_agent_spawns(Some(&launched.operation), 10)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn a_checkout_is_kept_until_nothing_on_it_can_be_lost_and_a_wake_restores_it() {
    let (root, state, _, _) = fixture(vec![LaunchOutcome::Succeed]).await;
    let launched = launch(&root, &state).await;

    fs::write(launched.checkout.join("notes.txt"), "keep me\n").unwrap();
    assert!(!remove(&state, &launched).await, "untracked work");
    assert!(launched.checkout.join("notes.txt").is_file());

    git(&launched.checkout, &["add", "notes.txt"]);
    git(&launched.checkout, &["commit", "-m", "Notes"]);
    assert!(
        !remove(&state, &launched).await,
        "a commit only on its branch"
    );
    assert!(launched.checkout.is_dir());

    let tip = git(&launched.checkout, &["rev-parse", "HEAD"]);
    git(root.path(), &["update-ref", "refs/heads/main", &tip]);
    assert!(remove(&state, &launched).await, "the default branch has it");
    assert!(!launched.checkout.exists());
    assert_eq!(
        git(root.path(), &["rev-parse", launched.branch.as_str()]),
        tip,
        "removing the worktree keeps its branch"
    );

    let wake = OperationIdV1::new("first-wake").unwrap();
    lifecycle::restore_checkout_for_wake(&state, &launched.agent, &wake)
        .await
        .unwrap();
    assert_eq!(git(&launched.checkout, &["rev-parse", "HEAD"]), tip);
    assert_eq!(
        git(&launched.checkout, &["symbolic-ref", "--short", "HEAD"]),
        launched.branch,
        "a restored checkout is on its original branch at its advanced tip"
    );
    assert!(launched.checkout.join("notes.txt").is_file());

    // The restored checkout goes through the same cycle again.
    assert!(
        remove(&state, &launched).await,
        "a wake's own claim is retired"
    );
    assert!(!launched.checkout.exists());
    let second = OperationIdV1::new("second-wake").unwrap();
    lifecycle::restore_checkout_for_wake(&state, &launched.agent, &second)
        .await
        .unwrap();
    assert!(launched.checkout.is_dir());
}

#[tokio::test]
async fn a_checkout_is_kept_while_its_agent_has_no_recorded_stop() {
    let (root, mut state, _, _) = fixture(vec![LaunchOutcome::Succeed]).await;
    make_fixture_mutation_authority(&mut state);
    let launched = launch(&root, &state).await;
    assert!(
        git(&launched.checkout, &["status", "--porcelain"]).is_empty(),
        "the checkout itself would be disposable"
    );
    assert_eq!(
        lifecycle::remove_finished_checkouts_page(&state, None).await,
        None
    );
    assert!(launched.checkout.is_dir());
}

#[tokio::test]
async fn waking_an_agent_no_schedule_started_never_creates_a_checkout() {
    let (_root, state, _, _) = fixture(Vec::new()).await;
    lifecycle::restore_checkout_for_wake(
        &state,
        &AgentIdV1::new("started-by-a-person").unwrap(),
        &OperationIdV1::new("wake").unwrap(),
    )
    .await
    .unwrap();
}
