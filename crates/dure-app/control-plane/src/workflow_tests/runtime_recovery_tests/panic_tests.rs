use super::*;

struct PanicIsolationRuntime {
    panicking_agent_id: AgentIdV1,
    healthy_agent_id: AgentIdV1,
    first_attach_entered: Arc<tokio::sync::Barrier>,
    healthy_attach_release: Arc<Semaphore>,
    panicking_attach_attempts: Arc<AtomicUsize>,
    panicking_attempt_times: Arc<std::sync::Mutex<Vec<(tokio::time::Instant, tokio::task::Id)>>>,
    healthy_attach_attempts: Arc<AtomicUsize>,
    panicking_attach_successes: Arc<AtomicUsize>,
    healthy_attach_successes: Arc<AtomicUsize>,
    panic_every_attempt: bool,
}

impl structured_provider_runtime::StructuredProviderRuntime for PanicIsolationRuntime {
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
        selection: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        let is_panicking_agent = selection.agent_id == self.panicking_agent_id;
        let is_healthy_agent = selection.agent_id == self.healthy_agent_id;
        let first_attach_entered = Arc::clone(&self.first_attach_entered);
        let healthy_attach_release = Arc::clone(&self.healthy_attach_release);
        let panicking_attach_attempts = Arc::clone(&self.panicking_attach_attempts);
        let panicking_attempt_times = Arc::clone(&self.panicking_attempt_times);
        let healthy_attach_attempts = Arc::clone(&self.healthy_attach_attempts);
        let panicking_attach_successes = Arc::clone(&self.panicking_attach_successes);
        let healthy_attach_successes = Arc::clone(&self.healthy_attach_successes);
        let panic_every_attempt = self.panic_every_attempt;
        let binding = binding.clone();
        Box::pin(async move {
            if is_panicking_agent {
                let attempt = panicking_attach_attempts.load(Ordering::SeqCst);
                if attempt == 0 {
                    first_attach_entered.wait().await;
                }
                // Bound the fault fixture even if the coordinator starts respawning workers.
                if attempt >= 16 {
                    return std::future::pending().await;
                }
                panicking_attempt_times
                    .lock()
                    .unwrap()
                    .push((tokio::time::Instant::now(), tokio::task::id()));
                panicking_attach_attempts.fetch_add(1, Ordering::SeqCst);
                if panic_every_attempt || attempt == 0 {
                    std::panic::resume_unwind(Box::new("injected startup recovery worker panic"));
                }
                panicking_attach_successes.fetch_add(1, Ordering::SeqCst);
                return Ok(binding);
            }
            if is_healthy_agent {
                healthy_attach_attempts.fetch_add(1, Ordering::SeqCst);
                first_attach_entered.wait().await;
                healthy_attach_release
                    .acquire()
                    .await
                    .expect("test release semaphore must remain open")
                    .forget();
                healthy_attach_successes.fetch_add(1, Ordering::SeqCst);
                return Ok(binding);
            }
            Err(CountingStructuredRuntime::unavailable())
        })
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
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn startup_worker_panic_does_not_cancel_other_candidates_and_retries_once() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let provider_id = ProviderIdV1::new("provider.codex").unwrap();
    let panicking_agent_id = AgentIdV1::new("recovery-panicking-agent").unwrap();
    let healthy_agent_id = AgentIdV1::new("recovery-healthy-agent").unwrap();
    initialize_recovery_runtime(&state, panicking_agent_id.clone(), provider_id.clone()).await;
    initialize_recovery_runtime(&state, healthy_agent_id.clone(), provider_id.clone()).await;

    let first_attach_entered = Arc::new(tokio::sync::Barrier::new(3));
    let healthy_attach_release = Arc::new(Semaphore::new(0));
    let panicking_attach_attempts = Arc::new(AtomicUsize::new(0));
    let healthy_attach_attempts = Arc::new(AtomicUsize::new(0));
    let panicking_attach_successes = Arc::new(AtomicUsize::new(0));
    let healthy_attach_successes = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(PanicIsolationRuntime {
                panicking_agent_id,
                healthy_agent_id,
                first_attach_entered: Arc::clone(&first_attach_entered),
                healthy_attach_release: Arc::clone(&healthy_attach_release),
                panicking_attach_attempts: Arc::clone(&panicking_attach_attempts),
                panicking_attempt_times: Arc::new(std::sync::Mutex::new(Vec::new())),
                healthy_attach_attempts: Arc::clone(&healthy_attach_attempts),
                panicking_attach_successes: Arc::clone(&panicking_attach_successes),
                healthy_attach_successes: Arc::clone(&healthy_attach_successes),
                panic_every_attempt: false,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    let state = Arc::new(state);
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&state)));

    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        first_attach_entered.wait(),
    )
    .await
    .expect("both startup candidates must enter their first attach");

    let panicking_candidate_recovered =
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while panicking_attach_successes.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_ok();
    healthy_attach_release.add_permits(1);
    let healthy_candidate_recovered =
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while healthy_attach_successes.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_ok();

    recovery.abort();
    let _ = recovery.await;

    assert!(
        panicking_candidate_recovered,
        "the failed stable startup candidate must be retried in the same service lifetime"
    );
    assert!(
        healthy_candidate_recovered,
        "one startup worker panic must not cancel an unrelated healthy candidate"
    );
    assert_eq!(panicking_attach_attempts.load(Ordering::SeqCst), 2);
    assert_eq!(healthy_attach_attempts.load(Ordering::SeqCst), 1);
}

