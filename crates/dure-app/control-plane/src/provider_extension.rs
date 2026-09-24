use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use dure_app::{
    AgentInteractionProfileV1, AgentProviderContractV1, AgentProviderImplementation,
    AgentProviderLaunchPlanV1, AgentProviderPreflightPlanV1, AgentProviderPromptTargetV1,
    AgentProviderRegistry, AgentProviderStructuredSessionPlanV1,
    AgentProviderStructuredSessionRequestV1, AgentSpawnEffortSelectionV1,
    AgentSpawnModelSelectionV1, ApiVersionRangeV1, CapabilityDeclarationV1, CapabilityIdV1,
    EXTENSION_DESCRIPTOR_SCHEMA_VERSION, ExtensionContractV1, ExtensionDescriptorV1,
    ExtensionFailureCodeV1, ExtensionIdV1, ExtensionImplementation, ExtensionProbeContextV1,
    ExtensionProbeOutcomeV1, HostCompatibilityV1, PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1,
    ProviderIdV1, ProviderPermissionModeV1, ProviderRuntimeIntegrationV1,
    ProviderRuntimeIntegrationsV1, RegistrationOutcomeV1,
};
use dure_provider_adapter::{
    NativeProviderConversationReference, native_provider_launch_plan,
    native_provider_preflight_plan, native_provider_prompt_target,
    apply_provider_runtime_integration, reviewed_native_provider_ids,
};

const BUNDLED_PROBE_TIMEOUT: Duration = Duration::from_millis(50);
const PROVIDER_INTEGRATION_MAX_BYTES: u64 = 64 * 1024;
const APP_CHANNEL_ENV: &str = "DURE_APP_CHANNEL";
const STABLE_CHANNEL: &str = "stable";

mod launch;
#[cfg(test)]
mod launch_tests;

trait ProviderRuntimeIntegrationSource: Send + Sync {
    fn app_channel(&self) -> Option<&str> {
        None
    }

    fn integration(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Result<ProviderRuntimeIntegrationV1, ExtensionFailureCodeV1>;
}

struct ChannelProviderRuntimeIntegrationSource {
    channel: Option<String>,
    control_dir: Option<PathBuf>,
}

impl ChannelProviderRuntimeIntegrationSource {
    fn new(app_root: &Path) -> Self {
        let configured = std::env::var_os(APP_CHANNEL_ENV);
        let channel = match configured {
            None => Some(STABLE_CHANNEL.into()),
            Some(value) => value
                .to_str()
                .filter(|value| valid_channel(value))
                .map(str::to_owned),
        };
        let control_dir = channel.as_ref().map(|channel| {
            if channel == STABLE_CHANNEL {
                app_root.to_path_buf()
            } else {
                app_root.join("channels").join(channel)
            }
        });
        Self {
            channel,
            control_dir,
        }
    }

    #[cfg(test)]
    fn at(channel: &str, control_dir: PathBuf) -> Self {
        Self {
            channel: Some(channel.into()),
            control_dir: Some(control_dir),
        }
    }

    fn load(&self) -> Result<ProviderRuntimeIntegrationsV1, ExtensionFailureCodeV1> {
        let channel = self.channel.as_ref().ok_or_else(integration_unavailable)?;
        let control_dir = self
            .control_dir
            .as_ref()
            .ok_or_else(integration_unavailable)?;
        require_owner_directory(control_dir)?;
        let path = control_dir.join(PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1);
        let metadata = require_owner_file(&path, false)?;
        if metadata.len() > PROVIDER_INTEGRATION_MAX_BYTES {
            return Err(integration_unavailable());
        }
        let source = fs::read(&path).map_err(|_| integration_unavailable())?;
        let document: ProviderRuntimeIntegrationsV1 =
            serde_json::from_slice(&source).map_err(|_| integration_unavailable())?;
        document.validate().map_err(|_| integration_unavailable())?;
        if document.channel != *channel {
            return Err(integration_unavailable());
        }
        Ok(document)
    }

    fn validate_references(
        &self,
        integration: &ProviderRuntimeIntegrationV1,
    ) -> Result<(), ExtensionFailureCodeV1> {
        let control_dir = self
            .control_dir
            .as_ref()
            .ok_or_else(integration_unavailable)?;
        let canonical_control =
            fs::canonicalize(control_dir).map_err(|_| integration_unavailable())?;
        let paths: Vec<(&str, bool)> = match integration {
            ProviderRuntimeIntegrationV1::NotificationCommand { command } => {
                command.iter().map(|path| (path.as_str(), true)).collect()
            }
            ProviderRuntimeIntegrationV1::SettingsFile { path } => {
                vec![(path.as_str(), false)]
            }
            ProviderRuntimeIntegrationV1::CommandWrapper { path } => {
                vec![(path.as_str(), true)]
            }
        };
        for (path, executable) in paths {
            let path = Path::new(path);
            require_owner_file(path, executable)?;
            let canonical = fs::canonicalize(path).map_err(|_| integration_unavailable())?;
            if !canonical.starts_with(&canonical_control) {
                return Err(integration_unavailable());
            }
        }
        Ok(())
    }
}

impl ProviderRuntimeIntegrationSource for ChannelProviderRuntimeIntegrationSource {
    fn app_channel(&self) -> Option<&str> {
        self.channel.as_deref()
    }

