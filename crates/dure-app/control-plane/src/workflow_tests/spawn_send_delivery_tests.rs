use super::*;

/// Whoever starts a Run can make the durable inbox the only way `dure send`
/// reaches its Agent. The choice crosses the public preview wire, is listed
/// with the Run for the CLI to read before every send, and is advertised.
#[tokio::test]
async fn send_delivery_crosses_the_preview_wire_and_is_listed_with_the_run() {
    let (_root, state, _, _) = fixture(Vec::new()).await;
    let repository = crate::workspace_git::tests::repository().await;
    register_project(
        &state.projects_catalog_path,
        "send-delivery-project".into(),
        "Send delivery fixture".into(),
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
    let body = |key: &str, delivery: Value, preference: Value| {
        let mut body = json!({
            "schemaVersion": 1,
            "idempotencyKey": key,
            "projectId": "send-delivery-project",
            "providerId": "codex",
            "agentName": "worker",
            "worktree": { "kind": "project_root" },
            "promptDigest": null,
            "sendDelivery": delivery,
        });
        if !preference.is_null() {
            body["interactionPreference"] = preference;
        }
        body
    };
    let preview = preview_agent_spawn(
        &state,
        &authority,
        &body("send-delivery-inbox", json!("inbox"), json!("native_cli")),
    )
    .await
    .unwrap();
    assert_eq!(
        preview["receipt"]["plan"]["request"]["sendDelivery"],
        json!("inbox")
    );

    let mut wire = orchestration_backend_request(&state, "send-delivery-list", "", Value::Null);
    wire.operation = "agent_spawn.list".into();
    wire.expected.required_capabilities = vec![
        "agent_spawn.list".into(),
        "agent_spawn.send_delivery.v1".into(),
    ];
    wire.body = json!({
        "schemaVersion": 1,
        "after": null,
        "selector": preview["receipt"]["plan"]["agentId"],
    });
    let listed = dispatch(&state, &wire).await.unwrap();
    assert_eq!(listed["runs"][0]["sendDelivery"], json!("inbox"));

    // Only known deliveries exist, and an inbox needs a terminal Session.
    for (key, delivery, preference) in [
        (
            "send-delivery-unknown",
            json!("terminal"),
            json!("native_cli"),
        ),
        ("send-delivery-unpinned", json!("inbox"), Value::Null),
    ] {
        assert!(
            preview_agent_spawn(&state, &authority, &body(key, delivery, preference))
                .await
                .is_err()
        );
    }
}
