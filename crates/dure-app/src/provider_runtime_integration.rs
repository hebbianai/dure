use std::{collections::BTreeMap, error::Error, fmt, path::Path};

use serde::{Deserialize, Serialize};

use crate::ProviderIdV1;

pub const PROVIDER_RUNTIME_INTEGRATIONS_SCHEMA_VERSION_V1: u16 = 1;
pub const PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1: &str = "managed-provider-integrations-v1.json";

const MAX_CHANNEL_BYTES: usize = 64;
const MAX_INTEGRATIONS: usize = 64;
const MAX_COMMAND_ARGUMENTS: usize = 8;
const MAX_VALUE_BYTES: usize = 4 * 1024;

/// Token-free launch material published by the app channel that owns the
/// provider event ingress. A runtime adapter can carry this document across a
/// local, SSH, or future cloud boundary without learning provider semantics.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRuntimeIntegrationsV1 {
    pub schema_version: u16,
    pub channel: String,
    pub integrations: BTreeMap<ProviderIdV1, ProviderRuntimeIntegrationV1>,
}

/// Provider-native ways to install one typed runtime-event bridge.
///
/// The provider adapter chooses and renders the supported variant. The
/// orchestration core only carries the adapter's resulting launch plan.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProviderRuntimeIntegrationV1 {
    NotificationCommand {
        command: Vec<String>,
    },
    SettingsFile {
        path: String,
    },
    /// A channel-owned launcher receives the original executable and argv.
    CommandWrapper {
        path: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderRuntimeIntegrationContractErrorV1 {
    UnsupportedSchema,
    InvalidChannel,
    TooManyIntegrations,
    InvalidNotificationCommand,
    InvalidSettingsPath,
    InvalidWrapperPath,
}

const CODEX_SESSION_START_MATCHER: &str = "startup|resume|clear";
const CODEX_LIFECYCLE_HOOK_TIMEOUT_SECONDS: u64 = 3;

impl fmt::Display for ProviderRuntimeIntegrationContractErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::UnsupportedSchema => "provider runtime integration schema is unsupported",
            Self::InvalidChannel => "provider runtime integration channel is invalid",
            Self::TooManyIntegrations => "provider runtime integration document is too large",
            Self::InvalidNotificationCommand => "provider runtime notification command is invalid",
            Self::InvalidSettingsPath => "provider runtime settings path is invalid",
            Self::InvalidWrapperPath => "provider runtime wrapper path is invalid",
        })
    }
}

impl Error for ProviderRuntimeIntegrationContractErrorV1 {}

impl ProviderRuntimeIntegrationsV1 {
    pub fn validate(&self) -> Result<(), ProviderRuntimeIntegrationContractErrorV1> {
        if self.schema_version != PROVIDER_RUNTIME_INTEGRATIONS_SCHEMA_VERSION_V1 {
            return Err(ProviderRuntimeIntegrationContractErrorV1::UnsupportedSchema);
        }
        if !valid_channel(&self.channel) {
            return Err(ProviderRuntimeIntegrationContractErrorV1::InvalidChannel);
        }
        if self.integrations.len() > MAX_INTEGRATIONS {
            return Err(ProviderRuntimeIntegrationContractErrorV1::TooManyIntegrations);
        }
        for integration in self.integrations.values() {
            integration.validate()?;
        }
        Ok(())
    }

    pub fn integration(&self, provider_id: &ProviderIdV1) -> Option<&ProviderRuntimeIntegrationV1> {
        self.integrations.get(provider_id)
    }
}

impl ProviderRuntimeIntegrationV1 {
    pub fn validate(&self) -> Result<(), ProviderRuntimeIntegrationContractErrorV1> {
        match self {
            Self::NotificationCommand { command } => {
                if command.is_empty()
                    || command.len() > MAX_COMMAND_ARGUMENTS
                    || command.iter().any(|argument| {
                        !valid_bounded_value(argument) || !absolute_execution_path(argument)
                    })
                {
                    return Err(
                        ProviderRuntimeIntegrationContractErrorV1::InvalidNotificationCommand,
                    );
                }
            }
            Self::SettingsFile { path } => {
                if !valid_bounded_value(path) || !absolute_execution_path(path) {
                    return Err(ProviderRuntimeIntegrationContractErrorV1::InvalidSettingsPath);
                }
            }
            Self::CommandWrapper { path } => {
                if !valid_bounded_value(path) || !absolute_execution_path(path) {
                    return Err(ProviderRuntimeIntegrationContractErrorV1::InvalidWrapperPath);
                }
            }
        }
        Ok(())
    }
}

