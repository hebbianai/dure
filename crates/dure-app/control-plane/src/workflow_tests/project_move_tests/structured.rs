use super::*;
use crate::hmux_session_inspection::AgentActivityEvidence;
use crate::structured_provider_runtime::*;
use dure_app::{AgentRuntimeReplacementAuthorityV1, WorkspaceRecordV1};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

struct WorkspaceRuntime {
    store: Arc<SqliteDomainStore>,
    opens: Mutex<Vec<WorkspaceRecordV1>>,
    cleanups: Mutex<Vec<WorkspaceRecordV1>>,
    fail_first: bool,
    busy: bool,
    stops: AtomicUsize,
    /// What the fake host reports the live source doing.
    activity: Mutex<Option<AgentActivityEvidence>>,
}

impl WorkspaceRuntime {
    async fn replace(
        &self,
        request: StructuredProviderOpenRequestV1,
        transition: &AgentRuntimeTransitionRecordV1,
        workspace: WorkspaceRecordV1,
    ) -> Result<AgentInteractionBindingV1, StructuredProviderRuntimeErrorV1> {
        let attempt = {
            let mut opens = self.opens.lock().unwrap();
            opens.push(workspace);
            opens.len()
        };
        let authority = transition
            .replacement_authority
            .as_ref()
            .map(|authority| &authority.0)
            .unwrap_or(&transition.intent.source_authority);
        let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } = authority else {
            panic!()
        };
        let target = self
            .store
            .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
                schema_version: 1,
                interaction_session_id: binding.interaction_session_id.clone(),
                expected_binding_revision: binding.binding_revision,
                source: binding.runtime.clone(),
                source_execution_profile: binding.execution_profile.clone(),
                target: AgentProviderRuntimeFenceV1 {
                    runtime_generation: format!("move-target-{attempt}"),
                    provider_epoch: format!("move-epoch-{attempt}"),
                },
                target_execution_profile: request.execution_profile,
                provider_conversation_ref: request.provider_conversation_ref,
                replaced_at_ms: binding.updated_at_ms + 1,
            })
            .await
            .unwrap();
        if self.fail_first && attempt == 1 {
            return Err(StructuredProviderRuntimeErrorV1::new(
                StructuredProviderRuntimeErrorKindV1::ExplicitRecoveryRequired,
                "fixture_workspace_target_failed",
            )
            .with_failed_binding(target));
        }
        Ok(target)
    }
}

impl StructuredProviderRuntime for WorkspaceRuntime {
    fn workspace_move_availability(&self) -> Result<(), StructuredProviderRuntimeErrorV1> {
        Ok(())
    }
    fn open(
        &self,
        _: StructuredProviderOpenRequestV1,
    ) -> StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1> {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }
    fn attach_existing<'a>(
        &'a self,
        _: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1> {
        Box::pin(async move { Ok(binding.clone()) })
    }
    fn open_workspace_replacement<'a>(
        &'a self,
        request: StructuredProviderOpenRequestV1,
        workspace: WorkspaceRecordV1,
        transition: &'a AgentRuntimeTransitionRecordV1,
        _: hmux_client::ProviderStateEnvironment,
    ) -> StructuredProviderRuntimeFuture<'a, StructuredProviderWorkspaceOpenReceiptV1> {
        Box::pin(async move {
            let binding = self
                .replace(request, transition, workspace.clone())
                .await
                .map_err(|error| error.at_workspace(&workspace))?;
            Ok(StructuredProviderWorkspaceOpenReceiptV1 { binding, workspace })
        })
    }
    fn open_replacement<'a>(
        &'a self,
        request: StructuredProviderOpenRequestV1,
        transition: &'a AgentRuntimeTransitionRecordV1,
        _: hmux_client::ProviderStateEnvironment,
    ) -> StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1> {
        Box::pin(async move {
            let agent = self.store.agent(&request.agent_id).await.unwrap().unwrap();
            let workspace = self
                .store
                .workspace(&agent.workspace_id)
                .await
                .unwrap()
                .unwrap();
            self.replace(request, transition, workspace).await
        })
    }
    fn stop_replacement_source<'a>(
        &'a self,
        _: &'a AgentRuntimeTransitionRecordV1,
    ) -> StructuredProviderRuntimeFuture<'a, ()> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if self.busy {
                Err(StructuredProviderRuntimeErrorV1::new(
                    StructuredProviderRuntimeErrorKindV1::SourceBusy,
                    "fixture_source_busy",
                ))
            } else {
                Ok(())
            }
        })
    }
    fn source_activity<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
    ) -> StructuredProviderRuntimeFuture<'a, Option<AgentActivityEvidence>> {
        let activity = *self.activity.lock().unwrap();
        Box::pin(async move { Ok(activity) })
    }
    fn quiesce_workspace_target<'a>(
        &'a self,
        transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> StructuredProviderRuntimeFuture<'a, ()> {
        self.cleanups
            .lock()
            .unwrap()
            .push(transition.replacement_workspace.clone().unwrap());
        Box::pin(async { Ok(()) })
    }
    fn retire_replacement_source<'a>(
        &'a self,
        _: &'a AgentRuntimeTransitionRecordV1,
    ) -> StructuredProviderRuntimeFuture<'a, AgentRuntimeReplacementAuthorityV1> {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }
    fn stop_current<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
    ) -> StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

