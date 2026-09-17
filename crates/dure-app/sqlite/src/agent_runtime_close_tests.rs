use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AGENT_TIMELINE_SCHEMA_VERSION_V1,
    AgentCheckpointBindingAuthorityV1, AgentClientMessageIdV1, AgentExecutionProfileV1, AgentIdV1,
    AgentInteractionBindingV1, AgentInteractionProfileV1, AgentInteractionSessionIdV1,
    AgentProviderRuntimeFenceV1, AgentRecordV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeCloseAdvanceRequestV1, AgentRuntimeCloseAdvanceV1, AgentRuntimeCloseIntentV1,
    AgentRuntimeCloseStateV1, AgentRuntimeCloseStoppedTransitionV1, AgentRuntimeCloseStore,
    AgentRuntimeReplacementAuthorityUpdateV1, AgentRuntimeReplacementV1, AgentRuntimeSelectionV1,
    AgentRuntimeTargetFailureKindV1, AgentRuntimeTargetFailureV1,
    AgentRuntimeTransitionAdvanceRequestV1, AgentRuntimeTransitionAdvanceV1,
    AgentRuntimeTransitionEffectAuthorizationV1, AgentRuntimeTransitionIntentV1,
    AgentRuntimeTransitionRepairRequestV1, AgentRuntimeTransitionStore,
    AgentRuntimeTransitionSupersedeRequestV1, AgentStartTurnIntentV1, AgentTimelineEpochV1,
    AgentTimelineStore, AgentTurnIdV1, CURRENT_STORE_SCHEMA_VERSION, DomainStore,
    DomainStoreErrorV1, OperationIdV1, ProjectIdV1, ProjectRecordV1, ProviderIdV1,
    ProviderPermissionModeV1, RuntimeKindIdV1, SessionBindingRecordV1, WorkspaceIdV1,
    WorkspaceRecordV1,
};
use tempfile::TempDir;

mod removal;
mod successor_lineage;

use super::{
    SqliteDomainStore, agent_runtime_close, agent_runtime_transition,
    schema::{begin_immediate, downgrade_workflow_launch_fixture_to_v31},
};

async fn initialized_store(path: &std::path::Path) -> SqliteDomainStore {
    let store = SqliteDomainStore::open(path).await.unwrap();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: ProjectIdV1::new("project-1").unwrap(),
            root_path: "/workspace/project".into(),
            display_name: "Project".into(),
            created_at_ms: 10,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            project_id: ProjectIdV1::new("project-1").unwrap(),
            root_path: "/workspace/project".into(),
            base_commit_sha: None,
            created_at_ms: 20,
            updated_at_ms: 20,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            display_name: "Codex".into(),
            created_at_ms: 30,
            updated_at_ms: 30,
        })
        .await
        .unwrap();
    store
        .initialize_agent_runtime_selection(&selection())
        .await
        .unwrap();
    store.create_agent_interaction(&binding()).await.unwrap();
    store
}

fn selection() -> AgentRuntimeSelectionV1 {
    AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: AgentIdV1::new("agent-1").unwrap(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 100,
    }
}

fn binding() -> AgentInteractionBindingV1 {
    AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
        agent_id: AgentIdV1::new("agent-1").unwrap(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("thread-1".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-1".into(),
            provider_epoch: "provider-1".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-1").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 100,
        updated_at_ms: 100,
    }
}

fn close_intent() -> AgentRuntimeCloseIntentV1 {
    AgentRuntimeCloseIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new("runtime-close-1").unwrap(),
        idempotency_key: "runtime-close-agent-1".into(),
        source: selection(),
        source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: binding() },
        stopped_transition: None,
        requested_at_ms: 110,
    }
}

fn transition_intent() -> AgentRuntimeTransitionIntentV1 {
    AgentRuntimeTransitionIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new("runtime-transition-1").unwrap(),
        idempotency_key: "runtime-transition-agent-1".into(),
        source: selection(),
        source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: binding() },
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume("thread-1")
            .unwrap(),
        target_interaction_profile: AgentInteractionProfileV1::NativeCli,
        target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
        target_launch_selection: None,
        requested_at_ms: 110,
    }
}

