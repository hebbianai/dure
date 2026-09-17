//! Durable backend-local credential profile references.
//!
//! Interaction bindings carry only the public reference and generation. The
//! profile directory locator and filesystem identity remain private to the
//! backend that launches the provider process.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{AgentExecutionProfileV1, DomainStoreErrorV1, DomainStoreFuture, ProviderIdV1};

pub const PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1: u16 = 1;
const MAX_PROFILE_DIRECTORY_NAME_BYTES: usize = 255;

const CODEX_STATE_ROOTS: &[&str] = &["CODEX_HOME", "CODEX_SQLITE_HOME"];
const CODEX_SELECTED_ENVIRONMENT_REMOVALS: &[&str] = &[
    "CODEX_ACCESS_TOKEN",
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_FEDERATION_RULE_ID",
    "OPENAI_IDENTITY_TOKEN_FILE",
];
const CLAUDE_STATE_ROOTS: &[&str] = &["CLAUDE_CONFIG_DIR", "ANTHROPIC_CONFIG_DIR"];
const CLAUDE_SELECTED_ENVIRONMENT_REMOVALS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_PROFILE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_VERTEX",
];
const KIMI_STATE_ROOTS: &[&str] = &["KIMI_CODE_HOME"];
const KIMI_SELECTED_ENVIRONMENT_REMOVALS: &[&str] = &[
    "KIMI_CODE_CUSTOM_HEADERS",
    "KIMI_MODEL_API_KEY",
    "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_NAME",
    "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_WEB_FETCH_API_KEY",
    "KIMI_WEB_FETCH_BASE_URL",
    "KIMI_WEB_SEARCH_API_KEY",
    "KIMI_WEB_SEARCH_BASE_URL",
];

/// Provider-owned process selectors. Hosts receive only the resulting neutral
/// environment mutation; provider names and account concepts stop here.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProviderCredentialEnvironmentPolicyV1 {
    state_roots: &'static [&'static str],
    selected_environment_removals: &'static [&'static str],
}

impl ProviderCredentialEnvironmentPolicyV1 {
    #[must_use]
    pub fn state_roots(self) -> &'static [&'static str] {
        self.state_roots
    }

    #[must_use]
    pub fn selected_environment_removals(self) -> &'static [&'static str] {
        self.selected_environment_removals
    }
}

#[must_use]
pub fn provider_credential_environment_policy_v1(
    provider_id: &str,
) -> Option<ProviderCredentialEnvironmentPolicyV1> {
    let (state_roots, selected_environment_removals) = match provider_id {
        "codex" => (CODEX_STATE_ROOTS, CODEX_SELECTED_ENVIRONMENT_REMOVALS),
        "claude" => (CLAUDE_STATE_ROOTS, CLAUDE_SELECTED_ENVIRONMENT_REMOVALS),
        "kimi" => (KIMI_STATE_ROOTS, KIMI_SELECTED_ENVIRONMENT_REMOVALS),
        _ => return None,
    };
    Some(ProviderCredentialEnvironmentPolicyV1 {
        state_roots,
        selected_environment_removals,
    })
}

#[derive(Clone, Eq, PartialEq)]
pub struct ProviderCredentialProfileDirectoryNameV1(String);

impl ProviderCredentialProfileDirectoryNameV1 {
    pub fn new(
        provider_id: &ProviderIdV1,
        value: impl Into<String>,
    ) -> Result<Self, DomainStoreErrorV1> {
        let value = value.into();
        let expected_prefix = format!("{}-", provider_id.as_str());
        if value.is_empty()
            || value.len() > MAX_PROFILE_DIRECTORY_NAME_BYTES
            || !value.starts_with(&expected_prefix)
            || value.len() == expected_prefix.len()
            || value == "."
            || value == ".."
            || value
                .chars()
                .any(|character| !(character.is_alphanumeric() || matches!(character, '-' | '_')))
        {
            return invalid(
                "profileDirectoryName",
                "must be one provider-scoped account directory name",
            );
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProviderCredentialProfileDirectoryNameV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCredentialProfileV1 {
    pub schema_version: u16,
    pub provider_id: ProviderIdV1,
    pub reference_id: String,
    pub credential_generation: String,
}

impl ProviderCredentialProfileV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        AgentExecutionProfileV1::CredentialReference {
            reference_id: self.reference_id.clone(),
            credential_generation: Some(self.credential_generation.clone()),
        }
        .validate()
    }
}

/// Private durable registration used only inside the backend.
///
/// Custom `Debug` intentionally omits the account directory locator. This type
/// is not serializable, so it cannot accidentally enter an interaction DTO or
/// backend response.
#[derive(Clone, Eq, PartialEq)]
pub struct ProviderCredentialProfileRegistrationV1 {
    pub profile: ProviderCredentialProfileV1,
    pub profile_directory_name: ProviderCredentialProfileDirectoryNameV1,
    pub profile_device: u64,
    pub profile_inode: u64,
}

impl ProviderCredentialProfileRegistrationV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        self.profile.validate()?;
        if !self
            .profile_directory_name
            .as_str()
            .starts_with(&format!("{}-", self.profile.provider_id.as_str()))
        {
            return invalid("profileDirectoryName", "must match providerId");
        }
        Ok(())
    }
}

