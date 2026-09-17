use super::*;
use dure_app::{
    AgentIdV1, AgentRuntimeTransitionStore, DomainStore, OperationIdV1, ProviderIdV1,
    SessionCheckoutBindingV1, SessionCheckoutIdentityV1, SessionCheckoutOwnerV1, WorkspaceIdV1,
};

fn request() -> AgentBootstrapV1 {
    AgentBootstrapV1 {
        agent_id: AgentIdV1::new("fresh-agent").unwrap(),
        runtime_workspace_id: WorkspaceIdV1::new("pane-workspace").unwrap(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        working_directory: "/workspace/project".into(),
        display_name: "Agent".into(),
    }
}

fn binding(agent: &AgentBootstrapV1) -> SessionCheckoutBindingV1 {
    SessionCheckoutBindingV1::new(
        SessionCheckoutIdentityV1 {
            runtime_namespace: "/fixture/runtime".into(),
            owner: SessionCheckoutOwnerV1::Agent {
                agent_id: agent.agent_id.clone(),
                registration_id: OperationIdV1::new("first-incarnation").unwrap(),
            },
        },
        agent.working_directory.clone(),
        None,
    )
}

#[tokio::test]
async fn registration_failure_rolls_back_bootstrap_and_retry_commits_one_graph() {
    let temporary = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(temporary.path().join("state.sqlite3"))
        .await
        .unwrap();
    let agent = request();
    let binding = binding(&agent);
    sqlx::query("CREATE TRIGGER fail_checkout_publication BEFORE INSERT ON session_checkout_bindings BEGIN SELECT RAISE(ABORT, 'fixture checkout publication failure'); END")
        .execute(&store.pool).await.unwrap();
    assert!(
        store
            .prepare_agent_checkout(&binding, &agent, 10)
            .await
            .is_err()
    );
    assert!(store.agent(&agent.agent_id).await.unwrap().is_none());
    assert!(
        store
            .workspace(&agent_bootstrap_workspace_id(&agent.agent_id).unwrap())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .project(&agent_bootstrap_project_id(agent.runtime_workspace_id.as_str()).unwrap())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .session_checkout(&binding.identity)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("DROP TRIGGER fail_checkout_publication")
        .execute(&store.pool)
        .await
        .unwrap();
    let registered = store
        .prepare_agent_checkout(&binding, &agent, 20)
        .await
        .unwrap();
    assert_eq!(
        store
            .prepare_agent_checkout(&binding, &agent, 30)
            .await
            .unwrap(),
        registered
    );
    assert_eq!(
        store.agent_runtime_checkout(&agent.agent_id).await.unwrap(),
        Some(registered)
    );
    assert!(
        store
            .agent_runtime_selection(&agent.agent_id)
            .await
            .unwrap()
            .is_none()
    );
    store.close().await;
}

#[tokio::test]
async fn bootstrap_preserves_existing_graph_and_refuses_changed_provider_or_checkout() {
    let temporary = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(temporary.path().join("state.sqlite3"))
        .await
        .unwrap();
    let agent = request();
    store.ensure_agent_identity(&agent, 10).await.unwrap();
    let original = store.agent(&agent.agent_id).await.unwrap().unwrap();
    let workspace = store
        .workspace(&original.workspace_id)
        .await
        .unwrap()
        .unwrap();
    let project = store.project(&workspace.project_id).await.unwrap().unwrap();
    for changed in [
        AgentBootstrapV1 {
            provider_id: ProviderIdV1::new("claude").unwrap(),
            ..agent.clone()
        },
        AgentBootstrapV1 {
            working_directory: "/workspace/different".into(),
            ..agent.clone()
        },
    ] {
        assert!(matches!(
            store.ensure_agent_identity(&changed, 20).await,
            Err(DomainStoreErrorV1::IdentityConflict { .. })
        ));
        assert_eq!(
            store.agent(&agent.agent_id).await.unwrap(),
            Some(original.clone())
        );
    }
    let renamed = AgentBootstrapV1 {
        display_name: "Renamed".into(),
        ..agent.clone()
    };
    store.ensure_agent_identity(&renamed, 30).await.unwrap();
    let updated = store.agent(&agent.agent_id).await.unwrap().unwrap();
    assert_eq!(updated.workspace_id, original.workspace_id);
    assert_eq!(updated.created_at_ms, original.created_at_ms);
    assert_eq!(updated.display_name, "Renamed");
    assert_eq!(
        store.workspace(&original.workspace_id).await.unwrap(),
        Some(workspace)
    );
    assert_eq!(
        store.project(&project.project_id).await.unwrap(),
        Some(project)
    );
    store.close().await;
}