// Keep virtual time still while the real SQLite executor completes a query.
// A wall-clock deadline bounds a broken fixture without auto-advancing retry timers.
async fn wait_for_attempt(predicate: impl Fn() -> bool) -> Result<(), &'static str> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !predicate() {
        if std::time::Instant::now() >= deadline {
            return Err("recovery did not reach the expected observation");
        }
        tokio::task::yield_now().await;
    }
    Ok(())
}

#[tokio::test]
async fn persistent_startup_worker_panic_uses_the_existing_exponential_backoff() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let provider_id = ProviderIdV1::new("provider.codex").unwrap();
    let panicking_agent_id = AgentIdV1::new("recovery-persistent-panic-agent").unwrap();
    let healthy_agent_id = AgentIdV1::new("recovery-healthy-agent").unwrap();
    initialize_recovery_runtime(&state, panicking_agent_id.clone(), provider_id.clone()).await;
    initialize_recovery_runtime(&state, healthy_agent_id.clone(), provider_id.clone()).await;

    let first_attach_entered = Arc::new(tokio::sync::Barrier::new(3));
    let healthy_attach_release = Arc::new(Semaphore::new(0));
    let panicking_attach_attempts = Arc::new(AtomicUsize::new(0));
    let panicking_attempt_times = Arc::new(std::sync::Mutex::new(Vec::new()));
    let healthy_attach_attempts = Arc::new(AtomicUsize::new(0));
    let healthy_attach_successes = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(PanicIsolationRuntime {
                panicking_agent_id,
                healthy_agent_id,
                first_attach_entered: Arc::clone(&first_attach_entered),
                healthy_attach_release: Arc::clone(&healthy_attach_release),
                panicking_attach_attempts: Arc::clone(&panicking_attach_attempts),
                panicking_attempt_times: Arc::clone(&panicking_attempt_times),
                healthy_attach_attempts: Arc::clone(&healthy_attach_attempts),
                panicking_attach_successes: Arc::new(AtomicUsize::new(0)),
                healthy_attach_successes: Arc::clone(&healthy_attach_successes),
                panic_every_attempt: true,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    let state = Arc::new(state);
    // Fixture initialization uses real SQLite I/O; only recovery runs on paused time.
    tokio::time::pause();
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&state)));
    let first_attach = tokio::spawn(async move { first_attach_entered.wait().await });

    let observed = async {
        wait_for_attempt(|| panicking_attach_attempts.load(Ordering::SeqCst) == 1).await?;
        let expected_delays_ms = [50, 100, 200, 400, 800, 1_000, 1_000];
        for (index, delay_ms) in expected_delays_ms.into_iter().enumerate() {
            tokio::time::advance(std::time::Duration::from_millis(delay_ms - 1)).await;
            tokio::task::yield_now().await;
            if panicking_attach_attempts.load(Ordering::SeqCst) != index + 1 {
                return Err("a persistent panic retried before its exponential delay");
            }
            // Tokio rounds timer deadlines up to its next millisecond tick.
            tokio::time::advance(std::time::Duration::from_millis(2)).await;
            wait_for_attempt(|| panicking_attach_attempts.load(Ordering::SeqCst) > index + 1)
                .await?;
            if index == 2 {
                // Finish the healthy candidate while its peer continues failing.
                healthy_attach_release.add_permits(1);
                wait_for_attempt(|| healthy_attach_successes.load(Ordering::SeqCst) == 1).await?;
            }
        }
        Ok(())
    }
    .await;

    recovery.abort();
    let _ = recovery.await;
    first_attach.abort();
    let _ = first_attach.await;
    tokio::time::resume();

    assert!(
        observed.is_ok(),
        "persistent panic must remain bounded while the healthy candidate completes: {observed:?}; attempts={:?}, healthy={}",
        panicking_attempt_times.lock().unwrap(),
        healthy_attach_successes.load(Ordering::SeqCst),
    );
    assert_eq!(healthy_attach_attempts.load(Ordering::SeqCst), 1);
    assert_eq!(healthy_attach_successes.load(Ordering::SeqCst), 1);
    let attempts = panicking_attempt_times.lock().unwrap();
    assert_eq!(attempts.len(), 8);
    for (pair, delay_ms) in attempts
        .windows(2)
        .zip([50, 100, 200, 400, 800, 1_000, 1_000])
    {
        let elapsed = pair[1].0 - pair[0].0;
        assert!(elapsed >= std::time::Duration::from_millis(delay_ms));
        assert!(elapsed <= std::time::Duration::from_millis(delay_ms + 1));
        assert_eq!(
            pair[1].1, pair[0].1,
            "recovery must retain the same worker across panics and rescans"
        );
    }
}
