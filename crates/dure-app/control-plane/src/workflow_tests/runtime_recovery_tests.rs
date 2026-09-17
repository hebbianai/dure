use super::*;

mod panic_tests;

struct LostWakeBarrierRuntime {
    startup_agent_id: AgentIdV1,
    wake_scan_agent_id: AgentIdV1,
    startup_attach_entered: Arc<tokio::sync::Barrier>,
    startup_attach_release: Arc<tokio::sync::Barrier>,
    wake_scan_stop_entered: Arc<tokio::sync::Barrier>,
    wake_scan_stop_release: Arc<tokio::sync::Barrier>,
    skipped_agent_stop_entered: Arc<tokio::sync::Barrier>,
    attach_count: Arc<AtomicUsize>,
    startup_stop_count: Arc<AtomicUsize>,
    wake_scan_stop_count: Arc<AtomicUsize>,
}

struct TransientAttachRuntime {
    attach_count: Arc<AtomicUsize>,
}

impl structured_provider_runtime::StructuredProviderRuntime for TransientAttachRuntime {
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
        binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        let attempt = self.attach_count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if attempt == 0 {
                Err(CountingStructuredRuntime::unavailable())
            } else {
                Ok(binding.clone())
            }
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

impl structured_provider_runtime::StructuredProviderRuntime for LostWakeBarrierRuntime {
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
        let is_startup_agent = selection.agent_id == self.startup_agent_id;
        let entered = Arc::clone(&self.startup_attach_entered);
        let release = Arc::clone(&self.startup_attach_release);
        let attach_count = Arc::clone(&self.attach_count);
        let binding = binding.clone();
        Box::pin(async move {
            attach_count.fetch_add(1, Ordering::SeqCst);
            if is_startup_agent {
                entered.wait().await;
                release.wait().await;
            }
            Ok(binding)
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
        binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        let is_startup_agent = binding.agent_id == self.startup_agent_id;
        let is_wake_scan_agent = binding.agent_id == self.wake_scan_agent_id;
        let startup_entered = Arc::clone(&self.skipped_agent_stop_entered);
        let wake_scan_entered = Arc::clone(&self.wake_scan_stop_entered);
        let wake_scan_release = Arc::clone(&self.wake_scan_stop_release);
        let startup_stop_count = Arc::clone(&self.startup_stop_count);
        let wake_scan_stop_count = Arc::clone(&self.wake_scan_stop_count);
        Box::pin(async move {
            if is_startup_agent {
                startup_stop_count.fetch_add(1, Ordering::SeqCst);
                startup_entered.wait().await;
            } else if is_wake_scan_agent {
                wake_scan_stop_count.fetch_add(1, Ordering::SeqCst);
                wake_scan_entered.wait().await;
                wake_scan_release.wait().await;
            }
            Ok(())
        })
    }
}

async fn initialize_recovery_runtime(
    state: &ServiceState,
    agent_id: AgentIdV1,
    provider_id: ProviderIdV1,
) -> (AgentRuntimeSelectionV1, AgentInteractionBindingV1) {
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: provider_id.clone(),
            display_name: format!("Recovery {}", agent_id.as_str()),
            created_at_ms: 10,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    let selection = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 10,
    };
    state
        .store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();
    let binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new(format!(
            "interaction-{}",
            agent_id.as_str()
        ))
        .unwrap(),
        agent_id,
        provider_id,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some(format!("conversation-{}", selection.agent_id.as_str())),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: format!("runtime-{}", selection.agent_id.as_str()),
            provider_epoch: format!("provider-{}", selection.agent_id.as_str()),
        },
        timeline_epoch: AgentTimelineEpochV1::new(format!(
            "timeline-{}",
            selection.agent_id.as_str()
        ))
        .unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 10,
        updated_at_ms: 10,
    };
    state
        .store
        .create_agent_interaction(&binding)
        .await
        .unwrap();
    (selection, binding)
}

async fn admit_recovery_close(
    state: &ServiceState,
    source: AgentRuntimeSelectionV1,
    binding: AgentInteractionBindingV1,
) -> OperationIdV1 {
    let operation_id = OperationIdV1::new(format!("close-{}", source.agent_id.as_str())).unwrap();
    state
        .store
        .admit_agent_runtime_close(&AgentRuntimeCloseIntentV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            idempotency_key: format!("close-{}-key", source.agent_id.as_str()),
            source,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
            stopped_transition: None,
            requested_at_ms: 20,
        })
        .await
        .unwrap();
    operation_id
}

