use super::*;

impl StructuredProviderRuntime for ManagedStructuredRuntimeManager<SqliteDomainStore> {
    fn new_session_availability(&self) -> Result<(), Error> {
        self.configuration
            .supports_new_sessions()
            .then_some(())
            .ok_or_else(|| self.configuration.unavailable_error())
    }

    fn workspace_move_availability(&self) -> Result<(), Error> {
        if self.configuration.provider.kind != ManagedProviderKind::Codex {
            return Err(invalid().without_target());
        }
        self.new_session_availability()
    }

    fn open_workspace_replacement<'a>(
        &'a self,
        request: StructuredProviderOpenRequestV1,
        workspace: dure_app::WorkspaceRecordV1,
        transition: &'a AgentRuntimeTransitionRecordV1,
        environment: ProviderStateEnvironment,
    ) -> StructuredProviderRuntimeFuture<'a, StructuredProviderWorkspaceOpenReceiptV1> {
        Box::pin(async move {
            self.workspace_move_availability()?;
            if transition
                .intent
                .workspace_move
                .as_ref()
                .map(|movement| &movement.target_workspace)
                != Some(&workspace)
            {
                return Err(conflict().without_target());
            }
            let binding = self
                .open_replacement_runtime_at(request, transition, environment, Some(&workspace))
                .await
                .map_err(|error| error.at_workspace(&workspace))?;
            Ok(StructuredProviderWorkspaceOpenReceiptV1 { binding, workspace })
        })
    }

    fn quiesce_workspace_target<'a>(
        &'a self,
        transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async move {
            let Some(AgentRuntimeReplacementAuthorityV1(
                AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
            )) = &transition.replacement_authority
            else {
                return Err(conflict());
            };
            let workspace = transition
                .replacement_workspace
                .as_ref()
                .ok_or_else(conflict)?;
            let current = self
                .conversation_service
                .binding(&binding.interaction_session_id)
                .await
                .map_err(|_| unavailable())?
                .ok_or_else(conflict)?;
            if current != *binding {
                return Err(conflict());
            }
            self.retire_failed_binding_at(binding, Some(workspace))
                .await
        })
    }

    fn open(
        &self,
        request: StructuredProviderOpenRequestV1,
    ) -> StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1> {
        Box::pin(self.open_runtime(request))
    }

    fn attach_existing<'a>(
        &'a self,
        selection: &'a dure_app::AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1> {
        Box::pin(self.attach_existing_runtime(selection, binding))
    }

    fn open_replacement<'a>(
        &'a self,
        request: StructuredProviderOpenRequestV1,
        transition: &'a AgentRuntimeTransitionRecordV1,
        provider_state_environment: ProviderStateEnvironment,
    ) -> StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1> {
        Box::pin(self.open_replacement_runtime(request, transition, provider_state_environment))
    }

    fn stop_replacement_source<'a>(
        &'a self,
        transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(self.stop_replacement(transition))
    }

    fn retire_replacement_source<'a>(
        &'a self,
        transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> StructuredProviderRuntimeFuture<'a, AgentRuntimeReplacementAuthorityV1> {
        Box::pin(self.retire_replacement_runtime(transition))
    }

    fn stop_current<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
    ) -> StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async move { self.stop_binding(binding, false).await.map(|_| ()) })
    }

    fn hosts_session<'a>(
        &'a self,
        session: &'a WorkflowSessionGenerationV1,
    ) -> StructuredProviderRuntimeFuture<'a, bool> {
        Box::pin(async move { Ok(self.hosts_session_generation(session).await) })
    }
}
