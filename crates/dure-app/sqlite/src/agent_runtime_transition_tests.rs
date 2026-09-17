use std::sync::Arc;

use dure_app::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AgentCheckpointBindingAuthorityV1, AgentExecutionProfileV1,
    AgentIdV1, AgentInteractionBindingV1, AgentInteractionProfileV1, AgentInteractionSessionIdV1,
    AgentProviderRuntimeFenceV1, AgentRecordV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeReplacementAuthorityUpdateV1, AgentRuntimeSelectionV1,
    AgentRuntimeTargetFailureKindV1, AgentRuntimeTargetFailureV1,
    AgentRuntimeTransitionAdvanceRequestV1, AgentRuntimeTransitionAdvanceV1,
    AgentRuntimeTransitionEffectAuthorizationV1, AgentRuntimeTransitionIntentV1,
    AgentRuntimeTransitionRepairRequestV1, AgentRuntimeTransitionStateV1,
    AgentRuntimeTransitionStore, AgentRuntimeTransitionSupersedeRequestV1,
    AgentSpawnModelSelectionV1, AgentTimelineEpochV1, AgentTimelineStore,
    CURRENT_STORE_SCHEMA_VERSION, DomainStore, DomainStoreErrorV1, OperationIdV1, ProjectIdV1,
    ProjectRecordV1, ProviderIdV1, ProviderPermissionModeV1, RuntimeKindIdV1,
    SessionBindingRecordV1, WorkspaceIdV1, WorkspaceRecordV1,
};
use tempfile::TempDir;
use tokio::sync::Barrier;

use super::SqliteDomainStore;
use super::schema::downgrade_workflow_launch_fixture_to_v31;

mod checkout_handoff;
mod deferred;
mod idle_candidates;
mod request_replay;

fn database_path(temp_dir: &TempDir) -> std::path::PathBuf {
    temp_dir.path().join("domain.sqlite")
}

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
            provider_id: ProviderIdV1::new("claude").unwrap(),
            display_name: "Claude".into(),
            created_at_ms: 30,
            updated_at_ms: 30,
        })
        .await
        .unwrap();
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = native_authority() else {
        unreachable!()
    };
    store
        .upsert_agent_checkpoint_binding_authority(&authority)
        .await
        .unwrap();
    store
}

fn execution_profile() -> AgentExecutionProfileV1 {
    AgentExecutionProfileV1::CredentialReference {
        reference_id: "account-work".into(),
        credential_generation: Some("credential-v1".into()),
    }
}

fn native_selection() -> AgentRuntimeSelectionV1 {
    AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: AgentIdV1::new("agent-1").unwrap(),
        provider_id: ProviderIdV1::new("claude").unwrap(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: execution_profile(),
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 100,
    }
}

fn native_authority() -> AgentRuntimeBindingAuthorityV1 {
    AgentRuntimeBindingAuthorityV1::NativeCli {
        authority: AgentCheckpointBindingAuthorityV1 {
            schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
            binding: SessionBindingRecordV1 {
                agent_id: AgentIdV1::new("agent-1").unwrap(),
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                session_id: "session-1".into(),
                provider_conversation_id: Some("conversation-1".into()),
                credential_reference_id: Some("account-work".into()),
                binding_generation: 1,
                bound_at_ms: 90,
            },
            runtime_workspace_id: "workspace-1".into(),
            runner_principal: "runner-principal-1".into(),
            runner_instance: "runner-instance-1".into(),
            channel_epoch: "1".into(),
            host_instance_id: "host-instance-1".into(),
            terminal_epoch: "terminal-epoch-1".into(),
            updated_at_ms: 100,
        },
    }
}

fn intent(operation: &str, idempotency_key: &str) -> AgentRuntimeTransitionIntentV1 {
    AgentRuntimeTransitionIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new(operation).unwrap(),
        idempotency_key: idempotency_key.into(),
        source: native_selection(),
        source_authority: native_authority(),
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
            "conversation-1",
        )
        .unwrap(),
        target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        target_execution_profile: execution_profile(),
        target_launch_selection: None,
        requested_at_ms: 110,
    }
}

