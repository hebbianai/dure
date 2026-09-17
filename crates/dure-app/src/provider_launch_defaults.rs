use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use crate::{ProviderIdV1, ProviderPermissionModeV1};

pub const PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1: u16 = 1;
const MAX_PROVIDER_DEFAULTS: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLaunchPermissionModeV1 {
    RequireApprovals,
    BypassApprovals,
}

impl ProviderLaunchPermissionModeV1 {
    pub fn from_concrete(permission_mode: &ProviderPermissionModeV1) -> Self {
        match permission_mode {
            // Auto-edit still requires approvals for anything beyond workspace
            // edits, so the coarse launch-default projection keeps it on the
            // approvals side.
            ProviderPermissionModeV1::Default | ProviderPermissionModeV1::AutoEdit => {
                Self::RequireApprovals
            }
            ProviderPermissionModeV1::SkipPermissions => Self::BypassApprovals,
        }
    }

    pub fn concrete(self) -> ProviderPermissionModeV1 {
        match self {
            Self::RequireApprovals => ProviderPermissionModeV1::Default,
            Self::BypassApprovals => ProviderPermissionModeV1::SkipPermissions,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::RequireApprovals => "require_approvals",
            Self::BypassApprovals => "bypass_approvals",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLaunchPermissionOverrideV1 {
    RequireApprovals,
    AutoEdit,
    BypassApprovals,
}

impl ProviderLaunchPermissionOverrideV1 {
    pub fn from_concrete(permission_mode: &ProviderPermissionModeV1) -> Self {
        match permission_mode {
            ProviderPermissionModeV1::Default => Self::RequireApprovals,
            ProviderPermissionModeV1::AutoEdit => Self::AutoEdit,
            ProviderPermissionModeV1::SkipPermissions => Self::BypassApprovals,
        }
    }

    pub fn concrete(self) -> ProviderPermissionModeV1 {
        match self {
            Self::RequireApprovals => ProviderPermissionModeV1::Default,
            Self::AutoEdit => ProviderPermissionModeV1::AutoEdit,
            Self::BypassApprovals => ProviderPermissionModeV1::SkipPermissions,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::RequireApprovals => "require_approvals",
            Self::AutoEdit => "auto_edit",
            Self::BypassApprovals => "bypass_approvals",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderLaunchDefaultV1 {
    pub permission_mode: ProviderLaunchPermissionModeV1,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ProviderLaunchDefaultsFingerprintV1(String);

impl ProviderLaunchDefaultsFingerprintV1 {
    pub fn new(value: impl Into<String>) -> Result<Self, ProviderLaunchDefaultsContractErrorV1> {
        let value = value.into();
        if value.len() != 71
            || !value.starts_with("sha256:")
            || !value[7..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid(
                "fingerprint",
                "must be sha256: followed by 64 lowercase hexadecimal characters",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ProviderLaunchDefaultsFingerprintV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderLaunchDefaultsV1 {
    pub schema_version: u16,
    pub revision: u64,
    pub defaults: BTreeMap<ProviderIdV1, ProviderLaunchDefaultV1>,
    pub fingerprint: ProviderLaunchDefaultsFingerprintV1,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderLaunchDefaultsWireV1 {
    schema_version: u16,
    revision: u64,
    defaults: BTreeMap<ProviderIdV1, ProviderLaunchDefaultV1>,
    fingerprint: ProviderLaunchDefaultsFingerprintV1,
}

impl<'de> Deserialize<'de> for ProviderLaunchDefaultsV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ProviderLaunchDefaultsWireV1::deserialize(deserializer)?;
        let document = Self {
            schema_version: wire.schema_version,
            revision: wire.revision,
            defaults: wire.defaults,
            fingerprint: wire.fingerprint,
        };
        document.validate().map_err(serde::de::Error::custom)?;
        Ok(document)
    }
}

impl ProviderLaunchDefaultsV1 {
    pub fn new(
        revision: u64,
        defaults: BTreeMap<ProviderIdV1, ProviderLaunchDefaultV1>,
    ) -> Result<Self, ProviderLaunchDefaultsContractErrorV1> {
        validate_defaults(&defaults)?;
        Ok(Self {
            schema_version: PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1,
            revision,
            fingerprint: fingerprint(&defaults),
            defaults,
        })
    }

    pub fn empty() -> Self {
        Self::new(0, BTreeMap::new()).expect("the empty provider defaults document is valid")
    }

    pub fn validate(&self) -> Result<(), ProviderLaunchDefaultsContractErrorV1> {
        if self.schema_version != PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1 {
            return Err(invalid("schemaVersion", "must be version 1"));
        }
        validate_defaults(&self.defaults)?;
        if self.fingerprint != fingerprint(&self.defaults) {
            return Err(invalid(
                "fingerprint",
                "does not bind the exact provider defaults document",
            ));
        }
        Ok(())
    }

    pub fn resolve_permission_mode(
        &self,
        provider_id: &ProviderIdV1,
        permission_override: Option<ProviderLaunchPermissionOverrideV1>,
    ) -> ProviderPermissionModeV1 {
        permission_override.map_or_else(
            || {
                self.defaults
                    .get(provider_id)
                    .map_or(ProviderPermissionModeV1::Default, |entry| {
                        entry.permission_mode.concrete()
                    })
            },
            ProviderLaunchPermissionOverrideV1::concrete,
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderLaunchDefaultsPutRequestV1 {
    pub schema_version: u16,
    pub idempotency_key: String,
    pub expected_revision: u64,
    pub defaults: BTreeMap<ProviderIdV1, ProviderLaunchDefaultV1>,
}

impl ProviderLaunchDefaultsPutRequestV1 {
    pub fn validate(&self) -> Result<(), ProviderLaunchDefaultsContractErrorV1> {
        if self.schema_version != PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1 {
            return Err(invalid("schemaVersion", "must be version 1"));
        }
        validate_idempotency_key(&self.idempotency_key)?;
        validate_defaults(&self.defaults)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLaunchDefaultsPutDispositionV1 {
    Created,
    Updated,
    PreservedExisting,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderLaunchDefaultsPutReceiptV1 {
    pub schema_version: u16,
    pub idempotency_key: String,
    pub expected_revision: u64,
    pub disposition: ProviderLaunchDefaultsPutDispositionV1,
    pub document: ProviderLaunchDefaultsV1,
    pub updated_at_ms: i64,
}

impl ProviderLaunchDefaultsPutReceiptV1 {
    pub fn validate(&self) -> Result<(), ProviderLaunchDefaultsContractErrorV1> {
        if self.schema_version != PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1 {
            return Err(invalid("schemaVersion", "must be version 1"));
        }
        validate_idempotency_key(&self.idempotency_key)?;
        self.document.validate()?;
        if self.updated_at_ms < 0 {
            return Err(invalid("updatedAtMs", "must be non-negative"));
        }
        let valid_revision = match self.disposition {
            ProviderLaunchDefaultsPutDispositionV1::Created => {
                self.expected_revision == 0 && self.document.revision == 1
            }
            ProviderLaunchDefaultsPutDispositionV1::Updated => self
                .expected_revision
                .checked_add(1)
                .is_some_and(|revision| revision == self.document.revision),
            ProviderLaunchDefaultsPutDispositionV1::PreservedExisting => {
                self.expected_revision == 0 && self.document.revision > 0
            }
        };
        if !valid_revision {
            return Err(invalid(
                "disposition",
                "does not match the expected and resulting revisions",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderLaunchDefaultsResolutionV1 {
    pub schema_version: u16,
    pub revision: u64,
    pub fingerprint: ProviderLaunchDefaultsFingerprintV1,
    pub permission_override: Option<ProviderLaunchPermissionOverrideV1>,
}

impl ProviderLaunchDefaultsResolutionV1 {
    pub fn from_document(
        document: &ProviderLaunchDefaultsV1,
        permission_override: Option<ProviderLaunchPermissionOverrideV1>,
    ) -> Self {
        Self {
            schema_version: PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1,
            revision: document.revision,
            fingerprint: document.fingerprint.clone(),
            permission_override,
        }
    }

    pub fn validate(&self) -> Result<(), ProviderLaunchDefaultsContractErrorV1> {
        if self.schema_version != PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1 {
            return Err(invalid("schemaVersion", "must be version 1"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLaunchDefaultsContractErrorV1 {
    pub field: &'static str,
    pub reason: &'static str,
}

impl fmt::Display for ProviderLaunchDefaultsContractErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid provider launch defaults {}: {}",
            self.field, self.reason
        )
    }
}

impl Error for ProviderLaunchDefaultsContractErrorV1 {}

fn validate_defaults(
    defaults: &BTreeMap<ProviderIdV1, ProviderLaunchDefaultV1>,
) -> Result<(), ProviderLaunchDefaultsContractErrorV1> {
    if defaults.len() > MAX_PROVIDER_DEFAULTS {
        return Err(invalid("defaults", "contains too many providers"));
    }
    Ok(())
}

fn validate_idempotency_key(
    idempotency_key: &str,
) -> Result<(), ProviderLaunchDefaultsContractErrorV1> {
    if idempotency_key.is_empty()
        || idempotency_key.len() > 160
        || !idempotency_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(invalid("idempotencyKey", "must be a bounded stable token"));
    }
    Ok(())
}

fn fingerprint(
    defaults: &BTreeMap<ProviderIdV1, ProviderLaunchDefaultV1>,
) -> ProviderLaunchDefaultsFingerprintV1 {
    let mut digest = Sha256::new();
    digest.update(b"dure.provider_launch_defaults/v1\0");
    for (provider_id, entry) in defaults {
        digest.update((provider_id.as_str().len() as u64).to_be_bytes());
        digest.update(provider_id.as_str().as_bytes());
        digest.update([0]);
        digest.update(entry.permission_mode.as_str().as_bytes());
        digest.update([0]);
    }
    ProviderLaunchDefaultsFingerprintV1(format!("sha256:{:x}", digest.finalize()))
}

fn invalid(field: &'static str, reason: &'static str) -> ProviderLaunchDefaultsContractErrorV1 {
    ProviderLaunchDefaultsContractErrorV1 { field, reason }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_provider_requires_approvals_and_fingerprints_are_deterministic() {
        let provider = ProviderIdV1::new("codex").unwrap();
        let empty = ProviderLaunchDefaultsV1::empty();
        assert_eq!(
            empty.resolve_permission_mode(&provider, None),
            ProviderPermissionModeV1::Default
        );

        let defaults = BTreeMap::from([(
            provider.clone(),
            ProviderLaunchDefaultV1 {
                permission_mode: ProviderLaunchPermissionModeV1::BypassApprovals,
            },
        )]);
        let first = ProviderLaunchDefaultsV1::new(1, defaults.clone()).unwrap();
        let second = ProviderLaunchDefaultsV1::new(9, defaults).unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(
            first.resolve_permission_mode(&provider, None),
            ProviderPermissionModeV1::SkipPermissions
        );
        assert_eq!(
            first.resolve_permission_mode(
                &provider,
                Some(ProviderLaunchPermissionOverrideV1::RequireApprovals),
            ),
            ProviderPermissionModeV1::Default
        );
    }

    #[test]
    fn auto_edit_is_an_exact_one_run_override_not_a_coarse_provider_default() {
        let provider = ProviderIdV1::new("codex").unwrap();
        assert_eq!(
            ProviderLaunchDefaultsV1::empty().resolve_permission_mode(
                &provider,
                Some(ProviderLaunchPermissionOverrideV1::AutoEdit),
            ),
            ProviderPermissionModeV1::AutoEdit
        );

        assert!(
            serde_json::from_value::<ProviderLaunchDefaultV1>(serde_json::json!({
                "permissionMode": "auto_edit"
            }))
            .is_err()
        );
    }
}
