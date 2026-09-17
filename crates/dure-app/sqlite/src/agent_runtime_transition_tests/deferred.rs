use super::*;
use dure_app::{AgentRuntimeDeferredTargetV1, AgentRuntimeTransitionWakeRequestV1};

mod native_resume;

#[tokio::test]
async fn reclamation_journal_page_is_bounded_validated_and_survives_reopen() {
    let root = TempDir::new().unwrap();
    let path = database_path(&root);
    let store = initialized_store(&path).await;
    assert_eq!(
        store.recent_agent_runtime_transitions().await.unwrap(),
        (Vec::new(), false)
    );
    let first = deferred_plan();
    store
        .initialize_agent_runtime_selection(&first.source)
        .await
        .unwrap();
    for index in 0..66 {
        let mut plan = deferred_plan();
        plan.operation_id = OperationIdV1::new(format!("hibernate-{index:03}")).unwrap();
        plan.idempotency_key = format!("reclamation-request-{index:03}");
        store
            .admit_deferred_agent_runtime_transition(&plan)
            .await
            .unwrap();
        store
            .advance_agent_runtime_transition(&advance(
                &plan.operation_id,
                1,
                AgentRuntimeTransitionAdvanceV1::SourceRetained,
                120,
            ))
            .await
            .unwrap();
    }
    let (page, partial) = store.recent_agent_runtime_transitions().await.unwrap();
    assert!(partial);
    assert_eq!(page.len(), 64);
    assert_eq!(page[0].intent.operation_id.as_str(), "hibernate-065");
    assert_eq!(page[63].intent.operation_id.as_str(), "hibernate-002");
    assert!(
        page.iter()
            .all(|record| record.state == AgentRuntimeTransitionStateV1::SourceRetained)
    );
    drop(store);
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened.recent_agent_runtime_transitions().await.unwrap(),
        (page, true)
    );
    assert_eq!(
        reopened
            .agent_runtime_selection(&first.source.agent_id)
            .await
            .unwrap(),
        Some(first.source)
    );
    sqlx::query("UPDATE agent_runtime_transitions SET journal_revision = 99 WHERE operation_id = 'hibernate-065'")
        .execute(&reopened.pool).await.unwrap();
    assert!(
        reopened.recent_agent_runtime_transitions().await.is_err(),
        "column/record disagreement is not valid evidence"
    );
}

fn deferred_plan() -> AgentRuntimeTransitionIntentV1 {
    let mut plan = intent("hibernate-1", "hibernate-request-1");
    plan.target_interaction_profile = plan.source.interaction_profile;
    plan
}

fn wake(plan: &AgentRuntimeTransitionIntentV1) -> AgentRuntimeTransitionWakeRequestV1 {
    AgentRuntimeTransitionWakeRequestV1 {
        schema_version: 1,
        operation_id: plan.operation_id.clone(),
        expected_journal_revision: 2,
        wake_operation_id: OperationIdV1::new("wake-1").unwrap(),
        woken_at_ms: 130,
    }
}

async fn stopped_deferred(store: &SqliteDomainStore) -> dure_app::AgentRuntimeTransitionRecordV1 {
    let plan = deferred_plan();
    store
        .initialize_agent_runtime_selection(&plan.source)
        .await
        .unwrap();
    let admitted = store
        .admit_deferred_agent_runtime_transition(&plan)
        .await
        .unwrap();
    assert!(admitted.target_is_deferred());
    assert!(
        store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .contains(&plan.source.agent_id)
    );
    assert!(
        store
            .authorize_agent_runtime_transition_wake(&wake(&plan))
            .await
            .is_err(),
        "wake cannot race ahead of the durable stop receipt"
    );
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            120,
        ))
        .await
        .unwrap()
}

