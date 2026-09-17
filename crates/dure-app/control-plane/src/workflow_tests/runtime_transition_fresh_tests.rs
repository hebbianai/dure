use super::*;

struct FreshAllocatingReplacementRuntime {
    store: Arc<SqliteDomainStore>,
    open_count: Arc<AtomicUsize>,
}

impl structured_provider_runtime::StructuredProviderRuntime for FreshAllocatingReplacementRuntime {
    fn open(
        &self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1>
    {
        Box::pin(async {
            Err(structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
                "fresh_fixture_open_unavailable",
            ))
        })
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
        request: structured_provider_runtime::StructuredProviderOpenRequestV1,
        transition: &'a AgentRuntimeTransitionRecordV1,
        _provider_state_environment: hmux_client::ProviderStateEnvironment,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        let attempt = self.open_count.fetch_add(1, Ordering::SeqCst);
        let store = Arc::clone(&self.store);
        let replacement_source = transition.replacement_authority.clone();
        let provider_id = transition.intent.source.provider_id.clone();
        Box::pin(async move {
            if attempt == 0 {
                assert!(request.provider_conversation_ref.is_none());
                assert!(replacement_source.is_none());
                let binding = AgentInteractionBindingV1 {
                    schema_version: 1,
                    interaction_session_id: AgentInteractionSessionIdV1::new(
                        "fresh-allocated-interaction",
                    )
                    .unwrap(),
                    agent_id: request.agent_id,
                    provider_id,
                    execution_profile: request.execution_profile,
                    provider_conversation_ref: Some("fresh-allocated-conversation".into()),
                    runtime: AgentProviderRuntimeFenceV1 {
                        runtime_generation: "fresh-failed-runtime".into(),
                        provider_epoch: "fresh-failed-provider".into(),
                    },
                    timeline_epoch: AgentTimelineEpochV1::new("fresh-allocated-timeline").unwrap(),
                    binding_revision: 1,
                    history_complete: true,
                    created_at_ms: 30,
                    updated_at_ms: 30,
                };
                store.create_agent_interaction(&binding).await.map_err(|_| {
                    structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                        structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeConflict,
                        "fresh_fixture_binding_create_failed",
                    )
                })?;
                return Err(
                    structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                        structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::ExplicitRecoveryRequired,
                        "fresh_fixture_target_recovery_required",
                    )
                    .with_failed_binding(binding),
                );
            }

            let Some(dure_app::AgentRuntimeReplacementAuthorityV1(
                AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: source },
            )) = replacement_source
            else {
                panic!("the corrected successor must own the exact failed Fresh target")
            };
            assert_eq!(
                source.provider_conversation_ref.as_deref(),
                Some("fresh-allocated-conversation")
            );
            store
                .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
                    schema_version: 1,
                    interaction_session_id: source.interaction_session_id.clone(),
                    expected_binding_revision: source.binding_revision,
                    source: source.runtime.clone(),
                    source_execution_profile: source.execution_profile.clone(),
                    target: AgentProviderRuntimeFenceV1 {
                        runtime_generation: "fresh-corrected-runtime".into(),
                        provider_epoch: "fresh-corrected-provider".into(),
                    },
                    target_execution_profile: request.execution_profile,
                    provider_conversation_ref: source.provider_conversation_ref,
                    replaced_at_ms: 40,
                })
                .await
                .map_err(|_| {
                    structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                        structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeConflict,
                        "fresh_fixture_binding_replace_failed",
                    )
                })
        })
    }

    fn stop_replacement_source<'a>(
        &'a self,
        _transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn retire_replacement_source<'a>(
        &'a self,
        _transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<
        'a,
        dure_app::AgentRuntimeReplacementAuthorityV1,
    > {
        Box::pin(async {
            Err(structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
                "fresh_fixture_retire_unavailable",
            ))
        })
    }

    fn stop_current<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

