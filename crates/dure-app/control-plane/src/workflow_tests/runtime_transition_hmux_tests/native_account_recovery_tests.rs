//! A native terminal Agent whose turn ends at a usage limit moves to the next
//! account in the terminal and continues, with nothing typed by a person. With
//! no account to move to, it continues in the same terminal after the reset.

use super::*;
use dure_app::{
    AgentNativeRecoveryContinuationV1, AgentNativeTurnFailureV1, AgentRecoveryAttemptV1,
    AgentRecoveryStopV1, AgentRecoveryStore, AgentTurnFailureReasonV1, ProviderRecoveryAccountV1,
    ProviderRecoveryPolicyPutV1, ProviderRecoveryStore, agent_runtime_transition_identity,
};
use hmux_client::{AgentRuntimeActivity, AgentRuntimeAttention, AgentTurnFailure};

struct NativeRecovery {
    hmux: RealHmux,
    state: ServiceState,
    agent_id: AgentIdV1,
    source: WorkflowSessionGenerationV1,
    accounts: Vec<ProviderRecoveryAccountV1>,
    prompts: FakePromptDeliverer,
}

/// A running terminal Agent on account A of a recovery pool [A, B], whose
/// Host knows its conversation.
async fn native_recovery(key: &str) -> NativeRecovery {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 300\n",
    )
    .unwrap();
    make_fixture_mutation_authority(&mut state);
    let directory = state
        .descriptor
        .database_path
        .parent()
        .unwrap()
        .join("accounts");
    fs::create_dir_all(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    let mut accounts = Vec::new();
    for name in ["account-a", "account-b"] {
        let profile_directory = format!("codex-{name}");
        fs::create_dir(directory.join(&profile_directory)).unwrap();
        fs::set_permissions(
            directory.join(&profile_directory),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let profile = state
            .credential_profiles
            .register(
                provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                    schema_version: 1,
                    provider_id: "codex".into(),
                    reference_id: name.into(),
                    profile_directory_name: profile_directory,
                },
            )
            .await
            .unwrap();
        accounts.push(ProviderRecoveryAccountV1 {
            profile,
            name: name.into(),
        });
    }
    let hmux = RealHmux::install(root, &mut state);
    // The Host, its stop fence and the account switch are real. Typing the
    // prompt needs the product runtime's agent prompt input, so the prompt
    // port records what the owner asked to type, as other real-Hmux
    // fixtures that are not about provider prompt semantics do.
    let prompts = FakePromptDeliverer::new(vec![DeliveryOutcome::Succeed]);
    state.workflow_prompt_deliverer = Arc::new(prompts.clone());
    let agent_id = AgentIdV1::new(format!("{key}-agent")).unwrap();
    let source = launch(&state, &hmux, &format!("{key}-source")).await;
    bind_source_profile(
        &state,
        &agent_id,
        &source,
        Some(CONVERSATION),
        accounts[0].execution_profile(),
    )
    .await;
    state
        .store
        .put_provider_recovery_policy(
            &ProviderRecoveryPolicyPutV1 {
                schema_version: 1,
                provider_id: ProviderIdV1::new("codex").unwrap(),
                expected_revision: 0,
                idempotency_key: format!("{key}-policy"),
                enabled: true,
                accounts: accounts.clone(),
                continue_after_reset: false,
            },
            // An hour ago, so a test can stage a failure seen before now.
            now_ms().unwrap() - 60 * 60 * 1000,
        )
        .await
        .unwrap();
    state_reporter::report_conversation(
        &hmux,
        &source,
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
        Some(CONVERSATION),
    );
    NativeRecovery {
        hmux,
        state,
        agent_id,
        source,
        accounts,
        prompts,
    }
}

async fn native_attempt(
    state: &ServiceState,
    attempt_id: &str,
) -> dure_app::AgentNativeRecoveryRecordV1 {
    match state.store.agent_recovery(attempt_id).await.unwrap() {
        Some(AgentRecoveryAttemptV1::Native(record)) => *record,
        other => panic!("expected a native attempt, got {other:?}"),
    }
}

