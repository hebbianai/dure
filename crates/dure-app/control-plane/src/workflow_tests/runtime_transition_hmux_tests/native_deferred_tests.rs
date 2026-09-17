use super::*;
use hmux_client::{AgentRuntimeActivity, AgentRuntimeAttention};

mod admission_regressions;
mod removal;
mod resume_interop;

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run the deferred runtime control-plane smoke"]
async fn runtime_deferred_uses_real_hmux() {
    deferred_uses_real_hmux(false).await;
}

#[tokio::test]
#[ignore = "requires isolated current Hmux binaries with semantic quiescent stop"]
async fn runtime_observed_idle_uses_real_hmux() {
    deferred_uses_real_hmux(true).await;
}

#[tokio::test]
#[ignore = "requires isolated current Hmux binaries and the real backend idle coordinator"]
async fn runtime_idle_coordinator_hibernates_without_a_cleanup_request() {
    automatic_idle_coordinator(false, true).await;
}

#[tokio::test]
#[ignore = "requires isolated current Hmux binaries and the real backend idle coordinator"]
async fn runtime_idle_coordinator_hibernates_across_passive_output() {
    automatic_idle_coordinator(true, true).await;
}

#[tokio::test]
#[ignore = "requires isolated legacy Hmux with semantic stop but no Host idle clock"]
async fn runtime_idle_coordinator_resets_legacy_policy_credit() {
    automatic_idle_coordinator(false, false).await;
}

