use super::*;

#[tokio::test]
async fn explicit_transition_replaces_an_unchanged_failed_target() {
    explicit_transition_replaces_failed_target(false).await;
}

#[tokio::test]
async fn explicit_transition_replaces_a_corrected_failed_target() {
    explicit_transition_replaces_failed_target(true).await;
}

async fn explicit_transition_replaces_failed_target(change_model: bool) {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    state.agent_providers =
        Arc::new(provider_extension::test_codex_structured_agent_provider_registry());
    let (agent_id, provider_id, operation_id) =
        admit_structured_credential_transition(&state).await;
    let stop_count = Arc::new(AtomicUsize::new(0));
    let open_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes.register(provider_id, Arc::new(RepairableReplacementRuntime {
        store: Arc::clone(&state.store),
        stop_count: Arc::clone(&stop_count),
        open_count: Arc::clone(&open_count),
        first_failure_kind: structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::CredentialUnavailable,
        second_failure_kind: Some(structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable),
        succeed_on_retry: true,
    })).unwrap();
    state.structured_runtimes = Arc::new(runtimes);
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
        agent_runtime_transition_apply::TransitionDriveOutcome::RepairRequired
    ));
    let parked = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    let body = agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        expected_source_revision: Some(parked.intent.source.revision),
        target_interaction_profile: parked.intent.target_interaction_profile,
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        target_execution_profile: Some(parked.intent.target_execution_profile.clone()),
        target_launch_selection: change_model.then(|| dure_app::AgentRuntimeLaunchSelectionV1 {
            model: Some(dure_app::AgentSpawnModelSelectionV1::parse("gpt-5.6-sol").unwrap()),
            effort: None,
            permission_mode: None,
        }),
    };
    let mut stale = body.clone();
    stale.expected_source_revision = Some(parked.intent.source.revision + 1);
    assert_eq!(
        agent_runtime_transition_apply::apply(&state, "stale-target", stale)
            .await
            .unwrap_err()
            .code,
        "agent_runtime_transition_conflict"
    );
    assert_eq!(open_count.load(Ordering::SeqCst), 1);

    assert_eq!(
        agent_runtime_transition_apply::apply(&state, "explicit-target", body.clone())
            .await
            .unwrap_err()
            .code,
        "fixture_target_start_failed"
    );
    let predecessor = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    let successor_id = predecessor.superseded_by_operation_id.unwrap();
    let successor = state
        .store
        .agent_runtime_transition(&successor_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        successor.predecessor_operation_id.as_ref(),
        Some(&operation_id)
    );
    assert_eq!(
        successor.intent.provider_conversation_ref,
        parked.intent.provider_conversation_ref
    );
    assert_eq!(
        successor.intent.source_authority,
        parked.intent.source_authority
    );
    assert_eq!(
        successor.state,
        AgentRuntimeTransitionStateV1::SourceStopped
    );
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(open_count.load(Ordering::SeqCst), 2);

    assert_eq!(
        agent_runtime_transition_apply::apply(&state, "explicit-target", body.clone())
            .await
            .unwrap_err()
            .code,
        "agent_runtime_repair_in_progress"
    );
    assert_eq!(
        open_count.load(Ordering::SeqCst),
        2,
        "response replay must not launch again"
    );
    assert!(matches!(
        agent_runtime_transition_apply::drive_locked(&state, successor)
            .await
            .unwrap(),
        agent_runtime_transition_apply::TransitionDriveOutcome::Committed(_)
    ));
    agent_runtime_transition_apply::apply(&state, "explicit-target", body)
        .await
        .unwrap();
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(open_count.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn stale_discard_revision_is_rejected_before_source_stop() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    let agent_id = AgentIdV1::new("stale-discard-agent").unwrap();
    let provider_id = ProviderIdV1::new("codex").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: provider_id.clone(),
            display_name: "Stale discard agent".into(),
            created_at_ms: 1,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    let (source, _) =
        initialize_structured_source_for_provider(&state, agent_id, provider_id).await;
    let stop_count = Arc::new(AtomicUsize::new(0));
    let attach_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            source.provider_id.clone(),
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
    state.agent_providers =
        Arc::new(provider_extension::test_codex_structured_agent_provider_registry());
    let target_launch_selection = Some(dure_app::AgentRuntimeLaunchSelectionV1 {
        model: Some(dure_app::AgentSpawnModelSelectionV1::parse("gpt-5.6-sol").unwrap()),
        effort: None,
        permission_mode: None,
    });
    let discard_request = |expected_source_revision| {
        agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
            schema_version: 1,
            agent_id: source.agent_id.clone(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            expected_source_revision,
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Discard,
            target_execution_profile: None,
            target_launch_selection: target_launch_selection.clone(),
        }
    };

    let legacy_error = agent_runtime_transition_apply::apply(
        &state,
        "discard-without-revision",
        discard_request(None),
    )
    .await
    .unwrap_err();
    assert_eq!(
        legacy_error.code,
        "agent_runtime_transition_request_invalid"
    );
    assert_eq!(stop_count.load(Ordering::SeqCst), 0);

    let error = agent_runtime_transition_apply::apply(
        &state,
        "stale-discard-revision",
        discard_request(Some(source.revision + 1)),
    )
    .await
    .unwrap_err();

    assert_eq!(stop_count.load(Ordering::SeqCst), 0);
    assert_eq!(attach_count.load(Ordering::SeqCst), 0);
    assert_eq!(error.code, "agent_runtime_transition_conflict");
    assert!(
        state
            .store
            .active_agent_runtime_transition(&source.agent_id)
            .await
            .unwrap()
            .is_none(),
        "stale discard consent must not admit a durable transition"
    );

    let exact_stop_count = Arc::new(AtomicUsize::new(0));
    let open_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            source.provider_id.clone(),
            Arc::new(RepairableReplacementRuntime {
                store: Arc::clone(&state.store),
                stop_count: Arc::clone(&exact_stop_count),
                open_count: Arc::clone(&open_count),
                first_failure_kind:
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::CredentialUnavailable,
                second_failure_kind: None,
                succeed_on_retry: false,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);

    let matching_error = agent_runtime_transition_apply::apply(
        &state,
        "matching-discard-revision",
        discard_request(Some(source.revision)),
    )
    .await
    .unwrap_err();
    assert_eq!(matching_error.code, "agent_runtime_repair_required");
    assert_eq!(exact_stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(open_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn source_busy_transition_recovery_durably_retains_source_after_one_exact_attempt() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let (agent_id, provider_id) = admit_structured_to_native_transition(&state).await;
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
    let operation_id = OperationIdV1::new("transition-retained-source").unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let transition = state
                .store
                .agent_runtime_transition(&operation_id)
                .await
                .unwrap()
                .unwrap();
            if transition.state == AgentRuntimeTransitionStateV1::SourceRetained
                && attach_count.load(Ordering::SeqCst) == 1
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("recovery must durably retain the selected source");
    state.agent_runtime_recovery_wake.notify_one();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        stop_count.load(Ordering::SeqCst),
        1,
        "recovery must not poll a source that retained control"
    );
    assert_eq!(
        attach_count.load(Ordering::SeqCst),
        1,
        "recovery must restore the retained structured source before sleeping"
    );
    let transition = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(&transition).unwrap()["state"],
        "source_retained",
        "the durable journal, not a worker-local outcome, owns the retained source"
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
    let observation = serde_json::to_value(observation).unwrap();
    assert_eq!(
        observation["state"], "stable",
        "a retained source must route as the stable selected runtime"
    );
    assert_eq!(
        observation["receipt"]["selectionRevision"], 1,
        "stable inspection must expose the durable selection CAS revision"
    );
    assert!(
        observation.get("projectionContext").is_none(),
        "legacy Stable inspect V1 must keep its exact wire shape"
    );
    let projection = agent_runtime_transition_apply::inspect_projection(
        &state,
        agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 {
            schema_version: 1,
            agent_id: AgentIdV1::new("coordinator-1").unwrap(),
        },
    )
    .await
    .unwrap();
    let projection = serde_json::to_value(projection).unwrap();
    assert_eq!(
        projection["projectionContext"]["agent"]["agentId"],
        "coordinator-1"
    );
    assert_eq!(
        projection["projectionContext"]["identity"]["kind"],
        "registered"
    );
    assert_eq!(
        projection["projectionContext"]["agent"]["workspaceId"],
        "workspace-1"
    );
    assert_eq!(
        projection["projectionContext"]["workspace"]["projectId"],
        "project-1"
    );
    assert_eq!(
        projection["projectionContext"]["project"]["rootPath"],
        projection["projectionContext"]["workspace"]["rootPath"]
    );
    recovery.abort();
    let _ = recovery.await;
}

#[tokio::test]
async fn permanent_target_failure_parks_the_stopped_transition_across_recovery_restarts() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let (agent_id, provider_id, operation_id) =
        admit_structured_credential_transition(&state).await;
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
                second_failure_kind: None,
                succeed_on_retry: false,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);

    let state = Arc::new(state);
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&state)));
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let transition = state
                .store
                .agent_runtime_transition(&operation_id)
                .await
                .unwrap()
                .unwrap();
            if serde_json::to_value(&transition).unwrap()["state"] == "repair_required"
                || open_count.load(Ordering::SeqCst) >= 2
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the failed target start must reach a durable terminal posture");

    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        open_count.load(Ordering::SeqCst),
        1,
        "automatic recovery must not repeat a permanent target-start effect"
    );
    let transition = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(&transition).unwrap()["state"],
        "repair_required"
    );
    let observation = agent_runtime_transition_apply::inspect(
        &state,
        agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
        },
    )
    .await
    .unwrap();
    let observation = serde_json::to_value(observation).unwrap();
    assert_eq!(observation["stage"], "repair_required");
    assert!(
        observation.get("projectionContext").is_none(),
        "legacy Transitioning inspect V1 must keep its exact wire shape"
    );
    assert!(
        observation.get("sourceSelectionRevision").is_none()
            && observation.get("sourceLaunchSelection").is_none()
            && observation.get("targetLaunchSelection").is_none(),
        "the versioned repair-intent projection must not extend inspect V1"
    );
    let repair_intent = agent_runtime_transition_apply::inspect_repair_intent(
        &state,
        agent_runtime_transition_apply::AgentRuntimeRepairIntentInspectBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            operation_id: operation_id.clone(),
            expected_journal_revision: transition.journal_revision,
        },
    )
    .await
    .unwrap();
    let repair_intent = serde_json::to_value(repair_intent).unwrap();
    assert_eq!(repair_intent["state"], "repair_required");
    assert_eq!(repair_intent["sourceSelectionRevision"], 1);
    assert_eq!(
        repair_intent["sourceInteractionProfile"],
        "structured_protocol"
    );
    assert_eq!(repair_intent["targetFailure"], observation["targetFailure"]);
    assert_eq!(
        repair_intent["sourceLaunchSelection"]["permissionMode"],
        "default"
    );
    assert_eq!(
        repair_intent["targetLaunchSelection"]["permissionMode"],
        "default"
    );
    let projection = agent_runtime_transition_apply::inspect_projection(
        &state,
        agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 {
            schema_version: 1,
            agent_id,
        },
    )
    .await
    .unwrap();
    let projection = serde_json::to_value(projection).unwrap();
    assert_eq!(projection["stage"], "repair_required");
    assert_eq!(
        projection["projectionContext"]["identity"]["kind"],
        "registered"
    );

    recovery.abort();
    let _ = recovery.await;
    let database = root.path().join("domain.sqlite");
    let (mut reopened, launcher) = reopen_fixture_service_state(&state, &database).await;
    drop(state);
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            ProviderIdV1::new("provider.codex").unwrap(),
            Arc::new(RepairableReplacementRuntime {
                store: Arc::clone(&reopened.store),
                stop_count: Arc::clone(&stop_count),
                open_count: Arc::clone(&open_count),
                first_failure_kind:
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::CredentialUnavailable,
                second_failure_kind: None,
                succeed_on_retry: false,
            }),
        )
        .unwrap();
    reopened.structured_runtimes = Arc::new(runtimes);
    let reopened = Arc::new(reopened);
    let restarted = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&reopened)));
    reopened.agent_runtime_recovery_wake.notify_one();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        open_count.load(Ordering::SeqCst),
        1,
        "service restart must not turn repair-required into an implicit retry"
    );
    assert!(
        launcher.requests().is_empty(),
        "a reconstructed ServiceState must not launch a fallback native runtime"
    );
    restarted.abort();
    let _ = restarted.await;
}

