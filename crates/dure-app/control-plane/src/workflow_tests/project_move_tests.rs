use super::*;
use agent_runtime_transition_apply::project_move;

const CONVERSATION: &str = "019f0000-0000-7000-8000-000000000185";

async fn setup(outcomes: Vec<LaunchOutcome>) -> (TempDir, TempDir, ServiceState, FakeLauncher) {
    let (root, mut state, launcher, _, _) = fixture_with_source_launch_authority(
        outcomes,
        Vec::new(),
        Vec::new(),
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            conversation_id: Some(CONVERSATION.into()),
            credential_reference_id: Some("move-account".into()),
            ..Default::default()
        },
    )
    .await;
    let accounts = root.path().join("accounts");
    fs::create_dir(&accounts).unwrap();
    fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
    let profile = accounts.join("codex-move");
    fs::create_dir(&profile).unwrap();
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o700)).unwrap();
    let sessions = root.path().join(".codex/sessions");
    fs::create_dir_all(&sessions).unwrap();
    std::os::unix::fs::symlink(
        fs::canonicalize(sessions).unwrap(),
        profile.join("sessions"),
    )
    .unwrap();
    fs::write(
        profile.join(format!("sessions/rollout-{CONVERSATION}.jsonl")),
        format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{CONVERSATION}\"}}}}\n"),
    )
    .unwrap();
    let registered = state
        .credential_profiles
        .register(
            provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                schema_version: 1,
                provider_id: "codex".into(),
                reference_id: "move-account".into(),
                profile_directory_name: "codex-move".into(),
            },
        )
        .await
        .unwrap();
    let agent = AgentIdV1::new("coordinator-1").unwrap();
    let mut authority = state
        .store
        .agent_checkpoint_binding_authority(&agent)
        .await
        .unwrap()
        .unwrap();
    authority.binding.credential_reference_id = Some("move-account".into());
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&authority)
        .await
        .unwrap();
    state
        .store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent,
            provider_id: ProviderIdV1::new("codex").unwrap(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: AgentExecutionProfileV1::CredentialReference {
                reference_id: registered.reference_id,
                credential_generation: Some(registered.credential_generation),
            },
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    let destination = crate::workspace_git::tests::repository().await;
    register_project(
        &state.projects_catalog_path,
        "destination".into(),
        "Destination".into(),
        destination
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
    )
    .unwrap();
    write_inspection(&state, "exited", None);
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &state.hmux_identity.executable_path,
        &state.hmux_identity.runtime_executable_path,
        &state.hmux_identity.discovery_root,
    )
    .unwrap();
    (root, destination, state, launcher)
}

fn write_inspection(state: &ServiceState, lifecycle: &str, plan: Option<&Value>) {
    let source = json!({"schema_version": 1, "session_id": "coordinator-session", "workspace_id": "coordinator-workspace",
        "session_class": "managed", "provider_id": "codex", "runner_principal": "coordinator-runner", "runner_instance": "coordinator-instance",
        "channel_epoch": "1", "host_instance_id": "coordinator-host", "terminal_epoch": "coordinator-terminal", "output_seq": "0", "lifecycle": lifecycle,
        "health": if lifecycle == "exited" {"exited"} else {"healthy"}});
    let target = plan.map(|plan| {
        let operation: OperationIdV1 = serde_json::from_value(plan["operationId"].clone()).unwrap();
        let identity = dure_app::agent_runtime_native_launch_identity_v1(&operation);
        let workspace = &plan["workspaceMove"]["targetWorkspace"];
        let generation = json!({"session_id": identity.session_id, "workspace_id": workspace["workspaceId"], "runner_principal": "worker-runner", "runner_instance": "worker-instance", "channel_epoch": "2", "host_instance_id": "worker-host", "terminal_epoch": "worker-terminal", "provider_id": "codex", "conversation_id": CONVERSATION});
        let mut target = generation.clone();
        target.as_object_mut().unwrap().extend(json!({"schema_version": 1, "session_class": "managed", "lifecycle": "ready", "health": "healthy", "output_seq": "0", "providerConversationIdentity": generation,
            "workingDirectory": {"path": workspace["rootPath"], "terminal_epoch": "worker-terminal", "observed_through_output_seq": "0", "source": "launch_fallback"}}).as_object().unwrap().clone());
        target
    }).unwrap_or(Value::Null);
    fs::write(&state.hmux_identity.executable_path, format!("#!/bin/sh\nif [ \"${{6:-}}\" = coordinator-session ]; then printf '%s' '{}'; else printf '%s' '{}'; fi\n", source, target)).unwrap();
}

