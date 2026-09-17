use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    AgentAdapterIdV2, AgentIntegrationIdV2, ContractVersionRangeV2, ContributionDescriptorV2,
    ContributionFamilyIdV2, ContributionIdV2, PermissionKindIdV2, PluginContractValidationErrorV2,
    PluginManifestV2, PluginPlacementV2,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct ContributionFamilySupportV2 {
    pub family: ContributionFamilyIdV2,
    pub api: ContractVersionRangeV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct AgentAdapterSupportV2 {
    pub adapter: AgentAdapterIdV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct PluginHostContractV2 {
    pub host_api: ContractVersionRangeV2,
    #[serde(default)]
    pub contribution_families: Vec<ContributionFamilySupportV2>,
    #[serde(default)]
    pub agent_adapters: Vec<AgentAdapterSupportV2>,
    #[serde(default)]
    pub permission_kinds: Vec<PermissionKindIdV2>,
}

impl PluginHostContractV2 {
    pub fn validate(&self) -> Result<(), PluginContractValidationErrorV2> {
        if !self.host_api.is_valid() {
            return Err(PluginContractValidationErrorV2::new(
                "plugin host API range must be non-zero and ordered".to_owned(),
            ));
        }
        reject_duplicate_keys(
            "host contribution families",
            self.contribution_families
                .iter()
                .map(|support| &support.family),
        )?;
        for support in &self.contribution_families {
            if !support.api.is_valid() {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "host contribution family {} has an invalid API range",
                    support.family.as_str()
                )));
            }
        }
        reject_duplicate_keys(
            "host agent adapters",
            self.agent_adapters.iter().map(|support| &support.adapter),
        )?;
        reject_duplicate_keys("host permission kinds", &self.permission_kinds)?;
        Ok(())
    }
}

fn reject_duplicate_keys<'a, T>(
    label: &str,
    values: impl IntoIterator<Item = &'a T>,
) -> Result<(), PluginContractValidationErrorV2>
where
    T: 'a + Ord + std::fmt::Debug,
{
    let mut unique = BTreeSet::new();
    for value in values {
        if !unique.insert(value) {
            return Err(PluginContractValidationErrorV2::new(format!(
                "{label} contains duplicate {value:?}"
            )));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct NegotiatedContributionV2 {
    pub id: ContributionIdV2,
    pub family: ContributionFamilyIdV2,
    pub family_api_version: u16,
    pub placement: PluginPlacementV2,
}

impl NegotiatedContributionV2 {
    fn from_descriptor(descriptor: &ContributionDescriptorV2, family_api_version: u16) -> Self {
        Self {
            id: descriptor.id.clone(),
            family: descriptor.family.clone(),
            family_api_version,
            placement: descriptor.placement.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PluginCompatibilityOutcomeV2 {
    Supported {
        negotiated_host_api_version: u16,
        contributions: Vec<NegotiatedContributionV2>,
        ignored_optional_contributions: Vec<ContributionIdV2>,
        enabled_agent_integrations: Vec<AgentIntegrationIdV2>,
        ignored_optional_agent_integrations: Vec<AgentIntegrationIdV2>,
    },
    IncompatibleHostApi {
        host: ContractVersionRangeV2,
        plugin: ContractVersionRangeV2,
    },
    UnsupportedRequiredContributions {
        contributions: Vec<ContributionIdV2>,
    },
    UnsupportedRequiredAgentIntegrations {
        integrations: Vec<AgentIntegrationIdV2>,
    },
    UnsupportedPermissions {
        permissions: Vec<PermissionKindIdV2>,
    },
}

pub fn negotiate_plugin_manifest(
    manifest: &PluginManifestV2,
    host: &PluginHostContractV2,
) -> Result<PluginCompatibilityOutcomeV2, PluginContractValidationErrorV2> {
    manifest.validate()?;
    host.validate()?;

    let Some(negotiated_host_api_version) = manifest.host_api.highest_common(&host.host_api) else {
        return Ok(PluginCompatibilityOutcomeV2::IncompatibleHostApi {
            host: host.host_api.clone(),
            plugin: manifest.host_api.clone(),
        });
    };

    let supported_families = host
        .contribution_families
        .iter()
        .map(|support| (&support.family, &support.api))
        .collect::<BTreeMap<_, _>>();
    let mut contributions = Vec::new();
    let mut ignored_optional_contributions = Vec::new();
    let mut unsupported_required_contributions = Vec::new();
    for contribution in &manifest.contributions {
        let negotiated = supported_families
            .get(&contribution.family)
            .and_then(|host_api| contribution.family_api.highest_common(host_api));
        match negotiated {
            Some(family_api_version) => contributions.push(
                NegotiatedContributionV2::from_descriptor(contribution, family_api_version),
            ),
            None if contribution.required => {
                unsupported_required_contributions.push(contribution.id.clone());
            }
            None => ignored_optional_contributions.push(contribution.id.clone()),
        }
    }
    if !unsupported_required_contributions.is_empty() {
        return Ok(
            PluginCompatibilityOutcomeV2::UnsupportedRequiredContributions {
                contributions: unsupported_required_contributions,
            },
        );
    }

    let supported_adapters = host
        .agent_adapters
        .iter()
        .map(|support| &support.adapter)
        .collect::<BTreeSet<_>>();
    let mut enabled_agent_integrations = Vec::new();
    let mut ignored_optional_agent_integrations = Vec::new();
    let mut unsupported_required_agent_integrations = Vec::new();
    for integration in &manifest.agent_integrations {
        if supported_adapters.contains(&integration.adapter) {
            enabled_agent_integrations.push(integration.id.clone());
        } else if integration.required {
            unsupported_required_agent_integrations.push(integration.id.clone());
        } else {
            ignored_optional_agent_integrations.push(integration.id.clone());
        }
    }
    if !unsupported_required_agent_integrations.is_empty() {
        return Ok(
            PluginCompatibilityOutcomeV2::UnsupportedRequiredAgentIntegrations {
                integrations: unsupported_required_agent_integrations,
            },
        );
    }

    let supported_permissions = host.permission_kinds.iter().collect::<BTreeSet<_>>();
    let unsupported_permissions = manifest
        .permissions
        .iter()
        .filter(|permission| !supported_permissions.contains(&permission.kind))
        .map(|permission| permission.kind.clone())
        .collect::<Vec<_>>();
    if !unsupported_permissions.is_empty() {
        return Ok(PluginCompatibilityOutcomeV2::UnsupportedPermissions {
            permissions: unsupported_permissions,
        });
    }

    Ok(PluginCompatibilityOutcomeV2::Supported {
        negotiated_host_api_version,
        contributions,
        ignored_optional_contributions,
        enabled_agent_integrations,
        ignored_optional_agent_integrations,
    })
}