fn framed(value: &impl serde::Serialize) -> Vec<u8> {
    let payload = serde_json::to_vec(value).unwrap();
    let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(&payload);
    frame
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MissingIdentityScenario {
    Fresh,
    CompletedBeforeAdmission,
    CompletedAfterAdmission,
    WorkingBeforeAdmission,
    ExitedBeforeAdmission,
}

async fn exercise_no_recipe_native_source(
    scenario: MissingIdentityScenario,
    source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1,
) {
    let initial_turn_completed_count = match scenario {
        MissingIdentityScenario::CompletedBeforeAdmission => "1",
        MissingIdentityScenario::Fresh
        | MissingIdentityScenario::CompletedAfterAdmission
        | MissingIdentityScenario::WorkingBeforeAdmission
        | MissingIdentityScenario::ExitedBeforeAdmission => "0",
    };
    let initial_activity = match scenario {
        MissingIdentityScenario::WorkingBeforeAdmission => "working",
        _ => "waiting",
    };
    let agent_id = AgentIdV1::new("fresh-agent-1").unwrap();
    let provider_id = ProviderIdV1::new("codex").unwrap();
    let (root, mut state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            agent_id: agent_id.clone(),
            agent_provider_id: provider_id.clone(),
            include_rehost_recipe: false,
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    state
        .store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            provider_id: provider_id.clone(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 10,
        })
        .await
        .unwrap();

    let source_exited = scenario == MissingIdentityScenario::ExitedBeforeAdmission;
    let runtime_state = json!({
        "terminal_epoch": "coordinator-terminal",
        "revision": "1",
        "observed_through_output_seq": "0",
        "lifecycle": if source_exited { "exited" } else { "running" },
        "activity": initial_activity,
        "attention": "none",
        "attention_id": null,
        "turn_completed_count": initial_turn_completed_count
    });
    let inspection = json!({
        "schema_version": 1,
        "session_id": "coordinator-session",
        "workspace_id": "coordinator-workspace",
        "session_class": "managed",
        "lifecycle": if source_exited { "exited" } else { "ready" },
        "provider_id": "codex",
        "runner_principal": "coordinator-runner",
        "runner_instance": "coordinator-instance",
        "channel_epoch": "1",
        "host_instance_id": "coordinator-host",
        "terminal_epoch": "coordinator-terminal",
        "output_seq": "0",
        "health": if source_exited { "exited" } else { "healthy" },
        "agentRuntimeState": runtime_state,
        "providerConversationIdentity": null
    });
    let hmux = state.hmux_identity.executable_path.clone();
    let inspection_script = if scenario == MissingIdentityScenario::CompletedAfterAdmission {
        let inspection_calls = root.path().join("fresh-inspection-called");
        let mut completed = inspection.clone();
        completed["agentRuntimeState"]["turn_completed_count"] = json!("1");
        format!(
            "#!/bin/sh\nif [ -f '{}' ]; then printf '%s' '{}'; else : > '{}'; printf '%s' '{}'; fi\n",
            inspection_calls.display(),
            completed,
            inspection_calls.display(),
            inspection,
        )
    } else {
        format!("#!/bin/sh\nprintf '%s' '{}'\n", inspection)
    };
    fs::write(&hmux, inspection_script).unwrap();
    fs::set_permissions(&hmux, fs::Permissions::from_mode(0o700)).unwrap();

    let attempt_id = "fresh-native-to-structured";
    let (operation_id, _) =
        agent_runtime_transition_apply::runtime_transition_identity(attempt_id).unwrap();
    let stop_request = ManagedStopRequest::new(
        agent_runtime_transition_apply::quiescent_stop_identity(&operation_id, 1, 0),
        "coordinator-session",
        "coordinator-workspace",
    )
    .unwrap()
    .with_expected_fence(
        "coordinator-runner",
        "coordinator-instance",
        1,
        "coordinator-host",
        "coordinator-terminal",
    )
    .unwrap()
    .with_expected_conversation(ManagedStopConversationFence::new("codex", None).unwrap())
    .unwrap()
    .with_expected_quiescence(
        ManagedStopQuiescenceFence::new("coordinator-terminal", 1, 0).unwrap(),
    )
    .unwrap();
    let reconcile_path = root.path().join("fresh-stop-reconcile.bin");
    fs::write(
        &reconcile_path,
        framed(&ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_intent_not_found",
            "fresh fixture has no prior stop",
        )),
    )
    .unwrap();
    let stopped_path = root.path().join("fresh-stop-completed.bin");
    fs::write(
        &stopped_path,
        framed(&ManagedStopBrokerResponse::Completed(Box::new(
            ManagedStopReceipt::from_request(
                &stop_request,
                ManagedStopOutcome::Stopped,
                "fresh fixture exact source stopped",
            )
            .unwrap(),
        ))),
    )
    .unwrap();
    let stop_calls = root.path().join("fresh-stop-calls");
    let hmux_runtime = state.hmux_identity.runtime_executable_path.clone();
    fs::write(
        &hmux_runtime,
        format!(
            "#!/bin/sh\ncase \"${{2:-}}\" in\n  {MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}) cat '{}';;\n  {MANAGED_STOP_BROKER_SUBCOMMAND}) printf x >> '{}'; cat '{}';;\n  *) exit 64;;\nesac\n",
            reconcile_path.display(),
            stop_calls.display(),
            stopped_path.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&hmux_runtime, fs::Permissions::from_mode(0o700)).unwrap();
    state.hmux_identity =
        resolve_hmux_toolchain_identity(&hmux, &hmux_runtime, &state.hmux_identity.discovery_root)
            .unwrap();
    make_fixture_mutation_authority(&mut state);
    state.agent_providers =
        Arc::new(provider_extension::test_codex_structured_agent_provider_registry());
    let open_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id.clone(),
            Arc::new(FreshAllocatingReplacementRuntime {
                store: Arc::clone(&state.store),
                open_count: Arc::clone(&open_count),
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);

    let selection_before = state
        .store
        .agent_runtime_selection(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let authority_before = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let discard_requested = source_stop_policy == dure_app::AgentRuntimeSourceStopPolicyV1::Discard;
    let result = agent_runtime_transition_apply::apply(
        &state,
        attempt_id,
        agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            expected_source_revision: discard_requested.then_some(1),
            source_stop_policy,
            target_execution_profile: None,
            target_launch_selection: None,
        },
    )
    .await;
    let rejected_before_admission = matches!(
        scenario,
        MissingIdentityScenario::CompletedBeforeAdmission
            | MissingIdentityScenario::WorkingBeforeAdmission
            | MissingIdentityScenario::ExitedBeforeAdmission
    ) || (scenario == MissingIdentityScenario::Fresh
        && discard_requested);
    if rejected_before_admission {
        let error = result.as_ref().unwrap_err();
        assert_eq!(
            error.code,
            "agent_runtime_provider_conversation_unavailable"
        );
        assert_eq!(
            error.disposition,
            if source_exited {
                BackendFailureDispositionV1::Terminal
            } else {
                BackendFailureDispositionV1::RetrySame
            }
        );
        assert!(
            state
                .store
                .agent_runtime_transition(&operation_id)
                .await
                .unwrap()
                .is_none()
        );
    } else if scenario == MissingIdentityScenario::CompletedAfterAdmission {
        let error = result.as_ref().unwrap_err();
        assert_eq!(error.code, "agent_runtime_source_retained");
        assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
        assert_eq!(
            state
                .store
                .agent_runtime_transition(&operation_id)
                .await
                .unwrap()
                .unwrap()
                .state,
            AgentRuntimeTransitionStateV1::SourceRetained
        );
    }
    if rejected_before_admission || scenario == MissingIdentityScenario::CompletedAfterAdmission {
        assert!(!stop_calls.exists());
        assert_eq!(open_count.load(Ordering::SeqCst), 0);
        assert_eq!(
            state
                .store
                .agent_runtime_selection(&agent_id)
                .await
                .unwrap()
                .unwrap(),
            selection_before
        );
        assert_eq!(
            state
                .store
                .agent_checkpoint_binding_authority(&agent_id)
                .await
                .unwrap()
                .unwrap(),
            authority_before
        );
        return;
    }

    let error = result.unwrap_err();
    assert_eq!(error.code, "agent_runtime_repair_required");
    assert_eq!(fs::read(&stop_calls).unwrap(), b"x");
    assert_eq!(open_count.load(Ordering::SeqCst), 1);
    let parked = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(parked.state, AgentRuntimeTransitionStateV1::RepairRequired);
    assert!(
        parked
            .intent
            .provider_conversation_ref
            .as_option()
            .is_none()
    );
    let failed_binding = match &parked
        .replacement_authority
        .as_ref()
        .expect("the failed Fresh target must publish its allocated identity")
        .0
    {
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => binding,
        AgentRuntimeBindingAuthorityV1::NativeCli { .. } => panic!("expected structured target"),
    };
    assert_eq!(
        failed_binding.provider_conversation_ref.as_deref(),
        Some("fresh-allocated-conversation")
    );

    let database = root.path().join("domain.sqlite");
    let (mut restarted, launcher) = reopen_fixture_service_state(&state, &database).await;
    drop(state);
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(FreshAllocatingReplacementRuntime {
                store: Arc::clone(&restarted.store),
                open_count: Arc::clone(&open_count),
            }),
        )
        .unwrap();
    restarted.structured_runtimes = Arc::new(runtimes);
    let restarted = Arc::new(restarted);
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&restarted)));
    restarted.agent_runtime_recovery_wake.notify_one();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(
        open_count.load(Ordering::SeqCst),
        1,
        "a fresh ServiceState must leave RepairRequired quiescent"
    );
    assert!(launcher.requests().is_empty());
    recovery.abort();
    let _ = recovery.await;

    let parked = restarted
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    agent_runtime_transition_apply::repair(
        &restarted,
        "fresh-corrected-supersede",
        agent_runtime_transition_apply::AgentRuntimeRepairApplyBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            operation_id,
            expected_journal_revision: parked.journal_revision,
            action: agent_runtime_transition_apply::AgentRuntimeRepairActionV1::Supersede {
                target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
                target_execution_profile: None,
                target_launch_selection: Some(dure_app::AgentRuntimeLaunchSelectionV1 {
                    model: Some(
                        dure_app::AgentSpawnModelSelectionV1::parse("gpt-5.6-sol").unwrap(),
                    ),
                    effort: None,
                    permission_mode: None,
                }),
            },
        },
    )
    .await
    .unwrap();
    assert_eq!(open_count.load(Ordering::SeqCst), 2);
    let current = restarted
        .store
        .agent_interaction_for_agent(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        current.runtime.runtime_generation,
        "fresh-corrected-runtime"
    );
    assert_eq!(
        current.provider_conversation_ref.as_deref(),
        Some("fresh-allocated-conversation"),
        "the corrected successor must resume, not fork, the allocated identity"
    );
    assert_eq!(
        restarted
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .interaction_profile,
        AgentInteractionProfileV1::StructuredProtocol
    );
}