async fn park_transition(
    store: &SqliteDomainStore,
) -> (
    AgentRuntimeTransitionIntentV1,
    dure_app::AgentRuntimeTransitionRecordV1,
) {
    let intent = transition_intent();
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
    let parked = store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: intent.operation_id.clone(),
            expected_journal_revision: stopped.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: AgentRuntimeTargetFailureV1::new(
                    AgentRuntimeTargetFailureKindV1::CredentialUnavailable,
                    "credential_unavailable",
                )
                .unwrap(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
            },
            advanced_at_ms: 130,
        })
        .await
        .unwrap();
    (intent, parked)
}

fn close_parked_transition(
    parked: &dure_app::AgentRuntimeTransitionRecordV1,
    operation: &str,
) -> AgentRuntimeCloseIntentV1 {
    AgentRuntimeCloseIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new(operation).unwrap(),
        idempotency_key: operation.into(),
        source: parked.intent.source.clone(),
        source_authority: parked.intent.source_authority.clone(),
        stopped_transition: Some(AgentRuntimeCloseStoppedTransitionV1 {
            operation_id: parked.intent.operation_id.clone(),
            journal_revision: parked.journal_revision,
        }),
        requested_at_ms: 140,
    }
}

#[tokio::test]
async fn connection_scoped_close_admission_rolls_back_with_its_outer_transaction() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&temp_dir.path().join("domain.sqlite")).await;
    let intent = close_intent();
    let mut connection = store.pool.acquire().await.unwrap();
    begin_immediate(&mut connection, "test_runtime_close_outer_rollback")
        .await
        .unwrap();

    let admitted = agent_runtime_close::admit_on(&mut connection, &intent)
        .await
        .unwrap();
    assert_eq!(admitted.state, AgentRuntimeCloseStateV1::Admitted);
    sqlx::query("ROLLBACK")
        .execute(&mut *connection)
        .await
        .unwrap();
    drop(connection);

    assert!(
        store
            .agent_runtime_close(&intent.operation_id)
            .await
            .unwrap()
            .is_none(),
        "rolling back the caller transaction must roll back the child close"
    );
}

#[tokio::test]
async fn connection_scoped_close_admission_replays_exactly_before_commit() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&temp_dir.path().join("domain.sqlite")).await;
    let intent = close_intent();
    let mut connection = store.pool.acquire().await.unwrap();
    begin_immediate(&mut connection, "test_runtime_close_exact_replay")
        .await
        .unwrap();

    let admitted = agent_runtime_close::admit_on(&mut connection, &intent)
        .await
        .unwrap();
    assert_eq!(
        agent_runtime_close::admit_on(&mut connection, &intent)
            .await
            .unwrap(),
        admitted
    );
    let stored_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_runtime_closes WHERE operation_id = ?1")
            .bind(intent.operation_id.as_str())
            .fetch_one(&mut *connection)
            .await
            .unwrap();
    assert_eq!(
        stored_rows, 1,
        "exact replay must not insert a second close"
    );
    sqlx::query("COMMIT")
        .execute(&mut *connection)
        .await
        .unwrap();
    drop(connection);

    assert_eq!(
        store
            .agent_runtime_close(&intent.operation_id)
            .await
            .unwrap(),
        Some(admitted)
    );
}