async fn current_generation(
    state: &ServiceState,
    agent_id: &AgentIdV1,
) -> WorkflowSessionGenerationV1 {
    let authority = state
        .store
        .agent_checkpoint_binding_authority(agent_id)
        .await
        .unwrap()
        .unwrap();
    WorkflowSessionGenerationV1 {
        session_id: authority.binding.session_id,
        workspace_id: authority.runtime_workspace_id,
        provider_id: ProviderIdV1::new("codex").unwrap(),
        runner_principal: authority.runner_principal,
        runner_instance: authority.runner_instance,
        channel_epoch: authority.channel_epoch,
        host_instance_id: authority.host_instance_id,
        terminal_epoch: authority.terminal_epoch,
    }
}

/// Turns account switching off and continuing after a reset on, so a limit
/// has no account to move to.
async fn continue_after_reset_only(state: &ServiceState, key: &str) {
    state
        .store
        .put_provider_recovery_policy(
            &ProviderRecoveryPolicyPutV1 {
                schema_version: 1,
                provider_id: ProviderIdV1::new("codex").unwrap(),
                expected_revision: 1,
                idempotency_key: format!("{key}-continue"),
                enabled: false,
                accounts: Vec::new(),
                continue_after_reset: true,
            },
            now_ms().unwrap(),
        )
        .await
        .unwrap();
}

/// What the app's Codex usage check last recorded for account A: its
/// five-hour window full until `resets_at_ms`, its weekly window not.
fn record_full_window(state: &ServiceState, resets_at_ms: i64) {
    let now_s = now_ms().unwrap() / 1000;
    let snapshots = serde_json::json!({"schemaVersion": 1, "snapshots": [{
        "credentialId": "account-a", "capturedAt": now_s - 5, "attemptedAt": now_s - 5,
        "error": null, "rateLimits": [{"limitId": "codex",
            "usedPercent": 100.0, "resetsAt": resets_at_ms / 1000,
            "usedPercentWeekly": 40.0, "weeklyResetsAt": now_s + 3 * 24 * 60 * 60}]}]});
    fs::write(
        state
            .descriptor
            .database_path
            .parent()
            .unwrap()
            .join("codex-usage-snapshots.json"),
        serde_json::to_vec(&snapshots).unwrap(),
    )
    .unwrap();
}

/// What the source's Host shows now.
async fn host(
    state: &ServiceState,
    source: &WorkflowSessionGenerationV1,
) -> crate::hmux_session_inspection::HmuxSessionInspection {
    crate::query_hmux_for_runtime_transition(
        &state.hmux_identity,
        &source.session_id,
        &source.workspace_id,
        &crate::HmuxStopFence {
            runner_principal: source.runner_principal.clone(),
            runner_instance: source.runner_instance.clone(),
            channel_epoch: source.channel_epoch.clone(),
            host_instance_id: source.host_instance_id.clone(),
            terminal_epoch: source.terminal_epoch.clone(),
        },
    )
    .await
    .unwrap()
}

