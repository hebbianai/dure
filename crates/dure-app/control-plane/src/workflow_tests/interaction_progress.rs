use super::*;

#[tokio::test]
async fn progress_tracks_runtime_change_read_ack_and_completion_across_sqlite_reopen() {
    let (root, state, _launcher, deliverer) = fixture_with_delivery(
        Vec::new(),
        vec![DeliveryOutcome::Fail(
            "hmux_agent_prompt_runtime_changed",
            false,
        )],
    )
    .await;
    let (context, body) = prepare_exact_session_message(&state).await;
    invoke_orchestration(
        &state,
        "progress-open",
        "interaction.message.open.exact-session",
        body.clone(),
    )
    .await;
    let query = json!({
        "schemaVersion": 1, "authority": context["target"]["authority"],
        "interactionId": body["interactionId"], "participant": context["participant"],
        "readCapability": context["deliveryCapability"], "endpointFence": context["endpointFence"]
    });
    let progress = invoke_orchestration(
        &state,
        "progress-queued",
        "interaction.progress",
        query.clone(),
    )
    .await;
    let entry = &progress["receipt"]["deliveries"][0];
    assert_eq!(entry["delivery"]["state"], "queued");
    assert_eq!(
        entry["delivery"]["wake"]["reasonCode"],
        "hmux_agent_prompt_runtime_changed"
    );
    assert_eq!(entry["guidance"], "resolve_exact_session_then_wait");
    assert_eq!(entry["observedAtMs"], Value::Null);
    assert_eq!(progress["receipt"]["workerTurnCorrelation"], "not_recorded");
    let author = invoke_orchestration(&state, "progress-author", "interaction.progress", json!({
        "schemaVersion": 1, "authority": context["target"]["authority"],
        "interactionId": body["interactionId"], "participant": context["coordinatorGrant"]["participant"],
        "readCapability": context["interactionCapability"]
    })).await;
    assert_eq!(author, progress);
    let unchanged = invoke_orchestration(
        &state,
        "progress-again",
        "interaction.progress",
        query.clone(),
    )
    .await;
    assert_eq!(progress, unchanged);
    assert_eq!(deliverer.requests().len(), 1);

    let mut read_body = json!({
        "schemaVersion": 1, "authority": context["target"]["authority"], "target": context["target"],
        "participant": context["participant"], "deliveryCapability": context["deliveryCapability"],
        "endpointFence": context["endpointFence"], "after": 0, "limit": 128
    });
    let read =
        invoke_orchestration(&state, "progress-read", "events.read", read_body.clone()).await;
    let observed = invoke_orchestration(
        &state,
        "progress-observed",
        "interaction.progress",
        query.clone(),
    )
    .await;
    assert_eq!(
        observed["receipt"]["deliveries"][0]["delivery"]["state"],
        "observed"
    );
    assert!(
        observed["receipt"]["deliveries"][0]["observedAtMs"]
            .as_i64()
            .is_some()
    );
    read_body["after"] = read["receipt"]["nextCursor"].clone();
    read_body["acknowledgement"] = json!({ "through": read["receipt"]["nextCursor"], "idempotencyKey": "progress-ack",
        "acknowledgementCapability": context["acknowledgementCapability"] });
    invoke_orchestration(&state, "progress-ack", "events.read", read_body).await;
    let acknowledged = invoke_orchestration(
        &state,
        "progress-acknowledged",
        "interaction.progress",
        query.clone(),
    )
    .await;
    assert_eq!(acknowledged["receipt"]["dispatchState"], "active");
    assert_eq!(acknowledged["receipt"]["completedAtMs"], Value::Null);
    assert_eq!(
        acknowledged["receipt"]["deliveries"][0]["guidance"],
        "await_completion"
    );
    let reopened = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let persisted = reopened
        .interaction_service()
        .progress(serde_json::from_value(query.clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(persisted).unwrap(),
        acknowledged["receipt"]
    );
    reopened.close().await;
    invoke_orchestration(&state, "progress-complete", "dispatch.complete", json!({
        "schemaVersion": 1, "idempotencyKey": "progress-complete", "messageId": "progress-completion",
        "target": context["target"], "expectedDispatchRevision": context["dispatchRevision"],
        "completedBy": context["participant"], "endpointFence": context["endpointFence"],
        "audience": { "grants": [context["coordinatorGrant"]] },
        "completionCapability": context["completionCapability"], "title": "Completed",
        "resultMarkdown": "Verified the work.", "completedAtMs": 2_000
    })).await;
    let completed =
        invoke_orchestration(&state, "progress-completed", "interaction.progress", query).await;
    assert_eq!(completed["receipt"]["dispatchState"], "completed");
    assert_eq!(completed["receipt"]["completedAtMs"], 2_000);
    assert_eq!(
        completed["receipt"]["deliveries"][0]["guidance"],
        "dispatch_completed"
    );
    assert_eq!(deliverer.requests().len(), 1);
}
