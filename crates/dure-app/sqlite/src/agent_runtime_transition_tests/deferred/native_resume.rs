use super::*;
use dure_app::{
    AgentRuntimeNativeRehostCommitV1, AgentRuntimeNativeRehostRepairTransitionV1,
    AgentRuntimeNativeRehostSourceV1, AgentRuntimeTransitionRecordV1,
};

fn resume(record: &AgentRuntimeTransitionRecordV1) -> AgentRuntimeNativeRehostCommitV1 {
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority: source } =
        &record.intent.source_authority
    else {
        unreachable!()
    };
    let mut target = source.clone();
    target.binding.session_id = "native-resumed-session".into();
    target.binding.binding_generation += 1;
    target.binding.bound_at_ms = 150;
    target.host_instance_id = "native-resumed-host".into();
    target.terminal_epoch = "native-resumed-terminal".into();
    target.updated_at_ms = 150;
    AgentRuntimeNativeRehostCommitV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new("native-resume").unwrap(),
        request_source: AgentRuntimeNativeRehostSourceV1::from_authority(source),
        source_selection: record.intent.source.clone(),
        source_authority: source.clone(),
        repair_transition: Some(AgentRuntimeNativeRehostRepairTransitionV1 {
            operation_id: record.intent.operation_id.clone(),
            expected_journal_revision: record.journal_revision,
            retain_replacement_authority: true,
            retired_replacement_authority: None,
        }),
        target_authority: target,
        target_execution_profile: record.intent.source.execution_profile.clone(),
        target_permission_mode: record.intent.source.permission_mode.clone(),
        target_launch_idempotency_key: OperationIdV1::new("native-resume").unwrap(),
        target_provider_launch_reference: None,
        committed_at_ms: 150,
    }
}

#[tokio::test]
async fn deferred_native_resume_uses_exact_atomic_publication() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let stopped = stopped_deferred(&store).await;
    let request = resume(&stopped);
    for variant in 0..3 {
        let mut wrong = request.clone();
        match variant {
            0 => {
                wrong
                    .repair_transition
                    .as_mut()
                    .unwrap()
                    .expected_journal_revision += 1
            }
            1 => wrong.source_authority.host_instance_id = "unobserved-host".into(),
            _ => {
                wrong.target_authority.binding.provider_conversation_id =
                    Some("other-thread".into())
            }
        }
        assert!(
            store
                .commit_agent_runtime_native_rehost(&wrong)
                .await
                .is_err()
        );
        assert_eq!(
            store
                .active_agent_runtime_transition(&stopped.intent.source.agent_id)
                .await
                .unwrap(),
            Some(stopped.clone())
        );
    }
    // Fail the final receipt write after the journal and binding updates. The
    // existing transaction must roll back all three, leaving the same retry.
    sqlx::query("CREATE TRIGGER fail_dormant_resume BEFORE INSERT ON agent_runtime_native_rehost_receipts BEGIN SELECT RAISE(ABORT, 'fixture'); END")
        .execute(&store.pool).await.unwrap();
    assert!(
        store
            .commit_agent_runtime_native_rehost(&request)
            .await
            .is_err()
    );
    assert_eq!(
        store
            .active_agent_runtime_transition(&stopped.intent.source.agent_id)
            .await
            .unwrap(),
        Some(stopped.clone())
    );
    assert_eq!(
        store
            .agent_checkpoint_binding_authority(&stopped.intent.source.agent_id)
            .await
            .unwrap(),
        Some(request.source_authority.clone())
    );
    sqlx::query("DROP TRIGGER fail_dormant_resume")
        .execute(&store.pool)
        .await
        .unwrap();

    let committed = store
        .commit_agent_runtime_native_rehost(&request)
        .await
        .unwrap();
    assert_eq!(committed.authority, request.target_authority);
    assert_eq!(
        committed.selection.revision,
        stopped.intent.source.revision + 1
    );
    let retired = store
        .agent_runtime_transition(&stopped.intent.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retired.state, AgentRuntimeTransitionStateV1::Superseded);
    assert_eq!(retired.journal_revision, stopped.journal_revision + 1);
    assert_eq!(
        retired.superseded_by_operation_id,
        Some(request.operation_id)
    );
    assert!(retired.target_failure.is_none());
    assert!(retired.target_authority.is_none());
    assert!(
        store
            .active_agent_runtime_transition(&stopped.intent.source.agent_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .authorize_agent_runtime_transition_wake(&wake(&stopped.intent))
            .await
            .is_err()
    );
    assert!(
        store
            .agent_runtime_startup_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn deferred_native_resume_cannot_discard_a_live_or_waking_transition() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let stopped = stopped_deferred(&store).await;
    let admitted =
        AgentRuntimeTransitionRecordV1::admitted_deferred(stopped.intent.clone()).unwrap();
    assert!(
        dure_app::supersede_agent_runtime_transition_with_native_rehost_v1(
            &admitted,
            &resume(&admitted)
        )
        .is_err()
    );
    let AgentRuntimeTransitionEffectAuthorizationV1::Authorized(waking) = store
        .authorize_agent_runtime_transition_wake(&wake(&stopped.intent))
        .await
        .unwrap()
    else {
        panic!("first wake must authorize")
    };
    assert!(
        store
            .commit_agent_runtime_native_rehost(&resume(&waking))
            .await
            .is_err()
    );
    assert_eq!(
        store
            .active_agent_runtime_transition(&stopped.intent.source.agent_id)
            .await
            .unwrap(),
        Some(waking)
    );
}
