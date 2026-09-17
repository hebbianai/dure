use std::{collections::BTreeMap, sync::Arc, time::Duration};

use dure_app::{
    AgentProviderContractV1, AgentProviderImplementation, AgentProviderPreflightPlanV1,
    AgentProviderRegistry, ApiVersionRangeV1, CapabilityDeclarationV1, CapabilityIdV1,
    ExtensionContractV1, ExtensionDescriptorV1, ExtensionFailureCodeV1, ExtensionIdV1,
    ExtensionImplementation, ExtensionProbeContextV1, ExtensionProbeOutcomeV1, HostCompatibilityV1,
    PermissionIdV1, ProviderIdV1, RegistrationOutcomeV1, EXTENSION_DESCRIPTOR_SCHEMA_VERSION,
};

const BUNDLED_PROBE_TIMEOUT: Duration = Duration::from_millis(50);

struct BundledAgentProvider {
    descriptor: ExtensionDescriptorV1,
    preflight_plans: BTreeMap<ProviderIdV1, AgentProviderPreflightPlanV1>,
}

impl BundledAgentProvider {
    fn new(extension_id: &str, display_name: &str, provider: &str, executable: &str) -> Self {
        let provider_id = ProviderIdV1::new(provider).expect("static provider ID is valid");
        Self {
            descriptor: ExtensionDescriptorV1 {
                schema_version: EXTENSION_DESCRIPTOR_SCHEMA_VERSION,
                id: ExtensionIdV1::new(extension_id).expect("static extension ID is valid"),
                display_name: display_name.to_owned(),
                api: ApiVersionRangeV1::current_and_previous(),
                capabilities: CapabilityDeclarationV1 {
                    provided: vec![CapabilityIdV1::new("agent.preflight-plan")
                        .expect("static capability ID is valid")],
                    required: Vec::new(),
                    optional: Vec::new(),
                },
                permissions: Vec::<PermissionIdV1>::new(),
                extension: ExtensionContractV1::AgentProvider(AgentProviderContractV1 {
                    provider_ids: vec![provider_id.clone()],
                }),
            },
            preflight_plans: BTreeMap::from([(
                provider_id,
                AgentProviderPreflightPlanV1 {
                    executable: executable.to_owned(),
                },
            )]),
        }
    }
}

impl ExtensionImplementation for BundledAgentProvider {
    fn descriptor(&self) -> &ExtensionDescriptorV1 {
        &self.descriptor
    }

    fn probe(&self, _context: ExtensionProbeContextV1) -> ExtensionProbeOutcomeV1 {
        ExtensionProbeOutcomeV1::Available
    }
}

impl AgentProviderImplementation for BundledAgentProvider {
    fn preflight_plan(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Result<AgentProviderPreflightPlanV1, ExtensionFailureCodeV1> {
        self.preflight_plans
            .get(provider_id)
            .cloned()
            .ok_or_else(|| {
                ExtensionFailureCodeV1::new("preflight_plan_missing")
                    .expect("static failure code is valid")
            })
    }
}

pub struct DureAgentProviderState {
    registry: AgentProviderRegistry,
}

impl Default for DureAgentProviderState {
    fn default() -> Self {
        let mut registry = AgentProviderRegistry::default();
        for implementation in [
            BundledAgentProvider::new(
                "dure.bundled.codex",
                "Dure bundled Codex provider",
                "codex",
                "codex",
            ),
            BundledAgentProvider::new(
                "dure.bundled.claude",
                "Dure bundled Claude provider",
                "claude",
                "claude",
            ),
        ] {
            let extension_id = implementation.descriptor.id.clone();
            let outcome = registry.register(
                Arc::new(implementation),
                &HostCompatibilityV1::current(Vec::new(), Vec::new(), Vec::new()),
                BUNDLED_PROBE_TIMEOUT,
            );
            assert!(
                matches!(outcome, Ok(RegistrationOutcomeV1::Registered(_))),
                "bundled agent provider {extension_id:?} registration failed: {outcome:?}"
            );
        }
        Self { registry }
    }
}

impl DureAgentProviderState {
    pub fn preflight_command(
        &self,
        provider: &str,
        requested_command: &str,
    ) -> Result<String, String> {
        let provider_id = ProviderIdV1::new(provider)
            .map_err(|_| "provider_preflight_provider_id_invalid".to_owned())?;
        let Some(plan) = self
            .registry
            .preflight_plan(&provider_id)
            .map_err(|_| "provider_preflight_extension_failed".to_owned())?
        else {
            return Ok(requested_command.to_owned());
        };
        if requested_command != plan.executable {
            return Err("provider_preflight_command_mismatch".to_owned());
        }
        Ok(plan.executable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registered_preflight_uses_each_provider_canonical_executable() {
        let providers = DureAgentProviderState::default();
        assert_eq!(providers.registry.provider_count(), 2);
        for provider in ["codex", "claude"] {
            assert_eq!(
                providers.preflight_command(provider, provider),
                Ok(provider.to_owned())
            );
            assert_eq!(
                providers.preflight_command(provider, "unexpected-command"),
                Err("provider_preflight_command_mismatch".to_owned())
            );
        }
    }

    #[test]
    fn unregistered_provider_keeps_the_legacy_preflight_command() {
        let providers = DureAgentProviderState::default();
        assert_eq!(
            providers.preflight_command("gemini", "gemini"),
            Ok("gemini".to_owned())
        );
    }
}
