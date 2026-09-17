use super::*;
use dure_app::AgentSpawnJournalStore;

fn graph_draft() -> Value {
    json!({
        "schemaVersion": 1, "workflowId": "daily-review", "expectedRevision": 0,
        "idempotencyKey": "draft-daily-1", "name": "Daily review", "trigger": {"kind": "manual"},
        "definition": {"schemaVersion": 1, "nodes": [
            {"nodeId": "collect", "name": "Collect", "action": {"actionId": "command", "version": 1},
             "inputs": {"script": {"kind": "literal", "value": "printf 'changes\\n'"}}},
            {"nodeId": "report", "name": "Report", "action": {"actionId": "command", "version": 1},
             "inputs": {"script": {"kind": "literal", "value": "cat"}, "stdin": {"kind": "output", "nodeId": "collect", "field": "stdout"}}}
        ], "edges": []}
    })
}

#[tokio::test]
async fn workflow_graph_draft_round_trip_preserves_mapping_and_validation() {
    let (root, mut state, launcher, _) = fixture(vec![]).await;
    make_fixture_mutation_authority(&mut state);
    let mut draft = graph_draft();
    for node in draft["definition"]["nodes"].as_array_mut().unwrap() {
        node["inputs"]["directory"] = json!({"kind": "literal", "value": root.path()});
    }
    let saved =
        invoke_orchestration(&state, "graph-save", "workflow.graph.put", draft.clone()).await;
    assert_eq!(
        saved["receipt"]["workflow"]["definition"],
        draft["definition"]
    );
    let shown = invoke_orchestration(
        &state,
        "graph-show",
        "workflow.graph.show",
        json!({"schemaVersion": 1, "workflowId": "daily-review"}),
    )
    .await;
    assert_eq!(shown["receipt"]["workflow"]["revision"], 1);
    let validation = invoke_orchestration(
        &state,
        "graph-validate",
        "workflow.graph.validate",
        json!({"schemaVersion": 1, "definition": draft["definition"]}),
    )
    .await;
    assert_eq!(validation["receipt"]["issues"], json!([]));
    assert_eq!(validation["receipt"]["order"], json!(["collect", "report"]));
    assert!(launcher.requests().is_empty());
}

#[tokio::test]
async fn workflow_graph_runs_real_commands_with_immutable_inputs_and_idempotent_manual_admission() {
    let (root, mut state, _, _) = fixture(vec![]).await;
    make_fixture_mutation_authority(&mut state);
    let mut draft = graph_draft();
    for node in draft["definition"]["nodes"].as_array_mut().unwrap() {
        node["inputs"]["directory"] = json!({"kind": "literal", "value": root.path()});
    }
    invoke_orchestration(&state, "put", "workflow.graph.put", draft.clone()).await;
    let request = json!({"schemaVersion": 1, "workflowId": "daily-review", "expectedRevision": 1, "idempotencyKey": "manual-1"});
    let admitted =
        invoke_orchestration(&state, "run", "workflow.graph.run_once", request.clone()).await;
    let run_id = admitted["receipt"]["run"]["runId"].as_str().unwrap();
    crate::workflow_graph::runtime::advance(&state, run_id, "executor-1")
        .await
        .unwrap();
    draft["expectedRevision"] = json!(1);
    draft["idempotencyKey"] = json!("edit-2");
    draft["definition"]["nodes"][1]["inputs"]["script"]["value"] = json!("exit 99");
    invoke_orchestration(&state, "edit", "workflow.graph.put", draft).await;
    crate::workflow_graph::runtime::advance(&state, run_id, "executor-2")
        .await
        .unwrap();
    let inspected = invoke_orchestration(
        &state,
        "inspect",
        "workflow.graph.inspect",
        json!({"schemaVersion": 1, "runId": run_id, "nodeId": "report"}),
    )
    .await;
    let tasks = &inspected["receipt"]["tasks"];
    assert_eq!(tasks[0]["state"]["kind"], "completed");
    assert_eq!(tasks[1]["state"]["kind"], "completed");
    assert_eq!(
        inspected["receipt"]["task"]["state"]["inputs"]["stdin"],
        "changes\n"
    );
    assert_eq!(
        inspected["receipt"]["task"]["state"]["outputs"]["stdout"],
        "changes\n"
    );
    let replayed = invoke_orchestration(&state, "retry", "workflow.graph.run_once", request).await;
    assert_eq!(replayed, admitted);
    assert_eq!(
        state
            .store
            .workflow_runs(Some("daily-review"), false)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        inspected["receipt"]["version"]["definition"]["nodes"][1]["inputs"]["script"]["value"],
        "cat"
    );
}

