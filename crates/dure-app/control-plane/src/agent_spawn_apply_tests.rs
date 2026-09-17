use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use dure_app::{
    AGENT_TIMELINE_SCHEMA_VERSION_V1, AgentExecutionProfileV1, AgentInteractionBindingV1,
    AgentInteractionProfileV1, AgentInteractionSessionIdV1, AgentProviderConversationPlanV1,
    AgentProviderRuntimeFenceV1, AgentRecordV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeSelectionV1, AgentSpawnEffortSelectionV1, AgentSpawnInteractionPreferenceV1,
    AgentSpawnModelSelectionV1, AgentSpawnPermissionModeV1, AgentSpawnPreviewIntentV1,
    AgentSpawnPromptDigestV1, AgentSpawnWorktreePolicyV1, AgentTimelineCursorV1,
    AgentTimelineEpochV1, AgentTurnEffectReceiptV1, AgentTurnEffectStateV1,
    PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1, ProviderIdV1, ProviderLaunchDefaultV1,
    ProviderLaunchDefaultsPutRequestV1, ProviderLaunchPermissionModeV1,
    ProviderLaunchPermissionOverrideV1, ProviderPermissionModeV1, WorkflowPromptActivityFutureV1,
    WorkflowPromptActivityObservationRequestV1, WorkflowPromptActivityObserver,
    WorkflowPromptActivityReceiptV1, WorkflowPromptActivityStateV1,
    WorkflowPromptDeliveryEvidenceV1, WorkflowPromptDeliveryFailureV1,
    WorkflowPromptDeliveryFutureV1, WorkflowSessionLaunchFailureV1, WorkflowSessionLaunchFutureV1,
    WorkspaceRecordV1,
};
use hmux_client::ProviderStateEnvironment;

use super::*;
use crate::agent_spawn_api;
use crate::project_catalog::ProjectProjection;
use crate::workspace_git::{
    WorkspaceAcquireRequest, WorkspaceAcquirer, WorkspaceFuture, WorkspaceHandle,
};

#[path = "agent_spawn_project_records_tests.rs"]
mod project_records;

#[path = "agent_spawn_checkout_tests.rs"]
mod checkout_registration;

struct FixtureWorkspace;

impl WorkspaceAcquirer for FixtureWorkspace {
    fn acquire(&self, request: WorkspaceAcquireRequest) -> WorkspaceFuture {
        Box::pin(async move { Ok(fixture_workspace_handle(request)) })
    }

    fn resolve(&self, request: WorkspaceAcquireRequest) -> WorkspaceFuture {
        Box::pin(async move { Ok(fixture_workspace_handle(request)) })
    }
}

fn fixture_workspace_handle(request: WorkspaceAcquireRequest) -> WorkspaceHandle {
    match request.policy {
        AgentSpawnWorktreePolicyV1::ProjectRoot => WorkspaceHandle {
            root: request.project_root,
            disposition: AgentSpawnStageDispositionV1::AdoptedExisting,
            lease: None,
            registration: None,
        },
        AgentSpawnWorktreePolicyV1::Dedicated { branch, .. } => {
            let lease =
                dure_app::AgentSpawnWorkspaceLeaseV1::for_dedicated(&request.workspace_id, &branch)
                    .unwrap();
            WorkspaceHandle {
                root: request
                    .project_root
                    .join(".worktrees")
                    .join(&lease.directory_name),
                disposition: AgentSpawnStageDispositionV1::CreatedDureOwned,
                lease: Some(lease),
                registration: None,
            }
        }
        AgentSpawnWorktreePolicyV1::ExistingWorkspace { source } => WorkspaceHandle {
            root: PathBuf::from(source.workspace_root),
            disposition: AgentSpawnStageDispositionV1::AdoptedExisting,
            lease: None,
            registration: None,
        },
        AgentSpawnWorktreePolicyV1::ExistingCheckout { instance, .. } => WorkspaceHandle {
            root: PathBuf::from(&instance.canonical_path),
            disposition: AgentSpawnStageDispositionV1::AdoptedExisting,
            lease: None,
            registration: Some(dure_app::GitCheckoutRegistrationV1 {
                repository_path: request.project_root.to_str().unwrap().into(),
                instance,
            }),
        },
    }
}

static FIXTURE_WORKSPACE: FixtureWorkspace = FixtureWorkspace;

struct FixtureProviderStatePreparer;

impl AgentSpawnProviderStatePreparer for FixtureProviderStatePreparer {
    fn prepare<'a>(
        &'a self,
        _provider_id: &'a ProviderIdV1,
        _execution_profile: &'a AgentExecutionProfileV1,
    ) -> ProviderStatePreparationFuture<'a> {
        Box::pin(async { Ok(provider_default_state_environment()) })
    }
}

static FIXTURE_PROVIDER_STATE_PREPARER: FixtureProviderStatePreparer = FixtureProviderStatePreparer;

#[derive(Default)]
struct RecordingProviderStatePreparer {
    calls: AtomicUsize,
}

impl AgentSpawnProviderStatePreparer for RecordingProviderStatePreparer {
    fn prepare<'a>(
        &'a self,
        _provider_id: &'a ProviderIdV1,
        _execution_profile: &'a AgentExecutionProfileV1,
    ) -> ProviderStatePreparationFuture<'a> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(provider_default_state_environment()) })
    }
}

#[derive(Clone)]
struct FixtureStructuredLauncher {
    provider_id: ProviderIdV1,
    launch_calls: Arc<AtomicUsize>,
    prompt_calls: Arc<AtomicUsize>,
    launch_requests: Arc<Mutex<Vec<StructuredAgentLaunchRequest>>>,
}

impl FixtureStructuredLauncher {
    fn for_provider(provider_id: &str) -> Self {
        Self {
            provider_id: ProviderIdV1::new(provider_id).unwrap(),
            launch_calls: Arc::new(AtomicUsize::new(0)),
            prompt_calls: Arc::new(AtomicUsize::new(0)),
            launch_requests: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl StructuredAgentSessionLauncher for FixtureStructuredLauncher {
    fn launch(&self, request: StructuredAgentLaunchRequest) -> StructuredLaunchFuture<'_> {
        let calls = Arc::clone(&self.launch_calls);
        let requests = Arc::clone(&self.launch_requests);
        let provider_id = self.provider_id.clone();
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            requests.lock().unwrap().push(request.clone());
            let provider_conversation_ref = request
                .provider_conversation_ref
                .as_option()
                .map(str::to_string);
            Ok(AgentInteractionBindingV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: AgentInteractionSessionIdV1::new(format!(
                    "interaction-{}",
                    request.agent_id.as_str()
                ))
                .unwrap(),
                agent_id: request.agent_id,
                provider_id,
                execution_profile: request.execution_profile,
                provider_conversation_ref,
                runtime: AgentProviderRuntimeFenceV1 {
                    runtime_generation: "structured-runtime-1".into(),
                    provider_epoch: "structured-provider-1".into(),
                },
                timeline_epoch: AgentTimelineEpochV1::new("structured-timeline-1").unwrap(),
                binding_revision: 1,
                history_complete: true,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
        })
    }

    fn start_turn(&self, request: StructuredAgentPromptRequest) -> StructuredPromptFuture<'_> {
        let calls = Arc::clone(&self.prompt_calls);
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            let timeline_epoch = request.binding.timeline_epoch.clone();
            Ok(AgentTurnEffectReceiptV1 {
                intent: dure_app::AgentStartTurnIntentV1 {
                    schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                    interaction_session_id: request.binding.interaction_session_id,
                    runtime: request.binding.runtime,
                    turn_id: request.turn_id,
                    client_message_id: request.client_message_id,
                    input: request.input,
                    requested_at_ms: request.requested_at_ms,
                },
                state: AgentTurnEffectStateV1::Accepted,
                provider_receipt: None,
                timeline_cursor: AgentTimelineCursorV1 {
                    epoch: timeline_epoch,
                    sequence: 1,
                },
                newly_prepared: true,
                updated_at_ms: request.requested_at_ms,
            })
        })
    }
}