fn structured_authority() -> AgentRuntimeBindingAuthorityV1 {
    AgentRuntimeBindingAuthorityV1::StructuredProtocol {
        binding: AgentInteractionBindingV1 {
            schema_version: 1,
            interaction_session_id: AgentInteractionSessionIdV1::new("interaction-1").unwrap(),
            agent_id: AgentIdV1::new("agent-1").unwrap(),
            provider_id: ProviderIdV1::new("claude").unwrap(),
            execution_profile: execution_profile(),
            provider_conversation_ref: Some("conversation-1".into()),
            runtime: AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-generation-2".into(),
                provider_epoch: "provider-epoch-2".into(),
            },
            timeline_epoch: AgentTimelineEpochV1::new("timeline-1").unwrap(),
            binding_revision: 1,
            history_complete: true,
            created_at_ms: 130,
            updated_at_ms: 130,
        },
    }
}

async fn publish_runtime_authority(
    store: &SqliteDomainStore,
    authority: &AgentRuntimeBindingAuthorityV1,
) {
    match authority {
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } => {
            store.create_agent_interaction(binding).await.unwrap();
        }
        AgentRuntimeBindingAuthorityV1::NativeCli { authority } => {
            store
                .upsert_agent_checkpoint_binding_authority(authority)
                .await
                .unwrap();
        }
    }
}

fn advance(
    operation_id: &OperationIdV1,
    expected_journal_revision: i64,
    advance: AgentRuntimeTransitionAdvanceV1,
    advanced_at_ms: i64,
) -> AgentRuntimeTransitionAdvanceRequestV1 {
    AgentRuntimeTransitionAdvanceRequestV1 {
        schema_version: 1,
        operation_id: operation_id.clone(),
        expected_journal_revision,
        advance,
        advanced_at_ms,
    }
}

#[tokio::test]
async fn transition_commit_atomically_replaces_the_single_active_selection() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&temp_dir)).await;
    let source = store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = intent("transition-1", "switch-agent-1-to-chat");
    let admitted = store.admit_agent_runtime_transition(&plan).await.unwrap();
    assert_eq!(
        store
            .active_agent_runtime_transition(&source.agent_id)
            .await
            .unwrap(),
        Some(admitted.clone())
    );
    assert_eq!(
        store.admit_agent_runtime_transition(&plan).await.unwrap(),
        admitted
    );
    let stopped_request = advance(
        &plan.operation_id,
        1,
        AgentRuntimeTransitionAdvanceV1::SourceStopped,
        120,
    );
    let stopped = store
        .advance_agent_runtime_transition(&stopped_request)
        .await
        .unwrap();
    assert_eq!(
        store
            .advance_agent_runtime_transition(&stopped_request)
            .await
            .unwrap(),
        stopped
    );
    let target_authority = structured_authority();
    publish_runtime_authority(&store, &target_authority).await;
    let started = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            2,
            AgentRuntimeTransitionAdvanceV1::TargetStarted {
                launch_idempotency_key: None,
                authority: Box::new(target_authority),
            },
            130,
        ))
        .await
        .unwrap();

    assert_eq!(
        store
            .agent_runtime_selection(&source.agent_id)
            .await
            .unwrap(),
        Some(source)
    );
    assert_eq!(started.state, AgentRuntimeTransitionStateV1::TargetStarted);

    let committed = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            3,
            AgentRuntimeTransitionAdvanceV1::Committed,
            140,
        ))
        .await
        .unwrap();
    let target = plan.target_selection_at(140).unwrap();
    assert_eq!(committed.state, AgentRuntimeTransitionStateV1::Committed);
    assert!(
        store
            .active_agent_runtime_transition(&target.agent_id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .agent_runtime_selection(&target.agent_id)
            .await
            .unwrap(),
        Some(target)
    );
    assert_eq!(
        store
            .agent_runtime_transition_by_idempotency_key("switch-agent-1-to-chat")
            .await
            .unwrap(),
        Some(committed)
    );
}

