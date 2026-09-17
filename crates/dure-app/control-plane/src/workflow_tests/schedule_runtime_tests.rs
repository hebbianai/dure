use super::*;
use dure_app::AgentSpawnJournalStore;

#[tokio::test]
async fn schedule_permission_defaults_are_inherited_only_without_an_override() {
    for permission in [None, Some("default"), Some("skip_permissions")] {
        let (root, state, launcher, _) = fixture(vec![LaunchOutcome::Succeed]).await;
        prepare_project(&root, &state).await;
        state
            .store
            .put_provider_launch_defaults(
                &ProviderLaunchDefaultsPutRequestV1 {
                    schema_version: PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1,
                    idempotency_key: "schedule-defaults".into(),
                    expected_revision: 0,
                    defaults: BTreeMap::from([(
                        ProviderIdV1::new("codex").unwrap(),
                        ProviderLaunchDefaultV1 {
                            permission_mode: ProviderLaunchPermissionModeV1::BypassApprovals,
                        },
                    )]),
                },
                1,
            )
            .await
            .unwrap();
        let mut template = json!({"projectId": "project-1", "providerId": "codex", "prompt": "Run the scheduled task"});
        if let Some(permission) = permission {
            template["permissionMode"] = json!(permission);
        }
        let request: SchedulePutRequestV1 = serde_json::from_value(json!({
            "schemaVersion": 1, "scheduleId": "permissions", "expectedRevision": 0,
            "idempotencyKey": "schedule-create", "name": "Permissions", "enabled": true,
            "expression": "* * * * *", "timezone": "UTC", "runTemplate": template,
        }))
        .unwrap();
        state.store.put_schedule(&request, 60_000).await.unwrap();
        schedule_runtime::tick(&state, 120_000).await.unwrap();
        let requests = launcher.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].permission_mode,
            if permission == Some("default") {
                AgentSpawnPermissionModeV1::Default
            } else {
                AgentSpawnPermissionModeV1::SkipPermissions
            },
            "omitted permissions must resolve at the existing provider defaults authority"
        );
    }
}

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_BIN and DURE_QA_HMUX_RUNTIME; run pnpm test:hmux-schedule"]
async fn schedule_run_uses_real_hmux() {
    let (root, mut state, _, _) = fixture(vec![]).await;
    prepare_schedule(&root, &state).await;
    let hmux = real_hmux::RealHmux::install(root, &mut state);
    let marker = hmux.root.join("provider-start.txt");
    let marker_quoted = format!("'{}'", marker.to_str().unwrap().replace('\'', "'\\''"));
    fs::write(
        hmux.root.join("codex-fixture"),
        format!("#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$@\" > {marker_quoted}\nexec sleep 60\n"),
    )
    .unwrap();
    schedule_runtime::tick(&state, 120_000).await.unwrap();
    let occurrences = state.store.schedule_occurrences(None, 10).await.unwrap();
    assert_eq!(occurrences.len(), 1);
    let operation = OperationIdV1::new(occurrences[0].operation_id.clone().unwrap()).unwrap();
    let spawn = state
        .store
        .agent_spawn_receipt(&operation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        spawn
            .plan
            .request
            .model
            .as_ref()
            .map(|value| value.as_str()),
        Some("gpt-6-astra")
    );
    assert_eq!(
        spawn
            .plan
            .request
            .effort
            .as_ref()
            .map(|value| value.as_str()),
        Some("xhigh")
    );
    let session = spawn
        .completed
        .iter()
        .find_map(|stage| match &stage.evidence {
            dure_app::AgentSpawnStageEvidenceV1::RuntimeLaunch { session, .. } => {
                Some(session.clone())
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("real runtime launch did not commit: {spawn:?}"));
    assert_eq!(
        occurrences[0].launch_state,
        dure_app::ScheduleLaunchStateV1::Started,
        "{spawn:?}"
    );
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
    let started = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Ok(value) = fs::read_to_string(&marker) {
                break value;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let cwd = PathBuf::from(started.lines().next().unwrap());
    assert_ne!(cwd, hmux.root.canonicalize().unwrap());
    assert!(cwd.join(".git").is_file());
    assert_eq!(started.matches("Run the scheduled task").count(), 1);
    assert!(
        started.lines().any(|line| line == "gpt-6-astra"),
        "{started}"
    );
    assert!(
        started
            .lines()
            .any(|line| line == "model_reasoning_effort=xhigh"),
        "{started}"
    );

    let mut body = existing_session_run_body();
    body["session"] = json!(session);
    let created = invoke_orchestration(&state, "real-schedule-enroll", "run.create", body).await;
    complete_report(
        &state,
        &created["receipt"]["context"],
        "real-schedule-complete",
        "Retained from a real Hmux run.",
    )
    .await;
    hmux.stop(&session);
    let (_, result) = state
        .store
        .schedule_occurrence(&occurrences[0].idempotency_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.as_deref(), Some("Retained from a real Hmux run."));
}

#[tokio::test]
async fn due_schedule_reuses_the_spawn_saga_once_per_minute() {
    let (root, state, launcher, prompt_deliverer) = fixture(vec![LaunchOutcome::Succeed]).await;
    prepare_schedule(&root, &state).await;
    let project_root = root.path().canonicalize().unwrap();
    let scheduled_for_ms = 120_000;

    schedule_runtime::tick(&state, scheduled_for_ms)
        .await
        .unwrap();
    schedule_runtime::tick(&state, scheduled_for_ms)
        .await
        .unwrap();

    let occurrences = state.store.schedule_occurrences(None, 10).await.unwrap();
    assert_eq!(occurrences.len(), 1);
    let output = serde_json::to_value(&occurrences[0]).unwrap();
    assert_eq!(
        output
            .get("launchState")
            .or_else(|| output.get("state"))
            .unwrap(),
        "started",
        "launch acceptance must not report task success"
    );
    assert!(
        output.get("run").is_none(),
        "no completion report exists yet"
    );
    assert!(occurrences[0].operation_id.is_some());
    assert_eq!(launcher.requests().len(), 1);
    assert_ne!(
        Path::new(&launcher.requests()[0].working_directory),
        project_root
    );
    assert!(
        Path::new(&launcher.requests()[0].working_directory)
            .join(".git")
            .is_file()
    );
    assert_eq!(
        prompt_deliverer.requests().len()
            + launcher
                .requests()
                .iter()
                .filter(|request| request.initial_prompt.is_some())
                .count(),
        1
    );

    let operation = OperationIdV1::new(occurrences[0].operation_id.clone().unwrap()).unwrap();
    let spawn = state
        .store
        .agent_spawn_receipt(&operation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        spawn
            .plan
            .request
            .model
            .as_ref()
            .map(|value| value.as_str()),
        Some("gpt-6-astra")
    );
    assert_eq!(
        spawn
            .plan
            .request
            .effort
            .as_ref()
            .map(|value| value.as_str()),
        Some("xhigh")
    );
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
    fs::write(state.hmux_identity.discovery_root.join("current-session.json"), serde_json::to_vec(&json!({
        "schema_version": 1, "session_class": "managed", "lifecycle": "ready", "health": "healthy",
        "session_id": session.session_id, "workspace_id": session.workspace_id, "provider_id": session.provider_id,
        "runner_principal": session.runner_principal, "runner_instance": session.runner_instance,
        "channel_epoch": session.channel_epoch, "host_instance_id": session.host_instance_id,
        "terminal_epoch": session.terminal_epoch,
    })).unwrap()).unwrap();
    let mut body = existing_session_run_body();
    body["session"] = json!(session);
    let created = invoke_orchestration(
        &state,
        "scheduled-report-enroll",
        "run.create",
        body.clone(),
    )
    .await;
    let context = &created["receipt"]["context"];
    let key = &occurrences[0].idempotency_key;
    let (active, result) = state.store.schedule_occurrence(key).await.unwrap().unwrap();
    assert_eq!(
        active.run.as_ref().unwrap().run_id,
        context["target"]["runId"]
    );
    assert!(!active.run.as_ref().unwrap().completed);
    assert!(result.is_none());

    complete_report(
        &state,
        context,
        "scheduled-report-complete",
        "Daily review: two findings retained.",
    )
    .await;
    let (completed, result) = state.store.schedule_occurrence(key).await.unwrap().unwrap();
    assert!(completed.run.as_ref().unwrap().completed);
    assert_eq!(
        result.as_deref(),
        Some("Daily review: two findings retained.")
    );

    // Later work in the same session is a distinct Run, never the result of this trigger.
    body["idempotencyKey"] = json!("scheduled-report-successor");
    let successor =
        invoke_orchestration(&state, "scheduled-report-successor", "run.create", body).await;
    assert_ne!(successor["receipt"]["context"]["target"], context["target"]);
    complete_report(
        &state,
        &successor["receipt"]["context"],
        "scheduled-successor-complete",
        "Unrelated later report.",
    )
    .await;
    assert_eq!(
        state.store.schedule_occurrence(key).await.unwrap().unwrap(),
        (completed.clone(), result.clone())
    );

    // Inspect the result after runtime discovery and the checkout are unavailable.
    fs::rename(
        root.path().join("hmux-fixture"),
        root.path().join("hmux-fixture-closed"),
    )
    .unwrap();
    fs::rename(
        &launcher.requests()[0].working_directory,
        root.path().join("closed-checkout"),
    )
    .unwrap();
    state.store.close().await;
    let reopened = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    assert_eq!(
        reopened.schedule_occurrence(key).await.unwrap().unwrap(),
        (completed, result)
    );
}

pub(super) async fn complete_report(
    state: &ServiceState,
    context: &Value,
    key: &str,
    result: &str,
) {
    invoke_orchestration(
        state,
        key,
        "dispatch.complete",
        json!({
            "schemaVersion": 1, "idempotencyKey": key, "messageId": key,
            "target": context["target"], "expectedDispatchRevision": 1,
            "completedBy": context["participant"], "endpointFence": context["endpointFence"],
            "audience": { "grants": [context["coordinatorGrant"].clone()] },
            "completionCapability": context["completionCapability"], "title": "Automation report",
            "resultMarkdown": result, "completedAtMs": 1_100,
        }),
    )
    .await;
}

pub(super) async fn prepare_project(root: &TempDir, state: &ServiceState) {
    // An existing user branch must not reserve the namespace automated runs need.
    for args in [
        vec!["init", "--quiet", "--initial-branch=automation"],
        vec![
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "Initial",
        ],
    ] {
        assert!(
            std::process::Command::new("git")
                .args(args)
                .current_dir(root.path())
                .status()
                .unwrap()
                .success()
        );
    }
    let project_root = root.path().canonicalize().unwrap();
    register_project(
        &state.projects_catalog_path,
        "project-1".into(),
        "Fixture project".into(),
        project_root.to_string_lossy().into_owned(),
    )
    .unwrap();
}

async fn prepare_schedule(root: &TempDir, state: &ServiceState) {
    prepare_project(root, state).await;
    state
        .store
        .put_schedule(
            &SchedulePutRequestV1 {
                schema_version: SCHEDULE_SCHEMA_VERSION_V1,
                schedule_id: ScheduleIdV1::new("every-minute").unwrap(),
                expected_revision: 0,
                idempotency_key: "schedule-create-every-minute".into(),
                name: "Every minute".into(),
                enabled: true,
                expression: "* * * * *".into(),
                timezone: "UTC".into(),
                run_template: ScheduleRunTemplateV1 {
                    project_id: ProjectIdV1::new("project-1").unwrap(),
                    provider_id: ProviderIdV1::new("codex").unwrap(),
                    prompt: "Run the scheduled task".into(),
                    model: Some(
                        dure_app::AgentSpawnModelSelectionV1::parse("gpt-6-astra").unwrap(),
                    ),
                    effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("xhigh").unwrap()),
                    permission_mode: Some(AgentSpawnPermissionModeV1::Default),
                    execution_profile: AgentExecutionProfileV1::ProviderDefault,
                    worktree: dure_app::ScheduleWorkspacePolicyV1::default(),
                },
            },
            60_000,
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn schedule_launch_replay_survives_a_new_backend_generation_and_head() {
    let (root, mut state, launcher, _) = fixture(vec![LaunchOutcome::Succeed]).await;
    prepare_schedule(&root, &state).await;
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query(
        r#"CREATE TRIGGER lose_schedule_finish BEFORE UPDATE OF state ON schedule_occurrences
        WHEN NEW.state = 'started' BEGIN SELECT RAISE(ABORT, 'injected lost finish'); END"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    schedule_runtime::tick(&state, 120_000).await.unwrap();
    let pending = state.store.pending_schedule_occurrences(10).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert!(pending[0].0.operation_id.is_some());
    assert_eq!(launcher.requests().len(), 1);
    sqlx::query("DROP TRIGGER lose_schedule_finish")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    state.store.close().await;
    state.store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite"))
            .await
            .unwrap(),
    );
    state.descriptor.generation = "schedule-restarted-generation".into();
    assert!(
        std::process::Command::new("git")
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "New HEAD"
            ])
            .current_dir(root.path())
            .status()
            .unwrap()
            .success()
    );
    schedule_runtime::tick(&state, 120_000).await.unwrap();
    let occurrences = state.store.schedule_occurrences(None, 10).await.unwrap();
    assert_eq!(occurrences.len(), 1);
    assert_eq!(
        occurrences[0].launch_state,
        dure_app::ScheduleLaunchStateV1::Started
    );
    assert_eq!(occurrences[0].operation_id, pending[0].0.operation_id);
    assert_eq!(launcher.requests().len(), 1);
}
