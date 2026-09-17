use super::*;

#[tokio::test]
async fn stopped_close_successors_remain_visible_and_replay_without_launching_again() {
    let (_root, mut state, launcher, _) = fixture(Vec::new()).await;
    state.agent_providers = Arc::new(provider_extension::test_structured_agent_provider_registry(
        "provider.codex",
    ));
    let (agent_id, provider_id, close_id) = admit_structured_close(&state).await;
    state
        .store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: close_id.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: 25,
        })
        .await
        .unwrap();
    let stop_count = Arc::new(AtomicUsize::new(0));
    let open_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(RepairableReplacementRuntime {
                store: Arc::clone(&state.store),
                stop_count: Arc::clone(&stop_count),
                open_count: Arc::clone(&open_count),
                first_failure_kind: structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::CredentialUnavailable,
                second_failure_kind: Some(structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::CredentialUnavailable),
                succeed_on_retry: true,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    let body = agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        expected_source_revision: Some(1),
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        target_execution_profile: None,
        target_launch_selection: None,
    };
    let mut predecessor_id = close_id;
    for attempt in 0..2 {
        let key = format!("stopped-close-successor-{attempt}");
        assert_eq!(
            agent_runtime_transition_apply::apply(&state, &key, body.clone())
                .await
                .unwrap_err()
                .code,
            "agent_runtime_repair_required",
            "a stopped close must allow the next explicit target attempt"
        );
        let current = state
            .store
            .active_agent_runtime_transition(&agent_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.predecessor_operation_id, Some(predecessor_id));
        let observation = agent_runtime_transition_apply::inspect(
            &state,
            agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 {
                schema_version: 1,
                agent_id: agent_id.clone(),
            },
        )
        .await
        .unwrap();
        assert!(
            matches!(
                observation,
                agent_runtime_transition_apply::AgentRuntimeInspectObservationV1::Transitioning {
                    operation_id,
                    stage: AgentRuntimeTransitionStateV1::RepairRequired,
                    ..
                } if operation_id == current.intent.operation_id
            ),
            "inspection must project the newest successor, not its historical close"
        );
        assert_eq!(
            agent_runtime_transition_apply::apply(&state, &key, body.clone())
                .await
                .unwrap_err()
                .code,
            "agent_runtime_repair_required"
        );
        assert_eq!(open_count.load(Ordering::SeqCst), attempt + 1);
        predecessor_id = current.intent.operation_id;
    }
    agent_runtime_transition_apply::apply(&state, "stopped-close-successor-final", body.clone())
        .await
        .unwrap();
    agent_runtime_transition_apply::apply(&state, "stopped-close-successor-final", body)
        .await
        .unwrap();
    assert_eq!(open_count.load(Ordering::SeqCst), 3);
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert!(launcher.requests().is_empty());
    assert!(
        state
            .store
            .effective_agent_runtime_close(&agent_id)
            .await
            .unwrap()
            .is_none()
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
    assert!(matches!(
        observation,
        agent_runtime_transition_apply::AgentRuntimeInspectObservationV1::Stable { .. }
    ));
}