#[tokio::test]
async fn transition_admission_rejects_a_stale_source_runtime_authority() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&temp_dir)).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let mut stale = intent("transition-stale-source", "switch-stale-source");
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = &mut stale.source_authority
    else {
        unreachable!()
    };
    authority.binding.binding_generation += 1;
    authority.updated_at_ms += 1;

    assert!(matches!(
        store.admit_agent_runtime_transition(&stale).await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert!(
        store
            .agent_runtime_transition(&stale.operation_id)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn target_started_requires_the_provider_published_exact_authority() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&temp_dir)).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = intent("transition-stale-target", "switch-stale-target");
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    let stopped = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            120,
        ))
        .await
        .unwrap();
    let target_authority = structured_authority();
    let started_request = advance(
        &plan.operation_id,
        stopped.journal_revision,
        AgentRuntimeTransitionAdvanceV1::TargetStarted {
            launch_idempotency_key: None,
            authority: Box::new(target_authority.clone()),
        },
        130,
    );

    assert!(matches!(
        store
            .advance_agent_runtime_transition(&started_request)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert_eq!(
        store
            .agent_runtime_transition(&plan.operation_id)
            .await
            .unwrap()
            .unwrap(),
        stopped
    );

    publish_runtime_authority(&store, &target_authority).await;
    assert_eq!(
        store
            .advance_agent_runtime_transition(&started_request)
            .await
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::TargetStarted
    );
}

#[tokio::test]
async fn native_target_started_replay_rechecks_the_current_checkpoint_authority() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&temp_dir)).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let mut plan = intent("transition-native-target", "switch-native-target");
    plan.target_interaction_profile = AgentInteractionProfileV1::NativeCli;
    plan.target_execution_profile = AgentExecutionProfileV1::CredentialReference {
        reference_id: "account-b".into(),
        credential_generation: Some("credential-b-1".into()),
    };
    let admitted = store.admit_agent_runtime_transition(&plan).await.unwrap();
    let stopped = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            admitted.journal_revision,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            120,
        ))
        .await
        .unwrap();
    let AgentRuntimeBindingAuthorityV1::NativeCli {
        authority: mut target,
    } = native_authority()
    else {
        unreachable!()
    };
    target.binding.session_id = "session-b".into();
    target.binding.credential_reference_id = Some("account-b".into());
    target.binding.binding_generation = 2;
    target.binding.bound_at_ms = 130;
    target.runner_principal = "runner-principal-b".into();
    target.runner_instance = "runner-instance-b".into();
    target.channel_epoch = "2".into();
    target.host_instance_id = "host-instance-b".into();
    target.terminal_epoch = "terminal-epoch-b".into();
    target.updated_at_ms = 130;
    store
        .upsert_agent_checkpoint_binding_authority(&target)
        .await
        .unwrap();
    let target_authority = AgentRuntimeBindingAuthorityV1::NativeCli {
        authority: target.clone(),
    };
    let started_request = advance(
        &plan.operation_id,
        stopped.journal_revision,
        AgentRuntimeTransitionAdvanceV1::TargetStarted {
            launch_idempotency_key: Some("runtime-native-successor-key".into()),
            authority: Box::new(target_authority),
        },
        130,
    );
    let started = store
        .advance_agent_runtime_transition(&started_request)
        .await
        .unwrap();
    assert_eq!(started.state, AgentRuntimeTransitionStateV1::TargetStarted);

    let mut newer = target;
    newer.binding.session_id = "session-c".into();
    newer.binding.binding_generation = 3;
    newer.binding.bound_at_ms = 140;
    newer.runner_principal = "runner-principal-c".into();
    newer.runner_instance = "runner-instance-c".into();
    newer.channel_epoch = "3".into();
    newer.host_instance_id = "host-instance-c".into();
    newer.terminal_epoch = "terminal-epoch-c".into();
    newer.updated_at_ms = 140;
    store
        .upsert_agent_checkpoint_binding_authority(&newer)
        .await
        .unwrap();

    assert!(matches!(
        store
            .advance_agent_runtime_transition(&started_request)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
}

#[tokio::test]
async fn source_stop_policy_is_durable_idempotency_authority() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&temp_dir)).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let mut discard = intent("transition-discard", "switch-agent-1-discard");
    discard.source_stop_policy = dure_app::AgentRuntimeSourceStopPolicyV1::Discard;

    let admitted = store
        .admit_agent_runtime_transition(&discard)
        .await
        .unwrap();
    assert_eq!(
        admitted.intent.source_stop_policy,
        dure_app::AgentRuntimeSourceStopPolicyV1::Discard
    );
    assert_eq!(
        store
            .agent_runtime_transition(&discard.operation_id)
            .await
            .unwrap()
            .unwrap()
            .intent
            .source_stop_policy,
        dure_app::AgentRuntimeSourceStopPolicyV1::Discard
    );

    let mut conflicting_replay = discard;
    conflicting_replay.source_stop_policy = dure_app::AgentRuntimeSourceStopPolicyV1::Preserve;
    assert!(matches!(
        store
            .admit_agent_runtime_transition(&conflicting_replay)
            .await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));
}