#[tokio::test]
async fn deferred_target_refuses_replacement_binding_before_wake() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let stopped = stopped_deferred(&store).await;
    let AgentRuntimeBindingAuthorityV1::NativeCli { mut authority } = native_authority() else {
        unreachable!();
    };
    authority.binding.session_id = "unrequested-replacement".into();
    authority.binding.binding_generation += 1;
    authority.binding.bound_at_ms = 130;
    authority.updated_at_ms = 130;
    assert!(
        store
            .upsert_agent_checkpoint_binding_authority(&authority)
            .await
            .is_err(),
        "a stopped source alone must not authorize a new binding while wake is deferred"
    );
    assert_eq!(
        store
            .agent_checkpoint_binding_authority(&stopped.intent.source.agent_id)
            .await
            .unwrap(),
        match native_authority() {
            AgentRuntimeBindingAuthorityV1::NativeCli { authority } => Some(authority),
            _ => unreachable!(),
        }
    );
}

#[tokio::test]
async fn deferred_target_stays_asleep_across_store_restart_until_exact_wake() {
    let root = TempDir::new().unwrap();
    let path = database_path(&root);
    let store = initialized_store(&path).await;
    let stopped = stopped_deferred(&store).await;
    drop(store);
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    let plan = deferred_plan();
    assert_eq!(
        reopened
            .active_agent_runtime_transition(&plan.source.agent_id)
            .await
            .unwrap(),
        Some(stopped)
    );
    assert!(
        reopened
            .agent_runtime_startup_recovery_candidates()
            .await
            .unwrap()
            .is_empty(),
        "startup must not recreate a deliberately deferred runtime"
    );
    assert!(
        reopened
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .is_empty(),
        "periodic reconciliation is not a wake request"
    );
    assert!(
        reopened
            .advance_agent_runtime_transition(&advance(
                &plan.operation_id,
                2,
                AgentRuntimeTransitionAdvanceV1::RepairRequired {
                    failure: AgentRuntimeTargetFailureV1::new(
                        AgentRuntimeTargetFailureKindV1::LaunchFailed,
                        "fixture"
                    )
                    .unwrap(),
                    replacement_authority:
                        AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
                },
                130
            ))
            .await
            .is_err(),
        "no target attempt is admitted before wake"
    );
    let request = wake(&plan);
    let AgentRuntimeTransitionEffectAuthorizationV1::Authorized(woken) = reopened
        .authorize_agent_runtime_transition_wake(&request)
        .await
        .unwrap()
    else {
        panic!("first wake must authorize")
    };
    assert_eq!(
        woken.intent, plan,
        "wake must use the persisted replacement, not fresh caller hints"
    );
    assert_eq!(woken.journal_revision, 3);
    assert!(!woken.target_is_deferred());
    assert_eq!(
        reopened
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap(),
        vec![plan.source.agent_id.clone()]
    );
    assert_eq!(
        reopened
            .authorize_agent_runtime_transition_wake(&request)
            .await
            .unwrap(),
        AgentRuntimeTransitionEffectAuthorizationV1::Replayed(woken)
    );
    assert!(
        reopened
            .admit_agent_runtime_transition(&plan)
            .await
            .is_err(),
        "replaying admission cannot change deferred into immediate activation"
    );
}

