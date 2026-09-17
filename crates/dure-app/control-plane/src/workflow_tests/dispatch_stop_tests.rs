use super::*;
use std::path::{Path, PathBuf};
use std::process::Command;

use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
    AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1, AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
    AGENT_SPAWN_SCHEMA_VERSION_V1, AgentCheckpointBindingAuthorityV1,
    AgentDispatchStopAuthorizeRequestV1, AgentDispatchStopPlanTokenV1, AgentDispatchStopStore,
    AgentExecutionProfileV1, AgentInteractionBindingV1, AgentInteractionProfileV1,
    AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1, AgentRecordV1,
    AgentRuntimeBindingAuthorityV1, AgentRuntimeCloseAdvanceRequestV1, AgentRuntimeCloseAdvanceV1,
    AgentRuntimeCloseIntentV1, AgentRuntimeCloseStore, AgentRuntimeReplacementAuthorityV1,
    AgentRuntimeSelectionV1, AgentRuntimeSourceStopPolicyV1, AgentRuntimeTransitionIntentV1,
    AgentRuntimeTransitionStore, AgentSpawnAuthorityV1, AgentSpawnJournalEventBodyV1,
    AgentSpawnJournalEventV1, AgentSpawnJournalStore, AgentSpawnLaunchPlanV1,
    AgentSpawnPlanDraftV1, AgentSpawnPreviewRequestV1, AgentSpawnPromptDigestV1,
    AgentSpawnRuntimePlanV1, AgentSpawnStageDispositionV1, AgentSpawnStageEvidenceV1,
    AgentSpawnStageInputsV1, AgentSpawnWorkspaceLeaseV1, AgentSpawnWorktreePolicyV1,
    AgentTimelineEpochV1, AgentTimelineStore, CapabilityIdV1, OperationEventIdV1, OperationIdV1,
    ProjectIdV1, ProjectRecordV1, ProviderIdV1, ProviderPermissionModeV1, RuntimeKindIdV1,
    SessionBindingRecordV1, WorkflowSessionGenerationV1, WorkspaceIdV1, WorkspaceRecordV1,
    create_agent_spawn_plan_v1,
};
use dure_git_checkout::{GitCheckoutCaptureRequestV1, capture_git_checkout_instance};

mod checkout_tests;
mod shell_checkout_tests;

#[derive(Clone, Copy)]
enum SpawnWorkspaceOwnership {
    DureOwned,
    RegisteredDureOwned,
    AdoptedProjectRoot,
}

enum SpawnRuntime {
    Structured,
    Native {
        spawn_session: WorkflowSessionGenerationV1,
        current_authority: Box<AgentCheckpointBindingAuthorityV1>,
    },
}

#[derive(Clone, Copy)]
enum SpawnOutcome {
    Succeeded,
    PromptRetryRequired,
}

struct DispatchStopSeed {
    agent_id: AgentIdV1,
    provider_id: ProviderIdV1,
    spawn_operation_id: OperationIdV1,
    repository: PathBuf,
    checkout: PathBuf,
    spawn_session: Option<WorkflowSessionGenerationV1>,
    current_session: Option<WorkflowSessionGenerationV1>,
}

fn run_git(repository: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: stdout={} stderr={}",
        arguments,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn initialize_repository(
    root: &TempDir,
    checkout_directory_name: &str,
) -> (PathBuf, PathBuf, String) {
    let repository = root.path().join("dispatch-repository");
    fs::create_dir(&repository).unwrap();
    run_git(&repository, &["init", "--initial-branch=main"]);
    run_git(&repository, &["config", "user.name", "Dure Test"]);
    run_git(
        &repository,
        &["config", "user.email", "dure@example.invalid"],
    );
    run_git(&repository, &["config", "commit.gpgsign", "false"]);
    fs::write(repository.join("README.md"), "dispatch stop fixture\n").unwrap();
    run_git(&repository, &["add", "README.md"]);
    run_git(&repository, &["commit", "-m", "fixture"]);
    let base_commit = run_git(&repository, &["rev-parse", "HEAD"]);
    let checkout = repository.join(".worktrees").join(checkout_directory_name);
    let checkout_text = checkout.to_str().unwrap();
    run_git(
        &repository,
        &[
            "worktree",
            "add",
            "-b",
            "agent/dispatch-stop",
            checkout_text,
            "HEAD",
        ],
    );
    (
        repository.canonicalize().unwrap(),
        checkout.canonicalize().unwrap(),
        base_commit,
    )
}

fn spawn_event(
    plan: &dure_app::AgentSpawnPlanV1,
    sequence: u32,
    body: AgentSpawnJournalEventBodyV1,
) -> AgentSpawnJournalEventV1 {
    AgentSpawnJournalEventV1 {
        event_id: OperationEventIdV1::new(format!("dispatch-spawn-event-{sequence}")).unwrap(),
        operation_id: plan.operation_id.clone(),
        sequence,
        plan_token: plan.plan_token.clone(),
        body,
        recorded_at_ms: 100 + i64::from(sequence),
    }
}

async fn seed_dispatch_stop(
    state: &ServiceState,
    root: &TempDir,
    ownership: SpawnWorkspaceOwnership,
) -> DispatchStopSeed {
    seed_dispatch_stop_with_runtime(
        state,
        root,
        ownership,
        SpawnRuntime::Structured,
        SpawnOutcome::Succeeded,
    )
    .await
}

async fn seed_native_dispatch_stop(state: &ServiceState, root: &TempDir) -> DispatchStopSeed {
    seed_native_dispatch_stop_with_outcome(state, root, SpawnOutcome::Succeeded).await
}

async fn seed_retryable_native_dispatch_stop(
    state: &ServiceState,
    root: &TempDir,
) -> DispatchStopSeed {
    seed_native_dispatch_stop_with_outcome(state, root, SpawnOutcome::PromptRetryRequired).await
}

async fn seed_native_dispatch_stop_with_outcome(
    state: &ServiceState,
    root: &TempDir,
    outcome: SpawnOutcome,
) -> DispatchStopSeed {
    let agent_id = AgentIdV1::new("dispatch-agent").unwrap();
    let provider_id = ProviderIdV1::new("codex").unwrap();
    let workspace_id = WorkspaceIdV1::new("dispatch-workspace").unwrap();
    let spawn_session = WorkflowSessionGenerationV1 {
        session_id: "worker-session-rehosted".into(),
        workspace_id: workspace_id.as_str().into(),
        provider_id: provider_id.clone(),
        runner_principal: "dispatch-current-runner".into(),
        runner_instance: "dispatch-current-instance".into(),
        channel_epoch: "1".into(),
        host_instance_id: "dispatch-current-host".into(),
        terminal_epoch: "dispatch-current-terminal".into(),
    };
    let current_authority = AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: SessionBindingRecordV1 {
            agent_id,
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            session_id: "worker-session-rehosted".into(),
            provider_conversation_id: Some("dispatch-conversation-current".into()),
            credential_reference_id: None,
            binding_generation: 2,
            bound_at_ms: 80,
        },
        runtime_workspace_id: workspace_id.as_str().into(),
        runner_principal: "dispatch-current-runner".into(),
        runner_instance: "dispatch-current-instance".into(),
        channel_epoch: "2".into(),
        host_instance_id: "dispatch-current-host".into(),
        terminal_epoch: "dispatch-current-terminal".into(),
        updated_at_ms: 80,
    };
    seed_dispatch_stop_with_runtime(
        state,
        root,
        SpawnWorkspaceOwnership::DureOwned,
        SpawnRuntime::Native {
            spawn_session,
            current_authority: Box::new(current_authority),
        },
        outcome,
    )
    .await
}

