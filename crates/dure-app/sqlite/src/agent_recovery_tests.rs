use super::*;
use dure_app::{
    AgentCompleteTurnEffectV1, AgentInteractionProfileV1, AgentProviderConversationPlanV1,
    AgentQueuedTurnStore, AgentRecoveryAttemptV1, AgentRecoveryRecordV1, AgentRecoveryStopV1,
    AgentRecoveryStore, AgentRuntimeBindingAuthorityV1, AgentRuntimeSelectionV1,
    AgentRuntimeSourceStopPolicyV1, AgentRuntimeTransitionAdvanceRequestV1,
    AgentRuntimeTransitionAdvanceV1, AgentRuntimeTransitionIntentV1, AgentRuntimeTransitionStore,
    ProviderCredentialProfileV1, ProviderPermissionModeV1, ProviderRecoveryAccountV1,
    ProviderRecoveryPolicyPutV1, ProviderRecoveryStore, ProviderRecoveryUsageV1,
    agent_runtime_transition_identity,
};

fn policy() -> ProviderRecoveryPolicyPutV1 {
    let provider_id = interaction_binding().provider_id;
    ProviderRecoveryPolicyPutV1 {
        schema_version: 1,
        provider_id: provider_id.clone(),
        expected_revision: 0,
        idempotency_key: "enable-recovery".into(),
        enabled: true,
        // Each login has its own generation; account-a is the source's.
        accounts: [
            ("credential.account-a", "credential-generation-7"),
            ("credential.account-b", "credential-generation-8"),
            ("credential.account-c", "credential-generation-9"),
        ]
        .into_iter()
        .map(|(reference, generation)| ProviderRecoveryAccountV1 {
            profile: ProviderCredentialProfileV1 {
                schema_version: 1,
                provider_id: provider_id.clone(),
                reference_id: reference.into(),
                credential_generation: generation.into(),
            },
            name: reference.into(),
        })
        .collect(),
        continue_after_reset: false,
    }
}

async fn initialized(path: &std::path::Path) -> SqliteDomainStore {
    initialized_with(
        path,
        policy(),
        vec![super::failure::failure_row(1, Some("usage_limit"))],
    )
    .await
}

async fn initialized_with(
    path: &std::path::Path,
    policy: ProviderRecoveryPolicyPutV1,
    failure: Vec<dure_app::AgentTimelineMutationV1>,
) -> SqliteDomainStore {
    let store = provision(path).await;
    let binding = interaction_binding();
    store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: binding.agent_id,
            provider_id: binding.provider_id,
            interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            execution_profile: binding.execution_profile,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 100,
        })
        .await
        .unwrap();
    store
        .put_provider_recovery_policy(&policy, 100)
        .await
        .unwrap();
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    store
        .apply_agent_provider_event(&provider_event(1, failure))
        .await
        .unwrap();
    store
}

async fn prepare(store: &SqliteDomainStore) -> AgentRecoveryRecordV1 {
    store
        .prepare_agent_recovery(&interaction_binding().agent_id, 300, None)
        .await
        .unwrap()
        .and_then(AgentRecoveryAttemptV1::into_conversation)
        .unwrap()
}

async fn switch(store: &SqliteDomainStore, record: &AgentRecoveryRecordV1, attempt_id: &str) {
    let (operation_id, idempotency_key) = agent_runtime_transition_identity(attempt_id).unwrap();
    let source = store
        .agent_runtime_selection(&record.source.agent_id)
        .await
        .unwrap()
        .unwrap();
    let plan = AgentRuntimeTransitionIntentV1 {
        schema_version: 1,
        operation_id: operation_id.clone(),
        idempotency_key,
        source,
        source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol {
            binding: record.source.clone(),
        },
        source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
        provider_conversation_ref: AgentProviderConversationPlanV1::from_option(
            record.source.provider_conversation_ref.clone(),
        )
        .unwrap(),
        target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        target_execution_profile: record.target.as_ref().unwrap().execution_profile(),
        target_launch_selection: None,
        workspace_move: None,
        requested_at_ms: 310,
    };
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 320,
        })
        .await
        .unwrap();
    let binding = store
        .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
            schema_version: 1,
            interaction_session_id: record.source.interaction_session_id.clone(),
            expected_binding_revision: record.source.binding_revision,
            source: record.source.runtime.clone(),
            source_execution_profile: record.source.execution_profile.clone(),
            target: runtime(2),
            target_execution_profile: plan.target_execution_profile.clone(),
            provider_conversation_ref: record.source.provider_conversation_ref.clone(),
            replaced_at_ms: 330,
        })
        .await
        .unwrap();
    store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            expected_journal_revision: 2,
            advance: AgentRuntimeTransitionAdvanceV1::TargetStarted {
                workspace: None,
                authority: Box::new(AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding }),
                launch_idempotency_key: None,
            },
            advanced_at_ms: 340,
        })
        .await
        .unwrap();
    store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id,
            expected_journal_revision: 3,
            advance: AgentRuntimeTransitionAdvanceV1::Committed,
            advanced_at_ms: 350,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn duplicate_observers_and_restart_keep_one_attempt_and_one_turn_claim() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("recovery.sqlite");
    let store = initialized(&path).await;
    let other = SqliteDomainStore::open(&path).await.unwrap();
    let (left, right) = tokio::join!(prepare(&store), prepare(&other));
    assert_eq!(left, right);
    assert_eq!(
        left.target.as_ref().unwrap().profile.reference_id,
        "credential.account-b"
    );
    // No credential files or usage telemetry were necessary to select an
    // explicitly offered account. Launch owns actual credential failures.
    switch(&store, &left, &left.attempt_id).await;
    store.close().await;
    other.close().await;
    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(prepare(&store).await, left);
    let other = SqliteDomainStore::open(&path).await.unwrap();
    let (first, second) = tokio::join!(
        store.prepare_agent_recovery_turn(&left.attempt_id, 400),
        other.prepare_agent_recovery_turn(&left.attempt_id, 401),
    );
    let first = first.unwrap().unwrap();
    let second = second.unwrap().unwrap();
    assert_ne!(first.newly_prepared, second.newly_prepared);
    assert_eq!(first.intent, second.intent);
    assert_eq!(first.intent.input, start_turn().input);
    assert_eq!(first.intent.runtime, runtime(2));
    assert_eq!(
        tail(&store)
            .await
            .rows
            .iter()
            .filter(|row| row.item.turn_id.as_ref() == Some(&first.intent.turn_id))
            .count(),
        2
    );
    store.close().await;
    other.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    let replay = reopened
        .prepare_agent_recovery_turn(&left.attempt_id, 500)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replay.state, AgentTurnEffectStateV1::Uncertain);
    assert!(!replay.newly_prepared);
}