async fn automatic_idle_coordinator(passive_output: bool, host_clock: bool) {
    use agent_runtime_transition_apply::deferred::idle::{IdleRuntime, run};
    use std::time::Duration;
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        if passive_output {
            "#!/bin/sh\nwhile :; do printf 'idle status\\n'; sleep 7; done\n"
        } else {
            "#!/bin/sh\nexec sleep 300\n"
        },
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new("automatic-idle-agent").unwrap();
    let source = launch(&state, &hmux, "automatic-idle-source").await;
    bind_source(&state, &agent_id, &source).await;
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    // Verify the actual Host guarantee before enabling the disposable policy.
    let original = observe_idle_body(&state, &hmux, &agent_id, &source, true).await;
    let source_descriptor = hmux.session(&source);
    assert_eq!(
        source_descriptor
            .capabilities
            .iter()
            .any(|capability| { capability == "semantic_idle_observation_v1" }),
        host_clock,
        "each clock contract requires its deliberately selected real Host"
    );
    // A Host clock starts with provider activity, before policy installation.
    // Leave room for the first two scans without depending on sub-second setup.
    let after_ms = if host_clock { 60_000 } else { 1000 };
    state.runtime_idle = IdleRuntime::default();
    let configured = state
        .runtime_idle
        .configure(
            &state,
            serde_json::from_value(json!({
                "schemaVersion": 1, "expectedRevision": 0,
                "policy": {"mode": "enabled", "afterMs": after_ms},
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(configured).unwrap()["policyRevision"],
        1
    );
    let state = Arc::new(state);
    let mut workers = tokio::task::JoinSet::new();
    workers.spawn(run(Arc::clone(&state)));
    let first_scan = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let status = serde_json::to_value(state.runtime_idle.inspect().await).unwrap();
            if status["agents"][0]["state"] == "observing" {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    // A policy revision invalidates backend observation windows, not the
    // Host-owned semantic activity epoch. No manual cleanup participates.
    for (revision, policy) in [
        (1, json!({"mode": "disabled"})),
        (2, json!({"mode": "enabled", "afterMs": after_ms})),
    ] {
        state
            .runtime_idle
            .configure(
                &state,
                serde_json::from_value(json!({
                    "schemaVersion": 1, "expectedRevision": revision, "policy": policy,
                }))
                .unwrap(),
            )
            .await
            .unwrap();
    }
    let new_scan = tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let status = serde_json::to_value(state.runtime_idle.inspect().await).unwrap();
            if status["policyRevision"] == 3
                && !status["observedAtMs"].is_null()
                && status["observedAtMs"] != first_scan["observedAtMs"]
            {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(new_scan["agents"][0]["state"], "observing");
    if host_clock {
        assert_eq!(new_scan["agents"][0]["clockSource"], "host");
        assert!(
            new_scan["agents"][0]["observedIdleMs"].as_u64().unwrap()
                > first_scan["agents"][0]["observedIdleMs"].as_u64().unwrap(),
            "policy re-enable must retain the unchanged Host semantic idle clock: {first_scan} -> {new_scan}"
        );
    } else {
        assert_eq!(new_scan["agents"][0]["clockSource"], "backend_observed");
        assert_eq!(new_scan["agents"][0]["observedIdleMs"], 0);
        assert_eq!(new_scan["agents"][0]["restoredFromCheckpoint"], false);
    }
    assert_eq!(hmux.requests().len(), 1);
    if passive_output {
        let current = observe_idle_body(&state, &hmux, &agent_id, &source, true).await;
        assert_eq!(
            current["expectedIdle"]["runtimeRevision"], original["expectedIdle"]["runtimeRevision"],
            "the fixture must keep the same provider-authored semantic idle epoch"
        );
        assert!(
            current["expectedIdle"]["observedThroughOutputSeq"]
                .as_u64()
                .unwrap()
                > original["expectedIdle"]["observedThroughOutputSeq"]
                    .as_u64()
                    .unwrap(),
            "passive output must advance the real Host high-water between scans"
        );
    }
    let asleep = tokio::time::timeout(Duration::from_millis(after_ms + 30_000), async {
        loop {
            let observed = inspect(&state, &agent_id).await;
            if observed["deferredTarget"]["state"] == "waiting" {
                break observed;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    workers.abort_all();
    while workers.join_next().await.is_some() {}
    let status = serde_json::to_value(state.runtime_idle.inspect().await).unwrap();
    let asleep = asleep.unwrap_or_else(|error| {
        panic!("the real coordinator must admit hibernation after observed idle: {error}; status={status}")
    });
    assert_eq!(asleep["stage"], "source_stopped");
    let outcomes =
        serde_json::to_value(state.runtime_idle.inspect_with_outcomes(&state).await).unwrap();
    let stopped = &outcomes["reclamation"]["entries"][0];
    assert_eq!(stopped["operationId"], asleep["operationId"]);
    assert_eq!(stopped["stopState"], "completed");
    assert_eq!(stopped["wakeState"], "not_requested");
    assert_eq!(stopped["sourceSessionId"], source.session_id);
    assert_eq!(
        hmux.session(&source).lifecycle,
        hmux_client::SessionLifecycle::Exited
    );
    RealHmux::assert_exited(&source_descriptor).await;
    assert_eq!(
        hmux.requests().len(),
        1,
        "background admission must not immediately wake the source"
    );
    let wake = json!({
        "schemaVersion": 1, "agentId": agent_id, "operationId": asleep["operationId"],
        "expectedJournalRevision": asleep["journalRevision"],
        "expectedProviderConversationRef": CONVERSATION,
    });
    let awake = call(&state, "wake", "wake-automatic-once", wake.clone())
        .await
        .unwrap();
    assert_eq!(awake["receipt"]["providerConversationRef"], CONVERSATION);
    let outcomes =
        serde_json::to_value(state.runtime_idle.inspect_with_outcomes(&state).await).unwrap();
    assert_eq!(
        outcomes["reclamation"]["entries"][0]["operationId"],
        asleep["operationId"]
    );
    assert_eq!(
        outcomes["reclamation"]["entries"][0]["stopState"],
        "completed"
    );
    assert_eq!(
        outcomes["reclamation"]["entries"][0]["wakeState"],
        "completed"
    );
    assert_eq!(hmux.requests().len(), 2);
    assert_eq!(
        call(&state, "wake", "wake-automatic-once", wake)
            .await
            .unwrap(),
        awake
    );
    assert_eq!(hmux.requests().len(), 2);
}

async fn deferred_uses_real_hmux(observed_idle: bool) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 300\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new("deferred-native-agent").unwrap();
    let source = launch(&state, &hmux, "deferred-native-source").await;
    bind_source(&state, &agent_id, &source).await;
    let original = hmux.session(&source);
    let mut body = json!({ "schemaVersion": 1, "agentId": agent_id, "expectedSourceRevision": 1 });

    for (attempt, activity, attention) in [
        (
            "working",
            AgentRuntimeActivity::Working,
            AgentRuntimeAttention::None,
        ),
        (
            "approval",
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::ApprovalRequired,
        ),
    ] {
        state_reporter::report(&hmux, &source, activity, attention, false);
        assert_eq!(
            call(&state, "hibernate", attempt, body.clone())
                .await
                .unwrap_err()
                .code,
            "agent_runtime_source_busy"
        );
        assert!(hmux.session(&source).same_generation(&original));
        assert_eq!(hmux.requests().len(), 1);
    }
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    let controller = hmux_client::LocalSessionCatalog::new(&hmux.discovery)
        .open(&hmux_client::SessionSelector::new(
            &source.session_id,
            Some(source.workspace_id.clone()),
        ))
        .unwrap();
    controller.send_input(b"pending draft".to_vec()).unwrap();
    let retained = call(&state, "hibernate", "draft", body.clone())
        .await
        .unwrap_err();
    assert_eq!(retained.code, "agent_runtime_source_retained");
    let outcomes =
        serde_json::to_value(state.runtime_idle.inspect_with_outcomes(&state).await).unwrap();
    assert_eq!(
        outcomes["reclamation"]["entries"][0]["stopState"],
        "refused"
    );
    assert_eq!(
        outcomes["reclamation"]["entries"][0]["wakeState"],
        "not_requested"
    );
    assert_eq!(
        inspect(&state, &agent_id).await["receipt"]["selectionRevision"],
        1
    );
    assert!(hmux.session(&source).same_generation(&original));
    assert_eq!(hmux.requests().len(), 1);
    controller.send_input(b"\r".to_vec()).unwrap();
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    drop(controller);

    if observed_idle {
        let observed = observe_idle_body(&state, &hmux, &agent_id, &source, true).await;
        state_reporter::report(
            &hmux,
            &source,
            AgentRuntimeActivity::Working,
            AgentRuntimeAttention::None,
            false,
        );
        state_reporter::report(
            &hmux,
            &source,
            AgentRuntimeActivity::Waiting,
            AgentRuntimeAttention::None,
            true,
        );
        assert_eq!(
            call(&state, "hibernate", "activity-invalidated-idle", observed)
                .await
                .unwrap_err()
                .code,
            "agent_runtime_source_busy",
            "returning to waiting must not reuse a superseded idle interval"
        );
        assert!(hmux.session(&source).same_generation(&original));
        assert_eq!(hmux.requests().len(), 1);
        body = observe_idle_body(&state, &hmux, &agent_id, &source, true).await;
    }

    let asleep = call(&state, "hibernate", "sleep-once", body.clone())
        .await
        .unwrap();
    assert_eq!(asleep["stage"], "source_stopped");
    assert_eq!(asleep["deferredTarget"]["state"], "waiting");
    let outcomes =
        serde_json::to_value(state.runtime_idle.inspect_with_outcomes(&state).await).unwrap();
    assert_eq!(
        outcomes["reclamation"]["entries"][0]["operationId"],
        asleep["operationId"]
    );
    assert_eq!(
        outcomes["reclamation"]["entries"][0]["stopState"],
        "completed"
    );
    assert_eq!(
        outcomes["reclamation"]["entries"][0]["wakeState"],
        "not_requested"
    );
    assert_eq!(
        hmux.session(&source).lifecycle,
        hmux_client::SessionLifecycle::Exited
    );
    assert_eq!(
        hmux.requests().len(),
        1,
        "stopping must not immediately launch a replacement"
    );
    state.store = Arc::new(
        SqliteDomainStore::open(hmux.root.join("domain.sqlite"))
            .await
            .unwrap(),
    );
    assert_eq!(
        call(&state, "hibernate", "sleep-once", body.clone())
            .await
            .unwrap(),
        asleep
    );
    assert_eq!(
        hmux.requests().len(),
        1,
        "a reopened journal must remain asleep"
    );
    let reopened =
        serde_json::to_value(state.runtime_idle.inspect_with_outcomes(&state).await).unwrap();
    assert_eq!(
        reopened["reclamation"]["entries"],
        outcomes["reclamation"]["entries"]
    );

    let wake = json!({ "schemaVersion": 1, "agentId": agent_id,
        "operationId": asleep["operationId"], "expectedJournalRevision": asleep["journalRevision"] });
    let mut wrong = wake.clone();
    wrong["expectedJournalRevision"] = json!(1);
    assert!(call(&state, "wake", "stale-wake", wrong).await.is_err());
    assert_eq!(hmux.requests().len(), 1);
    let awake = call(&state, "wake", "wake-once", wake.clone())
        .await
        .unwrap();
    assert_eq!(awake["state"], "stable");
    assert_eq!(awake["receipt"]["selectionRevision"], 2);
    let outcomes =
        serde_json::to_value(state.runtime_idle.inspect_with_outcomes(&state).await).unwrap();
    assert_eq!(
        outcomes["reclamation"]["entries"][0]["operationId"],
        asleep["operationId"]
    );
    assert_eq!(
        outcomes["reclamation"]["entries"][0]["stopState"],
        "completed"
    );
    assert_eq!(
        outcomes["reclamation"]["entries"][0]["wakeState"],
        "completed"
    );
    assert_eq!(awake["receipt"]["providerConversationRef"], CONVERSATION);
    assert_eq!(hmux.requests().len(), 2);
    assert_eq!(
        hmux.requests()[1].provider_conversation_ref.as_deref(),
        Some(CONVERSATION)
    );
    assert_eq!(
        call(&state, "wake", "wake-once", wake.clone())
            .await
            .unwrap(),
        awake
    );
    assert_eq!(
        call(&state, "hibernate", "sleep-once", body).await.unwrap(),
        awake
    );
    assert_eq!(hmux.requests().len(), 2);

    // Even after an explicit close, the old wake cannot reopen this Agent.
    call(
        &state,
        "stop",
        "close-fixture",
        json!({ "schemaVersion": 1, "agentId": agent_id }),
    )
    .await
    .unwrap();
    let closed = call(&state, "wake", "wake-once", wake).await.unwrap();
    assert_eq!(closed["state"], "closed");
    assert_eq!(hmux.requests().len(), 2);
}

#[tokio::test]
#[ignore = "requires isolated legacy Hmux binaries without the semantic quiescence capability"]
async fn runtime_observed_idle_rejects_legacy_hmux() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 300\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new("observed-idle-native-agent").unwrap();
    let source = launch(&state, &hmux, "observed-idle-native-source").await;
    bind_source(&state, &agent_id, &source).await;
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    let original = hmux.session(&source);
    let body = observe_idle_body(&state, &hmux, &agent_id, &source, false).await;
    let mut changed_source = body.clone();
    changed_source["expectedIdle"]["sourceAuthority"]["authority"]["terminalEpoch"] =
        json!("different-terminal");
    assert_eq!(
        call(&state, "hibernate", "old-source", changed_source)
            .await
            .unwrap_err()
            .code,
        "agent_runtime_transition_conflict"
    );
    assert_eq!(
        call(&state, "hibernate", "legacy-idle", body)
            .await
            .unwrap_err()
            .code,
        "agent_runtime_semantic_idle_unavailable"
    );
    assert!(hmux.session(&source).same_generation(&original));
    assert_eq!(
        hmux.session(&source).lifecycle,
        hmux_client::SessionLifecycle::Ready
    );
    assert_eq!(hmux.requests().len(), 1);
    assert!(
        state
            .store
            .active_agent_runtime_transition(&agent_id)
            .await
            .unwrap()
            .is_none(),
        "unknown idle authority must not admit a destructive transition"
    );
}

async fn observe_idle_body(
    state: &ServiceState,
    hmux: &RealHmux,
    agent_id: &AgentIdV1,
    source: &WorkflowSessionGenerationV1,
    semantic_capability: bool,
) -> Value {
    let inspected = hmux_client::inspect_local_session(
        &hmux_client::LocalSessionCatalog::new(&hmux.discovery),
        hmux.session(source),
    );
    assert_eq!(
        inspected.descriptor.capabilities.iter().any(|capability| {
            capability == hmux_session_protocol::MANAGED_PROVIDER_SEMANTIC_QUIESCENT_STOP_CAPABILITY
        }),
        semantic_capability,
        "the regression must use its deliberately selected Host capability"
    );
    let runtime = inspected.agent_runtime_state.unwrap();
    let authority = state
        .store
        .agent_checkpoint_binding_authority(agent_id)
        .await
        .unwrap()
        .unwrap();
    json!({
        "schemaVersion": 1, "agentId": agent_id, "expectedSourceRevision": 1,
        "expectedIdle": {
            "sourceAuthority": AgentRuntimeBindingAuthorityV1::NativeCli { authority },
            "runtimeRevision": runtime.revision.parse::<u64>().unwrap(),
            "observedThroughOutputSeq": inspected.descriptor.output_seq.parse::<u64>().unwrap(),
        },
    })
}

async fn call(
    state: &ServiceState,
    action: &str,
    attempt: &str,
    body: Value,
) -> Result<Value, BackendDispatchError> {
    let mut request = orchestration_backend_request(state, attempt, "", Value::Null);
    request.operation = format!("agent_runtime.{action}");
    // Reach dispatch even on the pre-feature build for behavioral RED. The
    // separately exercised identity contract owns capability advertisement.
    request.expected.required_capabilities.clear();
    request.body = body;
    dispatch(state, &request).await
}