async fn seed_dispatch_stop_with_runtime(
    state: &ServiceState,
    root: &TempDir,
    ownership: SpawnWorkspaceOwnership,
    runtime: SpawnRuntime,
    outcome: SpawnOutcome,
) -> DispatchStopSeed {
    let project_id = ProjectIdV1::new("dispatch-project").unwrap();
    let workspace_id = WorkspaceIdV1::new("dispatch-workspace").unwrap();
    let agent_id = AgentIdV1::new("dispatch-agent").unwrap();
    let provider_id = match &runtime {
        SpawnRuntime::Structured => ProviderIdV1::new("provider.codex").unwrap(),
        SpawnRuntime::Native {
            current_authority, ..
        } => {
            assert_eq!(current_authority.binding.agent_id, agent_id);
            ProviderIdV1::new("codex").unwrap()
        }
    };
    let owned_lease =
        AgentSpawnWorkspaceLeaseV1::for_dedicated(&workspace_id, "agent/dispatch-stop").unwrap();
    let (repository, linked_checkout, base_commit) =
        initialize_repository(root, &owned_lease.directory_name);
    let project = project_catalog::register_project(
        &state.projects_catalog_path,
        project_id.as_str().into(),
        "Dispatch project".into(),
        repository.to_string_lossy().into_owned(),
    )
    .unwrap();
    let checkout = match ownership {
        SpawnWorkspaceOwnership::DureOwned | SpawnWorkspaceOwnership::RegisteredDureOwned => {
            linked_checkout
        }
        SpawnWorkspaceOwnership::AdoptedProjectRoot => repository.clone(),
    };
    state
        .store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: repository.to_string_lossy().into_owned(),
            display_name: "Dispatch project".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    state
        .store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: workspace_id.clone(),
            project_id: project_id.clone(),
            root_path: checkout.to_string_lossy().into_owned(),
            base_commit_sha: match ownership {
                SpawnWorkspaceOwnership::DureOwned
                | SpawnWorkspaceOwnership::RegisteredDureOwned => Some(base_commit.clone()),
                SpawnWorkspaceOwnership::AdoptedProjectRoot => None,
            },
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: workspace_id.clone(),
            provider_id: provider_id.clone(),
            display_name: "Dispatch agent".into(),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .await
        .unwrap();

    let (interaction_profile, structured_binding, current_session) = match &runtime {
        SpawnRuntime::Structured => {
            let binding = AgentInteractionBindingV1 {
                schema_version: 1,
                interaction_session_id: AgentInteractionSessionIdV1::new("dispatch-interaction")
                    .unwrap(),
                agent_id: agent_id.clone(),
                provider_id: provider_id.clone(),
                execution_profile: AgentExecutionProfileV1::ProviderDefault,
                provider_conversation_ref: Some("dispatch-conversation".into()),
                runtime: AgentProviderRuntimeFenceV1 {
                    runtime_generation: "dispatch-runtime".into(),
                    provider_epoch: "dispatch-provider".into(),
                },
                timeline_epoch: AgentTimelineEpochV1::new("dispatch-timeline").unwrap(),
                binding_revision: 1,
                history_complete: true,
                created_at_ms: 90,
                updated_at_ms: 90,
            };
            state
                .store
                .create_agent_interaction(&binding)
                .await
                .unwrap();
            (
                AgentInteractionProfileV1::StructuredProtocol,
                Some(binding),
                None,
            )
        }
        SpawnRuntime::Native {
            current_authority, ..
        } => {
            fs::write(
                root.path().join("discovery/current-session.json"),
                serde_json::to_vec(&json!({
                    "schema_version": 1,
                    "session_id": current_authority.binding.session_id,
                    "workspace_id": current_authority.runtime_workspace_id,
                    "session_class": "managed",
                    "lifecycle": "ready",
                    "provider_id": provider_id,
                    "runner_principal": current_authority.runner_principal,
                    "runner_instance": current_authority.runner_instance,
                    "channel_epoch": current_authority.channel_epoch,
                    "host_instance_id": current_authority.host_instance_id,
                    "terminal_epoch": current_authority.terminal_epoch,
                    "health": "healthy",
                }))
                .unwrap(),
            )
            .unwrap();
            state
                .store
                .upsert_agent_checkpoint_binding_authority(current_authority)
                .await
                .unwrap();
            (
                AgentInteractionProfileV1::NativeCli,
                None,
                Some(WorkflowSessionGenerationV1 {
                    session_id: current_authority.binding.session_id.clone(),
                    workspace_id: current_authority.runtime_workspace_id.clone(),
                    provider_id: provider_id.clone(),
                    runner_principal: current_authority.runner_principal.clone(),
                    runner_instance: current_authority.runner_instance.clone(),
                    channel_epoch: current_authority.channel_epoch.clone(),
                    host_instance_id: current_authority.host_instance_id.clone(),
                    terminal_epoch: current_authority.terminal_epoch.clone(),
                }),
            )
        }
    };
    let selection = AgentRuntimeSelectionV1 {
        schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 90,
    };
    state
        .store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();

    let spawn_operation_id = OperationIdV1::new("dispatch-spawn").unwrap();
    let worktree = match ownership {
        SpawnWorkspaceOwnership::DureOwned | SpawnWorkspaceOwnership::RegisteredDureOwned => {
            AgentSpawnWorktreePolicyV1::Dedicated {
                base_commit_sha: base_commit,
                branch: "agent/dispatch-stop".into(),
                branch_mode: Default::default(),
                checkout_path: None,
            }
        }
        SpawnWorkspaceOwnership::AdoptedProjectRoot => AgentSpawnWorktreePolicyV1::ProjectRoot,
    };
    let prompt_digest = matches!(outcome, SpawnOutcome::PromptRetryRequired)
        .then(|| AgentSpawnPromptDigestV1::sha256("dispatch prompt"));
    let spawn = create_agent_spawn_plan_v1(AgentSpawnPlanDraftV1 {
        schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
        operation_id: spawn_operation_id.clone(),
        authority: AgentSpawnAuthorityV1 {
            backend_id: state.descriptor.backend_id.clone(),
            backend_generation: state.descriptor.generation.clone(),
            project_id,
            root_id: project.root_id,
            repository_id: project.repository_id,
        },
        request: AgentSpawnPreviewRequestV1 {
            schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
            idempotency_key: "dispatch-spawn-request".into(),
            project_id: ProjectIdV1::new("dispatch-project").unwrap(),
            provider_id: provider_id.clone(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            agent_name: "dispatch-agent".into(),
            worktree: worktree.clone(),
            provider_conversation_ref: Default::default(),
            permission_mode: ProviderPermissionModeV1::Default,
            prompt_digest: prompt_digest.clone(),
            setup_command: None,
            model: None,
            effort: None,
            interaction_preference: None,
        },
        agent_id: agent_id.clone(),
        workspace_id: workspace_id.clone(),
        launch: match &runtime {
            SpawnRuntime::Structured => AgentSpawnLaunchPlanV1::StructuredProtocol,
            SpawnRuntime::Native { spawn_session, .. } => AgentSpawnLaunchPlanV1::NativeCli {
                session_id: spawn_session.session_id.clone(),
                runtime: AgentSpawnRuntimePlanV1 {
                    runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                    required_capabilities: vec![CapabilityIdV1::new("session.create").unwrap()],
                },
            },
        },
        provider_launch_defaults: None,
    })
    .unwrap();
    let (disposition, lease) = match ownership {
        SpawnWorkspaceOwnership::DureOwned | SpawnWorkspaceOwnership::RegisteredDureOwned => (
            AgentSpawnStageDispositionV1::CreatedDureOwned,
            Some(owned_lease),
        ),
        SpawnWorkspaceOwnership::AdoptedProjectRoot => {
            (AgentSpawnStageDispositionV1::AdoptedExisting, None)
        }
    };
    let (launch_inputs, launch_evidence) = match (&runtime, structured_binding) {
        (SpawnRuntime::Structured, Some(binding)) => (
            AgentSpawnStageInputsV1::StructuredLaunch {
                agent_id: agent_id.clone(),
                workspace_id: workspace_id.clone(),
                provider_id: provider_id.clone(),
                execution_profile: AgentExecutionProfileV1::ProviderDefault,
                provider_conversation_ref: Default::default(),
            },
            AgentSpawnStageEvidenceV1::StructuredLaunch { binding },
        ),
        (SpawnRuntime::Native { spawn_session, .. }, None) => (
            AgentSpawnStageInputsV1::RuntimeLaunch {
                agent_id: agent_id.clone(),
                workspace_id: workspace_id.clone(),
                session_id: spawn_session.session_id.clone(),
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                provider_id: provider_id.clone(),
                provider_conversation_ref: Default::default(),
                permission_mode: spawn.request.permission_mode.clone(),
                setup_command: None,
                model: None,
                effort: None,
            },
            AgentSpawnStageEvidenceV1::RuntimeLaunch {
                session: spawn_session.clone(),
                launch_idempotency_key: None,
                initial_prompt_accepted: false,
            },
        ),
        _ => unreachable!("runtime fixture and launch authority must agree"),
    };
    let mut events = vec![
        spawn_event(
            &spawn,
            1,
            AgentSpawnJournalEventBodyV1::Planned {
                plan: Box::new(spawn.clone()),
            },
        ),
        spawn_event(
            &spawn,
            2,
            AgentSpawnJournalEventBodyV1::StagePrepared {
                attempt: 1,
                inputs: AgentSpawnStageInputsV1::Worktree {
                    workspace_id: workspace_id.clone(),
                    project_root_id: spawn.authority.root_id.clone(),
                    repository_id: spawn.authority.repository_id.clone(),
                    policy: worktree,
                },
            },
        ),
        spawn_event(
            &spawn,
            3,
            AgentSpawnJournalEventBodyV1::StageCommitted {
                attempt: 1,
                evidence: AgentSpawnStageEvidenceV1::Worktree {
                    workspace_id: workspace_id.clone(),
                    disposition,
                    lease,
                },
            },
        ),
        spawn_event(
            &spawn,
            4,
            AgentSpawnJournalEventBodyV1::StagePrepared {
                attempt: 1,
                inputs: launch_inputs,
            },
        ),
        spawn_event(
            &spawn,
            5,
            AgentSpawnJournalEventBodyV1::StageCommitted {
                attempt: 1,
                evidence: launch_evidence,
            },
        ),
    ];
    match outcome {
        SpawnOutcome::Succeeded => {
            events.push(spawn_event(
                &spawn,
                6,
                AgentSpawnJournalEventBodyV1::Succeeded,
            ));
        }
        SpawnOutcome::PromptRetryRequired => {
            let SpawnRuntime::Native { spawn_session, .. } = &runtime else {
                unreachable!("the retryable dispatch-stop fixture uses a native runtime")
            };
            events.extend([
                spawn_event(
                    &spawn,
                    6,
                    AgentSpawnJournalEventBodyV1::StagePrepared {
                        attempt: 1,
                        inputs: AgentSpawnStageInputsV1::PromptDelivery {
                            session_id: spawn_session.session_id.clone(),
                            prompt_digest: prompt_digest
                                .clone()
                                .expect("retryable prompt fixture has a digest"),
                        },
                    },
                ),
                spawn_event(
                    &spawn,
                    7,
                    AgentSpawnJournalEventBodyV1::StageFailed {
                        stage: dure_app::AgentSpawnStageV1::PromptDelivery,
                        attempt: 1,
                        error_code: "hmux_agent_prompt_runtime_changed".into(),
                        error_detail: None,
                        may_have_written: Some(false),
                    },
                ),
            ]);
        }
    }
    if matches!(ownership, SpawnWorkspaceOwnership::RegisteredDureOwned) {
        let registration = dure_git_checkout::claim_git_checkout_registration(
            &checkout,
            &spawn_operation_id,
            None,
        )
        .unwrap()
        .unwrap();
        events.insert(
            2,
            spawn_event(
                &spawn,
                3,
                AgentSpawnJournalEventBodyV1::CheckoutClaimed { registration },
            ),
        );
        for (index, event) in events.iter_mut().enumerate().skip(3) {
            event.sequence = u32::try_from(index + 1).unwrap();
            event.event_id =
                OperationEventIdV1::new(format!("dispatch-spawn-event-{}", event.sequence))
                    .unwrap();
            event.recorded_at_ms = 100 + i64::from(event.sequence);
        }
    }
    for event in events {
        state.store.append_agent_spawn_event(&event).await.unwrap();
    }
    DispatchStopSeed {
        agent_id,
        provider_id,
        spawn_operation_id,
        repository,
        checkout,
        spawn_session: match runtime {
            SpawnRuntime::Structured => None,
            SpawnRuntime::Native { spawn_session, .. } => Some(spawn_session),
        },
        current_session,
    }
}

fn install_runtime(
    state: &mut ServiceState,
    provider_id: ProviderIdV1,
    stop_error: Option<structured_provider_runtime::StructuredProviderRuntimeErrorKindV1>,
) -> Arc<AtomicUsize> {
    let stop_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(BusyStructuredRuntime {
                stop_count: Arc::clone(&stop_count),
                attach_count: Arc::new(AtomicUsize::new(0)),
                stop_error,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    stop_count
}

async fn runtime_close_count(state: &ServiceState, agent_id: &AgentIdV1) -> i64 {
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(state.store.database_path()),
    )
    .await
    .unwrap();
    let count = sqlx::query_scalar("SELECT COUNT(*) FROM agent_runtime_closes WHERE agent_id = ?1")
        .bind(agent_id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    pool.close().await;
    count
}

async fn call_dispatch_stop(
    state: &ServiceState,
    request_id: &str,
    operation: &str,
    body: Value,
) -> Result<Value, BackendDispatchError> {
    let request = dispatch_stop_request(state, request_id, operation, body);
    dispatch_authorized(
        state,
        BackendRequestAuthority {
            backend_id: state.descriptor.backend_id.clone(),
            generation: state.descriptor.generation.clone(),
        },
        &request,
    )
    .await
}

async fn preview_stop(
    state: &ServiceState,
    request_id: &str,
    spawn_operation_id: &OperationIdV1,
) -> Result<Value, BackendDispatchError> {
    call_dispatch_stop(
        state,
        request_id,
        "dispatch.stop.preview",
        json!({
            "schemaVersion": AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            "spawnOperationId": spawn_operation_id,
        }),
    )
    .await
}

async fn preview_stop_with_workspace_disposition(
    state: &ServiceState,
    request_id: &str,
    spawn_operation_id: &OperationIdV1,
    workspace_disposition: &str,
) -> Result<Value, BackendDispatchError> {
    call_dispatch_stop(
        state,
        request_id,
        "dispatch.stop.preview",
        json!({
            "schemaVersion": AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            "spawnOperationId": spawn_operation_id,
            "workspaceDisposition": workspace_disposition,
        }),
    )
    .await
}

fn apply_body(preview: &Value) -> Value {
    json!({
        "schemaVersion": AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
        "operationId": preview["receipt"]["plan"]["operationId"],
        "planToken": preview["receipt"]["plan"]["planToken"],
        "expectedJournalRevision": preview["receipt"]["journalRevision"],
    })
}

fn assert_legacy_remove_owned_receipt_shape(response: &Value) {
    let plan = response["receipt"]["plan"]
        .as_object()
        .expect("stop receipt plan must be an object");
    assert!(plan.contains_key("ownedCheckout"));
    assert!(!plan.contains_key("workspaceDisposition"));
    let spawn = plan["spawn"]
        .as_object()
        .expect("stop receipt spawn must be an object");
    assert!(spawn.contains_key("workspaceId"));
    assert!(spawn.contains_key("lease"));
    assert!(!spawn.contains_key("workspaceOwnership"));
}

fn assert_tagged_preserve_receipt_shape(response: &Value, ownership: &str, has_lease: bool) {
    let plan = response["receipt"]["plan"]
        .as_object()
        .expect("stop receipt plan must be an object");
    assert_eq!(plan["workspaceDisposition"], "preserve");
    assert!(!plan.contains_key("ownedCheckout"));
    let spawn = plan["spawn"]
        .as_object()
        .expect("stop receipt spawn must be an object");
    assert_eq!(spawn["workspaceOwnership"], ownership);
    assert!(spawn.contains_key("workspaceId"));
    assert_eq!(spawn.contains_key("lease"), has_lease);
}

fn native_run_body(seed: &DispatchStopSeed, idempotency_key: &str) -> Value {
    let session = seed
        .current_session
        .as_ref()
        .expect("native stop fixture has a current Session generation");
    json!({
        "schemaVersion": 1,
        "workflowKindRef": "workflow.dispatch-stop-race",
        "task": {
            "summary": "Hold the exact Agent Session",
            "instructions": "Keep this exact Session generation assigned while stop admission is tested."
        },
        "session": session,
        "integrationReceipt": {
            "installRootRef": "install-dispatch-stop-fixture",
            "version": "fixture-v1",
            "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "channel": "test",
            "capabilities": [
                "event_cursor_v1",
                "idempotent_delivery_receipt_v1",
                "interaction_message_v1",
                "interaction_decision_v1",
                "mcp_stdio_v1"
            ]
        },
        "runtimeRef": "runtime.hmux",
        "targetReference": "orchestration.current-session",
        "idempotencyKey": idempotency_key,
        "createdAtMs": 1_050
    })
}

async fn create_native_run(
    state: &ServiceState,
    seed: &DispatchStopSeed,
    request_id: &str,
    idempotency_key: &str,
) -> Result<Value, BackendDispatchError> {
    dispatch(
        state,
        &orchestration_backend_request(
            state,
            request_id,
            "run.create",
            native_run_body(seed, idempotency_key),
        ),
    )
    .await
}

#[tokio::test]
async fn dispatch_stop_preview_is_inert_and_exactly_replays() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id, None);

    let first = preview_stop(&state, "dispatch-preview-1", &seed.spawn_operation_id)
        .await
        .unwrap();
    let replay = preview_stop(&state, "dispatch-preview-1", &seed.spawn_operation_id)
        .await
        .unwrap();

    assert_eq!(first, replay);
    assert_eq!(first["receipt"]["state"]["status"], "planned");
    assert!(seed.checkout.is_dir());
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert!(
        state
            .store
            .effective_agent_runtime_close(&seed.agent_id)
            .await
            .unwrap()
            .is_none(),
        "preview must not admit or drive the child runtime close",
    );
}

#[tokio::test]
async fn dispatch_stop_cancels_an_admitted_replacement_before_stopping_the_source() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);
    let source = state
        .store
        .agent_runtime_selection(&seed.agent_id)
        .await
        .unwrap()
        .unwrap();
    let binding = state
        .store
        .agent_interaction_for_agent(&seed.agent_id)
        .await
        .unwrap()
        .unwrap();
    let transition_id = OperationIdV1::new("dispatch-stop-active-transition").unwrap();
    state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            operation_id: transition_id.clone(),
            idempotency_key: "dispatch-stop-active-transition-key".into(),
            source,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
            source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "dispatch-conversation",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 120,
        })
        .await
        .unwrap();

    let preview = preview_stop_with_workspace_disposition(
        &state,
        "dispatch-stop-active-transition-preview",
        &seed.spawn_operation_id,
        "preserve",
    )
    .await
    .unwrap();

    assert_eq!(preview["receipt"]["state"]["status"], "planned");
    assert_eq!(
        preview["receipt"]["plan"]["runtimeSelection"]["interactionProfile"],
        "structured_protocol"
    );
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        state
            .store
            .agent_runtime_transition(&transition_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::Admitted
    );

    let applied = call_dispatch_stop(
        &state,
        "dispatch-stop-active-transition-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();

    assert_eq!(applied["receipt"]["state"]["status"], "workspace_preserved");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        state
            .store
            .agent_runtime_transition(&transition_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::SourceRetained
    );
}