async fn preview(state: &ServiceState, key: &str) -> Result<Value, BackendDispatchError> {
    project_move::preview(state, serde_json::from_value(json!({"schemaVersion": 1, "agentId": "coordinator-1", "projectId": "destination", "idempotencyKey": key})).unwrap()).await
}
async fn apply(state: &ServiceState, plan: Value) -> Result<Value, BackendDispatchError> {
    project_move::apply(
        state,
        serde_json::from_value(json!({"schemaVersion": 1, "plan": plan, "confirmRestart": true}))
            .unwrap(),
    )
    .await
}

#[tokio::test]
async fn project_move_resumes_exact_history_at_destination_and_replays_one_writer() {
    let (root, destination, mut state, launcher) = setup(vec![LaunchOutcome::Succeed]).await;
    let original = fs::read(destination.path().join(".git/HEAD")).unwrap();
    let planned = preview(&state, "move-success").await.unwrap();
    let plan = planned["plan"].clone();
    assert!(launcher.requests().is_empty());
    write_inspection(&state, "exited", Some(&plan));
    // Rewriting only the fixture executable changes its identity; pin the new fixture before invocation.
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &state.hmux_identity.executable_path,
        &state.hmux_identity.runtime_executable_path,
        &state.hmux_identity.discovery_root,
    )
    .unwrap();
    let result = apply(&state, plan.clone()).await.unwrap();
    assert_eq!(result["receipt"]["providerConversationRef"], CONVERSATION);
    let requests = launcher.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].working_directory,
        destination.path().canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(
        requests[0].provider_conversation_ref.as_deref(),
        Some(CONVERSATION)
    );
    assert_eq!(
        &requests[0].provider_arguments[..2],
        &["--cd".to_owned(), requests[0].working_directory.clone()]
    );
    assert!(requests[0].initial_prompt.is_none());
    assert_eq!(
        fs::read(destination.path().join(".git/HEAD")).unwrap(),
        original
    );
    state.store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite"))
            .await
            .unwrap(),
    );
    assert_eq!(apply(&state, plan.clone()).await.unwrap(), result);
    assert_eq!(launcher.requests().len(), 1);
    let context = serde_json::to_value(
        crate::agent_runtime_projection_context::read_agent(
            &state,
            &AgentIdV1::new("coordinator-1").unwrap(),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(context["workspaceMove"]["operationId"], plan["operationId"]);
    assert_eq!(
        context["workspaceMove"]["sourceAuthority"],
        plan["sourceAuthority"]["authority"]
    );
    state
        .store
        .ensure_agent_identity(
            &dure_app::AgentBootstrapV1 {
                agent_id: AgentIdV1::new("coordinator-1").unwrap(),
                provider_id: ProviderIdV1::new("codex").unwrap(),
                runtime_workspace_id: serde_json::from_value(
                    plan["workspaceMove"]["targetWorkspace"]["workspaceId"].clone(),
                )
                .unwrap(),
                working_directory: plan["workspaceMove"]["targetWorkspace"]["rootPath"]
                    .as_str()
                    .unwrap()
                    .into(),
                display_name: "Moved pane".into(),
            },
            now_ms().unwrap(),
        )
        .await
        .unwrap();
    let agent = state
        .store
        .agent(&AgentIdV1::new("coordinator-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        agent.workspace_id.as_str(),
        plan["workspaceMove"]["targetWorkspace"]["workspaceId"]
            .as_str()
            .unwrap()
    );
}

#[tokio::test]
async fn project_move_rejects_stale_preview_missing_history_and_unproven_stop_before_launch() {
    for boundary in [
        "busy",
        "unknown",
        "history",
        "revision",
        "destination",
        "confirmation",
    ] {
        let (root, destination, mut state, launcher) = setup(Vec::new()).await;
        let planned = preview(&state, "move-refused").await.unwrap();
        let mut plan = planned["plan"].clone();
        match boundary {
            "busy" | "unknown" => {
                write_inspection(
                    &state,
                    if boundary == "busy" {
                        "ready"
                    } else {
                        "unknown"
                    },
                    None,
                );
                state.hmux_identity = resolve_hmux_toolchain_identity(
                    &state.hmux_identity.executable_path,
                    &state.hmux_identity.runtime_executable_path,
                    &state.hmux_identity.discovery_root,
                )
                .unwrap();
            }
            "history" => {
                fs::remove_dir_all(root.path().join("accounts/codex-move/sessions")).unwrap()
            }
            "revision" => plan["source"]["revision"] = json!(9),
            "destination" => {
                fs::rename(destination.path(), root.path().join("retained-destination")).unwrap();
                fs::create_dir(destination.path()).unwrap();
                fs::set_permissions(destination.path(), fs::Permissions::from_mode(0o700)).unwrap();
            }
            _ => {}
        }
        let result = if boundary == "confirmation" {
            project_move::apply(
                &state,
                serde_json::from_value(
                    json!({"schemaVersion": 1, "plan": plan, "confirmRestart": false}),
                )
                .unwrap(),
            )
            .await
        } else {
            apply(&state, plan).await
        };
        assert!(result.is_err(), "{boundary}");
        assert!(launcher.requests().is_empty());
        assert_eq!(
            state
                .store
                .agent(&AgentIdV1::new("coordinator-1").unwrap())
                .await
                .unwrap()
                .unwrap()
                .workspace_id
                .as_str(),
            "workspace-1"
        );
    }
}

#[tokio::test]
async fn project_move_failed_start_keeps_source_workspace_and_journaled_repair() {
    let (_root, _destination, state, launcher) =
        setup(vec![LaunchOutcome::Reject("fixture_start_failed")]).await;
    let plan = preview(&state, "move-failed").await.unwrap()["plan"].clone();
    let error = apply(&state, plan.clone()).await.unwrap_err();
    assert_eq!(error.code, "agent_runtime_repair_required");
    assert_eq!(launcher.requests().len(), 1);
    assert_eq!(
        apply(&state, plan).await.unwrap_err().code,
        "agent_runtime_repair_required"
    );
    assert_eq!(launcher.requests().len(), 1);
    assert_eq!(
        state
            .store
            .agent(&AgentIdV1::new("coordinator-1").unwrap())
            .await
            .unwrap()
            .unwrap()
            .workspace_id
            .as_str(),
        "workspace-1"
    );
}

#[tokio::test]
async fn project_move_failed_start_rolls_back_through_existing_runtime_repair() {
    let (_root, _destination, mut state, launcher) = setup(vec![
        LaunchOutcome::Reject("fixture_start_failed"),
        LaunchOutcome::Succeed,
    ])
    .await;
    let plan = preview(&state, "move-to-rollback").await.unwrap()["plan"].clone();
    assert!(apply(&state, plan.clone()).await.is_err());
    let source = state
        .store
        .agent(&AgentIdV1::new("coordinator-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    let workspace = state
        .store
        .workspace(&source.workspace_id)
        .await
        .unwrap()
        .unwrap();
    let (operation, _) =
        agent_runtime_transition_apply::runtime_transition_identity("move-rollback").unwrap();
    // The fixture reports the repair's replacement at the original source cwd.
    write_inspection(
        &state,
        "exited",
        Some(&json!({"operationId": operation, "workspaceMove": {"targetWorkspace": workspace}})),
    );
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &state.hmux_identity.executable_path,
        &state.hmux_identity.runtime_executable_path,
        &state.hmux_identity.discovery_root,
    )
    .unwrap();
    let receipt = agent_runtime_transition_apply::apply(&state, "move-rollback", serde_json::from_value(json!({"schemaVersion": 1, "agentId": "coordinator-1", "targetInteractionProfile": "native_cli", "expectedSourceRevision": 1})).unwrap()).await.unwrap();
    assert_eq!(
        serde_json::to_value(receipt).unwrap()["providerConversationRef"],
        CONVERSATION
    );
    assert_eq!(launcher.requests().len(), 2);
    assert_eq!(
        launcher.requests()[1].working_directory,
        workspace.root_path
    );
    assert_eq!(
        state
            .store
            .agent(&source.agent_id)
            .await
            .unwrap()
            .unwrap()
            .workspace_id,
        source.workspace_id
    );
    assert_eq!(
        apply(&state, plan).await.unwrap_err().code,
        "agent_runtime_transition_superseded"
    );
    assert_eq!(launcher.requests().len(), 2);
}

#[tokio::test]
async fn project_move_post_start_rejection_retains_target_before_uncertain_cleanup() {
    for boundary in ["registration", "source"] {
        let (_root, _destination, mut state, launcher) = setup(vec![LaunchOutcome::Succeed]).await;
        let plan = preview(&state, "move-post-start").await.unwrap()["plan"].clone();
        write_inspection(&state, "exited", Some(&plan));
        state.hmux_identity = resolve_hmux_toolchain_identity(
            &state.hmux_identity.executable_path,
            &state.hmux_identity.runtime_executable_path,
            &state.hmux_identity.discovery_root,
        )
        .unwrap();
        let pool = sqlx::SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new().filename(state.store.database_path()),
        )
        .await
        .unwrap();
        sqlx::query("CREATE TRIGGER fail_move_commit BEFORE UPDATE ON agent_runtime_transitions WHEN NEW.state = 'committed' BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END")
        .execute(&pool).await.unwrap();
        assert!(apply(&state, plan.clone()).await.is_err());
        let operation: OperationIdV1 = serde_json::from_value(plan["operationId"].clone()).unwrap();
        let started = state
            .store
            .agent_runtime_transition(&operation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            started.state,
            dure_app::AgentRuntimeTransitionStateV1::TargetStarted
        );
        if boundary == "registration" {
            fs::remove_file(&state.projects_catalog_path).unwrap();
        } else {
            sqlx::query("DROP TRIGGER fail_move_commit")
                .execute(&pool)
                .await
                .unwrap();
            let mut agent = state
                .store
                .agent(&started.intent.source.agent_id)
                .await
                .unwrap()
                .unwrap();
            agent.display_name = "Changed source".into();
            state.store.upsert_agent(&agent).await.unwrap();
        }
        for _ in 0..2 {
            assert_eq!(
                apply(&state, plan.clone()).await.unwrap_err().code,
                "agent_runtime_native_target_cleanup_failed"
            );
            let rejected = state
                .store
                .agent_runtime_transition(&operation)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                rejected.state,
                dure_app::AgentRuntimeTransitionStateV1::RepairRequired
            );
            assert_eq!(
                rejected.replacement_authority.unwrap().0,
                started.target_authority.clone().unwrap()
            );
            assert_eq!(
                state
                    .store
                    .agent(&started.intent.source.agent_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .workspace_id,
                started
                    .intent
                    .workspace_move
                    .as_ref()
                    .unwrap()
                    .source_agent
                    .workspace_id
            );
            assert_eq!(launcher.requests().len(), 1);
        }
    }
}