#[tokio::test]
async fn workflow_graph_failed_command_retains_stderr_and_does_not_execute_downstream() {
    let (root, mut state, _, _) = fixture(vec![]).await;
    make_fixture_mutation_authority(&mut state);
    let mut draft = graph_draft();
    for node in draft["definition"]["nodes"].as_array_mut().unwrap() {
        node["inputs"]["directory"] = json!({"kind": "literal", "value": root.path()});
    }
    draft["definition"]["nodes"][0]["inputs"]["script"]["value"] =
        json!("printf 'test failed' >&2; exit 7");
    draft["definition"]["nodes"][1]["inputs"]["script"]["value"] = json!("touch should-not-run");
    invoke_orchestration(&state, "put", "workflow.graph.put", draft).await;
    let run = invoke_orchestration(&state, "run", "workflow.graph.run_once", json!({"schemaVersion": 1, "workflowId": "daily-review", "expectedRevision": 1, "idempotencyKey": "manual-1"})).await;
    let id = run["receipt"]["run"]["runId"].as_str().unwrap();
    crate::workflow_graph::runtime::advance(&state, id, "executor-1")
        .await
        .unwrap();
    crate::workflow_graph::runtime::advance(&state, id, "executor-1")
        .await
        .unwrap();
    let (run, _) = state.store.workflow_run(id).await.unwrap().unwrap();
    assert_eq!(
        run.status(),
        agent_orchestration::domain::graph::RunStatus::Failed
    );
    let json = serde_json::to_value(run).unwrap();
    assert_eq!(
        json["tasks"][0]["state"]["outputs"]["stderr"],
        "test failed"
    );
    assert_eq!(json["tasks"][0]["state"]["outputs"]["exitCode"], 7);
    assert!(!root.path().join("should-not-run").exists());
}

#[tokio::test]
async fn workflow_graph_schedule_pins_active_version_and_pause_preserves_admitted_runs() {
    let (root, mut state, _, _) = fixture(vec![]).await;
    make_fixture_mutation_authority(&mut state);
    let mut draft = graph_draft();
    for node in draft["definition"]["nodes"].as_array_mut().unwrap() {
        node["inputs"]["directory"] = json!({"kind": "literal", "value": root.path()});
    }
    draft["trigger"] = json!({"kind": "schedule", "expression": "* * * * *", "timezone": "UTC"});
    invoke_orchestration(&state, "put", "workflow.graph.put", draft.clone()).await;
    invoke_orchestration(&state, "activate", "workflow.graph.activate", json!({"schemaVersion": 1, "workflowId": "daily-review", "expectedRevision": 1, "idempotencyKey": "activate-1"})).await;
    draft["expectedRevision"] = json!(2);
    draft["idempotencyKey"] = json!("incomplete-edit");
    draft["definition"]["nodes"] = json!([]);
    draft["trigger"] = json!({"kind": "manual"});
    invoke_orchestration(&state, "edit", "workflow.graph.put", draft).await;
    crate::workflow_graph::runtime::admit_schedules(&state, 120_000)
        .await
        .unwrap();
    crate::workflow_graph::runtime::admit_schedules(&state, 120_000)
        .await
        .unwrap();
    let runs = state
        .store
        .workflow_runs(Some("daily-review"), false)
        .await
        .unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].workflow_version, 1);
    assert_eq!(runs[0].tasks.len(), 2);
    invoke_orchestration(&state, "pause", "workflow.graph.pause", json!({"schemaVersion": 1, "workflowId": "daily-review", "expectedRevision": 3, "idempotencyKey": "pause-1"})).await;
    crate::workflow_graph::runtime::admit_schedules(&state, 180_000)
        .await
        .unwrap();
    assert_eq!(
        state
            .store
            .workflow_runs(Some("daily-review"), false)
            .await
            .unwrap()
            .len(),
        1
    );
    for _ in 0..2 {
        crate::workflow_graph::runtime::advance(&state, runs[0].run_id.as_str(), "executor")
            .await
            .unwrap();
    }
    assert_eq!(
        state
            .store
            .workflow_run(runs[0].run_id.as_str())
            .await
            .unwrap()
            .unwrap()
            .0
            .status(),
        agent_orchestration::domain::graph::RunStatus::Completed
    );
}

