use super::*;
use dure_app::{
    AgentRuntimeRemovalPlanV1, SessionCheckoutBindingV1, SessionCheckoutIdentityV1,
    SessionCheckoutOwnerV1,
};

#[tokio::test]
async fn removal_fences_registration_until_the_existing_close_retains_its_source() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&root.path().join("domain.sqlite")).await;
    let registered = SessionCheckoutBindingV1::new(
        SessionCheckoutIdentityV1 {
            runtime_namespace: "/fixture/runtime".into(),
            owner: SessionCheckoutOwnerV1::Agent {
                agent_id: selection().agent_id,
                registration_id: OperationIdV1::new("registered-incarnation").unwrap(),
            },
        },
        "/workspace/project".into(),
        None,
    );
    let record = store
        .prepare_agent_checkout(
            &registered,
            &dure_app::AgentBootstrapV1 {
                agent_id: selection().agent_id,
                runtime_workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
                provider_id: selection().provider_id,
                working_directory: registered.working_directory.clone(),
                display_name: "Agent".into(),
            },
            100,
        )
        .await
        .unwrap();
    let origin: SessionCheckoutIdentityV1 =
        serde_json::from_value(record.close_payload.clone().unwrap()).unwrap();
    let intent = close_intent();
    // Ordinary Stop retains the resource and does not permanently close Agent registration.
    store.admit_agent_runtime_close(&intent).await.unwrap();
    store
        .admit_agent_checkout(&registered, &origin)
        .await
        .unwrap()
        .finish()
        .await
        .unwrap();
    let plan = AgentRuntimeRemovalPlanV1 {
        checkout: Some(registered.clone()),
        managed_roots: vec![origin.clone()],
    };
    store
        .admit_agent_runtime_removal(&intent, &plan)
        .await
        .unwrap();
    let late_registration = store.admit_agent_checkout(&registered, &origin).await;
    assert!(
        late_registration.is_err(),
        "an admitted Remove must exclude a new registration acknowledgement/launch"
    );
    drop(late_registration);
    store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: intent.operation_id,
            expected_journal_revision: 1,
            advance: AgentRuntimeCloseAdvanceV1::SourceRetained,
            advanced_at_ms: 120,
        })
        .await
        .unwrap();
    store
        .admit_agent_checkout(&registered, &origin)
        .await
        .unwrap()
        .finish()
        .await
        .unwrap();
    assert_eq!(
        store.session_checkout(&registered.identity).await.unwrap(),
        Some(record)
    );
    let mut retry = close_intent();
    retry.operation_id = OperationIdV1::new("remove-registration-retry").unwrap();
    retry.idempotency_key = "remove-registration-retry".into();
    retry.requested_at_ms = 130;
    store
        .admit_agent_runtime_removal(&retry, &plan)
        .await
        .unwrap();
    stop(&store, &retry).await;
    assert!(
        store
            .admit_agent_checkout(&registered, &origin)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn legacy_removal_transfers_its_resource_with_close_admission() {
    assert_legacy_removal_transaction(false).await;
}

#[tokio::test]
async fn legacy_repair_required_removal_uses_exact_retained_close_authority() {
    assert_legacy_removal_transaction(true).await;
}

async fn assert_legacy_removal_transaction(failed_replacement: bool) {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&root.path().join("domain.sqlite")).await;
    let source = SessionCheckoutBindingV1::new(
        SessionCheckoutIdentityV1 {
            runtime_namespace: "/fixture/runtime".into(),
            owner: SessionCheckoutOwnerV1::Managed {
                workspace_id: "workspace-1".into(),
                session_id: "legacy-worker".into(),
                idempotency_key: "legacy-create".into(),
            },
        },
        "/workspace/project".into(),
        None,
    );
    let original = store.prepare_session_checkout(&source).await.unwrap();
    let intent = if failed_replacement {
        let parked = park_replaced_binding(&store).await;
        let exact = close_parked_transition(&parked, "remove-failed-legacy");
        let mut stale = exact.clone();
        stale.stopped_transition.as_mut().unwrap().journal_revision -= 1;
        assert!(
            store
                .admit_agent_runtime_removal(&stale, &plan())
                .await
                .is_err()
        );
        exact
    } else {
        close_intent()
    };
    let input = AgentRuntimeRemovalPlanV1 {
        checkout: Some(source.clone()),
        managed_roots: vec![source.identity.clone()],
    };
    sqlx::query(
        "CREATE TRIGGER fail_legacy_removal BEFORE UPDATE OF removal_json ON agent_runtime_closes \
        BEGIN SELECT RAISE(ABORT, 'fault-injected atomic legacy removal'); END",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(
        store
            .admit_agent_runtime_removal(&intent, &input)
            .await
            .is_err()
    );
    assert_eq!(
        store.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
    assert!(
        store
            .agent_runtime_checkout(&intent.source.agent_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .agent_runtime_close(&intent.operation_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .agent_runtime_removal(&intent.operation_id)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("DROP TRIGGER fail_legacy_removal")
        .execute(&store.pool)
        .await
        .unwrap();

    let admitted = store
        .admit_agent_runtime_removal(&intent, &input)
        .await
        .unwrap();
    let retained = store
        .agent_runtime_checkout(&intent.source.agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        retained.binding,
        source.retained_by_agent(&intent.source.agent_id)
    );
    assert_eq!(
        retained.close_payload,
        Some(serde_json::to_value(&source.identity).unwrap())
    );
    assert!(
        store
            .session_checkout(&source.identity)
            .await
            .unwrap()
            .is_none()
    );
    let persisted = store
        .agent_runtime_removal(&intent.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.plan.checkout, Some(retained.binding.clone()));
    assert_eq!(persisted.plan.managed_roots, input.managed_roots);
    for replay in [&input, &persisted.plan] {
        assert_eq!(
            store
                .admit_agent_runtime_removal(&intent, replay)
                .await
                .unwrap(),
            admitted
        );
    }
    let mut foreign = persisted.plan.clone();
    foreign.checkout.as_mut().unwrap().identity.owner = SessionCheckoutOwnerV1::Agent {
        agent_id: AgentIdV1::new("another-agent").unwrap(),
        registration_id: source.claim_id.clone(),
    };
    assert!(
        store
            .admit_agent_runtime_removal(&intent, &foreign)
            .await
            .is_err()
    );
    let mut foreign_source = input.clone();
    let SessionCheckoutOwnerV1::Managed { session_id, .. } =
        &mut foreign_source.checkout.as_mut().unwrap().identity.owner
    else {
        unreachable!()
    };
    *session_id = "another-source".into();
    assert!(
        store
            .admit_agent_runtime_removal(&intent, &foreign_source)
            .await
            .is_err()
    );
    assert_eq!(
        store
            .agent_runtime_checkout(&intent.source.agent_id)
            .await
            .unwrap(),
        Some(retained)
    );
}

async fn park_replaced_binding(
    store: &SqliteDomainStore,
) -> dure_app::AgentRuntimeTransitionRecordV1 {
    let mut intent = transition_intent();
    intent.target_interaction_profile = AgentInteractionProfileV1::StructuredProtocol;
    intent.target_launch_selection = Some(dure_app::AgentRuntimeLaunchSelectionV1 {
        model: None,
        effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("high").unwrap()),
        permission_mode: None,
    });
    let admitted = store.admit_agent_runtime_transition(&intent).await.unwrap();
    let stopped = store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: intent.operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 120,
        })
        .await
        .unwrap();
    let failed = store
        .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
            schema_version: 1,
            interaction_session_id: binding().interaction_session_id,
            expected_binding_revision: 1,
            source: binding().runtime,
            source_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target: AgentProviderRuntimeFenceV1 {
                runtime_generation: "failed-runtime".into(),
                provider_epoch: "failed-provider".into(),
            },
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: Some("thread-1".into()),
            replaced_at_ms: 125,
        })
        .await
        .unwrap();
    store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: intent.operation_id,
            expected_journal_revision: stopped.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: AgentRuntimeTargetFailureV1::new(
                    AgentRuntimeTargetFailureKindV1::LaunchFailed,
                    "fixture-target-failed",
                )
                .unwrap(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::Replace {
                    authority: Some(Box::new(dure_app::AgentRuntimeReplacementAuthorityV1(
                        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: failed },
                    ))),
                },
            },
            advanced_at_ms: 130,
        })
        .await
        .unwrap()
}

