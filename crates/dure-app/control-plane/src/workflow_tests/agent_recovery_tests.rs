use super::*;
use crate::agent_conversation::{
    AgentConversationService, AgentProviderCommandFuture, AgentProviderCommands,
};
use crate::agent_conversation_api::{AgentConversationApi, AgentConversationRuntimeRegistry};
use crate::structured_provider_runtime::{
    StructuredProviderOpenRequestV1, StructuredProviderRuntime, StructuredProviderRuntimeFuture,
};
use dure_app::{
    AgentQueuedTurnStore, AgentRecoveryAttemptV1, AgentRecoveryRecordV1, AgentRecoveryStopV1,
    AgentRecoveryStore, AgentStartTurnIntentV1, AgentTimelineStore, ProviderRecoveryAccountV1,
    ProviderRecoveryPolicyPutV1, ProviderRecoveryStore, agent_runtime_transition_identity,
};
use std::path::Path;

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
    /// Every target start fails with a retryable runtime error.
    fail: bool,
    /// Accounts whose target start finds no usable credential.
    credential_unavailable: Vec<String>,
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
            if matches!(&request.execution_profile,
                AgentExecutionProfileV1::CredentialReference { reference_id, .. }
                    if self.credential_unavailable.contains(reference_id))
            {
                return Err(structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::CredentialUnavailable,
                    "recovery_test_credential_unavailable",
                )
                .without_target());
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
    recovery_pool_fixture(&["recovery-test"], &[], move |_, _| fail).await
}

/// One structured Codex agent on the default login, stopped at a usage limit,
/// with `accounts` allowed for recovery in that order. `prepare_host` runs
/// after registration and before the failure, with the backend home, and
/// says whether every target start fails with a retryable runtime error.
async fn recovery_pool_fixture(
    accounts: &[&str],
    credential_unavailable: &[&str],
    prepare_host: impl FnOnce(&mut ServiceState, &Path) -> bool,
) -> (TempDir, Arc<ServiceState>, Arc<RecoveryRuntime>, AgentIdV1) {
    recovery_pool_fixture_with(accounts, credential_unavailable, prepare_host, None).await
}

/// With `reset_at_ms`, continuing after a reset is on, switching only when
/// `accounts` names a pool, and the failed turn carries the reset its
/// provider reported, as the Claude bridge records it.
async fn recovery_pool_fixture_with(
    accounts: &[&str],
    credential_unavailable: &[&str],
    prepare_host: impl FnOnce(&mut ServiceState, &Path) -> bool,
    reset_at_ms: Option<i64>,
) -> (TempDir, Arc<ServiceState>, Arc<RecoveryRuntime>, AgentIdV1) {
    recovery_pool_fixture_on(
        "codex",
        None,
        accounts,
        credential_unavailable,
        prepare_host,
        reset_at_ms,
    )
    .await
}

