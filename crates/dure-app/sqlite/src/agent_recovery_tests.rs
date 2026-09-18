use super::*;
use dure_app::{
    AgentCompleteTurnEffectV1, AgentInteractionProfileV1, AgentProviderConversationPlanV1,
    AgentQueuedTurnStore, AgentRecoveryRecordV1, AgentRecoveryStopV1, AgentRecoveryStore,
    AgentRuntimeBindingAuthorityV1, AgentRuntimeSelectionV1, AgentRuntimeSourceStopPolicyV1,
    AgentRuntimeTransitionAdvanceRequestV1, AgentRuntimeTransitionAdvanceV1,
    AgentRuntimeTransitionIntentV1, AgentRuntimeTransitionStore, ProviderCredentialProfileV1,
    ProviderPermissionModeV1, ProviderRecoveryAccountV1, ProviderRecoveryPolicyPutV1,
    ProviderRecoveryStore, ProviderRecoveryUsageV1, agent_runtime_transition_identity,
};

fn policy() -> ProviderRecoveryPolicyPutV1 {
    let provider_id = interaction_binding().provider_id;
    ProviderRecoveryPolicyPutV1 {
        schema_version: 1,
        provider_id: provider_id.clone(),
        expected_revision: 0,
        idempotency_key: "enable-recovery".into(),
        enabled: true,
        accounts: [
            "credential.account-a",
            "credential.account-b",
            "credential.account-c",
        ]
        .into_iter()
        .map(|reference| ProviderRecoveryAccountV1 {
            profile: ProviderCredentialProfileV1 {
                schema_version: 1,
                provider_id: provider_id.clone(),
                reference_id: reference.into(),
                credential_generation: "credential-generation-7".into(),
            },
            name: reference.into(),
        })
        .collect(),
    }
}

async fn initialized(path: &std::path::Path) -> SqliteDomainStore {
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
        .put_provider_recovery_policy(&policy(), 100)
        .await
        .unwrap();
    store.record_agent_turn_intent(&start_turn()).await.unwrap();
    store
        .apply_agent_provider_event(&provider_event(
            1,
            vec![super::failure::failure_row(1, Some("usage_limit"))],
        ))
        .await
        .unwrap();
    store
}

async fn prepare(store: &SqliteDomainStore) -> AgentRecoveryRecordV1 {
    store
        .prepare_agent_recovery(&interaction_binding().agent_id, 300)
        .await
        .unwrap()
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
            .prepare_agent_recovery(&interaction_binding().agent_id, 300)
            .await
            .unwrap()
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
            .prepare_agent_recovery(&interaction_binding().agent_id, 400)
            .await
            .unwrap()
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
        crate::provider_recovery_usage::select_on(&mut connection, &profiles, &source, 400)
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
        crate::provider_recovery_usage::select_on(&mut connection, &profiles, &source, 420)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        crate::provider_recovery_usage::select_on(
            &mut connection,
            &profiles,
            &source,
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
                    .prepare_agent_recovery(&agent_id, 300)
                    .await
                    .unwrap()
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