#[tokio::test]
async fn queued_human_direction_wins_after_the_account_transition() {
    let root = TempDir::new().unwrap();
    let store = initialized(&root.path().join("queued.sqlite")).await;
    let record = prepare(&store).await;
    let human = AgentStartTurnIntentV1 {
        turn_id: AgentTurnIdV1::new("human-turn").unwrap(),
        client_message_id: AgentClientMessageIdV1::new("human-input").unwrap(),
        input: "Follow the revised brief".into(),
        ..start_turn()
    };
    store.enqueue_agent_turn(&human).await.unwrap();
    switch(&store, &record, &record.attempt_id).await;
    assert!(
        store
            .prepare_agent_recovery_turn(&record.attempt_id, 400)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .agent_recovery(&record.attempt_id)
            .await
            .unwrap()
            .and_then(AgentRecoveryAttemptV1::into_conversation)
            .unwrap()
            .stopped,
        Some(AgentRecoveryStopV1::Superseded)
    );
    let binding = tail(&store).await.binding;
    let queued = store
        .prepare_queued_agent_turn(&binding.interaction_session_id, &binding.runtime, 410)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(queued.intent.input, human.input);
    assert_eq!(queued.intent.runtime, runtime(2));
}

#[tokio::test]
async fn an_intervening_manual_switch_to_the_same_account_does_not_authorize_resend() {
    let root = TempDir::new().unwrap();
    let store = initialized(&root.path().join("manual.sqlite")).await;
    let record = prepare(&store).await;
    switch(&store, &record, "explicit-human-selection").await;
    assert!(
        store
            .prepare_agent_recovery_turn(&record.attempt_id, 400)
            .await
            .unwrap()
            .is_none()
    );
    assert!(tail(&store).await.active_turn.is_none());
}

#[tokio::test]
async fn disabled_policy_and_failed_attempt_are_not_retried_after_reopen() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("disabled.sqlite");
    let store = initialized(&path).await;
    let mut disabled = policy();
    disabled.expected_revision = 1;
    disabled.idempotency_key = "disable".into();
    disabled.enabled = false;
    store
        .put_provider_recovery_policy(&disabled, 250)
        .await
        .unwrap();
    assert!(
        store
            .prepare_agent_recovery(&interaction_binding().agent_id, 300, None)
            .await
            .unwrap()
            .and_then(AgentRecoveryAttemptV1::into_conversation)
            .is_none()
    );
    disabled.expected_revision = 2;
    disabled.idempotency_key = "enable".into();
    disabled.enabled = true;
    store
        .put_provider_recovery_policy(&disabled, 300)
        .await
        .unwrap();
    assert!(
        store
            .prepare_agent_recovery(&interaction_binding().agent_id, 400, None)
            .await
            .unwrap()
            .and_then(AgentRecoveryAttemptV1::into_conversation)
            .is_none(),
        "reenabling does not replay an older failure"
    );
    store
        .apply_agent_provider_event(&provider_event(
            2,
            vec![super::failure::failure_row(200, Some("usage_limit"))],
        ))
        .await
        .unwrap();
    let record = prepare(&store).await;
    let stopped = store
        .stop_agent_recovery(
            &record.attempt_id,
            &AgentRecoveryStopV1::Failed {
                code: "credential_unavailable".into(),
            },
        )
        .await
        .unwrap()
        .into_conversation()
        .unwrap();
    store.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(prepare(&reopened).await, stopped);
    assert!(
        reopened
            .prepare_agent_recovery_turn(&record.attempt_id, 500)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn fresh_usage_precedes_unknown_and_recent_limits_survive_restart() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("usage.sqlite");
    let store = initialized(&path).await;
    let profiles = policy().accounts;
    store
        .observe_provider_recovery_usage(&ProviderRecoveryUsageV1 {
            profile: profiles[2].profile.clone(),
            used_percent: Some(25.0),
            observed_at_ms: 250,
        })
        .await
        .unwrap();
    let record = prepare(&store).await;
    assert_eq!(record.target.as_ref().unwrap().profile, profiles[2].profile);
    // An older poll cannot erase the more recent provider failure.
    store
        .observe_provider_recovery_usage(&ProviderRecoveryUsageV1 {
            profile: profiles[0].profile.clone(),
            used_percent: Some(0.0),
            observed_at_ms: 150,
        })
        .await
        .unwrap();
    store.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    reopened
        .observe_provider_recovery_usage(&ProviderRecoveryUsageV1 {
            profile: profiles[0].profile.clone(),
            used_percent: None,
            observed_at_ms: 350,
        })
        .await
        .unwrap();
    let mut connection = reopened.pool.acquire().await.unwrap();
    let source = profiles[2].execution_profile();
    let picked =
        crate::provider_recovery_usage::select_on(&mut connection, &profiles, &source, &[], 400)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(picked.profile, profiles[1].profile);
    crate::provider_recovery_usage::report_limit_on(
        &mut connection,
        &profiles[1].profile.provider_id,
        &profiles[1].execution_profile(),
        410,
    )
    .await
    .unwrap();
    assert!(
        crate::provider_recovery_usage::select_on(&mut connection, &profiles, &source, &[], 420)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        crate::provider_recovery_usage::select_on(
            &mut connection,
            &profiles,
            &source,
            &[],
            31 * 60 * 1000
        )
        .await
        .unwrap()
        .is_some(),
        "stale telemetry does not deny a configured account"
    );
}

#[tokio::test]
async fn removing_permission_or_changing_the_goal_prevents_retained_resend() {
    use dure_app::{AgentGoalPutRequestV1, AgentGoalStatusV1, AgentGoalStore};
    for boundary in ["disabled", "reenabled", "removed", "goal_changed"] {
        let root = TempDir::new().unwrap();
        let store = initialized(&root.path().join("direction.sqlite")).await;
        let record = prepare(&store).await;
        switch(&store, &record, &record.attempt_id).await;
        if boundary == "goal_changed" {
            store
                .put_agent_goal(
                    &AgentGoalPutRequestV1 {
                        schema_version: 1,
                        agent_id: record.source.agent_id.clone(),
                        expected_revision: 0,
                        idempotency_key: "new-direction".into(),
                        objective: "Follow the new shared direction".into(),
                        status: AgentGoalStatusV1::Active,
                        detail: None,
                    },
                    360,
                )
                .await
                .unwrap();
        } else {
            let mut changed = policy();
            changed.expected_revision = 1;
            changed.idempotency_key = "change-policy".into();
            if boundary == "removed" {
                changed.accounts.retain(|account| {
                    Some(&account.profile) != record.target.as_ref().map(|target| &target.profile)
                });
            } else {
                changed.enabled = false;
            }
            store
                .put_provider_recovery_policy(&changed, 360)
                .await
                .unwrap();
            if boundary == "reenabled" {
                changed.expected_revision = 2;
                changed.idempotency_key = "enable-again".into();
                changed.enabled = true;
                store
                    .put_provider_recovery_policy(&changed, 370)
                    .await
                    .unwrap();
            }
        }
        assert!(
            store
                .prepare_agent_recovery_turn(&record.attempt_id, 400)
                .await
                .unwrap()
                .is_none(),
            "{boundary}"
        );
        assert!(tail(&store).await.active_turn.is_none(), "{boundary}");
        assert_eq!(
            store
                .agent_recovery(&record.attempt_id)
                .await
                .unwrap()
                .and_then(AgentRecoveryAttemptV1::into_conversation)
                .unwrap()
                .stopped,
            Some(AgentRecoveryStopV1::Superseded),
            "{boundary}"
        );
    }
}