#[tokio::test]
async fn repair_authorization_is_exact_and_replay_cannot_authorize_another_effect() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&temp_dir)).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = intent("transition-repair", "switch-repair");
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            120,
        ))
        .await
        .unwrap();
    let failure = AgentRuntimeTargetFailureV1::new(
        AgentRuntimeTargetFailureKindV1::CredentialUnavailable,
        "claude_credential_unavailable",
    )
    .unwrap();
    let parked = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            2,
            AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: failure.clone(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
            },
            130,
        ))
        .await
        .unwrap();
    let request = AgentRuntimeTransitionRepairRequestV1 {
        schema_version: 1,
        operation_id: plan.operation_id.clone(),
        expected_journal_revision: parked.journal_revision,
        repair_operation_id: OperationIdV1::new("repair-operation-1").unwrap(),
        repaired_at_ms: 140,
    };
    let authorization = store
        .authorize_agent_runtime_transition_repair(&request)
        .await
        .unwrap();
    let AgentRuntimeTransitionEffectAuthorizationV1::Authorized(authorized) = authorization else {
        panic!("the first exact repair must grant one authorization")
    };
    assert_eq!(
        authorized.state,
        AgentRuntimeTransitionStateV1::SourceStopped
    );
    assert_eq!(authorized.target_failure, None);

    let failed_again = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            authorized.journal_revision,
            AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure,
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
            },
            150,
        ))
        .await
        .unwrap();
    assert_eq!(
        store
            .authorize_agent_runtime_transition_repair(&request)
            .await
            .unwrap(),
        AgentRuntimeTransitionEffectAuthorizationV1::Replayed(failed_again),
        "transport replay observes the later journal state without reopening it"
    );
}

#[tokio::test]
async fn corrected_target_atomically_replaces_one_failed_intent() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&temp_dir)).await;
    let source = store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = intent("transition-superseded", "switch-superseded");
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            120,
        ))
        .await
        .unwrap();
    let parked = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            2,
            AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: AgentRuntimeTargetFailureV1::new(
                    AgentRuntimeTargetFailureKindV1::LaunchFailed,
                    "claude_launch_failed",
                )
                .unwrap(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
            },
            130,
        ))
        .await
        .unwrap();
    let mut successor_intent = plan.clone();
    successor_intent.operation_id = OperationIdV1::new("transition-successor").unwrap();
    successor_intent.idempotency_key = "switch-successor".into();
    successor_intent.target_launch_selection = Some(dure_app::AgentRuntimeLaunchSelectionV1 {
        model: Some(AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()),
        effort: None,
        permission_mode: None,
    });
    successor_intent.requested_at_ms = 140;
    let request = AgentRuntimeTransitionSupersedeRequestV1 {
        schema_version: 1,
        operation_id: plan.operation_id.clone(),
        expected_journal_revision: parked.journal_revision,
        successor_intent,
        superseded_at_ms: 140,
    };

    let outcome = store
        .supersede_agent_runtime_transition(&request)
        .await
        .unwrap();
    let AgentRuntimeTransitionEffectAuthorizationV1::Authorized(successor) = outcome else {
        panic!("the first exact supersede must create one successor")
    };
    assert_eq!(
        successor.state,
        AgentRuntimeTransitionStateV1::SourceStopped
    );
    assert_eq!(
        successor.predecessor_operation_id.as_ref(),
        Some(&plan.operation_id)
    );
    assert_eq!(
        store
            .active_agent_runtime_transition(&source.agent_id)
            .await
            .unwrap(),
        Some(successor.clone())
    );
    assert_eq!(
        store
            .agent_runtime_transition(&plan.operation_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::Superseded
    );
    assert_eq!(
        store
            .supersede_agent_runtime_transition(&request)
            .await
            .unwrap(),
        AgentRuntimeTransitionEffectAuthorizationV1::Replayed(successor),
        "the same supersede operation replays its single successor"
    );
}