/// `recovery_pool_fixture_with` for an agent of `provider` running `model`.
async fn recovery_pool_fixture_on(
    provider: &str,
    model: Option<&str>,
    accounts: &[&str],
    credential_unavailable: &[&str],
    prepare_host: impl FnOnce(&mut ServiceState, &Path) -> bool,
    reset_at_ms: Option<i64>,
) -> (TempDir, Arc<ServiceState>, Arc<RecoveryRuntime>, AgentIdV1) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    state.agent_providers = Arc::new(provider_extension::test_structured_agent_provider_registry(
        provider,
    ));
    let agent_id = AgentIdV1::new("account-recovery-agent").unwrap();
    let provider_id = ProviderIdV1::new(provider).unwrap();
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
    let (_, binding) = initialize_structured_source_on_model(
        &state,
        agent_id.clone(),
        provider_id.clone(),
        Some("conversation-retained"),
        model,
    )
    .await;
    let accounts_root = state
        .descriptor
        .database_path
        .parent()
        .unwrap()
        .join("accounts");
    fs::create_dir_all(&accounts_root).unwrap();
    fs::set_permissions(&accounts_root, fs::Permissions::from_mode(0o700)).unwrap();
    let mut pool = Vec::new();
    for reference in accounts {
        let directory_name = format!("{provider}-{reference}");
        let profile_directory = accounts_root.join(&directory_name);
        fs::create_dir(&profile_directory).unwrap();
        fs::set_permissions(&profile_directory, fs::Permissions::from_mode(0o700)).unwrap();
        let profile = state
            .credential_profiles
            .register(
                provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                    schema_version: 1,
                    provider_id: provider.into(),
                    reference_id: (*reference).into(),
                    profile_directory_name: directory_name,
                },
            )
            .await
            .unwrap();
        pool.push(ProviderRecoveryAccountV1 {
            profile,
            name: format!("Shared account {reference}"),
        });
    }
    // A reset fixture fails ten minutes ago, after recovery was turned on.
    let failed_at_ms = now_ms().unwrap() - reset_at_ms.map_or(0, |_| 10 * 60 * 1000);
    state
        .store
        .put_provider_recovery_policy(
            &ProviderRecoveryPolicyPutV1 {
                schema_version: 1,
                provider_id: provider_id.clone(),
                expected_revision: 0,
                idempotency_key: "enable-recovery".into(),
                enabled: reset_at_ms.is_none() || !pool.is_empty(),
                accounts: pool,
                continue_after_reset: reset_at_ms.is_some(),
            },
            failed_at_ms - 1,
        )
        .await
        .unwrap();
    let fail = prepare_host(&mut state, accounts_root.parent().unwrap());
    let service = Arc::new(AgentConversationService::new(Arc::clone(&state.store)));
    let registry = Arc::new(AgentConversationRuntimeRegistry::default());
    let runtime = Arc::new(RecoveryRuntime {
        store: Arc::clone(&state.store),
        registry: Arc::clone(&registry),
        commands: Arc::new(RecoveryCommands::default()),
        stops: AtomicUsize::new(0),
        opens: AtomicUsize::new(0),
        fail,
        credential_unavailable: credential_unavailable
            .iter()
            .map(|reference| (*reference).into())
            .collect(),
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
    let mut mutations = Vec::new();
    if let Some(resets_at_ms) = reset_at_ms {
        mutations.push(dure_app::AgentTimelineMutationV1::Append {
            item: dure_app::AgentTimelineItemDraftV1 {
                item_id: dure_app::AgentTimelineItemIdV1::new("limited-reset").unwrap(),
                turn_id: None,
                client_message_id: Some(input.client_message_id.clone()),
                provider_message_id: None,
                body: dure_app::AgentTimelineItemBodyV1::ProviderEvidence {
                    namespace: "provider.claude".into(),
                    kind: dure_app::AGENT_USAGE_LIMIT_RESET_EVIDENCE_KIND_V1.into(),
                    value: json!({ "resetsAtMs": resets_at_ms }),
                },
                created_at_ms: failed_at_ms,
            },
        });
    }
    mutations.push(dure_app::AgentTimelineMutationV1::Append {
        item: dure_app::AgentTimelineItemDraftV1 {
            item_id: dure_app::AgentTimelineItemIdV1::new("limited-failure").unwrap(),
            turn_id: Some(input.turn_id),
            client_message_id: Some(input.client_message_id),
            provider_message_id: None,
            body: dure_app::AgentTimelineItemBodyV1::Lifecycle {
                state: dure_app::AgentTimelineLifecycleStateV1::TurnFailed,
                detail: Some("usage_limit".into()),
            },
            created_at_ms: failed_at_ms,
        },
    });
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
            mutations,
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
            .prepare_agent_recovery(&agent_id, now_ms().unwrap(), None)
            .await
            .unwrap()
            .and_then(AgentRecoveryAttemptV1::into_conversation)
            .map(|record| record.stopped)
    );
    assert_eq!(runtime.stops.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 1);
    {
        let inputs = runtime.commands.inputs.lock().unwrap();
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].input, "Create the requested marketing draft");
        assert_eq!(inputs[0].runtime.runtime_generation, "recovery-target");
    }
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
        .prepare_agent_recovery(&agent_id, now_ms().unwrap(), None)
        .await
        .unwrap()
        .and_then(AgentRecoveryAttemptV1::into_conversation)
        .unwrap();
    agent_runtime_transition_apply::apply(
        &state,
        &record.attempt_id,
        agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            expected_source_revision: Some(record.source_selection_revision),
            expected_operation_id: None,
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
        .and_then(AgentRecoveryAttemptV1::into_conversation)
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
            .prepare_agent_recovery(&agent_id, now_ms().unwrap(), None)
            .await
            .unwrap()
            .and_then(AgentRecoveryAttemptV1::into_conversation)
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
        .prepare_agent_recovery(&agent_id, now_ms().unwrap(), None)
        .await
        .unwrap()
        .and_then(AgentRecoveryAttemptV1::into_conversation)
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
            .prepare_agent_recovery(&agent_id, now_ms().unwrap(), None)
            .await
            .unwrap()
            .and_then(AgentRecoveryAttemptV1::into_conversation),
        Some(first)
    );
}