#[tokio::test]
async fn concurrent_wake_authorizes_only_one_replacement_and_late_replay_is_observation() {
    let root = TempDir::new().unwrap();
    let store = Arc::new(initialized_store(&database_path(&root)).await);
    stopped_deferred(&store).await;
    let plan = deferred_plan();
    let request = wake(&plan);
    let barrier = Arc::new(Barrier::new(3));
    let mut calls = Vec::new();
    for _ in 0..2 {
        let (store, barrier, request) = (Arc::clone(&store), Arc::clone(&barrier), request.clone());
        calls.push(tokio::spawn(async move {
            barrier.wait().await;
            store
                .authorize_agent_runtime_transition_wake(&request)
                .await
                .unwrap()
        }));
    }
    barrier.wait().await;
    let mut authorized = 0;
    for call in calls {
        authorized += usize::from(matches!(
            call.await.unwrap(),
            AgentRuntimeTransitionEffectAuthorizationV1::Authorized(_)
        ));
    }
    assert_eq!(authorized, 1);
    let mut competing = request.clone();
    competing.wake_operation_id = OperationIdV1::new("wake-other").unwrap();
    assert!(
        store
            .authorize_agent_runtime_transition_wake(&competing)
            .await
            .is_err()
    );

    let mut target = native_authority();
    let identity = dure_app::agent_runtime_native_launch_identity_v1(&plan.operation_id);
    if let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = &mut target {
        authority.binding.session_id = identity.session_id;
        authority.binding.binding_generation += 1;
        authority.binding.bound_at_ms = 140;
        authority.host_instance_id = "host-instance-2".into();
        authority.terminal_epoch = "terminal-epoch-2".into();
        authority.updated_at_ms = 140;
    }
    publish_runtime_authority(&store, &target).await;
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            3,
            AgentRuntimeTransitionAdvanceV1::TargetStarted {
                authority: Box::new(target),
                launch_idempotency_key: Some(identity.launch_idempotency_key),
            },
            140,
        ))
        .await
        .unwrap();
    let committed = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            4,
            AgentRuntimeTransitionAdvanceV1::Committed,
            150,
        ))
        .await
        .unwrap();
    assert_eq!(
        store
            .authorize_agent_runtime_transition_wake(&request)
            .await
            .unwrap(),
        AgentRuntimeTransitionEffectAuthorizationV1::Replayed(committed)
    );
    let selected = store
        .agent_runtime_selection(&plan.source.agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(selected.revision, 2);
    assert_eq!(selected.provider_id, plan.source.provider_id);
    assert_eq!(selected.execution_profile, plan.source.execution_profile);
}

#[tokio::test]
async fn deferred_admission_rejects_discard_fresh_and_profile_changes() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let plan = deferred_plan();
    store
        .initialize_agent_runtime_selection(&plan.source)
        .await
        .unwrap();
    let mut discard = plan.clone();
    discard.source_stop_policy = dure_app::AgentRuntimeSourceStopPolicyV1::Discard;
    assert!(
        store
            .admit_deferred_agent_runtime_transition(&discard)
            .await
            .is_err()
    );
    let changed = intent("hibernate-1", "hibernate-request-1");
    assert!(
        store
            .admit_deferred_agent_runtime_transition(&changed)
            .await
            .is_err()
    );
    let mut fresh = plan.clone();
    fresh.provider_conversation_ref = dure_app::AgentProviderConversationPlanV1::fresh();
    if let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = &mut fresh.source_authority {
        authority.binding.provider_conversation_id = None;
    }
    assert!(dure_app::AgentRuntimeTransitionRecordV1::admitted_deferred(fresh).is_err());
    let record = store
        .admit_deferred_agent_runtime_transition(&plan)
        .await
        .unwrap();
    assert_eq!(
        record.deferred_target,
        Some(AgentRuntimeDeferredTargetV1::Waiting)
    );
    assert_eq!(
        store
            .admit_deferred_agent_runtime_transition(&plan)
            .await
            .unwrap(),
        record
    );
    let retained = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceRetained,
            120,
        ))
        .await
        .unwrap();
    assert_eq!(
        retained.state,
        AgentRuntimeTransitionStateV1::SourceRetained
    );
    assert!(
        store
            .authorize_agent_runtime_transition_wake(&wake(&plan))
            .await
            .is_err()
    );
    assert_eq!(
        store
            .agent_runtime_selection(&plan.source.agent_id)
            .await
            .unwrap(),
        Some(plan.source)
    );
}

