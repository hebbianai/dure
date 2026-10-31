use super::*;

#[tokio::test]
async fn interaction_open_shape_errors_are_terminal_and_documented_update_opens() {
    let (_root, state, launcher, _) = fixture_with_delivery(Vec::new(), Vec::new()).await;
    let created = invoke_orchestration(
        &state,
        "interaction-open-schema-run",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let context = &created["receipt"]["context"];

    // Draft fields at the top level, without the interaction wrapper or the
    // expected Dispatch revision, can never deserialize. Retrying is futile.
    let flat = json!({
        "schemaVersion": 1,
        "idempotencyKey": "interaction-open-flat",
        "interactionId": "interaction-open-flat-message",
        "target": context["target"],
        "author": context["participant"],
        "writeCapability": context["interactionCapability"],
        "audience": { "grants": [context["coordinatorGrant"].clone()] },
        "kind": "message",
        "purpose": "update",
        "title": "Progress update",
        "descriptionMarkdown": "Half of the requested work is verified.",
        "openedAtMs": 1_100
    });
    let error = dispatch(
        &state,
        &orchestration_backend_request(&state, "interaction-open-flat", "interaction.open", flat),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "orchestration_request_invalid");
    assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);

    // The body published by the MCP schema and the dure-orchestration skill.
    let opened = invoke_orchestration(
        &state,
        "interaction-open-documented",
        "interaction.open",
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "interaction-open-documented",
            "writeCapability": context["interactionCapability"],
            "expectedDispatchRevision": context["dispatchRevision"],
            "openedAtMs": 1_100,
            "interaction": {
                "kind": "message",
                "common": {
                    "id": "interaction-open-documented-message",
                    "target": context["target"],
                    "author": context["participant"],
                    "audience": { "grants": [context["coordinatorGrant"].clone()] },
                    "title": "Progress update",
                    "descriptionMarkdown": "Half of the requested work is verified."
                },
                "purpose": "update"
            }
        }),
    )
    .await;
    let receipt = &opened["receipt"];
    assert_eq!(receipt["interaction"]["kind"], "message");
    assert_eq!(receipt["interaction"]["purpose"], "update");
    assert_eq!(receipt["dispatchState"], context["dispatchState"]);
    assert_eq!(
        receipt["deliveries"][0]["participant"],
        context["coordinatorGrant"]["participant"]
    );
    assert!(launcher.requests().is_empty());
}
