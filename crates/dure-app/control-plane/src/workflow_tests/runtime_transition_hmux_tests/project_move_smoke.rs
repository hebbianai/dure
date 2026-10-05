use super::*;
use agent_runtime_transition_apply::project_move;

#[tokio::test]
#[ignore = "isolated native project move; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn project_move_uses_real_hmux() {
    project_move_case(false).await;
    project_move_case(true).await;
}

async fn project_move_case(reject_after_start: bool) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let destination = crate::workspace_git::tests::repository().await;
    let destination_root = destination.path().canonicalize().unwrap();
    let marker = root.path().join("target-starts");
    // The source exits by itself. Only the fixture replacement remains alive;
    // the standard QA guardian owns its exact-generation cleanup.
    fs::write(root.path().join("codex-fixture"), format!(
        "#!/bin/sh\nif [ \"$PWD\" = '{}' ]; then printf '%s\\n' \"$PWD\" \"$@\" >> '{}'; exec sleep 120; fi\nif [ ! -e '{}' ]; then touch '{}'; exit 0; fi\nexec sleep 120\n",
        destination_root.display(), marker.display(), root.path().join("source-exited").display(), root.path().join("source-exited").display())).unwrap();
    register_project(
        &state.projects_catalog_path,
        "move-destination".into(),
        "Move destination".into(),
        destination_root.to_str().unwrap().into(),
    )
    .unwrap();
    let isolated_home = PathBuf::from(std::env::var_os("HOME").unwrap());
    assert!(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").is_some());
    assert!(
        isolated_home
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("dure-control-plane-qa-home-")
    );
    let sessions = isolated_home.join(".codex/sessions");
    fs::create_dir_all(&sessions).unwrap();
    let history = sessions.join(format!("rollout-{CONVERSATION}.jsonl"));
    let original_history =
        format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{CONVERSATION}\"}}}}\n");
    fs::write(&history, &original_history).unwrap();
    let preserved_file = destination_root.join("preserve.txt");
    fs::write(&preserved_file, "unchanged").unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let source = launch(&state, &hmux, "project-move-source").await;
    let agent = AgentIdV1::new("project-move-agent").unwrap();
    bind_source(&state, &agent, &source).await;
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&agent)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if query_hmux_for_runtime_transition(
                &state.hmux_identity,
                &source.session_id,
                &source.workspace_id,
                &authority_stop_fence(&authority),
            )
            .await
            .is_ok_and(|observed| observed.is_exited_exact())
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    let preview = project_move::preview(&state, serde_json::from_value(json!({"schemaVersion": 1, "agentId": agent, "projectId": "move-destination", "idempotencyKey": "native-project-move"})).unwrap()).await.unwrap();
    assert_eq!(hmux.requests().len(), 1);
    let body = json!({"schemaVersion": 1, "plan": preview["plan"], "confirmRestart": true});
    if reject_after_start {
        let pool = sqlx::SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new().filename(state.store.database_path()),
        )
        .await
        .unwrap();
        sqlx::query("CREATE TRIGGER fail_move_commit BEFORE UPDATE ON agent_runtime_transitions WHEN NEW.state = 'committed' BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END")
            .execute(&pool).await.unwrap();
        assert!(
            project_move::apply(&state, serde_json::from_value(body.clone()).unwrap())
                .await
                .is_err()
        );
        sqlx::query("DROP TRIGGER fail_move_commit")
            .execute(&pool)
            .await
            .unwrap();
        let operation: OperationIdV1 =
            serde_json::from_value(preview["plan"]["operationId"].clone()).unwrap();
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
        fs::remove_file(&history).unwrap();
        for _ in 0..2 {
            assert_eq!(
                project_move::apply(&state, serde_json::from_value(body.clone()).unwrap())
                    .await
                    .unwrap_err()
                    .code,
                "agent_runtime_repair_required"
            );
            assert_eq!(hmux.requests().len(), 2);
        }
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
        let AgentRuntimeBindingAuthorityV1::NativeCli { authority: target } =
            started.target_authority.unwrap()
        else {
            panic!()
        };
        assert!(
            query_hmux_for_runtime_transition(
                &state.hmux_identity,
                &target.binding.session_id,
                &target.runtime_workspace_id,
                &authority_stop_fence(&target)
            )
            .await
            .unwrap()
            .is_exited_exact()
        );
        assert_eq!(
            state
                .store
                .agent(&agent)
                .await
                .unwrap()
                .unwrap()
                .workspace_id,
            rejected
                .intent
                .workspace_move
                .as_ref()
                .unwrap()
                .source_workspace
                .workspace_id
        );
        assert_eq!(fs::read_to_string(&preserved_file).unwrap(), "unchanged");
        // Restore this fixture's history and use the existing runtime repair owner.
        fs::write(&history, &original_history).unwrap();
        let rollback = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let result = agent_runtime_transition_apply::apply(
                    &state, "native-move-rollback", serde_json::from_value(json!({
                        "schemaVersion": 1, "agentId": agent, "targetInteractionProfile": "native_cli",
                        "expectedSourceRevision": rejected.intent.source.revision,
                    })).unwrap(),
                ).await;
                match result {
                    Ok(receipt) => break receipt,
                    // A transient observation is not proof of exit or permission
                    // to create another repair. Retain this exact request.
                    Err(error) if error.code == "hmux_descriptor_unavailable" => {
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                    Err(error) => panic!("{error:?}"),
                }
            }
        }).await.unwrap();
        assert_eq!(
            serde_json::to_value(rollback).unwrap()["providerConversationRef"],
            CONVERSATION
        );
        assert_eq!(
            state
                .store
                .agent(&agent)
                .await
                .unwrap()
                .unwrap()
                .workspace_id,
            rejected
                .intent
                .workspace_move
                .as_ref()
                .unwrap()
                .source_workspace
                .workspace_id
        );
        return;
    }
    let applied = project_move::apply(&state, serde_json::from_value(body.clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(applied["receipt"]["providerConversationRef"], CONVERSATION);
    assert_eq!(
        project_move::apply(&state, serde_json::from_value(body).unwrap())
            .await
            .unwrap(),
        applied
    );
    assert_eq!(hmux.requests().len(), 2);
    let selected = state.store.agent(&agent).await.unwrap().unwrap();
    let workspace = state
        .store
        .workspace(&selected.workspace_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(workspace.root_path, destination_root.to_str().unwrap());
    assert_eq!(workspace.project_id.as_str(), "move-destination");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !marker.is_file() {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    let start = fs::read_to_string(&marker).unwrap();
    assert!(start.starts_with(destination_root.to_str().unwrap()));
    assert!(start.contains(&format!("--cd\n{}", destination_root.display())));
    assert!(start.contains(CONVERSATION));
    assert_eq!(fs::read_to_string(preserved_file).unwrap(), "unchanged");
    assert_eq!(fs::read_to_string(history).unwrap(), original_history);
}
