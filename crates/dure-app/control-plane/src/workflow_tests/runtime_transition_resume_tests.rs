use super::*;

#[tokio::test]
async fn transition_resumes_admitted_intent_and_replays_without_another_writer() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let (agent_id, provider_id, operation_id) =
        admit_structured_credential_transition(&state).await;
    let source_selection = state
        .store
        .agent_runtime_selection(&agent_id)
        .await
        .unwrap();
    let stop_count = Arc::new(AtomicUsize::new(0));
    let open_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes.register(provider_id, Arc::new(RepairableReplacementRuntime {
        store: Arc::clone(&state.store),
        stop_count: Arc::clone(&stop_count),
        open_count: Arc::clone(&open_count),
        first_failure_kind: structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
        second_failure_kind: None,
        succeed_on_retry: true,
    })).unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    // This is the same semantic request sent by the CLI: no journal ID or
    // client-selected repair action, and omitted settings retain the target.
    let body: agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 =
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "agentId": agent_id,
            "targetInteractionProfile": "structured_protocol"
        }))
        .unwrap();
    let observed = agent_runtime_transition_apply::inspect_repair_intent(
        &state,
        agent_runtime_transition_apply::AgentRuntimeRepairIntentInspectBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            operation_id: operation_id.clone(),
            expected_journal_revision: 1,
        },
    )
    .await
    .unwrap();
    let observed = serde_json::to_value(observed).unwrap();
    assert_eq!(observed["state"], "admitted");
    assert_eq!(observed["sourceSelectionRevision"], 1);
    assert_eq!(observed["sourceInteractionProfile"], "structured_protocol");
    assert!(observed.get("targetFailure").is_none());
    assert_eq!(
        agent_runtime_transition_apply::apply(&state, "resume-admitted", body.clone())
            .await
            .unwrap_err()
            .code,
        "fixture_target_start_failed"
    );
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(open_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap(),
        source_selection,
        "failed credential launch must not publish the target selection"
    );

    // Reopen the journal before replaying a lost response; memory is not
    // request authority, and replay cannot authorize another target effect.
    state.store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite"))
            .await
            .unwrap(),
    );
    assert_eq!(
        agent_runtime_transition_apply::apply(&state, "resume-admitted", body.clone())
            .await
            .unwrap_err()
            .code,
        "agent_runtime_repair_in_progress"
    );
    assert_eq!(open_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap(),
        source_selection,
        "reopening and replaying intent must retain the source credential selection"
    );
    let transition = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        transition.state,
        AgentRuntimeTransitionStateV1::SourceStopped
    );
    assert!(transition.predecessor_operation_id.is_none());
    let target_execution_profile = transition.intent.target_execution_profile.clone();
    assert_ne!(
        source_selection.as_ref().unwrap().execution_profile,
        target_execution_profile
    );
    assert!(matches!(
        agent_runtime_transition_apply::drive_locked(&state, transition)
            .await
            .unwrap(),
        agent_runtime_transition_apply::TransitionDriveOutcome::Committed(_)
    ));
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .execution_profile,
        target_execution_profile,
        "only the successful target launch may commit its credential selection"
    );
    agent_runtime_transition_apply::apply(&state, "resume-admitted", body.clone())
        .await
        .unwrap();
    let mut changed = body;
    changed.target_interaction_profile = AgentInteractionProfileV1::NativeCli;
    assert_eq!(
        agent_runtime_transition_apply::apply(&state, "resume-admitted", changed)
            .await
            .unwrap_err()
            .code,
        "agent_runtime_transition_idempotency_conflict"
    );
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(open_count.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn transition_cannot_retarget_or_escalate_an_admitted_intent() {
    let (_root, state, _, _) = fixture(Vec::new()).await;
    let (agent_id, _, operation_id) = admit_structured_credential_transition(&state).await;
    let before = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    for changes in [
        serde_json::json!({"targetInteractionProfile": "native_cli"}),
        serde_json::json!({"targetExecutionProfile": {"kind": "provider_default"}}),
        serde_json::json!({"targetLaunchSelection": {"model": "changed-model"}}),
        serde_json::json!({"sourceStopPolicy": "discard", "expectedSourceRevision": before.intent.source.revision}),
        serde_json::json!({"expectedSourceRevision": before.intent.source.revision + 1}),
    ] {
        let mut request = serde_json::json!({
            "schemaVersion": 1,
            "agentId": agent_id,
            "targetInteractionProfile": "structured_protocol"
        });
        request
            .as_object_mut()
            .unwrap()
            .extend(changes.as_object().unwrap().clone());
        assert_eq!(
            agent_runtime_transition_apply::apply(
                &state,
                "different-intent",
                serde_json::from_value(request).unwrap()
            )
            .await
            .unwrap_err()
            .code,
            "agent_runtime_transition_conflict"
        );
        assert_eq!(
            state
                .store
                .agent_runtime_transition(&operation_id)
                .await
                .unwrap()
                .unwrap(),
            before
        );
    }
}