#[tokio::test]
async fn workflow_graph_reopened_started_command_is_uncertain_and_never_replayed() {
    let (root, mut state, _, _) = fixture(vec![]).await;
    make_fixture_mutation_authority(&mut state);
    let mut draft = graph_draft();
    for node in draft["definition"]["nodes"].as_array_mut().unwrap() {
        node["inputs"]["directory"] = json!({"kind": "literal", "value": root.path()});
    }
    draft["definition"]["nodes"][0]["inputs"]["script"]["value"] = json!("touch must-not-repeat");
    invoke_orchestration(&state, "put", "workflow.graph.put", draft).await;
    let admitted = invoke_orchestration(&state, "run", "workflow.graph.run_once", json!({"schemaVersion": 1, "workflowId": "daily-review", "expectedRevision": 1, "idempotencyKey": "crash-run"})).await;
    let id = admitted["receipt"]["run"]["runId"].as_str().unwrap();
    let (run, version) = state.store.workflow_run(id).await.unwrap().unwrap();
    let catalog = invoke_orchestration(
        &state,
        "catalog",
        "workflow.graph.catalog",
        json!({"schemaVersion": 1}),
    )
    .await;
    let contracts =
        serde_json::from_value::<Vec<agent_orchestration::domain::graph::ActionContract>>(
            catalog["receipt"]["actions"].clone(),
        )
        .unwrap();
    let mut execution = agent_orchestration::domain::graph::ExecutingWorkflow::restore(
        &version,
        &contracts,
        run.clone(),
    )
    .unwrap();
    execution
        .start_next("old-executor", now_ms().unwrap())
        .unwrap();
    state
        .store
        .update_workflow_run(&run, &execution)
        .await
        .unwrap();
    state.store.close().await;
    state.store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite"))
            .await
            .unwrap(),
    );
    crate::workflow_graph::runtime::advance(&state, id, "new-executor")
        .await
        .unwrap();
    let retained = state.store.workflow_run(id).await.unwrap().unwrap().0;
    assert_eq!(
        retained.status(),
        agent_orchestration::domain::graph::RunStatus::Uncertain
    );
    assert!(!root.path().join("must-not-repeat").exists());
}

async fn admit_agent_graph(state: &ServiceState, directory: &Path) -> String {
    let mut draft = graph_draft();
    draft["definition"]["nodes"][0] = json!({"nodeId": "collect", "name": "Review", "action": {"actionId": "agent", "version": 1}, "inputs": {
        "projectId": {"kind": "literal", "value": "project-1"}, "providerId": {"kind": "literal", "value": "codex"},
        "prompt": {"kind": "literal", "value": "Review the project and report the result."}
    }});
    draft["definition"]["nodes"][1]["inputs"]["stdin"]["field"] = json!("resultMarkdown");
    draft["definition"]["nodes"][1]["inputs"]["directory"] =
        json!({"kind": "literal", "value": directory});
    invoke_orchestration(state, "put", "workflow.graph.put", draft).await;
    let run = invoke_orchestration(state, "run", "workflow.graph.run_once", json!({"schemaVersion": 1, "workflowId": "daily-review", "expectedRevision": 1, "idempotencyKey": "agent-run"})).await;
    run["receipt"]["run"]["runId"].as_str().unwrap().into()
}

