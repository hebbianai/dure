use super::*;

const OPERATION: &str = "agent_runtime.native_session.resolve.v1";

async fn seed_native_owner(state: &ServiceState, agent: &str, session: &str, workspace: &str) {
    let project_id = ProjectIdV1::new("lookup-project").unwrap();
    let workspace_id = WorkspaceIdV1::new("lookup-workspace").unwrap();
    state
        .store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: "/work/lookup".into(),
            display_name: "Lookup".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    state
        .store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: workspace_id.clone(),
            project_id,
            root_path: "/work/lookup".into(),
            base_commit_sha: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    let agent_id = AgentIdV1::new(agent).unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id,
            provider_id: ProviderIdV1::new("claude").unwrap(),
            display_name: agent.into(),
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&AgentCheckpointBindingAuthorityV1 {
            schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
            binding: SessionBindingRecordV1 {
                agent_id,
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                session_id: session.into(),
                provider_conversation_id: Some("conversation-1".into()),
                credential_reference_id: None,
                binding_generation: 1,
                bound_at_ms: 3,
            },
            runtime_workspace_id: workspace.into(),
            runner_principal: "runner".into(),
            runner_instance: "instance".into(),
            channel_epoch: "1".into(),
            host_instance_id: "host".into(),
            terminal_epoch: format!("terminal-{agent}"),
            updated_at_ms: 3,
        })
        .await
        .unwrap();
}

async fn resolve(state: &Arc<ServiceState>, body: Value) -> Value {
    request_over_test_connection(Arc::clone(state), OPERATION, OPERATION, body).await
}

#[tokio::test]
async fn a_live_session_resolves_to_its_bound_agent_over_the_backend_wire() {
    let (_root, state, launcher, _prompt_deliverer) = fixture(Vec::new()).await;
    seed_native_owner(&state, "lost-pane-agent", "live-session", "live-workspace").await;
    assert!(control_plane_capabilities().contains(&OPERATION.to_string()));
    let state = Arc::new(state);

    let found = resolve(
        &state,
        json!({ "schemaVersion": 1, "sessionId": "live-session" }),
    )
    .await;
    assert_eq!(found["kind"], BACKEND_RESPONSE_KIND, "{found}");
    assert_eq!(
        found["result"],
        json!({
            "schemaVersion": 1,
            "sessionId": "live-session",
            "workspaceId": null,
            "agents": [{
                "agentId": "lost-pane-agent",
                "workspaceId": "live-workspace",
                "bindingGeneration": 1,
            }],
            "complete": true,
        })
    );

    let scoped = resolve(
        &state,
        json!({ "schemaVersion": 1, "sessionId": "live-session", "workspaceId": "live-workspace" }),
    )
    .await;
    assert_eq!(scoped["result"]["agents"][0]["agentId"], "lost-pane-agent");
    for body in [
        json!({ "schemaVersion": 1, "sessionId": "live-session", "workspaceId": "other" }),
        json!({ "schemaVersion": 1, "sessionId": "unbound-session" }),
    ] {
        let empty = resolve(&state, body).await;
        assert_eq!(empty["result"]["agents"], json!([]), "{empty}");
        assert_eq!(empty["result"]["complete"], true);
    }
    for body in [
        json!({ "schemaVersion": 2, "sessionId": "live-session" }),
        json!({ "schemaVersion": 1, "sessionId": "" }),
        json!({ "schemaVersion": 1, "sessionId": "live session" }),
        json!({ "schemaVersion": 1, "sessionId": "live-session", "agentId": "x" }),
    ] {
        let refused = resolve(&state, body).await;
        assert_eq!(refused["kind"], BACKEND_ERROR_KIND, "{refused}");
        assert_eq!(
            refused["error"]["code"],
            "agent_runtime_native_session_resolve_request_invalid"
        );
    }
    // Resolution reads identity only: no Host or provider is contacted.
    assert!(launcher.requests().is_empty());
}

#[tokio::test]
async fn session_resolution_is_a_durable_observation_during_authority_handoff() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(Vec::new()).await;
    seed_native_owner(&state, "lost-pane-agent", "live-session", "live-workspace").await;
    let mut replacement = state.descriptor.clone();
    replacement.generation = "local-v1-11111111111111111111111111111111".into();
    write_descriptor(&state.canonical_descriptor_path, &replacement).unwrap();
    assert!(!state.is_mutation_authority());
    let state = Arc::new(state);

    let found = resolve(
        &state,
        json!({ "schemaVersion": 1, "sessionId": "live-session" }),
    )
    .await;
    assert_eq!(found["kind"], BACKEND_RESPONSE_KIND, "{found}");
    assert_eq!(found["result"]["agents"][0]["agentId"], "lost-pane-agent");
}