#[tokio::test]
async fn transient_target_failure_remains_recoverable_after_control_plane_restart() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let (agent_id, provider_id, operation_id) =
        admit_structured_credential_transition(&state).await;
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
                first_failure_kind:
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
                second_failure_kind: None,
                succeed_on_retry: true,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);

    let admitted = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        agent_runtime_transition_apply::drive_locked(&state, admitted)
            .await
            .unwrap_err(),
        "fixture_target_start_failed"
    );
    assert_eq!(
        state
            .store
            .agent_runtime_transition(&operation_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::SourceStopped,
        "transient failure must remain eligible for automatic recovery"
    );

    let state = Arc::new(state);
    let restarted = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&state)));
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
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
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("restart recovery must retry the same durable target intent");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(open_count.load(Ordering::SeqCst), 2);
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .selected_by_operation_id,
        Some(operation_id)
    );
    restarted.abort();
    let _ = restarted.await;
}

#[tokio::test]
async fn exact_repair_replay_never_authorizes_a_second_target_effect_before_commit() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    let (agent_id, provider_id, operation_id) =
        admit_structured_credential_transition(&state).await;
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
                second_failure_kind: Some(
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
                ),
                succeed_on_retry: true,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);

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
        agent_runtime_transition_apply::TransitionDriveOutcome::RepairRequired
    ));
    let parked = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(parked.state, AgentRuntimeTransitionStateV1::RepairRequired);
    assert_eq!(
        parked.target_failure.as_ref().unwrap().kind,
        dure_app::AgentRuntimeTargetFailureKindV1::CredentialUnavailable
    );

    let body = agent_runtime_transition_apply::AgentRuntimeRepairApplyBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        operation_id: operation_id.clone(),
        expected_journal_revision: parked.journal_revision,
        action: agent_runtime_transition_apply::AgentRuntimeRepairActionV1::Retry,
    };
    assert_eq!(
        agent_runtime_transition_apply::repair(&state, "repair-attempt-1", body.clone())
            .await
            .unwrap_err()
            .code,
        "fixture_target_start_failed"
    );
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(open_count.load(Ordering::SeqCst), 2);
    let authorized = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        authorized.state,
        AgentRuntimeTransitionStateV1::SourceStopped
    );

    assert_eq!(
        agent_runtime_transition_apply::repair(&state, "repair-attempt-1", body.clone())
            .await
            .unwrap_err()
            .code,
        "agent_runtime_repair_in_progress"
    );
    assert_eq!(
        open_count.load(Ordering::SeqCst),
        2,
        "transport replay cannot invoke the target adapter again"
    );

    assert!(matches!(
        agent_runtime_transition_apply::drive_locked(&state, authorized)
            .await
            .unwrap(),
        agent_runtime_transition_apply::TransitionDriveOutcome::Committed(_)
    ));
    let committed = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    let selected = state
        .store
        .agent_runtime_selection(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        selected.execution_profile,
        committed.intent.target_execution_profile
    );
    assert_eq!(
        state
            .store
            .agent_interaction_for_agent(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .execution_profile,
        selected.execution_profile
    );

    agent_runtime_transition_apply::repair(&state, "repair-attempt-1", body)
        .await
        .unwrap();
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        open_count.load(Ordering::SeqCst),
        3,
        "transport replay must not consume a second repair authorization"
    );
}