async fn graph_agent_session(state: &ServiceState, run_id: &str) -> WorkflowSessionGenerationV1 {
    let run = state.store.workflow_run(run_id).await.unwrap().unwrap().0;
    let agent_orchestration::domain::graph::ActionState::Started {
        effect_ref: Some(operation),
        ..
    } = &run.tasks[0].state
    else {
        panic!("agent launch must retain its effect: {run:?}")
    };
    let receipt = state
        .store
        .agent_spawn_receipt(&OperationIdV1::new(operation.clone()).unwrap())
        .await
        .unwrap()
        .unwrap();
    receipt
        .completed
        .iter()
        .find_map(|stage| match &stage.evidence {
            dure_app::AgentSpawnStageEvidenceV1::RuntimeLaunch { session, .. } => {
                Some(session.clone())
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("Agent launch missing: {receipt:?}"))
}

async fn complete_agent_graph(
    state: &ServiceState,
    run_id: &str,
    session: &WorkflowSessionGenerationV1,
) {
    let mut body = existing_session_run_body();
    body["session"] = json!(session);
    let created = invoke_orchestration(state, "report-enroll", "run.create", body.clone()).await;
    schedule_runtime_tests::complete_report(
        state,
        &created["receipt"]["context"],
        "report-complete",
        "Actual agent report.",
    )
    .await;
    body["idempotencyKey"] = json!("unrelated-successor");
    let successor = invoke_orchestration(state, "successor-enroll", "run.create", body).await;
    schedule_runtime_tests::complete_report(
        state,
        &successor["receipt"]["context"],
        "successor-complete",
        "Unrelated later work.",
    )
    .await;
    for _ in 0..2 {
        crate::workflow_graph::runtime::advance(state, run_id, "reconnected-executor")
            .await
            .unwrap();
    }
    let retained = state.store.workflow_run(run_id).await.unwrap().unwrap().0;
    assert_eq!(
        retained.status(),
        agent_orchestration::domain::graph::RunStatus::Completed
    );
    let agent_orchestration::domain::graph::ActionState::Completed { outputs, .. } =
        &retained.tasks[1].state
    else {
        panic!("downstream command missing")
    };
    assert_eq!(outputs["stdout"], "Actual agent report.");
}

#[tokio::test]
async fn workflow_graph_agent_waits_for_exact_report_and_resumes_without_launching_again() {
    let (root, mut state, launcher, _) = fixture(vec![LaunchOutcome::Succeed]).await;
    make_fixture_mutation_authority(&mut state);
    schedule_runtime_tests::prepare_project(&root, &state).await;
    state
        .store
        .put_provider_launch_defaults(
            &ProviderLaunchDefaultsPutRequestV1 {
                schema_version: PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1,
                idempotency_key: "graph-defaults".into(),
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
    let id = admit_agent_graph(&state, root.path()).await;
    crate::workflow_graph::runtime::advance(&state, &id, "executor")
        .await
        .unwrap();
    let session = graph_agent_session(&state, &id).await;
    crate::workflow_graph::runtime::advance(&state, &id, "reconnected-executor")
        .await
        .unwrap();
    assert_eq!(launcher.requests().len(), 1);
    assert_eq!(
        launcher.requests()[0].permission_mode,
        AgentSpawnPermissionModeV1::SkipPermissions
    );
    let run = state.store.workflow_run(&id).await.unwrap().unwrap().0;
    assert!(matches!(
        run.tasks[1].state,
        agent_orchestration::domain::graph::ActionState::Pending
    ));
    fs::write(state.hmux_identity.discovery_root.join("current-session.json"), serde_json::to_vec(&json!({
        "schema_version": 1, "session_class": "managed", "lifecycle": "ready", "health": "healthy",
        "session_id": session.session_id, "workspace_id": session.workspace_id, "provider_id": session.provider_id,
        "runner_principal": session.runner_principal, "runner_instance": session.runner_instance, "channel_epoch": session.channel_epoch,
        "host_instance_id": session.host_instance_id, "terminal_epoch": session.terminal_epoch,
    })).unwrap()).unwrap();
    complete_agent_graph(&state, &id, &session).await;
    state.store.close().await;
    let reopened = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    assert_eq!(
        reopened
            .workflow_run(&id)
            .await
            .unwrap()
            .unwrap()
            .0
            .status(),
        agent_orchestration::domain::graph::RunStatus::Completed
    );
}

#[tokio::test]
#[ignore = "requires isolated real Hmux; run pnpm test:hmux-graph"]
async fn workflow_graph_uses_real_hmux() {
    let (root, mut state, _, _) = fixture(vec![]).await;
    schedule_runtime_tests::prepare_project(&root, &state).await;
    make_fixture_mutation_authority(&mut state);
    let hmux = real_hmux::RealHmux::install(root, &mut state);
    let id = admit_agent_graph(&state, &hmux.root).await;
    crate::workflow_graph::runtime::advance(&state, &id, "executor")
        .await
        .unwrap();
    let session = graph_agent_session(&state, &id).await;
    crate::workflow_graph::runtime::advance(&state, &id, "reconnected-executor")
        .await
        .unwrap();
    assert_eq!(hmux.requests().len(), 1);
    complete_agent_graph(&state, &id, &session).await;
    hmux.stop(&session);
    state.store.close().await;
    let reopened = SqliteDomainStore::open(hmux.root.join("domain.sqlite"))
        .await
        .unwrap();
    assert_eq!(
        reopened
            .workflow_run(&id)
            .await
            .unwrap()
            .unwrap()
            .0
            .status(),
        agent_orchestration::domain::graph::RunStatus::Completed
    );
}
