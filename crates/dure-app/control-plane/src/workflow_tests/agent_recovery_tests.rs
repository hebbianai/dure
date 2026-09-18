use super::*;
use crate::agent_conversation::{
    AgentConversationService, AgentProviderCommandFuture, AgentProviderCommands,
};
use crate::agent_conversation_api::{AgentConversationApi, AgentConversationRuntimeRegistry};
use crate::structured_provider_runtime::{
    StructuredProviderOpenRequestV1, StructuredProviderRuntime, StructuredProviderRuntimeFuture,
};
use dure_app::{
    AgentQueuedTurnStore, AgentRecoveryStore, AgentStartTurnIntentV1, AgentTimelineStore,
    ProviderRecoveryAccountV1, ProviderRecoveryPolicyPutV1, ProviderRecoveryStore,
};

#[derive(Default)]
struct RecoveryCommands {
    inputs: StdMutex<Vec<AgentStartTurnIntentV1>>,
    observed: Notify,
}

impl AgentProviderCommands for RecoveryCommands {
    fn start_turn<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
        intent: &'a AgentStartTurnIntentV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async move {
            self.inputs.lock().unwrap().push(intent.clone());
            self.observed.notify_one();
            Ok(json!({"accepted": true}))
        })
    }
    fn answer_pending<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
        _: &'a dure_app::AgentPendingAnswerIntentV1,
        _: &'a dure_app::AgentPendingRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async { unreachable!() })
    }
    fn interrupt_turn<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
        _: &'a dure_app::AgentInterruptTurnRequestV1,
    ) -> AgentProviderCommandFuture<'a> {
        Box::pin(async { unreachable!() })
    }
}

struct RecoveryRuntime {
    store: Arc<SqliteDomainStore>,
    registry: Arc<AgentConversationRuntimeRegistry>,
    commands: Arc<RecoveryCommands>,
    stops: AtomicUsize,
    opens: AtomicUsize,
    fail: bool,
}

impl StructuredProviderRuntime for RecoveryRuntime {
    fn open(
        &self,
        _: StructuredProviderOpenRequestV1,
    ) -> StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1> {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }
    fn attach_existing<'a>(
        &'a self,
        _: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1> {
        Box::pin(async move { Ok(binding.clone()) })
    }
    fn open_replacement<'a>(
        &'a self,
        request: StructuredProviderOpenRequestV1,
        transition: &'a AgentRuntimeTransitionRecordV1,
        _: ProviderStateEnvironment,
    ) -> StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1> {
        Box::pin(async move {
            self.opens.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err(CountingStructuredRuntime::unavailable().without_target());
            }
            let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: source } =
                &transition.intent.source_authority
            else {
                unreachable!()
            };
            let binding = self
                .store
                .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
                    schema_version: 1,
                    interaction_session_id: source.interaction_session_id.clone(),
                    expected_binding_revision: source.binding_revision,
                    source: source.runtime.clone(),
                    source_execution_profile: source.execution_profile.clone(),
                    target: AgentProviderRuntimeFenceV1 {
                        runtime_generation: "recovery-target".into(),
                        provider_epoch: "recovery-target-epoch".into(),
                    },
                    target_execution_profile: request.execution_profile,
                    provider_conversation_ref: request.provider_conversation_ref,
                    replaced_at_ms: now_ms().unwrap(),
                })
                .await
                .unwrap();
            self.registry
                .register(binding.clone(), self.commands.clone())
                .unwrap();
            Ok(binding)
        })
    }
    fn stop_replacement_source<'a>(
        &'a self,
        transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> StructuredProviderRuntimeFuture<'a, ()> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        if let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } =
            &transition.intent.source_authority
        {
            self.registry
                .retire(&binding.interaction_session_id, &binding.runtime)
                .unwrap();
        }
        Box::pin(async { Ok(()) })
    }
    fn retire_replacement_source<'a>(
        &'a self,
        _: &'a AgentRuntimeTransitionRecordV1,
    ) -> StructuredProviderRuntimeFuture<'a, AgentRuntimeReplacementAuthorityV1> {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }
    fn stop_current<'a>(
        &'a self,
        _: &'a AgentInteractionBindingV1,
    ) -> StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