#[tokio::test]
async fn pending_recovery_does_not_reopen_a_conversation_closed_by_a_person() {
    let (_root, state, runtime, agent_id) = recovery_fixture(false).await;
    let record = state
        .store
        .prepare_agent_recovery(&agent_id, now_ms().unwrap(), None)
        .await
        .unwrap()
        .and_then(AgentRecoveryAttemptV1::into_conversation)
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
            .owns()
    );
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 0);
    assert!(runtime.commands.inputs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn pending_recovery_survives_startup_reattachment_of_the_same_source_conversation() {
    let (_root, state, runtime, agent_id) = recovery_fixture(false).await;
    let record = state
        .store
        .prepare_agent_recovery(&agent_id, now_ms().unwrap(), None)
        .await
        .unwrap()
        .and_then(AgentRecoveryAttemptV1::into_conversation)
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
            .owns()
    );
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.commands.inputs.lock().unwrap().len(), 1);
    assert_eq!(
        state
            .store
            .agent_recovery(&record.attempt_id)
            .await
            .unwrap()
            .and_then(AgentRecoveryAttemptV1::into_conversation)
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
        .prepare_agent_recovery(&agent_id, now_ms().unwrap(), None)
        .await
        .unwrap()
        .and_then(AgentRecoveryAttemptV1::into_conversation)
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

/// A native terminal Agent has no conversation binding. The continuation
/// loop still runs account recovery for it and is not an error.
#[tokio::test]
async fn continuation_advances_an_agent_without_a_conversation() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new("native-terminal-agent").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            display_name: "Native terminal".into(),
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    assert_eq!(
        crate::agent_conversation::continuation::advance(&state, &agent_id, None).await,
        Ok(None)
    );
}

/// Answers the provider's login check from a fixed set of signed-out profile
/// directories and delegates everything else to the native preparer.
struct SignedOutProfiles {
    signed_out: Vec<String>,
    delegate: provider_credential_profile::NativeProviderCredentialProfileLaunchPreparer,
}

impl provider_credential_profile::ProviderCredentialProfileLaunchPreparer for SignedOutProfiles {
    fn prepare(
        &self,
        provider_id: &ProviderIdV1,
        directory: &Path,
    ) -> Result<
        dure_provider_profile::PreparedProviderProfileLaunch,
        provider_credential_profile::ProviderCredentialLaunchFailureV1,
    > {
        self.delegate.prepare(provider_id, directory)
    }

    fn observe_login(
        &self,
        provider_id: &ProviderIdV1,
        directory: Option<&Path>,
        reference_ids: &[String],
        observed_at_ms: i64,
    ) -> crate::provider_login_observation::ProviderLoginObservationV1 {
        self.delegate
            .observe_login(provider_id, directory, reference_ids, observed_at_ms)
    }

    fn login_signed_in<'a>(
        &'a self,
        _: &'a ProviderIdV1,
        environment: &'a ProviderStateEnvironment,
        _: i64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<bool>> + Send + 'a>> {
        Box::pin(async move {
            Some(!environment.values().values().any(|value| {
                self.signed_out
                    .iter()
                    .any(|directory| value.ends_with(directory.as_str()))
            }))
        })
    }
}

async fn recovery_record(state: &ServiceState, agent_id: &AgentIdV1) -> AgentRecoveryRecordV1 {
    let observation = state
        .store
        .latest_agent_recovery(agent_id)
        .await
        .unwrap()
        .expect("the recovery stays observable");
    state
        .store
        .agent_recovery(&observation.attempt_id)
        .await
        .unwrap()
        .and_then(AgentRecoveryAttemptV1::into_conversation)
        .unwrap()
}

fn reference_ids(profiles: &[dure_app::ProviderCredentialProfileV1]) -> Vec<&str> {
    profiles
        .iter()
        .map(|profile| profile.reference_id.as_str())
        .collect()
}

