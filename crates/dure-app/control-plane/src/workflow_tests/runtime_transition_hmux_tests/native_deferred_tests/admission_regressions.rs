use super::*;
use agent_runtime_transition_apply::deferred::{HibernateBodyV1, idle::native_idle_attempt};
use sha2::{Digest, Sha256};
use std::time::Duration;

fn attempt(body: &Value) -> String {
    native_idle_attempt(
        &serde_json::from_value::<HibernateBodyV1>(body.clone()).unwrap(),
        Some(2),
        Duration::from_secs(86400),
        Duration::from_secs(90000),
    )
    .unwrap()
    .unwrap()
}

#[tokio::test]
#[ignore = "requires isolated real Hmux; retained idle journal and fresh output fence"]
async fn runtime_idle_refusal_fresh_fence_uses_real_hmux() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let emit = root.path().join("emit-idle-output");
    fs::write(
        root.path().join("codex-fixture"),
        format!(
            "#!/bin/sh\nwhile [ ! -f '{}' ]; do sleep 0.02; done\nprintf 'idle status\\n'\nexec sleep 300\n",
            emit.display()
        ),
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new("retained-idle-agent").unwrap();
    let source = launch(&state, &hmux, "retained-idle-source").await;
    bind_source(&state, &agent_id, &source).await;
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    fs::write(emit, b"emit").unwrap();
    // Semantic readiness can precede the first PTY output read. Observe that
    // output before seeding a prior high-water; zero is not a changed fence.
    let fresh = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let body = observe_idle_body(&state, &hmux, &agent_id, &source, true).await;
            if body["expectedIdle"]["observedThroughOutputSeq"]
                .as_u64()
                .unwrap()
                > 0
            {
                break body;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("fixture must produce actual PTY output before the fresh-fence reproduction");
    let mut prior = fresh.clone();
    prior["expectedIdle"]["observedThroughOutputSeq"] = json!(0);
    let prior_attempt = attempt(&prior);
    // Seed the exact historical SourceRetained state observed in the incident.
    // This does not claim a native stop occurred before the seeded refusal.
    let mut hash = Sha256::new();
    hash.update(b"dure-agent-runtime-hibernate-attempt/v1\0");
    hash.update((prior_attempt.len() as u64).to_be_bytes());
    hash.update(prior_attempt.as_bytes());
    let digest = format!("{:x}", hash.finalize());
    let operation_id = OperationIdV1::new(format!("runtime-transition-{digest}")).unwrap();
    let crate::agent_runtime_projection::AgentRuntimeObservedV1::Stable {
        selection,
        authority,
    } = crate::agent_runtime_projection::read_locked(&state, &agent_id)
        .await
        .unwrap()
    else {
        panic!("stable source required")
    };
    let intent = AgentRuntimeTransitionIntentV1 {
        schema_version: 1,
        operation_id: operation_id.clone(),
        idempotency_key: format!("runtime-attempt-{digest}"),
        source: *selection.clone(),
        source_authority: *authority,
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::PreserveObserved {
            runtime_revision: prior["expectedIdle"]["runtimeRevision"].as_u64().unwrap(),
            observed_through_output_seq: 0,
        },
        provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(CONVERSATION)
            .unwrap(),
        target_interaction_profile: selection.interaction_profile,
        target_execution_profile: selection.execution_profile.clone(),
        target_launch_selection: None,
        requested_at_ms: selection.updated_at_ms + 1,
    };
    state
        .store
        .admit_deferred_agent_runtime_transition(&intent)
        .await
        .unwrap();
    state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeTransitionAdvanceV1::SourceRetained,
            advanced_at_ms: intent.requested_at_ms + 1,
        })
        .await
        .unwrap();
    state.store = Arc::new(
        SqliteDomainStore::open(hmux.root.join("domain.sqlite"))
            .await
            .unwrap(),
    );
    let original = hmux.session(&source);
    call(&state, "hibernate", &prior_attempt, prior.clone())
        .await
        .unwrap();
    assert_eq!(hmux.requests().len(), 1);
    let conflict = call(&state, "hibernate", &prior_attempt, fresh.clone())
        .await
        .unwrap_err();
    assert_eq!(
        conflict.code,
        "agent_runtime_transition_idempotency_conflict"
    );
    assert!(hmux.session(&source).same_generation(&original));
    let asleep = call(&state, "hibernate", &attempt(&fresh), fresh.clone()).await;
    assert!(
        asleep.is_ok(),
        "a fresh exact fence after a confirmed refusal must not collide: {asleep:?}"
    );
    let asleep = asleep.unwrap();
    assert_eq!(asleep["stage"], "source_stopped");
    RealHmux::assert_exited(&original).await;
    let retained = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        retained.state,
        AgentRuntimeTransitionStateV1::SourceRetained
    );
    assert_eq!(
        retained.intent.source_stop_policy,
        intent.source_stop_policy
    );
    assert_eq!(hmux.requests().len(), 1);
    let awake = call(&state, "wake", "wake-fresh-fence", json!({
        "schemaVersion": 1, "agentId": agent_id, "operationId": asleep["operationId"],
        "expectedJournalRevision": asleep["journalRevision"], "expectedProviderConversationRef": CONVERSATION,
    })).await.unwrap();
    assert_eq!(awake["receipt"]["providerConversationRef"], CONVERSATION);
    assert_eq!(
        call(&state, "hibernate", &attempt(&fresh), fresh)
            .await
            .unwrap(),
        awake
    );
    assert_eq!(
        call(&state, "hibernate", &prior_attempt, prior)
            .await
            .unwrap(),
        awake
    );
    assert_eq!(
        hmux.requests().len(),
        2,
        "replay must never stop/relaunch the successor"
    );
}