fn plan() -> AgentRuntimeRemovalPlanV1 {
    AgentRuntimeRemovalPlanV1 {
        checkout: None,
        managed_roots: Vec::new(),
    }
}

async fn stop(store: &SqliteDomainStore, intent: &AgentRuntimeCloseIntentV1) {
    store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: intent.operation_id.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: intent.requested_at_ms + 10,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn removal_input_and_runtime_close_roll_back_together() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&root.path().join("domain.sqlite")).await;
    sqlx::query(
        "CREATE TRIGGER fail_removal BEFORE UPDATE OF removal_json ON agent_runtime_closes \
        BEGIN SELECT RAISE(ABORT, 'fault-injected removal admission'); END",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    let intent = close_intent();
    assert!(
        store
            .admit_agent_runtime_removal(&intent, &plan())
            .await
            .is_err()
    );
    assert!(
        store
            .agent_runtime_close(&intent.operation_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .agent_runtime_removal(&intent.operation_id)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("DROP TRIGGER fail_removal")
        .execute(&store.pool)
        .await
        .unwrap();
    let admitted = store
        .admit_agent_runtime_removal(&intent, &plan())
        .await
        .unwrap();
    assert_eq!(admitted.state, AgentRuntimeCloseStateV1::Admitted);
    assert!(
        store
            .finish_agent_runtime_removal(&intent.operation_id, 120)
            .await
            .is_err()
    );
    assert_eq!(
        store
            .admit_agent_runtime_removal(&intent, &plan())
            .await
            .unwrap(),
        admitted
    );
}

#[tokio::test]
async fn stopped_removal_remains_recoverable_and_fences_successors_after_reopen() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = initialized_store(&path).await;
    let intent = close_intent();
    store
        .admit_agent_runtime_removal(&intent, &plan())
        .await
        .unwrap();
    stop(&store, &intent).await;
    drop(store);
    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap(),
        vec![intent.source.agent_id.clone()]
    );
    let mut successor = transition_intent();
    successor.requested_at_ms = 130;
    assert!(
        store
            .admit_agent_runtime_transition(&successor)
            .await
            .is_err()
    );
    store
        .finish_agent_runtime_removal(&intent.operation_id, 140)
        .await
        .unwrap();
    assert!(
        store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .admit_agent_runtime_transition(&successor)
            .await
            .is_err()
    );
    store
        .finish_agent_runtime_removal(&intent.operation_id, 150)
        .await
        .unwrap();
    assert_eq!(
        store
            .agent_runtime_removal(&intent.operation_id)
            .await
            .unwrap()
            .unwrap()
            .completed_at_ms,
        Some(140)
    );
}