#[derive(Clone, Default)]
struct RecordingWorkspace {
    acquire_calls: Arc<AtomicUsize>,
    resolve_calls: Arc<AtomicUsize>,
}

impl WorkspaceAcquirer for RecordingWorkspace {
    fn acquire(&self, request: WorkspaceAcquireRequest) -> WorkspaceFuture {
        let calls = Arc::clone(&self.acquire_calls);
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(fixture_workspace_handle(request))
        })
    }

    fn resolve(&self, request: WorkspaceAcquireRequest) -> WorkspaceFuture {
        let calls = Arc::clone(&self.resolve_calls);
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(fixture_workspace_handle(request))
        })
    }
}

fn project() -> ProjectProjection {
    ProjectProjection {
        id: "dure".into(),
        display_name: "Dure".into(),
        root_id: "root_0123456789abcdef0123456789abcdef".into(),
        repository_id: "repo_fedcba9876543210fedcba9876543210".into(),
    }
}

fn request() -> AgentSpawnPreviewIntentV1 {
    AgentSpawnPreviewIntentV1 {
        schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
        idempotency_key: "spawn-request-1".into(),
        project_id: dure_app::ProjectIdV1::new("dure").unwrap(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        agent_name: "codex-1".into(),
        worktree: AgentSpawnWorktreePolicyV1::ProjectRoot,
        provider_conversation_ref: Default::default(),
        permission_override: None,
        prompt_digest: Some(AgentSpawnPromptDigestV1::sha256("private prompt")),
        setup_command: None,
        model: None,
        effort: None,
        interaction_preference: None,
    }
}

fn dedicated_request() -> AgentSpawnPreviewIntentV1 {
    AgentSpawnPreviewIntentV1 {
        worktree: AgentSpawnWorktreePolicyV1::Dedicated {
            base_commit_sha: "a".repeat(40),
            branch: "agent/feature-x".into(),
            branch_mode: Default::default(),
            checkout_path: None,
        },
        ..request()
    }
}

fn existing_structured_source() -> (
    AgentRecordV1,
    WorkspaceRecordV1,
    AgentRuntimeSelectionV1,
    AgentInteractionBindingV1,
) {
    let agent_id = dure_app::AgentIdV1::new("agent-source").unwrap();
    let workspace_id = dure_app::WorkspaceIdV1::new("workspace-source").unwrap();
    let provider_id = ProviderIdV1::new("claude").unwrap();
    let agent = AgentRecordV1 {
        agent_id: agent_id.clone(),
        workspace_id: workspace_id.clone(),
        provider_id: provider_id.clone(),
        display_name: "Source".into(),
        created_at_ms: 1,
        updated_at_ms: 2,
    };
    let workspace = WorkspaceRecordV1 {
        workspace_id,
        project_id: dure_app::ProjectIdV1::new("dure").unwrap(),
        root_path: "/fixture/project/.worktrees/source".into(),
        base_commit_sha: Some("a".repeat(40)),
        created_at_ms: 1,
        updated_at_ms: 2,
    };
    let selection = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 4,
        selected_by_operation_id: Some(dure_app::OperationIdV1::new("transition-source").unwrap()),
        updated_at_ms: 2,
    };
    let binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-source").unwrap(),
        agent_id,
        provider_id,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-source".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-source".into(),
            provider_epoch: "provider-source".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-source").unwrap(),
        binding_revision: 3,
        history_complete: true,
        created_at_ms: 1,
        updated_at_ms: 2,
    };
    (agent, workspace, selection, binding)
}

#[tokio::test]
async fn exact_resume_adopts_the_source_workspace_through_the_shared_acquirer() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let (source_agent, source_workspace, selection, source_binding) = existing_structured_source();
    register_project(&store).await;
    store.upsert_workspace(&source_workspace).await.unwrap();
    store.upsert_agent(&source_agent).await.unwrap();
    let source_authority = agent_spawn_api::existing_workspace_authority(
        &source_agent,
        &source_workspace,
        &selection,
        &AgentRuntimeBindingAuthorityV1::StructuredProtocol {
            binding: source_binding,
        },
    )
    .unwrap();
    let mut requested = request();
    requested.idempotency_key = "spawn-history-resume".into();
    requested.provider_id = ProviderIdV1::new("claude").unwrap();
    requested.agent_name = "claude-history".into();
    requested.prompt_digest = None;
    requested.provider_conversation_ref =
        AgentProviderConversationPlanV1::resume("conversation-history").unwrap();
    requested.worktree = AgentSpawnWorktreePolicyV1::ExistingWorkspace {
        source: Box::new(source_authority),
    };
    let providers = crate::provider_extension::test_local_agent_provider_registry();
    let planned = agent_spawn_api::preview(
        &store,
        &providers,
        "dure-local",
        "generation-1",
        project(),
        requested,
        3,
    )
    .await
    .unwrap();
    let body = AgentSpawnApplyBody {
        schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
        operation_id: planned.operation_id.clone(),
        plan_token: planned.plan.plan_token.clone(),
        expected_last_sequence: planned.last_sequence,
        prompt: None,
    };
    let workspace = RecordingWorkspace::default();
    let launcher = FixtureStructuredLauncher::for_provider("claude");
    let execution = AgentSpawnExecution {
        project_root: PathBuf::from("/fixture/project"),
        project_display_name: "Dure".into(),
        workspace_acquirer: &workspace,
        launch: AgentSpawnLaunchExecution::StructuredProtocol {
            launcher: &launcher,
        },
    };

    let succeeded = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(execution),
    )
    .await
    .unwrap();

    assert_eq!(succeeded.state, AgentSpawnJournalStateV1::Succeeded);
    assert_eq!(succeeded.plan.workspace_id, source_workspace.workspace_id);
    assert_eq!(workspace.acquire_calls.load(Ordering::SeqCst), 1);
    assert_eq!(workspace.resolve_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        launcher.launch_requests.lock().unwrap()[0]
            .provider_conversation_ref
            .as_option(),
        Some("conversation-history")
    );
    assert_eq!(
        structured_binding(&succeeded)
            .unwrap()
            .provider_conversation_ref
            .as_deref(),
        Some("conversation-history")
    );
    assert_eq!(
        store
            .workspace(&source_workspace.workspace_id)
            .await
            .unwrap()
            .unwrap(),
        source_workspace
    );
    assert_eq!(
        store
            .agent(&succeeded.plan.agent_id)
            .await
            .unwrap()
            .unwrap()
            .workspace_id,
        source_workspace.workspace_id
    );
}