#[tokio::test]
async fn recovered_goal_input_keeps_its_origin_and_the_goal_can_continue() {
    use dure_app::{
        AgentGoalPutRequestV1, AgentGoalStatusV1, AgentGoalStore, AgentGoalTurnRequestV1,
    };
    for (pause_before_failure, has_client_id) in [(false, true), (false, false), (true, true)] {
        let root = TempDir::new().unwrap();
        let store = initialized(&root.path().join("goal.sqlite")).await;
        let agent_id = interaction_binding().agent_id;
        store
            .put_agent_goal(
                &AgentGoalPutRequestV1 {
                    schema_version: 1,
                    agent_id: agent_id.clone(),
                    expected_revision: 0,
                    idempotency_key: "goal".into(),
                    objective: "Finish the team's brief".into(),
                    status: AgentGoalStatusV1::Active,
                    detail: None,
                },
                210,
            )
            .await
            .unwrap();
        let request = AgentGoalTurnRequestV1 {
            agent_id: agent_id.clone(),
            goal_revision: 1,
            expected_cursor: tail(&store).await.final_cursor,
            intent: AgentStartTurnIntentV1 {
                turn_id: AgentTurnIdV1::new("goal-segment").unwrap(),
                client_message_id: AgentClientMessageIdV1::new("goal-input").unwrap(),
                input: "Continue the explicitly entrusted goal".into(),
                requested_at_ms: 220,
                ..start_turn()
            },
        };
        store
            .prepare_agent_goal_turn(&request)
            .await
            .unwrap()
            .unwrap();
        if pause_before_failure {
            let goal = store.agent_goal(&agent_id).await.unwrap().unwrap();
            store
                .put_agent_goal(
                    &AgentGoalPutRequestV1 {
                        schema_version: 1,
                        agent_id: agent_id.clone(),
                        expected_revision: goal.revision,
                        idempotency_key: "pause-before-failure".into(),
                        objective: goal.objective,
                        status: AgentGoalStatusV1::Paused,
                        detail: None,
                    },
                    229,
                )
                .await
                .unwrap();
        }
        let mut failure = super::failure::failure_row(30, Some("usage_limit"));
        if let AgentTimelineMutationV1::Append { item } = &mut failure {
            item.turn_id = Some(request.intent.turn_id.clone());
            item.client_message_id =
                has_client_id.then(|| request.intent.client_message_id.clone());
        }
        store
            .apply_agent_provider_event(&provider_event(2, vec![failure]))
            .await
            .unwrap();
        assert!(
            tail(&store)
                .await
                .latest_failure
                .unwrap()
                .user_input
                .is_none()
        );
        if pause_before_failure {
            assert!(
                store
                    .prepare_agent_recovery(&agent_id, 300, None)
                    .await
                    .unwrap()
                    .and_then(AgentRecoveryAttemptV1::into_conversation)
                    .is_none(),
                "a paused goal must not start a new account transition"
            );
            continue;
        }
        let record = prepare(&store).await;
        assert_eq!(record.input, request.intent.input);
        switch(&store, &record, &record.attempt_id).await;
        assert_eq!(
            tail(&store).await.latest_failure,
            Some(record.failure.clone()),
            "replacement must preserve a turn-ID-only terminal failure"
        );
        let resumed = store
            .prepare_agent_recovery_turn(&record.attempt_id, 400)
            .await
            .unwrap()
            .unwrap();
        assert!(
            tail(&store)
                .await
                .rows
                .iter()
                .any(|row| row.item.client_message_id.as_ref()
                    == Some(&resumed.intent.client_message_id)
                    && matches!(
                        &row.item.body,
                        AgentTimelineItemBodyV1::GoalContinuation {
                            goal_revision: 1,
                            ..
                        }
                    )),
            "automatic recovery must not become a human message"
        );
        store
            .complete_agent_turn_effect(&dure_app::AgentCompleteTurnEffectV1 {
                schema_version: 1,
                interaction_session_id: resumed.intent.interaction_session_id.clone(),
                runtime: resumed.intent.runtime.clone(),
                client_message_id: resumed.intent.client_message_id.clone(),
                state: AgentTurnEffectStateV1::Accepted,
                provider_receipt: None,
                updated_at_ms: 410,
            })
            .await
            .unwrap();
        let mut completed = session_lifecycle(
            "recovered-complete",
            AgentTimelineLifecycleStateV1::TurnCompleted,
            420,
        );
        if let AgentTimelineMutationV1::Append { item } = &mut completed {
            item.turn_id = Some(resumed.intent.turn_id);
            item.client_message_id = Some(resumed.intent.client_message_id);
        }
        let mut event = provider_event(1, vec![completed]);
        event.event.runtime = runtime(2);
        store.apply_agent_provider_event(&event).await.unwrap();
        let next = AgentGoalTurnRequestV1 {
            agent_id,
            goal_revision: 1,
            expected_cursor: tail(&store).await.final_cursor,
            intent: AgentStartTurnIntentV1 {
                turn_id: AgentTurnIdV1::new("next-goal-segment").unwrap(),
                client_message_id: AgentClientMessageIdV1::new("next-goal-input").unwrap(),
                runtime: runtime(2),
                requested_at_ms: 430,
                ..request.intent
            },
        };
        assert!(
            store
                .prepare_agent_goal_turn(&next)
                .await
                .unwrap()
                .is_some(),
            "the recovered quota failure must not fail the next goal segment"
        );
        assert_eq!(
            store
                .agent_goal(&next.agent_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            AgentGoalStatusV1::Active
        );
    }
}

#[tokio::test]
async fn recovery_observation_tracks_its_own_turn_and_expires_on_new_human_input() {
    let root = TempDir::new().unwrap();
    let store = initialized(&root.path().join("observation.sqlite")).await;
    let record = prepare(&store).await;
    switch(&store, &record, &record.attempt_id).await;
    let turn = store
        .prepare_agent_recovery_turn(&record.attempt_id, 400)
        .await
        .unwrap()
        .unwrap();
    store
        .complete_agent_turn_effect(&AgentCompleteTurnEffectV1 {
            schema_version: 1,
            interaction_session_id: turn.intent.interaction_session_id.clone(),
            runtime: turn.intent.runtime.clone(),
            client_message_id: turn.intent.client_message_id.clone(),
            state: AgentTurnEffectStateV1::Failed,
            provider_receipt: None,
            updated_at_ms: 450,
        })
        .await
        .unwrap();
    let page = tail(&store).await;
    assert_ne!(
        page.latest_failure.as_ref().unwrap().item_id,
        record.failure.item_id
    );
    assert_eq!(
        page.recovery.unwrap().turn_state,
        Some(AgentTurnEffectStateV1::Failed)
    );
    let mut next = start_turn();
    next.runtime = runtime(2);
    next.turn_id = AgentTurnIdV1::new("later-human-turn").unwrap();
    next.client_message_id = AgentClientMessageIdV1::new("later-human-message").unwrap();
    next.requested_at_ms = 500;
    store.record_agent_turn_intent(&next).await.unwrap();
    assert!(
        tail(&store).await.recovery.is_none(),
        "a new human turn must replace the recovery outcome"
    );
    assert!(
        store
            .latest_agent_recovery(&record.source.agent_id)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn accepted_recovery_does_not_hide_a_new_provider_failure() {
    let root = TempDir::new().unwrap();
    let store = initialized(&root.path().join("rejected-again.sqlite")).await;
    let record = prepare(&store).await;
    switch(&store, &record, &record.attempt_id).await;
    let turn = store
        .prepare_agent_recovery_turn(&record.attempt_id, 400)
        .await
        .unwrap()
        .unwrap();
    store
        .complete_agent_turn_effect(&AgentCompleteTurnEffectV1 {
            schema_version: 1,
            interaction_session_id: turn.intent.interaction_session_id.clone(),
            runtime: turn.intent.runtime.clone(),
            client_message_id: turn.intent.client_message_id.clone(),
            state: AgentTurnEffectStateV1::Accepted,
            provider_receipt: None,
            updated_at_ms: 410,
        })
        .await
        .unwrap();
    let mut failure = super::failure::failure_row(300, Some("usage_limit"));
    if let AgentTimelineMutationV1::Append { item } = &mut failure {
        item.turn_id = Some(turn.intent.turn_id);
        item.client_message_id = Some(turn.intent.client_message_id);
    }
    let mut event = provider_event(1, vec![failure]);
    event.event.runtime = runtime(2);
    store.apply_agent_provider_event(&event).await.unwrap();
    let page = tail(&store).await;
    assert!(page.latest_failure.is_some());
    assert!(
        page.recovery.is_none(),
        "an accepted send is not a successful recovery of a later failure"
    );
}

mod native {
    use super::*;
    use dure_app::{
        AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AgentCheckpointBindingAuthorityV1,
        AgentNativeRecoveryContinuationV1, AgentNativeRecoveryRecordV1, AgentNativeTurnFailureV1,
        AgentTurnFailureReasonV1, WorkflowPromptDeliveryEvidenceV1,
    };

    fn agent() -> AgentIdV1 {
        interaction_binding().agent_id
    }

    fn failure(reason: AgentTurnFailureReasonV1, attention: &str) -> AgentNativeTurnFailureV1 {
        AgentNativeTurnFailureV1 {
            terminal_epoch: "terminal-epoch-1".into(),
            attention_id: attention.into(),
            reason,
            observed_at_ms: 200,
            turn_completed_count: Some(3),
            limit_resets_at_ms: None,
        }
    }

    /// A limit failure whose login's provider reported when it resets.
    fn reset_failure(attention: &str, resets_at_ms: i64) -> AgentNativeTurnFailureV1 {
        AgentNativeTurnFailureV1 {
            limit_resets_at_ms: Some(resets_at_ms),
            ..failure(AgentTurnFailureReasonV1::UsageLimit, attention)
        }
    }

    /// Types the attempt's continuation, as the owner does once it is due.
    async fn deliver(store: &SqliteDomainStore, attempt_id: &str) {
        store
            .claim_native_agent_recovery_continuation(attempt_id, "recovery:typed")
            .await
            .unwrap();
        let evidence = WorkflowPromptDeliveryEvidenceV1::agent_prompt(
            "terminal-epoch-1",
            "record-1",
            "41",
            Some("7".into()),
        );
        store
            .settle_native_agent_recovery_continuation(attempt_id, Some(&evidence))
            .await
            .unwrap();
    }

    fn authority() -> AgentCheckpointBindingAuthorityV1 {
        AgentCheckpointBindingAuthorityV1 {
            schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
            binding: SessionBindingRecordV1 {
                agent_id: agent(),
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                session_id: "hmux-session-1".into(),
                provider_conversation_id: Some("conversation-1".into()),
                credential_reference_id: Some("credential.account-a".into()),
                binding_generation: 1,
                bound_at_ms: 4,
            },
            runtime_workspace_id: "workspace-1".into(),
            runner_principal: "runner-principal-1".into(),
            runner_instance: "runner-instance-1".into(),
            channel_epoch: "1".into(),
            host_instance_id: "host-instance-1".into(),
            terminal_epoch: "terminal-epoch-1".into(),
            updated_at_ms: 100,
        }
    }

    fn selection(profile: AgentInteractionProfileV1) -> AgentRuntimeSelectionV1 {
        let binding = interaction_binding();
        AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: binding.agent_id,
            provider_id: binding.provider_id,
            interaction_profile: profile,
            execution_profile: binding.execution_profile,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 100,
        }
    }

    /// A terminal Agent on account A whose provider recovers over the
    /// configured pool. Its timeline holds no failure: only the Host knows.
    async fn native_store(
        path: &std::path::Path,
        profile: AgentInteractionProfileV1,
        policy: ProviderRecoveryPolicyPutV1,
    ) -> SqliteDomainStore {
        let store = provision(path).await;
        store
            .initialize_agent_runtime_selection(&selection(profile))
            .await
            .unwrap();
        store
            .upsert_agent_checkpoint_binding_authority(&authority())
            .await
            .unwrap();
        store
            .put_provider_recovery_policy(&policy, 100)
            .await
            .unwrap();
        store
    }

    fn only_the_source_account() -> ProviderRecoveryPolicyPutV1 {
        let mut policy = policy();
        policy.accounts.truncate(1);
        policy
    }

    async fn prepare_native(
        store: &SqliteDomainStore,
        native: &AgentNativeTurnFailureV1,
    ) -> Option<AgentNativeRecoveryRecordV1> {
        match store
            .prepare_agent_recovery(&agent(), 300, Some(native))
            .await
            .unwrap()
        {
            Some(AgentRecoveryAttemptV1::Native(record)) => Some(*record),
            Some(AgentRecoveryAttemptV1::Conversation(record)) => {
                panic!("a native failure prepared a conversation attempt: {record:?}")
            }
            None => None,
        }
    }

    async fn rows(store: &SqliteDomainStore, predicate: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(format!(
            "SELECT COUNT(*) FROM agent_recoveries WHERE {predicate}"
        )))
        .fetch_one(&store.pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn native_limit_failure_prepares_one_attempt_on_the_next_account() {
        let root = TempDir::new().unwrap();
        for reason in [
            AgentTurnFailureReasonV1::RateLimit,
            AgentTurnFailureReasonV1::UsageLimit,
        ] {
            let path = root.path().join(format!("{}.sqlite", reason.as_token()));
            let store = native_store(&path, AgentInteractionProfileV1::NativeCli, policy()).await;
            let native = failure(reason, "attention-3");
            let record = prepare_native(&store, &native).await.unwrap();
            assert_eq!(
                record
                    .target
                    .as_ref()
                    .map(|target| target.profile.reference_id.as_str()),
                Some("credential.account-b")
            );
            assert_eq!(record.native_failure, native);
            assert_eq!(record.source_selection_revision, 1);
            assert_eq!(
                record.continuation,
                AgentNativeRecoveryContinuationV1::NotStarted
            );
            assert_eq!(record.stopped, None);
            assert!(agent_runtime_transition_identity(&record.attempt_id).is_ok());
            // The Host's failure episode is the identity: a repeated
            // observation and a reopened store find the same attempt.
            assert_eq!(
                prepare_native(&store, &native).await.as_ref(),
                Some(&record)
            );
            store.close().await;
            let reopened = SqliteDomainStore::open(&path).await.unwrap();
            assert_eq!(
                prepare_native(&reopened, &native)
                    .await
                    .map(|record| record.attempt_id),
                Some(record.attempt_id)
            );
            reopened.close().await;
        }
    }

    #[tokio::test]
    async fn native_failures_that_cannot_recover_write_no_attempt() {
        let root = TempDir::new().unwrap();
        let rate_limit = failure(AgentTurnFailureReasonV1::RateLimit, "attention-3");

        let store = native_store(
            &root.path().join("provider-error.sqlite"),
            AgentInteractionProfileV1::NativeCli,
            policy(),
        )
        .await;
        let provider_error = failure(AgentTurnFailureReasonV1::ProviderError, "attention-3");
        assert_eq!(prepare_native(&store, &provider_error).await, None);
        // An episode the checkpoint's Host generation did not see.
        let elsewhere = AgentNativeTurnFailureV1 {
            terminal_epoch: "terminal-epoch-2".into(),
            ..rate_limit.clone()
        };
        assert_eq!(prepare_native(&store, &elsewhere).await, None);
        // A failure from before recovery was enabled is not replayed.
        let earlier = AgentNativeTurnFailureV1 {
            observed_at_ms: 50,
            ..rate_limit.clone()
        };
        assert_eq!(prepare_native(&store, &earlier).await, None);
        assert_eq!(rows(&store, "1").await, 0);

        let mut disabled = policy();
        disabled.enabled = false;
        let store = native_store(
            &root.path().join("disabled.sqlite"),
            AgentInteractionProfileV1::NativeCli,
            disabled,
        )
        .await;
        assert_eq!(prepare_native(&store, &rate_limit).await, None);
        assert_eq!(rows(&store, "1").await, 0);

        let store = native_store(
            &root.path().join("structured.sqlite"),
            AgentInteractionProfileV1::StructuredProtocol,
            policy(),
        )
        .await;
        assert_eq!(prepare_native(&store, &rate_limit).await, None);
        assert_eq!(rows(&store, "1").await, 0);

        // A runtime change already in flight owns the Agent.
        let store = native_store(
            &root.path().join("transitioning.sqlite"),
            AgentInteractionProfileV1::NativeCli,
            policy(),
        )
        .await;
        let (operation_id, idempotency_key) =
            agent_runtime_transition_identity("manual-switch").unwrap();
        store
            .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
                schema_version: 1,
                operation_id,
                idempotency_key,
                source: selection(AgentInteractionProfileV1::NativeCli),
                source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                    authority: authority(),
                },
                source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
                provider_conversation_ref: AgentProviderConversationPlanV1::resume(
                    "conversation-1",
                )
                .unwrap(),
                target_interaction_profile: AgentInteractionProfileV1::NativeCli,
                target_execution_profile: policy().accounts[2].execution_profile(),
                target_launch_selection: None,
                workspace_move: None,
                requested_at_ms: 250,
            })
            .await
            .unwrap();
        assert_eq!(prepare_native(&store, &rate_limit).await, None);
        assert_eq!(rows(&store, "1").await, 0);
    }

    #[tokio::test]
    async fn a_native_limit_without_another_account_is_saved_exhausted() {
        let root = TempDir::new().unwrap();
        let store = native_store(
            &root.path().join("exhausted.sqlite"),
            AgentInteractionProfileV1::NativeCli,
            only_the_source_account(),
        )
        .await;
        let native = failure(AgentTurnFailureReasonV1::UsageLimit, "attention-3");
        let record = prepare_native(&store, &native).await.unwrap();
        assert_eq!(record.target, None);
        assert_eq!(record.stopped, Some(AgentRecoveryStopV1::Exhausted));
        assert_eq!(prepare_native(&store, &native).await, Some(record));
        // A recorded reset waits only when continuing after a reset is on.
        let record = prepare_native(&store, &reset_failure("attention-4", 10_000))
            .await
            .unwrap();
        assert_eq!(record.resume_at_ms, None);
        assert_eq!(record.stopped, Some(AgentRecoveryStopV1::Exhausted));
        assert!(
            serde_json::to_value(&record)
                .unwrap()
                .get("resumeAtMs")
                .is_none(),
            "a record that does not wait keeps its stored shape"
        );
    }

    #[tokio::test]
    async fn a_native_limit_with_a_recorded_reset_waits_once_in_its_terminal() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("native-reset.sqlite");
        // Continuing after a reset alone recovers a single account and arms
        // the Host scanner.
        let store = native_store(
            &path,
            AgentInteractionProfileV1::NativeCli,
            continue_policy(),
        )
        .await;
        let candidate = |unfinished_attempt| {
            vec![crate::NativeRecoveryCandidateV1 {
                agent_id: agent(),
                unfinished_attempt,
            }]
        };
        assert_eq!(
            store
                .agent_native_recovery_candidates(None, 128)
                .await
                .unwrap(),
            candidate(false)
        );
        let native = reset_failure("attention-3", 10_000);
        let record = prepare_native(&store, &native).await.unwrap();
        assert_eq!(record.target, None);
        assert_eq!(record.stopped, None);
        assert_eq!(record.native_failure, native);
        let resume_at_ms = record.resume_at_ms.unwrap();
        assert!((70_000..=190_000).contains(&resume_at_ms), "{resume_at_ms}");
        // The wait is unfinished work: it survives a restart, and the
        // scanner and the continuation loop keep waking it.
        store.close().await;
        let store = SqliteDomainStore::open(&path).await.unwrap();
        assert_eq!(
            prepare_native(&store, &native).await.as_ref(),
            Some(&record)
        );
        assert_eq!(
            store
                .agent_native_recovery_candidates(None, 128)
                .await
                .unwrap(),
            candidate(true)
        );
        assert!(
            store
                .agents_with_recovery()
                .await
                .unwrap()
                .contains(&agent())
        );
        // Clients list the terminal's wait the same way as a Chat agent's.
        let wait = dure_app::AgentRecoveryWaitV1 {
            agent_id: agent(),
            attempt_id: record.attempt_id.clone(),
            resume_at_ms,
        };
        assert_eq!(store.agent_recovery_waits().await.unwrap(), vec![wait]);
        deliver(&store, &record.attempt_id).await;
        // Once its prompt is typed, the terminal no longer waits.
        assert_eq!(store.agent_recovery_waits().await.unwrap(), Vec::new());

        // Still limited: the continued turn fails again before any turn
        // completes, so recovery stops for a person instead of waiting
        // a second time. An unknown count is no proof of a completed turn.
        for (attention, turn_completed_count) in [("attention-4", Some(3)), ("attention-5", None)] {
            let again = prepare_native(
                &store,
                &AgentNativeTurnFailureV1 {
                    turn_completed_count,
                    ..reset_failure(attention, 400_000)
                },
            )
            .await
            .unwrap();
            assert_ne!(again.attempt_id, record.attempt_id);
            assert_eq!(again.resume_at_ms, None, "{attention}");
            assert_eq!(again.stopped, Some(AgentRecoveryStopV1::Exhausted));
        }

        // A turn that completed since ends the chain: the next limit waits.
        let later = prepare_native(
            &store,
            &AgentNativeTurnFailureV1 {
                turn_completed_count: Some(4),
                ..reset_failure("attention-6", 400_000)
            },
        )
        .await
        .unwrap();
        assert_eq!(later.stopped, None);
        assert!(later.resume_at_ms.is_some_and(|at| at > 400_000));
        // An Exhausted attempt never lists; the new wait does.
        assert_eq!(
            store
                .agent_recovery_waits()
                .await
                .unwrap()
                .into_iter()
                .map(|wait| wait.attempt_id)
                .collect::<Vec<_>>(),
            vec![later.attempt_id]
        );
    }

    #[tokio::test]
    async fn only_a_continued_wait_counts_and_only_a_plausible_reset_waits() {
        let root = TempDir::new().unwrap();
        let store = native_store(
            &root.path().join("native-reset-rules.sqlite"),
            AgentInteractionProfileV1::NativeCli,
            continue_policy(),
        )
        .await;
        // A wait a person took over never typed anything: it is no wait.
        let first = prepare_native(&store, &reset_failure("attention-3", 10_000))
            .await
            .unwrap();
        store
            .stop_agent_recovery(&first.attempt_id, &AgentRecoveryStopV1::Superseded)
            .await
            .unwrap();
        let next = prepare_native(&store, &reset_failure("attention-4", 20_000))
            .await
            .unwrap();
        assert!(next.resume_at_ms.is_some_and(|at| at > 20_000));
        store
            .stop_agent_recovery(&next.attempt_id, &AgentRecoveryStopV1::Superseded)
            .await
            .unwrap();
        // A reset before the failure, or more than eight days (past the
        // longest provider window) after it, is not one the provider could
        // have reported for it.
        let past_the_longest_window = 200 + 8 * 24 * 60 * 60 * 1000 + 1;
        for (attention, reset) in [
            ("attention-5", 200),
            ("attention-6", past_the_longest_window),
        ] {
            let record = prepare_native(&store, &reset_failure(attention, reset))
                .await
                .unwrap();
            assert_eq!(record.resume_at_ms, None, "{attention}");
            assert_eq!(record.stopped, Some(AgentRecoveryStopV1::Exhausted));
        }

        // An account to switch to wins over waiting.
        let store = native_store(
            &root.path().join("native-switch-first.sqlite"),
            AgentInteractionProfileV1::NativeCli,
            ProviderRecoveryPolicyPutV1 {
                continue_after_reset: true,
                ..policy()
            },
        )
        .await;
        let record = prepare_native(&store, &reset_failure("attention-3", 10_000))
            .await
            .unwrap();
        assert!(record.target.is_some());
        assert_eq!(record.resume_at_ms, None);
    }

    #[tokio::test]
    async fn native_attempt_rows_stay_out_of_conversation_queries() {
        let root = TempDir::new().unwrap();
        let store = native_store(
            &root.path().join("queries.sqlite"),
            AgentInteractionProfileV1::NativeCli,
            policy(),
        )
        .await;
        let first = prepare_native(
            &store,
            &failure(AgentTurnFailureReasonV1::RateLimit, "attention-3"),
        )
        .await
        .unwrap();
        // Queries written before native attempts never select one, so a
        // downgraded backend leaves them alone.
        assert_eq!(
            rows(
                &store,
                "json_extract(record_json, '$.stopped') IS NULL \
                 AND json_extract(record_json, '$.continuation') IS NULL"
            )
            .await,
            0
        );
        assert_eq!(
            rows(
                &store,
                "json_extract(record_json, '$.source.interactionSessionId') IS NOT NULL"
            )
            .await,
            0
        );
        assert_eq!(store.latest_agent_recovery(&agent()).await.unwrap(), None);
        assert!(
            store
                .agents_with_recovery()
                .await
                .unwrap()
                .contains(&agent())
        );
        let candidates = store
            .agent_native_recovery_candidates(None, 128)
            .await
            .unwrap();
        assert_eq!(
            candidates,
            vec![crate::NativeRecoveryCandidateV1 {
                agent_id: agent(),
                unfinished_attempt: true,
            }]
        );

        // One claim owns the prompt; a second claim changes nothing.
        let claimed = store
            .claim_native_agent_recovery_continuation(&first.attempt_id, "recovery:first")
            .await
            .unwrap();
        let owned = AgentNativeRecoveryContinuationV1::Claimed {
            delivery_idempotency_key: "recovery:first".into(),
        };
        assert_eq!(claimed.continuation, owned);
        assert_eq!(
            store
                .claim_native_agent_recovery_continuation(&first.attempt_id, "recovery:other")
                .await
                .unwrap()
                .continuation,
            owned
        );
        // Nothing written releases it; a delivery settles it for good.
        assert_eq!(
            store
                .settle_native_agent_recovery_continuation(&first.attempt_id, None)
                .await
                .unwrap()
                .continuation,
            AgentNativeRecoveryContinuationV1::NotStarted
        );
        store
            .claim_native_agent_recovery_continuation(&first.attempt_id, "recovery:first")
            .await
            .unwrap();
        let evidence = WorkflowPromptDeliveryEvidenceV1::agent_prompt(
            "terminal-epoch-2",
            "record-1",
            "41",
            Some("7".into()),
        );
        let delivered = store
            .settle_native_agent_recovery_continuation(&first.attempt_id, Some(&evidence))
            .await
            .unwrap();
        assert_eq!(
            delivered.continuation,
            AgentNativeRecoveryContinuationV1::Delivered { evidence }
        );
        // A delivered continuation cannot be stopped, resent or resumed.
        let stop = AgentRecoveryStopV1::Failed {
            code: "late".into(),
        };
        assert_eq!(
            store
                .stop_agent_recovery(&first.attempt_id, &stop)
                .await
                .unwrap()
                .stopped(),
            None
        );
        assert_eq!(
            store
                .claim_native_agent_recovery_continuation(&first.attempt_id, "recovery:again")
                .await
                .unwrap(),
            delivered
        );
        assert!(
            store
                .agent_native_recovery_candidates(None, 128)
                .await
                .unwrap()
                .iter()
                .all(|candidate| !candidate.unfinished_attempt)
        );

        // Unfinished attempts, claimed or not, can still be stopped.
        for (attention, claim) in [("attention-4", false), ("attention-5", true)] {
            let record = prepare_native(
                &store,
                &failure(AgentTurnFailureReasonV1::UsageLimit, attention),
            )
            .await
            .unwrap();
            if claim {
                store
                    .claim_native_agent_recovery_continuation(&record.attempt_id, "recovery:x")
                    .await
                    .unwrap();
            }
            assert_eq!(
                store
                    .stop_agent_recovery(&record.attempt_id, &stop)
                    .await
                    .unwrap()
                    .stopped(),
                Some(&stop),
                "{attention}"
            );
        }
    }
}