async fn recovery_fixture(
    fail: bool,
) -> (TempDir, Arc<ServiceState>, Arc<RecoveryRuntime>, AgentIdV1) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    state.agent_providers = Arc::new(provider_extension::test_structured_agent_provider_registry(
        "codex",
    ));
    let agent_id = AgentIdV1::new("account-recovery-agent").unwrap();
    let provider_id = ProviderIdV1::new("codex").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: provider_id.clone(),
            display_name: "Account recovery".into(),
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    let (_, binding) =
        initialize_structured_source_for_provider(&state, agent_id.clone(), provider_id.clone())
            .await;
    let accounts = state
        .descriptor
        .database_path
        .parent()
        .unwrap()
        .join("accounts");
    fs::create_dir_all(&accounts).unwrap();
    fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
    let profile_directory = accounts.join("codex-recovery-test");
    fs::create_dir(&profile_directory).unwrap();
    fs::set_permissions(&profile_directory, fs::Permissions::from_mode(0o700)).unwrap();
    let profile = state
        .credential_profiles
        .register(
            provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                schema_version: 1,
                provider_id: "codex".into(),
                reference_id: "recovery-test".into(),
                profile_directory_name: "codex-recovery-test".into(),
            },
        )
        .await
        .unwrap();
    state
        .store
        .put_provider_recovery_policy(
            &ProviderRecoveryPolicyPutV1 {
                schema_version: 1,
                provider_id: provider_id.clone(),
                expected_revision: 0,
                idempotency_key: "enable-recovery".into(),
                enabled: true,
                accounts: vec![ProviderRecoveryAccountV1 {
                    profile,
                    name: "Shared account".into(),
                }],
            },
            now_ms().unwrap(),
        )
        .await
        .unwrap();
    let service = Arc::new(AgentConversationService::new(Arc::clone(&state.store)));
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let runtime = Arc::new(RecoveryRuntime {
        store: Arc::clone(&state.store),
        registry: Arc::clone(&registry),
        commands: Arc::new(RecoveryCommands::default()),
        stops: AtomicUsize::new(0),
        opens: AtomicUsize::new(0),
        fail,
    });
    registry
        .register(binding.clone(), runtime.commands.clone())
        .unwrap();
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes.register(provider_id, runtime.clone()).unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    state.agent_conversation_runtimes = Arc::clone(&registry);
    state.agent_conversations = Arc::new(AgentConversationApi::new(service.clone(), registry));
    let input = AgentStartTurnIntentV1 {
        schema_version: 1,
        interaction_session_id: binding.interaction_session_id.clone(),
        runtime: binding.runtime.clone(),
        turn_id: dure_app::AgentTurnIdV1::new("limited-turn").unwrap(),
        client_message_id: dure_app::AgentClientMessageIdV1::new("limited-input").unwrap(),
        input: "Create the requested marketing draft".into(),
        requested_at_ms: now_ms().unwrap(),
    };
    state.store.record_agent_turn_intent(&input).await.unwrap();
    service
        .commit_provider_event(&dure_app::AgentProviderEventCommitV1 {
            schema_version: 1,
            interaction_session_id: binding.interaction_session_id,
            event: dure_app::AgentProviderEventIdentityV1 {
                runtime: binding.runtime,
                sequence: 1,
            },
            source_fingerprint: "quota-fixture".into(),
            recorded_at_ms: now_ms().unwrap(),
            mutations: vec![dure_app::AgentTimelineMutationV1::Append {
                item: dure_app::AgentTimelineItemDraftV1 {
                    item_id: dure_app::AgentTimelineItemIdV1::new("limited-failure").unwrap(),
                    turn_id: Some(input.turn_id),
                    client_message_id: Some(input.client_message_id),
                    provider_message_id: None,
                    body: dure_app::AgentTimelineItemBodyV1::Lifecycle {
                        state: dure_app::AgentTimelineLifecycleStateV1::TurnFailed,
                        detail: Some("usage_limit".into()),
                    },
                    created_at_ms: now_ms().unwrap(),
                },
            }],
        })
        .await
        .unwrap();
    (root, Arc::new(state), runtime, agent_id)
}