async fn fixture(
    provider: &'static str,
    fail_first: bool,
    busy: bool,
) -> (TempDir, TempDir, ServiceState, Arc<WorkspaceRuntime>) {
    let (root, destination, mut state, _) = setup_provider_mode(
        Vec::new(),
        provider,
        AgentInteractionProfileV1::StructuredProtocol,
    )
    .await;
    let runtime = Arc::new(WorkspaceRuntime {
        store: Arc::clone(&state.store),
        opens: Mutex::new(Vec::new()),
        cleanups: Mutex::new(Vec::new()),
        fail_first,
        busy,
        stops: AtomicUsize::new(0),
        activity: Mutex::new(None),
    });
    let mut runtimes = StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(ProviderIdV1::new(provider).unwrap(), runtime.clone())
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    (root, destination, state, runtime)
}

#[tokio::test]
async fn structured_move_preserves_conversation_account_and_interaction_after_reopen() {
    for provider in ["codex", "claude"] {
        let (_root, _destination, mut state, runtime) = fixture(provider, false, false).await;
        let plan = preview(&state, "structured-success").await.unwrap()["plan"].clone();
        assert_eq!(plan["targetInteractionProfile"], "structured_protocol");
        let response = apply(&state, plan.clone()).await.unwrap();
        assert_eq!(
            response["workspace"],
            plan["workspaceMove"]["targetWorkspace"]
        );
        let binding = &response["receipt"]["authority"]["binding"];
        assert_eq!(binding["interactionSessionId"], "move-interaction");
        assert_eq!(binding["providerConversationRef"], CONVERSATION);
        assert_eq!(binding["executionProfile"], plan["targetExecutionProfile"]);
        assert_eq!(
            response["receipt"]["transitionLineage"]["operationId"],
            plan["operationId"]
        );
        state.store = Arc::new(
            SqliteDomainStore::open(state.store.database_path())
                .await
                .unwrap(),
        );
        assert_eq!(apply(&state, plan.clone()).await.unwrap(), response);
        assert_eq!(runtime.opens.lock().unwrap().len(), 1);
        assert_eq!(runtime.stops.load(Ordering::SeqCst), 1);
        let projection = serde_json::to_value(
            crate::agent_runtime_projection_context::read_agent(
                &state,
                &AgentIdV1::new("coordinator-1").unwrap(),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            projection["workspaceMove"]["sourceStructuredBinding"],
            plan["sourceAuthority"]["binding"]
        );
        assert!(projection["workspaceMove"].get("sourceAuthority").is_none());
    }
}

#[tokio::test]
async fn structured_move_source_repair_keeps_failed_destination_and_exact_lineage() {
    for provider in ["codex", "claude"] {
        let (_root, _destination, mut state, runtime) = fixture(provider, true, false).await;
        let plan = preview(&state, "structured-failed").await.unwrap()["plan"].clone();
        assert!(apply(&state, plan.clone()).await.is_err());
        let operation: OperationIdV1 = serde_json::from_value(plan["operationId"].clone()).unwrap();
        let failed = state
            .store
            .agent_runtime_transition(&operation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(failed.state, AgentRuntimeTransitionStateV1::RepairRequired);
        assert_eq!(
            serde_json::to_value(failed.replacement_workspace).unwrap(),
            plan["workspaceMove"]["targetWorkspace"]
        );
        state.store = Arc::new(
            SqliteDomainStore::open(state.store.database_path())
                .await
                .unwrap(),
        );
        let body = serde_json::from_value(
            json!({"schemaVersion": 1, "agentId": "coordinator-1", "expectedSourceRevision": 1,
            "expectedOperationId": operation, "targetInteractionProfile": "structured_protocol"}),
        )
        .unwrap();
        let repaired =
            agent_runtime_transition_apply::apply(&state, "restore-structured-source", body)
                .await
                .unwrap();
        let response = serde_json::to_value(repaired).unwrap();
        assert_eq!(
            response["authority"]["binding"]["interactionSessionId"],
            "move-interaction"
        );
        assert_eq!(
            response["authority"]["binding"]["providerConversationRef"],
            CONVERSATION
        );
        assert_eq!(
            response["transitionLineage"]["predecessorOperationId"],
            plan["operationId"]
        );
        let opens = runtime.opens.lock().unwrap();
        assert_eq!(opens.len(), 2);
        assert_eq!(
            serde_json::to_value(&opens[1]).unwrap(),
            plan["workspaceMove"]["sourceWorkspace"]
        );
        assert_eq!(runtime.stops.load(Ordering::SeqCst), 1);
    }
}

fn chat_account_switch() -> agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
    agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
        schema_version: 1,
        agent_id: AgentIdV1::new("coordinator-1").unwrap(),
        target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        expected_source_revision: Some(1),
        expected_operation_id: None,
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        target_execution_profile: Some(AgentExecutionProfileV1::ProviderDefault),
        target_launch_selection: None,
    }
}