/// Render the stable Codex lifecycle arguments used by both native launch
/// paths. The command is an owner-only path from the provider integration
/// contract, so this managed invocation can bypass Codex's interactive trust
/// prompt without changing persistent trust for user or project hooks.
/// Completion is delivered by the paired notify command, not a second Stop
/// hook that repeats the same goal lookup and Host report on the blocking path.
pub fn codex_lifecycle_hook_arguments_v1(
    command: &str,
) -> Result<Vec<String>, ProviderRuntimeIntegrationContractErrorV1> {
    if !valid_bounded_value(command) || !absolute_execution_path(command) {
        return Err(ProviderRuntimeIntegrationContractErrorV1::InvalidNotificationCommand);
    }
    let quoted_command = serde_json::to_string(command)
        .map_err(|_| ProviderRuntimeIntegrationContractErrorV1::InvalidNotificationCommand)?;
    Ok(vec![
        "--dangerously-bypass-hook-trust".to_string(),
        "-c".to_string(),
        "features.hooks=true".to_string(),
        "-c".to_string(),
        format!(
            "hooks.SessionStart=[{{matcher=\"{CODEX_SESSION_START_MATCHER}\",hooks=[{{type=\"command\",command={quoted_command},timeout={CODEX_LIFECYCLE_HOOK_TIMEOUT_SECONDS}}}]}}]"
        ),
        "-c".to_string(),
        format!(
            "hooks.UserPromptSubmit=[{{hooks=[{{type=\"command\",command={quoted_command},timeout={CODEX_LIFECYCLE_HOOK_TIMEOUT_SECONDS}}}]}}]"
        ),
        "-c".to_string(),
        format!(
            "hooks.Interrupt=[{{hooks=[{{type=\"command\",command={quoted_command},timeout={CODEX_LIFECYCLE_HOOK_TIMEOUT_SECONDS}}}]}}]"
        ),
    ])
}

fn valid_channel(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CHANNEL_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_bounded_value(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_VALUE_BYTES && !value.chars().any(char::is_control)
}

fn absolute_execution_path(value: &str) -> bool {
    value.starts_with('/') || Path::new(value).is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> ProviderRuntimeIntegrationsV1 {
        ProviderRuntimeIntegrationsV1 {
            schema_version: PROVIDER_RUNTIME_INTEGRATIONS_SCHEMA_VERSION_V1,
            channel: "dev-fixture-a1b2c3d4".into(),
            integrations: BTreeMap::from([
                (
                    ProviderIdV1::new("codex").unwrap(),
                    ProviderRuntimeIntegrationV1::NotificationCommand {
                        command: vec![
                            "/fixture/managed-codex-notify.sh".into(),
                            "/fixture/managed-codex-user-notify.sh".into(),
                        ],
                    },
                ),
                (
                    ProviderIdV1::new("claude").unwrap(),
                    ProviderRuntimeIntegrationV1::SettingsFile {
                        path: "/fixture/managed-claude-settings.json".into(),
                    },
                ),
            ]),
        }
    }

    #[test]
    fn provider_runtime_integration_document_is_token_free_and_bounded() {
        let document = document();
        document.validate().unwrap();
        let encoded = serde_json::to_string(&document).unwrap();
        let decoded: ProviderRuntimeIntegrationsV1 = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, document);
        assert!(!encoded.contains("Bearer"));
    }

    #[test]
    fn provider_runtime_integration_rejects_relative_or_control_paths() {
        let mut document = document();
        document.integrations.insert(
            ProviderIdV1::new("codex").unwrap(),
            ProviderRuntimeIntegrationV1::NotificationCommand {
                command: vec!["relative/notify.sh".into()],
            },
        );
        assert_eq!(
            document.validate(),
            Err(ProviderRuntimeIntegrationContractErrorV1::InvalidNotificationCommand)
        );

        document.integrations.insert(
            ProviderIdV1::new("codex").unwrap(),
            ProviderRuntimeIntegrationV1::NotificationCommand {
                command: vec!["/fixture/notify\n.sh".into()],
            },
        );
        assert_eq!(
            document.validate(),
            Err(ProviderRuntimeIntegrationContractErrorV1::InvalidNotificationCommand)
        );
    }

    #[test]
    fn codex_lifecycle_hook_arguments_enable_only_managed_lifecycle_handlers() {
        let arguments =
            codex_lifecycle_hook_arguments_v1("/fixture/managed-codex-notify.sh").unwrap();
        assert_eq!(arguments[0], "--dangerously-bypass-hook-trust");
        assert_eq!(arguments[1], "-c");
        assert_eq!(arguments[2], "features.hooks=true");
        assert!(
            arguments
                .iter()
                .any(|value| value.contains("hooks.SessionStart=")
                    && value.contains("startup|resume|clear"))
        );
        assert!(
            arguments
                .iter()
                .any(|value| value.contains("hooks.UserPromptSubmit="))
        );
        assert!(!arguments.iter().any(|value| value.contains("hooks.Stop=")));
        assert!(
            arguments
                .iter()
                .any(|value| value.contains("hooks.Interrupt="))
        );
        assert_eq!(
            arguments
                .iter()
                .filter(|value| value.contains("managed-codex-notify.sh"))
                .count(),
            3
        );
        assert!(
            !arguments
                .iter()
                .any(|value| value.starts_with("hooks.state="))
        );
    }
}