#[tokio::test]
async fn set_aside_logins_are_skipped_until_none_remains() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("reselect.sqlite");
    let store = initialized(&path).await;
    let profiles = policy().accounts;
    let first = prepare(&store).await;
    // Account-a is the source; unknown usage keeps policy order.
    assert_eq!(first.target.as_ref().unwrap().profile, profiles[1].profile);
    assert!(
        serde_json::to_value(&first)
            .unwrap()
            .get("unusableTargets")
            .is_none(),
        "a record with nothing set aside keeps its stored shape"
    );
    // Fresh usage alone reorders the choice and keeps the first transition.
    store
        .observe_provider_recovery_usage(&ProviderRecoveryUsageV1 {
            profile: profiles[2].profile.clone(),
            used_percent: Some(10.0),
            observed_at_ms: 290,
        })
        .await
        .unwrap();
    let reordered = store
        .reselect_agent_recovery_target(&first.attempt_id, &[], None, 300)
        .await
        .unwrap();
    assert!(reordered.unusable_targets().is_empty());
    assert_eq!(reordered.runtime_attempt_id(), first.attempt_id);
    let reordered = reordered.into_conversation().unwrap();
    assert_eq!(
        reordered.target.as_ref().unwrap().profile,
        profiles[2].profile
    );
    // A failed target is set aside, and the next one gets its own transition.
    let next = store
        .reselect_agent_recovery_target(
            &first.attempt_id,
            &[profiles[2].profile.clone()],
            Some("agent_runtime_repair_required"),
            300,
        )
        .await
        .unwrap();
    let first_attempt = AgentRecoveryAttemptV1::Conversation(Box::new(first.clone()));
    assert_eq!(next.target().unwrap().profile, profiles[1].profile);
    assert_eq!(next.unusable_targets(), [profiles[2].profile.clone()]);
    assert_eq!(next.stopped(), None);
    let (first_operation, _) = agent_runtime_transition_identity(&first.attempt_id).unwrap();
    let next_operation = next.runtime_operation_id().unwrap();
    assert_ne!(next_operation, first_operation);
    assert!(next.owns_runtime_operation(&first_operation));
    assert!(next.owns_runtime_operation(&next_operation));
    assert!(!first_attempt.owns_runtime_operation(&next_operation));
    store.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .prepare_agent_recovery(&interaction_binding().agent_id, 310, None)
            .await
            .unwrap(),
        Some(next.clone()),
        "an unfinished attempt resumes with what it set aside"
    );
    // With nothing left, a failed target stops the attempt with its reason.
    let stopped = reopened
        .reselect_agent_recovery_target(
            &first.attempt_id,
            &[profiles[1].profile.clone()],
            Some("agent_runtime_repair_required"),
            320,
        )
        .await
        .unwrap();
    assert_eq!(stopped.target(), None);
    assert_eq!(
        stopped.stopped(),
        Some(&AgentRecoveryStopV1::Failed {
            code: "agent_runtime_repair_required".into()
        })
    );
    assert_eq!(
        reopened
            .reselect_agent_recovery_target(&first.attempt_id, &[], None, 330)
            .await
            .unwrap(),
        stopped,
        "a finished attempt is not selected again"
    );
}