#[tokio::test]
async fn completed_worker_rescans_durable_work_skipped_while_agent_was_active() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let provider_id = ProviderIdV1::new("provider.codex").unwrap();
    let startup_agent_id = AgentIdV1::new("recovery-startup-agent").unwrap();
    let wake_scan_agent_id = AgentIdV1::new("recovery-wake-agent").unwrap();
    let (startup_selection, startup_binding) =
        initialize_recovery_runtime(&state, startup_agent_id.clone(), provider_id.clone()).await;

    let startup_attach_entered = Arc::new(tokio::sync::Barrier::new(2));
    let startup_attach_release = Arc::new(tokio::sync::Barrier::new(2));
    let wake_scan_stop_entered = Arc::new(tokio::sync::Barrier::new(2));
    let wake_scan_stop_release = Arc::new(tokio::sync::Barrier::new(2));
    let skipped_agent_stop_entered = Arc::new(tokio::sync::Barrier::new(2));
    let attach_count = Arc::new(AtomicUsize::new(0));
    let startup_stop_count = Arc::new(AtomicUsize::new(0));
    let wake_scan_stop_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id.clone(),
            Arc::new(LostWakeBarrierRuntime {
                startup_agent_id: startup_agent_id.clone(),
                wake_scan_agent_id: wake_scan_agent_id.clone(),
                startup_attach_entered: Arc::clone(&startup_attach_entered),
                startup_attach_release: Arc::clone(&startup_attach_release),
                wake_scan_stop_entered: Arc::clone(&wake_scan_stop_entered),
                wake_scan_stop_release: Arc::clone(&wake_scan_stop_release),
                skipped_agent_stop_entered: Arc::clone(&skipped_agent_stop_entered),
                attach_count: Arc::clone(&attach_count),
                startup_stop_count: Arc::clone(&startup_stop_count),
                wake_scan_stop_count: Arc::clone(&wake_scan_stop_count),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    let state = Arc::new(state);
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&state)));

    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        startup_attach_entered.wait(),
    )
    .await
    .expect("startup recovery worker must be active");

    let (wake_selection, wake_binding) =
        initialize_recovery_runtime(&state, wake_scan_agent_id, provider_id).await;
    let startup_close_id = admit_recovery_close(&state, startup_selection, startup_binding).await;
    let wake_close_id = admit_recovery_close(&state, wake_selection, wake_binding).await;
    state.agent_runtime_recovery_wake.notify_one();

    // The second Agent blocks inside its close effect, proving that the wake
    // scan ran while the startup Agent was still active and skipped it.
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        wake_scan_stop_entered.wait(),
    )
    .await
    .expect("the wake scan must run while the startup Agent remains active");
    startup_attach_release.wait().await;

    // No notification follows the startup worker's completion. Its durable
    // close can converge only if completion itself performs the rescan.
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        skipped_agent_stop_entered.wait(),
    )
    .await
    .expect("worker completion must rescan and recover the previously skipped Agent");
    wake_scan_stop_release.wait().await;

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let startup = state
                .store
                .agent_runtime_close(&startup_close_id)
                .await
                .unwrap()
                .unwrap();
            let wake = state
                .store
                .agent_runtime_close(&wake_close_id)
                .await
                .unwrap()
                .unwrap();
            if startup.state == AgentRuntimeCloseStateV1::Stopped
                && wake.state == AgentRuntimeCloseStateV1::Stopped
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("both durable closes must converge");
    assert_eq!(attach_count.load(Ordering::SeqCst), 1);
    assert_eq!(startup_stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(wake_scan_stop_count.load(Ordering::SeqCst), 1);

    recovery.abort();
    let _ = recovery.await;
}