#[tokio::test]
#[ignore = "requires isolated real Hmux and disposable credential registration"]
async fn runtime_idle_legacy_credential_target_uses_real_hmux() {
    legacy_credential_target(CredentialState::Current).await;
}

#[tokio::test]
#[ignore = "requires isolated real Hmux and disposable credential registration"]
async fn runtime_idle_shared_credential_target_uses_real_hmux() {
    legacy_credential_target(CredentialState::Shared).await;
}

#[tokio::test]
#[ignore = "requires isolated real Hmux and disposable credential fault injection"]
async fn runtime_idle_unverified_legacy_credential_retains_real_hmux() {
    for credential in [CredentialState::Missing, CredentialState::Replaced] {
        legacy_credential_target(credential).await;
    }
}

enum CredentialState {
    Current,
    Shared,
    Missing,
    Replaced,
}

async fn legacy_credential_target(credential: CredentialState) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 300\n",
    )
    .unwrap();
    let accounts = root.path().join("accounts");
    fs::create_dir(&accounts).unwrap();
    fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
    let profile = accounts.join("codex-idle-account");
    fs::create_dir(&profile).unwrap();
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o700)).unwrap();
    if matches!(credential, CredentialState::Shared) {
        state
            .credential_profiles
            .register(
                provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                    schema_version: 1,
                    provider_id: "codex".into(),
                    reference_id: "another-client-account".into(),
                    profile_directory_name: "codex-idle-account".into(),
                },
            )
            .await
            .unwrap();
    }
    let registration = if matches!(credential, CredentialState::Missing) {
        None
    } else {
        Some(
            state
                .credential_profiles
                .register(
                    provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                        schema_version: 1,
                        provider_id: "codex".into(),
                        reference_id: "idle-account".into(),
                        profile_directory_name: "codex-idle-account".into(),
                    },
                )
                .await
                .unwrap(),
        )
    };
    let hmux = RealHmux::install(root, &mut state);
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new("legacy-credential-idle-agent").unwrap();
    let source = launch(&state, &hmux, "legacy-credential-idle-source").await;
    bind_source_profile(
        &state,
        &agent_id,
        &source,
        Some(CONVERSATION),
        AgentExecutionProfileV1::CredentialReference {
            reference_id: "idle-account".into(),
            credential_generation: None,
        },
    )
    .await;
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
    );
    let body = observe_idle_body(&state, &hmux, &agent_id, &source, true).await;
    let original = hmux.session(&source);
    if matches!(credential, CredentialState::Replaced) {
        // Replace only this disposable directory. A matching logical reference
        // must not bypass the registered filesystem generation check.
        fs::rename(&profile, accounts.join("retired-profile")).unwrap();
        fs::create_dir(&profile).unwrap();
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let result = call(&state, "hibernate", "legacy-account-idle", body.clone()).await;
    if !matches!(
        credential,
        CredentialState::Current | CredentialState::Shared
    ) {
        let expected = match credential {
            CredentialState::Missing => "provider_credential_profile_unavailable",
            CredentialState::Replaced => "provider_credential_profile_stale_generation",
            CredentialState::Current | CredentialState::Shared => unreachable!(),
        };
        assert_eq!(result.unwrap_err().code, expected);
        let retained = hmux.session(&source);
        assert!(retained.same_generation(&original));
        assert_eq!(retained.lifecycle, hmux_client::SessionLifecycle::Ready);
        assert_eq!(
            inspect(&state, &agent_id).await["receipt"]["selectionRevision"],
            1
        );
        assert_eq!(
            hmux.requests().len(),
            1,
            "unverified credentials must not stop or replace the source"
        );
        return;
    }
    assert!(
        result.is_ok(),
        "pin a verified target before stopping an unpinned legacy source: {result:?}"
    );
    let asleep = result.unwrap();
    assert_eq!(asleep["stage"], "source_stopped");
    RealHmux::assert_exited(&original).await;
    let transition = state
        .store
        .agent_runtime_transition(
            &OperationIdV1::new(asleep["operationId"].as_str().unwrap()).unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        transition.intent.source.execution_profile,
        AgentExecutionProfileV1::CredentialReference {
            reference_id: "idle-account".into(),
            credential_generation: None,
        },
        "target pinning must not invent the legacy source generation"
    );
    assert_eq!(
        transition.intent.target_execution_profile,
        AgentExecutionProfileV1::CredentialReference {
            reference_id: "idle-account".into(),
            credential_generation: Some(registration.unwrap().credential_generation),
        }
    );
    let awake = call(&state, "wake", "wake-legacy-account", json!({
        "schemaVersion": 1, "agentId": agent_id, "operationId": asleep["operationId"],
        "expectedJournalRevision": asleep["journalRevision"], "expectedProviderConversationRef": CONVERSATION,
    })).await.unwrap();
    assert_eq!(awake["receipt"]["providerConversationRef"], CONVERSATION);
    assert_eq!(
        call(&state, "hibernate", "legacy-account-idle", body)
            .await
            .unwrap(),
        awake
    );
    assert_eq!(hmux.requests().len(), 2);
}
