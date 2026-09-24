use super::*;

#[tokio::test]
async fn completion_request_errors_are_terminal_and_corrected_v1_report_is_idempotent() {
    let (_root, state, launcher, _) = fixture_with_delivery(Vec::new(), Vec::new()).await;
    let created = invoke_orchestration(
        &state,
        "completion-schema-run",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let context = &created["receipt"]["context"];
    let body = json!({
        "schemaVersion": 1,
        "idempotencyKey": "completion-schema-report",
        "messageId": "completion-schema-message",
        "target": context["target"],
        "expectedDispatchRevision": context["dispatchRevision"],
        "completedBy": context["participant"],
        "endpointFence": context["endpointFence"],
        "audience": { "grants": [context["coordinatorGrant"].clone()] },
        "completionCapability": context["completionCapability"],
        "title": "Work complete",
        "resultMarkdown": "The requested work is verified.",
        "completedAtMs": 1_100
    });

    for report_field in ["reportMarkdown", "descriptionMarkdown", "empty-title"] {
        let mut invalid = body.clone();
        if report_field == "empty-title" {
            invalid["title"] = json!("");
        } else {
            let object = invalid.as_object_mut().unwrap();
            for (canonical, guessed) in [
                ("completedBy", "participant"),
                ("expectedDispatchRevision", "expectedRevision"),
                ("messageId", "interactionId"),
                ("resultMarkdown", report_field),
            ] {
                let value = object.remove(canonical).unwrap();
                object.insert(guessed.into(), value);
            }
            object.remove("audience");
        }
        let error = dispatch(
            &state,
            &orchestration_backend_request(&state, report_field, "dispatch.complete", invalid),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "orchestration_request_invalid");
        assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
        let current = invoke_orchestration(
            &state,
            "context-after-invalid-report",
            "dispatch.context.get",
            json!({ "schemaVersion": 1, "session": existing_session_run_body()["session"] }),
        )
        .await;
        assert_eq!(
            current["receipt"]["dispatchState"],
            context["dispatchState"]
        );
        assert_eq!(
            current["receipt"]["dispatchRevision"],
            context["dispatchRevision"]
        );
    }

    // The same completion identity can be corrected after a definite rejection;
    // identical retries after acceptance return the original durable result.
    for idempotent in [false, true] {
        let result = invoke_orchestration(
            &state,
            "completion-schema-submit",
            "dispatch.complete",
            body.clone(),
        )
        .await;
        assert_eq!(result["receipt"]["dispatchState"], "completed");
        assert_eq!(result["receipt"]["idempotent"], idempotent);
    }
    assert!(launcher.requests().is_empty());
}