#[tokio::test]
async fn dispatch_stop_terminalizes_a_source_stopped_transition_without_starting_its_target() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);
    let source = state
        .store
        .agent_runtime_selection(&seed.agent_id)
        .await
        .unwrap()
        .unwrap();
    let binding = state
        .store
        .agent_interaction_for_agent(&seed.agent_id)
        .await
        .unwrap()
        .unwrap();
    let transition_id = OperationIdV1::new("dispatch-stop-source-stopped").unwrap();
    let admitted = state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            operation_id: transition_id.clone(),
            idempotency_key: "dispatch-stop-source-stopped-key".into(),
            source,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
            source_stop_policy: AgentRuntimeSourceStopPolicyV1::Discard,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "dispatch-conversation",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 120,
        })
        .await
        .unwrap();
    state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            operation_id: transition_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 121,
        })
        .await
        .unwrap();

    let preview = preview_stop_with_workspace_disposition(
        &state,
        "dispatch-stop-source-stopped-preview",
        &seed.spawn_operation_id,
        "preserve",
    )
    .await
    .unwrap();
    let observed = state
        .store
        .agent_runtime_transition(&transition_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed.state, AgentRuntimeTransitionStateV1::SourceStopped);

    let applied = call_dispatch_stop(
        &state,
        "dispatch-stop-source-stopped-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();

    assert_eq!(applied["receipt"]["state"]["status"], "workspace_preserved");
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert_eq!(runtime_close_count(&state, &seed.agent_id).await, 1);
    let parked = state
        .store
        .agent_runtime_transition(&transition_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(parked.state, AgentRuntimeTransitionStateV1::RepairRequired);
    assert_eq!(
        parked.target_failure.unwrap().provider_code,
        "agent_dispatch_stop_target_superseded"
    );
}

#[tokio::test]
async fn dispatch_stop_reuses_a_matching_stopped_runtime_tombstone() {
    let (root, state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let source = state
        .store
        .agent_runtime_selection(&seed.agent_id)
        .await
        .unwrap()
        .unwrap();
    let binding = state
        .store
        .agent_interaction_for_agent(&seed.agent_id)
        .await
        .unwrap()
        .unwrap();
    let close = state
        .store
        .admit_agent_runtime_close(&AgentRuntimeCloseIntentV1 {
            schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
            operation_id: OperationIdV1::new("dispatch-stop-external-close").unwrap(),
            idempotency_key: "dispatch-stop-external-close-key".into(),
            requested_at_ms: source.updated_at_ms + 10,
            source,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
            stopped_transition: None,
        })
        .await
        .unwrap();
    state
        .store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
            operation_id: close.intent.operation_id.clone(),
            expected_journal_revision: close.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: close.updated_at_ms + 1,
        })
        .await
        .unwrap();

    let preview = preview_stop_with_workspace_disposition(
        &state,
        "dispatch-stop-after-external-close",
        &seed.spawn_operation_id,
        "preserve",
    )
    .await
    .unwrap();

    let applied = call_dispatch_stop(
        &state,
        "dispatch-stop-apply-external-close",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();

    assert_eq!(applied["receipt"]["state"]["status"], "workspace_preserved");
    assert_eq!(runtime_close_count(&state, &seed.agent_id).await, 1);
}

#[tokio::test]
async fn dispatch_stop_closes_an_exact_repair_required_transition() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let source = state
        .store
        .agent_runtime_selection(&seed.agent_id)
        .await
        .unwrap()
        .unwrap();
    let binding = state
        .store
        .agent_interaction_for_agent(&seed.agent_id)
        .await
        .unwrap()
        .unwrap();
    let transition_id = OperationIdV1::new("dispatch-stop-repair-required").unwrap();
    let admitted = state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            operation_id: transition_id.clone(),
            idempotency_key: "dispatch-stop-repair-required-key".into(),
            source,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
            source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "dispatch-conversation",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 120,
        })
        .await
        .unwrap();
    let stopped = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            operation_id: transition_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 121,
        })
        .await
        .unwrap();
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: source } =
        &stopped.intent.source_authority
    else {
        unreachable!()
    };
    let mut failed = source.clone();
    failed.execution_profile = stopped.intent.target_execution_profile.clone();
    failed.runtime = AgentProviderRuntimeFenceV1 {
        runtime_generation: "dispatch-repair-failed-runtime".into(),
        provider_epoch: "dispatch-repair-failed-provider".into(),
    };
    failed.binding_revision += 1;
    failed.updated_at_ms = 121;
    state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            operation_id: transition_id,
            expected_journal_revision: stopped.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: AgentRuntimeTargetFailureV1::new(
                    AgentRuntimeTargetFailureKindV1::CredentialUnavailable,
                    "dispatch_stop_target_unavailable",
                )
                .unwrap(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::Replace {
                    authority: Some(Box::new(AgentRuntimeReplacementAuthorityV1(
                        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: failed },
                    ))),
                },
            },
            advanced_at_ms: 122,
        })
        .await
        .unwrap();
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);

    let preview = preview_stop_with_workspace_disposition(
        &state,
        "dispatch-stop-repair-required-preview",
        &seed.spawn_operation_id,
        "preserve",
    )
    .await
    .unwrap();
    let applied = call_dispatch_stop(
        &state,
        "dispatch-stop-repair-required-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();

    assert_eq!(applied["receipt"]["state"]["status"], "workspace_preserved");
    assert_eq!(runtime_close_count(&state, &seed.agent_id).await, 1);
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn exited_native_runtime_converges_past_a_stale_active_dispatch() {
    let (root, state, _, _) = fixture(Vec::new()).await;
    let seed = seed_native_dispatch_stop(&state, &root).await;
    let spawn_session = seed.spawn_session.as_ref().unwrap();
    let current_session = seed.current_session.as_ref().unwrap();

    create_native_run(
        &state,
        &seed,
        "dispatch-stop-run-before-preview",
        "dispatch-stop-run-before-preview",
    )
    .await
    .unwrap();
    let descriptor = state
        .hmux_identity
        .discovery_root
        .join("current-session.json");
    let mut exited: Value = serde_json::from_slice(&fs::read(&descriptor).unwrap()).unwrap();
    exited["lifecycle"] = json!("exited");
    exited["health"] = json!("exited");
    exited["output_seq"] = json!("0");
    exited["agentRuntimeState"] = Value::Null;
    exited["providerConversationIdentity"] = Value::Null;
    fs::write(descriptor, serde_json::to_vec(&exited).unwrap()).unwrap();
    let stale = invoke_orchestration(
        &state,
        "dispatch-stop-inspect-stale-spawn-session",
        "dispatch.session.inspect",
        json!({ "schemaVersion": 1, "session": spawn_session }),
    )
    .await;
    assert_eq!(stale["receipt"]["outcome"], "unassigned");
    let current = invoke_orchestration(
        &state,
        "dispatch-stop-inspect-current-session",
        "dispatch.session.inspect",
        json!({ "schemaVersion": 1, "session": current_session }),
    )
    .await;
    assert_eq!(current["receipt"]["outcome"], "active_dispatch");

    let preview = preview_stop(
        &state,
        "dispatch-stop-active-run-preview",
        &seed.spawn_operation_id,
    )
    .await
    .unwrap();
    let applied = call_dispatch_stop(
        &state,
        "dispatch-stop-active-run-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();

    assert_eq!(applied["receipt"]["state"]["status"], "succeeded");
    assert_eq!(runtime_close_count(&state, &seed.agent_id).await, 1);
    assert!(!seed.checkout.exists());
}

#[tokio::test]
async fn retryable_spawn_with_a_committed_runtime_can_be_stopped_without_resuming() {
    let (root, state, _, _) = fixture(Vec::new()).await;
    let seed = seed_retryable_native_dispatch_stop(&state, &root).await;
    let spawn = state
        .store
        .agent_spawn_receipt(&seed.spawn_operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        spawn.state,
        dure_app::AgentSpawnJournalStateV1::RetryRequired
    );

    let preview = preview_stop_with_workspace_disposition(
        &state,
        "dispatch-stop-retryable-spawn",
        &seed.spawn_operation_id,
        "preserve",
    )
    .await
    .unwrap();
    let retry_error = apply_agent_spawn(
        &state,
        &BackendRequestAuthority {
            backend_id: state.descriptor.backend_id.clone(),
            generation: state.descriptor.generation.clone(),
        },
        agent_spawn_apply::AgentSpawnApplyBody {
            schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
            operation_id: spawn.operation_id,
            plan_token: spawn.plan.plan_token,
            expected_last_sequence: spawn.last_sequence,
            prompt: Some("dispatch prompt".into()),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(retry_error.code, "agent_spawn_stop_in_progress");

    let applied = call_dispatch_stop(
        &state,
        "dispatch-stop-retryable-spawn-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();
    assert_eq!(applied["receipt"]["state"]["status"], "source_retained");
    assert!(seed.checkout.is_dir());
}

#[tokio::test]
async fn live_runtime_without_exact_stop_receipt_is_retained_by_runtime_close() {
    let (root, state, _, _) = fixture(Vec::new()).await;
    let seed = seed_native_dispatch_stop(&state, &root).await;
    let preview = preview_stop(
        &state,
        "dispatch-stop-preview-before-run",
        &seed.spawn_operation_id,
    )
    .await
    .unwrap();
    create_native_run(
        &state,
        &seed,
        "dispatch-stop-run-after-preview",
        "dispatch-stop-run-after-preview",
    )
    .await
    .unwrap();
    let preview_replay = preview_stop(
        &state,
        "dispatch-stop-preview-before-run",
        &seed.spawn_operation_id,
    )
    .await
    .unwrap();
    assert_eq!(preview_replay, preview);

    let applied = call_dispatch_stop(
        &state,
        "dispatch-stop-apply-after-run",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();

    assert_eq!(applied["receipt"]["state"]["status"], "source_retained");
    assert_eq!(runtime_close_count(&state, &seed.agent_id).await, 1);
    assert!(
        seed.checkout.is_dir(),
        "workspace removal waits for exact exited evidence",
    );
}

#[tokio::test]
async fn runtime_close_rejects_a_stop_planned_for_a_replaced_native_generation() {
    let (root, state, _, _) = fixture(Vec::new()).await;
    let seed = seed_native_dispatch_stop(&state, &root).await;
    let preview = preview_stop(
        &state,
        "dispatch-stop-preview-before-native-successor",
        &seed.spawn_operation_id,
    )
    .await
    .unwrap();
    let mut successor = state
        .store
        .agent_checkpoint_binding_authority(&seed.agent_id)
        .await
        .unwrap()
        .unwrap();
    successor.binding.session_id = "worker-session-successor".into();
    successor.binding.binding_generation += 1;
    successor.binding.bound_at_ms += 1;
    successor.terminal_epoch = "dispatch-successor-terminal".into();
    successor.updated_at_ms += 1;
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&successor)
        .await
        .unwrap();

    let error = call_dispatch_stop(
        &state,
        "dispatch-stop-apply-after-native-successor",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap_err();

    assert_eq!(error.code, "agent_dispatch_stop_conflict");
    assert_eq!(
        error.disposition,
        BackendFailureDispositionV1::StaleGeneration
    );
    assert_eq!(runtime_close_count(&state, &seed.agent_id).await, 0);
    assert!(seed.checkout.is_dir());
}

#[tokio::test]
async fn terminal_stop_exactly_replays_after_its_retained_session_becomes_active() {
    let (root, state, _, _) = fixture(Vec::new()).await;
    let seed = seed_native_dispatch_stop(&state, &root).await;
    let preview = preview_stop(
        &state,
        "dispatch-stop-terminal-replay",
        &seed.spawn_operation_id,
    )
    .await
    .unwrap();
    let body = apply_body(&preview);
    let applied = call_dispatch_stop(
        &state,
        "dispatch-stop-terminal-replay-apply",
        "dispatch.stop.apply",
        body.clone(),
    )
    .await
    .unwrap();
    assert_eq!(applied["receipt"]["state"]["status"], "source_retained");
    create_native_run(
        &state,
        &seed,
        "dispatch-stop-run-after-terminal",
        "dispatch-stop-run-after-terminal",
    )
    .await
    .unwrap();

    let replay = call_dispatch_stop(
        &state,
        "dispatch-stop-terminal-replay-apply-again",
        "dispatch.stop.apply",
        body,
    )
    .await
    .unwrap();

    assert_eq!(replay, applied);
}

#[tokio::test]
async fn exact_run_create_replays_after_runtime_close_admission() {
    let (root, state, _, _) = fixture(Vec::new()).await;
    let seed = seed_native_dispatch_stop(&state, &root).await;
    let first = create_native_run(
        &state,
        &seed,
        "dispatch-stop-run-before-close",
        "dispatch-stop-run-before-close",
    )
    .await
    .unwrap();
    let selection = state
        .store
        .agent_runtime_selection(&seed.agent_id)
        .await
        .unwrap()
        .unwrap();
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&seed.agent_id)
        .await
        .unwrap()
        .unwrap();
    state
        .store
        .admit_agent_runtime_close(&AgentRuntimeCloseIntentV1 {
            schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
            operation_id: OperationIdV1::new("dispatch-stop-run-replay-close").unwrap(),
            idempotency_key: "dispatch-stop-run-replay-close".into(),
            source: selection,
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli { authority },
            stopped_transition: None,
            requested_at_ms: 1_051,
        })
        .await
        .unwrap();

    let replay = create_native_run(
        &state,
        &seed,
        "dispatch-stop-run-before-close-replay",
        "dispatch-stop-run-before-close",
    )
    .await
    .unwrap();

    assert_eq!(replay["receipt"]["idempotent"], true);
    assert_eq!(replay["receipt"]["context"], first["receipt"]["context"]);
}

#[tokio::test]
async fn authorized_stop_blocks_a_later_run_creation_atomically() {
    let (root, state, _, _) = fixture(Vec::new()).await;
    let seed = seed_native_dispatch_stop(&state, &root).await;
    let preview = preview_stop(
        &state,
        "dispatch-stop-authorize-before-run",
        &seed.spawn_operation_id,
    )
    .await
    .unwrap();
    let operation_id: OperationIdV1 =
        serde_json::from_value(preview["receipt"]["plan"]["operationId"].clone()).unwrap();
    let planned = state
        .store
        .agent_dispatch_stop(&operation_id)
        .await
        .unwrap()
        .unwrap();
    state
        .store
        .authorize_agent_dispatch_stop(&AgentDispatchStopAuthorizeRequestV1 {
            schema_version: AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            operation_id,
            plan_token: planned.plan().plan_token().clone(),
            expected_journal_revision: planned.journal_revision(),
            runtime_close_intent: AgentRuntimeCloseIntentV1 {
                schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
                operation_id: OperationIdV1::new("dispatch-stop-authorized-child").unwrap(),
                idempotency_key: "dispatch-stop-authorized-child".into(),
                source: planned.plan().runtime_selection().clone(),
                source_authority: planned.plan().runtime_authority().clone(),
                stopped_transition: None,
                requested_at_ms: planned.plan().planned_at_ms(),
            },
            authorized_at_ms: planned.plan().planned_at_ms(),
        })
        .await
        .unwrap();

    let error = create_native_run(
        &state,
        &seed,
        "dispatch-stop-run-after-authorize",
        "dispatch-stop-run-after-authorize",
    )
    .await
    .unwrap_err();

    assert_eq!(error.code, "orchestration_state_conflict");
    assert_eq!(
        error.details,
        Some(json!({ "reasonCode": "agent_runtime_not_open" }))
    );
    assert!(seed.checkout.is_dir());
    let inspection = invoke_orchestration(
        &state,
        "dispatch-stop-inspect-after-run-refusal",
        "dispatch.session.inspect",
        json!({ "schemaVersion": 1, "session": seed.current_session }),
    )
    .await;
    assert_eq!(inspection["receipt"]["outcome"], "unassigned");
}

#[tokio::test]
async fn fresh_exact_preview_supersedes_a_stale_plan_without_effects() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);
    let preview = preview_stop(
        &state,
        "dispatch-stop-before-runtime-successor",
        &seed.spawn_operation_id,
    )
    .await
    .unwrap();
    let source = state
        .store
        .agent_interaction_for_agent(&seed.agent_id)
        .await
        .unwrap()
        .unwrap();
    state
        .store
        .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
            schema_version: 1,
            interaction_session_id: source.interaction_session_id.clone(),
            expected_binding_revision: source.binding_revision,
            source: source.runtime.clone(),
            source_execution_profile: source.execution_profile.clone(),
            target: AgentProviderRuntimeFenceV1 {
                runtime_generation: "dispatch-runtime-successor".into(),
                provider_epoch: "dispatch-provider-successor".into(),
            },
            target_execution_profile: source.execution_profile.clone(),
            provider_conversation_ref: Some("dispatch-conversation-successor".into()),
            replaced_at_ms: source.updated_at_ms + 1,
        })
        .await
        .unwrap();

    let stale_body = apply_body(&preview);
    let stale_error = call_dispatch_stop(
        &state,
        "dispatch-stop-stale-before-successor-preview",
        "dispatch.stop.apply",
        stale_body.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(stale_error.code, "agent_dispatch_stop_conflict");
    assert_eq!(
        stale_error.disposition,
        BackendFailureDispositionV1::StaleGeneration
    );
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert_eq!(runtime_close_count(&state, &seed.agent_id).await, 0);
    assert!(seed.checkout.is_dir());

    let fresh = preview_stop(
        &state,
        "dispatch-stop-after-runtime-successor",
        &seed.spawn_operation_id,
    )
    .await
    .unwrap();
    assert_eq!(fresh["receipt"]["state"]["status"], "planned");

    let stale_preview_replay = preview_stop(
        &state,
        "dispatch-stop-before-runtime-successor",
        &seed.spawn_operation_id,
    )
    .await
    .unwrap();
    assert_eq!(
        stale_preview_replay["receipt"]["state"]["status"],
        "superseded"
    );

    let superseded = call_dispatch_stop(
        &state,
        "dispatch-stop-superseded-replay",
        "dispatch.stop.apply",
        stale_body.clone(),
    )
    .await
    .unwrap();
    assert_eq!(superseded["receipt"]["state"]["status"], "superseded");
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert!(seed.checkout.is_dir());
    assert_eq!(runtime_close_count(&state, &seed.agent_id).await, 0);

    let status = call_dispatch_stop(
        &state,
        "dispatch-stop-status-prefers-fresh-plan",
        "dispatch.stop.status",
        json!({
            "schemaVersion": AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            "spawnOperationId": seed.spawn_operation_id,
        }),
    )
    .await
    .unwrap();
    assert_eq!(status["receipt"], fresh["receipt"]);

    let database_path = root.path().join("domain.sqlite");
    let (mut reopened, _) = reopen_fixture_service_state(&state, &database_path).await;
    let restarted_stop_count = install_runtime(&mut reopened, seed.provider_id, None);
    let replay = call_dispatch_stop(
        &reopened,
        "dispatch-stop-stale-response-lost",
        "dispatch.stop.apply",
        stale_body,
    )
    .await
    .unwrap();
    assert_eq!(replay, superseded);
    assert_eq!(restarted_stop_count.load(Ordering::SeqCst), 0);
    assert!(seed.checkout.is_dir());

    let restarted_status = call_dispatch_stop(
        &reopened,
        "dispatch-stop-status-after-superseded-restart",
        "dispatch.stop.status",
        json!({
            "schemaVersion": AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            "spawnOperationId": seed.spawn_operation_id,
        }),
    )
    .await
    .unwrap();
    assert_eq!(restarted_status["receipt"], fresh["receipt"]);

    let applied = call_dispatch_stop(
        &reopened,
        "dispatch-stop-fresh-successor-apply",
        "dispatch.stop.apply",
        apply_body(&fresh),
    )
    .await
    .unwrap();
    assert_eq!(applied["receipt"]["state"]["status"], "succeeded");
    assert_eq!(restarted_stop_count.load(Ordering::SeqCst), 1);
    assert!(!seed.checkout.exists());
}

#[tokio::test]
async fn dispatch_stop_apply_and_status_exactly_replay_after_restart() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id, None);
    let preview = preview_stop(&state, "dispatch-apply-replay", &seed.spawn_operation_id)
        .await
        .unwrap();
    assert_legacy_remove_owned_receipt_shape(&preview);
    let body = apply_body(&preview);

    let applied = call_dispatch_stop(
        &state,
        "dispatch-apply-response-lost",
        "dispatch.stop.apply",
        body.clone(),
    )
    .await
    .unwrap();
    assert_legacy_remove_owned_receipt_shape(&applied);
    assert_eq!(applied["receipt"]["state"]["status"], "succeeded");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert!(!seed.checkout.exists());

    let database_path = root.path().join("domain.sqlite");
    let (reopened, _) = reopen_fixture_service_state(&state, &database_path).await;
    let status = call_dispatch_stop(
        &reopened,
        "dispatch-status-after-restart",
        "dispatch.stop.status",
        json!({
            "schemaVersion": AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            "spawnOperationId": seed.spawn_operation_id,
        }),
    )
    .await
    .unwrap();
    assert_legacy_remove_owned_receipt_shape(&status);
    assert_eq!(status["receipt"], applied["receipt"]);

    let replay = call_dispatch_stop(
        &reopened,
        "dispatch-apply-retry-after-restart",
        "dispatch.stop.apply",
        body,
    )
    .await
    .unwrap();
    assert_legacy_remove_owned_receipt_shape(&replay);
    assert_eq!(replay, applied);
    let preview_replay = preview_stop(&reopened, "dispatch-apply-replay", &seed.spawn_operation_id)
        .await
        .unwrap();
    assert_legacy_remove_owned_receipt_shape(&preview_replay);
    assert_eq!(preview_replay["receipt"], applied["receipt"]);
}