#[tokio::test]
async fn structured_spawn_uses_one_chat_runtime_and_typed_prompt_effect() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let providers = crate::provider_extension::test_local_agent_provider_registry();
    let mut requested = request();
    requested.idempotency_key = "spawn-structured-claude".into();
    requested.provider_id = ProviderIdV1::new("claude").unwrap();
    requested.agent_name = "claude-chat-1".into();
    requested.permission_override = Some(ProviderLaunchPermissionOverrideV1::BypassApprovals);
    requested.model = Some(AgentSpawnModelSelectionV1::parse("opus").unwrap());
    requested.effort = Some(AgentSpawnEffortSelectionV1::parse("high").unwrap());
    let planned = agent_spawn_api::preview(
        &store,
        &providers,
        "dure-local",
        "generation-1",
        project(),
        requested,
        1,
    )
    .await
    .unwrap();
    assert!(matches!(
        planned.plan.launch,
        AgentSpawnLaunchPlanV1::StructuredProtocol
    ));
    let body = apply_body(&planned, "private prompt");
    let launcher = FixtureStructuredLauncher::for_provider("claude");
    let execution = AgentSpawnExecution {
        project_root: PathBuf::from("/fixture/project"),
        project_display_name: "Dure".into(),
        workspace_acquirer: &FIXTURE_WORKSPACE,
        launch: AgentSpawnLaunchExecution::StructuredProtocol {
            launcher: &launcher,
        },
    };

    let succeeded = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(execution),
    )
    .await
    .unwrap();

    assert_eq!(succeeded.state, AgentSpawnJournalStateV1::Succeeded);
    assert_eq!(launcher.launch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(launcher.prompt_calls.load(Ordering::SeqCst), 1);
    {
        let launch_requests = launcher.launch_requests.lock().unwrap();
        assert_eq!(launch_requests.len(), 1);
        assert_eq!(
            launch_requests[0].permission_mode,
            AgentSpawnPermissionModeV1::SkipPermissions
        );
        assert_eq!(launch_requests[0].model.as_ref().unwrap().as_str(), "opus");
        assert_eq!(launch_requests[0].effort.as_ref().unwrap().as_str(), "high");
    }
    let persisted_project = store
        .project(&succeeded.plan.authority.project_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted_project.root_path, "/fixture/project");
    assert_eq!(persisted_project.display_name, "Dure");
    let selection = store
        .agent_runtime_selection(&succeeded.plan.agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        selection.interaction_profile,
        AgentInteractionProfileV1::StructuredProtocol
    );
    assert_eq!(
        selection.permission_mode,
        AgentSpawnPermissionModeV1::SkipPermissions
    );
    assert_eq!(selection.model.as_ref().unwrap().as_str(), "opus");
    assert_eq!(selection.effort.as_ref().unwrap().as_str(), "high");
    assert_eq!(
        succeeded
            .completed
            .iter()
            .map(|stage| stage.stage)
            .collect::<Vec<_>>(),
        vec![
            AgentSpawnStageV1::Worktree,
            AgentSpawnStageV1::StructuredLaunch,
            AgentSpawnStageV1::StructuredPromptDelivery,
        ]
    );
}

#[tokio::test]
async fn native_preference_pins_the_pty_launch_even_when_structured_exists() {
    // Basic interface mode creates agents as terminal panes (owner decision
    // 2026-08-31): the caller's native_cli preference must skip the
    // structured session plan the provider would otherwise win.
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let providers = crate::provider_extension::test_local_agent_provider_registry();
    let mut requested = request();
    requested.idempotency_key = "spawn-native-preference-claude".into();
    requested.provider_id = ProviderIdV1::new("claude").unwrap();
    requested.agent_name = "claude-terminal-1".into();
    requested.interaction_preference = Some(AgentSpawnInteractionPreferenceV1::NativeCli);
    let planned = agent_spawn_api::preview(
        &store,
        &providers,
        "dure-local",
        "generation-1",
        project(),
        requested,
        1,
    )
    .await
    .unwrap();
    assert!(matches!(
        planned.plan.launch,
        AgentSpawnLaunchPlanV1::NativeCli { .. }
    ));
}

#[tokio::test]
async fn codex_structured_spawn_applies_through_the_common_chat_launcher() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let providers = crate::provider_extension::test_codex_structured_agent_provider_registry();
    let planned = agent_spawn_api::preview(
        &store,
        &providers,
        "dure-local",
        "generation-1",
        project(),
        request(),
        1,
    )
    .await
    .unwrap();
    assert!(matches!(
        planned.plan.launch,
        AgentSpawnLaunchPlanV1::StructuredProtocol
    ));
    let body = apply_body(&planned, "private prompt");
    let launcher = FixtureStructuredLauncher::for_provider("codex");
    let execution = AgentSpawnExecution {
        project_root: PathBuf::from("/fixture/project"),
        project_display_name: "Dure".into(),
        workspace_acquirer: &FIXTURE_WORKSPACE,
        launch: AgentSpawnLaunchExecution::StructuredProtocol {
            launcher: &launcher,
        },
    };

    let succeeded = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(execution),
    )
    .await
    .unwrap();

    assert_eq!(succeeded.state, AgentSpawnJournalStateV1::Succeeded);
    assert_eq!(launcher.launch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(launcher.prompt_calls.load(Ordering::SeqCst), 1);
    let binding = structured_binding(&succeeded).unwrap();
    assert_eq!(binding.provider_id.as_str(), "codex");
    assert_eq!(binding.agent_id, succeeded.plan.agent_id);
}

#[derive(Clone)]
struct FixtureLauncher {
    calls: Arc<AtomicUsize>,
}

#[derive(Clone, Default)]
struct RecordingLauncher {
    calls: Arc<AtomicUsize>,
    initial_prompts: Arc<Mutex<Vec<Option<String>>>>,
    working_directories: Arc<Mutex<Vec<String>>>,
    permission_modes: Arc<Mutex<Vec<AgentSpawnPermissionModeV1>>>,
    setup_commands: Arc<Mutex<Vec<Option<String>>>>,
    provider_state_environments: Arc<Mutex<Vec<ProviderStateEnvironment>>>,
    provider_conversations: Arc<Mutex<Vec<Option<String>>>>,
}

impl crate::workflow_launch::CredentialAwareWorkflowSessionLauncher for RecordingLauncher {
    fn launch_with_provider_state(
        &self,
        request: WorkflowSessionLaunchRequestV1,
        provider_state_environment: ProviderStateEnvironment,
        _presentation_predecessor: Option<hmux_client::PresentationCheckpointPredecessor>,
    ) -> WorkflowSessionLaunchFutureV1 {
        self.provider_state_environments
            .lock()
            .unwrap()
            .push(provider_state_environment);
        let calls = Arc::clone(&self.calls);
        let initial_prompts = Arc::clone(&self.initial_prompts);
        let working_directories = Arc::clone(&self.working_directories);
        let permission_modes = Arc::clone(&self.permission_modes);
        let setup_commands = Arc::clone(&self.setup_commands);
        let provider_conversations = Arc::clone(&self.provider_conversations);
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            initial_prompts
                .lock()
                .unwrap()
                .push(request.initial_prompt.clone());
            working_directories
                .lock()
                .unwrap()
                .push(request.working_directory.clone());
            permission_modes
                .lock()
                .unwrap()
                .push(request.permission_mode.clone());
            setup_commands.lock().unwrap().push(
                request
                    .prelaunch_command
                    .as_ref()
                    .map(|command| command.as_str().to_string()),
            );
            provider_conversations
                .lock()
                .unwrap()
                .push(request.provider_conversation_ref.clone());
            Ok(dure_app::WorkflowSessionLaunchReceiptV1 {
                launch_idempotency_key: request.launch_idempotency_key,
                session: WorkflowSessionGenerationV1 {
                    session_id: request.session_id,
                    workspace_id: request.workspace_id,
                    provider_id: request.provider_id,
                    runner_principal: "runner-principal-1".into(),
                    runner_instance: "runner-instance-1".into(),
                    channel_epoch: "1".into(),
                    host_instance_id: "host-instance-1".into(),
                    terminal_epoch: "terminal-epoch-1".into(),
                },
            })
        })
    }
}