#[tokio::test]
async fn supersede_replay_never_authorizes_a_second_successor_effect_before_commit() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    state.agent_providers =
        Arc::new(provider_extension::test_codex_structured_agent_provider_registry());
    let (agent_id, provider_id, operation_id) =
        admit_structured_credential_transition(&state).await;
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
                second_failure_kind: Some(
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
                ),
                succeed_on_retry: true,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
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
        agent_runtime_transition_apply::TransitionDriveOutcome::RepairRequired
    ));
    let parked = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    let action = agent_runtime_transition_apply::AgentRuntimeRepairActionV1::Supersede {
        target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        target_execution_profile: None,
        target_launch_selection: Some(dure_app::AgentRuntimeLaunchSelectionV1 {
            model: Some(dure_app::AgentSpawnModelSelectionV1::parse("gpt-5.6-sol").unwrap()),
            effort: None,
            permission_mode: None,
        }),
    };
    let body = agent_runtime_transition_apply::AgentRuntimeRepairApplyBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        operation_id: operation_id.clone(),
        expected_journal_revision: parked.journal_revision,
        action,
    };

    assert_eq!(
        agent_runtime_transition_apply::repair(&state, "supersede-attempt-1", body.clone())
            .await
            .unwrap_err()
            .code,
        "fixture_target_start_failed"
    );
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(open_count.load(Ordering::SeqCst), 2);
    let superseded = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(superseded.state, AgentRuntimeTransitionStateV1::Superseded);
    assert!(superseded.target_failure.is_some());
    let successor_id = superseded.superseded_by_operation_id.clone().unwrap();
    let successor = state
        .store
        .agent_runtime_transition(&successor_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        successor.state,
        AgentRuntimeTransitionStateV1::SourceStopped
    );
    assert_eq!(
        successor.predecessor_operation_id.as_ref(),
        Some(&operation_id)
    );
    assert_eq!(
        agent_runtime_transition_apply::repair(&state, "supersede-attempt-1", body.clone())
            .await
            .unwrap_err()
            .code,
        "agent_runtime_repair_in_progress"
    );
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        open_count.load(Ordering::SeqCst),
        2,
        "supersede replay cannot invoke the successor adapter again"
    );

    assert!(matches!(
        agent_runtime_transition_apply::drive_locked(&state, successor)
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
            .model
            .unwrap()
            .as_str(),
        "gpt-5.6-sol"
    );
    assert!(
        state
            .store
            .active_agent_runtime_transition(&agent_id)
            .await
            .unwrap()
            .is_none()
    );

    agent_runtime_transition_apply::repair(&state, "supersede-attempt-1", body)
        .await
        .unwrap();
    assert_eq!(open_count.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn native_failure_after_structured_retirement_moves_the_returned_tombstone_to_the_next_successor()
 {
    let (_root, mut state, launcher, _) = fixture(vec![LaunchOutcome::Reject(
        "fixture_native_target_rejected",
    )])
    .await;
    state.agent_providers =
        Arc::new(provider_extension::test_codex_structured_agent_provider_registry());
    let (agent_id, provider_id, operation_id) =
        admit_structured_credential_transition(&state).await;
    let open_count = Arc::new(AtomicUsize::new(0));
    let retire_count = Arc::new(AtomicUsize::new(0));
    let observed_replacement_authorities = Arc::new(StdMutex::new(Vec::new()));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(ReplacementLineageRuntime {
                store: Arc::clone(&state.store),
                open_count: Arc::clone(&open_count),
                retire_count: Arc::clone(&retire_count),
                observed_replacement_authorities: Arc::clone(&observed_replacement_authorities),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);

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
        agent_runtime_transition_apply::TransitionDriveOutcome::RepairRequired
    ));
    let failed_structured = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    let failed_b = match &failed_structured
        .replacement_authority
        .as_ref()
        .expect("provider mutation must publish the exact failed target")
        .0
    {
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => binding.clone(),
        AgentRuntimeBindingAuthorityV1::NativeCli { .. } => {
            panic!("failed target B must remain a structured fence")
        }
    };
    assert_eq!(failed_b.runtime.runtime_generation, "runtime-failed-b");

    let restore_native = agent_runtime_transition_apply::AgentRuntimeRepairApplyBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        operation_id: operation_id.clone(),
        expected_journal_revision: failed_structured.journal_revision,
        action: agent_runtime_transition_apply::AgentRuntimeRepairActionV1::Supersede {
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            target_execution_profile: Some(AgentExecutionProfileV1::ProviderDefault),
            target_launch_selection: None,
        },
    };
    assert_eq!(
        agent_runtime_transition_apply::repair(&state, "lineage-native-supersede", restore_native,)
            .await
            .unwrap_err()
            .code,
        "agent_runtime_repair_required"
    );
    let failed_structured = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert!(failed_structured.replacement_authority.is_none());
    let native_operation_id = failed_structured.superseded_by_operation_id.unwrap();
    let failed_native = state
        .store
        .agent_runtime_transition(&native_operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        failed_native.state,
        AgentRuntimeTransitionStateV1::RepairRequired
    );
    let tombstone_c = match &failed_native
        .replacement_authority
        .as_ref()
        .expect("native failure must replace B with the returned tombstone C")
        .0
    {
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => binding.clone(),
        AgentRuntimeBindingAuthorityV1::NativeCli { .. } => {
            panic!("retired tombstone C must remain a structured exact fence")
        }
    };
    assert_eq!(
        tombstone_c.runtime.runtime_generation,
        "runtime-tombstone-c"
    );
    assert_eq!(
        tombstone_c.execution_profile,
        AgentExecutionProfileV1::ProviderDefault,
        "the tombstone must use the Native successor's immutable profile"
    );
    assert_eq!(launcher.requests().len(), 1);
    assert_eq!(retire_count.load(Ordering::SeqCst), 1);

    let corrected_structured = agent_runtime_transition_apply::AgentRuntimeRepairApplyBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        operation_id: native_operation_id.clone(),
        expected_journal_revision: failed_native.journal_revision,
        action: agent_runtime_transition_apply::AgentRuntimeRepairActionV1::Supersede {
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: Some(AgentExecutionProfileV1::ProviderDefault),
            target_launch_selection: None,
        },
    };
    agent_runtime_transition_apply::repair(
        &state,
        "lineage-structured-supersede",
        corrected_structured,
    )
    .await
    .unwrap();
    let corrected_d = state
        .store
        .agent_interaction_for_agent(&agent_id)
        .await
        .unwrap()
        .expect("the corrected successor must commit one structured binding");
    assert_eq!(
        corrected_d.runtime.runtime_generation,
        "runtime-corrected-d"
    );
    assert_eq!(open_count.load(Ordering::SeqCst), 2);
    assert_eq!(retire_count.load(Ordering::SeqCst), 1);
    let observed = observed_replacement_authorities.lock().unwrap().clone();
    assert_eq!(observed.len(), 2);
    assert_eq!(
        observed[0].0,
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: failed_b }
    );
    assert_eq!(
        observed[1].0,
        AgentRuntimeBindingAuthorityV1::StructuredProtocol {
            binding: tombstone_c,
        }
    );
    let failed_native = state
        .store
        .agent_runtime_transition(&native_operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        failed_native.state,
        AgentRuntimeTransitionStateV1::Superseded
    );
    assert!(failed_native.replacement_authority.is_none());
}