    fn integration(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Result<ProviderRuntimeIntegrationV1, ExtensionFailureCodeV1> {
        let integration = self
            .load()?
            .integration(provider_id)
            .cloned()
            .ok_or_else(integration_unavailable)?;
        self.validate_references(&integration)?;
        Ok(integration)
    }
}

fn valid_channel(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn require_owner_directory(path: &Path) -> Result<(), ExtensionFailureCodeV1> {
    let metadata = fs::symlink_metadata(path).map_err(|_| integration_unavailable())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(integration_unavailable());
    }
    Ok(())
}

fn require_owner_file(
    path: &Path,
    executable: bool,
) -> Result<fs::Metadata, ExtensionFailureCodeV1> {
    let metadata = fs::symlink_metadata(path).map_err(|_| integration_unavailable())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
        || (executable && metadata.permissions().mode() & 0o100 == 0)
    {
        return Err(integration_unavailable());
    }
    Ok(metadata)
}

fn integration_unavailable() -> ExtensionFailureCodeV1 {
    ExtensionFailureCodeV1::new("provider_runtime_integration_unavailable")
        .expect("static failure code is valid")
}

struct BundledAgentProvider {
    descriptor: ExtensionDescriptorV1,
    plans: BTreeMap<ProviderIdV1, AgentProviderPreflightPlanV1>,
    integrations: Arc<dyn ProviderRuntimeIntegrationSource>,
    structured_session_available: bool,
}

impl BundledAgentProvider {
    fn new(
        extension_id: &str,
        display_name: &str,
        provider_id: &str,
        executable: &str,
        integrations: Arc<dyn ProviderRuntimeIntegrationSource>,
        structured_session_available: bool,
    ) -> Self {
        let provider_id = ProviderIdV1::new(provider_id).expect("static provider ID is valid");
        let mut provided_capabilities = vec![
            CapabilityIdV1::new("agent.preflight-plan").expect("static capability ID is valid"),
            CapabilityIdV1::new("agent.launch-plan").expect("static capability ID is valid"),
            CapabilityIdV1::new("agent.prompt-delivery-plan")
                .expect("static capability ID is valid"),
        ];
        if structured_session_available {
            provided_capabilities.push(
                CapabilityIdV1::new("agent.structured-session-plan")
                    .expect("static capability ID is valid"),
            );
        }
        Self {
            descriptor: ExtensionDescriptorV1 {
                schema_version: EXTENSION_DESCRIPTOR_SCHEMA_VERSION,
                id: ExtensionIdV1::new(extension_id).expect("static extension ID is valid"),
                display_name: display_name.into(),
                api: ApiVersionRangeV1::current_and_previous(),
                capabilities: CapabilityDeclarationV1 {
                    provided: provided_capabilities,
                    required: Vec::new(),
                    optional: Vec::new(),
                },
                permissions: Vec::new(),
                extension: ExtensionContractV1::AgentProvider(AgentProviderContractV1 {
                    provider_ids: vec![provider_id.clone()],
                }),
            },
            plans: BTreeMap::from([(
                provider_id,
                AgentProviderPreflightPlanV1 {
                    executable: executable.into(),
                },
            )]),
            integrations,
            structured_session_available,
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

struct NativeAgentProviders {
    structured_providers: BTreeSet<ProviderIdV1>,
    descriptor: ExtensionDescriptorV1,
    integrations: Arc<dyn ProviderRuntimeIntegrationSource>,
}

impl NativeAgentProviders {
    fn new(
        structured_providers: BTreeSet<ProviderIdV1>,
        integrations: Arc<dyn ProviderRuntimeIntegrationSource>,
    ) -> Self {
        let provider_ids = reviewed_native_provider_ids()
            .filter(|provider_id| !matches!(*provider_id, "codex" | "claude"))
            .map(|provider_id| ProviderIdV1::new(provider_id).expect("static provider ID is valid"))
            .collect();
        Self {
            structured_providers,
            integrations,
            descriptor: ExtensionDescriptorV1 {
                schema_version: EXTENSION_DESCRIPTOR_SCHEMA_VERSION,
                id: ExtensionIdV1::new("dure.bundled.native-providers")
                    .expect("static extension ID is valid"),
                display_name: "Dure bundled native providers".into(),
                api: ApiVersionRangeV1::current_and_previous(),
                capabilities: CapabilityDeclarationV1 {
                    provided: vec![
                        CapabilityIdV1::new("agent.preflight-plan")
                            .expect("static capability ID is valid"),
                        CapabilityIdV1::new("agent.launch-plan")
                            .expect("static capability ID is valid"),
                        CapabilityIdV1::new("agent.prompt-delivery-plan")
                            .expect("static capability ID is valid"),
                        CapabilityIdV1::new("agent.structured-session-plan")
                            .expect("static capability ID is valid"),
                    ],
                    required: Vec::new(),
                    optional: Vec::new(),
                },
                permissions: Vec::new(),
                extension: ExtensionContractV1::AgentProvider(AgentProviderContractV1 {
                    provider_ids,
                }),
            },
        }
    }
}

impl ExtensionImplementation for NativeAgentProviders {
    fn descriptor(&self) -> &ExtensionDescriptorV1 {
        &self.descriptor
    }

    fn probe(&self, _context: ExtensionProbeContextV1) -> ExtensionProbeOutcomeV1 {
        ExtensionProbeOutcomeV1::Available
    }
}

fn register_provider<T>(registry: &mut AgentProviderRegistry, implementation: T)
where
    T: AgentProviderImplementation + 'static,
{
    let extension_id = implementation.descriptor().id.clone();
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

fn provider_registry(
    integrations: Arc<dyn ProviderRuntimeIntegrationSource>,
    structured_providers: BTreeSet<ProviderIdV1>,
) -> AgentProviderRegistry {
    let mut registry = AgentProviderRegistry::default();
    register_provider(
        &mut registry,
        BundledAgentProvider::new(
            "dure.bundled.codex",
            "Dure bundled Codex provider",
            "codex",
            "codex",
            Arc::clone(&integrations),
            structured_providers.contains(&ProviderIdV1::new("codex").unwrap()),
        ),
    );
    register_provider(
        &mut registry,
        BundledAgentProvider::new(
            "dure.bundled.claude",
            "Dure bundled Claude provider",
            "claude",
            "claude",
            Arc::clone(&integrations),
            structured_providers.contains(&ProviderIdV1::new("claude").unwrap()),
        ),
    );
    register_provider(
        &mut registry,
        NativeAgentProviders::new(structured_providers, integrations),
    );
    registry
}

pub(crate) fn local_agent_provider_registry(
    app_root: &Path,
    structured_providers: BTreeSet<ProviderIdV1>,
) -> AgentProviderRegistry {
    provider_registry(
        Arc::new(ChannelProviderRuntimeIntegrationSource::new(app_root)),
        structured_providers,
    )
}

#[cfg(test)]
#[derive(Clone)]
struct StaticProviderRuntimeIntegrationSource {
    integrations: BTreeMap<ProviderIdV1, ProviderRuntimeIntegrationV1>,
}

#[cfg(test)]
impl ProviderRuntimeIntegrationSource for StaticProviderRuntimeIntegrationSource {
    fn integration(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Result<ProviderRuntimeIntegrationV1, ExtensionFailureCodeV1> {
        self.integrations
            .get(provider_id)
            .cloned()
            .ok_or_else(integration_unavailable)
    }
}

#[cfg(test)]
fn test_integration_source() -> Arc<dyn ProviderRuntimeIntegrationSource> {
    Arc::new(StaticProviderRuntimeIntegrationSource {
        integrations: BTreeMap::from([
            (
                ProviderIdV1::new("codex").unwrap(),
                ProviderRuntimeIntegrationV1::NotificationCommand {
                    command: vec!["/fixture/managed-codex-notify.sh".into()],
                },
            ),
            (
                ProviderIdV1::new("claude").unwrap(),
                ProviderRuntimeIntegrationV1::SettingsFile {
                    path: "/fixture/managed-claude-settings.json".into(),
                },
            ),
            (
                ProviderIdV1::new("pi").unwrap(),
                ProviderRuntimeIntegrationV1::CommandWrapper {
                    path: "/fixture/managed-pi-launch.sh".into(),
                },
            ),
            (
                ProviderIdV1::new("gemini").unwrap(),
                ProviderRuntimeIntegrationV1::CommandWrapper {
                    path: "/fixture/managed-gemini-launch.sh".into(),
                },
            ),
        ]),
    })
}

#[cfg(test)]
pub(crate) fn test_local_agent_provider_registry() -> AgentProviderRegistry {
    provider_registry(
        test_integration_source(),
        BTreeSet::from([ProviderIdV1::new("claude").unwrap()]),
    )
}

#[cfg(test)]
pub(crate) fn test_codex_provider_arguments(
    permission_mode: ProviderPermissionModeV1,
) -> Vec<String> {
    test_local_agent_provider_registry()
        .launch_plan(
            &ProviderIdV1::new("codex").unwrap(),
            &permission_mode,
            None,
            None,
            None,
        )
        .unwrap()
        .unwrap()
        .arguments
}

#[cfg(test)]
pub(crate) fn test_codex_structured_agent_provider_registry() -> AgentProviderRegistry {
    provider_registry(
        test_integration_source(),
        BTreeSet::from([ProviderIdV1::new("codex").unwrap()]),
    )
}

#[cfg(test)]
pub(crate) fn test_agent_provider_registry(executable: &str) -> AgentProviderRegistry {
    test_bundled_provider_registry("codex", executable, false)
}

#[cfg(test)]
pub(crate) fn test_structured_agent_provider_registry(provider: &str) -> AgentProviderRegistry {
    test_bundled_provider_registry(provider, provider, true)
}

#[cfg(test)]
fn test_bundled_provider_registry(
    provider: &str,
    executable: &str,
    structured: bool,
) -> AgentProviderRegistry {
    let mut registry = AgentProviderRegistry::default();
    register_provider(
        &mut registry,
        BundledAgentProvider::new(
            "dure.test.codex",
            "Dure test Codex provider",
            provider,
            executable,
            test_integration_source(),
            structured,
        ),
    );
    registry
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_app::AgentExecutionProfileV1;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    fn write_fixture_file(path: &Path, contents: &[u8], mode: u32) {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(path)
            .unwrap();
        std::io::Write::write_all(&mut file, contents).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    fn write_fixture_document(
        path: &Path,
        channel: &str,
        codex_command: Vec<String>,
        claude_settings: String,
    ) {
        let document = ProviderRuntimeIntegrationsV1 {
            schema_version: dure_app::PROVIDER_RUNTIME_INTEGRATIONS_SCHEMA_VERSION_V1,
            channel: channel.into(),
            integrations: BTreeMap::from([
                (
                    ProviderIdV1::new("codex").unwrap(),
                    ProviderRuntimeIntegrationV1::NotificationCommand {
                        command: codex_command,
                    },
                ),
                (
                    ProviderIdV1::new("claude").unwrap(),
                    ProviderRuntimeIntegrationV1::SettingsFile {
                        path: claude_settings,
                    },
                ),
            ]),
        };
        write_fixture_file(path, &serde_json::to_vec(&document).unwrap(), 0o600);
    }

    #[test]
    fn every_reviewed_provider_resolves_through_one_registry() {
        let registry = test_local_agent_provider_registry();
        assert_eq!(registry.provider_count(), 24);
        for (provider, executable) in [
            ("claude", "claude"),
            ("codex", "codex"),
            ("kimi", "kimi"),
            ("gemini", "gemini"),
            ("cursor", "cursor-agent"),
            ("copilot", "copilot"),
            ("opencode", "opencode"),
            ("grok", "grok"),
            ("pi", "pi"),
            ("amp", "amp"),
        ] {
            let provider_id = ProviderIdV1::new(provider).unwrap();
            assert_eq!(
                registry
                    .preflight_plan(&provider_id)
                    .unwrap()
                    .unwrap()
                    .executable,
                executable
            );
        }
    }

    #[test]
    fn prompt_target_is_owned_by_the_registered_provider_adapter() {
        let registry = test_local_agent_provider_registry();
        let opencode = ProviderIdV1::new("opencode").unwrap();
        assert_eq!(
            registry.prompt_target(&opencode, None),
            Some(AgentProviderPromptTargetV1::LaunchArgument),
        );
        assert_eq!(
            registry.prompt_target(&opencode, Some("ses_exact_fixture")),
            Some(AgentProviderPromptTargetV1::ProviderEvent),
        );
        assert_eq!(
            registry.prompt_target(&ProviderIdV1::new("codex").unwrap(), None),
            Some(AgentProviderPromptTargetV1::LaunchArgument),
        );
        assert_eq!(
            registry.prompt_target(&ProviderIdV1::new("claude").unwrap(), None),
            Some(AgentProviderPromptTargetV1::LaunchArgument),
        );
        assert_eq!(
            registry.prompt_target(&ProviderIdV1::new("unknown").unwrap(), None),
            None,
        );
    }

    #[test]
    fn codex_structured_capability_is_advertised_only_by_its_registered_runtime() {
        let registry = test_codex_structured_agent_provider_registry();
        let codex = ProviderIdV1::new("codex").unwrap();
        assert!(
            registry
                .structured_session_plan(AgentProviderStructuredSessionRequestV1 {
                    provider_id: &codex,
                    execution_profile: &AgentExecutionProfileV1::ProviderDefault,
                    permission_mode: &ProviderPermissionModeV1::Default,
                    model: None,
                    effort: None,
                    has_setup_command: false,
                    provider_conversation_ref: &Default::default(),
                })
                .unwrap()
                .is_some()
        );
        assert!(
            registry
                .structured_session_plan(AgentProviderStructuredSessionRequestV1 {
                    provider_id: &ProviderIdV1::new("claude").unwrap(),
                    execution_profile: &AgentExecutionProfileV1::ProviderDefault,
                    permission_mode: &ProviderPermissionModeV1::Default,
                    model: None,
                    effort: None,
                    has_setup_command: false,
                    provider_conversation_ref: &Default::default(),
                })
                .unwrap()
                .is_none()
        );

        let model = AgentSpawnModelSelectionV1::parse("gpt-5.6-sol").unwrap();
        let effort = AgentSpawnEffortSelectionV1::parse("ultra").unwrap();
        assert!(
            registry
                .structured_session_plan(AgentProviderStructuredSessionRequestV1 {
                    provider_id: &codex,
                    execution_profile: &AgentExecutionProfileV1::ProviderDefault,
                    permission_mode: &ProviderPermissionModeV1::SkipPermissions,
                    model: Some(&model),
                    effort: Some(&effort),
                    has_setup_command: false,
                    provider_conversation_ref: &Default::default(),
                })
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn pi_structured_plan_refuses_permission_modes_without_a_provider_contract() {
        let provider = ProviderIdV1::new("pi").unwrap();
        let registry = provider_registry(
            test_integration_source(),
            BTreeSet::from([provider.clone()]),
        );
        for permission in [
            ProviderPermissionModeV1::AutoEdit,
            ProviderPermissionModeV1::SkipPermissions,
        ] {
            let result =
                registry.structured_session_plan(AgentProviderStructuredSessionRequestV1 {
                    provider_id: &provider,
                    execution_profile: &AgentExecutionProfileV1::ProviderDefault,
                    permission_mode: &permission,
                    model: None,
                    effort: None,
                    has_setup_command: false,
                    provider_conversation_ref: &Default::default(),
                });
            assert!(
                result.is_err(),
                "Pi must not advertise an approval policy it does not implement: {permission:?}"
            );
        }
    }

    #[test]
    fn opencode_structured_plans_follow_registered_runtime_capability() {
        let provider = ProviderIdV1::new("opencode").unwrap();
        for available in [false, true] {
            let registry = provider_registry(
                test_integration_source(),
                if available {
                    BTreeSet::from([provider.clone()])
                } else {
                    BTreeSet::new()
                },
            );
            for setup in [false, true] {
                let plan =
                    registry
                        .structured_session_plan(AgentProviderStructuredSessionRequestV1 {
                            provider_id: &provider,
                            execution_profile: &AgentExecutionProfileV1::ProviderDefault,
                            permission_mode: &ProviderPermissionModeV1::AutoEdit,
                            model: Some(
                                &AgentSpawnModelSelectionV1::parse("fixture/model").unwrap(),
                            ),
                            effort: Some(&AgentSpawnEffortSelectionV1::parse("high").unwrap()),
                            has_setup_command: setup,
                            provider_conversation_ref:
                                &dure_app::AgentProviderConversationPlanV1::resume("ses_exact")
                                    .unwrap(),
                        })
                        .unwrap();
                assert_eq!(plan.is_some(), available && !setup);
            }
        }
    }

    #[test]
    fn bundled_provider_adapters_own_the_permission_arguments() {
        let registry = test_local_agent_provider_registry();
        for (provider, argument) in [
            ("codex", "--dangerously-bypass-approvals-and-sandbox"),
            ("claude", "--dangerously-skip-permissions"),
        ] {
            let provider_id = ProviderIdV1::new(provider).unwrap();
            let default = registry
                .launch_plan(
                    &provider_id,
                    &ProviderPermissionModeV1::Default,
                    None,
                    None,
                    None,
                )
                .unwrap()
                .unwrap();
            assert!(!default.arguments.contains(&argument.to_string()));
            let bypass = registry
                .launch_plan(
                    &provider_id,
                    &ProviderPermissionModeV1::SkipPermissions,
                    None,
                    None,
                    None,
                )
                .unwrap()
                .unwrap();
            assert_eq!(
                bypass
                    .arguments
                    .iter()
                    .filter(|value| *value == argument)
                    .count(),
                1
            );
            assert_eq!(
                bypass
                    .arguments
                    .into_iter()
                    .filter(|value| value != argument)
                    .collect::<Vec<_>>(),
                default.arguments
            );
        }
    }

    #[test]
    fn bundled_provider_adapters_own_the_auto_edit_arguments() {
        let registry = test_local_agent_provider_registry();
        for (provider, expected, bypass) in [
            (
                "claude",
                &["--permission-mode", "acceptEdits"][..],
                "--dangerously-skip-permissions",
            ),
            (
                "codex",
                &[
                    "--sandbox",
                    "workspace-write",
                    "--ask-for-approval",
                    "on-request",
                ][..],
                "--dangerously-bypass-approvals-and-sandbox",
            ),
        ] {
            let provider_id = ProviderIdV1::new(provider).unwrap();
            let plan = registry
                .launch_plan(
                    &provider_id,
                    &ProviderPermissionModeV1::AutoEdit,
                    None,
                    None,
                    None,
                )
                .unwrap()
                .unwrap();
            assert!(
                plan.arguments
                    .windows(expected.len())
                    .any(|window| window == expected),
                "{provider} arguments missing {expected:?}: {:?}",
                plan.arguments
            );
            assert!(
                !plan.arguments.iter().any(|argument| argument == bypass),
                "auto-edit must never bypass permissions or sandboxing"
            );
            let default = registry
                .launch_plan(
                    &provider_id,
                    &ProviderPermissionModeV1::Default,
                    None,
                    None,
                    None,
                )
                .unwrap()
                .unwrap();
            let mut without_auto_edit = plan.arguments;
            let position = without_auto_edit
                .windows(expected.len())
                .position(|window| window == expected)
                .unwrap();
            without_auto_edit.drain(position..position + expected.len());
            assert_eq!(without_auto_edit, default.arguments);
        }
    }

    #[test]
    fn bundled_codex_launch_carries_the_semantic_lifecycle_adapter() {
        let registry = test_local_agent_provider_registry();
        let provider_id = ProviderIdV1::new("codex").unwrap();
        let plan = registry
            .launch_plan(
                &provider_id,
                &ProviderPermissionModeV1::Default,
                None,
                None,
                None,
            )
            .unwrap()
            .unwrap();

        assert!(
            plan.arguments
                .windows(2)
                .any(|pair| { pair == ["-c", "notify=[\"/fixture/managed-codex-notify.sh\"]"] })
        );
        assert!(
            plan.arguments
                .iter()
                .any(|value| value == "--dangerously-bypass-hook-trust")
        );
        assert!(
            plan.arguments
                .windows(2)
                .any(|pair| pair == ["-c", "features.hooks=true"])
        );
        assert!(
            plan.arguments
                .iter()
                .any(|value| value.starts_with("hooks.SessionStart=")
                    && value.contains("startup|resume|clear"))
        );
        assert!(
            plan.arguments
                .iter()
                .any(|value| value.starts_with("hooks.UserPromptSubmit=")
                    && value.contains("managed-codex-notify.sh"))
        );
        assert!(
            plan.arguments
                .iter()
                .any(|value| value.starts_with("hooks.Interrupt=")
                    && value.contains("managed-codex-notify.sh"))
        );
        assert!(
            !plan
                .arguments
                .iter()
                .any(|value| value.starts_with("hooks.Stop=")
                    && value.contains("managed-codex-notify.sh"))
        );
        assert!(
            !plan
                .arguments
                .iter()
                .any(|value| value.starts_with("hooks.state="))
        );
        assert!(
            !plan
                .arguments
                .iter()
                .any(|argument| argument.starts_with("tui.alternate_screen="))
        );
    }

    #[test]
    fn bundled_claude_launch_preserves_the_completion_hook_contract() {
        let registry = test_local_agent_provider_registry();
        let provider_id = ProviderIdV1::new("claude").unwrap();
        let plan = registry
            .launch_plan(
                &provider_id,
                &ProviderPermissionModeV1::Default,
                None,
                None,
                None,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            plan.arguments,
            vec!["--settings", "/fixture/managed-claude-settings.json"]
        );
    }

    fn bundled_argv_table() -> [(&'static str, Vec<String>); 2] {
        [
            (
                "codex",
                test_codex_provider_arguments(ProviderPermissionModeV1::Default),
            ),
            (
                "claude",
                vec![
                    "--settings".into(),
                    "/fixture/managed-claude-settings.json".into(),
                ],
            ),
        ]
    }

    #[test]
    fn model_selection_appends_the_model_flag_for_both_bundled_providers() {
        let registry = test_local_agent_provider_registry();
        let model = AgentSpawnModelSelectionV1::parse("opus").unwrap();
        for (provider, arguments) in bundled_argv_table() {
            let provider_id = ProviderIdV1::new(provider).unwrap();
            let plan = registry
                .launch_plan(
                    &provider_id,
                    &ProviderPermissionModeV1::Default,
                    Some(&model),
                    None,
                    None,
                )
                .unwrap()
                .unwrap();
            let position = plan
                .arguments
                .iter()
                .position(|argument| argument == "--model")
                .unwrap();
            assert_eq!(plan.arguments[position + 1], "opus");
            assert_eq!(plan.arguments[..position], arguments[..]);

            let bypass = registry
                .launch_plan(
                    &provider_id,
                    &ProviderPermissionModeV1::SkipPermissions,
                    Some(&model),
                    None,
                    None,
                )
                .unwrap()
                .unwrap();
            assert_eq!(
                bypass.arguments.last().map(String::as_str),
                Some("opus"),
                "the model selection must survive the permission argument"
            );
        }
    }

    #[test]
    fn absent_model_leaves_argv_unchanged() {
        let registry = test_local_agent_provider_registry();
        for (provider, arguments) in bundled_argv_table() {
            let plan = registry
                .launch_plan(
                    &ProviderIdV1::new(provider).unwrap(),
                    &ProviderPermissionModeV1::Default,
                    None,
                    None,
                    None,
                )
                .unwrap()
                .unwrap();
            assert_eq!(plan.arguments, arguments);
        }
    }

    #[test]
    fn structured_claude_admits_both_permissions_opaque_models_and_supported_effort() {
        let registry = test_local_agent_provider_registry();
        let provider_id = ProviderIdV1::new("claude").unwrap();
        let model = AgentSpawnModelSelectionV1::parse("future.model-v9").unwrap();

        for permission_mode in [
            ProviderPermissionModeV1::Default,
            ProviderPermissionModeV1::SkipPermissions,
        ] {
            for effort in ["low", "medium", "high", "xhigh", "max"] {
                let effort = AgentSpawnEffortSelectionV1::parse(effort).unwrap();
                let plan = registry
                    .structured_session_plan(AgentProviderStructuredSessionRequestV1 {
                        provider_id: &provider_id,
                        execution_profile: &AgentExecutionProfileV1::ProviderDefault,
                        permission_mode: &permission_mode,
                        model: Some(&model),
                        effort: Some(&effort),
                        has_setup_command: false,
                        provider_conversation_ref: &Default::default(),
                    })
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    plan.interaction_profile,
                    AgentInteractionProfileV1::StructuredProtocol
                );
            }
        }
    }

    #[test]
    fn structured_claude_passes_unlisted_effort_tokens_to_the_runtime() {
        // Which efforts exist is the provider runtime's catalog to decide —
        // it downgrades unsupported levels itself — so a shape-valid token
        // the local list never heard of still gets a structured plan.
        let registry = test_local_agent_provider_registry();
        let plan = registry
            .structured_session_plan(AgentProviderStructuredSessionRequestV1 {
                provider_id: &ProviderIdV1::new("claude").unwrap(),
                execution_profile: &AgentExecutionProfileV1::ProviderDefault,
                permission_mode: &ProviderPermissionModeV1::Default,
                model: None,
                effort: Some(&AgentSpawnEffortSelectionV1::parse("ultra").unwrap()),
                has_setup_command: false,
                provider_conversation_ref: &Default::default(),
            })
            .unwrap();

        assert!(plan.is_some());
    }

    #[test]
    fn native_only_setup_does_not_apply_structured_effort_constraints() {
        let registry = test_local_agent_provider_registry();
        let plan = registry
            .structured_session_plan(AgentProviderStructuredSessionRequestV1 {
                provider_id: &ProviderIdV1::new("claude").unwrap(),
                execution_profile: &AgentExecutionProfileV1::ProviderDefault,
                permission_mode: &ProviderPermissionModeV1::Default,
                model: None,
                effort: Some(&AgentSpawnEffortSelectionV1::parse("ultra").unwrap()),
                has_setup_command: true,
                provider_conversation_ref: &Default::default(),
            })
            .unwrap();

        assert!(plan.is_none());
    }

    #[test]
    fn effort_selection_maps_to_each_bundled_adapter_launch_argument() {
        let registry = test_local_agent_provider_registry();
        let model = AgentSpawnModelSelectionV1::parse("gpt-5.6-sol").unwrap();
        let effort = AgentSpawnEffortSelectionV1::parse("xhigh").unwrap();
        let plan = registry
            .launch_plan(
                &ProviderIdV1::new("codex").unwrap(),
                &ProviderPermissionModeV1::Default,
                Some(&model),
                Some(&effort),
                None,
            )
            .unwrap()
            .unwrap();
        let position = plan
            .arguments
            .iter()
            .position(|argument| argument == "model_reasoning_effort=xhigh")
            .unwrap();
        assert_eq!(plan.arguments[position - 1], "-c");
        assert!(plan.arguments.contains(&"gpt-5.6-sol".to_string()));

        // Effort alone must work too: Auto model keeps the provider default.
        let effort_only = registry
            .launch_plan(
                &ProviderIdV1::new("codex").unwrap(),
                &ProviderPermissionModeV1::Default,
                None,
                Some(&effort),
                None,
            )
            .unwrap()
            .unwrap();
        assert!(!effort_only.arguments.contains(&"--model".to_string()));
        assert!(
            effort_only
                .arguments
                .contains(&"model_reasoning_effort=xhigh".to_string())
        );

        // Claude spells the same selection as a dedicated flag.
        let claude = registry
            .launch_plan(
                &ProviderIdV1::new("claude").unwrap(),
                &ProviderPermissionModeV1::Default,
                None,
                Some(&effort),
                None,
            )
            .unwrap()
            .unwrap();
        let position = claude
            .arguments
            .iter()
            .position(|argument| argument == "--effort")
            .unwrap();
        assert_eq!(claude.arguments[position + 1], "xhigh");
    }

    #[test]
    fn bundled_adapters_resume_one_exact_provider_conversation() {
        let registry = test_local_agent_provider_registry();
        for (provider, expected_tail) in [
            ("codex", ["resume", "conversation-1"]),
            ("claude", ["--resume", "conversation-1"]),
        ] {
            let plan = registry
                .launch_plan(
                    &ProviderIdV1::new(provider).unwrap(),
                    &ProviderPermissionModeV1::Default,
                    None,
                    None,
                    Some("conversation-1"),
                )
                .unwrap()
                .unwrap();
            assert_eq!(
                &plan.arguments[plan.arguments.len() - expected_tail.len()..],
                expected_tail
            );
        }
    }

    #[test]
    fn channel_contract_drives_both_adapters_and_rejects_outside_references() {
        let fixture = tempfile::tempdir().unwrap();
        let channel = "dev-completion-fixture-a1b2c3d4";
        let control_dir = fixture.path().join("channels").join(channel);
        fs::create_dir_all(&control_dir).unwrap();
        fs::set_permissions(&control_dir, fs::Permissions::from_mode(0o700)).unwrap();

        let codex_notify = control_dir.join("managed-codex-notify.sh");
        let claude_settings = control_dir.join("managed-claude-settings.json");
        write_fixture_file(&codex_notify, b"#!/bin/sh\nexit 0\n", 0o700);
        write_fixture_file(&claude_settings, b"{}\n", 0o600);
        let document_path = control_dir.join(PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1);
        write_fixture_document(
            &document_path,
            channel,
            vec![codex_notify.to_string_lossy().into_owned()],
            claude_settings.to_string_lossy().into_owned(),
        );

        let integrations: Arc<dyn ProviderRuntimeIntegrationSource> = Arc::new(
            ChannelProviderRuntimeIntegrationSource::at(channel, control_dir.clone()),
        );
        let fixture_executable = std::env::current_exe().unwrap();
        let mut registry = AgentProviderRegistry::default();
        for provider in ["codex", "claude"] {
            register_provider(
                &mut registry,
                BundledAgentProvider::new(
                    &format!("fixture.{provider}"), "Fixture provider", provider,
                    fixture_executable.to_str().unwrap(), Arc::clone(&integrations), false,
                ),
            );
        }
        let codex = registry
            .launch_plan(
                &ProviderIdV1::new("codex").unwrap(),
                &ProviderPermissionModeV1::Default,
                None,
                None,
                None,
            )
            .unwrap()
            .unwrap();
        assert_eq!(codex.arguments[0], "-c");
        assert!(codex.arguments.windows(2).any(|arguments| {
            arguments[0] == "-c" && arguments[1].contains("managed-codex-notify.sh")
        }));
        assert!(
            !codex
                .arguments
                .iter()
                .any(|argument| argument.starts_with("tui.alternate_screen="))
        );
        let claude = registry
            .launch_plan(
                &ProviderIdV1::new("claude").unwrap(),
                &ProviderPermissionModeV1::Default,
                None,
                None,
                None,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            &claude.arguments[claude.arguments.len() - 2..],
            ["--settings", claude_settings.to_str().unwrap()]
        );

        fs::remove_file(&document_path).unwrap();
        let outside_notify = fixture.path().join("outside-notify.sh");
        write_fixture_file(&outside_notify, b"#!/bin/sh\nexit 0\n", 0o700);
        write_fixture_document(
            &document_path,
            channel,
            vec![outside_notify.to_string_lossy().into_owned()],
            claude_settings.to_string_lossy().into_owned(),
        );
        let error = registry
            .launch_plan(
                &ProviderIdV1::new("codex").unwrap(),
                &ProviderPermissionModeV1::Default,
                None,
                None,
                None,
            )
            .unwrap_err();
        assert_eq!(
            error.code.as_str(),
            "provider_runtime_integration_unavailable"
        );
    }
}
