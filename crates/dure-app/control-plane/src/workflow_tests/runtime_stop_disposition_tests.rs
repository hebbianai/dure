use super::*;
use structured_provider_runtime::StructuredProviderRuntimeErrorKindV1 as StopError;

struct ContextualStopRuntime {
    stop_error: Option<StopError>,
    stop_count: Arc<AtomicUsize>,
    open_count: Arc<AtomicUsize>,
}

impl structured_provider_runtime::StructuredProviderRuntime for ContextualStopRuntime {
    fn open(
        &self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn attach_existing<'a>(
        &'a self,
        _selection: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        Box::pin(async move { Ok(binding.clone()) })
    }

    fn open_replacement<'a>(
        &'a self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
        _provider_state_environment: hmux_client::ProviderStateEnvironment,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        self.open_count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Err(
                structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::StopFailed,
                    "fixture_target_cleanup_incomplete",
                ),
            )
        })
    }

    fn stop_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        self.stop_count.fetch_add(1, Ordering::SeqCst);
        let stop_error = self.stop_error;
        Box::pin(async move {
            if let Some(kind) = stop_error {
                Err(
                    structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                        kind,
                        "fixture_selected_source_refused",
                    ),
                )
            } else {
                Ok(())
            }
        })
    }

    fn retire_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<
        'a,
        dure_app::AgentRuntimeReplacementAuthorityV1,
    > {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn stop_current<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

async fn contextual_stop_fixture(
    stop_error: Option<StopError>,
) -> (
    TempDir,
    ServiceState,
    AgentIdV1,
    OperationIdV1,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let (agent_id, provider_id, operation_id) =
        admit_structured_credential_transition(&state).await;
    let stop_count = Arc::new(AtomicUsize::new(0));
    let open_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(ContextualStopRuntime {
                stop_error,
                stop_count: Arc::clone(&stop_count),
                open_count: Arc::clone(&open_count),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    (root, state, agent_id, operation_id, stop_count, open_count)
}

#[tokio::test]
async fn definitive_selected_source_refusal_is_durably_retained_once() {
    let (_root, state, agent_id, operation_id, stop_count, open_count) =
        contextual_stop_fixture(Some(StopError::RuntimeConflict)).await;
    let admitted = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();

    assert!(matches!(
        agent_runtime_transition_apply::drive_locked(&state, admitted)
            .await
            .unwrap(),
        agent_runtime_transition_apply::TransitionDriveOutcome::SourceRetained
    ));
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
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(open_count.load(Ordering::SeqCst), 0);

    assert!(matches!(
        agent_runtime_transition_apply::drive_locked(&state, retained)
            .await
            .unwrap(),
        agent_runtime_transition_apply::TransitionDriveOutcome::SourceRetained
    ));
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert!(
        state
            .store
            .active_agent_runtime_transition(&agent_id)
            .await
            .unwrap()
            .is_none(),
        "a retained source is stable, not an automatic recovery candidate"
    );
}

#[tokio::test]
async fn failed_target_cleanup_refusal_stays_source_stopped_and_retryable() {
    let (_root, state, _agent_id, operation_id, stop_count, open_count) =
        contextual_stop_fixture(None).await;
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

    assert_eq!(
        agent_runtime_transition_apply::drive_locked(&state, stopped)
            .await
            .unwrap_err(),
        "fixture_target_cleanup_incomplete"
    );
    let retryable = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        retryable.state,
        AgentRuntimeTransitionStateV1::SourceStopped
    );
    assert!(retryable.target_failure.is_none());
    assert!(retryable.replacement_authority.is_none());
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert_eq!(open_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn partial_source_stop_retries_without_retaining_source_or_starting_target() {
    let (_root, state, agent_id, operation_id, stop_count, open_count) =
        contextual_stop_fixture(Some(StopError::StopFailed)).await;
    for attempt in 1..=2 {
        let admitted = state
            .store
            .agent_runtime_transition(&operation_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(admitted.state, AgentRuntimeTransitionStateV1::Admitted);
        let revision = admitted.journal_revision;
        assert_eq!(
            agent_runtime_transition_apply::drive_locked(&state, admitted)
                .await
                .unwrap_err(),
            "fixture_selected_source_refused",
        );
        let pending = state
            .store
            .active_agent_runtime_transition(&agent_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pending.intent.operation_id, operation_id);
        assert_eq!(pending.state, AgentRuntimeTransitionStateV1::Admitted);
        assert_eq!(pending.journal_revision, revision);
        assert!(pending.target_failure.is_none());
        assert_eq!(stop_count.load(Ordering::SeqCst), attempt);
        assert_eq!(open_count.load(Ordering::SeqCst), 0);
    }
}