/// A background shell Claude records as running in the fixture conversation.
fn record_running_background_shell(root: &Path) {
    let conversation = root.join(format!(
        ".claude/projects/original-project/{CONVERSATION}.jsonl"
    ));
    let records = [
        json!({"type": "assistant", "timestamp": "2026-11-02T06:13:20.000Z", "message": {
            "id": "message-background-1", "role": "assistant", "content": [{
                "type": "tool_use", "id": "tool-background-1", "name": "Bash",
                "input": {"command": "sleep 600", "description": "Run the release checks",
                    "run_in_background": true}}]}}),
        json!({"type": "user", "timestamp": "2026-11-02T06:13:21.000Z", "message": {"role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "tool-background-1", "content": "ok"}]},
            "toolUseResult": {"backgroundTaskId": "shell-background-1", "stdout": "", "stderr": "",
                "interrupted": false}}),
    ];
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(conversation)
        .unwrap();
    for record in records {
        writeln!(file, "{record}").unwrap();
    }
}

#[tokio::test]
async fn chat_account_switch_waits_for_background_work_the_host_reports() {
    let (root, _destination, state, runtime) = fixture("claude", false, false).await;
    record_running_background_shell(root.path());
    *runtime.activity.lock().unwrap() = Some(AgentActivityEvidence {
        background_work: true,
        ..Default::default()
    });

    let error = agent_runtime_transition_apply::apply(
        &state,
        "chat-background-switch-1",
        chat_account_switch(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "agent_runtime_source_busy", "{error:?}");
    let details = error.details.as_ref().unwrap();
    assert_eq!(details["reasonCode"], "agent_background_work");
    assert_eq!(
        details["backgroundWork"]["items"][0]["label"],
        "Run the release checks"
    );
    assert_eq!(error.disposition, BackendFailureDispositionV1::RetrySame);
    assert_eq!(
        runtime.stops.load(Ordering::SeqCst),
        0,
        "nothing was stopped"
    );
    assert!(runtime.opens.lock().unwrap().is_empty());
    let agent = AgentIdV1::new("coordinator-1").unwrap();
    let selection = state
        .store
        .agent_runtime_selection(&agent)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(selection.revision, 1, "a refusal never changes the account");

    // The work ended; the same switch is now admitted and applied.
    *runtime.activity.lock().unwrap() = Some(AgentActivityEvidence::default());
    agent_runtime_transition_apply::apply(
        &state,
        "chat-background-switch-2",
        chat_account_switch(),
    )
    .await
    .unwrap();
    assert_eq!(runtime.stops.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.opens.lock().unwrap().len(), 1);
    let selection = state
        .store
        .agent_runtime_selection(&agent)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        selection.execution_profile,
        AgentExecutionProfileV1::ProviderDefault
    );
}

#[tokio::test]
async fn chat_account_switch_names_a_running_turn_and_a_pending_approval() {
    for (activity, expected) in [
        (
            AgentActivityEvidence {
                working: true,
                ..Default::default()
            },
            "agent_working",
        ),
        (
            AgentActivityEvidence {
                working: true,
                attention_required: true,
                background_work: false,
                input_pending: false,
            },
            "agent_attention_required",
        ),
    ] {
        let (_root, _destination, state, runtime) = fixture("claude", false, false).await;
        *runtime.activity.lock().unwrap() = Some(activity);
        let error = agent_runtime_transition_apply::apply(
            &state,
            "chat-busy-switch",
            chat_account_switch(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "agent_runtime_source_busy", "{error:?}");
        assert_eq!(error.details.as_ref().unwrap()["reasonCode"], expected);
        assert_eq!(runtime.stops.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn structured_move_busy_source_never_launches_destination() {
    let (_root, _destination, state, runtime) = fixture("codex", false, true).await;
    let plan = preview(&state, "structured-busy").await.unwrap()["plan"].clone();
    assert!(apply(&state, plan).await.is_err());
    assert!(runtime.opens.lock().unwrap().is_empty());
    assert!(runtime.cleanups.lock().unwrap().is_empty());
}

#[tokio::test]
async fn structured_move_destination_repair_replays_one_target_and_commit_rejection_quiesces_it() {
    for provider in ["codex", "claude"] {
        let (_root, _destination, state, runtime) = fixture(provider, true, false).await;
        let plan = preview(&state, "structured-retry").await.unwrap()["plan"].clone();
        assert!(apply(&state, plan.clone()).await.is_err());
        let operation: OperationIdV1 = serde_json::from_value(plan["operationId"].clone()).unwrap();
        let failed = state
            .store
            .agent_runtime_transition(&operation)
            .await
            .unwrap()
            .unwrap();
        let body = serde_json::from_value(
            json!({"schemaVersion": 1, "agentId": "coordinator-1", "operationId": operation,
            "expectedJournalRevision": failed.journal_revision, "action": {"kind": "retry"}}),
        )
        .unwrap();
        let response = agent_runtime_transition_apply::repair(&state, "retry-destination", body)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(response).unwrap()["authority"]["binding"]["interactionSessionId"],
            "move-interaction"
        );
        assert_eq!(
            apply(&state, plan.clone()).await.unwrap()["workspace"],
            plan["workspaceMove"]["targetWorkspace"]
        );
        assert_eq!(runtime.opens.lock().unwrap().len(), 2);
        let opens = runtime.opens.lock().unwrap();
        assert_eq!(opens[0], opens[1]);
    }

    let (_root, _destination, state, runtime) = fixture("codex", false, false).await;
    let plan = preview(&state, "structured-rejected").await.unwrap()["plan"].clone();
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(state.store.database_path()),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_move_commit BEFORE UPDATE ON agent_runtime_transitions WHEN NEW.state = 'committed' BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END").execute(&pool).await.unwrap();
    assert!(apply(&state, plan.clone()).await.is_err());
    fs::remove_file(&state.projects_catalog_path).unwrap();
    assert!(apply(&state, plan.clone()).await.is_err());
    let cleanups = runtime.cleanups.lock().unwrap();
    assert_eq!(cleanups.len(), 1);
    assert_eq!(
        serde_json::to_value(&cleanups[0]).unwrap(),
        plan["workspaceMove"]["targetWorkspace"]
    );
    assert_eq!(runtime.opens.lock().unwrap().len(), 1);
}
