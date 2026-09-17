use super::*;
use dure_app::{
    AgentCheckpointBindingAuthorityV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeCloseAdvanceRequestV1, AgentRuntimeCloseAdvanceV1, AgentRuntimeCloseIntentV1,
    AgentRuntimeCloseRecordV1, AgentRuntimeRemovalPlanV1, RuntimeKindIdV1, SessionBindingRecordV1,
    advance_agent_runtime_close_v1,
};

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn removal_finalizes_refresh_roots_missing_from_the_selected_projection() {
    let fixture = Fixture::new(true).await;
    let registered = fixture.register("refresh-removal").await.unwrap();
    let request = fixture.request(&registered.root);
    let source = ready(fixture.runtime.advance(request.clone()).await.unwrap());
    let selection = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id(),
        provider_id: ProviderIdV1::new("local-shell").unwrap(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 1,
    };
    fixture
        .store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();
    let receipt = source.receipt();
    let fence = receipt.generation_fence().unwrap();
    let authority = AgentRuntimeBindingAuthorityV1::NativeCli {
        authority: AgentCheckpointBindingAuthorityV1 {
            schema_version: 1,
            binding: SessionBindingRecordV1 {
                agent_id: agent_id(),
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                session_id: receipt.session_id().into(),
                provider_conversation_id: None,
                credential_reference_id: None,
                binding_generation: 1,
                bound_at_ms: 1,
            },
            runtime_workspace_id: receipt.workspace_id().into(),
            runner_principal: fence.runner_principal().into(),
            runner_instance: fence.runner_instance().into(),
            channel_epoch: fence.channel_epoch().to_string(),
            host_instance_id: fence.host_instance_id().into(),
            terminal_epoch: fence.terminal_epoch().into(),
            updated_at_ms: 1,
        },
    };
    let admitted = AgentRuntimeCloseRecordV1::admitted(AgentRuntimeCloseIntentV1 {
        schema_version: 1,
        operation_id: operation("remove-after-refresh"),
        idempotency_key: "remove-after-refresh".into(),
        source: selection,
        source_authority: authority,
        stopped_transition: None,
        requested_at_ms: 2,
    })
    .unwrap();
    let target = ready(
        fixture
            .runtime
            .replace_current_and_advance(request)
            .await
            .unwrap(),
    );
    // Simulate a lost projection update: the selected source really is retired,
    // but the newer live Host exists only in the admitted resource membership.
    assert_eq!(
        probe_local_process_generation(&source.session().descriptor().provider_process).unwrap(),
        LocalProcessGenerationStatus::Absent
    );
    let stopped = advance_agent_runtime_close_v1(
        &admitted,
        &AgentRuntimeCloseAdvanceRequestV1 {
            schema_version: 1,
            operation_id: admitted.intent.operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeCloseAdvanceV1::Stopped,
            advanced_at_ms: 3,
        },
    )
    .unwrap();
    let plan = AgentRuntimeRemovalPlanV1 {
        checkout: Some(registered.binding),
        managed_roots: vec![managed_identity(
            &fixture.runtime.namespace,
            registered.root.idempotency_key(),
            registered.root.session_id(),
            registered.root.workspace_id(),
        )],
    };
    fixture
        .runtime
        .finish_agent_removal(&stopped, &plan)
        .await
        .unwrap();
    assert_eq!(
        probe_local_process_generation(&target.session().descriptor().provider_process).unwrap(),
        LocalProcessGenerationStatus::Absent
    );
    assert_eq!(fixture.claims(), 0);
    fixture
        .runtime
        .finish_agent_removal(&stopped, &plan)
        .await
        .unwrap();
    fixture.store.close().await;
}