async fn wait_for_accepted(
    state: &ServiceState,
    commands: &RecoveryCommands,
) -> Result<(), tokio::time::error::Elapsed> {
    tokio::time::timeout(Duration::from_secs(3), async {
        commands.observed.notified().await;
        let intent = commands.inputs.lock().unwrap()[0].clone();
        loop {
            if matches!(state.store.inspect_agent_input(&intent.interaction_session_id, &intent.client_message_id).await.unwrap(),
                Some(dure_app::AgentInputReceiptV1::Turn { receipt }) if receipt.state == dure_app::AgentTurnEffectStateV1::Accepted) {
                return;
            }
            tokio::task::yield_now().await;
        }
    }).await
}

#[tokio::test]
async fn account_recovery_worker_starts_without_any_mounted_client() {
    let (_root, state, runtime, agent_id) = recovery_fixture(false).await;
    let worker = tokio::spawn(crate::agent_conversation::continuation::run(Arc::clone(
        &state,
    )));
    let observed = wait_for_accepted(&state, &runtime.commands).await;
    worker.abort();
    let _ = worker.await;
    assert!(
        observed.is_ok(),
        "{observed:?}; recovery: {:?}",
        state
            .store
            .prepare_agent_recovery(&agent_id, now_ms().unwrap())
            .await
            .unwrap()
            .map(|record| record.stopped)
    );
    assert_eq!(runtime.stops.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 1);
    let inputs = runtime.commands.inputs.lock().unwrap();
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0].input, "Create the requested marketing draft");
    assert_eq!(inputs[0].runtime.runtime_generation, "recovery-target");
    drop(inputs);
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .revision,
        2
    );
}

#[tokio::test]
async fn reopened_backend_resumes_after_committed_switch_without_launching_again() {
    let (_root, state, runtime, agent_id) = recovery_fixture(false).await;
    let record = state
        .store
        .prepare_agent_recovery(&agent_id, now_ms().unwrap())
        .await
        .unwrap()
        .unwrap();
    agent_runtime_transition_apply::apply(
        &state,
        &record.attempt_id,
        agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            expected_source_revision: Some(record.source_selection_revision),
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            target_execution_profile: Some(record.target.as_ref().unwrap().execution_profile()),
            target_launch_selection: None,
        },
    )
    .await
    .unwrap();
    assert!(runtime.commands.inputs.lock().unwrap().is_empty());
    state.store.close().await;
    let reopened = reopen_goal_runtime_fixture(&state, state.store.database_path()).await;
    let binding = reopened
        .store
        .agent_interaction_for_agent(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let commands = Arc::new(RecoveryCommands::default());
    reopened
        .agent_conversation_runtimes
        .register(binding, commands.clone())
        .unwrap();
    let reopened = Arc::new(reopened);
    let worker = tokio::spawn(crate::agent_conversation::continuation::run(Arc::clone(
        &reopened,
    )));
    let observed = wait_for_accepted(&reopened, &commands).await;
    worker.abort();
    let _ = worker.await;
    observed.unwrap();
    assert_eq!(commands.inputs.lock().unwrap().len(), 1);
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 1);
    let receipt = reopened
        .store
        .agent_recovery(&record.attempt_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(receipt.continuation.unwrap().intent.input, record.input);
}