async fn selected_reference(state: &ServiceState, agent_id: &AgentIdV1) -> String {
    match state
        .store
        .agent_runtime_selection(agent_id)
        .await
        .unwrap()
        .unwrap()
        .execution_profile
    {
        AgentExecutionProfileV1::CredentialReference { reference_id, .. } => reference_id,
        AgentExecutionProfileV1::ProviderDefault => "default".into(),
    }
}

#[tokio::test]
async fn a_target_that_fails_to_start_moves_the_conversation_to_the_next_account() {
    let (_root, state, runtime, agent_id) =
        recovery_pool_fixture(&["broken", "working"], &["broken"], |_, _| false).await;
    let advanced = crate::agent_recovery::advance(&state, &agent_id).await;
    let record = recovery_record(&state, &agent_id).await;
    assert_eq!(
        advanced,
        Ok(crate::agent_recovery::AgentRecoveryHoldV1::Owned),
        "{record:?}"
    );
    // One source stop, then the failed target's journal is replaced in place.
    assert_eq!(runtime.stops.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 2);
    assert_eq!(reference_ids(&record.unusable_targets), ["broken"]);
    assert_eq!(
        record.target.as_ref().unwrap().profile.reference_id,
        "working"
    );
    assert_eq!(record.stopped, None);
    let (first, _) = agent_runtime_transition_identity(&record.attempt_id).unwrap();
    assert_eq!(
        state
            .store
            .agent_runtime_transition(&first)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::Superseded
    );
    assert_eq!(selected_reference(&state, &agent_id).await, "working");
    {
        let inputs = runtime.commands.inputs.lock().unwrap();
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].input, "Create the requested marketing draft");
        assert_eq!(inputs[0].runtime.runtime_generation, "recovery-target");
    }
    // Replaying the attempt neither launches nor sends again.
    crate::agent_recovery::advance(&state, &agent_id)
        .await
        .unwrap();
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 2);
    assert_eq!(runtime.commands.inputs.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn recovery_tries_each_account_once_when_every_target_fails() {
    let (_root, state, runtime, agent_id) = recovery_pool_fixture(
        &["broken-a", "broken-b"],
        &["broken-a", "broken-b"],
        |_, _| false,
    )
    .await;
    assert_eq!(
        crate::agent_recovery::advance(&state, &agent_id).await,
        Err("agent_recovery_failed")
    );
    let record = recovery_record(&state, &agent_id).await;
    assert_eq!(
        reference_ids(&record.unusable_targets),
        ["broken-a", "broken-b"]
    );
    assert_eq!(
        record.stopped,
        Some(AgentRecoveryStopV1::Failed {
            code: "agent_runtime_repair_required".into()
        })
    );
    assert!(
        crate::agent_recovery::advance(&state, &agent_id)
            .await
            .is_err()
    );
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 2);
    assert!(runtime.commands.inputs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn recovery_skips_signed_out_full_and_same_logins_the_app_observed() {
    let now = now_ms().unwrap() / 1000;
    let (_root, state, runtime, agent_id) = recovery_pool_fixture(
        &["signed-out", "same-login", "full", "working"],
        &[],
        |_, home| {
            let write = |path: std::path::PathBuf, value: serde_json::Value| {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, value.to_string()).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            };
            let limit = |used: f64| {
                json!([{"limitId": "codex", "usedPercent": used, "resetsAt": now + 600,
                    "usedPercentWeekly": used, "weeklyResetsAt": now + 6000}])
            };
            // The app's latest Codex usage check for each account.
            write(
                home.join("codex-usage-snapshots.json"),
                json!({"schemaVersion": 1, "snapshots": [
                    {"credentialId": "signed-out", "capturedAt": now - 900, "attemptedAt": now - 10,
                        "error": "codex_usage_not_signed_in", "rateLimits": limit(1.0)},
                    {"credentialId": "full", "capturedAt": now - 10, "attemptedAt": now - 10,
                        "error": null, "rateLimits": limit(100.0)},
                    {"credentialId": "working", "capturedAt": now - 10, "attemptedAt": now - 10,
                        "error": null, "rateLimits": limit(30.0)},
                ]}),
            );
            // The source runs on the default login, which is also registered.
            write(
                home.join(".codex/auth.json"),
                json!({"tokens": {"account_id": "chatgpt-shared"}}),
            );
            write(
                home.join("accounts/codex-same-login/auth.json"),
                json!({"tokens": {"account_id": "chatgpt-shared"}}),
            );
            false
        },
    )
    .await;
    let advanced = crate::agent_recovery::advance(&state, &agent_id).await;
    let record = recovery_record(&state, &agent_id).await;
    assert_eq!(
        advanced,
        Ok(crate::agent_recovery::AgentRecoveryHoldV1::Owned),
        "{record:?}"
    );
    assert_eq!(
        reference_ids(&record.unusable_targets),
        ["signed-out", "same-login"]
    );
    assert_eq!(
        record.target.as_ref().unwrap().profile.reference_id,
        "working"
    );
    // Nothing was launched on an account the app already knew was unusable.
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 1);
    assert_eq!(selected_reference(&state, &agent_id).await, "working");
    assert_eq!(runtime.commands.inputs.lock().unwrap().len(), 1);
}

