use super::*;
use dure_app::{AgentProviderSessionLaunchPlanV1, AgentProviderSessionLaunchRequestV1};
use dure_provider_adapter::{
    merge_native_provider_launch_settings, native_provider_launch_settings,
    native_provider_project_move, native_provider_session_launch_plan,
};
use dure_provider_profile::claude_settings;

fn conversation(reference: Option<&str>) -> NativeProviderConversationReference<'_> {
    reference.map_or(
        NativeProviderConversationReference::Fresh,
        NativeProviderConversationReference::Exact,
    )
}

fn missing_launch_plan() -> ExtensionFailureCodeV1 {
    ExtensionFailureCodeV1::new("launch_plan_missing").expect("static failure code is valid")
}

/// A project move adapts only the provider's own argv. Integration and launch
/// channel wrappers are applied afterwards; their arguments are not the
/// provider's and must not be reinterpreted as provider flags.
fn native_session_plan(
    request: AgentProviderSessionLaunchRequestV1<'_>,
    project_directory: Option<&Path>,
) -> Result<AgentProviderSessionLaunchPlanV1, ExtensionFailureCodeV1> {
    let mut plan = native_provider_session_launch_plan(
        request.provider_id,
        request.permission_mode,
        request.model,
        request.effort,
        conversation(request.provider_conversation_ref),
        request.conversation_placeholder,
    )?
    .ok_or_else(missing_launch_plan)?;
    if let Some(directory) = project_directory {
        native_provider_project_move(request.provider_id, &mut plan, directory)?;
    }
    Ok(plan)
}

