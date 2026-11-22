use super::*;

/// Every attach fails the same retryable way; a close is the only effect that
/// can succeed, so it proves when recovery decided a new durable step.
struct PersistentAttachFailureRuntime {
    attach_count: Arc<AtomicUsize>,
    attach_times: Arc<StdMutex<Vec<tokio::time::Instant>>>,
    stop_count: Arc<AtomicUsize>,
}

impl structured_provider_runtime::StructuredProviderRuntime for PersistentAttachFailureRuntime {
    fn new_session_availability(
        &self,
    ) -> Result<(), structured_provider_runtime::StructuredProviderRuntimeErrorV1> {
        Err(CountingStructuredRuntime::unavailable())
    }

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
        _binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        self.attach_times
            .lock()
            .unwrap()
            .push(tokio::time::Instant::now());
        self.attach_count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn open_replacement<'a>(
        &'a self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
        _provider_state_environment: hmux_client::ProviderStateEnvironment,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn stop_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Ok(()) })
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
        self.stop_count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

/// A candidate that keeps failing on the same durable state backs off past
/// the rescan interval instead of retrying every second forever. Unrelated
/// wakes do not re-decide it; a wake after its own state changed does.
#[tokio::test]
async fn persistent_failure_backs_off_until_its_durable_state_changes() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let provider_id = ProviderIdV1::new("provider.persistent").unwrap();
    let agent_id = AgentIdV1::new("recovery-persistent-failure").unwrap();
    let (selection, binding) =
        initialize_recovery_runtime(&state, agent_id, provider_id.clone()).await;
    let attach_count = Arc::new(AtomicUsize::new(0));
    let attach_times = Arc::new(StdMutex::new(Vec::new()));
    let stop_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(PersistentAttachFailureRuntime {
                attach_count: Arc::clone(&attach_count),
                attach_times: Arc::clone(&attach_times),
                stop_count: Arc::clone(&stop_count),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    let state = Arc::new(state);
    // Fixture initialization uses real SQLite I/O; only recovery runs on paused time.
    tokio::time::pause();
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&state)));

    // Past the former one-second ceiling and past several rescans.
    let expected_delays_ms = [50, 100, 200, 400, 800, 1_600, 3_200, 6_400];
    let observed = async {
        wait_for_attempt(|| attach_count.load(Ordering::SeqCst) == 1).await?;
        for (index, delay_ms) in expected_delays_ms.into_iter().enumerate() {
            tokio::time::advance(std::time::Duration::from_millis(delay_ms - 1)).await;
            settle_without_advancing_time(150).await;
            if attach_count.load(Ordering::SeqCst) != index + 1 {
                return Err("a persistent failure retried before its backoff elapsed");
            }
            tokio::time::advance(std::time::Duration::from_millis(2)).await;
            wait_for_attempt(|| attach_count.load(Ordering::SeqCst) > index + 1).await?;
        }
        let attempts = attach_count.load(Ordering::SeqCst);

        state.agent_runtime_recovery_wake.notify_one();
        settle_without_advancing_time(300).await;
        if attach_count.load(Ordering::SeqCst) != attempts {
            return Err("a wake without a durable change re-decided the same failure");
        }

        tokio::time::resume();
        let close_id = admit_recovery_close(&state, selection, binding).await;
        tokio::time::pause();
        state.agent_runtime_recovery_wake.notify_one();
        wait_for_attempt(|| stop_count.load(Ordering::SeqCst) == 1)
            .await
            .map_err(|_| "a wake after a durable change must drive it at once")?;
        if attach_count.load(Ordering::SeqCst) != attempts {
            return Err("the new close must not repeat the failed attach");
        }
        Ok(close_id)
    }
    .await;
    tokio::time::resume();
    let converged = match &observed {
        Ok(close_id) => tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while state
                .store
                .agent_runtime_close(close_id)
                .await
                .unwrap()
                .is_none_or(|close| close.state != AgentRuntimeCloseStateV1::Stopped)
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok(),
        Err(_) => false,
    };

    recovery.abort();
    let _ = recovery.await;

    let attempts = attach_times.lock().unwrap().clone();
    if let Err(error) = observed {
        panic!(
            "{error}; attaches={attempts:?}, stops={}",
            stop_count.load(Ordering::SeqCst)
        );
    }
    assert!(converged, "the woken close must converge");
    assert_eq!(attempts.len(), expected_delays_ms.len() + 1);
    for (pair, delay_ms) in attempts.windows(2).zip(expected_delays_ms) {
        let elapsed = pair[1] - pair[0];
        assert!(
            elapsed >= std::time::Duration::from_millis(delay_ms)
                && elapsed <= std::time::Duration::from_millis(delay_ms + 1),
            "attempt spacing {elapsed:?} must follow the {delay_ms} ms backoff; attaches={attempts:?}"
        );
    }
}