#[tokio::test]
async fn explicit_removal_can_attach_to_an_ordinary_stopped_source() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&root.path().join("domain.sqlite")).await;
    let intent = close_intent();
    store.admit_agent_runtime_close(&intent).await.unwrap();
    stop(&store, &intent).await;
    assert!(
        store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
    let before = store
        .agent_runtime_close(&intent.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        store
            .admit_agent_runtime_removal(&intent, &plan())
            .await
            .unwrap(),
        before
    );
    assert_eq!(
        store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap(),
        vec![intent.source.agent_id]
    );
}

#[tokio::test]
async fn refused_stop_keeps_removal_out_of_recovery_and_allows_a_new_attempt() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&root.path().join("domain.sqlite")).await;
    let intent = close_intent();
    store
        .admit_agent_runtime_removal(&intent, &plan())
        .await
        .unwrap();
    store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: intent.operation_id.clone(),
            expected_journal_revision: 1,
            advance: AgentRuntimeCloseAdvanceV1::SourceRetained,
            advanced_at_ms: 120,
        })
        .await
        .unwrap();
    assert!(
        store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .finish_agent_runtime_removal(&intent.operation_id, 130)
            .await
            .is_err()
    );
    let mut next = intent;
    next.operation_id = OperationIdV1::new("remove-2").unwrap();
    next.idempotency_key = "remove-2".into();
    next.requested_at_ms = 130;
    store
        .admit_agent_runtime_removal(&next, &plan())
        .await
        .unwrap();
}