#[tokio::test]
async fn successor_insert_failure_rolls_back_the_superseded_record() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&temp_dir)).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = intent("transition-rollback", "switch-rollback");
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            120,
        ))
        .await
        .unwrap();
    let parked = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            2,
            AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: AgentRuntimeTargetFailureV1::new(
                    AgentRuntimeTargetFailureKindV1::LaunchFailed,
                    "claude_launch_failed",
                )
                .unwrap(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
            },
            130,
        ))
        .await
        .unwrap();
    let mut successor_intent = plan.clone();
    successor_intent.operation_id = OperationIdV1::new("transition-rollback-successor").unwrap();
    successor_intent.idempotency_key = "switch-rollback-successor".into();
    successor_intent.target_launch_selection = Some(dure_app::AgentRuntimeLaunchSelectionV1 {
        model: Some(AgentSpawnModelSelectionV1::parse("claude-opus-4-1").unwrap()),
        effort: None,
        permission_mode: None,
    });
    successor_intent.requested_at_ms = 140;
    sqlx::query(
        r#"
        CREATE TRIGGER fail_runtime_transition_successor
        BEFORE INSERT ON agent_runtime_transitions
        WHEN NEW.operation_id = 'transition-rollback-successor'
        BEGIN
            SELECT RAISE(ABORT, 'injected successor insert failure');
        END
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();

    assert!(matches!(
        store
            .supersede_agent_runtime_transition(&AgentRuntimeTransitionSupersedeRequestV1 {
                schema_version: 1,
                operation_id: plan.operation_id.clone(),
                expected_journal_revision: parked.journal_revision,
                successor_intent,
                superseded_at_ms: 140,
            })
            .await,
        Err(DomainStoreErrorV1::Storage { .. })
    ));
    assert_eq!(
        store
            .agent_runtime_transition(&plan.operation_id)
            .await
            .unwrap(),
        Some(parked)
    );
}

#[tokio::test]
async fn retained_source_releases_the_active_slot_without_discarding_history() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&temp_dir)).await;
    let source = store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let first = intent("transition-retained", "switch-retained");
    store.admit_agent_runtime_transition(&first).await.unwrap();
    let retained = store
        .advance_agent_runtime_transition(&advance(
            &first.operation_id,
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
            .active_agent_runtime_transition(&source.agent_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !store
            .agent_runtime_incomplete_recovery_candidates()
            .await
            .unwrap()
            .contains(&source.agent_id)
    );
    assert_eq!(
        store
            .agent_runtime_transition(&first.operation_id)
            .await
            .unwrap(),
        Some(retained)
    );

    let second = intent("transition-after-retained", "switch-after-retained");
    let admitted = store.admit_agent_runtime_transition(&second).await.unwrap();
    assert_eq!(
        store
            .active_agent_runtime_transition(&source.agent_id)
            .await
            .unwrap(),
        Some(admitted)
    );
}

#[tokio::test]
async fn commit_journal_failure_rolls_back_the_selection_replacement() {
    let temp_dir = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&temp_dir)).await;
    let source = store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = intent("transition-1", "switch-agent-1-to-chat");
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            120,
        ))
        .await
        .unwrap();
    let target_authority = structured_authority();
    publish_runtime_authority(&store, &target_authority).await;
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            2,
            AgentRuntimeTransitionAdvanceV1::TargetStarted {
                launch_idempotency_key: None,
                authority: Box::new(target_authority),
            },
            130,
        ))
        .await
        .unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER fail_runtime_transition_commit
        BEFORE UPDATE ON agent_runtime_transitions
        WHEN NEW.state = 'committed'
        BEGIN
            SELECT RAISE(ABORT, 'injected transition commit failure');
        END
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();

    assert!(matches!(
        store
            .advance_agent_runtime_transition(&advance(
                &plan.operation_id,
                3,
                AgentRuntimeTransitionAdvanceV1::Committed,
                140,
            ))
            .await,
        Err(DomainStoreErrorV1::Storage { .. })
    ));
    assert_eq!(
        store
            .agent_runtime_selection(&source.agent_id)
            .await
            .unwrap(),
        Some(source)
    );
    assert_eq!(
        store
            .agent_runtime_transition(&plan.operation_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::TargetStarted
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_admission_allows_only_one_active_replacement_per_agent() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    let first_store = initialized_store(&path).await;
    first_store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let second_store = SqliteDomainStore::open(&path).await.unwrap();
    let barrier = Arc::new(Barrier::new(3));

    let first_barrier = Arc::clone(&barrier);
    let first = tokio::spawn(async move {
        first_barrier.wait().await;
        first_store
            .admit_agent_runtime_transition(&intent("transition-a", "switch-a"))
            .await
    });
    let second_barrier = Arc::clone(&barrier);
    let second = tokio::spawn(async move {
        second_barrier.wait().await;
        second_store
            .admit_agent_runtime_transition(&intent("transition-b", "switch-b"))
            .await
    });
    barrier.wait().await;
    let results = [first.await.unwrap(), second.await.unwrap()];

    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(DomainStoreErrorV1::IdentityConflict { .. })))
            .count(),
        1
    );
}