#[tokio::test]
async fn duplicate_recovery_requests_share_the_runtime_and_turn_effects() {
    let (_root, state, runtime, agent_id) = recovery_fixture(false).await;
    let (left, right) = tokio::join!(
        crate::agent_recovery::advance(&state, &agent_id),
        crate::agent_recovery::advance(&state, &agent_id)
    );
    assert!(
        left.is_ok(),
        "{left:?}; recovery: {:?}",
        state
            .store
            .prepare_agent_recovery(&agent_id, now_ms().unwrap())
            .await
            .unwrap()
            .map(|record| record.stopped)
    );
    right.unwrap();
    assert_eq!(runtime.stops.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.commands.inputs.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn failed_account_recovery_does_not_launch_or_resend_again() {
    let (_root, state, runtime, agent_id) = recovery_fixture(true).await;
    assert!(
        crate::agent_recovery::advance(&state, &agent_id)
            .await
            .is_err()
    );
    let first = state
        .store
        .prepare_agent_recovery(&agent_id, now_ms().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert!(first.stopped.is_some());
    assert!(
        crate::agent_recovery::advance(&state, &agent_id)
            .await
            .is_err()
    );
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 1);
    assert!(runtime.commands.inputs.lock().unwrap().is_empty());
    assert_eq!(
        state
            .store
            .prepare_agent_recovery(&agent_id, now_ms().unwrap())
            .await
            .unwrap(),
        Some(first)
    );
}

#[tokio::test]
async fn pending_recovery_does_not_reopen_a_conversation_closed_by_a_person() {
    let (_root, state, runtime, agent_id) = recovery_fixture(false).await;
    let record = state
        .store
        .prepare_agent_recovery(&agent_id, now_ms().unwrap())
        .await
        .unwrap()
        .unwrap();
    let operation_id = OperationIdV1::new("human-close").unwrap();
    state
        .store
        .admit_agent_runtime_close(&AgentRuntimeCloseIntentV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            idempotency_key: "human-close".into(),
            source: state
                .store
                .agent_runtime_selection(&agent_id)
                .await
                .unwrap()
                .unwrap(),
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                binding: record.source.clone(),
            },
            stopped_transition: None,
            requested_at_ms: now_ms().unwrap(),
        })
        .await
        .unwrap();
    state
        .store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id,
            expected_journal_revision: 1,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: now_ms().unwrap(),
        })
        .await
        .unwrap();
    runtime
        .registry
        .retire(
            &record.source.interaction_session_id,
            &record.source.runtime,
        )
        .unwrap();
    assert!(
        !crate::agent_recovery::advance(&state, &agent_id)
            .await
            .unwrap()
    );
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 0);
    assert!(runtime.commands.inputs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn pending_recovery_survives_startup_reattachment_of_the_same_source_conversation() {
    let (_root, state, runtime, agent_id) = recovery_fixture(false).await;
    let record = state
        .store
        .prepare_agent_recovery(&agent_id, now_ms().unwrap())
        .await
        .unwrap()
        .unwrap();
    let attached = state
        .store
        .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
            schema_version: 1,
            interaction_session_id: record.source.interaction_session_id.clone(),
            expected_binding_revision: record.source.binding_revision,
            source: record.source.runtime.clone(),
            source_execution_profile: record.source.execution_profile.clone(),
            target: AgentProviderRuntimeFenceV1 {
                runtime_generation: "startup-source".into(),
                provider_epoch: "startup-epoch".into(),
            },
            target_execution_profile: record.source.execution_profile.clone(),
            provider_conversation_ref: record.source.provider_conversation_ref.clone(),
            replaced_at_ms: now_ms().unwrap(),
        })
        .await
        .unwrap();
    runtime
        .registry
        .retire(
            &record.source.interaction_session_id,
            &record.source.runtime,
        )
        .unwrap();
    runtime
        .registry
        .register(attached, runtime.commands.clone())
        .unwrap();
    assert!(
        crate::agent_recovery::advance(&state, &agent_id)
            .await
            .unwrap()
    );
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.commands.inputs.lock().unwrap().len(), 1);
    assert_eq!(
        state
            .store
            .agent_recovery(&record.attempt_id)
            .await
            .unwrap()
            .unwrap()
            .attempt_id,
        record.attempt_id
    );
}

