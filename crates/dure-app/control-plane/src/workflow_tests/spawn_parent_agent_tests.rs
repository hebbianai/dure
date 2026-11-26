use super::*;

/// A Chat agent has no terminal Session, so a Run it starts records the Agent
/// itself. The link crosses the public preview wire, is listed with the Run,
/// and the listing's capability is advertised.
#[tokio::test]
async fn parent_agent_crosses_the_preview_wire_and_is_listed_with_the_run() {
    let (_root, state, _, _) = fixture(Vec::new()).await;
    let repository = crate::workspace_git::tests::repository().await;
    register_project(
        &state.projects_catalog_path,
        "parent-agent-project".into(),
        "Parent agent fixture".into(),
        repository
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
    )
    .unwrap();
    let authority = BackendRequestAuthority {
        backend_id: state.descriptor.backend_id.clone(),
        generation: state.descriptor.generation.clone(),
    };
    let preview = preview_agent_spawn(
        &state,
        &authority,
        &json!({
            "schemaVersion": 1,
            "idempotencyKey": "parent-agent-child",
            "projectId": "parent-agent-project",
            "providerId": "codex",
            "agentName": "child",
            "interactionPreference": "native_cli",
            "worktree": { "kind": "project_root" },
            "promptDigest": null,
            "parentAgent": { "agentId": "agent-coordinator" },
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        preview["receipt"]["plan"]["request"]["parentAgent"],
        json!({ "agentId": "agent-coordinator" })
    );

    let mut wire = orchestration_backend_request(&state, "parent-agent-list", "", Value::Null);
    wire.operation = "agent_spawn.list".into();
    wire.expected.required_capabilities = vec![
        "agent_spawn.list".into(),
        "agent_spawn.parent_agent.v1".into(),
    ];
    wire.body = json!({ "schemaVersion": 1, "after": null, "selector": null });
    let listed = dispatch(&state, &wire).await.unwrap();
    assert_eq!(
        listed["runs"][0]["parentAgent"],
        json!({ "agentId": "agent-coordinator" })
    );
    assert!(listed["runs"][0].get("parent").is_none());
}