/// The runtime integration a launch carries. A launch selection may contribute
/// provider settings (Claude's `ultracode`); they join the settings document
/// the integration publishes, because Claude reads one `--settings` per launch
/// and a second one would drop the managed hooks.
fn launch_integration(
    source: &dyn ProviderRuntimeIntegrationSource,
    provider_id: &ProviderIdV1,
    effort: Option<&AgentSpawnEffortSelectionV1>,
) -> Result<ProviderRuntimeIntegrationV1, ExtensionFailureCodeV1> {
    let integration = source.integration(provider_id)?;
    let settings = native_provider_launch_settings(provider_id, effort);
    if settings.is_empty() {
        return Ok(integration);
    }
    let ProviderRuntimeIntegrationV1::SettingsFile { path } = integration else {
        return Err(
            ExtensionFailureCodeV1::new("provider_launch_settings_unsupported")
                .expect("static failure code is valid"),
        );
    };
    claude_settings::read(&path)
        .and_then(|mut document| {
            merge_native_provider_launch_settings(&mut document, settings);
            claude_settings::publish_beside(&path, &document)
        })
        .map(|path| ProviderRuntimeIntegrationV1::SettingsFile { path })
        .map_err(|_| {
            ExtensionFailureCodeV1::new("provider_launch_settings_unavailable")
                .expect("static failure code is valid")
        })
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

// Routing belongs to the Dure launch command, not the ambient environment of
// a reused Hmux broker. It is retained in the resume recipe as well.
fn bind_launch_channel(
    source: &dyn ProviderRuntimeIntegrationSource,
    plan: &mut AgentProviderLaunchPlanV1,
) -> Result<(), ExtensionFailureCodeV1> {
    // The Windows adapter retains its native launch plan. This Unix command
    // wrapper must never introduce /bin/sh into a Windows provider launch.
    if !cfg!(unix) {
        return Ok(());
    }
    let Some(channel) = source.app_channel() else {
        return Ok(());
    };
    // Resolve the actual provider before adding a shell wrapper; validating
    // only /bin/sh would defer missing-provider errors until after admission.
    plan.executable = crate::resolve_provider_executable(&plan.executable)
        .map_err(|_| ExtensionFailureCodeV1::new("provider_executable_unavailable").unwrap())?
        .to_str()
        .ok_or_else(missing_launch_plan)?
        .to_owned();
    let directory = std::env::current_exe()
        .ok()
        .and_then(|executable| agent_command_directory(&executable));
    wrap_launch_channel(plan, channel, directory.as_deref());
    Ok(())
}

/// The installed CLI version's directory of user-facing commands, beside the
/// `bin` directory that holds this executable. That `bin` also holds the
/// version's private Node runtime and internal executables; on PATH they would
/// shadow the user's toolchain, and package managers that derive a global
/// prefix from `node` would then write into the immutable version.
const AGENT_COMMAND_DIRECTORY: &str = "commands";

pub(super) fn agent_command_directory(executable: &Path) -> Option<PathBuf> {
    let directory = executable.parent()?.parent()?.join(AGENT_COMMAND_DIRECTORY);
    directory.join("dure").is_file().then_some(directory)
}

pub(super) fn wrap_launch_channel(
    plan: &mut AgentProviderLaunchPlanV1,
    channel: &str,
    directory: Option<&Path>,
) {
    let mut command =
        dure_provider_adapter::managed_environment::unix_managed_launch_prefix(channel, directory);
    command.push(std::mem::take(&mut plan.executable));
    command.append(&mut plan.arguments);
    plan.executable = command.remove(0);
    plan.arguments = command;
}

pub(super) fn bind_session_channel(
    source: &dyn ProviderRuntimeIntegrationSource,
    plan: &mut AgentProviderSessionLaunchPlanV1,
) -> Result<(), ExtensionFailureCodeV1> {
    let executable = plan.launch.executable.clone();
    if let Some(arguments) = &mut plan.resume_arguments {
        let mut resume = AgentProviderLaunchPlanV1 {
            executable,
            arguments: std::mem::take(arguments),
        };
        bind_launch_channel(source, &mut resume)?;
        *arguments = resume.arguments;
    }
    bind_launch_channel(source, &mut plan.launch)
}

impl BundledAgentProvider {
    fn session_plan(
        &self,
        request: AgentProviderSessionLaunchRequestV1<'_>,
        project_directory: Option<&Path>,
    ) -> Result<AgentProviderSessionLaunchPlanV1, ExtensionFailureCodeV1> {
        let preflight = self.preflight_plan(request.provider_id)?;
        // Resolve the integration once so launch and resume retain one selection.
        let integration = launch_integration(
            self.integrations.as_ref(),
            request.provider_id,
            request.effort,
        )?;
        let mut plan = native_session_plan(request, project_directory)?;
        plan.launch.executable = preflight.executable;
        integrate_session_launch(request.provider_id, &integration, &mut plan)?;
        bind_session_channel(self.integrations.as_ref(), &mut plan)?;
        Ok(plan)
    }
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
            &launch_integration(self.integrations.as_ref(), provider_id, effort)?,
            &mut native,
        )?;
        bind_launch_channel(self.integrations.as_ref(), &mut native)?;
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
        self.session_plan(
            AgentProviderSessionLaunchRequestV1 {
                provider_id,
                permission_mode,
                model,
                effort,
                provider_conversation_ref,
                conversation_placeholder,
            },
            None,
        )
    }

    fn project_move_session_launch_plan(
        &self,
        request: AgentProviderSessionLaunchRequestV1<'_>,
        directory: &Path,
    ) -> Result<AgentProviderSessionLaunchPlanV1, ExtensionFailureCodeV1> {
        self.session_plan(request, Some(directory))
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

impl NativeAgentProviders {
    /// The channel integration a native launch carries. Pi and Gemini need
    /// theirs; OpenClaude's, OpenCode's and Kilo Code's only report activity,
    /// so their launches proceed without one that is missing or no longer
    /// matches its publication.
    fn native_integration(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Result<Option<ProviderRuntimeIntegrationV1>, ExtensionFailureCodeV1> {
        match provider_id.as_str() {
            "pi" => self.integrations.integration(provider_id).map(Some),
            "gemini" if cfg!(unix) => self.integrations.integration(provider_id).map(Some),
            "openclaude" | "opencode" | "kilocode" if cfg!(unix) => {
                Ok(self.integrations.integration(provider_id).ok())
            }
            _ => Ok(None),
        }
    }

    fn session_plan(
        &self,
        request: AgentProviderSessionLaunchRequestV1<'_>,
        project_directory: Option<&Path>,
    ) -> Result<AgentProviderSessionLaunchPlanV1, ExtensionFailureCodeV1> {
        let provider_id = request.provider_id;
        let mut plan = native_session_plan(request, project_directory)?;
        if let Some(integration) = self.native_integration(provider_id)? {
            integrate_session_launch(provider_id, &integration, &mut plan)?;
        }
        bind_session_channel(self.integrations.as_ref(), &mut plan)?;
        Ok(plan)
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
        if let Some(integration) = self.native_integration(provider_id)? {
            apply_provider_runtime_integration(provider_id, &integration, &mut plan)?;
        }
        bind_launch_channel(self.integrations.as_ref(), &mut plan)?;
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
        self.session_plan(
            AgentProviderSessionLaunchRequestV1 {
                provider_id,
                permission_mode,
                model,
                effort,
                provider_conversation_ref,
                conversation_placeholder,
            },
            None,
        )
    }

    fn project_move_session_launch_plan(
        &self,
        request: AgentProviderSessionLaunchRequestV1<'_>,
        directory: &Path,
    ) -> Result<AgentProviderSessionLaunchPlanV1, ExtensionFailureCodeV1> {
        self.session_plan(request, Some(directory))
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
    // Plan mode is admitted only where the reviewed adapter declares it, so
    // a structured driver without a plan posture never receives one.
    if (available && !request.has_setup_command && request.provider_id.as_str() == "pi")
        || request.permission_mode == &dure_app::ProviderPermissionModeV1::Plan
    {
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