#[tokio::test]
async fn preview_wire_shape_preserves_legacy_remove_owned_and_tags_preserve() {
    {
        let (root, state, _, _) = fixture(Vec::new()).await;
        let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
        let preview = preview_stop(&state, "dispatch-shape-default", &seed.spawn_operation_id)
            .await
            .unwrap();
        assert_legacy_remove_owned_receipt_shape(&preview);
    }

    {
        let (root, state, _, _) = fixture(Vec::new()).await;
        let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
        let preview = preview_stop_with_workspace_disposition(
            &state,
            "dispatch-shape-remove-owned",
            &seed.spawn_operation_id,
            "remove_owned",
        )
        .await
        .unwrap();
        assert_legacy_remove_owned_receipt_shape(&preview);
    }

    {
        let (root, state, _, _) = fixture(Vec::new()).await;
        let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
        let preview = preview_stop_with_workspace_disposition(
            &state,
            "dispatch-shape-preserve",
            &seed.spawn_operation_id,
            "preserve",
        )
        .await
        .unwrap();
        assert_tagged_preserve_receipt_shape(&preview, "dure_owned", true);
    }
}

#[tokio::test]
async fn dispatch_stop_apply_serializes_plan_to_authorize_on_the_agent_lock() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id, None);
    let preview = preview_stop(&state, "dispatch-lock", &seed.spawn_operation_id)
        .await
        .unwrap();
    let request = dispatch_stop_request(
        &state,
        "dispatch-lock-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    );
    let state = Arc::new(state);
    let guard = state.agent_operations.acquire(&seed.agent_id).await;
    let apply_state = Arc::clone(&state);
    let apply = tokio::spawn(async move {
        dispatch_authorized(
            &apply_state,
            BackendRequestAuthority {
                backend_id: apply_state.descriptor.backend_id.clone(),
                generation: apply_state.descriptor.generation.clone(),
            },
            &request,
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(
        !apply.is_finished(),
        "authorization must wait for the existing per-Agent operation lock",
    );
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);

    drop(guard);
    let applied = apply.await.unwrap().unwrap();
    assert_eq!(applied["receipt"]["state"]["status"], "succeeded");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn source_retained_terminal_preserves_the_owned_checkout() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let stop_count = install_runtime(
        &mut state,
        seed.provider_id,
        Some(structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::SourceBusy),
    );
    let preview = preview_stop(&state, "dispatch-source-retained", &seed.spawn_operation_id)
        .await
        .unwrap();

    let applied = call_dispatch_stop(
        &state,
        "dispatch-source-retained-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();

    assert_eq!(applied["receipt"]["state"]["status"], "source_retained",);
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert!(seed.checkout.is_dir());
    assert!(
        state
            .store
            .effective_agent_runtime_close(&seed.agent_id)
            .await
            .unwrap()
            .is_none(),
        "source-retained history must leave the selected runtime open",
    );
}

#[tokio::test]
async fn checkout_replacement_preserves_the_same_path_successor() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id, None);
    let preview = preview_stop(
        &state,
        "dispatch-checkout-replaced",
        &seed.spawn_operation_id,
    )
    .await
    .unwrap();

    run_git(
        &seed.repository,
        &["worktree", "remove", seed.checkout.to_str().unwrap()],
    );
    run_git(
        &seed.repository,
        &[
            "worktree",
            "add",
            "-b",
            "agent/dispatch-successor",
            seed.checkout.to_str().unwrap(),
            "HEAD",
        ],
    );
    let successor = capture_git_checkout_instance(&GitCheckoutCaptureRequestV1 {
        repository_path: seed.repository.to_string_lossy().into_owned(),
        checkout_path: seed.checkout.to_string_lossy().into_owned(),
    })
    .unwrap();
    assert_ne!(
        successor.instance_token,
        preview["receipt"]["plan"]["ownedCheckout"]["instance"]["instanceToken"]
            .as_str()
            .unwrap(),
    );

    let applied = call_dispatch_stop(
        &state,
        "dispatch-checkout-replaced-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();

    assert_eq!(applied["receipt"]["state"]["status"], "workspace_replaced",);
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert!(seed.checkout.is_dir());
    assert_eq!(
        run_git(&seed.checkout, &["branch", "--show-current"]),
        "agent/dispatch-successor",
    );
}

#[tokio::test]
async fn preserve_stops_a_dure_owned_agent_without_observing_or_removing_git() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let stop_count = install_runtime(&mut state, seed.provider_id, None);
    let git_metadata = seed.repository.join(".git");
    let unavailable_git_metadata = seed.repository.join(".git-unavailable");
    fs::rename(&git_metadata, &unavailable_git_metadata).unwrap();

    let preview = preview_stop_with_workspace_disposition(
        &state,
        "dispatch-preserve-owned",
        &seed.spawn_operation_id,
        "preserve",
    )
    .await
    .unwrap();
    let applied = call_dispatch_stop(
        &state,
        "dispatch-preserve-owned-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();

    assert_eq!(applied["receipt"]["state"]["status"], "workspace_preserved");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(runtime_close_count(&state, &seed.agent_id).await, 1);
    assert!(seed.checkout.is_dir());
    assert!(unavailable_git_metadata.is_dir());
}

#[tokio::test]
async fn preserve_stops_an_adopted_project_root_without_observing_or_removing_git() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::AdoptedProjectRoot).await;
    let stop_count = install_runtime(&mut state, seed.provider_id.clone(), None);
    let git_metadata = seed.repository.join(".git");
    let unavailable_git_metadata = seed.repository.join(".git-unavailable");
    fs::rename(&git_metadata, &unavailable_git_metadata).unwrap();

    let preview = preview_stop_with_workspace_disposition(
        &state,
        "dispatch-preserve-adopted",
        &seed.spawn_operation_id,
        "preserve",
    )
    .await
    .unwrap();
    assert_tagged_preserve_receipt_shape(&preview, "adopted_project_root", false);

    let applied = call_dispatch_stop(
        &state,
        "dispatch-preserve-adopted-apply",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();

    assert_tagged_preserve_receipt_shape(&applied, "adopted_project_root", false);
    assert_eq!(applied["receipt"]["state"]["status"], "workspace_preserved");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(runtime_close_count(&state, &seed.agent_id).await, 1);
    assert!(seed.checkout.is_dir());
    assert!(unavailable_git_metadata.is_dir());
    assert!(
        state
            .store
            .agent_dispatch_stop_for_spawn_operation(&seed.spawn_operation_id)
            .await
            .unwrap()
            .is_some(),
    );

    let status = call_dispatch_stop(
        &state,
        "dispatch-preserve-adopted-status",
        "dispatch.stop.status",
        json!({
            "schemaVersion": AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            "spawnOperationId": seed.spawn_operation_id,
        }),
    )
    .await
    .unwrap();
    assert_tagged_preserve_receipt_shape(&status, "adopted_project_root", false);
    assert_eq!(status["receipt"], applied["receipt"]);

    let database_path = root.path().join("domain.sqlite");
    let (mut reopened, _) = reopen_fixture_service_state(&state, &database_path).await;
    let replay_stop_count = install_runtime(&mut reopened, seed.provider_id, None);
    let replay = call_dispatch_stop(
        &reopened,
        "dispatch-preserve-adopted-replay",
        "dispatch.stop.apply",
        apply_body(&preview),
    )
    .await
    .unwrap();
    assert_tagged_preserve_receipt_shape(&replay, "adopted_project_root", false);
    assert_eq!(replay, applied);
    assert_eq!(replay_stop_count.load(Ordering::SeqCst), 0);
    assert_eq!(runtime_close_count(&reopened, &seed.agent_id).await, 1);
    assert!(seed.checkout.is_dir());
    assert!(unavailable_git_metadata.is_dir());
}

#[tokio::test]
async fn remove_owned_refuses_an_adopted_project_root_without_effects() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::AdoptedProjectRoot).await;
    let stop_count = install_runtime(&mut state, seed.provider_id, None);

    let error = preview_stop(&state, "dispatch-remove-adopted", &seed.spawn_operation_id)
        .await
        .unwrap_err();

    assert_eq!(error.code, "agent_dispatch_stop_ownership_unsupported");
    assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert_eq!(runtime_close_count(&state, &seed.agent_id).await, 0);
    assert!(seed.checkout.is_dir());
    assert!(
        state
            .store
            .agent_dispatch_stop_for_spawn_operation(&seed.spawn_operation_id)
            .await
            .unwrap()
            .is_none(),
    );
}