#[tokio::test]
async fn admitted_close_is_durable_idempotent_and_advances_once() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = initialized_store(&path).await;
    let intent = close_intent();

    assert_eq!(
        store
            .agent_runtime_startup_recovery_candidates()
            .await
            .unwrap(),
        vec![intent.source.agent_id.clone()]
    );
    assert!(
        store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
    let admitted = store.admit_agent_runtime_close(&intent).await.unwrap();
    assert_eq!(admitted.state, AgentRuntimeCloseStateV1::Admitted);
    assert_eq!(
        store
            .agent_runtime_startup_recovery_candidates()
            .await
            .unwrap(),
        vec![intent.source.agent_id.clone()]
    );
    assert_eq!(
        store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap(),
        vec![intent.source.agent_id.clone()]
    );
    assert_eq!(
        store.admit_agent_runtime_close(&intent).await.unwrap(),
        admitted
    );
    drop(store);

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .effective_agent_runtime_close(&intent.source.agent_id)
            .await
            .unwrap(),
        Some(admitted.clone())
    );
    assert_eq!(
        reopened
            .agent_runtime_startup_recovery_candidates()
            .await
            .unwrap(),
        vec![intent.source.agent_id.clone()]
    );
    assert_eq!(
        reopened
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap(),
        vec![intent.source.agent_id.clone()]
    );
    let request = AgentRuntimeCloseAdvanceRequestV1 {
        schema_version: 1,
        operation_id: intent.operation_id.clone(),
        expected_journal_revision: 1,
        advance: AgentRuntimeCloseAdvanceV1::Stopped,
        advanced_at_ms: 120,
    };
    let stopped = reopened
        .advance_agent_runtime_close(&request)
        .await
        .unwrap();
    assert_eq!(stopped.state, AgentRuntimeCloseStateV1::Stopped);
    assert_eq!(
        reopened
            .advance_agent_runtime_close(&request)
            .await
            .unwrap(),
        stopped
    );
    assert_eq!(
        reopened
            .effective_agent_runtime_close(&intent.source.agent_id)
            .await
            .unwrap(),
        Some(stopped)
    );
    assert!(
        reopened
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn terminal_close_fences_only_its_exact_selection_generation() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&temp_dir.path().join("domain.sqlite")).await;
    let first = close_intent();
    let admitted = store.admit_agent_runtime_close(&first).await.unwrap();
    let stopped = store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: first.operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: 120,
        })
        .await
        .unwrap();

    let mut successor_selection = first.source.clone();
    successor_selection.revision = 2;
    successor_selection.selected_by_operation_id =
        Some(OperationIdV1::new("native-successor-1").unwrap());
    successor_selection.updated_at_ms = 130;
    successor_selection.validate().unwrap();
    let mut connection = store.pool.acquire().await.unwrap();
    begin_immediate(&mut connection, "test_publish_successor_selection")
        .await
        .unwrap();
    agent_runtime_transition::update_selection(
        &mut connection,
        &first.source,
        &successor_selection,
    )
    .await
    .unwrap();
    sqlx::query("COMMIT")
        .execute(&mut *connection)
        .await
        .unwrap();
    drop(connection);

    assert!(
        store
            .effective_agent_runtime_close(&first.source.agent_id)
            .await
            .unwrap()
            .is_none(),
        "a stopped predecessor must not close its published successor"
    );
    assert_eq!(
        store
            .agent_runtime_close(&first.operation_id)
            .await
            .unwrap(),
        Some(stopped),
        "advancing the selection must preserve exact close history"
    );

    let successor = AgentRuntimeCloseIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new("runtime-close-successor").unwrap(),
        idempotency_key: "runtime-close-successor".into(),
        source: successor_selection,
        source_authority: first.source_authority,
        stopped_transition: None,
        requested_at_ms: 140,
    };
    assert_eq!(
        store
            .admit_agent_runtime_close(&successor)
            .await
            .unwrap()
            .state,
        AgentRuntimeCloseStateV1::Admitted,
        "the close index must admit the new generation independently"
    );
}

