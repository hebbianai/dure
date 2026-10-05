use super::*;

async fn move_plan(store: &SqliteDomainStore) -> AgentRuntimeTransitionIntentV1 {
    let mut plan = intent("move-project", "move-project-key");
    plan.target_interaction_profile = AgentInteractionProfileV1::NativeCli;
    let source_agent = store.agent(&plan.source.agent_id).await.unwrap().unwrap();
    let source_workspace = store
        .workspace(&source_agent.workspace_id)
        .await
        .unwrap()
        .unwrap();
    plan.workspace_move = Some(dure_app::AgentRuntimeWorkspaceMoveV1 {
        source_agent,
        source_workspace,
        target_project: ProjectRecordV1 {
            project_id: ProjectIdV1::new("project-2").unwrap(),
            root_path: "/workspace/other".into(),
            display_name: "Other".into(),
            created_at_ms: 110,
            updated_at_ms: 110,
        },
        target_workspace: WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new("workspace-2").unwrap(),
            project_id: ProjectIdV1::new("project-2").unwrap(),
            root_path: "/workspace/other".into(),
            base_commit_sha: None,
            created_at_ms: 110,
            updated_at_ms: 110,
        },
        registered_root_id: "root-2".into(),
        observed_root_id: "observed-root-2".into(),
        registered_repository_id: "repository-2".into(),
    });
    plan
}

async fn start_target(store: &SqliteDomainStore, plan: &AgentRuntimeTransitionIntentV1) {
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            120,
        ))
        .await
        .unwrap();
    let identity = dure_app::agent_runtime_native_launch_identity_v1(&plan.operation_id);
    let AgentRuntimeBindingAuthorityV1::NativeCli { mut authority } = native_authority() else {
        panic!()
    };
    authority.binding.session_id = identity.session_id;
    authority.binding.binding_generation += 1;
    authority.binding.bound_at_ms = 130;
    authority.runtime_workspace_id = "workspace-2".into();
    authority.host_instance_id = "host-2".into();
    authority.terminal_epoch = "terminal-2".into();
    authority.updated_at_ms = 130;
    store
        .upsert_agent_checkpoint_binding_authority(&authority)
        .await
        .unwrap();
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            2,
            AgentRuntimeTransitionAdvanceV1::TargetStarted {
                authority: Box::new(AgentRuntimeBindingAuthorityV1::NativeCli { authority }),
                launch_idempotency_key: Some(identity.launch_idempotency_key),
            },
            130,
        ))
        .await
        .unwrap();
}

#[tokio::test]
async fn workspace_move_publishes_only_with_runtime_commit_and_replays_after_reopen() {
    let root = TempDir::new().unwrap();
    let path = database_path(&root);
    let store = initialized_store(&path).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = move_plan(&store).await;
    let movement = plan.workspace_move.as_ref().unwrap();
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    start_target(&store, &plan).await;
    assert_eq!(
        store.agent(&plan.source.agent_id).await.unwrap(),
        Some(movement.source_agent.clone())
    );
    let request = advance(
        &plan.operation_id,
        3,
        AgentRuntimeTransitionAdvanceV1::Committed,
        140,
    );
    let committed = store
        .advance_agent_runtime_transition(&request)
        .await
        .unwrap();
    assert_eq!(
        store
            .agent(&plan.source.agent_id)
            .await
            .unwrap()
            .unwrap()
            .workspace_id,
        movement.target_workspace.workspace_id
    );
    assert_eq!(
        store
            .workspace(&movement.source_workspace.workspace_id)
            .await
            .unwrap(),
        Some(movement.source_workspace.clone())
    );
    assert_eq!(
        store
            .agent_runtime_selection(&plan.source.agent_id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        2
    );
    drop(store);
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .admit_agent_runtime_transition(&plan)
            .await
            .unwrap(),
        committed
    );
    assert_eq!(
        reopened
            .advance_agent_runtime_transition(&request)
            .await
            .unwrap(),
        committed
    );
    assert_eq!(
        reopened
            .agent(&plan.source.agent_id)
            .await
            .unwrap()
            .unwrap()
            .workspace_id,
        movement.target_workspace.workspace_id
    );
}

#[tokio::test]
async fn workspace_move_commit_failure_rolls_back_workspace_and_selection_together() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = move_plan(&store).await;
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    start_target(&store, &plan).await;
    sqlx::query("CREATE TRIGGER fail_move_commit BEFORE UPDATE ON agent_runtime_transitions WHEN NEW.state = 'committed' BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END")
        .execute(&store.pool).await.unwrap();
    assert!(
        store
            .advance_agent_runtime_transition(&advance(
                &plan.operation_id,
                3,
                AgentRuntimeTransitionAdvanceV1::Committed,
                140
            ))
            .await
            .is_err()
    );
    assert_eq!(
        store.agent(&plan.source.agent_id).await.unwrap(),
        Some(plan.workspace_move.as_ref().unwrap().source_agent.clone())
    );
    assert_eq!(
        store
            .agent_runtime_selection(&plan.source.agent_id)
            .await
            .unwrap(),
        Some(plan.source.clone())
    );
    assert_eq!(
        store
            .agent_runtime_transition(&plan.operation_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::TargetStarted
    );
}

#[tokio::test]
async fn workspace_move_rejects_a_source_or_destination_changed_after_preview() {
    for target_changed in [false, true] {
        let root = TempDir::new().unwrap();
        let store = initialized_store(&database_path(&root)).await;
        store
            .initialize_agent_runtime_selection(&native_selection())
            .await
            .unwrap();
        let plan = move_plan(&store).await;
        let movement = plan.workspace_move.as_ref().unwrap();
        if target_changed {
            let mut target = movement.target_project.clone();
            target.root_path = "/workspace/replaced".into();
            store.upsert_project(&target).await.unwrap();
        } else {
            let mut source = movement.source_workspace.clone();
            source.root_path = "/workspace/replaced".into();
            source.updated_at_ms += 1;
            store.upsert_workspace(&source).await.unwrap();
        }
        assert!(store.admit_agent_runtime_transition(&plan).await.is_err());
        assert!(
            store
                .agent_runtime_transition(&plan.operation_id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .workspace(&movement.target_workspace.workspace_id)
                .await
                .unwrap()
                .is_none()
        );
    }
}
