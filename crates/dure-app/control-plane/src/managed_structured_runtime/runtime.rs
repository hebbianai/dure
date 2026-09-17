use super::*;

impl StructuredProviderRuntime for ManagedStructuredRuntimeManager<SqliteDomainStore> {
    fn new_session_availability(&self) -> Result<(), Error> {
        self.configuration
            .supports_new_sessions()
            .then_some(())
            .ok_or_else(|| self.configuration.unavailable_error())
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
}
