use super::*;

pub(super) async fn open_or_attach(
    manager: &ManagedStructuredRuntimeManager<SqliteDomainStore>,
    agent_id: AgentIdV1,
    execution_profile: &AgentExecutionProfileV1,
    recovering: bool,
) -> Result<AgentInteractionBindingV1, Error> {
    let store = &manager.store;
    let service = &manager.conversation_service;
    if recovering {
        let selection = store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .expect("the initial launch must commit its selection before backend replacement");
        let binding = service.binding_for_agent(&agent_id).await.unwrap().unwrap();
        assert_eq!(&selection.execution_profile, execution_profile);
        // Match agent_conversation_recover and agent_runtime_recovery: an
        // existing runtime is attached through its durable selected authority.
        return manager.attach_existing_runtime(&selection, &binding).await;
    }

    let binding = manager
        .open_runtime(StructuredProviderOpenRequestV1 {
            agent_id,
            execution_profile: execution_profile.clone(),
            provider_conversation_ref: None,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
        })
        .await?;
    store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION_V1,
            agent_id: binding.agent_id.clone(),
            provider_id: binding.provider_id.clone(),
            interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            execution_profile: binding.execution_profile.clone(),
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: binding.updated_at_ms,
        })
        .await
        .unwrap();
    Ok(binding)
}
