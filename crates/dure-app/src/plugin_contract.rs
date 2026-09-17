use std::{collections::BTreeMap, error::Error, fmt};

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use crate::{StableIdError, contract::validate_stable_id};

pub const PLUGIN_MANIFEST_SCHEMA_VERSION_V2: u16 = 2;

macro_rules! plugin_stable_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
        #[ts(type = "string")]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, StableIdError> {
                let value = value.into();
                validate_stable_id(&value)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(serde::de::Error::custom)
            }
        }
    };
}

plugin_stable_id!(PluginIdV2);
plugin_stable_id!(PluginPublisherIdV2);
plugin_stable_id!(ContributionIdV2);
plugin_stable_id!(ContributionFamilyIdV2);
plugin_stable_id!(PermissionKindIdV2);
plugin_stable_id!(AgentAdapterIdV2);
plugin_stable_id!(AgentIntegrationIdV2);
plugin_stable_id!(AgentProfileIdV2);
plugin_stable_id!(AgentTargetIdV2);
plugin_stable_id!(AgentNativePluginNameV2);
plugin_stable_id!(AgentNativeMarketplaceNameV2);
plugin_stable_id!(PhysicalTargetKeyV2);

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[ts(type = "string")]
pub struct PluginVersionV2(String);

impl PluginVersionV2 {
    pub fn new(value: impl Into<String>) -> Result<Self, PluginContractValidationErrorV2> {
        let value = value.into();
        semver::Version::parse(&value).map_err(|error| {
            PluginContractValidationErrorV2::new(format!(
                "plugin version {value:?} is not valid SemVer: {error}"
            ))
        })?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PluginVersionV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[ts(type = "string")]
pub struct PluginResourcePathV2(String);

impl PluginResourcePathV2 {
    pub fn new(value: impl Into<String>) -> Result<Self, PluginContractValidationErrorV2> {
        let value = value.into();
        validate_relative_resource_path(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PluginResourcePathV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

fn validate_relative_resource_path(value: &str) -> Result<(), PluginContractValidationErrorV2> {
    if value.len() > 512 {
        return Err(PluginContractValidationErrorV2::new(
            "plugin resource path must be at most 512 bytes".to_owned(),
        ));
    }
    if !value.starts_with("./") {
        return Err(PluginContractValidationErrorV2::new(format!(
            "plugin resource path {value:?} must start with './'"
        )));
    }
    if value.contains('\\') || value.contains(':') || value.contains('\0') {
        return Err(PluginContractValidationErrorV2::new(format!(
            "plugin resource path {value:?} must use portable forward-slash segments"
        )));
    }
    let segments = value[2..].split('/').collect::<Vec<_>>();
    if segments.is_empty()
        || segments
            .iter()
            .any(|segment| segment.is_empty() || matches!(*segment, "." | ".."))
    {
        return Err(PluginContractValidationErrorV2::new(format!(
            "plugin resource path {value:?} must remain inside the package root"
        )));
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
pub struct ContractVersionRangeV2 {
    pub min_inclusive: u16,
    pub max_inclusive: u16,
}

impl ContractVersionRangeV2 {
    pub const fn new(min_inclusive: u16, max_inclusive: u16) -> Self {
        Self {
            min_inclusive,
            max_inclusive,
        }
    }

    pub const fn is_valid(&self) -> bool {
        self.min_inclusive > 0 && self.min_inclusive <= self.max_inclusive
    }

    pub const fn highest_common(&self, other: &Self) -> Option<u16> {
        let lowest_max = if self.max_inclusive < other.max_inclusive {
            self.max_inclusive
        } else {
            other.max_inclusive
        };
        let highest_min = if self.min_inclusive > other.min_inclusive {
            self.min_inclusive
        } else {
            other.min_inclusive
        };
        if highest_min <= lowest_max {
            Some(lowest_max)
        } else {
            None
        }
    }
}

impl<'de> Deserialize<'de> for ContractVersionRangeV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct WireRange {
            min_inclusive: u16,
            max_inclusive: u16,
        }

        let wire = WireRange::deserialize(deserializer)?;
        let range = Self::new(wire.min_inclusive, wire.max_inclusive);
        if !range.is_valid() {
            return Err(serde::de::Error::custom(
                "contract version range must be non-zero and ordered",
            ));
        }
        Ok(range)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PluginPlacementV2 {
    Ui,
    Workspace,
    Either,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginActivationEventV2 {
    Explicit,
    WorkspaceContains { pattern: String },
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
pub struct ContributionDescriptorV2 {
    pub id: ContributionIdV2,
    pub family: ContributionFamilyIdV2,
    pub family_api: ContractVersionRangeV2,
    pub required: bool,
    pub placement: PluginPlacementV2,
    pub resource: PluginResourcePathV2,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentInstallScopeV2 {
    User,
    Project,
    Local,
    Managed,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
pub struct AgentNativePluginSelectorV2 {
    pub plugin: AgentNativePluginNameV2,
    pub marketplace: AgentNativeMarketplaceNameV2,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
pub struct AgentIntegrationDescriptorV2 {
    pub id: AgentIntegrationIdV2,
    pub adapter: AgentAdapterIdV2,
    pub required: bool,
    pub resource: PluginResourcePathV2,
    pub selector: AgentNativePluginSelectorV2,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
pub struct PermissionRequestV2 {
    pub kind: PermissionKindIdV2,
    #[serde(default)]
    pub parameters: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct PluginManifestV2 {
    pub schema_version: u16,
    pub id: PluginIdV2,
    pub publisher: PluginPublisherIdV2,
    pub version: PluginVersionV2,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub host_api: ContractVersionRangeV2,
    #[serde(default)]
    pub activation: Vec<PluginActivationEventV2>,
    #[serde(default)]
    pub contributions: Vec<ContributionDescriptorV2>,
    #[serde(default)]
    pub agent_integrations: Vec<AgentIntegrationDescriptorV2>,
    #[serde(default)]
    pub permissions: Vec<PermissionRequestV2>,
}

impl PluginManifestV2 {
    pub fn validate(&self) -> Result<(), PluginContractValidationErrorV2> {
        if self.schema_version != PLUGIN_MANIFEST_SCHEMA_VERSION_V2 {
            return Err(PluginContractValidationErrorV2::new(format!(
                "unsupported plugin manifest schema version {}; expected {}",
                self.schema_version, PLUGIN_MANIFEST_SCHEMA_VERSION_V2
            )));
        }
        validate_display_name(&self.display_name)?;
        if let Some(description) = &self.description {
            validate_description(description)?;
        }
        if !self.host_api.is_valid() {
            return Err(PluginContractValidationErrorV2::new(
                "host API version range must be non-zero and ordered".to_owned(),
            ));
        }
        if self.contributions.is_empty() && self.agent_integrations.is_empty() {
            return Err(PluginContractValidationErrorV2::new(
                "plugin must declare at least one contribution or agent integration".to_owned(),
            ));
        }
        let plugin_namespace = format!("{}.", self.id.as_str());
        let publisher_namespace = format!("{}.", self.publisher.as_str());
        if !self.id.as_str().starts_with(&publisher_namespace) {
            return Err(PluginContractValidationErrorV2::new(format!(
                "plugin id {} must be namespaced by publisher {}",
                self.id.as_str(),
                self.publisher.as_str()
            )));
        }

        reject_duplicates(
            "contribution ids",
            self.contributions.iter().map(|entry| &entry.id),
        )?;
        for contribution in &self.contributions {
            if !contribution.id.as_str().starts_with(&plugin_namespace) {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "contribution id {} must be namespaced by plugin {}",
                    contribution.id.as_str(),
                    self.id.as_str()
                )));
            }
            if !contribution.family_api.is_valid() {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "contribution {} has an invalid family API range",
                    contribution.id.as_str()
                )));
            }
        }

        reject_duplicates(
            "agent integration ids",
            self.agent_integrations.iter().map(|entry| &entry.id),
        )?;
        for integration in &self.agent_integrations {
            if !integration.id.as_str().starts_with(&plugin_namespace) {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "agent integration id {} must be namespaced by plugin {}",
                    integration.id.as_str(),
                    self.id.as_str()
                )));
            }
        }

        reject_duplicates(
            "permission kinds",
            self.permissions.iter().map(|entry| &entry.kind),
        )?;
        for permission in &self.permissions {
            validate_permission_parameters(permission)?;
        }
        for activation in &self.activation {
            if let PluginActivationEventV2::WorkspaceContains { pattern } = activation {
                validate_workspace_pattern(pattern)?;
            }
        }
        Ok(())
    }
}

fn validate_display_name(value: &str) -> Result<(), PluginContractValidationErrorV2> {
    if value.trim().is_empty() || value.trim() != value {
        return Err(PluginContractValidationErrorV2::new(
            "plugin display_name must be non-empty without surrounding whitespace".to_owned(),
        ));
    }
    if value.len() > 128 {
        return Err(PluginContractValidationErrorV2::new(
            "plugin display_name must be at most 128 bytes".to_owned(),
        ));
    }
    Ok(())
}

fn validate_description(value: &str) -> Result<(), PluginContractValidationErrorV2> {
    if value.trim().is_empty() || value.trim() != value {
        return Err(PluginContractValidationErrorV2::new(
            "plugin description must be non-empty without surrounding whitespace".to_owned(),
        ));
    }
    if value.len() > 512 {
        return Err(PluginContractValidationErrorV2::new(
            "plugin description must be at most 512 bytes".to_owned(),
        ));
    }
    Ok(())
}

fn validate_workspace_pattern(value: &str) -> Result<(), PluginContractValidationErrorV2> {
    if value.is_empty()
        || value.len() > 512
        || value.starts_with('/')
        || value.starts_with('~')
        || value.contains('\\')
        || value.contains(':')
        || value.contains('\0')
        || value.split('/').any(|segment| segment == "..")
    {
        return Err(PluginContractValidationErrorV2::new(format!(
            "workspace activation pattern {value:?} must remain workspace-relative"
        )));
    }
    Ok(())
}

fn validate_permission_parameters(
    permission: &PermissionRequestV2,
) -> Result<(), PluginContractValidationErrorV2> {
    for (key, values) in &permission.parameters {
        validate_stable_id(key).map_err(|error| {
            PluginContractValidationErrorV2::new(format!(
                "permission {} has invalid parameter key: {error}",
                permission.kind.as_str()
            ))
        })?;
        if values.is_empty() {
            return Err(PluginContractValidationErrorV2::new(format!(
                "permission {} parameter {key} must not be empty",
                permission.kind.as_str()
            )));
        }
        let mut unique = std::collections::BTreeSet::new();
        for value in values {
            if value.is_empty() || value.len() > 512 || value.contains('\0') {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "permission {} parameter {key} contains an invalid value",
                    permission.kind.as_str()
                )));
            }
            if !unique.insert(value) {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "permission {} parameter {key} contains duplicate value {value:?}",
                    permission.kind.as_str()
                )));
            }
        }
    }
    Ok(())
}

fn reject_duplicates<'a, T>(
    label: &str,
    values: impl IntoIterator<Item = &'a T>,
) -> Result<(), PluginContractValidationErrorV2>
where
    T: 'a + Ord + fmt::Debug,
{
    let mut unique = std::collections::BTreeSet::new();
    for value in values {
        if !unique.insert(value) {
            return Err(PluginContractValidationErrorV2::new(format!(
                "{label} contains duplicate {value:?}"
            )));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginContractValidationErrorV2 {
    message: String,
}

impl PluginContractValidationErrorV2 {
    pub(crate) fn new(message: String) -> Self {
        Self { message }
    }
}

impl fmt::Display for PluginContractValidationErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for PluginContractValidationErrorV2 {}