impl crate::workflow_launch::CredentialAwareWorkflowSessionLauncher for FixtureLauncher {
    fn launch_with_provider_state(
        &self,
        request: WorkflowSessionLaunchRequestV1,
        _provider_state_environment: ProviderStateEnvironment,
        _presentation_predecessor: Option<hmux_client::PresentationCheckpointPredecessor>,
    ) -> WorkflowSessionLaunchFutureV1 {
        let calls = Arc::clone(&self.calls);
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(dure_app::WorkflowSessionLaunchReceiptV1 {
                launch_idempotency_key: request.launch_idempotency_key,
                session: WorkflowSessionGenerationV1 {
                    session_id: request.session_id,
                    workspace_id: request.workspace_id,
                    provider_id: request.provider_id,
                    runner_principal: "runner-principal-1".into(),
                    runner_instance: "runner-instance-1".into(),
                    channel_epoch: "1".into(),
                    host_instance_id: "host-instance-1".into(),
                    terminal_epoch: "terminal-epoch-1".into(),
                },
            })
        })
    }
}

#[derive(Clone, Default)]
struct ResponseLossLauncher {
    calls: Arc<AtomicUsize>,
    effects: Arc<AtomicUsize>,
    session: Arc<Mutex<Option<dure_app::WorkflowSessionLaunchReceiptV1>>>,
}

impl crate::workflow_launch::CredentialAwareWorkflowSessionLauncher for ResponseLossLauncher {
    fn launch_with_provider_state(
        &self,
        request: WorkflowSessionLaunchRequestV1,
        _provider_state_environment: ProviderStateEnvironment,
        _presentation_predecessor: Option<hmux_client::PresentationCheckpointPredecessor>,
    ) -> WorkflowSessionLaunchFutureV1 {
        let calls = Arc::clone(&self.calls);
        let effects = Arc::clone(&self.effects);
        let session = Arc::clone(&self.session);
        Box::pin(async move {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            let created = {
                let mut stored = session.lock().unwrap();
                stored
                    .get_or_insert_with(|| {
                        effects.fetch_add(1, Ordering::SeqCst);
                        dure_app::WorkflowSessionLaunchReceiptV1 {
                            launch_idempotency_key: format!(
                                "{}-advanced",
                                request.launch_idempotency_key
                            ),
                            session: WorkflowSessionGenerationV1 {
                                session_id: format!("{}-advanced", request.session_id),
                                workspace_id: request.workspace_id,
                                provider_id: request.provider_id,
                                runner_principal: "runner-principal-1".into(),
                                runner_instance: "runner-instance-1".into(),
                                channel_epoch: "1".into(),
                                host_instance_id: "host-instance-1".into(),
                                terminal_epoch: "terminal-epoch-1".into(),
                            },
                        }
                    })
                    .clone()
            };
            if call == 0 {
                Err(WorkflowSessionLaunchFailureV1::new("fixture_launch_response_lost").unwrap())
            } else {
                Ok(created)
            }
        })
    }
}

#[derive(Clone)]
struct FixtureFailureLauncher {
    calls: Arc<AtomicUsize>,
}

impl crate::workflow_launch::CredentialAwareWorkflowSessionLauncher for FixtureFailureLauncher {
    fn launch_with_provider_state(
        &self,
        _request: WorkflowSessionLaunchRequestV1,
        _provider_state_environment: ProviderStateEnvironment,
        _presentation_predecessor: Option<hmux_client::PresentationCheckpointPredecessor>,
    ) -> WorkflowSessionLaunchFutureV1 {
        let calls = Arc::clone(&self.calls);
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(WorkflowSessionLaunchFailureV1::new("fixture_runtime_unavailable").unwrap())
        })
    }
}

#[derive(Clone)]
struct FixturePromptDeliverer {
    calls: Arc<AtomicUsize>,
    uncertain: bool,
}

/// Answers whichever way a test needs: the provider reacted, or it stayed
/// silent after the prompt reached the PTY.
#[derive(Clone)]
struct FixturePromptActivityObserver {
    state: WorkflowPromptActivityStateV1,
}

impl FixturePromptActivityObserver {
    fn observed() -> Self {
        Self {
            state: WorkflowPromptActivityStateV1::Observed,
        }
    }

    fn stalled() -> Self {
        Self {
            state: WorkflowPromptActivityStateV1::Stalled,
        }
    }
}

impl WorkflowPromptActivityObserver for FixturePromptActivityObserver {
    fn observe(
        &self,
        _request: WorkflowPromptActivityObservationRequestV1,
    ) -> WorkflowPromptActivityFutureV1 {
        let state = self.state;
        Box::pin(async move {
            Ok(WorkflowPromptActivityReceiptV1 {
                state,
                observed_output_seq: "7".into(),
                error_code: None,
            })
        })
    }
}

fn fixture_prompt_evidence(terminal_epoch: String) -> WorkflowPromptDeliveryEvidenceV1 {
    WorkflowPromptDeliveryEvidenceV1::agent_prompt(terminal_epoch, "1", "1", Some("1".into()))
}

impl WorkflowPromptDeliverer for FixturePromptDeliverer {
    fn deliver(&self, request: WorkflowPromptDeliveryRequestV1) -> WorkflowPromptDeliveryFutureV1 {
        let calls = Arc::clone(&self.calls);
        let uncertain = self.uncertain;
        let terminal_epoch = request.session.terminal_epoch;
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            if uncertain {
                return Err(
                    WorkflowPromptDeliveryFailureV1::new("fixture_prompt_uncertain", true).unwrap(),
                );
            }
            Ok(fixture_prompt_evidence(terminal_epoch))
        })
    }
}

#[derive(Clone)]
struct NoWriteThenSuccessPromptDeliverer {
    calls: Arc<AtomicUsize>,
}

impl WorkflowPromptDeliverer for NoWriteThenSuccessPromptDeliverer {
    fn deliver(&self, request: WorkflowPromptDeliveryRequestV1) -> WorkflowPromptDeliveryFutureV1 {
        let calls = Arc::clone(&self.calls);
        let terminal_epoch = request.session.terminal_epoch;
        Box::pin(async move {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(WorkflowPromptDeliveryFailureV1::new(
                    "fixture_prompt_not_written",
                    false,
                )
                .unwrap());
            }
            Ok(fixture_prompt_evidence(terminal_epoch))
        })
    }
}

async fn planned_prompt_spawn(store: &SqliteDomainStore) -> AgentSpawnJournalReceiptV1 {
    planned_prompt_spawn_for(store, "private prompt").await
}

async fn planned_prompt_spawn_for(
    store: &SqliteDomainStore,
    prompt: &str,
) -> AgentSpawnJournalReceiptV1 {
    register_project(store).await;
    let providers = crate::provider_extension::test_local_agent_provider_registry();
    let mut request = request();
    request.prompt_digest = Some(AgentSpawnPromptDigestV1::sha256(prompt));
    agent_spawn_api::preview(
        store,
        &providers,
        "dure-local",
        "generation-1",
        project(),
        request,
        1,
    )
    .await
    .unwrap()
}

