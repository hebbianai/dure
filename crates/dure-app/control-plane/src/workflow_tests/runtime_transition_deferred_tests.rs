use super::*;

#[tokio::test]
async fn deferred_api_reuses_stop_recovery_and_observation_only_replay() {
    use agent_runtime_transition_apply::deferred::{HibernateBodyV1, WakeBodyV1, hibernate, wake};
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let agent_id = AgentIdV1::new("deferred-structured-agent").unwrap();
    let provider_id = ProviderIdV1::new("codex").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            provider_id: provider_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            display_name: "Deferred fixture".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    let (source, _) =
        initialize_structured_source_for_provider(&state, agent_id, provider_id).await;
    state.agent_providers =
        Arc::new(provider_extension::test_codex_structured_agent_provider_registry());
    let stop_count = Arc::new(AtomicUsize::new(0));
    let open_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes.register(source.provider_id.clone(), Arc::new(RepairableReplacementRuntime {
        store: Arc::clone(&state.store),
        stop_count: Arc::clone(&stop_count),
        open_count: Arc::clone(&open_count),
        first_failure_kind: structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
        second_failure_kind: None,
        succeed_on_retry: true,
    })).unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    make_fixture_mutation_authority(&mut state);
    let body = HibernateBodyV1 {
        schema_version: 1,
        agent_id: source.agent_id.clone(),
        expected_source_revision: 1,
        expected_idle: None,
    };
    let mut stale = body.clone();
    stale.expected_source_revision = 2;
    assert_eq!(
        hibernate(&state, "stale-hibernate", stale)
            .await
            .unwrap_err()
            .code,
        "agent_runtime_transition_conflict"
    );
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    {
        // Admission was queued while this backend was current. A replacement
        // published before the Agent lock became available must prevent stop.
        let guard = state.agent_operations.acquire(&source.agent_id).await;
        let mut pending = std::pin::pin!(hibernate(&state, "queued-old-backend", body.clone()));
        assert!(futures_util::FutureExt::now_or_never(pending.as_mut()).is_none());
        let mut replacement = state.descriptor.clone();
        replacement.generation = random_generation().unwrap();
        write_descriptor(&state.canonical_descriptor_path, &replacement).unwrap();
        assert!(!state.is_mutation_authority());
        drop(guard);
        let refused = pending.await;
        assert_eq!(
            stop_count.load(Ordering::SeqCst),
            0,
            "a superseded backend must not stop the queued source"
        );
        assert_eq!(refused.unwrap_err().code, "recovering");
    }
    write_descriptor(&state.canonical_descriptor_path, &state.descriptor).unwrap();
    let asleep = hibernate(&state, "sleep-once", body.clone()).await.unwrap();
    let observed = serde_json::to_value(&asleep).unwrap();
    assert_eq!(observed["stage"], "source_stopped");
    assert_eq!(observed["deferredTarget"]["state"], "waiting");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(open_count.load(Ordering::SeqCst), 0);
    state.store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite"))
            .await
            .unwrap(),
    );
    assert_eq!(
        hibernate(&state, "sleep-once", body.clone()).await.unwrap(),
        asleep
    );
    let wake_body = WakeBodyV1 {
        schema_version: 1,
        agent_id: source.agent_id.clone(),
        operation_id: OperationIdV1::new(observed["operationId"].as_str().unwrap()).unwrap(),
        expected_journal_revision: observed["journalRevision"].as_i64().unwrap(),
        expected_provider_conversation_ref: Some("conversation-retained".into()),
    };
    {
        let guard = state.agent_operations.acquire(&source.agent_id).await;
        let mut pending = std::pin::pin!(wake(&state, "queued-old-backend", wake_body.clone()));
        assert!(futures_util::FutureExt::now_or_never(pending.as_mut()).is_none());
        let mut replacement = state.descriptor.clone();
        replacement.generation = random_generation().unwrap();
        write_descriptor(&state.canonical_descriptor_path, &replacement).unwrap();
        assert!(!state.is_mutation_authority());
        drop(guard);
        let refused = pending.await;
        assert_eq!(
            open_count.load(Ordering::SeqCst),
            0,
            "a superseded backend must not wake the queued source"
        );
        assert_eq!(refused.unwrap_err().code, "recovering");
    }
    write_descriptor(&state.canonical_descriptor_path, &state.descriptor).unwrap();
    let mut wrong_conversation = wake_body.clone();
    wrong_conversation.expected_provider_conversation_ref = Some("historical-conversation".into());
    assert_eq!(
        wake(&state, "historical-pane", wrong_conversation)
            .await
            .unwrap_err()
            .code,
        "agent_runtime_transition_conflict"
    );
    assert_eq!(open_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        serde_json::to_value(hibernate(&state, "sleep-once", body.clone()).await.unwrap()).unwrap(),
        observed
    );
    // An actual adapter failure leaves the authorized target in the existing
    // journal. Replaying the request cannot become a second launch attempt.
    assert_eq!(
        wake(&state, "wake-once", wake_body.clone())
            .await
            .unwrap_err()
            .code,
        "fixture_target_start_failed"
    );
    wake(&state, "wake-once", wake_body.clone()).await.unwrap();
    assert_eq!(open_count.load(Ordering::SeqCst), 1);
    let pending = state
        .store
        .agent_runtime_transition(&wake_body.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        agent_runtime_transition_apply::drive_locked(&state, pending)
            .await
            .unwrap(),
        agent_runtime_transition_apply::TransitionDriveOutcome::Committed(_)
    ));
    let awake = wake(&state, "wake-once", wake_body).await.unwrap();
    let observed = serde_json::to_value(&awake).unwrap();
    assert_eq!(observed["state"], "stable");
    assert_eq!(
        observed["receipt"]["providerConversationRef"],
        "conversation-retained"
    );
    assert_eq!(observed["receipt"]["selectionRevision"], 2);
    assert_eq!(hibernate(&state, "sleep-once", body).await.unwrap(), awake);
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(open_count.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn deferred_driver_does_not_launch_on_repeated_drive_or_reopened_store() {
    let (root, mut state, launcher, _) = fixture(Vec::new()).await;
    let (source, binding) = initialize_structured_source(&state).await;
    let plan = AgentRuntimeTransitionIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new("deferred-runtime").unwrap(),
        idempotency_key: "deferred-runtime-key".into(),
        source: source.clone(),
        source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
            "conversation-retained",
        )
        .unwrap(),
        target_interaction_profile: source.interaction_profile,
        target_execution_profile: source.execution_profile.clone(),
        target_launch_selection: None,
        requested_at_ms: 20,
    };
    state
        .store
        .admit_deferred_agent_runtime_transition(&plan)
        .await
        .unwrap();
    // This fixture proves journal/drive behavior, not an actual process stop.
    let stopped = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: plan.operation_id.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 30,
        })
        .await
        .unwrap();
    for _ in 0..2 {
        state.store = Arc::new(
            SqliteDomainStore::open(root.path().join("domain.sqlite"))
                .await
                .unwrap(),
        );
        let retained = state
            .store
            .agent_runtime_transition(&plan.operation_id)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            agent_runtime_transition_apply::drive_locked(&state, retained)
                .await
                .unwrap(),
            agent_runtime_transition_apply::TransitionDriveOutcome::Deferred
        ));
        assert_eq!(
            state
                .store
                .agent_runtime_transition(&plan.operation_id)
                .await
                .unwrap(),
            Some(stopped.clone())
        );
        assert_eq!(
            state
                .store
                .agent_runtime_selection(&source.agent_id)
                .await
                .unwrap(),
            Some(source.clone())
        );
        assert!(launcher.requests().is_empty());
    }
}
