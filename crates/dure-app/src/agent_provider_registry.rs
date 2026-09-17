use std::{collections::BTreeMap, fmt, sync::Arc, time::Duration};

use crate::{
    AgentExecutionProfileV1, AgentInteractionProfileV1, AgentProviderConversationPlanV1,
    AgentSpawnEffortSelectionV1, AgentSpawnModelSelectionV1, ExtensionContractV1,
    ExtensionFailureCodeV1, ExtensionIdV1, ExtensionImplementation, ExtensionRegistry,
    HostCompatibilityV1, ProviderIdV1, ProviderPermissionModeV1, RegistrationOutcomeV1,
};

const MAX_PROVIDER_LAUNCH_PROMPT_BYTES_V1: usize = 16 * 1024;

pub fn agent_provider_launch_prompt_is_valid(prompt: &str) -> bool {
    !prompt.is_empty()
        && prompt.len() <= MAX_PROVIDER_LAUNCH_PROMPT_BYTES_V1
        && !prompt.contains('\0')
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentProviderPreflightPlanV1 {
    pub executable: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentProviderLaunchPlanV1 {
    pub executable: String,
    pub arguments: Vec<String>,
}

/// One provider selection for the initial process and later exact resume.
/// Resume uses the same executable, omits the initial prompt, and contains the
/// caller's opaque conversation placeholder. `None` leaves launch-only
/// providers usable without inventing resume support.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentProviderSessionLaunchPlanV1 {
    pub launch: AgentProviderLaunchPlanV1,
    pub resume_arguments: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum AgentProviderPromptTargetV1 {
    #[default]
    ProviderEvent,
    ProcessObserved,
    /// The provider CLI consumes the first prompt as part of its launch argv.
    /// The managed-create identity therefore owns both process creation and
    /// initial prompt at-most-once semantics.
    LaunchArgument,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgentProviderStructuredSessionPlanV1 {
    pub interaction_profile: AgentInteractionProfileV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgentProviderStructuredSessionRequestV1<'a> {
    pub provider_id: &'a ProviderIdV1,
    pub execution_profile: &'a AgentExecutionProfileV1,
    pub permission_mode: &'a ProviderPermissionModeV1,
    pub model: Option<&'a AgentSpawnModelSelectionV1>,
    pub effort: Option<&'a AgentSpawnEffortSelectionV1>,
    pub has_setup_command: bool,
    pub provider_conversation_ref: &'a AgentProviderConversationPlanV1,
}

/// The first production AgentProvider capability.
///
/// OS environment resolution and process execution remain host-adapter work.
/// This capability only selects the provider-owned executable to preflight.
pub trait AgentProviderImplementation: ExtensionImplementation {
    fn preflight_plan(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Result<AgentProviderPreflightPlanV1, ExtensionFailureCodeV1>;

    fn launch_plan(
        &self,
        provider_id: &ProviderIdV1,
        permission_mode: &ProviderPermissionModeV1,
        model: Option<&AgentSpawnModelSelectionV1>,
        effort: Option<&AgentSpawnEffortSelectionV1>,
        provider_conversation_ref: Option<&str>,
    ) -> Result<AgentProviderLaunchPlanV1, ExtensionFailureCodeV1> {
        let preflight = self.preflight_plan(provider_id)?;
        if permission_mode != &ProviderPermissionModeV1::Default {
            return Err(ExtensionFailureCodeV1::new("permission_mode_unsupported")
                .expect("static failure code is valid"));
        }
        if model.is_some() {
            // A provider that owns no argv mapping cannot honour a model
            // selection; dropping it would launch the wrong model silently.
            return Err(ExtensionFailureCodeV1::new("model_selection_unsupported")
                .expect("static failure code is valid"));
        }
        if effort.is_some() {
            // Same contract as model: silently dropping an effort selection
            // would launch with the wrong reasoning depth.
            return Err(ExtensionFailureCodeV1::new("effort_selection_unsupported")
                .expect("static failure code is valid"));
        }
        if provider_conversation_ref.is_some() {
            return Err(
                ExtensionFailureCodeV1::new("conversation_resume_unsupported")
                    .expect("static failure code is valid"),
            );
        }
        Ok(AgentProviderLaunchPlanV1 {
            executable: preflight.executable,
            arguments: Vec::new(),
        })
    }

    fn session_launch_plan(
        &self,
        provider_id: &ProviderIdV1,
        permission_mode: &ProviderPermissionModeV1,
        model: Option<&AgentSpawnModelSelectionV1>,
        effort: Option<&AgentSpawnEffortSelectionV1>,
        provider_conversation_ref: Option<&str>,
        _conversation_placeholder: &str,
    ) -> Result<AgentProviderSessionLaunchPlanV1, ExtensionFailureCodeV1> {
        Ok(AgentProviderSessionLaunchPlanV1 {
            launch: self.launch_plan(
                provider_id,
                permission_mode,
                model,
                effort,
                provider_conversation_ref,
            )?,
            resume_arguments: None,
        })
    }

    /// Resolve an optional structured launch before any process mutation.
    /// `None` is a supported capability miss and selects the native CLI path;
    /// an error means the adapter could not safely evaluate the tuple.
    fn structured_session_plan(
        &self,
        _request: AgentProviderStructuredSessionRequestV1<'_>,
    ) -> Result<Option<AgentProviderStructuredSessionPlanV1>, ExtensionFailureCodeV1> {
        Ok(None)
    }

    fn prompt_target(
        &self,
        _provider_id: &ProviderIdV1,
        _provider_conversation_ref: Option<&str>,
    ) -> AgentProviderPromptTargetV1 {
        AgentProviderPromptTargetV1::ProviderEvent
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentProviderRegistrationErrorV1 {
    WrongExtensionFamily {
        extension_id: ExtensionIdV1,
    },
    DuplicateProviderId {
        provider_id: ProviderIdV1,
        existing_extension_id: ExtensionIdV1,
    },
}

impl fmt::Display for AgentProviderRegistrationErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongExtensionFamily { extension_id } => write!(
                formatter,
                "extension {} is not an agent provider",
                extension_id.as_str()
            ),
            Self::DuplicateProviderId {
                provider_id,
                existing_extension_id,
            } => write!(
                formatter,
                "provider {} is already owned by extension {}",
                provider_id.as_str(),
                existing_extension_id.as_str()
            ),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentProviderOperationErrorV1 {
    pub extension_id: ExtensionIdV1,
    pub provider_id: ProviderIdV1,
    pub code: ExtensionFailureCodeV1,
}

impl fmt::Display for AgentProviderOperationErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "agent provider extension {} failed {} for {}",
            self.extension_id.as_str(),
            self.code.as_str(),
            self.provider_id.as_str()
        )
    }
}

struct RegisteredAgentProvider {
    extension_id: ExtensionIdV1,
    implementation: Arc<dyn AgentProviderImplementation>,
}

#[derive(Default)]
pub struct AgentProviderRegistry {
    extensions: ExtensionRegistry,
    providers: BTreeMap<ProviderIdV1, RegisteredAgentProvider>,
}

impl AgentProviderRegistry {
    pub fn extension_count(&self) -> usize {
        self.extensions.len()
    }

    pub fn provider_count(&self) -> usize {
        self.providers.len()
    }

    pub fn register<T>(
        &mut self,
        implementation: Arc<T>,
        host: &HostCompatibilityV1,
        probe_timeout: Duration,
    ) -> Result<RegistrationOutcomeV1, AgentProviderRegistrationErrorV1>
    where
        T: AgentProviderImplementation + 'static,
    {
        let descriptor = implementation.descriptor();
        if let Err(error) = descriptor.validate() {
            return Ok(RegistrationOutcomeV1::InvalidDescriptor {
                message: error.to_string(),
            });
        }
        let provider_ids = match &descriptor.extension {
            ExtensionContractV1::AgentProvider(contract) => contract.provider_ids.clone(),
            _ => {
                return Err(AgentProviderRegistrationErrorV1::WrongExtensionFamily {
                    extension_id: descriptor.id.clone(),
                });
            }
        };
        if self.extensions.get(&descriptor.id).is_some() {
            return Ok(RegistrationOutcomeV1::DuplicateId {
                id: descriptor.id.clone(),
            });
        }
        for provider_id in &provider_ids {
            if let Some(existing) = self.providers.get(provider_id) {
                return Err(AgentProviderRegistrationErrorV1::DuplicateProviderId {
                    provider_id: provider_id.clone(),
                    existing_extension_id: existing.extension_id.clone(),
                });
            }
        }

        let base_implementation: Arc<dyn ExtensionImplementation> = implementation.clone();
        let outcome = self
            .extensions
            .register(base_implementation, host, probe_timeout);
        if matches!(outcome, RegistrationOutcomeV1::Registered(_)) {
            let extension_id = implementation.descriptor().id.clone();
            let provider_implementation: Arc<dyn AgentProviderImplementation> = implementation;
            for provider_id in provider_ids {
                self.providers.insert(
                    provider_id,
                    RegisteredAgentProvider {
                        extension_id: extension_id.clone(),
                        implementation: Arc::clone(&provider_implementation),
                    },
                );
            }
        }
        Ok(outcome)
    }

    pub fn preflight_plan(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Result<Option<AgentProviderPreflightPlanV1>, AgentProviderOperationErrorV1> {
        let Some(provider) = self.providers.get(provider_id) else {
            return Ok(None);
        };
        provider
            .implementation
            .preflight_plan(provider_id)
            .map(Some)
            .map_err(|code| AgentProviderOperationErrorV1 {
                extension_id: provider.extension_id.clone(),
                provider_id: provider_id.clone(),
                code,
            })
    }

    pub fn launch_plan(
        &self,
        provider_id: &ProviderIdV1,
        permission_mode: &ProviderPermissionModeV1,
        model: Option<&AgentSpawnModelSelectionV1>,
        effort: Option<&AgentSpawnEffortSelectionV1>,
        provider_conversation_ref: Option<&str>,
    ) -> Result<Option<AgentProviderLaunchPlanV1>, AgentProviderOperationErrorV1> {
        let Some(provider) = self.providers.get(provider_id) else {
            return Ok(None);
        };
        provider
            .implementation
            .launch_plan(
                provider_id,
                permission_mode,
                model,
                effort,
                provider_conversation_ref,
            )
            .map(Some)
            .map_err(|code| AgentProviderOperationErrorV1 {
                extension_id: provider.extension_id.clone(),
                provider_id: provider_id.clone(),
                code,
            })
    }

    pub fn session_launch_plan(
        &self,
        provider_id: &ProviderIdV1,
        permission_mode: &ProviderPermissionModeV1,
        model: Option<&AgentSpawnModelSelectionV1>,
        effort: Option<&AgentSpawnEffortSelectionV1>,
        provider_conversation_ref: Option<&str>,
        conversation_placeholder: &str,
    ) -> Result<Option<AgentProviderSessionLaunchPlanV1>, AgentProviderOperationErrorV1> {
        let Some(provider) = self.providers.get(provider_id) else {
            return Ok(None);
        };
        provider
            .implementation
            .session_launch_plan(
                provider_id,
                permission_mode,
                model,
                effort,
                provider_conversation_ref,
                conversation_placeholder,
            )
            .map(Some)
            .map_err(|code| AgentProviderOperationErrorV1 {
                extension_id: provider.extension_id.clone(),
                provider_id: provider_id.clone(),
                code,
            })
    }

    pub fn structured_session_plan(
        &self,
        request: AgentProviderStructuredSessionRequestV1<'_>,
    ) -> Result<Option<AgentProviderStructuredSessionPlanV1>, AgentProviderOperationErrorV1> {
        let provider_id = request.provider_id;
        let Some(provider) = self.providers.get(provider_id) else {
            return Ok(None);
        };
        provider
            .implementation
            .structured_session_plan(request)
            .map_err(|code| AgentProviderOperationErrorV1 {
                extension_id: provider.extension_id.clone(),
                provider_id: provider_id.clone(),
                code,
            })
    }

    pub fn prompt_target(
        &self,
        provider_id: &ProviderIdV1,
        provider_conversation_ref: Option<&str>,
    ) -> Option<AgentProviderPromptTargetV1> {
        self.providers.get(provider_id).map(|provider| {
            provider
                .implementation
                .prompt_target(provider_id, provider_conversation_ref)
        })
    }
}