async fn register_project(store: &SqliteDomainStore) {
    store
        .upsert_project(&dure_app::ProjectRecordV1 {
            project_id: dure_app::ProjectIdV1::new("dure").unwrap(),
            root_path: "/fixture/project".into(),
            display_name: "Dure".into(),
            created_at_ms: 0,
            updated_at_ms: 0,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn dedicated_worktree_plan_is_authorized_for_the_workspace_boundary() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let providers = crate::provider_extension::test_local_agent_provider_registry();
    let planned = agent_spawn_api::preview(
        &store,
        &providers,
        "dure-local",
        "generation-1",
        project(),
        dedicated_request(),
        1,
    )
    .await
    .unwrap();

    let authorized = authorize(
        &store,
        "dure-local",
        &apply_body(&planned, "private prompt"),
    )
    .await
    .unwrap();

    assert_eq!(authorized, planned);
}

#[tokio::test]
async fn skip_permissions_is_authorized_for_the_runtime_boundary() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    register_project(&store).await;
    let providers = crate::provider_extension::test_local_agent_provider_registry();
    let bypass = store
        .put_provider_launch_defaults(
            &ProviderLaunchDefaultsPutRequestV1 {
                schema_version: PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1,
                idempotency_key: "apply-defaults-bypass".into(),
                expected_revision: 0,
                defaults: BTreeMap::from([(
                    ProviderIdV1::new("codex").unwrap(),
                    ProviderLaunchDefaultV1 {
                        permission_mode: ProviderLaunchPermissionModeV1::BypassApprovals,
                    },
                )]),
            },
            0,
        )
        .await
        .unwrap();
    let planned = agent_spawn_api::preview(
        &store,
        &providers,
        "dure-local",
        "generation-1",
        project(),
        request(),
        1,
    )
    .await
    .unwrap();
    assert_eq!(
        planned
            .plan
            .provider_launch_defaults
            .as_ref()
            .unwrap()
            .revision,
        bypass.document.revision
    );

    store
        .put_provider_launch_defaults(
            &ProviderLaunchDefaultsPutRequestV1 {
                schema_version: PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1,
                idempotency_key: "apply-defaults-require".into(),
                expected_revision: bypass.document.revision,
                defaults: BTreeMap::from([(
                    ProviderIdV1::new("codex").unwrap(),
                    ProviderLaunchDefaultV1 {
                        permission_mode: ProviderLaunchPermissionModeV1::RequireApprovals,
                    },
                )]),
            },
            2,
        )
        .await
        .unwrap();

    let authorized = authorize(
        &store,
        "dure-local",
        &apply_body(&planned, "private prompt"),
    )
    .await
    .unwrap();

    assert_eq!(authorized, planned);
    let launcher = RecordingLauncher::default();
    let prompt_calls = Arc::new(AtomicUsize::new(0));
    let prompt_deliverer = FixturePromptDeliverer {
        calls: Arc::clone(&prompt_calls),
        uncertain: false,
    };
    let succeeded = apply(
        &store,
        authorized,
        &apply_body(&planned, "private prompt"),
        Some(execution(
            &launcher,
            &prompt_deliverer,
            &FixturePromptActivityObserver::observed(),
        )),
    )
    .await
    .unwrap();

    assert_eq!(succeeded.state, AgentSpawnJournalStateV1::Succeeded);
    assert_eq!(
        *launcher.permission_modes.lock().unwrap(),
        vec![AgentSpawnPermissionModeV1::SkipPermissions]
    );
}

#[tokio::test]
async fn dedicated_worktree_is_acquired_once_and_drives_the_runtime_directory() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    register_project(&store).await;
    let providers = crate::provider_extension::test_local_agent_provider_registry();
    let mut requested = dedicated_request();
    requested.setup_command =
        Some(dure_app::WorkflowSessionPrelaunchCommandV1::new("pnpm install").unwrap());
    let planned = agent_spawn_api::preview(
        &store,
        &providers,
        "dure-local",
        "generation-1",
        project(),
        requested,
        1,
    )
    .await
    .unwrap();
    let body = apply_body(&planned, "private prompt");
    let workspace = RecordingWorkspace::default();
    let launcher = RecordingLauncher::default();
    let prompt_calls = Arc::new(AtomicUsize::new(0));
    let prompt_deliverer = FixturePromptDeliverer {
        calls: Arc::clone(&prompt_calls),
        uncertain: false,
    };
    let execution = AgentSpawnExecution {
        project_root: PathBuf::from("/fixture/project"),
        project_display_name: "Dure".into(),
        workspace_acquirer: &workspace,
        launch: AgentSpawnLaunchExecution::NativeCli {
            provider_executable: "/fixture/codex".into(),
            provider_arguments: Vec::new(),
            provider_resume_arguments: None,
            prompt_target: dure_app::AgentProviderPromptTargetV1::ProcessObserved,
            launcher: &launcher,
            provider_state_preparer: &FIXTURE_PROVIDER_STATE_PREPARER,
            prompt_deliverer: &prompt_deliverer,
            prompt_activity_observer: &FixturePromptActivityObserver::observed(),
        },
    };

    let succeeded = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(execution),
    )
    .await
    .unwrap();

    assert_eq!(succeeded.state, AgentSpawnJournalStateV1::Succeeded);
    assert_eq!(workspace.acquire_calls.load(Ordering::SeqCst), 1);
    assert_eq!(workspace.resolve_calls.load(Ordering::SeqCst), 1);
    assert_eq!(launcher.calls.load(Ordering::SeqCst), 1);
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        *launcher.working_directories.lock().unwrap(),
        vec!["/fixture/project/.worktrees/feature-x"]
    );
    assert_eq!(
        *launcher.setup_commands.lock().unwrap(),
        vec![Some("pnpm install".into())]
    );
    assert_eq!(
        *launcher.provider_state_environments.lock().unwrap(),
        vec![provider_default_state_environment()]
    );
    assert!(matches!(
        &succeeded.completed[0].evidence,
        AgentSpawnStageEvidenceV1::Worktree {
            disposition: AgentSpawnStageDispositionV1::CreatedDureOwned,
            lease: Some(lease),
            ..
        } if lease.directory_name == "feature-x"
    ));
}

#[tokio::test]
async fn native_exact_resume_reaches_the_existing_launcher_and_durable_binding() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    register_project(&store).await;
    let providers = crate::provider_extension::test_local_agent_provider_registry();
    let mut requested = request();
    requested.idempotency_key = "spawn-native-resume".into();
    requested.provider_conversation_ref =
        AgentProviderConversationPlanV1::resume("conversation-history").unwrap();
    let planned = agent_spawn_api::preview(
        &store,
        &providers,
        "dure-local",
        "generation-1",
        project(),
        requested,
        1,
    )
    .await
    .unwrap();
    assert!(matches!(
        planned.plan.launch,
        AgentSpawnLaunchPlanV1::NativeCli { .. }
    ));
    let body = apply_body(&planned, "private prompt");
    let launcher = RecordingLauncher::default();
    let prompt_calls = Arc::new(AtomicUsize::new(0));
    let prompt_deliverer = FixturePromptDeliverer {
        calls: prompt_calls,
        uncertain: false,
    };

    let succeeded = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(execution(
            &launcher,
            &prompt_deliverer,
            &FixturePromptActivityObserver::observed(),
        )),
    )
    .await
    .unwrap();

    assert_eq!(succeeded.state, AgentSpawnJournalStateV1::Succeeded);
    assert_eq!(
        *launcher.provider_conversations.lock().unwrap(),
        vec![Some("conversation-history".into())]
    );
    assert_eq!(
        store
            .agent_checkpoint_binding_authority(&succeeded.plan.agent_id)
            .await
            .unwrap()
            .unwrap()
            .binding
            .provider_conversation_id
            .as_deref(),
        Some("conversation-history")
    );
}