#[tokio::test]
async fn fresh_no_recipe_native_source_keeps_an_allocated_failed_target_across_a_real_restart() {
    exercise_no_recipe_native_source(
        MissingIdentityScenario::Fresh,
        dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
    )
    .await;
}

#[tokio::test]
async fn completed_no_recipe_native_source_waits_for_provider_conversation_identity() {
    exercise_no_recipe_native_source(
        MissingIdentityScenario::CompletedBeforeAdmission,
        dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
    )
    .await;
}

#[tokio::test]
async fn completion_after_fresh_admission_retains_the_native_source() {
    exercise_no_recipe_native_source(
        MissingIdentityScenario::CompletedAfterAdmission,
        dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
    )
    .await;
}

#[tokio::test]
async fn identity_unknown_working_source_cannot_be_discarded_as_fresh() {
    exercise_no_recipe_native_source(
        MissingIdentityScenario::WorkingBeforeAdmission,
        dure_app::AgentRuntimeSourceStopPolicyV1::Discard,
    )
    .await;
}

#[tokio::test]
async fn identity_unknown_idle_source_requires_the_fenced_preserve_path() {
    exercise_no_recipe_native_source(
        MissingIdentityScenario::Fresh,
        dure_app::AgentRuntimeSourceStopPolicyV1::Discard,
    )
    .await;
}

#[tokio::test]
async fn exited_identity_unknown_source_is_terminal_without_mutating_the_selection() {
    exercise_no_recipe_native_source(
        MissingIdentityScenario::ExitedBeforeAdmission,
        dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
    )
    .await;
}
