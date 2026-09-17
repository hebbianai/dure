use super::*;

#[tokio::test]
async fn source_busy_close_recovery_durably_retains_and_reopens_source() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let (agent_id, provider_id, operation_id) = admit_structured_close(&state).await;
    let stop_count = Arc::new(AtomicUsize::new(0));
    let attach_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(BusyStructuredRuntime {
                stop_count: Arc::clone(&stop_count),
                attach_count: Arc::clone(&attach_count),
                stop_error: Some(
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::SourceBusy,
                ),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);

    let state = Arc::new(state);
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&state)));
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let close = state
                .store
                .agent_runtime_close(&operation_id)
                .await
                .unwrap()
                .unwrap();
            if close.state == AgentRuntimeCloseStateV1::SourceRetained
                && attach_count.load(Ordering::SeqCst) == 1
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("recovery must durably retain and restore the selected source");
    state.agent_runtime_recovery_wake.notify_one();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        stop_count.load(Ordering::SeqCst),
        1,
        "recovery must not retry a close attempt that retained its source"
    );
    assert_eq!(
        attach_count.load(Ordering::SeqCst),
        1,
        "recovery must reattach the retained structured source exactly once"
    );
    assert!(
        state
            .store
            .effective_agent_runtime_close(&agent_id)
            .await
            .unwrap()
            .is_none(),
        "a retained close is history, not an active close tombstone"
    );
    assert!(
        state
            .store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
    let observation = agent_runtime_transition_apply::inspect(
        &state,
        agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 {
            schema_version: 1,
            agent_id,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(observation).unwrap()["state"],
        "stable",
        "the original source must become the authoritative stable runtime again"
    );
    recovery.abort();
    let _ = recovery.await;
}

#[tokio::test]
async fn repair_required_close_is_zero_effect_and_projects_closed() {
    let (_root, mut state, launcher, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let (agent_id, provider_id, parked) = park_structured_credential_transition(&state).await;
    let binding_before = state
        .store
        .agent_interaction_for_agent(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let stop_count = Arc::new(AtomicUsize::new(0));
    let attach_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(BusyStructuredRuntime {
                stop_count: Arc::clone(&stop_count),
                attach_count: Arc::clone(&attach_count),
                stop_error: Some(
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::SourceBusy,
                ),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);

    let receipt = agent_runtime_close_apply::apply(
        &state,
        "close-repair-required",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
        },
    )
    .await
    .unwrap();

    assert_eq!(receipt, json!({ "schemaVersion": 1, "stopped": true }));
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert_eq!(attach_count.load(Ordering::SeqCst), 0);
    assert!(launcher.requests().is_empty());
    assert_eq!(
        state
            .store
            .agent_interaction_for_agent(&agent_id)
            .await
            .unwrap(),
        Some(binding_before),
        "closing a quiescent failed transition must not rotate its dormant binding"
    );
    let close = state
        .store
        .effective_agent_runtime_close(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(close.state, AgentRuntimeCloseStateV1::Stopped);
    assert_eq!(
        close.intent.stopped_transition,
        Some(AgentRuntimeCloseStoppedTransitionV1 {
            operation_id: parked.intent.operation_id,
            journal_revision: parked.journal_revision,
        })
    );
    let observation = agent_runtime_transition_apply::inspect(
        &state,
        agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 {
            schema_version: 1,
            agent_id,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(observation).unwrap()["state"],
        "closed"
    );
}

#[tokio::test]
async fn repair_required_close_stops_the_exact_failed_structured_target_before_projecting_closed() {
    let (_root, mut state, launcher, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let (agent_id, provider_id, operation_id) =
        admit_structured_credential_transition(&state).await;
    let admitted = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    let stopped = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 30,
        })
        .await
        .unwrap();
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: source } =
        &stopped.intent.source_authority
    else {
        unreachable!()
    };
    let mut failed = source.clone();
    failed.execution_profile = stopped.intent.target_execution_profile.clone();
    failed.runtime = AgentProviderRuntimeFenceV1 {
        runtime_generation: "runtime-failed-close-target".into(),
        provider_epoch: "provider-failed-close-target".into(),
    };
    failed.binding_revision += 1;
    failed.updated_at_ms = 35;
    let parked = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id,
            expected_journal_revision: stopped.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: AgentRuntimeTargetFailureV1::new(
                    AgentRuntimeTargetFailureKindV1::LaunchFailed,
                    "fixture_failed_target_quiescent",
                )
                .unwrap(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::Replace {
                    authority: Some(Box::new(AgentRuntimeReplacementAuthorityV1(
                        AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                            binding: failed.clone(),
                        },
                    ))),
                },
            },
            advanced_at_ms: 40,
        })
        .await
        .unwrap();
    let stop_count = Arc::new(AtomicUsize::new(0));
    let attach_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(BusyStructuredRuntime {
                stop_count: Arc::clone(&stop_count),
                attach_count,
                stop_error: None,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);

    let receipt = agent_runtime_close_apply::apply(
        &state,
        "close-repair-required-failed-target",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
        },
    )
    .await
    .unwrap();

    assert_eq!(receipt, json!({ "schemaVersion": 1, "stopped": true }));
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert!(launcher.requests().is_empty());
    assert_eq!(
        state
            .store
            .effective_agent_runtime_close(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeCloseStateV1::Stopped,
    );
    assert_eq!(parked.state, AgentRuntimeTransitionStateV1::RepairRequired);
}

#[tokio::test]
async fn admitted_repair_required_close_recovers_after_db_and_service_restart() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let (agent_id, _, parked) = park_structured_credential_transition(&state).await;
    let binding_before = state
        .store
        .agent_interaction_for_agent(&agent_id)
        .await
        .unwrap();
    let close_operation = OperationIdV1::new("close-repair-required-restart").unwrap();
    state
        .store
        .admit_agent_runtime_close(&AgentRuntimeCloseIntentV1 {
            schema_version: 1,
            operation_id: close_operation.clone(),
            idempotency_key: "close-repair-required-restart".into(),
            source: parked.intent.source.clone(),
            source_authority: parked.intent.source_authority.clone(),
            stopped_transition: Some(AgentRuntimeCloseStoppedTransitionV1 {
                operation_id: parked.intent.operation_id,
                journal_revision: parked.journal_revision,
            }),
            requested_at_ms: 50,
        })
        .await
        .unwrap();
    let (restarted, launcher) =
        reopen_fixture_service_state(&state, &root.path().join("domain.sqlite")).await;
    drop(state);
    let restarted = Arc::new(restarted);
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&restarted)));
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let close = restarted
                .store
                .agent_runtime_close(&close_operation)
                .await
                .unwrap()
                .unwrap();
            if close.state == AgentRuntimeCloseStateV1::Stopped {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fresh recovery service must commit the admitted close");

    assert!(launcher.requests().is_empty());
    assert_eq!(
        restarted
            .store
            .agent_interaction_for_agent(&agent_id)
            .await
            .unwrap(),
        binding_before,
    );
    let observation = agent_runtime_transition_apply::inspect(
        &restarted,
        agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 {
            schema_version: 1,
            agent_id,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(observation).unwrap()["state"],
        "closed"
    );
    recovery.abort();
    let _ = recovery.await;
}

#[tokio::test]
async fn later_stop_request_resumes_the_authoritative_admitted_close() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    let (agent_id, provider_id, operation_id) = admit_structured_close(&state).await;
    let stop_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(BusyStructuredRuntime {
                stop_count: Arc::clone(&stop_count),
                attach_count: Arc::new(AtomicUsize::new(0)),
                stop_error: None,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);

    let receipt = agent_runtime_close_apply::apply(
        &state,
        "different-transport-request",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
        },
    )
    .await
    .unwrap();

    assert_eq!(receipt, json!({ "schemaVersion": 1, "stopped": true }));
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        state
            .store
            .agent_runtime_close(&operation_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeCloseStateV1::Stopped,
        "the admitted close remains the one durable authority across retries"
    );
    assert_eq!(
        state
            .store
            .effective_agent_runtime_close(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .intent
            .operation_id,
        operation_id,
        "a retry must drive the existing close instead of admitting another one"
    );
}