/// An account whose own Fable window is used up refuses a Fable agent even
/// while its weekly window over every model has headroom; an agent on
/// another model still gets it, as the account with the most headroom.
#[tokio::test]
async fn recovery_skips_an_account_whose_window_for_the_agents_model_is_full() {
    let now = now_ms().unwrap() / 1000;
    let pool = |state: &mut ServiceState, home: &Path| {
        let window = |kind: &str, model: Option<&str>, used: f64| {
            json!({"id": "window", "kind": kind, "model": model, "usedPercent": used,
                "resetsAt": now + 6000})
        };
        let path = home.join("claude-usage-snapshots.json");
        fs::write(
            &path,
            json!({"schemaVersion": 1, "snapshots": [
                {"credentialId": "fable-full", "capturedAt": now - 10, "attemptedAt": now - 10,
                    "error": null, "windows": [
                    window("weekly", None, 30.0),
                    window("modelWeekly", Some("Fable"), 100.0),
                ]},
                {"credentialId": "working", "capturedAt": now - 10, "attemptedAt": now - 10,
                    "error": null, "windows": [
                    window("weekly", None, 50.0),
                    window("modelWeekly", Some("Fable"), 20.0),
                ]},
            ]})
            .to_string(),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        // Every login answers signed in, without running Claude Code.
        state.credential_profiles = Arc::new(
            provider_credential_profile::ProviderCredentialProfileRegistry::with_launch_preparer(
                home.to_path_buf(),
                Arc::clone(&state.store),
                Arc::new(SignedOutProfiles {
                    signed_out: Vec::new(),
                    delegate: provider_credential_profile::NativeProviderCredentialProfileLaunchPreparer::new(
                        home.to_path_buf(),
                        Some(home.to_path_buf()),
                    ),
                }),
            ),
        );
        false
    };
    let (_root, state, runtime, agent_id) = recovery_pool_fixture_on(
        "claude",
        Some("claude-fable-5-2"),
        &["fable-full", "working"],
        &[],
        pool,
        None,
    )
    .await;
    let advanced = crate::agent_recovery::advance(&state, &agent_id).await;
    let record = recovery_record(&state, &agent_id).await;
    assert_eq!(
        advanced,
        Ok(crate::agent_recovery::AgentRecoveryHoldV1::Owned),
        "{record:?}"
    );
    assert_eq!(reference_ids(&record.unusable_targets), ["fable-full"]);
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 1);
    assert_eq!(selected_reference(&state, &agent_id).await, "working");

    let (_root, state, _, agent_id) = recovery_pool_fixture_on(
        "claude",
        Some("sonnet"),
        &["fable-full", "working"],
        &[],
        pool,
        None,
    )
    .await;
    let advanced = crate::agent_recovery::advance(&state, &agent_id).await;
    let record = recovery_record(&state, &agent_id).await;
    assert_eq!(
        advanced,
        Ok(crate::agent_recovery::AgentRecoveryHoldV1::Owned),
        "{record:?}"
    );
    assert!(record.unusable_targets.is_empty());
    assert_eq!(selected_reference(&state, &agent_id).await, "fable-full");
}

