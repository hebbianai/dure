use super::*;

#[tokio::test]
async fn claude_schedule_refuses_untrusted_project_without_launching_or_accepting_trust() {
    let (root, mut state, launcher, _) = fixture(vec![LaunchOutcome::Succeed]).await;
    prepare(&root, &mut state).await;
    schedule_runtime::tick(&state, 120_000).await.unwrap();
    let occurrences = state.store.schedule_occurrences(None, 10).await.unwrap();
    assert_eq!(
        occurrences[0].error_code.as_deref(),
        Some("schedule_claude_project_trust_required")
    );
    assert!(launcher.requests().is_empty());
    assert!(!root.path().join(".claude.json").exists());
    schedule_runtime::tick(&state, 120_000).await.unwrap();
    assert_eq!(
        state
            .store
            .schedule_occurrences(None, 10)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(launcher.requests().is_empty());
}

async fn prepare(root: &TempDir, state: &mut ServiceState) {
    prepare_project(root, state).await;
    state.agent_providers = Arc::new(provider_extension::test_bundled_provider_registry(
        "claude",
        root.path().join("codex-fixture").to_str().unwrap(),
        false,
    ));
    let request: SchedulePutRequestV1 = serde_json::from_value(json!({
        "schemaVersion": 1, "scheduleId": "claude-schedule", "expectedRevision": 0,
        "idempotencyKey": "create-claude-schedule", "name": "Claude schedule", "enabled": true,
        "expression": "* * * * *", "timezone": "UTC",
        "runTemplate": {"projectId": "project-1", "providerId": "claude", "prompt": "Run the scheduled task"},
    })).unwrap();
    state.store.put_schedule(&request, 60_000).await.unwrap();
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_BIN and DURE_QA_HMUX_RUNTIME; run pnpm test:hmux-schedule"]
async fn claude_schedule_run_uses_real_hmux() {
    let (root, mut state, _, _) = fixture(vec![]).await;
    prepare(&root, &mut state).await;
    let project = root.path().canonicalize().unwrap();
    fs::write(
        root.path().join(".claude.json"),
        serde_json::to_vec(&json!({"projects": {
            project.to_str().unwrap(): {"hasTrustDialogAccepted": true}
        }}))
        .unwrap(),
    )
    .unwrap();
    let original_trust = fs::read(root.path().join(".claude.json")).unwrap();
    let hmux = real_hmux::RealHmux::install(root, &mut state);
    fs::write(
        hmux.root.join("codex-fixture"),
        "#!/bin/sh\nexec sleep 60\n",
    )
    .unwrap();
    schedule_runtime::tick(&state, 120_000).await.unwrap();
    let occurrences = state.store.schedule_occurrences(None, 10).await.unwrap();
    assert_eq!(
        occurrences[0].launch_state,
        dure_app::ScheduleLaunchStateV1::Started,
        "{occurrences:?}"
    );
    assert_eq!(
        fs::read(hmux.root.join(".claude.json")).unwrap(),
        original_trust
    );
    let request = hmux.requests().pop().unwrap();
    assert!(Path::new(&request.working_directory).join(".git").is_file());
    let spawn = state
        .store
        .agent_spawn_receipt(
            &OperationIdV1::new(occurrences[0].operation_id.clone().unwrap()).unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    let session = spawn
        .completed
        .iter()
        .find_map(|stage| match &stage.evidence {
            dure_app::AgentSpawnStageEvidenceV1::RuntimeLaunch { session, .. } => {
                Some(session.clone())
            }
            _ => None,
        })
        .unwrap();
    use hmux_client::{AgentRuntimeActivity as Activity, AgentRuntimeAttention as Attention};
    for (activity, attention, expected) in [
        (
            Activity::Waiting,
            Attention::InputRequired,
            Attention::InputRequired,
        ),
        (
            Activity::Waiting,
            Attention::ApprovalRequired,
            Attention::ApprovalRequired,
        ),
        // The shared Host retains attention until provider work resumes.
        (
            Activity::Waiting,
            Attention::None,
            Attention::ApprovalRequired,
        ),
        (Activity::Working, Attention::None, Attention::None),
    ] {
        hmux_client::ManagedAgentStateReporter::new(
            PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap()),
            &hmux.root,
        )
        .with_discovery_root(&hmux.discovery)
        .report_agent_state_for_fence(
            hmux_client::ManagedAttachRequest::new(&session.session_id, &session.workspace_id)
                .unwrap(),
            hmux_client::AgentStateReport {
                progress: None,
                identity_only: false,
                activity,
                attention,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                conversation_identity: None,
                expected_observation: None,
            },
            hmux_client::SessionFence {
                workspace_id: session.workspace_id.clone(),
                session_id: session.session_id.clone(),
                runner_principal: session.runner_principal.clone(),
                runner_instance: session.runner_instance.clone(),
                channel_epoch: session.channel_epoch.parse().unwrap(),
                host_instance_id: session.host_instance_id.clone(),
                terminal_epoch: session.terminal_epoch.clone(),
            },
        )
        .unwrap();
        let observed = schedule_runtime::invoke(
            &state,
            "schedule.occurrences",
            &json!({"schemaVersion": 1, "maxItems": 10, "includeRuntime": true}),
        )
        .await
        .unwrap();
        assert_eq!(
            observed["occurrences"][0]["runtime"]["state"], "observed",
            "{observed}"
        );
        assert_eq!(
            observed["occurrences"][0]["runtime"]["attention"],
            json!(expected)
        );
        assert_eq!(
            observed["occurrences"][0]["runtime"]["session"],
            json!(session)
        );
        assert_eq!(observed["occurrences"][0]["launchState"], "started");
    }
    let legacy = schedule_runtime::invoke(
        &state,
        "schedule.occurrences",
        &json!({"schemaVersion": 1, "maxItems": 10}),
    )
    .await
    .unwrap();
    assert!(legacy["occurrences"][0].get("runtime").is_none());
    hmux.stop(&session);
    let observed = schedule_runtime::invoke(&state, "schedule.inspect", &json!({"schemaVersion": 1, "idempotencyKey": occurrences[0].idempotency_key, "includeRuntime": true})).await.unwrap();
    assert_ne!(observed["occurrence"]["run"]["completed"], true);
    assert!(observed["resultMarkdown"].is_null());
}