fn apply_body(receipt: &AgentSpawnJournalReceiptV1, prompt: &str) -> AgentSpawnApplyBody {
    AgentSpawnApplyBody {
        schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
        operation_id: receipt.operation_id.clone(),
        plan_token: receipt.plan.plan_token.clone(),
        expected_last_sequence: receipt.last_sequence,
        prompt: Some(prompt.into()),
    }
}

fn execution<'a>(
    launcher: &'a dyn crate::workflow_launch::CredentialAwareWorkflowSessionLauncher,
    prompt_deliverer: &'a dyn WorkflowPromptDeliverer,
    prompt_activity_observer: &'a dyn WorkflowPromptActivityObserver,
) -> AgentSpawnExecution<'a> {
    execution_with_prompt_target(
        launcher,
        prompt_deliverer,
        &FIXTURE_PROVIDER_STATE_PREPARER,
        prompt_activity_observer,
        dure_app::AgentProviderPromptTargetV1::ProcessObserved,
    )
}

fn execution_with_provider_state_preparer<'a>(
    launcher: &'a dyn crate::workflow_launch::CredentialAwareWorkflowSessionLauncher,
    prompt_deliverer: &'a dyn WorkflowPromptDeliverer,
    provider_state_preparer: &'a dyn AgentSpawnProviderStatePreparer,
    prompt_activity_observer: &'a dyn WorkflowPromptActivityObserver,
) -> AgentSpawnExecution<'a> {
    execution_with_prompt_target(
        launcher,
        prompt_deliverer,
        provider_state_preparer,
        prompt_activity_observer,
        dure_app::AgentProviderPromptTargetV1::ProcessObserved,
    )
}

fn execution_with_prompt_target<'a>(
    launcher: &'a dyn crate::workflow_launch::CredentialAwareWorkflowSessionLauncher,
    prompt_deliverer: &'a dyn WorkflowPromptDeliverer,
    provider_state_preparer: &'a dyn AgentSpawnProviderStatePreparer,
    prompt_activity_observer: &'a dyn WorkflowPromptActivityObserver,
    prompt_target: dure_app::AgentProviderPromptTargetV1,
) -> AgentSpawnExecution<'a> {
    AgentSpawnExecution {
        project_root: PathBuf::from("/fixture/project"),
        project_display_name: "Dure".into(),
        workspace_acquirer: &FIXTURE_WORKSPACE,
        launch: AgentSpawnLaunchExecution::NativeCli {
            provider_executable: "/fixture/codex".into(),
            provider_arguments: Vec::new(),
            provider_resume_arguments: None,
            prompt_target,
            launcher,
            provider_state_preparer,
            prompt_deliverer,
            prompt_activity_observer,
        },
    }
}

fn provider_default_state_environment() -> ProviderStateEnvironment {
    ProviderStateEnvironment::from_mutations(
        BTreeMap::new(),
        BTreeSet::from(["CODEX_HOME".into(), "CODEX_SQLITE_HOME".into()]),
    )
    .unwrap()
}

#[tokio::test]
async fn apply_journals_runtime_launch_and_persists_reasoning_effort() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    register_project(&store).await;
    let providers = crate::provider_extension::test_local_agent_provider_registry();
    let mut requested = request();
    requested.effort = Some(AgentSpawnEffortSelectionV1::parse("xhigh").unwrap());
    let planned = agent_spawn_api::preview(
        &store,
        &providers,
        "dure-local",
        "generation-1",
        project(),
        requested,
        1,
    )
    .await
    .unwrap();
    let body = apply_body(&planned, "private prompt");
    let authorized = authorize(&store, "dure-local", &body).await.unwrap();
    let launch_calls = Arc::new(AtomicUsize::new(0));
    let prompt_calls = Arc::new(AtomicUsize::new(0));
    let launcher = FixtureLauncher {
        calls: Arc::clone(&launch_calls),
    };
    let prompt_deliverer = FixturePromptDeliverer {
        calls: Arc::clone(&prompt_calls),
        uncertain: false,
    };
    let succeeded = apply(
        &store,
        authorized,
        &body,
        Some(execution(
            &launcher,
            &prompt_deliverer,
            &FixturePromptActivityObserver::observed(),
        )),
    )
    .await
    .unwrap();
    assert_eq!(succeeded.state, AgentSpawnJournalStateV1::Succeeded);
    assert_eq!(succeeded.last_sequence, 8);
    assert_eq!(
        succeeded
            .completed
            .iter()
            .map(|stage| stage.stage)
            .collect::<Vec<_>>(),
        vec![
            AgentSpawnStageV1::Worktree,
            AgentSpawnStageV1::RuntimeLaunch,
            AgentSpawnStageV1::PromptDelivery,
        ]
    );
    assert_eq!(launch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 1);
    let selection = store
        .agent_runtime_selection(&succeeded.plan.agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        selection.interaction_profile,
        AgentInteractionProfileV1::NativeCli
    );
    assert_eq!(
        selection.execution_profile,
        succeeded.plan.request.execution_profile
    );
    assert_eq!(
        serde_json::to_value(&selection).unwrap()["effort"],
        serde_json::json!("xhigh")
    );
    assert!(
        !serde_json::to_string(&succeeded)
            .unwrap()
            .contains("private prompt")
    );

    let replay = authorize(&store, "dure-local", &body).await.unwrap();
    assert!(!requires_external_context(&replay));
    let replayed = apply(&store, replay, &body, None).await.unwrap();
    assert_eq!(replayed, succeeded);
    assert_eq!(launch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn launch_argument_prompt_never_crosses_the_pty_delivery_path() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let planned = planned_prompt_spawn(&store).await;
    let body = apply_body(&planned, "private prompt");
    let launcher = RecordingLauncher::default();
    let prompt_calls = Arc::new(AtomicUsize::new(0));
    let prompt_deliverer = FixturePromptDeliverer {
        calls: Arc::clone(&prompt_calls),
        uncertain: false,
    };

    let succeeded = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(execution_with_prompt_target(
            &launcher,
            &prompt_deliverer,
            &FIXTURE_PROVIDER_STATE_PREPARER,
            &FixturePromptActivityObserver::observed(),
            dure_app::AgentProviderPromptTargetV1::LaunchArgument,
        )),
    )
    .await
    .unwrap();

    assert_eq!(succeeded.state, AgentSpawnJournalStateV1::Succeeded);
    assert_eq!(
        *launcher.initial_prompts.lock().unwrap(),
        vec![Some("private prompt".to_string())],
    );
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 0);
    assert!(succeeded.completed.iter().any(|stage| matches!(
        stage.evidence,
        AgentSpawnStageEvidenceV1::RuntimeLaunch {
            initial_prompt_accepted: true,
            ..
        }
    )));
    assert!(
        !serde_json::to_string(&succeeded)
            .unwrap()
            .contains("private prompt")
    );

    let replay = authorize(&store, "dure-local", &body).await.unwrap();
    assert_eq!(apply(&store, replay, &body, None).await.unwrap(), succeeded);
    assert_eq!(launcher.calls.load(Ordering::SeqCst), 1);
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn oversized_launch_argument_prompt_falls_back_to_the_pty_delivery_path() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let prompt = "x".repeat(4097);
    let planned = planned_prompt_spawn_for(&store, &prompt).await;
    let body = apply_body(&planned, &prompt);
    let launcher = RecordingLauncher::default();
    let prompt_calls = Arc::new(AtomicUsize::new(0));
    let prompt_deliverer = FixturePromptDeliverer {
        calls: Arc::clone(&prompt_calls),
        uncertain: false,
    };

    let succeeded = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(execution_with_prompt_target(
            &launcher,
            &prompt_deliverer,
            &FIXTURE_PROVIDER_STATE_PREPARER,
            &FixturePromptActivityObserver::observed(),
            dure_app::AgentProviderPromptTargetV1::LaunchArgument,
        )),
    )
    .await
    .unwrap();

    assert_eq!(succeeded.state, AgentSpawnJournalStateV1::Succeeded);
    assert_eq!(*launcher.initial_prompts.lock().unwrap(), vec![None]);
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 1);
    assert!(succeeded.completed.iter().any(|stage| matches!(
        stage.evidence,
        AgentSpawnStageEvidenceV1::RuntimeLaunch {
            initial_prompt_accepted: false,
            ..
        }
    )));
}