#[tokio::test]
async fn structured_startup_selection_cannot_bypass_deferred_target() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let authority = structured_authority();
    publish_runtime_authority(&store, &authority).await;
    let mut plan = deferred_plan();
    plan.source.interaction_profile = AgentInteractionProfileV1::StructuredProtocol;
    plan.source.updated_at_ms = 150;
    plan.target_interaction_profile = plan.source.interaction_profile;
    plan.source_authority = authority;
    plan.requested_at_ms = 160;
    store
        .initialize_agent_runtime_selection(&plan.source)
        .await
        .unwrap();
    store
        .admit_deferred_agent_runtime_transition(&plan)
        .await
        .unwrap();
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            170,
        ))
        .await
        .unwrap();
    assert!(
        store
            .agent_runtime_startup_recovery_candidates()
            .await
            .unwrap()
            .is_empty(),
        "a selected structured profile must not override its deferred journal"
    );
    let mut request = wake(&plan);
    request.woken_at_ms = 180;
    store
        .authorize_agent_runtime_transition_wake(&request)
        .await
        .unwrap();
    assert_eq!(
        store
            .agent_runtime_startup_recovery_candidates()
            .await
            .unwrap(),
        vec![plan.source.agent_id]
    );
}

#[tokio::test]
async fn deferred_wake_keeps_existing_repair_and_successor_fences() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    stopped_deferred(&store).await;
    let plan = deferred_plan();
    store
        .authorize_agent_runtime_transition_wake(&wake(&plan))
        .await
        .unwrap();
    let failed = AgentRuntimeTransitionAdvanceV1::RepairRequired {
        failure: AgentRuntimeTargetFailureV1::new(
            AgentRuntimeTargetFailureKindV1::LaunchFailed,
            "fixture_failure",
        )
        .unwrap(),
        replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
    };
    store
        .advance_agent_runtime_transition(&advance(&plan.operation_id, 3, failed.clone(), 140))
        .await
        .unwrap();
    let repair = AgentRuntimeTransitionRepairRequestV1 {
        schema_version: 1,
        operation_id: plan.operation_id.clone(),
        expected_journal_revision: 4,
        repair_operation_id: OperationIdV1::new("repair-1").unwrap(),
        repaired_at_ms: 150,
    };
    assert!(matches!(
        store
            .authorize_agent_runtime_transition_repair(&repair)
            .await
            .unwrap(),
        AgentRuntimeTransitionEffectAuthorizationV1::Authorized(_)
    ));
    store
        .advance_agent_runtime_transition(&advance(&plan.operation_id, 5, failed, 160))
        .await
        .unwrap();
    let mut successor = plan.clone();
    successor.operation_id = OperationIdV1::new("corrected-target").unwrap();
    successor.idempotency_key = "corrected-target-request".into();
    successor.target_interaction_profile = AgentInteractionProfileV1::StructuredProtocol;
    successor.requested_at_ms = 170;
    let authorized = store
        .supersede_agent_runtime_transition(&AgentRuntimeTransitionSupersedeRequestV1 {
            schema_version: 1,
            operation_id: plan.operation_id.clone(),
            expected_journal_revision: 6,
            successor_intent: successor,
            superseded_at_ms: 170,
        })
        .await
        .unwrap();
    let AgentRuntimeTransitionEffectAuthorizationV1::Authorized(next) = authorized else {
        panic!("successor must be authorized")
    };
    assert!(next.permits_target_effects());
    assert_eq!(
        next.predecessor_operation_id,
        Some(plan.operation_id.clone())
    );
    assert!(
        matches!(
            store
                .authorize_agent_runtime_transition_wake(&wake(&plan))
                .await
                .unwrap(),
            AgentRuntimeTransitionEffectAuthorizationV1::Replayed(_)
        ),
        "old wake replay cannot drive a superseding target"
    );
}

#[tokio::test]
async fn immediate_transitions_keep_existing_wire_shape_and_recovery_behavior() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let plan = intent("immediate", "immediate-request");
    store
        .initialize_agent_runtime_selection(&plan.source)
        .await
        .unwrap();
    let record = store.admit_agent_runtime_transition(&plan).await.unwrap();
    assert!(
        serde_json::to_value(&record)
            .unwrap()
            .get("deferredTarget")
            .is_none()
    );
    assert!(!record.target_is_deferred());
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            120,
        ))
        .await
        .unwrap();
    assert_eq!(
        store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap(),
        vec![plan.source.agent_id]
    );
}