async fn recovery_rows(state: &ServiceState, agent_id: &AgentIdV1) -> usize {
    state
        .store
        .agent_native_recovery_candidates(None, 128)
        .await
        .unwrap()
        .into_iter()
        .filter(|candidate| &candidate.agent_id == agent_id && candidate.unfinished_attempt)
        .count()
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run pnpm test:hmux-native-account-recovery"]
async fn native_usage_limit_switches_account_and_continues_uses_real_hmux() {
    limit_failure_moves_the_conversation_and_continues_it_once().await;
    a_person_who_resumed_first_supersedes_the_attempt().await;
}

async fn limit_failure_moves_the_conversation_and_continues_it_once() {
    let NativeRecovery {
        hmux,
        state,
        agent_id,
        source,
        accounts,
        prompts,
    } = native_recovery("native-limit").await;
    let original = hmux.session(&source);
    // An untyped error is a person's to read; recovery leaves it alone.
    state_reporter::report_turn_failure(&hmux, &source, None);
    assert!(
        !agent_recovery::advance(&state, &agent_id)
            .await
            .unwrap()
            .owns()
    );
    assert!(hmux.session(&source).same_generation(&original));
    assert_eq!(hmux.requests().len(), 1);

    state_reporter::report_turn_failure(&hmux, &source, Some(AgentTurnFailure::RateLimit));
    assert!(
        agent_recovery::advance(&state, &agent_id)
            .await
            .unwrap()
            .owns()
    );
    let projection = inspect(&state, &agent_id).await;
    assert_eq!(
        projection["receipt"]["selectionRevision"], 2,
        "{projection}"
    );
    let selection = state
        .store
        .agent_runtime_selection(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        selection.interaction_profile,
        AgentInteractionProfileV1::NativeCli
    );
    assert_eq!(selection.execution_profile, accounts[1].execution_profile());
    let requests = hmux.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].provider_conversation_ref.as_deref(),
        Some(CONVERSATION),
        "the next account resumes the same conversation"
    );
    RealHmux::assert_exited(&original).await;
    let operation_id = selection.selected_by_operation_id.clone().unwrap();
    // The unfinished attempt resumes as it is; reading it writes nothing.
    let Some(AgentRecoveryAttemptV1::Native(switched)) = state
        .store
        .prepare_agent_recovery(&agent_id, now_ms().unwrap(), None)
        .await
        .unwrap()
    else {
        panic!("the switch leaves one unfinished native attempt");
    };
    assert_eq!(
        agent_runtime_transition_identity(&switched.attempt_id)
            .unwrap()
            .0,
        operation_id,
        "the switch is the recovery attempt's own operation"
    );
    assert_eq!(
        switched.continuation,
        AgentNativeRecoveryContinuationV1::NotStarted
    );
    assert_eq!(switched.target.as_ref(), Some(&accounts[1]));
    let transition = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        transition.state,
        dure_app::AgentRuntimeTransitionStateV1::Committed
    );
    assert_eq!(
        transition.intent.target_interaction_profile,
        AgentInteractionProfileV1::NativeCli
    );

    // The resumed conversation is not ready yet: nothing is typed into it.
    let target = current_generation(&state, &agent_id).await;
    assert_ne!(target.terminal_epoch, source.terminal_epoch);
    assert!(
        agent_recovery::advance(&state, &agent_id)
            .await
            .unwrap()
            .owns()
    );
    assert_eq!(recovery_rows(&state, &agent_id).await, 1);
    assert!(prompts.requests().is_empty());

    // Once its Host reports the conversation waiting, it gets one prompt.
    state_reporter::report_conversation(
        &hmux,
        &target,
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        false,
        Some(CONVERSATION),
    );
    assert!(
        agent_recovery::advance(&state, &agent_id)
            .await
            .unwrap()
            .owns()
    );
    let attempt = native_attempt(&state, &switched.attempt_id).await;
    let AgentNativeRecoveryContinuationV1::Delivered { evidence } = &attempt.continuation else {
        panic!("the continuation was not delivered: {attempt:?}");
    };
    assert!(matches!(
        evidence,
        dure_app::WorkflowPromptDeliveryEvidenceV1::AgentPrompt(prompt)
            if prompt.terminal_epoch == target.terminal_epoch
    ));
    assert_eq!(attempt.stopped, None);
    assert_eq!(recovery_rows(&state, &agent_id).await, 0);
    let typed = prompts.requests();
    assert_eq!(typed.len(), 1);
    assert_eq!(typed[0].session, target);
    assert_eq!(
        typed[0].delivery_idempotency_key,
        format!("recovery:{}", attempt.attempt_id)
    );
    assert_eq!(
        typed[0].intent,
        dure_app::WorkflowPromptDeliveryIntentV1::ExistingConversation {
            provider_conversation_id: CONVERSATION.into(),
        }
    );
    assert_eq!(
        typed[0].handoff,
        "Your previous turn stopped at a usage limit. Dure moved this conversation to \
         another account; continue where you left off."
    );

    // Later wakes never type it again.
    let delivered = attempt.clone();
    assert!(
        !agent_recovery::advance(&state, &agent_id)
            .await
            .unwrap()
            .owns()
    );
    assert_eq!(
        native_attempt(&state, &delivered.attempt_id).await,
        delivered
    );
    assert_eq!(prompts.requests().len(), 1);
    agent_runtime_close_apply::apply(
        &state,
        "close-native-limit-fixture",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id,
        },
    )
    .await
    .unwrap();
}