#[tokio::test]
async fn the_same_preview_request_cannot_replay_another_workspace_disposition() {
    let (root, state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    let preserve = preview_stop_with_workspace_disposition(
        &state,
        "dispatch-stop-disposition-cas",
        &seed.spawn_operation_id,
        "preserve",
    )
    .await
    .unwrap();

    let error = preview_stop(
        &state,
        "dispatch-stop-disposition-cas",
        &seed.spawn_operation_id,
    )
    .await
    .unwrap_err();

    assert_eq!(error.code, "agent_dispatch_stop_conflict");
    assert_eq!(
        error.disposition,
        BackendFailureDispositionV1::StaleGeneration
    );
    assert_eq!(preserve["receipt"]["state"]["status"], "planned");
    assert_eq!(runtime_close_count(&state, &seed.agent_id).await, 0);
    assert!(seed.checkout.is_dir());
}

#[tokio::test]
async fn restart_recovery_drives_the_authorized_parent_before_its_child_projection() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    install_runtime(&mut state, seed.provider_id.clone(), None);
    let preview = preview_stop(&state, "dispatch-recovery", &seed.spawn_operation_id)
        .await
        .unwrap();
    let operation_id: OperationIdV1 =
        serde_json::from_value(preview["receipt"]["plan"]["operationId"].clone()).unwrap();
    let plan_token: AgentDispatchStopPlanTokenV1 =
        serde_json::from_value(preview["receipt"]["plan"]["planToken"].clone()).unwrap();
    let planned = state
        .store
        .agent_dispatch_stop(&operation_id)
        .await
        .unwrap()
        .unwrap();
    let (_, authorized_child) = state
        .store
        .authorize_agent_dispatch_stop(&AgentDispatchStopAuthorizeRequestV1 {
            schema_version: AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            operation_id: operation_id.clone(),
            plan_token,
            expected_journal_revision: planned.journal_revision(),
            runtime_close_intent: AgentRuntimeCloseIntentV1 {
                schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
                operation_id: OperationIdV1::new("dispatch-recovery-child").unwrap(),
                idempotency_key: "dispatch-recovery-child".into(),
                source: planned.plan().runtime_selection().clone(),
                source_authority: planned.plan().runtime_authority().clone(),
                stopped_transition: None,
                requested_at_ms: planned.plan().planned_at_ms(),
            },
            authorized_at_ms: planned.plan().planned_at_ms(),
        })
        .await
        .unwrap();

    let database_path = root.path().join("domain.sqlite");
    let (mut reopened, _) = reopen_fixture_service_state(&state, &database_path).await;
    let stop_count = install_runtime(&mut reopened, seed.provider_id, None);
    make_fixture_mutation_authority(&mut reopened);
    let reopened = Arc::new(reopened);
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&reopened)));
    let observation_started = std::time::Instant::now();
    let mut last_parent = None;
    let recovered = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let stop = reopened
                .store
                .agent_dispatch_stop(&operation_id)
                .await
                .unwrap()
                .unwrap();
            last_parent = Some((
                observation_started.elapsed(),
                stop.state().clone(),
                stop.journal_revision(),
            ));
            if stop.projection_is_finalizable() {
                break stop;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await;
    if recovered.is_err() {
        eprintln!(
            "restart_recovery_timeout: last_polled_parent={last_parent:?}; \
             after_deadline_elapsed={:?}; stop_count={}; mutation_authority={}; \
             checkout_exists={}; coordinator_finished={}",
            observation_started.elapsed(),
            stop_count.load(Ordering::SeqCst),
            reopened.is_mutation_authority(),
            seed.checkout.exists(),
            recovery.is_finished(),
        );
        let child = reopened
            .store
            .agent_runtime_close(&authorized_child.intent.operation_id)
            .await;
        eprintln!(
            "restart_recovery_timeout: child_read_completed_after_deadline={:?}; \
             child_state_revision={:?}",
            observation_started.elapsed(),
            child.map(|record| record.map(|record| (record.state, record.journal_revision))),
        );
    }
    recovery.abort();
    let recovery_result = recovery.await;
    if recovered.is_err() {
        eprintln!(
            "restart_recovery_timeout: coordinator_join_after_abort={recovery_result:?}; \
             elapsed={:?}",
            observation_started.elapsed(),
        );
    }
    // Aborting the coordinator cancels workers, but not running blocking work.
    // Checkout actions retain this same guard until they finish using the root.
    let _settled = reopened.agent_operations.acquire(&seed.agent_id).await;
    reopened.store.close().await;
    state.store.close().await;
    let recovered = recovered.expect("restart recovery must finish the authorized parent");

    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert!(matches!(
        recovered.state(),
        dure_app::AgentDispatchStopStateV1::Succeeded { .. }
    ));
    assert!(!seed.checkout.exists());
}