#[tokio::test]
async fn agent_removal_close_cannot_be_bypassed_by_a_native_successor() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&temp_dir.path().join("domain.sqlite")).await;
    let structured = selection();
    let mut source = structured.clone();
    source.interaction_profile = AgentInteractionProfileV1::NativeCli;
    source.revision = 2;
    source.selected_by_operation_id = Some(OperationIdV1::new("select-native-runtime").unwrap());
    source.updated_at_ms = 105;
    let authority = AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: SessionBindingRecordV1 {
            agent_id: source.agent_id.clone(),
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            session_id: "native-session-1".into(),
            provider_conversation_id: Some("thread-1".into()),
            credential_reference_id: None,
            binding_generation: 1,
            bound_at_ms: 105,
        },
        runtime_workspace_id: "native-workspace-1".into(),
        runner_principal: "runner-1".into(),
        runner_instance: "instance-1".into(),
        channel_epoch: "1".into(),
        host_instance_id: "host-1".into(),
        terminal_epoch: "terminal-1".into(),
        updated_at_ms: 105,
    };
    store
        .upsert_agent_checkpoint_binding_authority(&authority)
        .await
        .unwrap();
    let mut connection = store.pool.acquire().await.unwrap();
    begin_immediate(&mut connection, "test_select_native_runtime")
        .await
        .unwrap();
    agent_runtime_transition::update_selection(&mut connection, &structured, &source)
        .await
        .unwrap();
    sqlx::query("COMMIT")
        .execute(&mut *connection)
        .await
        .unwrap();
    drop(connection);

    let close_operation = OperationIdV1::new("agent-removal-runtime-close").unwrap();
    let admitted = store
        .admit_agent_runtime_close(&AgentRuntimeCloseIntentV1 {
            schema_version: 1,
            operation_id: close_operation.clone(),
            idempotency_key: "agent-removal-runtime-close".into(),
            source: source.clone(),
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: authority.clone(),
            },
            stopped_transition: None,
            requested_at_ms: 110,
        })
        .await
        .unwrap();
    store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: close_operation.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: 120,
        })
        .await
        .unwrap();
    sqlx::query(
        r#"
        INSERT INTO agent_dispatch_stops (
            operation_id, agent_id, spawn_operation_id, plan_token, state,
            journal_revision, runtime_selection_json, runtime_authority_json,
            workspace_action_json, runtime_close_operation_id,
            terminal_workspace_receipt_json, planned_at_ms, authorized_at_ms,
            updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, 'authorized', 2, ?5, ?6, ?7, ?8, NULL, 100, 110, 120)
        "#,
    )
    .bind("agent-removal-stop")
    .bind(source.agent_id.as_str())
    .bind("agent-removal-spawn")
    .bind("agent-removal-plan-token")
    .bind(serde_json::to_string(&source).unwrap())
    .bind(
        serde_json::to_string(&AgentRuntimeBindingAuthorityV1::NativeCli {
            authority: authority.clone(),
        })
        .unwrap(),
    )
    .bind(serde_json::json!({ "workspaceDisposition": "preserve" }).to_string())
    .bind(close_operation.as_str())
    .execute(&store.pool)
    .await
    .unwrap();

    let mut connection = store.pool.acquire().await.unwrap();
    let error = agent_runtime_close::ensure_runtime_successor_source_on(
        &mut connection,
        &source,
        &AgentRuntimeBindingAuthorityV1::NativeCli { authority },
        &OperationIdV1::new("resume-after-agent-removal").unwrap(),
        130,
    )
    .await
    .unwrap_err();
    assert!(matches!(error, DomainStoreErrorV1::IdentityConflict { .. }));
}