#[tokio::test]
async fn recovery_skips_a_login_its_provider_reports_signed_out() {
    let (_root, state, runtime, agent_id) =
        recovery_pool_fixture(&["expired", "working"], &[], |state, home| {
            state.credential_profiles = Arc::new(
                provider_credential_profile::ProviderCredentialProfileRegistry::with_launch_preparer(
                    home.to_path_buf(),
                    Arc::clone(&state.store),
                    Arc::new(SignedOutProfiles {
                        signed_out: vec!["codex-expired".into()],
                        delegate: provider_credential_profile::NativeProviderCredentialProfileLaunchPreparer::new(
                            home.to_path_buf(),
                            Some(home.to_path_buf()),
                        ),
                    }),
                ),
            );
            false
        })
        .await;
    let advanced = crate::agent_recovery::advance(&state, &agent_id).await;
    let record = recovery_record(&state, &agent_id).await;
    assert_eq!(
        advanced,
        Ok(crate::agent_recovery::AgentRecoveryHoldV1::Owned),
        "{record:?}"
    );
    assert_eq!(reference_ids(&record.unusable_targets), ["expired"]);
    assert_eq!(runtime.stops.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 1);
    assert_eq!(selected_reference(&state, &agent_id).await, "working");
}

#[tokio::test]
async fn a_limited_turn_waits_for_its_reported_reset_without_sending() {
    let reset_at_ms = now_ms().unwrap() + 60 * 60 * 1000;
    let (_root, state, runtime, agent_id) =
        recovery_pool_fixture_with(&[], &[], |_, _| false, Some(reset_at_ms)).await;
    let hold = crate::agent_recovery::advance(&state, &agent_id)
        .await
        .unwrap();
    let crate::agent_recovery::AgentRecoveryHoldV1::WaitsUntil(resume_at_ms) = hold else {
        panic!("expected a wait for the reset: {hold:?}");
    };
    assert!(hold.owns(), "the wait keeps a goal from taking the turn");
    assert!(
        (reset_at_ms + 60_000..=reset_at_ms + 180_000).contains(&resume_at_ms),
        "{resume_at_ms} vs {reset_at_ms}"
    );
    assert!(runtime.commands.inputs.lock().unwrap().is_empty());
    let read = request_over_test_connection(
        Arc::clone(&state),
        "agent_recovery.read",
        "account_recovery.v1",
        json!({ "schemaVersion": 1, "agentId": agent_id }),
    )
    .await;
    assert_eq!(read["result"]["recovery"]["resumeAtMs"], resume_at_ms);
    assert!(read["result"]["recovery"]["stopped"].is_null());
    let attempt_id = read["result"]["recovery"]["attemptId"].clone();
    let wait = json!({ "agentId": agent_id, "attemptId": attempt_id, "resumeAtMs": resume_at_ms });
    assert_eq!(read["result"]["wait"], wait);
    // Every client lists the same waits without knowing which Agents to ask.
    let waits = request_over_test_connection(
        Arc::clone(&state),
        "agent_recovery.waits",
        "account_recovery.waits.v1",
        json!({ "schemaVersion": 1 }),
    )
    .await;
    assert_eq!(
        waits["result"],
        json!({ "schemaVersion": 1, "waits": [wait] })
    );
    // A stopped wait leaves the list, and its Agent's read omits it.
    state
        .store
        .stop_agent_recovery(
            attempt_id.as_str().unwrap(),
            &AgentRecoveryStopV1::Superseded,
        )
        .await
        .unwrap();
    let waits = request_over_test_connection(
        Arc::clone(&state),
        "agent_recovery.waits",
        "account_recovery.waits.v1",
        json!({ "schemaVersion": 1 }),
    )
    .await;
    assert_eq!(waits["result"]["waits"], json!([]));
    let read = request_over_test_connection(
        Arc::clone(&state),
        "agent_recovery.read",
        "account_recovery.v1",
        json!({ "schemaVersion": 1, "agentId": agent_id }),
    )
    .await;
    assert!(read["result"].get("wait").is_none(), "{read}");
}