/// Red-first contract for the admitted escape hatch: repair(Retry) on an
/// admitted transition drives it in place and returns the drive's real
/// failure instead of a generic conflict - the only API-reachable exit for
/// a transition whose recovery drives fail invisibly.
#[tokio::test]
async fn repair_retry_drives_an_admitted_transition_and_surfaces_the_drive_error() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let (agent_id, provider_id, operation_id) =
        admit_structured_credential_transition(&state).await;
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
                first_failure_kind:
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
                second_failure_kind: None,
                succeed_on_retry: true,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);

    let outcome = agent_runtime_transition_apply::repair(
        &state,
        "repair-admitted-attempt-1",
        agent_runtime_transition_apply::AgentRuntimeRepairApplyBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            operation_id: operation_id.clone(),
            expected_journal_revision: 1,
            action: agent_runtime_transition_apply::AgentRuntimeRepairActionV1::Retry,
        },
    )
    .await
    .unwrap_err();
    // The drive really ran: the fixture's transient target failure comes back
    // verbatim (never the pre-drive repair_conflict), and the transition
    // advanced out of 'admitted'.
    assert_eq!(outcome.code, "fixture_target_start_failed");
    assert_eq!(stop_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        state
            .store
            .agent_runtime_transition(&operation_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::SourceStopped,
    );
}