#[tokio::test]
async fn retained_close_reopens_the_source_and_preserves_exact_attempt_history() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&temp_dir.path().join("domain.sqlite")).await;
    let first = close_intent();
    let admitted = store.admit_agent_runtime_close(&first).await.unwrap();
    let retained = store
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: first.operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::SourceRetained,
            advanced_at_ms: 120,
        })
        .await
        .unwrap();

    assert_eq!(retained.state, AgentRuntimeCloseStateV1::SourceRetained);
    assert!(
        store
            .effective_agent_runtime_close(&first.source.agent_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
    store
        .record_agent_turn_intent(&AgentStartTurnIntentV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            interaction_session_id: binding().interaction_session_id,
            runtime: binding().runtime,
            turn_id: AgentTurnIdV1::new("turn-after-retained-close").unwrap(),
            client_message_id: AgentClientMessageIdV1::new("message-after-retained-close").unwrap(),
            input: "source remains open".into(),
            requested_at_ms: 121,
        })
        .await
        .unwrap();

    let mut successor = close_intent();
    successor.operation_id = OperationIdV1::new("runtime-close-2").unwrap();
    successor.idempotency_key = "runtime-close-agent-1-second".into();
    successor.requested_at_ms = 122;
    store.admit_agent_runtime_close(&successor).await.unwrap();
    assert_eq!(
        store.admit_agent_runtime_close(&first).await.unwrap(),
        retained,
        "an exact retained replay must ignore a newer effective close"
    );
    let mut concurrent = successor.clone();
    concurrent.operation_id = OperationIdV1::new("runtime-close-3").unwrap();
    concurrent.idempotency_key = "runtime-close-agent-1-third".into();
    assert!(matches!(
        store.admit_agent_runtime_close(&concurrent).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
}

#[tokio::test]
async fn close_and_runtime_transition_are_mutually_exclusive() {
    let close_first = TempDir::new().unwrap();
    let store = initialized_store(&close_first.path().join("domain.sqlite")).await;
    store
        .admit_agent_runtime_close(&close_intent())
        .await
        .unwrap();
    assert!(matches!(
        store
            .admit_agent_runtime_transition(&transition_intent())
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));

    let transition_first = TempDir::new().unwrap();
    let store = initialized_store(&transition_first.path().join("domain.sqlite")).await;
    store
        .admit_agent_runtime_transition(&transition_intent())
        .await
        .unwrap();
    assert!(matches!(
        store.admit_agent_runtime_close(&close_intent()).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
}

#[tokio::test]
async fn exact_repair_required_transition_can_be_closed_and_replayed() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&temp_dir.path().join("domain.sqlite")).await;
    let (_, parked) = park_transition(&store).await;
    let exact = close_parked_transition(&parked, "close-parked-transition");
    let mut stale = exact.clone();
    stale.operation_id = OperationIdV1::new("close-stale-transition").unwrap();
    stale.idempotency_key = "close-stale-transition".into();
    stale.stopped_transition.as_mut().unwrap().journal_revision -= 1;

    assert!(matches!(
        store.admit_agent_runtime_close(&stale).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    let admitted = store.admit_agent_runtime_close(&exact).await.unwrap();
    assert_eq!(admitted.intent.stopped_transition, exact.stopped_transition);
    assert_eq!(
        store.admit_agent_runtime_close(&exact).await.unwrap(),
        admitted,
        "the exact close admission must replay after it fences repair"
    );
    let repair = AgentRuntimeTransitionRepairRequestV1 {
        schema_version: 1,
        operation_id: parked.intent.operation_id.clone(),
        expected_journal_revision: parked.journal_revision,
        repair_operation_id: OperationIdV1::new("repair-after-close").unwrap(),
        repaired_at_ms: 150,
    };
    assert!(matches!(
        store
            .authorize_agent_runtime_transition_repair(&repair)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
}

#[tokio::test]
async fn repair_or_supersede_wins_before_a_stale_repair_required_close() {
    let repair_dir = TempDir::new().unwrap();
    let repair_store = initialized_store(&repair_dir.path().join("domain.sqlite")).await;
    let (_, repair_parked) = park_transition(&repair_store).await;
    let stale_repair_close = close_parked_transition(&repair_parked, "close-after-repair");
    let repair = repair_store
        .authorize_agent_runtime_transition_repair(&AgentRuntimeTransitionRepairRequestV1 {
            schema_version: 1,
            operation_id: repair_parked.intent.operation_id.clone(),
            expected_journal_revision: repair_parked.journal_revision,
            repair_operation_id: OperationIdV1::new("repair-before-close").unwrap(),
            repaired_at_ms: 140,
        })
        .await
        .unwrap();
    assert!(matches!(
        repair,
        AgentRuntimeTransitionEffectAuthorizationV1::Authorized(_)
    ));
    assert!(matches!(
        repair_store
            .admit_agent_runtime_close(&stale_repair_close)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));

    let supersede_dir = TempDir::new().unwrap();
    let supersede_store = initialized_store(&supersede_dir.path().join("domain.sqlite")).await;
    let (_, supersede_parked) = park_transition(&supersede_store).await;
    let stale_supersede_close = close_parked_transition(&supersede_parked, "close-after-supersede");
    let mut successor = supersede_parked.intent.clone();
    successor.operation_id = OperationIdV1::new("corrected-transition").unwrap();
    successor.idempotency_key = "corrected-transition".into();
    successor.target_execution_profile = AgentExecutionProfileV1::CredentialReference {
        reference_id: "account-b".into(),
        credential_generation: Some("credential-b-1".into()),
    };
    successor.requested_at_ms = 140;
    let supersede = supersede_store
        .supersede_agent_runtime_transition(&AgentRuntimeTransitionSupersedeRequestV1 {
            schema_version: 1,
            operation_id: supersede_parked.intent.operation_id.clone(),
            expected_journal_revision: supersede_parked.journal_revision,
            successor_intent: successor,
            superseded_at_ms: 140,
        })
        .await
        .unwrap();
    assert!(matches!(
        supersede,
        AgentRuntimeTransitionEffectAuthorizationV1::Authorized(_)
    ));
    assert!(matches!(
        supersede_store
            .admit_agent_runtime_close(&stale_supersede_close)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
}

#[tokio::test]
async fn repair_required_close_fences_supersede_before_it_can_move_authority() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&temp_dir.path().join("domain.sqlite")).await;
    let (_, parked) = park_transition(&store).await;
    store
        .admit_agent_runtime_close(&close_parked_transition(&parked, "close-before-supersede"))
        .await
        .unwrap();
    let mut successor = parked.intent.clone();
    successor.operation_id = OperationIdV1::new("blocked-corrected-transition").unwrap();
    successor.idempotency_key = "blocked-corrected-transition".into();
    successor.target_execution_profile = AgentExecutionProfileV1::CredentialReference {
        reference_id: "account-b".into(),
        credential_generation: Some("credential-b-1".into()),
    };
    successor.requested_at_ms = 150;

    assert!(matches!(
        store
            .supersede_agent_runtime_transition(&AgentRuntimeTransitionSupersedeRequestV1 {
                schema_version: 1,
                operation_id: parked.intent.operation_id.clone(),
                expected_journal_revision: parked.journal_revision,
                successor_intent: successor,
                superseded_at_ms: 150,
            })
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
}

#[tokio::test]
async fn close_rejects_a_stale_structured_binding() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&temp_dir.path().join("domain.sqlite")).await;
    let mut stale = close_intent();
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } =
        &mut stale.source_authority
    else {
        unreachable!();
    };
    binding.runtime.runtime_generation = "runtime-stale".into();

    assert!(matches!(
        store.admit_agent_runtime_close(&stale).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
}

#[tokio::test]
async fn admitted_close_fences_interaction_reopen_replacement_and_commands() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&temp_dir.path().join("domain.sqlite")).await;
    let prepared_before_close = AgentStartTurnIntentV1 {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
        interaction_session_id: binding().interaction_session_id,
        runtime: binding().runtime,
        turn_id: AgentTurnIdV1::new("turn-before-close").unwrap(),
        client_message_id: AgentClientMessageIdV1::new("message-before-close").unwrap(),
        input: "already admitted".into(),
        requested_at_ms: 105,
    };
    store
        .record_agent_turn_intent(&prepared_before_close)
        .await
        .unwrap();
    store
        .admit_agent_runtime_close(&close_intent())
        .await
        .unwrap();

    assert!(
        store
            .record_agent_turn_intent(&prepared_before_close)
            .await
            .is_ok()
    );

    assert!(matches!(
        store.create_agent_interaction(&binding()).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert!(matches!(
        store
            .replace_agent_interaction_runtime(&AgentRuntimeReplacementV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: binding().interaction_session_id,
                expected_binding_revision: 1,
                source: binding().runtime,
                source_execution_profile: AgentExecutionProfileV1::ProviderDefault,
                target: AgentProviderRuntimeFenceV1 {
                    runtime_generation: "runtime-2".into(),
                    provider_epoch: "provider-2".into(),
                },
                target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
                provider_conversation_ref: Some("thread-1".into()),
                replaced_at_ms: 120,
            })
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert!(matches!(
        store
            .record_agent_turn_intent(&AgentStartTurnIntentV1 {
                schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
                interaction_session_id: binding().interaction_session_id,
                runtime: binding().runtime,
                turn_id: AgentTurnIdV1::new("turn-after-close").unwrap(),
                client_message_id: AgentClientMessageIdV1::new("message-after-close").unwrap(),
                input: "must not run".into(),
                requested_at_ms: 120,
            })
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
}

#[tokio::test]
async fn schema_twenty_six_migrates_additively_to_runtime_close_authority() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    sqlx::query("DROP TABLE agent_runtime_closes")
        .execute(&store.pool)
        .await
        .unwrap();
    downgrade_workflow_launch_fixture_to_v31(&store.pool)
        .await
        .unwrap();
    crate::migration_test_support::remove_post_v32_dispatch_stop_storage(&store.pool).await;
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 26, min_reader_version = 26, min_writer_version = 26 WHERE singleton = 1",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info.schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    let table_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'agent_runtime_closes'",
    )
    .fetch_one(&migrated.pool)
    .await
    .unwrap();
    assert_eq!(table_count, 1);
}

#[tokio::test]
async fn schema_twenty_eight_migration_preserves_an_admitted_close() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = initialized_store(&path).await;
    let intent = close_intent();
    let admitted = store.admit_agent_runtime_close(&intent).await.unwrap();
    sqlx::query("DROP TABLE agent_runtime_closes")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        r#"
        CREATE TABLE agent_runtime_closes (
            operation_id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            agent_id TEXT NOT NULL UNIQUE REFERENCES agents(agent_id) ON DELETE CASCADE,
            state TEXT NOT NULL CHECK (state IN ('admitted', 'stopped')),
            journal_revision INTEGER NOT NULL CHECK (journal_revision > 0),
            record_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
            updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
            CHECK (
                (state = 'admitted' AND journal_revision = 1)
                OR (state = 'stopped' AND journal_revision = 2)
            )
        )
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO agent_runtime_closes (
            operation_id,
            idempotency_key,
            agent_id,
            state,
            journal_revision,
            record_json,
            created_at_ms,
            updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        "#,
    )
    .bind(admitted.intent.operation_id.as_str())
    .bind(&admitted.intent.idempotency_key)
    .bind(admitted.intent.source.agent_id.as_str())
    .bind(admitted.state.as_str())
    .bind(admitted.journal_revision)
    .bind(serde_json::to_string(&admitted).unwrap())
    .bind(admitted.created_at_ms)
    .bind(admitted.updated_at_ms)
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(
        sqlx::query(
            "UPDATE agent_runtime_closes SET state = 'source_retained' WHERE operation_id = ?1",
        )
        .bind(intent.operation_id.as_str())
        .execute(&store.pool)
        .await
        .is_err(),
        "the fixture must carry the v28 state CHECK, not the current schema"
    );
    downgrade_workflow_launch_fixture_to_v31(&store.pool)
        .await
        .unwrap();
    crate::migration_test_support::remove_post_v32_dispatch_stop_storage(&store.pool).await;
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 28, min_reader_version = 28, min_writer_version = 28 WHERE singleton = 1",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated
            .agent_runtime_close(&intent.operation_id)
            .await
            .unwrap(),
        Some(admitted.clone())
    );
    let retained = migrated
        .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: intent.operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::SourceRetained,
            advanced_at_ms: 120,
        })
        .await
        .unwrap();
    assert_eq!(retained.state, AgentRuntimeCloseStateV1::SourceRetained);
    let mut successor = close_intent();
    successor.operation_id = OperationIdV1::new("runtime-close-after-migration").unwrap();
    successor.idempotency_key = "runtime-close-after-migration".into();
    successor.requested_at_ms = 121;
    migrated
        .admit_agent_runtime_close(&successor)
        .await
        .unwrap();
    let mut concurrent = successor.clone();
    concurrent.operation_id = OperationIdV1::new("runtime-close-concurrent-migration").unwrap();
    concurrent.idempotency_key = "runtime-close-concurrent-migration".into();
    assert!(
        migrated
            .admit_agent_runtime_close(&concurrent)
            .await
            .is_err(),
        "the migrated partial index must admit one new active close, not two"
    );
}

#[tokio::test]
async fn schema_thirty_seven_migrates_close_uniqueness_to_selection_generation() {
    let temp_dir = TempDir::new().unwrap();
    let path = temp_dir.path().join("domain.sqlite");
    let store = initialized_store(&path).await;
    let mut connection = store.pool.acquire().await.unwrap();
    sqlx::query("DROP INDEX agent_runtime_closes_active_idx")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query(
        r#"
        CREATE UNIQUE INDEX agent_runtime_closes_active_idx
        ON agent_runtime_closes (agent_id)
        WHERE state != 'source_retained'
        "#,
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 37, min_reader_version = 37, min_writer_version = 37 WHERE singleton = 1",
    )
    .execute(&mut *connection)
    .await
    .unwrap();
    drop(connection);
    store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info.schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    let index_sql: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'agent_runtime_closes_active_idx'",
    )
    .fetch_one(&migrated.pool)
    .await
    .unwrap();
    assert!(index_sql.contains("json_extract"));
    assert!(index_sql.contains("source.revision"));
}