#[tokio::test]
async fn authority_divergence_is_rejected_before_journal_progress() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let planned = planned_prompt_spawn(&store).await;

    let mut wrong_token = apply_body(&planned, "private prompt");
    wrong_token.plan_token =
        AgentSpawnPlanTokenV1::new(format!("sha256:{}", "0".repeat(64))).unwrap();
    assert_eq!(
        authorize(&store, "dure-local", &wrong_token)
            .await
            .unwrap_err(),
        "agent_spawn_apply_authority_mismatch"
    );

    let stale = AgentSpawnApplyBody {
        expected_last_sequence: planned.last_sequence + 1,
        ..apply_body(&planned, "private prompt")
    };
    assert_eq!(
        authorize(&store, "dure-local", &stale).await.unwrap_err(),
        "agent_spawn_revision_conflict"
    );
    assert_eq!(
        authorize(
            &store,
            "different-backend",
            &apply_body(&planned, "private prompt"),
        )
        .await
        .unwrap_err(),
        "agent_spawn_apply_authority_mismatch"
    );
    assert_eq!(
        authorize(
            &store,
            "dure-local",
            &apply_body(&planned, "different prompt"),
        )
        .await
        .unwrap_err(),
        "agent_spawn_prompt_mismatch"
    );
    let unchanged = store
        .agent_spawn_receipt(&planned.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged, planned);
}

#[tokio::test]
async fn backend_successor_can_resume_the_exact_persisted_operation() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let planned = planned_prompt_spawn(&store).await;

    assert_eq!(planned.plan.authority.backend_generation, "generation-1");
    let resumed = authorize(
        &store,
        "dure-local",
        &apply_body(&planned, "private prompt"),
    )
    .await
    .unwrap();

    assert_eq!(resumed, planned);
}

#[tokio::test]
async fn runtime_response_loss_reconciles_one_advanced_successor() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let planned = planned_prompt_spawn(&store).await;
    let requested_session_id = native_launch(&planned.plan).unwrap().0.to_owned();
    let successor_session_id = format!("{requested_session_id}-advanced");
    let body = apply_body(&planned, "private prompt");
    let launcher = ResponseLossLauncher::default();
    let prompt_calls = Arc::new(AtomicUsize::new(0));
    let prompt_deliverer = FixturePromptDeliverer {
        calls: Arc::clone(&prompt_calls),
        uncertain: false,
    };

    let inspect = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(execution(
            &launcher,
            &prompt_deliverer,
            &FixturePromptActivityObserver::observed(),
        )),
    )
    .await
    .unwrap();
    assert_eq!(inspect.state, AgentSpawnJournalStateV1::RetryRequired);
    assert!(matches!(
        inspect.recovery,
        AgentSpawnRecoveryDirectiveV1::RetryRequired {
            stage: AgentSpawnStageV1::RuntimeLaunch,
            failed_attempt: 1,
            ref error_code,
            ..
        } if error_code == "fixture_launch_response_lost"
    ));
    assert_eq!(launcher.calls.load(Ordering::SeqCst), 1);
    assert_eq!(launcher.effects.load(Ordering::SeqCst), 1);
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 0);

    let mut retry = body.clone();
    retry.expected_last_sequence = inspect.last_sequence;
    let succeeded = apply(
        &store,
        authorize(&store, "dure-local", &retry).await.unwrap(),
        &retry,
        Some(execution(
            &launcher,
            &prompt_deliverer,
            &FixturePromptActivityObserver::observed(),
        )),
    )
    .await
    .unwrap();
    assert_eq!(succeeded.state, AgentSpawnJournalStateV1::Succeeded);
    assert_eq!(launcher.calls.load(Ordering::SeqCst), 2);
    assert_eq!(launcher.effects.load(Ordering::SeqCst), 1);
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 1);
    let (session, launch_idempotency_key) = succeeded
        .completed
        .iter()
        .find_map(|stage| match &stage.evidence {
            AgentSpawnStageEvidenceV1::RuntimeLaunch {
                session,
                launch_idempotency_key,
                ..
            } => Some((session, launch_idempotency_key.as_deref())),
            _ => None,
        })
        .unwrap();
    assert_ne!(session.session_id, requested_session_id);
    assert_eq!(session.session_id, successor_session_id);
    let successor_launch_idempotency_key =
        format!("spawn-runtime:{}-advanced", planned.operation_id.as_str());
    assert_eq!(
        launch_idempotency_key,
        Some(successor_launch_idempotency_key.as_str())
    );
    let authority = store
        .agent_checkpoint_binding_authority(&succeeded.plan.agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(authority.binding.session_id, session.session_id);
    assert_eq!(authority.runtime_workspace_id, session.workspace_id);
    assert_eq!(authority.runner_principal, session.runner_principal);
    assert_eq!(authority.runner_instance, session.runner_instance);
    assert_eq!(authority.channel_epoch, session.channel_epoch);
    assert_eq!(authority.host_instance_id, session.host_instance_id);
    assert_eq!(authority.terminal_epoch, session.terminal_epoch);
}

#[tokio::test]
async fn runtime_launch_failure_is_journaled_before_client_retry() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let planned = planned_prompt_spawn(&store).await;
    let body = apply_body(&planned, "private prompt");
    let launch_calls = Arc::new(AtomicUsize::new(0));
    let prompt_calls = Arc::new(AtomicUsize::new(0));
    let launcher = FixtureFailureLauncher {
        calls: Arc::clone(&launch_calls),
    };
    let prompt_deliverer = FixturePromptDeliverer {
        calls: Arc::clone(&prompt_calls),
        uncertain: false,
    };

    let failed = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(execution(
            &launcher,
            &prompt_deliverer,
            &FixturePromptActivityObserver::observed(),
        )),
    )
    .await
    .unwrap();

    assert_eq!(failed.state, AgentSpawnJournalStateV1::RetryRequired);
    assert_eq!(failed.last_sequence, 5);
    assert!(matches!(
        failed.recovery,
        AgentSpawnRecoveryDirectiveV1::RetryRequired {
            stage: AgentSpawnStageV1::RuntimeLaunch,
            failed_attempt: 1,
            ref error_code,
            ..
        } if error_code == "fixture_runtime_unavailable"
    ));
    assert_eq!(launch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        store
            .agent_spawn_receipt(&planned.operation_id)
            .await
            .unwrap()
            .unwrap(),
        failed
    );
}