async fn a_person_who_resumed_first_supersedes_the_attempt() {
    let NativeRecovery {
        hmux,
        state,
        agent_id,
        source,
        ..
    } = native_recovery("native-resumed").await;
    state_reporter::report_turn_failure(&hmux, &source, Some(AgentTurnFailure::UsageLimit));
    let observed = hmux_client::LocalSessionCatalog::new(&hmux.discovery)
        .find(&hmux_client::SessionSelector::new(
            &source.session_id,
            Some(source.workspace_id.clone()),
        ))
        .unwrap();
    // An earlier wake recorded the attempt and stopped before switching.
    let failure = AgentNativeTurnFailureV1 {
        terminal_epoch: source.terminal_epoch.clone(),
        attention_id: crate::query_hmux_for_runtime_transition(
            &state.hmux_identity,
            &source.session_id,
            &source.workspace_id,
            &crate::HmuxStopFence {
                runner_principal: source.runner_principal.clone(),
                runner_instance: source.runner_instance.clone(),
                channel_epoch: source.channel_epoch.clone(),
                host_instance_id: source.host_instance_id.clone(),
                terminal_epoch: source.terminal_epoch.clone(),
            },
        )
        .await
        .unwrap()
        .attention_id()
        .unwrap()
        .to_owned(),
        reason: AgentTurnFailureReasonV1::UsageLimit,
        observed_at_ms: now_ms().unwrap(),
        turn_completed_count: None,
        limit_resets_at_ms: None,
    };
    let Some(AgentRecoveryAttemptV1::Native(prepared)) = state
        .store
        .prepare_agent_recovery(&agent_id, now_ms().unwrap(), Some(&failure))
        .await
        .unwrap()
    else {
        panic!("the settled limit failure prepares a native attempt");
    };
    // Then the person resumed the conversation in the terminal.
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    assert!(
        !agent_recovery::advance(&state, &agent_id)
            .await
            .unwrap()
            .owns()
    );
    assert_eq!(
        native_attempt(&state, &prepared.attempt_id).await.stopped,
        Some(AgentRecoveryStopV1::Superseded)
    );
    assert_eq!(hmux.requests().len(), 1, "no account switch started");
    assert!(hmux.session(&source).same_generation(&observed));
    assert_eq!(
        inspect(&state, &agent_id).await["receipt"]["selectionRevision"],
        1
    );
    agent_runtime_close_apply::apply(
        &state,
        "close-native-resumed-fixture",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id,
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run pnpm test:hmux-native-account-recovery"]
async fn native_usage_limit_continues_after_the_reset_uses_real_hmux() {
    a_limit_with_a_recorded_reset_waits_for_it_without_typing().await;
    a_passed_reset_continues_in_the_same_terminal_once().await;
}

async fn a_limit_with_a_recorded_reset_waits_for_it_without_typing() {
    let NativeRecovery {
        hmux,
        state,
        agent_id,
        source,
        prompts,
        ..
    } = native_recovery("native-reset-wait").await;
    continue_after_reset_only(&state, "native-reset-wait").await;
    let reset_at_ms = (now_ms().unwrap() / 1000 + 60 * 60) * 1000;
    record_full_window(&state, reset_at_ms);
    let original = hmux.session(&source);
    state_reporter::report_turn_failure(&hmux, &source, Some(AgentTurnFailure::UsageLimit));
    let hold = agent_recovery::advance(&state, &agent_id).await.unwrap();
    let agent_recovery::AgentRecoveryHoldV1::WaitsUntil(resume_at_ms) = hold else {
        panic!("expected a wait for the recorded reset: {hold:?}");
    };
    assert!(
        (reset_at_ms + 60_000..=reset_at_ms + 180_000).contains(&resume_at_ms),
        "{resume_at_ms} vs {reset_at_ms}"
    );
    // Waiting types nothing and leaves the terminal and its account alone.
    assert!(prompts.requests().is_empty());
    assert_eq!(hmux.requests().len(), 1);
    assert!(hmux.session(&source).same_generation(&original));
    assert_eq!(recovery_rows(&state, &agent_id).await, 1);
    assert_eq!(
        agent_recovery::advance(&state, &agent_id).await,
        Ok(agent_recovery::AgentRecoveryHoldV1::WaitsUntil(
            resume_at_ms
        ))
    );
    // A person who answers in the terminal takes over the wait.
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    assert!(
        !agent_recovery::advance(&state, &agent_id)
            .await
            .unwrap()
            .owns()
    );
    assert_eq!(recovery_rows(&state, &agent_id).await, 0);
    assert!(prompts.requests().is_empty());
    agent_runtime_close_apply::apply(
        &state,
        "close-native-reset-wait-fixture",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id,
        },
    )
    .await
    .unwrap();
}

async fn a_passed_reset_continues_in_the_same_terminal_once() {
    let NativeRecovery {
        hmux,
        state,
        agent_id,
        source,
        prompts,
        ..
    } = native_recovery("native-reset-due").await;
    continue_after_reset_only(&state, "native-reset-due").await;
    let original = hmux.session(&source);
    state_reporter::report_turn_failure(&hmux, &source, Some(AgentTurnFailure::UsageLimit));
    let shown = host(&state, &source).await;
    // An earlier wake recorded this failure with the reset its login's
    // provider reported, which has passed since.
    let now = now_ms().unwrap();
    let failure = AgentNativeTurnFailureV1 {
        terminal_epoch: source.terminal_epoch.clone(),
        attention_id: shown.attention_id().unwrap().to_owned(),
        reason: AgentTurnFailureReasonV1::UsageLimit,
        observed_at_ms: now - 30 * 60 * 1000,
        turn_completed_count: shown.turn_completed_count(),
        limit_resets_at_ms: Some(now - 10 * 60 * 1000),
    };
    let Some(AgentRecoveryAttemptV1::Native(waiting)) = state
        .store
        .prepare_agent_recovery(&agent_id, failure.observed_at_ms, Some(&failure))
        .await
        .unwrap()
    else {
        panic!("the limit failure prepares a native attempt");
    };
    assert_eq!(waiting.target, None);
    assert_eq!(waiting.stopped, None);
    assert!(waiting.resume_at_ms.is_some_and(|at| at <= now));

    // Due: the same terminal gets one prompt and keeps its account.
    assert!(
        agent_recovery::advance(&state, &agent_id)
            .await
            .unwrap()
            .owns()
    );
    let attempt = native_attempt(&state, &waiting.attempt_id).await;
    assert!(
        matches!(
            attempt.continuation,
            AgentNativeRecoveryContinuationV1::Delivered { .. }
        ),
        "the continuation was not delivered: {attempt:?}"
    );
    let typed = prompts.requests();
    assert_eq!(typed.len(), 1);
    assert_eq!(typed[0].session, source);
    assert_eq!(
        typed[0].delivery_idempotency_key,
        format!("recovery:{}", attempt.attempt_id)
    );
    assert_eq!(
        typed[0].intent,
        dure_app::WorkflowPromptDeliveryIntentV1::ExistingConversation {
            provider_conversation_id: CONVERSATION.into(),
        }
    );
    assert_eq!(
        typed[0].handoff,
        "Your previous turn stopped at a usage limit, which has now reset; continue where you \
         left off."
    );
    assert_eq!(hmux.requests().len(), 1, "no account switch started");
    assert!(hmux.session(&source).same_generation(&original));
    assert_eq!(
        inspect(&state, &agent_id).await["receipt"]["selectionRevision"],
        1
    );

    // Still limited: the continued turn fails again before any turn
    // completes. The owner reads the login's recorded reset and still stops
    // for a person instead of waiting twice.
    let reset_at_ms = (now / 1000 + 60 * 60) * 1000;
    record_full_window(&state, reset_at_ms);
    state_reporter::report(
        &hmux,
        &source,
        AgentRuntimeActivity::Working,
        AgentRuntimeAttention::None,
        false,
    );
    state_reporter::report_turn_failure(&hmux, &source, Some(AgentTurnFailure::UsageLimit));
    assert_eq!(
        agent_recovery::advance(&state, &agent_id).await,
        Err("agent_recovery_accounts_exhausted")
    );
    let shown = host(&state, &source).await;
    assert_ne!(shown.attention_id(), Some(failure.attention_id.as_str()));
    let Some(AgentRecoveryAttemptV1::Native(again)) = state
        .store
        .prepare_agent_recovery(
            &agent_id,
            now_ms().unwrap(),
            Some(&AgentNativeTurnFailureV1 {
                attention_id: shown.attention_id().unwrap().to_owned(),
                ..failure
            }),
        )
        .await
        .unwrap()
    else {
        panic!("the second failure keeps its attempt");
    };
    assert_ne!(again.attempt_id, waiting.attempt_id);
    assert_eq!(again.stopped, Some(AgentRecoveryStopV1::Exhausted));
    assert_eq!(again.resume_at_ms, None);
    assert_eq!(again.native_failure.limit_resets_at_ms, Some(reset_at_ms));
    assert_eq!(prompts.requests().len(), 1);
    agent_runtime_close_apply::apply(
        &state,
        "close-native-reset-due-fixture",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id,
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires isolated real Hmux binaries; run pnpm test:hmux-native-account-recovery"]
async fn native_preserve_switch_admits_a_settled_turn_failure_uses_real_hmux() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 60\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let agent_id = AgentIdV1::new("failed-turn-native-agent").unwrap();
    let source = launch(&state, &hmux, "failed-turn-native-source").await;
    bind_source(&state, &agent_id, &source).await;
    let body = agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        target_interaction_profile: AgentInteractionProfileV1::NativeCli,
        expected_source_revision: Some(1),
        expected_operation_id: None,
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        target_execution_profile: None,
        target_launch_selection: Some(dure_app::AgentRuntimeLaunchSelectionV1 {
            model: Some(dure_app::AgentSpawnModelSelectionV1::parse("gpt-6-astra").unwrap()),
            effort: None,
            permission_mode: None,
        }),
    };
    state_reporter::report_conversation(
        &hmux,
        &source,
        AgentRuntimeActivity::Waiting,
        AgentRuntimeAttention::None,
        true,
        Some(CONVERSATION),
    );
    // An error the provider did not type still waits for a person.
    state_reporter::report_turn_failure(&hmux, &source, None);
    let error = agent_runtime_transition_apply::apply(&state, "untyped-error-switch", body.clone())
        .await
        .unwrap_err();
    assert_eq!(error.code, "agent_runtime_source_busy", "{error:?}");
    assert_eq!(hmux.requests().len(), 1);

    // The same switch at a settled limit failure keeps the conversation.
    state_reporter::report_turn_failure(&hmux, &source, Some(AgentTurnFailure::RateLimit));
    let original = hmux.session(&source);
    let receipt = agent_runtime_transition_apply::apply(&state, "failed-turn-switch", body)
        .await
        .unwrap();
    let projection = serde_json::to_value(&receipt).unwrap();
    assert_eq!(projection["selectionRevision"], 2);
    assert_eq!(projection["providerConversationRef"], CONVERSATION);
    assert_eq!(hmux.requests().len(), 2);
    RealHmux::assert_exited(&original).await;
    agent_runtime_close_apply::apply(
        &state,
        "close-failed-turn-fixture",
        agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
            schema_version: 1,
            agent_id,
        },
    )
    .await
    .unwrap();
}