#[tokio::test]
async fn restart_recovery_finalizes_preserve_without_git_observation() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let seed = seed_dispatch_stop(&state, &root, SpawnWorkspaceOwnership::DureOwned).await;
    install_runtime(&mut state, seed.provider_id.clone(), None);
    let preview = preview_stop_with_workspace_disposition(
        &state,
        "dispatch-preserve-recovery",
        &seed.spawn_operation_id,
        "preserve",
    )
    .await
    .unwrap();
    let operation_id: OperationIdV1 =
        serde_json::from_value(preview["receipt"]["plan"]["operationId"].clone()).unwrap();
    let plan_token: AgentDispatchStopPlanTokenV1 =
        serde_json::from_value(preview["receipt"]["plan"]["planToken"].clone()).unwrap();
    let planned = state
        .store
        .agent_dispatch_stop(&operation_id)
        .await
        .unwrap()
        .unwrap();
    state
        .store
        .authorize_agent_dispatch_stop(&AgentDispatchStopAuthorizeRequestV1 {
            schema_version: AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            operation_id: operation_id.clone(),
            plan_token,
            expected_journal_revision: planned.journal_revision(),
            runtime_close_intent: AgentRuntimeCloseIntentV1 {
                schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
                operation_id: OperationIdV1::new("dispatch-preserve-recovery-child").unwrap(),
                idempotency_key: "dispatch-preserve-recovery-child".into(),
                source: planned.plan().runtime_selection().clone(),
                source_authority: planned.plan().runtime_authority().clone(),
                stopped_transition: None,
                requested_at_ms: planned.plan().planned_at_ms(),
            },
            authorized_at_ms: planned.plan().planned_at_ms(),
        })
        .await
        .unwrap();
    let git_metadata = seed.repository.join(".git");
    let unavailable_git_metadata = seed.repository.join(".git-unavailable");
    fs::rename(&git_metadata, &unavailable_git_metadata).unwrap();

    let database_path = root.path().join("domain.sqlite");
    let (mut reopened, _) = reopen_fixture_service_state(&state, &database_path).await;
    let stop_count = install_runtime(&mut reopened, seed.provider_id, None);
    make_fixture_mutation_authority(&mut reopened);
    let reopened = Arc::new(reopened);
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&reopened)));
    let recovered = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let stop = reopened
                .store
                .agent_dispatch_stop(&operation_id)
                .await
                .unwrap()
                .unwrap();
            if stop.projection_is_finalizable() {
                break stop;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("restart recovery must finish the preserve parent");
    recovery.abort();
    let _ = recovery.await;

    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert!(matches!(
        recovered.state(),
        dure_app::AgentDispatchStopStateV1::WorkspacePreserved { .. }
    ));
    assert_eq!(runtime_close_count(&reopened, &seed.agent_id).await, 1);
    assert!(seed.checkout.is_dir());
    assert!(unavailable_git_metadata.is_dir());
    let status = call_dispatch_stop(
        &reopened,
        "dispatch-preserve-recovery-status",
        "dispatch.stop.status",
        json!({
            "schemaVersion": AGENT_DISPATCH_STOP_SCHEMA_VERSION_V1,
            "spawnOperationId": seed.spawn_operation_id,
        }),
    )
    .await
    .unwrap();
    assert_eq!(status["receipt"]["state"]["status"], "workspace_preserved");
}

