use super::*;
use hmux_client::{
    ManagedCreateAdvanceResolution, ManagedCreateRequest, ManagedSessionCreator,
    ProviderConversationIdentitySeed,
};

#[tokio::test]
#[ignore = "requires isolated real Hmux; verifies ordinary native Resume after idle hibernation"]
async fn runtime_deferred_native_resume_publishes_without_a_second_wake() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let provider = root.path().join("codex-fixture");
    fs::write(&provider, "#!/bin/sh\nexec sleep 300\n").unwrap();
    let hmux = RealHmux::install(root, &mut state);
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new("native-idle-resume-agent").unwrap();
    let source = launch(&state, &hmux, "native-idle-resume-source").await;
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
        "idle-before-native-resume",
        observe_idle_body(&state, &hmux, &agent_id, &source, true).await,
    )
    .await
    .unwrap();
    assert_eq!(asleep["deferredTarget"]["state"], "waiting");

    // Ordinary pane Resume first uses the Hmux target-first create advance.
    // It must not need a backend preflight, nor create a second writer later.
    let request = ManagedCreateRequest::new(
        &hmux.requests()[0].launch_idempotency_key,
        &source.session_id,
        &source.workspace_id,
        source.provider_id.as_str(),
        HmuxPermissionMode::Default,
        &hmux.root,
        vec![
            provider.to_str().unwrap().into(),
            "resume".into(),
            CONVERSATION.into(),
        ],
        24,
        80,
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("codex", CONVERSATION).unwrap(),
    )
    .unwrap();
    let resumed = ManagedSessionCreator::new(&state.hmux_identity.runtime_executable_path)
        .with_discovery_root(&hmux.discovery)
        .replace_current_and_advance(request)
        .unwrap();
    let (ManagedCreateAdvanceResolution::Advanced(created)
    | ManagedCreateAdvanceResolution::Current(created)) = resumed
    else {
        panic!("the ordinary native Resume must produce an exact Ready target");
    };
    let target = created.session().descriptor().clone();
    assert_eq!(target.lifecycle, hmux_client::SessionLifecycle::Ready);
    assert_ne!(target.session_id, source.session_id);
    let body = json!({
        "schemaVersion": 1, "agentId": agent_id,
        "operationId": created.receipt().idempotency_key(), "providerId": "codex",
        "targetCredential": { "kind": "provider_default" },
        "providerConversationRef": CONVERSATION, "permissionMode": "default",
        "launchIdempotencyKey": created.receipt().idempotency_key(),
        "target": {
            "sessionId": target.session_id, "workspaceId": target.workspace_id,
            "runnerPrincipal": target.runner_principal, "runnerInstance": target.runner_instance,
            "channelEpoch": target.channel_epoch, "hostInstanceId": target.host_instance_id,
            "terminalEpoch": target.terminal_epoch,
        },
    });
    let publish = async || {
        agent_runtime_native_rehost::apply_resume(
            &state,
            serde_json::from_value(body.clone()).unwrap(),
        )
        .await
    };
    let published = publish().await;
    assert!(
        published.is_ok(),
        "a Ready native Resume must replace the dormant projection: {published:?}"
    );
    let published = published.unwrap();
    assert_eq!(publish().await.unwrap(), published);
    let observed = inspect(&state, &agent_id).await;
    assert_eq!(observed["state"], "stable");
    assert_eq!(observed["receipt"]["providerConversationRef"], CONVERSATION);
    // A stale CLI wake may be refused, but cannot start another provider after
    // the user's explicit native Resume has already committed.
    let _ = call(
        &state,
        "wake",
        "late-old-idle-wake",
        json!({
            "schemaVersion": 1, "agentId": agent_id, "operationId": asleep["operationId"],
            "expectedJournalRevision": asleep["journalRevision"],
            "expectedProviderConversationRef": CONVERSATION,
        }),
    )
    .await;
    assert_eq!(
        hmux.requests().len(),
        1,
        "publication/wake must not launch a second provider"
    );
    assert_eq!(inspect(&state, &agent_id).await, observed);
    let current = hmux_client::LocalSessionCatalog::new(&hmux.discovery)
        .find(&hmux_client::SessionSelector::new(
            &target.session_id,
            Some(target.workspace_id.clone()),
        ))
        .unwrap();
    assert_eq!(current.lifecycle, hmux_client::SessionLifecycle::Ready);
    assert!(current.same_generation(&target));
}
