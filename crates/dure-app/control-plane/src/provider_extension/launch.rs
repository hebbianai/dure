use super::*;
use dure_app::AgentProviderSessionLaunchPlanV1;
use dure_provider_adapter::native_provider_session_launch_plan;

fn conversation(reference: Option<&str>) -> NativeProviderConversationReference<'_> {
    reference.map_or(
        NativeProviderConversationReference::Fresh,
        NativeProviderConversationReference::Exact,
    )
}

fn missing_launch_plan() -> ExtensionFailureCodeV1 {
    ExtensionFailureCodeV1::new("launch_plan_missing").expect("static failure code is valid")
}

fn integrate_session_launch(
    provider: &ProviderIdV1,
    integration: &ProviderRuntimeIntegrationV1,
    plan: &mut AgentProviderSessionLaunchPlanV1,
) -> Result<(), ExtensionFailureCodeV1> {
    let executable = plan.launch.executable.clone();
    apply_provider_runtime_integration(provider, integration, &mut plan.launch)?;
    if let Some(resume) = &mut plan.resume_arguments {
        let mut native = AgentProviderLaunchPlanV1 {
            executable,
            arguments: std::mem::take(resume),
        };
        apply_provider_runtime_integration(provider, integration, &mut native)?;
        *resume = native.arguments;
    }
    Ok(())
}

