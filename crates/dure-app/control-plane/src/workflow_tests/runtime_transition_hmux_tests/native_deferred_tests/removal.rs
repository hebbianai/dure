use super::*;

#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn hibernated_native_removal_never_wakes_a_replacement() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 300\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new("hibernated-remove-agent").unwrap();
    let source = launch(&state, &hmux, "hibernated-remove-source").await;
    let original = hmux.session(&source);
    bind_source(&state, &agent_id, &source).await;
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    let asleep = call(
        &state,
        "hibernate",
        "hibernate-before-removal",
        observe_idle_body(&state, &hmux, &agent_id, &source, true).await,
    )
    .await
    .unwrap();
    assert_eq!(asleep["deferredTarget"]["state"], "waiting");
    RealHmux::assert_exited(&original).await;
    assert_eq!(
        hmux.session(&source).lifecycle,
        hmux_client::SessionLifecycle::Exited
    );
    let body = agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
    };
    let removed =
        agent_runtime_remove_apply::apply(&state, "remove-hibernated", body.clone()).await;
    assert!(
        removed.is_ok(),
        "an already stopped dormant Agent must be removable: {removed:?}"
    );
    // Reopen the store before replaying the completed removal.
    state.store = Arc::new(
        SqliteDomainStore::open(hmux.root.join("domain.sqlite"))
            .await
            .unwrap(),
    );
    assert_eq!(
        agent_runtime_remove_apply::apply(&state, "remove-hibernated", body)
            .await
            .unwrap(),
        removed.unwrap(),
    );
    let close = state
        .store
        .effective_agent_runtime_close(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(close.state, AgentRuntimeCloseStateV1::Stopped);
    assert!(
        state
            .store
            .agent_runtime_removal(&close.intent.operation_id)
            .await
            .unwrap()
            .unwrap()
            .completed_at_ms
            .is_some()
    );
    let late_wake = call(
        &state,
        "wake",
        "wake-after-removal",
        json!({
            "schemaVersion": 1, "agentId": agent_id,
            "operationId": asleep["operationId"],
            "expectedJournalRevision": asleep["journalRevision"],
            "expectedProviderConversationRef": CONVERSATION,
        }),
    )
    .await;
    assert!(
        late_wake.is_err(),
        "a removed Agent cannot acquire a replacement: {late_wake:?}"
    );
    assert_eq!(
        hmux.requests().len(),
        1,
        "removal/replay/wake must not launch a successor"
    );
}
