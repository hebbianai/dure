use super::*;
use agent_runtime_transition_apply::deferred::idle::IdleRuntime;
use agent_runtime_transition_apply::deferred::{WakeBodyV1, wake};
use dure_app::{AgentSpawnJournalStore, AgentSpawnWorktreePolicyV1};
use schedule_runtime::lifecycle;
use std::time::Duration;

fn git(directory: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(directory)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

/// The saved opt-out stays off, as a person would leave it, and nothing asks
/// for the stop or the removal: only the schedule lifecycle pass acts here.
#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_BIN and DURE_QA_HMUX_RUNTIME; run pnpm test:hmux-schedule"]
async fn idle_schedule_run_uses_real_hmux() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    schedule_runtime_tests::prepare_schedule(&root, &state).await;
    let project_root = root.path().canonicalize().unwrap();
    git(&project_root, &["branch", "main"]);
    let hmux = RealHmux::install(root, &mut state);
    let starts = hmux.root.join("provider-starts.txt");
    fs::write(
        hmux.root.join("codex-fixture"),
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$PWD\" >> '{}'\nexec sleep 300\n",
            starts.display()
        ),
    )
    .unwrap();
    make_fixture_mutation_authority(&mut state);
    state.runtime_idle = IdleRuntime::default();
    state
        .runtime_idle
        .configure(
            &state,
            serde_json::from_value(json!({
                "schemaVersion": 1, "expectedRevision": 0, "policy": {"mode": "disabled"},
            }))
            .unwrap(),
        )
        .await
        .unwrap();

    schedule_runtime::tick(&state, 120_000).await.unwrap();
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
    let source = spawn
        .completed
        .iter()
        .find_map(|stage| match &stage.evidence {
            dure_app::AgentSpawnStageEvidenceV1::RuntimeLaunch { session, .. } => {
                Some(session.clone())
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("real runtime launch did not commit: {spawn:?}"));
    let AgentSpawnWorktreePolicyV1::Dedicated { branch, .. } = &spawn.plan.request.worktree else {
        panic!("a default schedule uses a dedicated worktree");
    };
    let checkout = PathBuf::from(
        state
            .store
            .workspace(&spawn.plan.workspace_id)
            .await
            .unwrap()
            .unwrap()
            .root_path,
    );
    assert!(checkout.is_dir());
    // The binding learns this identity from the Host, as with a real provider.
    state_reporter::report_conversation(
        &hmux,
        &source,
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
        Some(CONVERSATION),
    );
    let descriptor = hmux.session(&source);

    // Only the threshold is shortened; the page, Host clock and stop are real.
    let asleep = tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            lifecycle::hibernate_idle_page(&state, None, Duration::from_secs(2)).await;
            if let Some(transition) = state
                .store
                .active_agent_runtime_transition(&agent)
                .await
                .unwrap()
                && transition.is_dormant()
            {
                break transition;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await;
    let asleep = match asleep {
        Ok(asleep) => asleep,
        Err(_) => panic!(
            "a scheduled agent hibernates despite the saved opt-out: {:?}",
            agent_runtime_transition_apply::deferred::idle::hibernate_if_host_idle(
                &state,
                &agent,
                0,
                Duration::from_secs(2),
            )
            .await
        ),
    };
    RealHmux::assert_exited(&descriptor).await;
    assert_eq!(
        serde_json::to_value(state.runtime_idle.observe(&state).await).unwrap()["configuration"],
        "disabled"
    );

    lifecycle::remove_finished_checkouts_page(&state, None).await;
    assert!(
        !checkout.exists(),
        "the stopped agent's clean, merged checkout is removed"
    );
    assert!(!git(&project_root, &["rev-parse", branch.as_str()]).is_empty());

    wake(
        &state,
        "wake-scheduled-agent",
        WakeBodyV1 {
            schema_version: 1,
            agent_id: agent.clone(),
            operation_id: asleep.intent.operation_id.clone(),
            expected_journal_revision: asleep.journal_revision,
            expected_provider_conversation_ref: Some(CONVERSATION.into()),
        },
    )
    .await
    .expect("a wake brings back the removed checkout");
    assert_eq!(
        git(&checkout, &["symbolic-ref", "--short", "HEAD"]),
        branch.as_str()
    );
    let started = fs::read_to_string(&starts).unwrap();
    assert_eq!(started.lines().count(), 2, "{started}");
    let expected = checkout.canonicalize().unwrap();
    assert!(
        started
            .lines()
            .all(|directory| Path::new(directory).canonicalize().unwrap() == expected),
        "both generations run in the same folder: {started}"
    );
}