fn dispatch_stop_request(
    state: &ServiceState,
    request_id: &str,
    operation: &str,
    body: Value,
) -> BackendRequest {
    BackendRequest {
        schema_version: 1,
        api_version: BACKEND_PROTOCOL_API.into(),
        kind: BACKEND_REQUEST_KIND.into(),
        request_id: request_id.into(),
        operation: operation.into(),
        expected: ExpectedBackend {
            scope_id: None,
            backend_id: BACKEND_ID.into(),
            generation: state.descriptor.generation.clone(),
            protocol: ExpectedProtocol {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            required_capabilities: Vec::new(),
        },
        body,
        connection: None,
    }
}

#[tokio::test]
async fn dispatch_stop_status_reads_the_backend_owned_journal() {
    let (_root, state, _, _) = fixture(Vec::new()).await;
    let request = dispatch_stop_request(
        &state,
        "dispatch-stop-status-empty",
        "dispatch.stop.status",
        json!({
            "schemaVersion": 1,
            "spawnOperationId": "spawn-missing",
        }),
    );

    let response = dispatch_authorized(
        &state,
        BackendRequestAuthority {
            backend_id: state.descriptor.backend_id.clone(),
            generation: state.descriptor.generation.clone(),
        },
        &request,
    )
    .await
    .expect("status is a backend-owned read even before a stop exists");

    assert_eq!(response, json!({ "schemaVersion": 1, "receipt": null }));
}