impl AgentProviderImplementation for BundledAgentProvider {
    fn preflight_plan(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Result<AgentProviderPreflightPlanV1, ExtensionFailureCodeV1> {
        self.plans.get(provider_id).cloned().ok_or_else(|| {
            ExtensionFailureCodeV1::new("preflight_plan_missing")
                .expect("static failure code is valid")
        })
    }

    fn launch_plan(
        &self,
        provider_id: &ProviderIdV1,
        permission_mode: &ProviderPermissionModeV1,
        model: Option<&AgentSpawnModelSelectionV1>,
        effort: Option<&AgentSpawnEffortSelectionV1>,
        provider_conversation_ref: Option<&str>,
    ) -> Result<AgentProviderLaunchPlanV1, ExtensionFailureCodeV1> {
        let preflight = self.preflight_plan(provider_id)?;
        let mut native = native_provider_launch_plan(
            provider_id,
            permission_mode,
            model,
            effort,
            conversation(provider_conversation_ref),
        )?
        .ok_or_else(missing_launch_plan)?;
        native.executable = preflight.executable;
        apply_provider_runtime_integration(
            provider_id,
            &self.integrations.integration(provider_id)?,
            &mut native,
        )?;
        Ok(native)
    }

    fn session_launch_plan(
        &self,
        provider_id: &ProviderIdV1,
        permission_mode: &ProviderPermissionModeV1,
        model: Option<&AgentSpawnModelSelectionV1>,
        effort: Option<&AgentSpawnEffortSelectionV1>,
        provider_conversation_ref: Option<&str>,
        conversation_placeholder: &str,
    ) -> Result<AgentProviderSessionLaunchPlanV1, ExtensionFailureCodeV1> {
        let preflight = self.preflight_plan(provider_id)?;
        // Resolve the integration once so launch and resume retain one selection.
        let integration = self.integrations.integration(provider_id)?;
        let mut plan = native_provider_session_launch_plan(
            provider_id,
            permission_mode,
            model,
            effort,
            conversation(provider_conversation_ref),
            conversation_placeholder,
        )?
        .ok_or_else(missing_launch_plan)?;
        plan.launch.executable = preflight.executable;
        integrate_session_launch(provider_id, &integration, &mut plan)?;
        Ok(plan)
    }

    fn structured_session_plan(
        &self,
        request: AgentProviderStructuredSessionRequestV1<'_>,
    ) -> Result<Option<AgentProviderStructuredSessionPlanV1>, ExtensionFailureCodeV1> {
        if !self.plans.contains_key(request.provider_id) {
            return Err(
                ExtensionFailureCodeV1::new("structured_session_plan_missing")
                    .expect("static failure code is valid"),
            );
        }
        structured_session_plan(self.structured_session_available, request)
    }

    fn prompt_target(
        &self,
        provider_id: &ProviderIdV1,
        provider_conversation_ref: Option<&str>,
    ) -> AgentProviderPromptTargetV1 {
        native_provider_prompt_target(provider_id, provider_conversation_ref).unwrap_or_default()
    }
}

impl AgentProviderImplementation for NativeAgentProviders {
    fn preflight_plan(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Result<AgentProviderPreflightPlanV1, ExtensionFailureCodeV1> {
        native_provider_preflight_plan(provider_id).ok_or_else(|| {
            ExtensionFailureCodeV1::new("preflight_plan_missing")
                .expect("static failure code is valid")
        })
    }

    fn launch_plan(
        &self,
        provider_id: &ProviderIdV1,
        permission_mode: &ProviderPermissionModeV1,
        model: Option<&AgentSpawnModelSelectionV1>,
        effort: Option<&AgentSpawnEffortSelectionV1>,
        provider_conversation_ref: Option<&str>,
    ) -> Result<AgentProviderLaunchPlanV1, ExtensionFailureCodeV1> {
        let mut plan = native_provider_launch_plan(
            provider_id,
            permission_mode,
            model,
            effort,
            conversation(provider_conversation_ref),
        )?
        .ok_or_else(missing_launch_plan)?;
        if provider_id.as_str() == "pi" || cfg!(unix) && provider_id.as_str() == "gemini" {
            apply_provider_runtime_integration(
                provider_id,
                &self.integrations.integration(provider_id)?,
                &mut plan,
            )?;
        }
        Ok(plan)
    }

    fn session_launch_plan(
        &self,
        provider_id: &ProviderIdV1,
        permission_mode: &ProviderPermissionModeV1,
        model: Option<&AgentSpawnModelSelectionV1>,
        effort: Option<&AgentSpawnEffortSelectionV1>,
        provider_conversation_ref: Option<&str>,
        conversation_placeholder: &str,
    ) -> Result<AgentProviderSessionLaunchPlanV1, ExtensionFailureCodeV1> {
        let mut plan = native_provider_session_launch_plan(
            provider_id,
            permission_mode,
            model,
            effort,
            conversation(provider_conversation_ref),
            conversation_placeholder,
        )?
        .ok_or_else(missing_launch_plan)?;
        if provider_id.as_str() == "pi" || cfg!(unix) && provider_id.as_str() == "gemini" {
            integrate_session_launch(
                provider_id,
                &self.integrations.integration(provider_id)?,
                &mut plan,
            )?;
        }
        Ok(plan)
    }

    fn structured_session_plan(
        &self,
        request: AgentProviderStructuredSessionRequestV1<'_>,
    ) -> Result<Option<AgentProviderStructuredSessionPlanV1>, ExtensionFailureCodeV1> {
        structured_session_plan(
            self.structured_providers.contains(request.provider_id),
            request,
        )
    }

    fn prompt_target(
        &self,
        provider_id: &ProviderIdV1,
        provider_conversation_ref: Option<&str>,
    ) -> AgentProviderPromptTargetV1 {
        native_provider_prompt_target(provider_id, provider_conversation_ref).unwrap_or_default()
    }
}

fn structured_session_plan(
    available: bool,
    request: AgentProviderStructuredSessionRequestV1<'_>,
) -> Result<Option<AgentProviderStructuredSessionPlanV1>, ExtensionFailureCodeV1> {
    if available && !request.has_setup_command && request.provider_id.as_str() == "pi" {
        dure_provider_adapter::native_provider_permission_arguments(
            request.provider_id,
            request.permission_mode,
        )?;
    }
    request.execution_profile.validate().map_err(|_| {
        ExtensionFailureCodeV1::new("structured_execution_profile_invalid")
            .expect("static failure code is valid")
    })?;
    Ok(
        (available && !request.has_setup_command).then_some(AgentProviderStructuredSessionPlanV1 {
            interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        }),
    )
}