#[tokio::test]
async fn logins_set_aside_without_a_failure_exhaust_the_attempt() {
    let root = TempDir::new().unwrap();
    let store = initialized(&root.path().join("exhausted.sqlite")).await;
    let profiles = policy().accounts;
    let record = prepare(&store).await;
    let exhausted = store
        .reselect_agent_recovery_target(
            &record.attempt_id,
            &[profiles[1].profile.clone(), profiles[2].profile.clone()],
            None,
            300,
        )
        .await
        .unwrap();
    assert_eq!(exhausted.target(), None);
    assert_eq!(exhausted.stopped(), Some(&AgentRecoveryStopV1::Exhausted));
}

#[tokio::test]
async fn selection_skips_every_id_of_the_source_or_a_set_aside_login() {
    let root = TempDir::new().unwrap();
    let store = initialized(&root.path().join("aliases.sqlite")).await;
    let mut accounts = policy().accounts;
    // A second ID registered for account-c's profile directory is one login.
    let mut alias = accounts[2].clone();
    alias.profile.reference_id = "credential.account-c-alias".into();
    accounts.push(alias);
    // A second ID for the source's login shares its generation.
    let mut source_alias = accounts[0].clone();
    source_alias.profile.reference_id = "credential.account-a-alias".into();
    accounts.insert(0, source_alias);
    let source = interaction_binding().execution_profile;
    let mut connection = store.pool.acquire().await.unwrap();
    // accounts: a-alias, a (the source), b, c, c-alias.
    let picked = crate::provider_recovery_usage::select_on(
        &mut connection,
        &accounts,
        &source,
        &[accounts[2].profile.clone()],
        300,
    )
    .await
    .unwrap();
    assert_eq!(picked.unwrap().profile.reference_id, "credential.account-c");
    let picked = crate::provider_recovery_usage::select_on(
        &mut connection,
        &accounts,
        &source,
        &[accounts[2].profile.clone(), accounts[3].profile.clone()],
        300,
    )
    .await
    .unwrap();
    assert_eq!(picked, None, "the alias of a set-aside login is that login");
}