#[tokio::test]
async fn durable_provider_failure_quiesces_recovery_after_one_attempt() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new("coordinator-1").unwrap();
    let provider_id = ProviderIdV1::new("provider.codex").unwrap();
    let selection = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 10,
    };
    state
        .store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();
    let binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-stable").unwrap(),
        agent_id,
        provider_id: provider_id.clone(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-stable".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-stable".into(),
            provider_epoch: "provider-stable".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-stable").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 10,
        updated_at_ms: 10,
    };
    state
        .store
        .create_agent_interaction(&binding)
        .await
        .unwrap();
    let attach_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(CountingStructuredRuntime {
                supports_new_sessions: false,
                attach_count: Arc::clone(&attach_count),
                attach_error: Some(
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::ExplicitRecoveryRequired,
                ),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    let state = Arc::new(state);
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&state)));

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while attach_count.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("startup recovery must observe the durable provider failure");
    tokio::time::sleep(std::time::Duration::from_millis(180)).await;
    assert_eq!(
        attach_count.load(Ordering::SeqCst),
        1,
        "a durable provider failure must not create effects on coordinator backoff ticks"
    );
    state.agent_runtime_recovery_wake.notify_one();
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    assert_eq!(attach_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        state
            .store
            .agent_interaction(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(binding.clone()),
    );

    recovery.abort();
    let _ = recovery.await;

    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&state)));
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while attach_count.load(Ordering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("a restarted coordinator must reread the durable provider failure once");
    tokio::time::sleep(std::time::Duration::from_millis(180)).await;
    state.agent_runtime_recovery_wake.notify_one();
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    assert_eq!(
        attach_count.load(Ordering::SeqCst),
        2,
        "a coordinator restart may reread, but must not retry, a durable provider failure"
    );
    assert_eq!(
        state
            .store
            .agent_interaction(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(binding),
    );

    recovery.abort();
    let _ = recovery.await;
}

async fn assert_credential_authority_failure_parks(
    error_kind: structured_provider_runtime::StructuredProviderRuntimeErrorKindV1,
    case: &str,
) {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new(format!("credential-recovery-{case}")).unwrap();
    let provider_id = ProviderIdV1::new(format!("provider.{case}")).unwrap();
    let (_, binding) = initialize_recovery_runtime(&state, agent_id, provider_id.clone()).await;
    let attach_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(CountingStructuredRuntime {
                supports_new_sessions: false,
                attach_count: Arc::clone(&attach_count),
                attach_error: Some(error_kind),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    let state = Arc::new(state);
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&state)));

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while attach_count.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("startup recovery must observe the credential authority failure");

    tokio::time::sleep(std::time::Duration::from_millis(220)).await;
    assert_eq!(
        attach_count.load(Ordering::SeqCst),
        1,
        "credential authority failure {case} must park without timer retries"
    );

    state.agent_runtime_recovery_wake.notify_one();
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    assert_eq!(
        attach_count.load(Ordering::SeqCst),
        1,
        "an unrelated recovery wake must not retry parked credential authority {case}"
    );
    assert_eq!(
        state
            .store
            .agent_interaction(&binding.interaction_session_id)
            .await
            .unwrap(),
        Some(binding),
        "parking must preserve the exact structured binding"
    );

    recovery.abort();
    let _ = recovery.await;
}

#[tokio::test]
async fn credential_authority_failures_do_not_poll_or_follow_unrelated_wakes() {
    for (error_kind, case) in [
        (
            structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::CredentialUnavailable,
            "local-unavailable",
        ),
        (
            structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::CredentialStale,
            "ssh-stale",
        ),
    ] {
        assert_credential_authority_failure_parks(error_kind, case).await;
    }
}

#[tokio::test]
async fn transient_runtime_unavailability_still_retries_and_converges() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new("transient-runtime-recovery").unwrap();
    let provider_id = ProviderIdV1::new("provider.transient").unwrap();
    initialize_recovery_runtime(&state, agent_id, provider_id.clone()).await;
    let attach_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(TransientAttachRuntime {
                attach_count: Arc::clone(&attach_count),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::new(state)));

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while attach_count.load(Ordering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("transient runtime unavailability must retain automatic recovery");
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    assert_eq!(
        attach_count.load(Ordering::SeqCst),
        2,
        "a successful retry must converge instead of becoming a recurring candidate"
    );

    recovery.abort();
    let _ = recovery.await;
}

/// Red-first contract for the interval rescan: a transition admitted after
/// the startup scan, whose wake never arrives (or whose first drive fails),
/// must still converge. Before the rescan existed the loop parked on
/// `notified()` forever and an 'admitted' switch had no API able to move it.
#[tokio::test]
async fn interval_rescan_converges_an_admitted_transition_without_a_wake() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let stop_count = Arc::new(AtomicUsize::new(0));
    let open_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            ProviderIdV1::new("codex").unwrap(),
            Arc::new(RepairableReplacementRuntime {
                store: Arc::clone(&state.store),
                stop_count: Arc::clone(&stop_count),
                open_count: Arc::clone(&open_count),
                first_failure_kind:
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
                second_failure_kind: None,
                succeed_on_retry: true,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    let state = Arc::new(state);
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&state)));
    // Let the startup scan finish over an empty store, so the transition
    // below is visible only to a later rescan - never to startup.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let (_agent_id, _provider_id, operation_id) =
        admit_structured_credential_transition(&state).await;

    // Deliberately no agent_runtime_recovery_wake notification.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if state
                .store
                .agent_runtime_transition(&operation_id)
                .await
                .unwrap()
                .is_some_and(|record| record.state == AgentRuntimeTransitionStateV1::Committed)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the interval rescan must drive an admitted transition to commit without a wake");
    assert!(open_count.load(Ordering::SeqCst) >= 1);
    recovery.abort();
    let _ = recovery.await;
}
