use super::*;
use agent_runtime_transition_apply::project_move;

const CONVERSATION: &str = "019f0000-0000-7000-8000-000000000185";

async fn setup(outcomes: Vec<LaunchOutcome>) -> (TempDir, TempDir, ServiceState, FakeLauncher) {
    setup_provider(outcomes, "codex").await
}

async fn setup_provider(
    outcomes: Vec<LaunchOutcome>,
    provider: &'static str,
) -> (TempDir, TempDir, ServiceState, FakeLauncher) {
    setup_provider_mode(outcomes, provider, AgentInteractionProfileV1::NativeCli).await
}

async fn setup_provider_mode(
    outcomes: Vec<LaunchOutcome>,
    provider: &'static str,
    mode: AgentInteractionProfileV1,
) -> (TempDir, TempDir, ServiceState, FakeLauncher) {
    let (root, mut state, launcher, _, _) = fixture_with_source_launch_authority(
        outcomes,
        Vec::new(),
        Vec::new(),
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            agent_provider_id: ProviderIdV1::new(provider).unwrap(),
            source_provider_id: provider,
            conversation_id: Some(CONVERSATION.into()),
            credential_reference_id: Some("move-account".into()),
            ..Default::default()
        },
    )
    .await;
    state.agent_providers = Arc::new(provider_extension::test_bundled_provider_registry(
        provider,
        root.path().join("codex-fixture").to_str().unwrap(),
        false,
    ));
    let accounts = root.path().join("accounts");
    fs::create_dir(&accounts).unwrap();
    fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
    let profile_name = format!("{provider}-move");
    let profile = accounts.join(&profile_name);
    fs::create_dir(&profile).unwrap();
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o700)).unwrap();
    if provider == "claude" {
        fs::write(
            root.path().join("codex-fixture"),
            "#!/bin/sh\nprintf '2.1.223 (Claude Code)\\n'\n",
        )
        .unwrap();
        let projects = root.path().join(".claude/projects");
        fs::create_dir_all(projects.join("original-project")).unwrap();
        std::os::unix::fs::symlink(
            fs::canonicalize(projects).unwrap(),
            profile.join("projects"),
        )
        .unwrap();
        fs::write(profile.join(format!("projects/original-project/{CONVERSATION}.jsonl")),
            format!("{{\"type\":\"user\",\"sessionId\":\"{CONVERSATION}\",\"message\":{{\"content\":\"retained context\"}}}}\n")).unwrap();
    } else {
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
    }
    let registered = state
        .credential_profiles
        .register(
            provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                schema_version: 1,
                provider_id: provider.into(),
                reference_id: "move-account".into(),
                profile_directory_name: profile_name,
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
            agent_id: agent.clone(),
            provider_id: ProviderIdV1::new(provider).unwrap(),
            interaction_profile: mode,
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
    if mode == AgentInteractionProfileV1::StructuredProtocol {
        let selection = state
            .store
            .agent_runtime_selection(&agent)
            .await
            .unwrap()
            .unwrap();
        state
            .store
            .create_agent_interaction(&AgentInteractionBindingV1 {
                schema_version: 1,
                interaction_session_id: AgentInteractionSessionIdV1::new("move-interaction")
                    .unwrap(),
                agent_id: agent,
                provider_id: ProviderIdV1::new(provider).unwrap(),
                execution_profile: selection.execution_profile,
                provider_conversation_ref: Some(CONVERSATION.into()),
                runtime: AgentProviderRuntimeFenceV1 {
                    runtime_generation: "move-source".into(),
                    provider_epoch: "source-epoch".into(),
                },
                timeline_epoch: AgentTimelineEpochV1::new("move-timeline").unwrap(),
                binding_revision: 1,
                history_complete: true,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        state.agent_providers = Arc::new(
            provider_extension::test_structured_agent_provider_registry(provider),
        );
    }
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
    write_provider_inspection(&state, provider, "exited", None, None);
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &state.hmux_identity.executable_path,
        &state.hmux_identity.runtime_executable_path,
        &state.hmux_identity.discovery_root,
    )
    .unwrap();
    (root, destination, state, launcher)
}

fn write_inspection(state: &ServiceState, lifecycle: &str, plan: Option<&Value>) {
    write_observed_inspection(state, lifecycle, plan, None);
}

fn write_observed_inspection(
    state: &ServiceState,
    lifecycle: &str,
    plan: Option<&Value>,
    observed: Option<Value>,
) {
    write_provider_inspection(state, "codex", lifecycle, plan, observed);
}

fn write_provider_inspection(
    state: &ServiceState,
    provider: &str,
    lifecycle: &str,
    plan: Option<&Value>,
    observed: Option<Value>,
) {
    let mut source = json!({"schema_version": 1, "session_id": "coordinator-session", "workspace_id": "coordinator-workspace",
        "session_class": "managed", "provider_id": provider, "runner_principal": "coordinator-runner", "runner_instance": "coordinator-instance",
        "channel_epoch": "1", "host_instance_id": "coordinator-host", "terminal_epoch": "coordinator-terminal", "output_seq": "0", "lifecycle": lifecycle,
        "health": if lifecycle == "exited" {"exited"} else {"healthy"}});
    if let Some(observed) = observed {
        source
            .as_object_mut()
            .unwrap()
            .extend(observed.as_object().unwrap().clone());
    }
    let target = plan.map(|plan| {
        let operation: OperationIdV1 = serde_json::from_value(plan["operationId"].clone()).unwrap();
        let identity = dure_app::agent_runtime_native_launch_identity_v1(&operation);
        let workspace = &plan["workspaceMove"]["targetWorkspace"];
        let generation = json!({"session_id": identity.session_id, "workspace_id": workspace["workspaceId"], "runner_principal": "worker-runner", "runner_instance": "worker-instance", "channel_epoch": "2", "host_instance_id": "worker-host", "terminal_epoch": "worker-terminal", "provider_id": provider, "conversation_id": CONVERSATION});
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
    assert!(
        requests[0]
            .provider_arguments
            .windows(2)
            .any(|pair| pair == ["--cd", requests[0].working_directory.as_str()])
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
    let operation: OperationIdV1 = serde_json::from_value(plan["operationId"].clone()).unwrap();
    let journal = state
        .store
        .agent_runtime_transition(&operation)
        .await
        .unwrap()
        .unwrap();
    let inspected = agent_runtime_transition_apply::inspect_repair_intent(
        &state,
        serde_json::from_value(json!({
            "schemaVersion": 1, "agentId": "coordinator-1", "operationId": operation,
            "expectedJournalRevision": journal.journal_revision
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(inspected).unwrap()["workspaceMovePlan"],
        plan
    );
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

fn write_idle_inspection(state: &mut ServiceState, revision: &str, output: &str, pending: bool) {
    write_observed_inspection(
        state,
        "ready",
        None,
        Some(json!({
            "output_seq": output,
            "controllerInputPending": pending,
            "agentRuntimeState": {"terminal_epoch": "coordinator-terminal", "revision": revision,
                "observed_through_output_seq": output, "lifecycle": "running", "activity": "waiting",
                "attention": "none", "attention_id": null, "source": "provider_event", "turn_completed_count": "1"},
            "providerConversationIdentity": {"session_id": "coordinator-session", "workspace_id": "coordinator-workspace",
                "runner_principal": "coordinator-runner", "runner_instance": "coordinator-instance", "channel_epoch": "1",
                "host_instance_id": "coordinator-host", "terminal_epoch": "coordinator-terminal", "revision": "1",
                "observed_through_output_seq": output, "provider_id": "codex", "conversation_id": CONVERSATION, "source": "provider_event"}
        })),
    );
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &state.hmux_identity.executable_path,
        &state.hmux_identity.runtime_executable_path,
        &state.hmux_identity.discovery_root,
    )
    .unwrap();
}

#[tokio::test]
async fn project_move_live_preview_pins_idle_revision_and_output_without_stopping() {
    let (_root, _destination, mut state, launcher) = setup(Vec::new()).await;
    write_idle_inspection(&mut state, "3", "9", false);
    let plan = preview(&state, "move-idle").await.unwrap()["plan"].clone();
    let intent: dure_app::AgentRuntimeTransitionIntentV1 = serde_json::from_value(plan).unwrap();
    assert_eq!(
        intent.source_stop_policy,
        dure_app::AgentRuntimeSourceStopPolicyV1::PreserveObserved {
            runtime_revision: 3,
            observed_through_output_seq: 9,
        }
    );
    assert!(
        state
            .store
            .agent_runtime_transition(&intent.operation_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(launcher.requests().is_empty());
    write_idle_inspection(&mut state, "3", "9", true);
    assert_eq!(
        preview(&state, "move-pending").await.unwrap_err().code,
        "agent_runtime_source_busy"
    );
}

#[tokio::test]
async fn project_move_does_not_substitute_a_later_idle_observation_before_or_after_admission() {
    for admitted in [false, true] {
        for (revision, output) in [("4", "9"), ("3", "10")] {
            let (_root, _destination, mut state, launcher) = setup(Vec::new()).await;
            write_idle_inspection(&mut state, "3", "9", false);
            let plan = preview(&state, "move-idle-stale").await.unwrap()["plan"].clone();
            let intent: dure_app::AgentRuntimeTransitionIntentV1 =
                serde_json::from_value(plan.clone()).unwrap();
            if admitted {
                state
                    .store
                    .admit_agent_runtime_transition(&intent)
                    .await
                    .unwrap();
            }
            write_idle_inspection(&mut state, revision, output, false);
            assert_eq!(
                apply(&state, plan.clone()).await.unwrap_err().code,
                if admitted {
                    "agent_runtime_source_retained"
                } else {
                    "agent_project_move_preview_stale"
                }
            );
            assert!(launcher.requests().is_empty());
            if admitted {
                assert_eq!(
                    apply(&state, plan).await.unwrap_err().code,
                    "agent_runtime_source_retained"
                );
            }
        }
    }
}

#[tokio::test]
async fn claude_project_move_keeps_exact_history_and_account_at_destination_after_reconnect() {
    let (root, destination, mut state, launcher) =
        setup_provider(vec![LaunchOutcome::Succeed], "claude").await;
    let history = root.path().join(format!(
        "accounts/claude-move/projects/original-project/{CONVERSATION}.jsonl"
    ));
    let original = fs::read(&history).unwrap();
    let plan = preview(&state, "claude-move-success").await.unwrap()["plan"].clone();
    assert_eq!(
        plan["source"]["executionProfile"],
        plan["targetExecutionProfile"]
    );
    write_provider_inspection(&state, "claude", "exited", Some(&plan), None);
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &state.hmux_identity.executable_path,
        &state.hmux_identity.runtime_executable_path,
        &state.hmux_identity.discovery_root,
    )
    .unwrap();
    let result = apply(&state, plan.clone()).await.unwrap();
    let requests = launcher.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].provider_id.as_str(), "claude");
    assert_eq!(
        requests[0].provider_conversation_ref.as_deref(),
        Some(CONVERSATION)
    );
    assert_eq!(
        requests[0].working_directory,
        destination.path().canonicalize().unwrap().to_str().unwrap()
    );
    assert!(
        requests[0]
            .provider_arguments
            .windows(2)
            .any(|pair| pair == ["--resume", CONVERSATION])
    );
    assert!(
        !requests[0]
            .provider_arguments
            .iter()
            .any(|argument| argument == "--fork-session")
    );
    assert!(requests[0].initial_prompt.is_none());
    assert_eq!(fs::read(&history).unwrap(), original);
    state.store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite"))
            .await
            .unwrap(),
    );
    assert_eq!(apply(&state, plan).await.unwrap(), result);
    assert_eq!(launcher.requests().len(), 1);
}

#[tokio::test]
async fn claude_project_move_refuses_old_cli_before_any_stop_or_launch() {
    let (root, _destination, state, launcher) = setup_provider(Vec::new(), "claude").await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nprintf '2.1.222 (Claude Code)\\n'\n",
    )
    .unwrap();
    assert_eq!(
        preview(&state, "old-claude").await.unwrap_err().code,
        "agent_project_move_provider_version_unsupported"
    );
    assert!(launcher.requests().is_empty());
}

#[tokio::test]
async fn claude_project_move_refuses_background_auto_attach_versions_before_stop() {
    let (root, _destination, state, launcher) = setup_provider(Vec::new(), "claude").await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nprintf '2.1.285 (Claude Code)\\n'\n",
    )
    .unwrap();
    assert_eq!(
        preview(&state, "background-claude").await.unwrap_err().code,
        "agent_project_move_provider_version_unsupported"
    );
    assert!(launcher.requests().is_empty());
    assert!(
        state
            .store
            .active_agent_runtime_transition(&AgentIdV1::new("coordinator-1").unwrap())
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn installed_launch_wrappers_keep_the_project_move_in_the_provider_argv() {
    for provider in ["claude", "codex"] {
        let (root, destination, mut state, launcher) =
            setup_provider(vec![LaunchOutcome::Succeed], provider).await;
        let fixture = root.path().join("codex-fixture");
        fs::write(
            &fixture,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '2.1.223 (Claude Code)\\n'; else printf '%s\\n' \"$@\"; fi\n",
        )
        .unwrap();
        fs::set_permissions(&fixture, fs::Permissions::from_mode(0o755)).unwrap();
        let integration = if provider == "claude" {
            dure_app::ProviderRuntimeIntegrationV1::SettingsFile {
                path: "/fixture/managed-claude-settings.json".into(),
            }
        } else {
            let wrapper = root.path().join("managed-codex-native.sh");
            fs::write(&wrapper, "#!/bin/sh\nexec \"$@\"\n").unwrap();
            fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
            dure_app::ProviderRuntimeIntegrationV1::CommandWrapper {
                path: wrapper.to_str().unwrap().into(),
            }
        };
        state.agent_providers = Arc::new(provider_extension::test_installed_provider_registry(
            provider,
            fixture.to_str().unwrap(),
            integration,
        ));
        let plan = preview(&state, &format!("{provider}-installed-move"))
            .await
            .unwrap()["plan"]
            .clone();
        write_provider_inspection(&state, provider, "exited", Some(&plan), None);
        state.hmux_identity = resolve_hmux_toolchain_identity(
            &state.hmux_identity.executable_path,
            &state.hmux_identity.runtime_executable_path,
            &state.hmux_identity.discovery_root,
        )
        .unwrap();
        apply(&state, plan).await.unwrap();
        let requests = launcher.requests();
        assert_eq!(requests.len(), 1);
        let output = std::process::Command::new(&requests[0].provider_executable)
            .args(&requests[0].provider_arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{provider}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let argv = String::from_utf8(output.stdout).unwrap();
        let argv = argv.lines().collect::<Vec<_>>();
        let destination = destination.path().canonicalize().unwrap();
        let expected = if provider == "claude" {
            ["--resume", CONVERSATION]
        } else {
            ["--cd", destination.to_str().unwrap()]
        };
        assert!(
            argv.windows(2).any(|pair| pair == expected),
            "{provider} argv: {argv:?}"
        );
    }
}

mod source_busy;
mod structured;
