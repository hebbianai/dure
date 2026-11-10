use super::*;

#[tokio::test]
async fn interaction_answer_shape_errors_are_terminal_and_documented_answer_commits() {
    let (_root, state, launcher, _) = fixture_with_delivery(Vec::new(), Vec::new()).await;
    let created = invoke_orchestration(
        &state,
        "interaction-answer-schema-run",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let context = &created["receipt"]["context"];
    let opened = invoke_orchestration(
        &state,
        "interaction-answer-decision",
        "interaction.open",
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "interaction-answer-decision",
            "writeCapability": context["interactionCapability"],
            "expectedDispatchRevision": context["dispatchRevision"],
            "openedAtMs": 1_100,
            "interaction": {
                "kind": "decision",
                "common": {
                    "id": "interaction-answer-decision-1",
                    "target": context["target"],
                    "author": context["participant"],
                    "audience": { "grants": [context["coordinatorGrant"].clone()] },
                    "title": "Choose what to work on next",
                    "descriptionMarkdown": "Pick one recommendation or stop."
                },
                "response": {
                    "kind": "select",
                    "options": [
                        { "id": "local", "label": "Local" },
                        { "id": "stop", "label": "Stop here" }
                    ],
                    "minSelections": 1,
                    "maxSelections": 1
                },
                "replyCapability": context["coordinatorReplyCapability"]
            }
        }),
    )
    .await;
    assert_eq!(opened["receipt"]["dispatchState"], "blocked");
    let interaction = &opened["receipt"]["interaction"];

    // A flat body (decisionId, the worker participant, top-level optionIds and
    // no expected revisions) can never deserialize. Retrying is futile.
    let flat = json!({
        "schemaVersion": 1,
        "idempotencyKey": "interaction-answer-flat",
        "decisionId": interaction["common"]["id"],
        "target": context["target"],
        "participant": context["participant"],
        "interactionCapability": context["interactionCapability"],
        "optionIds": ["local"],
        "answeredAtMs": 1_200
    });
    let error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "interaction-answer-flat",
            "interaction.answer",
            flat,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "orchestration_request_invalid");
    assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);

    // The body published by the MCP schema and the dure-orchestration skill,
    // built from the Decision record and the blocked Dispatch's context.
    let blocked = invoke_orchestration(
        &state,
        "interaction-answer-blocked-context",
        "dispatch.context.get",
        json!({
            "schemaVersion": 1,
            "session": existing_session_run_body()["session"].clone()
        }),
    )
    .await;
    let blocked = &blocked["receipt"];
    assert_eq!(blocked["dispatchState"], "blocked");
    let answered = invoke_orchestration(
        &state,
        "interaction-answer-documented",
        "interaction.answer",
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "interaction-answer-documented",
            "interactionId": interaction["common"]["id"],
            "target": blocked["target"],
            "expectedRevision": interaction["common"]["revision"],
            "expectedDispatchRevision": blocked["dispatchRevision"],
            "answeredBy": blocked["coordinatorGrant"]["participant"],
            "replyCapability": blocked["coordinatorReplyCapability"],
            "answer": { "kind": "select", "optionIds": ["local"] },
            "answeredAtMs": 1_200
        }),
    )
    .await;
    let receipt = &answered["receipt"];
    assert_eq!(receipt["dispatchState"], "active");
    assert_eq!(receipt["interaction"]["state"]["state"], "answered");
    assert!(launcher.requests().is_empty());
}