#[tokio::test]
async fn recovery_configuration_is_shared_and_replays_without_overwriting_newer_direction() {
    let (_root, state, runtime, _) = recovery_fixture(false).await;
    let get = json!({ "schemaVersion": 1, "providerId": "codex" });
    let read = request_over_test_connection(
        Arc::clone(&state),
        "provider_recovery.get",
        "account_recovery.v1",
        get.clone(),
    )
    .await;
    let policy = &read["result"]["policy"];
    assert_eq!(policy["revision"], 1);
    assert_eq!(read["result"]["profiles"].as_array().unwrap().len(), 1);
    assert_eq!(
        read["result"]["profiles"][0],
        policy["accounts"][0]["profile"]
    );
    assert!(!read.to_string().contains("profileDirectoryName"));
    let disable = json!({ "schemaVersion": 1, "providerId": "codex", "expectedRevision": 1,
        "idempotencyKey": "disable-recovery", "enabled": false, "accounts": policy["accounts"] });
    let written = request_over_test_connection(
        Arc::clone(&state),
        "provider_recovery.put",
        "account_recovery.v1",
        disable.clone(),
    )
    .await;
    assert_eq!(written["result"]["policy"]["revision"], 2);
    let newer = json!({ "expectedRevision": 2, "idempotencyKey": "remove-accounts", "accounts": [],
        "schemaVersion": 1, "providerId": "codex", "enabled": false });
    let changed = request_over_test_connection(
        Arc::clone(&state),
        "provider_recovery.put",
        "account_recovery.v1",
        newer,
    )
    .await;
    assert_eq!(changed["result"]["policy"]["revision"], 3);
    let replay = request_over_test_connection(
        Arc::clone(&state),
        "provider_recovery.put",
        "account_recovery.v1",
        disable.clone(),
    )
    .await;
    assert_eq!(replay["result"], written["result"]);
    let mut stale = disable;
    stale["idempotencyKey"] = json!("another-client");
    let conflict = request_over_test_connection(
        Arc::clone(&state),
        "provider_recovery.put",
        "account_recovery.v1",
        stale,
    )
    .await;
    assert_eq!(conflict["error"]["code"], "provider_recovery_conflict");
    let latest = request_over_test_connection(
        Arc::clone(&state),
        "provider_recovery.get",
        "account_recovery.v1",
        get,
    )
    .await;
    assert_eq!(latest["result"]["policy"], changed["result"]["policy"]);
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn independent_clients_observe_the_same_retained_recovery_and_canonical_send_receipt() {
    let (_root, state, runtime, agent_id) = recovery_fixture(false).await;
    let body = json!({ "schemaVersion": 1, "agentId": agent_id });
    let empty = request_over_test_connection(
        Arc::clone(&state),
        "agent_recovery.read",
        "account_recovery.v1",
        body.clone(),
    )
    .await;
    assert!(empty["result"]["recovery"].is_null());
    let record = state
        .store
        .prepare_agent_recovery(&agent_id, now_ms().unwrap())
        .await
        .unwrap()
        .unwrap();
    let pending = request_over_test_connection(
        Arc::clone(&state),
        "agent_recovery.read",
        "account_recovery.v1",
        body.clone(),
    )
    .await;
    assert_eq!(
        pending["result"]["recovery"]["attemptId"],
        record.attempt_id
    );
    assert!(pending["result"]["recovery"]["turnState"].is_null());
    crate::agent_recovery::advance(&state, &agent_id)
        .await
        .unwrap();
    for _ in 0..2 {
        let settled = request_over_test_connection(
            Arc::clone(&state),
            "agent_recovery.read",
            "account_recovery.v1",
            body.clone(),
        )
        .await;
        assert_eq!(
            settled["result"]["recovery"]["attemptId"],
            record.attempt_id
        );
        assert_eq!(settled["result"]["recovery"]["turnState"], "accepted");
    }
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.commands.inputs.lock().unwrap().len(), 1);
}