impl fmt::Debug for ProviderCredentialProfileRegistrationV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderCredentialProfileRegistrationV1")
            .field("profile", &self.profile)
            .field("profile_directory_name", &"<redacted>")
            .field("profile_device", &self.profile_device)
            .field("profile_inode", &self.profile_inode)
            .finish()
    }
}

pub trait ProviderCredentialProfileStore: Send + Sync {
    fn register_provider_credential_profile<'a>(
        &'a self,
        expected_credential_generation: Option<&'a str>,
        registration: &'a ProviderCredentialProfileRegistrationV1,
    ) -> DomainStoreFuture<'a, ProviderCredentialProfileRegistrationV1>;

    fn provider_credential_profile<'a>(
        &'a self,
        provider_id: &'a ProviderIdV1,
        reference_id: &'a str,
    ) -> DomainStoreFuture<'a, Option<ProviderCredentialProfileRegistrationV1>>;

    fn provider_credential_profile_for_launch_reference<'a>(
        &'a self,
        provider_id: &'a ProviderIdV1,
        launch_reference: &'a str,
    ) -> DomainStoreFuture<'a, Option<ProviderCredentialProfileRegistrationV1>>;
}

fn validate_schema(schema_version: u16) -> Result<(), DomainStoreErrorV1> {
    if schema_version != PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1 {
        return invalid(
            "schemaVersion",
            "unsupported provider credential profile schema",
        );
    }
    Ok(())
}

fn invalid<T>(field: &'static str, reason: impl Into<String>) -> Result<T, DomainStoreErrorV1> {
    Err(DomainStoreErrorV1::InvalidRecord {
        field,
        reason: reason.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration() -> ProviderCredentialProfileRegistrationV1 {
        ProviderCredentialProfileRegistrationV1 {
            profile: ProviderCredentialProfileV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: ProviderIdV1::new("claude").unwrap(),
                reference_id: "acc-profile-a".into(),
                credential_generation: "credential-v1-1234".into(),
            },
            profile_directory_name: ProviderCredentialProfileDirectoryNameV1::new(
                &ProviderIdV1::new("claude").unwrap(),
                "claude-work",
            )
            .unwrap(),
            profile_device: 10,
            profile_inode: 20,
        }
    }

    #[test]
    fn private_registration_never_debugs_the_locator() {
        let registration = registration();
        registration.validate().unwrap();
        let debug = format!("{registration:?}");
        assert!(!debug.contains("claude-work"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn locator_must_be_one_provider_scoped_leaf() {
        for invalid_name in ["work", "claude", "claude-../work", "codex-work"] {
            let registration = registration();
            assert!(
                ProviderCredentialProfileDirectoryNameV1::new(
                    &registration.profile.provider_id,
                    invalid_name,
                )
                .is_err(),
                "accepted {invalid_name}"
            );
        }
        assert!(
            ProviderCredentialProfileDirectoryNameV1::new(
                &ProviderIdV1::new("claude").unwrap(),
                "claude-업무",
            )
            .is_ok()
        );
    }

    #[test]
    fn process_environment_policy_has_one_provider_owned_key_registry() {
        let codex = provider_credential_environment_policy_v1("codex").unwrap();
        assert_eq!(codex.state_roots(), CODEX_STATE_ROOTS);
        assert_eq!(
            codex.selected_environment_removals(),
            &[
                "CODEX_ACCESS_TOKEN",
                "CODEX_API_KEY",
                "OPENAI_API_KEY",
                "OPENAI_FEDERATION_RULE_ID",
                "OPENAI_IDENTITY_TOKEN_FILE",
            ]
        );

        let claude = provider_credential_environment_policy_v1("claude").unwrap();
        assert_eq!(claude.state_roots(), CLAUDE_STATE_ROOTS);
        assert_eq!(
            claude.selected_environment_removals(),
            &[
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "ANTHROPIC_FEDERATION_RULE_ID",
                "ANTHROPIC_ORGANIZATION_ID",
                "ANTHROPIC_PROFILE",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "CLAUDE_CODE_USE_ANTHROPIC_AWS",
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_FOUNDRY",
                "CLAUDE_CODE_USE_MANTLE",
                "CLAUDE_CODE_USE_VERTEX",
            ]
        );

        let kimi = provider_credential_environment_policy_v1("kimi").unwrap();
        assert_eq!(kimi.state_roots(), KIMI_STATE_ROOTS);
        assert_eq!(
            kimi.selected_environment_removals(),
            &[
                "KIMI_CODE_CUSTOM_HEADERS",
                "KIMI_MODEL_API_KEY",
                "KIMI_MODEL_BASE_URL",
                "KIMI_MODEL_NAME",
                "KIMI_MODEL_PROVIDER_TYPE",
                "KIMI_WEB_FETCH_API_KEY",
                "KIMI_WEB_FETCH_BASE_URL",
                "KIMI_WEB_SEARCH_API_KEY",
                "KIMI_WEB_SEARCH_BASE_URL",
            ]
        );
        assert!(provider_credential_environment_policy_v1("unknown").is_none());
    }
}