#[tokio::test]
async fn the_continuation_worker_resends_once_on_the_same_account_after_the_reset() {
    let reset_at_ms = now_ms().unwrap() - 5 * 60 * 1000;
    let (_root, state, runtime, agent_id) =
        recovery_pool_fixture_with(&[], &[], |_, _| false, Some(reset_at_ms)).await;
    let source = state
        .store
        .agent_interaction_for_agent(&agent_id)
        .await
        .unwrap()
        .unwrap();
    let worker = tokio::spawn(crate::agent_conversation::continuation::run(Arc::clone(
        &state,
    )));
    let observed = wait_for_accepted(&state, &runtime.commands).await;
    worker.abort();
    let _ = worker.await;
    observed.unwrap();
    let inputs = runtime.commands.inputs.lock().unwrap().clone();
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0].input, "Create the requested marketing draft");
    assert_eq!(inputs[0].runtime, source.runtime, "no account switch");
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 0);
    assert_eq!(runtime.stops.load(Ordering::SeqCst), 0);
}

/// The switch that sets every login aside before any apply waits for the
/// reported reset instead and then resends on the unchanged runtime; a
/// target that failed after its source stopped still stops recovery.
#[tokio::test]
async fn a_switch_with_every_login_set_aside_waits_for_the_reset_instead() {
    let signed_out = |state: &mut ServiceState, home: &Path| {
        state.credential_profiles = Arc::new(
            provider_credential_profile::ProviderCredentialProfileRegistry::with_launch_preparer(
                home.to_path_buf(),
                Arc::clone(&state.store),
                Arc::new(SignedOutProfiles {
                    signed_out: vec!["codex-expired".into()],
                    delegate: provider_credential_profile::NativeProviderCredentialProfileLaunchPreparer::new(
                        home.to_path_buf(),
                        Some(home.to_path_buf()),
                    ),
                }),
            ),
        );
        false
    };
    let reset_at_ms = now_ms().unwrap() + 60 * 60 * 1000;
    let (_root, state, runtime, agent_id) =
        recovery_pool_fixture_with(&["expired"], &[], signed_out, Some(reset_at_ms)).await;
    let hold = crate::agent_recovery::advance(&state, &agent_id).await;
    let record = recovery_record(&state, &agent_id).await;
    let Ok(crate::agent_recovery::AgentRecoveryHoldV1::WaitsUntil(resume_at_ms)) = hold else {
        panic!("expected a wait for the reset: {hold:?} {record:?}");
    };
    assert!(
        (reset_at_ms + 60_000..=reset_at_ms + 180_000).contains(&resume_at_ms),
        "{resume_at_ms} vs {reset_at_ms}"
    );
    assert_eq!(reference_ids(&record.unusable_targets), ["expired"]);
    assert_eq!(record.target, None);
    assert_eq!(record.stopped, None);
    assert_eq!(record.resume_at_ms, Some(resume_at_ms));
    assert_eq!(runtime.stops.load(Ordering::SeqCst), 0);
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 0);
    assert!(runtime.commands.inputs.lock().unwrap().is_empty());
    assert_eq!(selected_reference(&state, &agent_id).await, "default");

    // A reset already behind the backend: the same account resends at once.
    let reset_at_ms = now_ms().unwrap() - 5 * 60 * 1000;
    let (_root, state, runtime, agent_id) =
        recovery_pool_fixture_with(&["expired"], &[], signed_out, Some(reset_at_ms)).await;
    let source = state
        .store
        .agent_interaction_for_agent(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        crate::agent_recovery::advance(&state, &agent_id).await,
        Ok(crate::agent_recovery::AgentRecoveryHoldV1::Owned)
    );
    {
        let inputs = runtime.commands.inputs.lock().unwrap();
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].input, "Create the requested marketing draft");
        assert_eq!(inputs[0].runtime, source.runtime, "no account switch");
    }
    assert_eq!(runtime.opens.load(Ordering::SeqCst), 0);
    assert_eq!(runtime.stops.load(Ordering::SeqCst), 0);

    // A target that failed to start after the source stopped has applied.
    let (_root, state, runtime, agent_id) =
        recovery_pool_fixture_with(&["broken"], &["broken"], |_, _| false, Some(reset_at_ms)).await;
    assert_eq!(
        crate::agent_recovery::advance(&state, &agent_id).await,
        Err("agent_recovery_failed")
    );
    let record = recovery_record(&state, &agent_id).await;
    assert_eq!(record.resume_at_ms, None);
    assert_eq!(
        record.stopped,
        Some(AgentRecoveryStopV1::Failed {
            code: "agent_runtime_repair_required".into()
        })
    );
    assert!(runtime.commands.inputs.lock().unwrap().is_empty());
}