#[tokio::test]
async fn concurrent_apply_uses_the_journal_fence_and_crosses_each_boundary_once() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let planned = planned_prompt_spawn(&store).await;
    let body = apply_body(&planned, "private prompt");
    let first = authorize(&store, "dure-local", &body).await.unwrap();
    let second = authorize(&store, "dure-local", &body).await.unwrap();
    let launch_calls = Arc::new(AtomicUsize::new(0));
    let prompt_calls = Arc::new(AtomicUsize::new(0));
    let launcher = FixtureLauncher {
        calls: Arc::clone(&launch_calls),
    };
    let prompt_deliverer = FixturePromptDeliverer {
        calls: Arc::clone(&prompt_calls),
        uncertain: false,
    };
    let activity_observer = FixturePromptActivityObserver::observed();

    let first_apply = apply(
        &store,
        first,
        &body,
        Some(execution(&launcher, &prompt_deliverer, &activity_observer)),
    );
    let second_apply = apply(
        &store,
        second,
        &body,
        Some(execution(&launcher, &prompt_deliverer, &activity_observer)),
    );
    let (first_result, second_result) = tokio::join!(first_apply, second_apply);
    assert_eq!(
        usize::from(first_result.is_ok()) + usize::from(second_result.is_ok()),
        1
    );
    assert_eq!(launch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 1);
    let stored = store
        .agent_spawn_receipt(&planned.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.state, AgentSpawnJournalStateV1::Succeeded);
}

/// A prompt that reached the PTY is not a task the provider took up. When the
/// provider stays silent the spawn must say so — 2026-09-01 it reported
/// `succeeded` for an agent that had been handed nothing, because the stage
/// committed on the write receipt alone.
#[tokio::test]
async fn a_prompt_the_provider_never_answered_is_not_a_successful_spawn() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let planned = planned_prompt_spawn(&store).await;
    let body = apply_body(&planned, "private prompt");
    let launcher = FixtureLauncher {
        calls: Arc::new(AtomicUsize::new(0)),
    };
    let prompt_deliverer = FixturePromptDeliverer {
        calls: Arc::new(AtomicUsize::new(0)),
        uncertain: false,
    };

    let unanswered = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(execution(
            &launcher,
            &prompt_deliverer,
            &FixturePromptActivityObserver::stalled(),
        )),
    )
    .await
    .unwrap();

    assert_ne!(unanswered.state, AgentSpawnJournalStateV1::Succeeded);
    assert_eq!(
        unanswered.state,
        AgentSpawnJournalStateV1::PromptDeliveryUncertain
    );
    // The bytes did reach the PTY, so the prompt must never be replayed — the
    // recovery says "do not resend", not "retry".
    let AgentSpawnRecoveryDirectiveV1::DoNotReplayPrompt {
        error_code,
        error_detail,
        ..
    } = unanswered.recovery
    else {
        panic!("an unanswered prompt must not be replayed, got {unanswered:?}");
    };
    assert_eq!(error_code.as_deref(), Some("agent_spawn_prompt_unanswered"));
    // The receipt says what was observed, not only that something went wrong.
    assert!(
        error_detail
            .as_deref()
            .is_some_and(|detail| detail.contains("no output")),
        "the failure must carry its evidence, got {error_detail:?}"
    );
}

#[tokio::test]
async fn uncertain_prompt_delivery_is_durable_and_never_replayed() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let planned = planned_prompt_spawn(&store).await;
    let body = apply_body(&planned, "private prompt");
    let launch_calls = Arc::new(AtomicUsize::new(0));
    let prompt_calls = Arc::new(AtomicUsize::new(0));
    let launcher = FixtureLauncher {
        calls: Arc::clone(&launch_calls),
    };
    let prompt_deliverer = FixturePromptDeliverer {
        calls: Arc::clone(&prompt_calls),
        uncertain: true,
    };
    let uncertain = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(execution(
            &launcher,
            &prompt_deliverer,
            &FixturePromptActivityObserver::observed(),
        )),
    )
    .await
    .unwrap();
    assert_eq!(
        uncertain.state,
        AgentSpawnJournalStateV1::PromptDeliveryUncertain
    );
    assert_eq!(uncertain.last_sequence, 7);
    assert!(matches!(
        uncertain.recovery,
        AgentSpawnRecoveryDirectiveV1::DoNotReplayPrompt {
            error_code: Some(ref code),
            ..
        } if code == "fixture_prompt_uncertain"
    ));
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 1);

    let mut retry = body.clone();
    retry.expected_last_sequence = uncertain.last_sequence;
    let replayed = apply(
        &store,
        authorize(&store, "dure-local", &retry).await.unwrap(),
        &retry,
        None,
    )
    .await
    .unwrap();
    assert_eq!(replayed, uncertain);
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn prompt_failure_before_any_write_can_retry_the_persisted_stage() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("application-state.sqlite3"))
        .await
        .unwrap();
    let planned = planned_prompt_spawn(&store).await;
    let body = apply_body(&planned, "private prompt");
    let launch_calls = Arc::new(AtomicUsize::new(0));
    let prompt_calls = Arc::new(AtomicUsize::new(0));
    let launcher = FixtureLauncher {
        calls: Arc::clone(&launch_calls),
    };
    let prompt_deliverer = NoWriteThenSuccessPromptDeliverer {
        calls: Arc::clone(&prompt_calls),
    };
    let provider_state_preparer = RecordingProviderStatePreparer::default();

    let retry_required = apply(
        &store,
        authorize(&store, "dure-local", &body).await.unwrap(),
        &body,
        Some(execution_with_provider_state_preparer(
            &launcher,
            &prompt_deliverer,
            &provider_state_preparer,
            &FixturePromptActivityObserver::observed(),
        )),
    )
    .await
    .unwrap();
    assert_eq!(
        retry_required.state,
        AgentSpawnJournalStateV1::RetryRequired
    );
    assert!(matches!(
        retry_required.recovery,
        AgentSpawnRecoveryDirectiveV1::RetryRequired {
            stage: AgentSpawnStageV1::PromptDelivery,
            failed_attempt: 1,
            ref error_code,
            ..
        } if error_code == "fixture_prompt_not_written"
    ));

    let mut retry = body.clone();
    retry.expected_last_sequence = retry_required.last_sequence;
    let succeeded = apply(
        &store,
        authorize(&store, "dure-local", &retry).await.unwrap(),
        &retry,
        Some(execution_with_provider_state_preparer(
            &launcher,
            &prompt_deliverer,
            &provider_state_preparer,
            &FixturePromptActivityObserver::observed(),
        )),
    )
    .await
    .unwrap();
    assert_eq!(succeeded.state, AgentSpawnJournalStateV1::Succeeded);
    assert_eq!(launch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(prompt_calls.load(Ordering::SeqCst), 2);
    assert_eq!(provider_state_preparer.calls.load(Ordering::SeqCst), 1);
}
