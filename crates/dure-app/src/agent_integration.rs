use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentIntegrationIdV2, AgentNativePluginSelectorV2,
    AgentProfileIdV2, AgentTargetIdV2, PhysicalTargetKeyV2, PluginIdV2, PluginManifestV2,
    PluginResourcePathV2, PluginVersionV2,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct AgentEnvironmentTargetV2 {
    pub id: AgentTargetIdV2,
    pub profile_id: AgentProfileIdV2,
    pub adapter: AgentAdapterIdV2,
    pub profile_root_key: PhysicalTargetKeyV2,
    pub plugin_store_key: PhysicalTargetKeyV2,
    pub scope: AgentInstallScopeV2,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentIntegrationInstallActionV2 {
    PreparePackage {
        integration_id: AgentIntegrationIdV2,
        adapter: AgentAdapterIdV2,
        resource: PluginResourcePathV2,
        selector: AgentNativePluginSelectorV2,
        plugin_store_key: PhysicalTargetKeyV2,
        target_ids: Vec<AgentTargetIdV2>,
    },
    RegisterProfile {
        integration_id: AgentIntegrationIdV2,
        adapter: AgentAdapterIdV2,
        profile_root_key: PhysicalTargetKeyV2,
        plugin_store_key: PhysicalTargetKeyV2,
        resource: PluginResourcePathV2,
        selector: AgentNativePluginSelectorV2,
        scope: AgentInstallScopeV2,
        target_ids: Vec<AgentTargetIdV2>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct AgentIntegrationInstallPlanV2 {
    pub plugin_id: PluginIdV2,
    pub plugin_version: PluginVersionV2,
    pub actions: Vec<AgentIntegrationInstallActionV2>,
    #[serde(default)]
    pub skipped_optional_integrations: Vec<AgentIntegrationIdV2>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentIntegrationPlanErrorV2 {
    InvalidManifest {
        message: String,
    },
    DuplicateTarget {
        target_id: AgentTargetIdV2,
    },
    InconsistentPhysicalTarget {
        profile_root_key: PhysicalTargetKeyV2,
    },
    RequiredTargetUnavailable {
        integration_id: AgentIntegrationIdV2,
    },
    DuplicateReceiptEffect,
}

impl fmt::Display for AgentIntegrationPlanErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidManifest { message } => {
                write!(formatter, "invalid plugin manifest: {message}")
            }
            Self::DuplicateTarget { target_id } => {
                write!(
                    formatter,
                    "agent environment target {} is duplicated",
                    target_id.as_str()
                )
            }
            Self::InconsistentPhysicalTarget { profile_root_key } => write!(
                formatter,
                "physical profile root {} resolves to inconsistent plugin stores or install scopes",
                profile_root_key.as_str()
            ),
            Self::RequiredTargetUnavailable { integration_id } => write!(
                formatter,
                "required agent integration {} has no matching target",
                integration_id.as_str()
            ),
            Self::DuplicateReceiptEffect => {
                formatter.write_str("agent integration receipt contains a duplicate effect")
            }
        }
    }
}

impl Error for AgentIntegrationPlanErrorV2 {}

pub fn plan_agent_integration_install(
    manifest: &PluginManifestV2,
    targets: &[AgentEnvironmentTargetV2],
) -> Result<AgentIntegrationInstallPlanV2, AgentIntegrationPlanErrorV2> {
    manifest
        .validate()
        .map_err(|error| AgentIntegrationPlanErrorV2::InvalidManifest {
            message: error.to_string(),
        })?;
    validate_targets(targets)?;

    let mut actions = Vec::new();
    let mut skipped_optional_integrations = Vec::new();
    for integration in &manifest.agent_integrations {
        let matching_targets = targets
            .iter()
            .filter(|target| target.adapter == integration.adapter)
            .collect::<Vec<_>>();
        if matching_targets.is_empty() {
            if integration.required {
                return Err(AgentIntegrationPlanErrorV2::RequiredTargetUnavailable {
                    integration_id: integration.id.clone(),
                });
            }
            skipped_optional_integrations.push(integration.id.clone());
            continue;
        }

        let mut package_targets = BTreeMap::<PhysicalTargetKeyV2, Vec<AgentTargetIdV2>>::new();
        let mut profile_targets = BTreeMap::<
            (
                PhysicalTargetKeyV2,
                AgentInstallScopeV2,
                PhysicalTargetKeyV2,
            ),
            Vec<AgentTargetIdV2>,
        >::new();
        for target in matching_targets {
            package_targets
                .entry(target.plugin_store_key.clone())
                .or_default()
                .push(target.id.clone());
            profile_targets
                .entry((
                    target.profile_root_key.clone(),
                    target.scope.clone(),
                    target.plugin_store_key.clone(),
                ))
                .or_default()
                .push(target.id.clone());
        }

        for (plugin_store_key, mut target_ids) in package_targets {
            target_ids.sort();
            actions.push(AgentIntegrationInstallActionV2::PreparePackage {
                integration_id: integration.id.clone(),
                adapter: integration.adapter.clone(),
                resource: integration.resource.clone(),
                selector: integration.selector.clone(),
                plugin_store_key,
                target_ids,
            });
        }
        for ((profile_root_key, scope, plugin_store_key), mut target_ids) in profile_targets {
            target_ids.sort();
            actions.push(AgentIntegrationInstallActionV2::RegisterProfile {
                integration_id: integration.id.clone(),
                adapter: integration.adapter.clone(),
                profile_root_key,
                plugin_store_key,
                resource: integration.resource.clone(),
                selector: integration.selector.clone(),
                scope,
                target_ids,
            });
        }
    }

    Ok(AgentIntegrationInstallPlanV2 {
        plugin_id: manifest.id.clone(),
        plugin_version: manifest.version.clone(),
        actions,
        skipped_optional_integrations,
    })
}

fn validate_targets(
    targets: &[AgentEnvironmentTargetV2],
) -> Result<(), AgentIntegrationPlanErrorV2> {
    let mut ids = BTreeSet::new();
    let mut physical_profiles = BTreeMap::new();
    for target in targets {
        if !ids.insert(&target.id) {
            return Err(AgentIntegrationPlanErrorV2::DuplicateTarget {
                target_id: target.id.clone(),
            });
        }
        let key = (&target.adapter, &target.profile_root_key);
        let physical_target = (&target.plugin_store_key, &target.scope);
        match physical_profiles.insert(key, physical_target) {
            Some(existing) if existing != physical_target => {
                return Err(AgentIntegrationPlanErrorV2::InconsistentPhysicalTarget {
                    profile_root_key: target.profile_root_key.clone(),
                });
            }
            _ => {}
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentIntegrationEffectOwnershipV2 {
    CreatedByOperation,
    PreexistingDureOwned,
    PreexistingExternal,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct AgentIntegrationEffectReceiptV2 {
    pub action: AgentIntegrationInstallActionV2,
    pub ownership: AgentIntegrationEffectOwnershipV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct AgentIntegrationInstallReceiptV2 {
    pub plugin_id: PluginIdV2,
    pub plugin_version: PluginVersionV2,
    pub effects: Vec<AgentIntegrationEffectReceiptV2>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentIntegrationUninstallActionV2 {
    UnregisterProfile {
        integration_id: AgentIntegrationIdV2,
        adapter: AgentAdapterIdV2,
        profile_root_key: PhysicalTargetKeyV2,
        plugin_store_key: PhysicalTargetKeyV2,
        selector: AgentNativePluginSelectorV2,
        scope: AgentInstallScopeV2,
        target_ids: Vec<AgentTargetIdV2>,
    },
    RemoveOwnedPackageIfUnleased {
        integration_id: AgentIntegrationIdV2,
        adapter: AgentAdapterIdV2,
        resource: PluginResourcePathV2,
        selector: AgentNativePluginSelectorV2,
        plugin_store_key: PhysicalTargetKeyV2,
        target_ids: Vec<AgentTargetIdV2>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct AgentIntegrationUninstallPlanV2 {
    pub plugin_id: PluginIdV2,
    pub plugin_version: PluginVersionV2,
    pub actions: Vec<AgentIntegrationUninstallActionV2>,
}

pub fn plan_agent_integration_uninstall(
    receipt: &AgentIntegrationInstallReceiptV2,
) -> Result<AgentIntegrationUninstallPlanV2, AgentIntegrationPlanErrorV2> {
    let mut unique_effects = BTreeSet::new();
    for effect in &receipt.effects {
        if !unique_effects.insert(&effect.action) {
            return Err(AgentIntegrationPlanErrorV2::DuplicateReceiptEffect);
        }
    }
    let actions = receipt
        .effects
        .iter()
        .rev()
        .filter(|effect| effect.ownership == AgentIntegrationEffectOwnershipV2::CreatedByOperation)
        .map(|effect| match &effect.action {
            AgentIntegrationInstallActionV2::PreparePackage {
                integration_id,
                adapter,
                resource,
                selector,
                plugin_store_key,
                target_ids,
            } => AgentIntegrationUninstallActionV2::RemoveOwnedPackageIfUnleased {
                integration_id: integration_id.clone(),
                adapter: adapter.clone(),
                resource: resource.clone(),
                selector: selector.clone(),
                plugin_store_key: plugin_store_key.clone(),
                target_ids: target_ids.clone(),
            },
            AgentIntegrationInstallActionV2::RegisterProfile {
                integration_id,
                adapter,
                profile_root_key,
                plugin_store_key,
                selector,
                scope,
                target_ids,
                ..
            } => AgentIntegrationUninstallActionV2::UnregisterProfile {
                integration_id: integration_id.clone(),
                adapter: adapter.clone(),
                profile_root_key: profile_root_key.clone(),
                plugin_store_key: plugin_store_key.clone(),
                selector: selector.clone(),
                scope: scope.clone(),
                target_ids: target_ids.clone(),
            },
        })
        .collect();
    Ok(AgentIntegrationUninstallPlanV2 {
        plugin_id: receipt.plugin_id.clone(),
        plugin_version: receipt.plugin_version.clone(),
        actions,
    })
}