#[tokio::test]
async fn schema_twenty_five_migrates_additively_to_runtime_transition_tables() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    let store = SqliteDomainStore::open(&path).await.unwrap();
    sqlx::query("DROP TABLE agent_runtime_transitions")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE agent_runtime_selections")
        .execute(&store.pool)
        .await
        .unwrap();
    downgrade_workflow_launch_fixture_to_v31(&store.pool)
        .await
        .unwrap();
    crate::migration_test_support::remove_post_v32_dispatch_stop_storage(&store.pool).await;
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 25, min_reader_version = 25, min_writer_version = 25 WHERE singleton = 1",
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
        r#"
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('agent_runtime_selections', 'agent_runtime_transitions')
        "#,
    )
    .fetch_one(&migrated.pool)
    .await
    .unwrap();
    assert_eq!(table_count, 2);
}

#[tokio::test]
async fn schema_twenty_eight_migration_preserves_an_admitted_transition() {
    let temp_dir = TempDir::new().unwrap();
    let path = database_path(&temp_dir);
    let store = initialized_store(&path).await;
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let plan = intent("transition-before-migration", "switch-before-migration");
    let admitted = store.admit_agent_runtime_transition(&plan).await.unwrap();
    sqlx::query("DROP INDEX agent_runtime_transitions_active_idx")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE agent_runtime_transitions")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        r#"
        CREATE TABLE agent_runtime_transitions (
            operation_id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
            state TEXT NOT NULL CHECK (
                state IN ('admitted', 'source_stopped', 'target_started', 'committed')
            ),
            journal_revision INTEGER NOT NULL CHECK (journal_revision > 0),
            record_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
            updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
            CHECK (
                (state = 'admitted' AND journal_revision = 1)
                OR (state = 'source_stopped' AND journal_revision = 2)
                OR (state = 'target_started' AND journal_revision = 3)
                OR (state = 'committed' AND journal_revision = 4)
            )
        )
        "#,
    )
    .execute(&store.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO agent_runtime_transitions (
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
    sqlx::query(
        "CREATE UNIQUE INDEX agent_runtime_transitions_active_idx ON agent_runtime_transitions (agent_id) WHERE state != 'committed'",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(
        sqlx::query(
            "UPDATE agent_runtime_transitions SET state = 'source_retained' WHERE operation_id = ?1",
        )
        .bind(plan.operation_id.as_str())
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
        migrated.schema_info.schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    assert_eq!(
        migrated
            .agent_runtime_transition(&plan.operation_id)
            .await
            .unwrap(),
        Some(admitted)
    );
    let retained = migrated
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
    let successor = intent("transition-after-migration", "switch-after-migration");
    migrated
        .admit_agent_runtime_transition(&successor)
        .await
        .unwrap();
    assert!(
        migrated
            .admit_agent_runtime_transition(&intent(
                "transition-concurrent-after-migration",
                "switch-concurrent-after-migration",
            ))
            .await
            .is_err(),
        "the migrated partial index must admit one new active attempt, not two"
    );
}