/// Only continuing after a reset is on: no account may be switched to.
fn continue_policy() -> ProviderRecoveryPolicyPutV1 {
    ProviderRecoveryPolicyPutV1 {
        enabled: false,
        accounts: Vec::new(),
        continue_after_reset: true,
        ..policy()
    }
}

fn reset_evidence(
    sequence: i64,
    client_message_id: &str,
    resets_at_ms: i64,
) -> dure_app::AgentTimelineMutationV1 {
    dure_app::AgentTimelineMutationV1::Append {
        item: dure_app::AgentTimelineItemDraftV1 {
            item_id: dure_app::AgentTimelineItemIdV1::new(format!("reset-{sequence}")).unwrap(),
            turn_id: None,
            client_message_id: Some(AgentClientMessageIdV1::new(client_message_id).unwrap()),
            provider_message_id: None,
            body: dure_app::AgentTimelineItemBodyV1::ProviderEvidence {
                namespace: "provider.claude".into(),
                kind: dure_app::AGENT_USAGE_LIMIT_RESET_EVIDENCE_KIND_V1.into(),
                value: serde_json::json!({ "resetsAtMs": resets_at_ms }),
            },
            created_at_ms: 200 + sequence,
        },
    }
}

fn limit_failure(sequence: i64, client_message_id: &str) -> dure_app::AgentTimelineMutationV1 {
    dure_app::AgentTimelineMutationV1::Append {
        item: dure_app::AgentTimelineItemDraftV1 {
            item_id: dure_app::AgentTimelineItemIdV1::new(format!("failure-{sequence}")).unwrap(),
            turn_id: None,
            client_message_id: Some(AgentClientMessageIdV1::new(client_message_id).unwrap()),
            provider_message_id: None,
            body: dure_app::AgentTimelineItemBodyV1::Lifecycle {
                state: dure_app::AgentTimelineLifecycleStateV1::TurnFailed,
                detail: Some("usage_limit".into()),
            },
            created_at_ms: 200 + sequence,
        },
    }
}

#[tokio::test]
async fn a_reported_reset_resends_once_on_the_same_account_and_never_waits_twice() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("reset.sqlite");
    let input = start_turn().client_message_id;
    let store = initialized_with(
        &path,
        continue_policy(),
        vec![
            reset_evidence(1, input.as_str(), 10_000),
            limit_failure(2, input.as_str()),
        ],
    )
    .await;
    let record = prepare(&store).await;
    assert_eq!(record.target, None);
    assert_eq!(record.stopped, None);
    let resume_at_ms = record.resume_at_ms.unwrap();
    assert!((70_000..=190_000).contains(&resume_at_ms), "{resume_at_ms}");
    let observed = store
        .latest_agent_recovery(&record.source.agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(observed.resume_at_ms, Some(resume_at_ms));
    // Before the reset nothing is sent and the wait keeps its intent,
    // across a restart too.
    assert!(
        store
            .prepare_agent_recovery_turn(&record.attempt_id, resume_at_ms - 1)
            .await
            .unwrap()
            .is_none()
    );
    store.close().await;
    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(prepare(&store).await, record);
    let sent = store
        .prepare_agent_recovery_turn(&record.attempt_id, resume_at_ms)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(sent.intent.input, start_turn().input);
    assert_eq!(
        sent.intent.runtime,
        runtime(1),
        "the same account continues"
    );
    // Still limited after the reset: the resent turn fails again and
    // recovery stops for a person instead of waiting a second time.
    store
        .apply_agent_provider_event(&provider_event(
            2,
            vec![
                reset_evidence(3, sent.intent.client_message_id.as_str(), 400_000),
                limit_failure(4, sent.intent.client_message_id.as_str()),
            ],
        ))
        .await
        .unwrap();
    let again = store
        .prepare_agent_recovery(&record.source.agent_id, resume_at_ms + 1_000, None)
        .await
        .unwrap()
        .and_then(AgentRecoveryAttemptV1::into_conversation)
        .unwrap();
    assert_ne!(again.attempt_id, record.attempt_id);
    assert_eq!(again.resume_at_ms, None);
    assert_eq!(again.stopped, Some(AgentRecoveryStopV1::Exhausted));
}

#[tokio::test]
async fn a_limit_without_a_reported_reset_or_the_switch_off_stops_as_exhausted() {
    for (policy, with_reset) in [
        (continue_policy(), false),
        (
            ProviderRecoveryPolicyPutV1 {
                continue_after_reset: false,
                enabled: true,
                accounts: Vec::new(),
                ..policy()
            },
            true,
        ),
    ] {
        let root = TempDir::new().unwrap();
        let input = start_turn().client_message_id;
        let mut failure = vec![limit_failure(2, input.as_str())];
        if with_reset {
            failure.insert(0, reset_evidence(1, input.as_str(), 10_000));
        }
        let store = initialized_with(&root.path().join("exhausted.sqlite"), policy, failure).await;
        let record = prepare(&store).await;
        assert_eq!(record.resume_at_ms, None);
        assert_eq!(record.stopped, Some(AgentRecoveryStopV1::Exhausted));
    }
}
