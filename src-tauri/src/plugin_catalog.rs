use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
#[cfg(test)]
use std::sync::Arc;

use fs2::FileExt;
use dure_app::{
    canonicalize_plugin_permission_plan, negotiate_plugin_manifest, AgentAdapterIdV2,
    AgentAdapterSupportV2, ContractVersionRangeV2, ContributionDescriptorV2,
    ContributionFamilyIdV2, ContributionFamilySupportV2, ContributionIdV2,
    IssueTrackerOperationV1, IssueTrackerProviderV1, NegotiatedContributionV2, PermissionKindIdV2,
    PluginBundledPermissionPackageV2, PluginCompatibilityOutcomeV2, PluginHostContractV2,
    PluginIdV2, PluginIssueTrackerDefaultQueryV1, PluginManifestV2,
    PluginPackageCandidateIdV2, PluginPackageRegistryV2, PluginPackageSourceCandidateV2,
    PluginPackageSourceErrorV2, PluginPackageSourceIdV2, PluginPackageSourceRegistrationV2,
    PluginPackageSourceV2, PluginPermissionHostPolicyV2, PluginPermissionKindPolicyV2,
    PluginPermissionParameterPolicyV2, PluginPermissionPlanV2, PluginSettingDefinitionV1,
    PluginSettingKeyV1, PluginSettingScopeV1, PluginSettingValueV1, PluginSettingsSchemaV1,
    PluginVersionV2, PluginViewKindV1, PluginViewsV1, PluginWorkflowContributionV1,
    PluginWorkspaceIdentityV2, RegisteredPluginPackageV2,
};
#[cfg(test)]
use dure_app::{
    InMemoryPluginPackageSourceV2, PluginPackageCatalogSnapshotV2, PluginResourcePathV2,
};
use crate::plugin_bundled_package::bundled_package_candidates;
use crate::plugin_issue_tracker::DureIssueTrackerState;
use crate::plugin_installed_package_source::InstalledPluginPackageSourceV2;
#[cfg(test)]
use crate::plugin_installed_package_source::INSTALLED_PLUGIN_PACKAGES_DIRECTORY;
use crate::plugin_permission_commands::DurePluginPermissionRuntime;
#[cfg(test)]
use crate::plugin_bundled_package::{
    bundled_contribution_resources, BUNDLED_BEADS_ISSUE_TRACKER, BUNDLED_BEADS_MANIFEST,
    BUNDLED_BEADS_SETTINGS, BUNDLED_BEADS_VIEWS, BUNDLED_CORE_MANIFEST,
    BUNDLED_CORE_WORKFLOWS, bundled_core_contribution_resources,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

const BUNDLED_PLUGIN_SOURCE_ID: &str = "dure.bundled";
const BUNDLED_PLUGIN_AUTHORITY_ID: &str = "dure.release";
const INSTALLED_PLUGIN_SOURCE_ID: &str = "dure.installed";
#[cfg(test)]
use crate::plugin_bundled_package::{BUNDLED_BEADS_CANDIDATE_ID, BUNDLED_CORE_CANDIDATE_ID};
const PLUGIN_CATALOG_SCHEMA_VERSION_V2: u16 = 2;
const SUPPORTED_WORKFLOW_KINDS_V1: &[&str] = &["workflow.delegate_once"];
const SETTINGS_DIRECTORY: &str = "plugin-settings";
const SETTINGS_LOCK_FILE: &str = ".settings.lock";
const MAX_SETTINGS_BYTES: u64 = 64 * 1024;
const SETTINGS_DOCUMENT_SCHEMA_VERSION: u16 = 1;
const PLUGIN_SETTINGS_EVENT: &str = "dure://plugin/settings";

static BUNDLED_PLUGIN_REGISTRY: OnceLock<PluginPackageRegistryV2> = OnceLock::new();

pub struct DurePluginState {
    settings_lock: Mutex<()>,
    registry: PluginPackageRegistryV2,
}

impl Default for DurePluginState {
    fn default() -> Self {
        Self::from_registry(build_bundled_plugin_registry())
    }
}

impl DurePluginState {
    fn from_registry(registry: PluginPackageRegistryV2) -> Self {
        Self {
            settings_lock: Mutex::new(()),
            registry,
        }
    }

    fn registry(&self) -> &PluginPackageRegistryV2 {
        &self.registry
    }

    pub(crate) fn from_app_root(app_root: &Path) -> Self {
        Self::from_registry(build_production_plugin_registry(app_root))
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurePluginDistribution {
    Bundled,
    Installed,
}

#[derive(Clone, Copy)]
struct DurePluginCatalogPolicy {
    distribution: DurePluginDistribution,
    installed: bool,
    removable: bool,
    allows_native_agent_integrations: bool,
}

fn catalog_policy(source_id: &PluginPackageSourceIdV2) -> Option<DurePluginCatalogPolicy> {
    match source_id.as_str() {
        BUNDLED_PLUGIN_SOURCE_ID => Some(DurePluginCatalogPolicy {
            distribution: DurePluginDistribution::Bundled,
            installed: true,
            removable: false,
            allows_native_agent_integrations: true,
        }),
        INSTALLED_PLUGIN_SOURCE_ID => Some(DurePluginCatalogPolicy {
            distribution: DurePluginDistribution::Installed,
            installed: true,
            removable: true,
            allows_native_agent_integrations: false,
        }),
        _ => None,
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct DurePluginCatalogEntry {
    pub manifest: PluginManifestV2,
    pub compatibility: PluginCompatibilityOutcomeV2,
    pub distribution: DurePluginDistribution,
    pub installed: bool,
    pub removable: bool,
    pub settings_schema: PluginSettingsSchemaV1,
    pub issue_tracker_contributions: Vec<DureIssueTrackerCatalogContribution>,
    pub view_contributions: Vec<DureViewsCatalogContribution>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurePluginCatalogCandidateIdentityV2 {
    pub source_id: String,
    pub candidate_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurePluginSettingsTargetV2 {
    pub identity: DurePluginCatalogCandidateIdentityV2,
    pub plugin_id: PluginIdV2,
    pub version: PluginVersionV2,
    pub contribution_id: ContributionIdV2,
}

#[derive(Clone, Debug, Serialize)]
pub struct DureSettingsCatalogContributionV2 {
    pub target: DurePluginSettingsTargetV2,
    pub contribution_id: ContributionIdV2,
    pub schema: PluginSettingsSchemaV1,
}

#[derive(Clone, Debug, Serialize)]
pub struct DurePluginCatalogEntryV2 {
    pub manifest: PluginManifestV2,
    pub compatibility: PluginCompatibilityOutcomeV2,
    pub distribution: DurePluginDistribution,
    pub installed: bool,
    pub removable: bool,
    pub settings_contribution: Option<DureSettingsCatalogContributionV2>,
    pub issue_tracker_contributions: Vec<DureIssueTrackerCatalogContribution>,
    pub view_contributions: Vec<DureViewsCatalogContribution>,
    pub workflow_contributions: Vec<DureWorkflowCatalogContributionV1>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DurePluginCatalogConflictCandidateV2 {
    pub source_id: String,
    pub candidate_id: String,
    pub version: PluginVersionV2,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DurePluginCatalogRejectionV2 {
    SourceRejected,
    CatalogPolicyUnavailable,
    Incompatible {
        compatibility: PluginCompatibilityOutcomeV2,
    },
    InvalidContribution {
        contribution_id: Option<ContributionIdV2>,
        family: Option<ContributionFamilyIdV2>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DurePluginCatalogOutcomeV2 {
    Available {
        identity: DurePluginCatalogCandidateIdentityV2,
        entry: Box<DurePluginCatalogEntryV2>,
    },
    Rejected {
        identity: DurePluginCatalogCandidateIdentityV2,
        manifest: Option<Box<PluginManifestV2>>,
        reason: DurePluginCatalogRejectionV2,
    },
    Conflict {
        plugin_id: PluginIdV2,
        candidates: Vec<DurePluginCatalogConflictCandidateV2>,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct DurePluginCatalogSnapshotV2 {
    pub schema_version: u16,
    pub outcomes: Vec<DurePluginCatalogOutcomeV2>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DureIssueTrackerCatalogContribution {
    pub contribution_id: ContributionIdV2,
    pub provider: IssueTrackerProviderV1,
}

#[derive(Clone, Debug, Serialize)]
pub struct DureViewsCatalogContribution {
    pub contribution_id: ContributionIdV2,
    pub views: PluginViewsV1,
}

#[derive(Clone, Debug, Serialize)]
pub struct DureWorkflowCatalogContributionV1 {
    pub contribution_id: ContributionIdV2,
    pub workflow: PluginWorkflowContributionV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DurePluginSettingsSnapshot {
    pub target: DurePluginSettingsTargetV2,
    pub scope: PluginSettingScopeV1,
    pub scope_key: Option<String>,
    pub values: BTreeMap<PluginSettingKeyV1, PluginSettingValueV1>,
    #[serde(default = "zero_settings_revision")]
    pub settings_revision: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub agent_claim_policy_epochs: BTreeMap<String, u32>,
}

fn zero_settings_revision() -> String {
    "0".to_owned()
}

#[derive(Debug, Deserialize, Serialize)]
struct StoredSettingsDocument {
    schema_version: u16,
    revision: u64,
    values: BTreeMap<PluginSettingKeyV1, PluginSettingValueV1>,
}

#[derive(Debug)]
struct StoredSettings {
    revision: u64,
    values: BTreeMap<PluginSettingKeyV1, PluginSettingValueV1>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ResolvedSettingsScope {
    scope_key: Option<String>,
    canonical_workspace_root: Option<PathBuf>,
}

fn host_contract() -> PluginHostContractV2 {
    PluginHostContractV2 {
        host_api: ContractVersionRangeV2::new(1, 2),
        contribution_families: vec![
            ContributionFamilySupportV2 {
                family: ContributionFamilyIdV2::new("dure.issue-tracker")
                    .expect("host family is static and valid"),
                api: ContractVersionRangeV2::new(1, 1),
            },
            ContributionFamilySupportV2 {
                family: ContributionFamilyIdV2::new("dure.settings")
                    .expect("host family is static and valid"),
                api: ContractVersionRangeV2::new(1, 1),
            },
            ContributionFamilySupportV2 {
                family: ContributionFamilyIdV2::new("dure.views")
                    .expect("host family is static and valid"),
                api: ContractVersionRangeV2::new(1, 1),
            },
            ContributionFamilySupportV2 {
                family: ContributionFamilyIdV2::new("dure.workflows")
                    .expect("host family is static and valid"),
                api: ContractVersionRangeV2::new(1, 1),
            },
        ],
        agent_adapters: ["codex", "claude"]
            .into_iter()
            .map(|adapter| AgentAdapterSupportV2 {
                adapter: AgentAdapterIdV2::new(adapter).expect("host adapter is static and valid"),
            })
            .collect(),
        permission_kinds: vec![
            PermissionKindIdV2::new("dure.issue-tracker.read")
                .expect("host permission is static and valid"),
            PermissionKindIdV2::new("dure.repository-landing.manage")
                .expect("host permission is static and valid"),
            PermissionKindIdV2::new("dure.ui.contribute")
                .expect("host permission is static and valid"),
        ],
    }
}

struct BundledPluginPackageSourceV2;

impl PluginPackageSourceV2 for BundledPluginPackageSourceV2 {
    fn load(&self) -> Vec<PluginPackageSourceCandidateV2> {
        bundled_package_candidates()
        .into_iter()
        .map(|(candidate_id, package)| {
            let candidate_id = PluginPackageCandidateIdV2::new(candidate_id)
                .expect("bundled candidate ID is static and valid");
            match package {
                Ok(package) => PluginPackageSourceCandidateV2::accepted(candidate_id, package),
                Err(error) => PluginPackageSourceCandidateV2::rejected(
                    candidate_id,
                    PluginPackageSourceErrorV2::new(error.to_string()),
                ),
            }
        })
        .collect()
    }
}

fn build_bundled_plugin_registry() -> PluginPackageRegistryV2 {
    let source = BundledPluginPackageSourceV2;
    let registration = PluginPackageSourceRegistrationV2::trusted_bundled(
        PluginPackageSourceIdV2::new(BUNDLED_PLUGIN_SOURCE_ID)
            .expect("bundled source ID is static and valid"),
        &source,
        BUNDLED_PLUGIN_AUTHORITY_ID,
    )
    .expect("bundled authority ID is static and valid");
    PluginPackageRegistryV2::from_sources(&[registration])
}

fn build_production_plugin_registry(app_root: &Path) -> PluginPackageRegistryV2 {
    let bundled_source = BundledPluginPackageSourceV2;
    let installed_source = InstalledPluginPackageSourceV2::under_app_root(app_root);
    let bundled_registration = PluginPackageSourceRegistrationV2::trusted_bundled(
        PluginPackageSourceIdV2::new(BUNDLED_PLUGIN_SOURCE_ID)
            .expect("bundled source ID is static and valid"),
        &bundled_source,
        BUNDLED_PLUGIN_AUTHORITY_ID,
    )
    .expect("bundled authority ID is static and valid");
    let installed_registration = PluginPackageSourceRegistrationV2::new(
        PluginPackageSourceIdV2::new(INSTALLED_PLUGIN_SOURCE_ID)
            .expect("installed source ID is static and valid"),
        &installed_source,
    );
    PluginPackageRegistryV2::from_sources(&[bundled_registration, installed_registration])
}

pub(crate) fn bundled_plugin_registry() -> &'static PluginPackageRegistryV2 {
    BUNDLED_PLUGIN_REGISTRY.get_or_init(build_bundled_plugin_registry)
}

fn permission_parameter_policy(
    parameter: &str,
    allowed_values: &[&str],
) -> Result<PluginPermissionParameterPolicyV2, String> {
    PluginPermissionParameterPolicyV2::try_new(
        parameter,
        true,
        allowed_values
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
    )
    .map_err(|error| error.to_string())
}

fn permission_policy() -> Result<PluginPermissionHostPolicyV2, String> {
    PluginPermissionHostPolicyV2::try_new(vec![
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.issue-tracker.read")
                .expect("host permission is static and valid"),
            vec![permission_parameter_policy(
                "operations",
                &["activate", "human", "list", "ready", "show", "watch"],
            )?],
        )
        .map_err(|error| error.to_string())?,
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.repository-landing.manage")
                .expect("host permission is static and valid"),
            Vec::new(),
        )
        .map_err(|error| error.to_string())?,
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.ui.contribute")
                .expect("host permission is static and valid"),
            vec![permission_parameter_policy(
                "surfaces",
                &[
                    "agent_pane_claim_status",
                    "primary_sidebar",
                    "secondary_sidebar",
                ],
            )?],
        )
        .map_err(|error| error.to_string())?,
    ])
    .map_err(|error| error.to_string())
}

pub(crate) fn bundled_permission_plan(
    plugin_id: &PluginIdV2,
    workspace_identity: PluginWorkspaceIdentityV2,
) -> Result<PluginPermissionPlanV2, String> {
    let package = bundled_plugin_registry()
        .package(plugin_id)
        .map_err(|error| error.to_string())?;
    let package = PluginBundledPermissionPackageV2::from_registered(package)
        .map_err(|error| error.to_string())?;
    canonicalize_plugin_permission_plan(
        &package,
        &host_contract(),
        workspace_identity,
        &permission_policy()?,
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
pub(crate) fn bundled_permission_plan_with_exact_review_bytes(
    workspace_identity: PluginWorkspaceIdentityV2,
    plugin_id: &PluginIdV2,
    target_bytes: usize,
) -> Result<PluginPermissionPlanV2, String> {
    const MAX_RESOURCE_PATH_BYTES: usize = 512;

    fn build(
        workspace_identity: &PluginWorkspaceIdentityV2,
        plugin_id: &PluginIdV2,
        padding_lengths: &[usize],
    ) -> Result<PluginPermissionPlanV2, String> {
        let mut manifest = serde_json::from_slice::<PluginManifestV2>(BUNDLED_BEADS_MANIFEST)
            .map_err(|error| error.to_string())?;
        manifest.id = plugin_id.clone();
        manifest.activation.clear();
        let mut contribution = manifest
            .contributions
            .into_iter()
            .next()
            .ok_or_else(|| "bundled fixture has no contribution".to_owned())?;
        contribution.id = ContributionIdV2::new(format!("{}.x", plugin_id.as_str()))
            .map_err(|error| error.to_string())?;
        manifest.contributions = vec![contribution];
        manifest.agent_integrations.clear();
        manifest.permissions.clear();
        let mut resources = bundled_contribution_resources();
        for (index, padding_length) in padding_lengths.iter().copied().enumerate() {
            let prefix = format!("./review-padding/{index:03}-");
            let resource = PluginResourcePathV2::new(format!(
                "{prefix}{}",
                "x".repeat(padding_length)
            ))
            .map_err(|error| error.to_string())?;
            resources.insert(resource, Arc::from(&b"bounded-review-padding"[..]));
        }
        let package = PluginPackageCatalogSnapshotV2::try_new(manifest, resources)
            .map_err(|error| error.to_string())?;
        let source = InMemoryPluginPackageSourceV2::new(vec![package]);
        let registration = PluginPackageSourceRegistrationV2::trusted_bundled(
            PluginPackageSourceIdV2::new("dure.bundled.review-capacity")
                .expect("test source ID is static and valid"),
            &source,
            BUNDLED_PLUGIN_AUTHORITY_ID,
        )
        .map_err(|error| error.to_string())?;
        let registry = PluginPackageRegistryV2::from_sources(&[registration]);
        let package = registry
            .package(plugin_id)
            .map_err(|error| error.to_string())?;
        let package = PluginBundledPermissionPackageV2::from_registered(package)
            .map_err(|error| error.to_string())?;
        canonicalize_plugin_permission_plan(
            &package,
            &host_contract(),
            workspace_identity.clone(),
            &permission_policy()?,
        )
        .map_err(|error| error.to_string())
    }

    for resource_count in 1..=32 {
        let prefixes = (0..resource_count)
            .map(|index| format!("./review-padding/{index:03}-").len())
            .collect::<Vec<_>>();
        let minimum = vec![1; resource_count];
        let minimum_plan = build(&workspace_identity, plugin_id, &minimum).map_err(|error| {
            format!("cannot build minimum projection with {resource_count} resources: {error}")
        })?;
        let minimum_bytes = serde_json::to_vec(minimum_plan.review_projection())
            .map_err(|error| error.to_string())?
            .len();
        if minimum_bytes > target_bytes {
            break;
        }
        let available_padding = prefixes
            .iter()
            .map(|prefix_bytes| MAX_RESOURCE_PATH_BYTES - prefix_bytes - 1)
            .sum::<usize>();
        let required_padding = target_bytes - minimum_bytes;
        if required_padding > available_padding {
            continue;
        }
        let mut remaining = required_padding;
        let mut padding_lengths = minimum;
        for (padding_length, prefix_bytes) in padding_lengths.iter_mut().zip(prefixes) {
            let added = remaining.min(MAX_RESOURCE_PATH_BYTES - prefix_bytes - 1);
            *padding_length += added;
            remaining -= added;
        }
        let plan = build(&workspace_identity, plugin_id, &padding_lengths)?;
        let actual_bytes = serde_json::to_vec(plan.review_projection())
            .map_err(|error| error.to_string())?
            .len();
        if actual_bytes == target_bytes {
            return Ok(plan);
        }
        return Err(format!(
            "review projection padding expected {target_bytes} bytes, found {actual_bytes}"
        ));
    }
    Err(format!(
        "could not construct a canonical {target_bytes}-byte review projection"
    ))
}

fn negotiated_contributions(
    manifest: &PluginManifestV2,
) -> Result<(PluginCompatibilityOutcomeV2, Vec<NegotiatedContributionV2>), String> {
    let compatibility =
        negotiate_plugin_manifest(manifest, &host_contract()).map_err(|error| error.to_string())?;
    let PluginCompatibilityOutcomeV2::Supported { contributions, .. } = &compatibility else {
        return Err(format!(
            "plugin {} is incompatible with this Dure build",
            manifest.id.as_str()
        ));
    };
    Ok((compatibility.clone(), contributions.clone()))
}

#[derive(Debug)]
struct CatalogEntryRejection {
    reason: Box<DurePluginCatalogRejectionV2>,
    message: String,
}

impl CatalogEntryRejection {
    fn catalog_policy(source_id: &PluginPackageSourceIdV2) -> Self {
        Self {
            reason: Box::new(DurePluginCatalogRejectionV2::CatalogPolicyUnavailable),
            message: format!(
                "plugin package source {} has no catalog policy",
                source_id.as_str()
            ),
        }
    }

    fn incompatible(
        plugin_id: &PluginIdV2,
        compatibility: PluginCompatibilityOutcomeV2,
    ) -> Self {
        Self {
            reason: Box::new(DurePluginCatalogRejectionV2::Incompatible {
                compatibility: compatibility.clone(),
            }),
            message: format!(
                "plugin {} is incompatible with this Dure build: {compatibility:?}",
                plugin_id.as_str()
            ),
        }
    }

    fn invalid_contribution(
        contribution_id: Option<ContributionIdV2>,
        family: Option<ContributionFamilyIdV2>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            reason: Box::new(DurePluginCatalogRejectionV2::InvalidContribution {
                contribution_id,
                family,
            }),
            message: message.into(),
        }
    }
}

pub(crate) fn bundled_contribution_resource(
    plugin_id: &str,
    contribution_id: &str,
    expected_family: &str,
) -> Result<(ContributionDescriptorV2, &'static [u8]), String> {
    let plugin_id = PluginIdV2::new(plugin_id).map_err(|error| error.to_string())?;
    let contribution_id =
        ContributionIdV2::new(contribution_id).map_err(|error| error.to_string())?;
    let expected_family =
        ContributionFamilyIdV2::new(expected_family).map_err(|error| error.to_string())?;
    let registry = bundled_plugin_registry();
    let package = registry
        .package(&plugin_id)
        .map_err(|error| error.to_string())?;
    let (_, negotiated) = negotiated_contributions(package.manifest())?;
    if !negotiated.iter().any(|candidate| {
        candidate.id == contribution_id && candidate.family == expected_family
    }) {
        return Err(format!(
            "contribution {} is not enabled for plugin {}",
            contribution_id.as_str(),
            plugin_id.as_str()
        ));
    }
    let contribution = registry
        .declared_contribution_resource(&plugin_id, &contribution_id, &expected_family)
        .map_err(|error| error.to_string())?;
    Ok((contribution.descriptor().clone(), contribution.bytes()))
}

fn contribution_resources<'a>(
    registry: &'a PluginPackageRegistryV2,
    plugin_id: &PluginIdV2,
    negotiated: &[NegotiatedContributionV2],
    family: &ContributionFamilyIdV2,
) -> Result<Vec<(ContributionIdV2, &'a [u8])>, CatalogEntryRejection> {
    negotiated
        .iter()
        .filter(|contribution| contribution.family == *family)
        .map(|contribution| {
            let resource = registry
                .declared_contribution_resource(plugin_id, &contribution.id, family)
                .map_err(|error| {
                    CatalogEntryRejection::invalid_contribution(
                        Some(contribution.id.clone()),
                        Some(family.clone()),
                        error.to_string(),
                    )
                })?;
            Ok((resource.descriptor().id.clone(), resource.bytes()))
        })
        .collect()
}

fn default_query_operation(query: &PluginIssueTrackerDefaultQueryV1) -> IssueTrackerOperationV1 {
    match query {
        PluginIssueTrackerDefaultQueryV1::Human => IssueTrackerOperationV1::Human,
        PluginIssueTrackerDefaultQueryV1::List => IssueTrackerOperationV1::List,
        PluginIssueTrackerDefaultQueryV1::Ready => IssueTrackerOperationV1::Ready,
    }
}

fn configured_query_operation(value: &str) -> Option<IssueTrackerOperationV1> {
    match value {
        "human" => Some(IssueTrackerOperationV1::Human),
        "list" => Some(IssueTrackerOperationV1::List),
        "ready" => Some(IssueTrackerOperationV1::Ready),
        _ => None,
    }
}

fn validate_issue_tracker_view_settings(
    view_id: &str,
    provider: &IssueTrackerProviderV1,
    settings_schema: Option<&PluginSettingsSchemaV1>,
    default_query_setting_key: Option<&PluginSettingKeyV1>,
    watch_interval_setting_key: Option<&PluginSettingKeyV1>,
) -> Result<(), String> {
    if let Some(key) = default_query_setting_key {
        let valid = settings_schema.is_some_and(|settings_schema| {
            settings_schema.settings.iter().any(|definition| {
                matches!(
                    definition,
                    PluginSettingDefinitionV1::Choice {
                        key: candidate,
                        scope: PluginSettingScopeV1::Workspace,
                        options,
                        ..
                    } if candidate == key
                        && options.iter().all(|option| configured_query_operation(&option.value)
                            .is_some_and(|operation| provider.supports(operation)))
                )
            })
        });
        if !valid {
            return Err(format!(
                "view {view_id} default query setting must reference a workspace choice containing only supported queries"
            ));
        }
    }
    if let Some(key) = watch_interval_setting_key {
        let valid = settings_schema.is_some_and(|settings_schema| {
            settings_schema.settings.iter().any(|definition| {
                matches!(
                    definition,
                    PluginSettingDefinitionV1::Integer {
                        key: candidate,
                        scope: PluginSettingScopeV1::Workspace,
                        minimum,
                        maximum,
                        ..
                    } if candidate == key && *minimum >= 5 && *maximum <= 300
                )
            })
        });
        if !valid {
            return Err(format!(
                "view {view_id} watch interval setting must reference a workspace integer bounded within 5..=300 seconds"
            ));
        }
    }
    Ok(())
}

fn package_identity(
    package: &RegisteredPluginPackageV2,
) -> DurePluginCatalogCandidateIdentityV2 {
    DurePluginCatalogCandidateIdentityV2 {
        source_id: package.source_id().as_str().to_owned(),
        candidate_id: package.candidate_id().as_str().to_owned(),
    }
}

fn package_settings_target(
    package: &RegisteredPluginPackageV2,
    contribution_id: ContributionIdV2,
) -> DurePluginSettingsTargetV2 {
    DurePluginSettingsTargetV2 {
        identity: package_identity(package),
        plugin_id: package.manifest().id.clone(),
        version: package.manifest().version.clone(),
        contribution_id,
    }
}

fn catalog_entry_v2(
    registry: &PluginPackageRegistryV2,
    package: &RegisteredPluginPackageV2,
) -> Result<DurePluginCatalogEntryV2, CatalogEntryRejection> {
    let policy = catalog_policy(package.source_id())
        .ok_or_else(|| CatalogEntryRejection::catalog_policy(package.source_id()))?;
    let manifest = package.manifest();
    if !policy.allows_native_agent_integrations && !manifest.agent_integrations.is_empty() {
        return Err(CatalogEntryRejection::invalid_contribution(
            None,
            None,
            format!(
                "plugin package source {} does not allow native agent integrations",
                package.source_id().as_str()
            ),
        ));
    }
    let compatibility = negotiate_plugin_manifest(manifest, &host_contract()).map_err(|error| {
        CatalogEntryRejection::invalid_contribution(None, None, error.to_string())
    })?;
    let negotiated = match &compatibility {
        PluginCompatibilityOutcomeV2::Supported { contributions, .. } => contributions.clone(),
        _ => {
            return Err(CatalogEntryRejection::incompatible(
                &manifest.id,
                compatibility,
            ));
        }
    };
    let settings_family = ContributionFamilyIdV2::new("dure.settings")
        .expect("settings family is static and valid");
    let settings_resources = contribution_resources(
        registry,
        &manifest.id,
        &negotiated,
        &settings_family,
    )?;
    let settings_contribution = match settings_resources.as_slice() {
        [] => None,
        [(contribution_id, resource)] => {
            let schema: PluginSettingsSchemaV1 = serde_json::from_slice(resource).map_err(|error| {
                CatalogEntryRejection::invalid_contribution(
                    Some(contribution_id.clone()),
                    Some(settings_family.clone()),
                    error.to_string(),
                )
            })?;
            schema.validate().map_err(|error| {
                CatalogEntryRejection::invalid_contribution(
                    Some(contribution_id.clone()),
                    Some(settings_family.clone()),
                    error.to_string(),
                )
            })?;
            Some(DureSettingsCatalogContributionV2 {
                target: package_settings_target(package, contribution_id.clone()),
                contribution_id: contribution_id.clone(),
                schema,
            })
        }
        _ => {
            return Err(CatalogEntryRejection::invalid_contribution(
                None,
                Some(settings_family.clone()),
                format!(
                    "plugin {} declares multiple negotiated settings contributions without merge semantics",
                    manifest.id.as_str()
                ),
            ));
        }
    };
    let issue_tracker_family = ContributionFamilyIdV2::new("dure.issue-tracker")
        .expect("issue tracker family is static and valid");
    let issue_tracker_contributions = contribution_resources(
        registry,
        &manifest.id,
        &negotiated,
        &issue_tracker_family,
    )?
    .into_iter()
    .map(|(contribution_id, resource)| {
        let provider: IssueTrackerProviderV1 = serde_json::from_slice(resource).map_err(|error| {
            CatalogEntryRejection::invalid_contribution(
                Some(contribution_id.clone()),
                Some(issue_tracker_family.clone()),
                error.to_string(),
            )
        })?;
        provider.validate().map_err(|error| {
            CatalogEntryRejection::invalid_contribution(
                Some(contribution_id.clone()),
                Some(issue_tracker_family.clone()),
                error.to_string(),
            )
        })?;
        Ok(DureIssueTrackerCatalogContribution {
            contribution_id,
            provider,
        })
    })
    .collect::<Result<Vec<_>, CatalogEntryRejection>>()?;
    let views_family =
        ContributionFamilyIdV2::new("dure.views").expect("views family is static and valid");
    let view_contributions = contribution_resources(
        registry,
        &manifest.id,
        &negotiated,
        &views_family,
    )?
    .into_iter()
    .map(|(contribution_id, resource)| {
        let decoded = (|| -> Result<DureViewsCatalogContribution, String> {
            let views: PluginViewsV1 =
                serde_json::from_slice(resource).map_err(|error| error.to_string())?;
            views
                .validate_for_manifest(manifest)
                .map_err(|error| error.to_string())?;
            for view in &views.views {
                let PluginViewKindV1::IssueTracker {
                    provider_contribution_id,
                    default_query,
                    default_query_setting_key,
                    watch_interval_setting_key,
                    agent_claims,
                    // Titles only rename tabs the host already decides to
                    // show; nothing to cross-check against the provider.
                    query_titles: _,
                } = &view.kind;
                let provider = issue_tracker_contributions
                    .iter()
                    .find(|candidate| candidate.contribution_id == *provider_contribution_id)
                    .ok_or_else(|| {
                        format!(
                            "view {} provider contribution is unavailable",
                            view.id.as_str()
                        )
                    })?;
                if !provider.provider.supports(default_query_operation(default_query)) {
                    return Err(format!(
                        "view {} default query is not supported by its provider",
                        view.id.as_str()
                    ));
                }
                let settings_schema = settings_contribution
                    .as_ref()
                    .map(|contribution| &contribution.schema);
                validate_issue_tracker_view_settings(
                    view.id.as_str(),
                    &provider.provider,
                    settings_schema,
                    default_query_setting_key.as_ref(),
                    watch_interval_setting_key.as_ref(),
                )?;
                if let Some(agent_claims) = agent_claims {
                    if provider.provider.agent_binding.is_none()
                        || !provider.provider.supports(IssueTrackerOperationV1::List)
                    {
                        return Err(format!(
                            "view {} agent claims require a provider list operation and agent binding",
                            view.id.as_str()
                        ));
                    }
                    let valid_setting = settings_schema.is_some_and(|settings_schema| {
                        settings_schema.settings.iter().any(|definition| {
                            matches!(
                                definition,
                                PluginSettingDefinitionV1::Boolean { key, scope, .. }
                                    if key == &agent_claims.setting_key
                                        && scope == &PluginSettingScopeV1::Workspace
                            )
                        })
                    });
                    if !valid_setting {
                        return Err(format!(
                            "view {} agent claims setting must reference a workspace boolean",
                            view.id.as_str()
                        ));
                    }
                }
            }
            Ok(DureViewsCatalogContribution {
                contribution_id: contribution_id.clone(),
                views,
            })
        })();
        decoded.map_err(|error| {
            CatalogEntryRejection::invalid_contribution(
                Some(contribution_id),
                Some(views_family.clone()),
                error,
            )
        })
    })
    .collect::<Result<Vec<_>, CatalogEntryRejection>>()?;
    let workflows_family = ContributionFamilyIdV2::new("dure.workflows")
        .expect("workflows family is static and valid");
    let workflow_resources = contribution_resources(
        registry,
        &manifest.id,
        &negotiated,
        &workflows_family,
    )?;
    let mut workflow_kinds = BTreeSet::new();
    let mut workflow_contributions = Vec::with_capacity(workflow_resources.len());
    for (contribution_id, resource) in workflow_resources {
        let workflow: PluginWorkflowContributionV1 = serde_json::from_slice(resource).map_err(
            |error| {
                CatalogEntryRejection::invalid_contribution(
                    Some(contribution_id.clone()),
                    Some(workflows_family.clone()),
                    error.to_string(),
                )
            },
        )?;
        workflow.validate_for_manifest(manifest).map_err(|error| {
            CatalogEntryRejection::invalid_contribution(
                Some(contribution_id.clone()),
                Some(workflows_family.clone()),
                error.to_string(),
            )
        })?;
        if !SUPPORTED_WORKFLOW_KINDS_V1.contains(&workflow.kind.as_str()) {
            return Err(CatalogEntryRejection::invalid_contribution(
                Some(contribution_id),
                Some(workflows_family.clone()),
                format!(
                    "workflow kind {} has no host handler",
                    workflow.kind.as_str()
                ),
            ));
        }
        if !workflow_kinds.insert(workflow.kind.clone()) {
            return Err(CatalogEntryRejection::invalid_contribution(
                Some(contribution_id),
                Some(workflows_family.clone()),
                format!(
                    "plugin {} declares workflow kind {} more than once",
                    manifest.id.as_str(),
                    workflow.kind.as_str()
                ),
            ));
        }
        workflow_contributions.push(DureWorkflowCatalogContributionV1 {
            contribution_id,
            workflow,
        });
    }
    Ok(DurePluginCatalogEntryV2 {
        manifest: manifest.clone(),
        compatibility,
        distribution: policy.distribution,
        installed: policy.installed,
        removable: policy.removable,
        settings_contribution,
        issue_tracker_contributions,
        view_contributions,
        workflow_contributions,
    })
}

fn catalog_snapshot_from_registry(
    registry: &PluginPackageRegistryV2,
) -> DurePluginCatalogSnapshotV2 {
    let mut keyed_outcomes = Vec::new();
    for package in registry.iter_available() {
        let identity = package_identity(package);
        let outcome = match catalog_entry_v2(registry, package) {
            Ok(entry) => DurePluginCatalogOutcomeV2::Available {
                identity,
                entry: Box::new(entry),
            },
            Err(rejection) => DurePluginCatalogOutcomeV2::Rejected {
                identity,
                manifest: Some(Box::new(package.manifest().clone())),
                reason: *rejection.reason,
            },
        };
        keyed_outcomes.push((
            format!(
                "0:{}:{}:{}",
                package.manifest().id.as_str(),
                package.source_id().as_str(),
                package.candidate_id().as_str()
            ),
            outcome,
        ));
    }
    for (plugin_id, candidates) in registry.iter_conflicts() {
        keyed_outcomes.push((
            format!("1:{}", plugin_id.as_str()),
            DurePluginCatalogOutcomeV2::Conflict {
                plugin_id: plugin_id.clone(),
                candidates: candidates
                    .iter()
                    .map(|candidate| DurePluginCatalogConflictCandidateV2 {
                        source_id: candidate.source_id().as_str().to_owned(),
                        candidate_id: candidate.candidate_id().as_str().to_owned(),
                        version: candidate.version().clone(),
                    })
                    .collect(),
            },
        ));
    }
    for rejection in registry.source_rejections() {
        let identity = DurePluginCatalogCandidateIdentityV2 {
            source_id: rejection.source_id().as_str().to_owned(),
            candidate_id: rejection.candidate_id().as_str().to_owned(),
        };
        keyed_outcomes.push((
            format!(
                "2:{}:{}",
                rejection.source_id().as_str(),
                rejection.candidate_id().as_str()
            ),
            DurePluginCatalogOutcomeV2::Rejected {
                identity,
                manifest: None,
                reason: DurePluginCatalogRejectionV2::SourceRejected,
            },
        ));
    }
    keyed_outcomes.sort_by(|left, right| left.0.cmp(&right.0));
    DurePluginCatalogSnapshotV2 {
        schema_version: PLUGIN_CATALOG_SCHEMA_VERSION_V2,
        outcomes: keyed_outcomes
            .into_iter()
            .map(|(_, outcome)| outcome)
            .collect(),
    }
}

fn legacy_catalog_entry(entry: &DurePluginCatalogEntryV2) -> Option<DurePluginCatalogEntry> {
    let settings_schema = entry.settings_contribution.as_ref()?.schema.clone();
    Some(DurePluginCatalogEntry {
        manifest: entry.manifest.clone(),
        compatibility: entry.compatibility.clone(),
        distribution: entry.distribution,
        installed: entry.installed,
        removable: entry.removable,
        settings_schema,
        issue_tracker_contributions: entry.issue_tracker_contributions.clone(),
        view_contributions: entry.view_contributions.clone(),
    })
}

fn bundled_plugin_entry(plugin_id: &PluginIdV2) -> Result<DurePluginCatalogEntryV2, String> {
    let registry = bundled_plugin_registry();
    let package = registry
        .package(plugin_id)
        .map_err(|error| error.to_string())?;
    catalog_entry_v2(registry, package).map_err(|rejection| rejection.message)
}

#[cfg(test)]
fn bundled_beads() -> Result<DurePluginCatalogEntryV2, String> {
    let plugin_id = PluginIdV2::new("dure.beads").expect("bundled plugin ID is static and valid");
    bundled_plugin_entry(&plugin_id)
}

#[tauri::command]
pub fn dure_plugin_catalog_v2(
    state: State<'_, DurePluginState>,
) -> Result<DurePluginCatalogSnapshotV2, String> {
    Ok(plugin_catalog_v2(&state))
}

fn plugin_catalog_v2(state: &DurePluginState) -> DurePluginCatalogSnapshotV2 {
    catalog_snapshot_from_registry(state.registry())
}

fn legacy_catalog_projection(
    snapshot: DurePluginCatalogSnapshotV2,
) -> Result<Vec<DurePluginCatalogEntry>, String> {
    let mut entries = Vec::new();
    for outcome in snapshot.outcomes {
        if let DurePluginCatalogOutcomeV2::Available { entry, .. } = outcome {
            if let Some(entry) = legacy_catalog_entry(&entry) {
                entries.push(entry);
            }
        }
    }
    Ok(entries)
}

#[tauri::command]
pub fn dure_plugin_catalog(
    state: State<'_, DurePluginState>,
) -> Result<Vec<DurePluginCatalogEntry>, String> {
    legacy_plugin_catalog(&state)
}

fn legacy_plugin_catalog(
    state: &DurePluginState,
) -> Result<Vec<DurePluginCatalogEntry>, String> {
    legacy_catalog_projection(plugin_catalog_v2(state))
}

pub(crate) fn bundled_agent_claim_statuses(
    plugin_id: &str,
    provider_contribution_id: &str,
) -> Result<Vec<String>, String> {
    let plugin_id = PluginIdV2::new(plugin_id).map_err(|error| error.to_string())?;
    let entry = bundled_plugin_entry(&plugin_id)?;
    Ok(agent_claim_statuses(&entry, provider_contribution_id))
}

fn agent_claim_statuses(
    entry: &DurePluginCatalogEntryV2,
    provider_contribution_id: &str,
) -> Vec<String> {
    let mut statuses = std::collections::BTreeSet::new();
    for contribution in &entry.view_contributions {
        for view in &contribution.views.views {
            let PluginViewKindV1::IssueTracker {
                provider_contribution_id: candidate,
                agent_claims,
                ..
            } = &view.kind;
            if candidate.as_str() == provider_contribution_id {
                if let Some(agent_claims) = agent_claims {
                    statuses.extend(agent_claims.statuses.iter().cloned());
                }
            }
        }
    }
    statuses.into_iter().collect()
}

fn agent_claim_policies_for_snapshot(
    snapshot: &DurePluginSettingsSnapshot,
) -> Result<Vec<(String, bool)>, String> {
    if snapshot.scope != PluginSettingScopeV1::Workspace {
        return Ok(Vec::new());
    }
    let registry = bundled_plugin_registry();
    let schema = catalog_settings_schema(registry, &snapshot.target)?;
    let mut values = schema.defaults(PluginSettingScopeV1::Workspace);
    values.extend(snapshot.values.clone());
    let entry = bundled_plugin_entry(&snapshot.target.plugin_id)?;
    let mut policies = BTreeMap::<String, bool>::new();
    for contribution in &entry.view_contributions {
        for view in &contribution.views.views {
            let PluginViewKindV1::IssueTracker {
                provider_contribution_id,
                agent_claims,
                ..
            } = &view.kind;
            let Some(agent_claims) = agent_claims else {
                continue;
            };
            let enabled = match values.get(&agent_claims.setting_key) {
                Some(PluginSettingValueV1::Boolean(enabled)) => *enabled,
                _ => {
                    return Err(format!(
                        "plugin {} agent claims setting {} is not a workspace boolean",
                        snapshot.target.plugin_id.as_str(),
                        agent_claims.setting_key.as_str()
                    ));
                }
            };
            policies
                .entry(provider_contribution_id.as_str().to_owned())
                .and_modify(|current| *current |= enabled)
                .or_insert(enabled);
        }
    }
    Ok(policies.into_iter().collect())
}

type AgentClaimPolicyUpdate = (PathBuf, Vec<(String, bool)>);

fn resolved_agent_claim_policy_update(
    snapshot: &DurePluginSettingsSnapshot,
    canonical_workspace_root: Option<&Path>,
) -> Result<Option<AgentClaimPolicyUpdate>, String> {
    let policies = agent_claim_policies_for_snapshot(snapshot)?;
    if policies.is_empty() {
        return Ok(None);
    }
    let Some(workspace_root) = canonical_workspace_root else {
        if snapshot
            .scope_key
            .as_deref()
            .is_some_and(|scope_key| scope_key.starts_with("ssh:"))
        {
            // Remote issue-tracker execution is not available, so there is no
            // local watcher to fence. Keep its workspace settings editable.
            return Ok(None);
        }
        return Err("local workspace plugin settings require an authoritative workspace root".into());
    };
    Ok(Some((workspace_root.to_path_buf(), policies)))
}

fn apply_agent_claim_policy_update(
    state: &DureIssueTrackerState,
    plugin_id: &str,
    update: Option<AgentClaimPolicyUpdate>,
) -> Result<BTreeMap<String, u32>, String> {
    let Some((workspace_root, policies)) = update else {
        return Ok(BTreeMap::new());
    };
    let mut epochs = BTreeMap::new();
    let mut errors = Vec::new();
    for (contribution_id, enabled) in policies {
        match state.set_agent_claim_policy(
            plugin_id,
            &contribution_id,
            workspace_root.clone(),
            enabled,
        ) {
            Ok(epoch) => {
                epochs.insert(contribution_id, epoch);
            }
            Err(error) => errors.push(format!("{contribution_id}: {error}")),
        }
    }
    if !errors.is_empty() {
        return Err(format!(
            "plugin agent claim policy update failed: {}",
            errors.join("; ")
        ));
    }
    Ok(epochs)
}

fn catalog_settings_schema(
    registry: &PluginPackageRegistryV2,
    target: &DurePluginSettingsTargetV2,
) -> Result<PluginSettingsSchemaV1, String> {
    let source_id = PluginPackageSourceIdV2::new(target.identity.source_id.clone())
        .map_err(|error| error.to_string())?;
    let candidate_id = PluginPackageCandidateIdV2::new(target.identity.candidate_id.clone())
        .map_err(|error| error.to_string())?;
    let package = registry
        .package(&target.plugin_id)
        .map_err(|error| error.to_string())?;
    if package.source_id() != &source_id
        || package.candidate_id() != &candidate_id
        || package.manifest().version.as_str() != target.version.as_str()
    {
        return Err(format!(
            "plugin settings target for {} does not match the catalog package",
            target.plugin_id.as_str()
        ));
    }
    let entry = catalog_entry_v2(registry, package).map_err(|rejection| rejection.message)?;
    let contribution = entry
        .settings_contribution
        .ok_or_else(|| {
            format!(
                "plugin {} does not declare settings",
                target.plugin_id.as_str()
            )
        })?;
    if &contribution.target != target {
        return Err(format!(
            "plugin settings target for {} does not match the catalog contribution",
            target.plugin_id.as_str()
        ));
    }
    Ok(contribution.schema)
}

fn validated_scope_key(
    scope: &PluginSettingScopeV1,
    scope_key: Option<String>,
) -> Result<Option<String>, String> {
    match scope {
        PluginSettingScopeV1::User if scope_key.is_none() => Ok(None),
        PluginSettingScopeV1::User => {
            Err("user-scoped plugin settings cannot have a scope key".into())
        }
        PluginSettingScopeV1::Workspace | PluginSettingScopeV1::Profile => {
            let key = scope_key
                .filter(|key| !key.trim().is_empty() && key.len() <= 4_096)
                .ok_or_else(|| {
                    "workspace/profile plugin settings require a bounded scope key".to_owned()
                })?;
            Ok(Some(key))
        }
    }
}

fn authoritative_workspace_scope(
    requested_scope_key: Option<String>,
    workspace_identity: &PluginWorkspaceIdentityV2,
    canonical_workspace_root: &Path,
) -> Result<ResolvedSettingsScope, String> {
    let scope_key = workspace_identity.as_str().to_owned();
    match requested_scope_key {
        None => {}
        Some(requested) if requested == scope_key => {}
        // The old renderer-local project id has no host-owned id-to-root
        // authority. Accept it only as an ignored compatibility hint; it must
        // never select or migrate a settings file for the authorized root.
        Some(requested) if is_legacy_local_scope_key(&requested) => {}
        Some(_) => {
            return Err(
                "workspace plugin settings scope does not match the authorized workspace".into(),
            );
        }
    };
    Ok(ResolvedSettingsScope {
        scope_key: Some(scope_key),
        canonical_workspace_root: Some(canonical_workspace_root.to_path_buf()),
    })
}

fn is_legacy_local_scope_key(value: &str) -> bool {
    value
        .strip_prefix("local:local:")
        .is_some_and(|project_id| {
            !project_id.is_empty()
                && value.len() <= 4_096
                && value.trim() == value
                && !value.chars().any(char::is_control)
        })
}

fn resolve_settings_scope(
    permissions: &DurePluginPermissionRuntime,
    target: &DurePluginSettingsTargetV2,
    scope: &PluginSettingScopeV1,
    requested_scope_key: Option<String>,
    workspace_root: Option<&str>,
) -> Result<ResolvedSettingsScope, String> {
    match (scope, workspace_root) {
        (PluginSettingScopeV1::Workspace, Some(workspace_root)) => {
            let (permission_target, _) =
                permissions.resolve_current(target.plugin_id.as_str(), workspace_root)?;
            authoritative_workspace_scope(
                requested_scope_key,
                permission_target.workspace().identity(),
                permission_target.workspace().canonical_root(),
            )
        }
        (PluginSettingScopeV1::Workspace, None) => {
            let scope_key = validated_scope_key(scope, requested_scope_key)?;
            if !scope_key
                .as_deref()
                .is_some_and(|scope_key| scope_key.starts_with("ssh:"))
            {
                return Err("local workspace plugin settings require a workspace root".into());
            }
            Ok(ResolvedSettingsScope {
                scope_key,
                canonical_workspace_root: None,
            })
        }
        (_, Some(_)) => Err("only workspace plugin settings accept a workspace root".into()),
        (_, None) => Ok(ResolvedSettingsScope {
            scope_key: validated_scope_key(scope, requested_scope_key)?,
            canonical_workspace_root: None,
        }),
    }
}

fn settings_file_name(scope: &PluginSettingScopeV1, scope_key: Option<&str>) -> String {
    match (scope, scope_key) {
        (PluginSettingScopeV1::User, _) => "user.json".to_owned(),
        (PluginSettingScopeV1::Workspace, Some(key)) => {
            format!("workspace-{}.json", digest_scope_key(key))
        }
        (PluginSettingScopeV1::Profile, Some(key)) => {
            format!("profile-{}.json", digest_scope_key(key))
        }
        _ => unreachable!("scope key is validated before path construction"),
    }
}

fn digest_scope_key(key: &str) -> String {
    format!("{:x}", Sha256::digest(key.as_bytes()))
}

fn settings_path(
    root: &Path,
    plugin_id: &PluginIdV2,
    scope: &PluginSettingScopeV1,
    scope_key: Option<&str>,
) -> PathBuf {
    root.join(SETTINGS_DIRECTORY)
        .join(plugin_id.as_str())
        .join(settings_file_name(scope, scope_key))
}

fn read_stored_settings(path: &Path) -> Result<StoredSettings, String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StoredSettings {
                revision: 0,
                values: BTreeMap::new(),
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("plugin settings path is not a regular file".into());
    }
    if metadata.len() > MAX_SETTINGS_BYTES {
        return Err("plugin settings file exceeds the size limit".into());
    }
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_SETTINGS_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err("plugin settings file exceeds the size limit".into());
    }
    if let Ok(document) = serde_json::from_slice::<StoredSettingsDocument>(&bytes) {
        if document.schema_version != SETTINGS_DOCUMENT_SCHEMA_VERSION {
            return Err("plugin settings document version is not supported".into());
}
        return Ok(StoredSettings {
            revision: document.revision,
            values: document.values,
        });
    }
    let values = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    Ok(StoredSettings {
        revision: 0,
        values,
    })
}

fn stored_settings_bytes(stored: &StoredSettings) -> Result<Vec<u8>, String> {
    let document = StoredSettingsDocument {
        schema_version: SETTINGS_DOCUMENT_SCHEMA_VERSION,
        revision: stored.revision,
        values: stored.values.clone(),
    };
    let mut bytes = serde_json::to_vec_pretty(&document).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err("plugin settings payload exceeds the size limit".into());
    }
    Ok(bytes)
}

fn read_resolved_snapshot(
    registry: &PluginPackageRegistryV2,
    root: &Path,
    target: DurePluginSettingsTargetV2,
    scope: PluginSettingScopeV1,
    resolved_scope: &ResolvedSettingsScope,
) -> Result<DurePluginSettingsSnapshot, String> {
    read_snapshot(
        registry,
        root,
        target,
        scope,
        resolved_scope.scope_key.clone(),
    )
}

fn parse_settings_revision(value: &str) -> Result<u64, String> {
    let revision = value
        .parse::<u64>()
        .map_err(|_| "plugin settings revision is invalid".to_owned())?;
    if revision.to_string() != value {
        return Err("plugin settings revision is invalid".into());
    }
    Ok(revision)
}

fn ensure_settings_revision_matches(
    candidate: &DurePluginSettingsSnapshot,
    current: &DurePluginSettingsSnapshot,
) -> Result<(), String> {
    if parse_settings_revision(&candidate.settings_revision)?
        != parse_settings_revision(&current.settings_revision)?
    {
        return Err("plugin settings revision conflict".into());
    }
    Ok(())
}

fn read_snapshot(
    registry: &PluginPackageRegistryV2,
    root: &Path,
    target: DurePluginSettingsTargetV2,
    scope: PluginSettingScopeV1,
    scope_key: Option<String>,
) -> Result<DurePluginSettingsSnapshot, String> {
    let scope_key = validated_scope_key(&scope, scope_key)?;
    let schema = catalog_settings_schema(registry, &target)?;
    let path = settings_path(root, &target.plugin_id, &scope, scope_key.as_deref());
    let stored = read_stored_settings(&path)?;
    schema
        .validate_values(scope.clone(), &stored.values)
        .map_err(|error| error.to_string())?;
    let mut values = schema.defaults(scope.clone());
    values.extend(stored.values);
    Ok(DurePluginSettingsSnapshot {
        target,
        scope,
        scope_key,
        values,
        settings_revision: stored.revision.to_string(),
        agent_claim_policy_epochs: BTreeMap::new(),
    })
}

fn write_owner_only(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "plugin settings path has no parent".to_owned())?;
    let settings_root = parent
        .parent()
        .ok_or_else(|| "plugin settings directory has no root".to_owned())?;
    if std::fs::symlink_metadata(settings_root)
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("plugin settings root cannot be a symlink".into());
    }
    std::fs::create_dir_all(settings_root).map_err(|error| error.to_string())?;
    if std::fs::symlink_metadata(settings_root)
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("plugin settings root cannot be a symlink".into());
    }
    std::fs::create_dir(parent)
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                Ok(())
            } else {
                Err(error)
            }
        })
        .map_err(|error| error.to_string())?;
    if std::fs::symlink_metadata(parent).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("plugin settings directory cannot be a symlink".into());
    }
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("plugin settings file cannot be a symlink".into());
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let temporary = path.with_extension(format!("tmp-{}-{nonce}", std::process::id()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write_result = (|| {
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result
}

fn save_snapshot(
    registry: &PluginPackageRegistryV2,
    root: &Path,
    snapshot: DurePluginSettingsSnapshot,
) -> Result<DurePluginSettingsSnapshot, String> {
    let scope_key = validated_scope_key(&snapshot.scope, snapshot.scope_key)?;
    let schema = catalog_settings_schema(registry, &snapshot.target)?;
    schema
        .validate_values(snapshot.scope.clone(), &snapshot.values)
        .map_err(|error| error.to_string())?;
    let path = settings_path(
        root,
        &snapshot.target.plugin_id,
        &snapshot.scope,
        scope_key.as_deref(),
    );
    let stored = read_stored_settings(&path)?;
    let expected_revision = parse_settings_revision(&snapshot.settings_revision)?;
    if expected_revision != stored.revision {
        return Err("plugin settings revision conflict".into());
    }
    let revision = stored
        .revision
        .checked_add(1)
        .ok_or_else(|| "plugin settings revision exhausted".to_owned())?;
    let stored = StoredSettings {
        revision,
        values: snapshot.values.clone(),
    };
    write_owner_only(&path, &stored_settings_bytes(&stored)?)?;
    let mut values = schema.defaults(snapshot.scope.clone());
    values.extend(snapshot.values);
    Ok(DurePluginSettingsSnapshot {
        target: snapshot.target,
        scope: snapshot.scope,
        scope_key,
        values,
        settings_revision: revision.to_string(),
        agent_claim_policy_epochs: BTreeMap::new(),
    })
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

struct SettingsFileLock(File);

impl Drop for SettingsFileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

fn lock_settings_directory(root: &Path) -> Result<SettingsFileLock, String> {
    let directory = root.join(SETTINGS_DIRECTORY);
    if std::fs::symlink_metadata(&directory)
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("plugin settings root cannot be a symlink".into());
    }
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let directory_metadata =
        std::fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err("plugin settings root is not a real directory".into());
    }
    let path = directory.join(SETTINGS_LOCK_FILE);
    if std::fs::symlink_metadata(&path)
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("plugin settings lock cannot be a symlink".into());
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    let file = options.open(&path).map_err(|error| error.to_string())?;
    let opened_metadata = file.metadata().map_err(|error| error.to_string())?;
    if !opened_metadata.is_file() {
        return Err("plugin settings lock is not a regular file".into());
    }
    FileExt::lock_exclusive(&file).map_err(|error| error.to_string())?;
    let directory_metadata =
        std::fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
    let path_metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if directory_metadata.file_type().is_symlink()
        || !directory_metadata.is_dir()
        || path_metadata.file_type().is_symlink()
        || !path_metadata.is_file()
    {
        let _ = FileExt::unlock(&file);
        return Err("plugin settings lock authority changed while acquiring it".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened_metadata.dev() != path_metadata.dev()
            || opened_metadata.ino() != path_metadata.ino()
        {
            let _ = FileExt::unlock(&file);
            return Err("plugin settings lock changed while acquiring it".into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(SettingsFileLock(file))
}

fn with_serialized_settings_policy<S, T>(
    settings_lock: &Mutex<()>,
    settings_root: &Path,
    settings_operation: impl FnOnce() -> Result<S, String>,
    policy_publication: impl FnOnce(S) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = settings_lock
        .lock()
        .map_err(|_| "plugin settings lock is poisoned".to_owned())?;
    let _file_guard = lock_settings_directory(settings_root)?;
    let settings_result = settings_operation()?;
    policy_publication(settings_result)
}

#[tauri::command]
pub async fn dure_plugin_settings_get(
    app: AppHandle,
    target: DurePluginSettingsTargetV2,
    scope: PluginSettingScopeV1,
    scope_key: Option<String>,
    workspace_root: Option<String>,
) -> Result<DurePluginSettingsSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DurePluginState>();
        let issue_tracker = app.state::<DureIssueTrackerState>();
        let permissions = app.state::<DurePluginPermissionRuntime>();
        let root = app_data_dir(&app)?;
        catalog_settings_schema(state.registry(), &target)?;
        with_serialized_settings_policy(
            &state.settings_lock,
            &root,
            || {
                let resolved_scope = resolve_settings_scope(
                    &permissions,
                    &target,
                    &scope,
                    scope_key,
                    workspace_root.as_deref(),
                )?;
                let snapshot = read_resolved_snapshot(
                    state.registry(),
                    &root,
                    target,
                    scope,
                    &resolved_scope,
                )?;
                let update = resolved_agent_claim_policy_update(
                    &snapshot,
                    resolved_scope.canonical_workspace_root.as_deref(),
                )?;
                Ok((snapshot, update))
            },
            |(mut snapshot, update)| {
                snapshot.agent_claim_policy_epochs = apply_agent_claim_policy_update(
                    &issue_tracker,
                    snapshot.target.plugin_id.as_str(),
                    update,
                )?;
                Ok(snapshot)
            },
    )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn dure_plugin_settings_update(
    app: AppHandle,
    snapshot: DurePluginSettingsSnapshot,
    workspace_root: Option<String>,
) -> Result<DurePluginSettingsSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DurePluginState>();
        let issue_tracker = app.state::<DureIssueTrackerState>();
        let permissions = app.state::<DurePluginPermissionRuntime>();
        let root = app_data_dir(&app)?;
        catalog_settings_schema(state.registry(), &snapshot.target)?;
        with_serialized_settings_policy(
            &state.settings_lock,
            &root,
            || {
                let resolved_scope = resolve_settings_scope(
                    &permissions,
                    &snapshot.target,
                    &snapshot.scope,
                    snapshot.scope_key.clone(),
                    workspace_root.as_deref(),
                )?;
                let mut snapshot = snapshot;
                snapshot.scope_key = resolved_scope.scope_key.clone();
                let previous = read_resolved_snapshot(
                    state.registry(),
                    &root,
                    snapshot.target.clone(),
                    snapshot.scope.clone(),
                    &resolved_scope,
                )?;
                ensure_settings_revision_matches(&snapshot, &previous)?;
                let next_update = resolved_agent_claim_policy_update(
                    &snapshot,
                    resolved_scope.canonical_workspace_root.as_deref(),
                )?;
                Ok((snapshot, previous, next_update))
            },
            |(snapshot, mut previous, next_update)| {
                let plugin_id = snapshot.target.plugin_id.as_str().to_owned();
                let updated = match next_update {
                    Some((workspace_root, policies)) => issue_tracker
                        .persist_agent_claim_policy_update(
                            &plugin_id,
                            workspace_root,
                            policies,
                            || save_snapshot(state.registry(), &root, snapshot),
                        ),
                    None => save_snapshot(state.registry(), &root, snapshot)
                        .map(|saved| (BTreeMap::new(), saved))
                        .map_err(|error| (error, BTreeMap::new())),
                };
                match updated {
                    Ok((epochs, mut saved)) => {
                        saved.agent_claim_policy_epochs = epochs;
                        if let Err(error) = app.emit(PLUGIN_SETTINGS_EVENT, &saved) {
                            eprintln!(
                                "[plugin-settings] committed update event publication failed: {error}"
                            );
                        }
    Ok(saved)
}
                    Err((error, epochs)) => {
                        previous.agent_claim_policy_epochs = epochs;
                        match app.emit(PLUGIN_SETTINGS_EVENT, &previous) {
                            Ok(()) => Err(error),
                            Err(event_error) => Err(format!(
                                "{error}; plugin settings rollback event publication failed: {event_error}"
                            )),
                        }
                    }
                }
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
#[path = "plugin_catalog_optional_tests.rs"]
mod optional_tracker_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::TryLockError;

    #[test]
    fn settings_serialization_holds_the_lock_through_policy_and_event_publication() {
        let settings_lock = Mutex::new(());
        let settings_root = tempfile::tempdir().unwrap();

        let published = with_serialized_settings_policy(
            &settings_lock,
            settings_root.path(),
            || {
                assert!(matches!(
                    settings_lock.try_lock(),
                    Err(TryLockError::WouldBlock)
                ));
                Ok("persisted snapshot")
            },
            |snapshot| {
                assert_eq!(snapshot, "persisted snapshot");
                assert!(matches!(
                    settings_lock.try_lock(),
                    Err(TryLockError::WouldBlock)
                ));
                Ok("published policy")
            },
        )
        .unwrap();

        assert_eq!(published, "published policy");
        assert!(settings_lock.try_lock().is_ok());
    }

    #[test]
    fn settings_file_lock_fences_a_second_writer() {
        let root = tempfile::tempdir().unwrap();
        let first = lock_settings_directory(root.path()).unwrap();
        let path = root
            .path()
            .join(SETTINGS_DIRECTORY)
            .join(SETTINGS_LOCK_FILE);
        let second = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();

        assert!(FileExt::try_lock_exclusive(&second).is_err());
        drop(first);
        FileExt::try_lock_exclusive(&second).unwrap();
        FileExt::unlock(&second).unwrap();
    }

    #[test]
    fn agent_claim_policy_is_derived_from_the_plugin_view_and_setting_contracts() {
        let entry = bundled_beads().unwrap();
        let settings = entry.settings_contribution.as_ref().unwrap();
        let mut snapshot = DurePluginSettingsSnapshot {
            target: settings.target.clone(),
            scope: PluginSettingScopeV1::Workspace,
            scope_key: Some("local:local:project".into()),
            values: BTreeMap::new(),
            settings_revision: "0".into(),
            agent_claim_policy_epochs: BTreeMap::new(),
        };

        assert_eq!(
            agent_claim_policies_for_snapshot(&snapshot).unwrap(),
            vec![("dure.beads.issue-tracker".into(), true)]
        );
        snapshot.values.insert(
            PluginSettingKeyV1::new("show_agent_claims").unwrap(),
            PluginSettingValueV1::Boolean(false),
        );
        assert_eq!(
            agent_claim_policies_for_snapshot(&snapshot).unwrap(),
            vec![("dure.beads.issue-tracker".into(), false)]
        );
        snapshot.scope_key = Some("ssh:host:project".into());
        assert!(
            resolved_agent_claim_policy_update(&snapshot, None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn bundled_permission_plan_uses_the_trusted_registry_snapshot() {
        let plan = bundled_permission_plan(
            &PluginIdV2::new("dure.beads").unwrap(),
            PluginWorkspaceIdentityV2::from_host_hmac(format!(
                "sha256:{}",
                "a".repeat(64)
            ))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(plan.identity().plugin_id().as_str(), "dure.beads");
        assert_eq!(plan.authority().authority().as_str(), BUNDLED_PLUGIN_AUTHORITY_ID);
        assert!(
            plan.permissions()
                .iter()
                .any(|permission| permission.kind.as_str() == "dure.issue-tracker.read")
        );
    }

    fn test_registry(
        manifest: PluginManifestV2,
        resources: BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
        source_id: &str,
    ) -> PluginPackageRegistryV2 {
        let package = PluginPackageCatalogSnapshotV2::try_new(manifest, resources).unwrap();
        let source = InMemoryPluginPackageSourceV2::new(vec![package]);
        PluginPackageRegistryV2::from_sources(&[PluginPackageSourceRegistrationV2::new(
            PluginPackageSourceIdV2::new(source_id).unwrap(),
            &source,
        )])
    }

    fn beads_manifest() -> PluginManifestV2 {
        serde_json::from_slice(BUNDLED_BEADS_MANIFEST).unwrap()
    }

    fn core_manifest() -> PluginManifestV2 {
        serde_json::from_slice(BUNDLED_CORE_MANIFEST).unwrap()
    }

    fn renamed_beads_manifest(plugin_id: &str, display_name: &str) -> PluginManifestV2 {
        let mut manifest: serde_json::Value =
            serde_json::from_slice(BUNDLED_BEADS_MANIFEST).unwrap();
        manifest["id"] = serde_json::Value::String(plugin_id.to_owned());
        manifest["publisher"] = serde_json::Value::String(
            plugin_id
                .split_once('.')
                .map(|(publisher, _)| publisher)
                .unwrap()
                .to_owned(),
        );
        manifest["display_name"] = serde_json::Value::String(display_name.to_owned());
        for contribution in manifest["contributions"].as_array_mut().unwrap() {
            let id = contribution["id"].as_str().unwrap();
            contribution["id"] =
                serde_json::Value::String(id.replacen("dure.beads", plugin_id, 1));
        }
        for integration in manifest["agent_integrations"].as_array_mut().unwrap() {
            let id = integration["id"].as_str().unwrap();
            integration["id"] =
                serde_json::Value::String(id.replacen("dure.beads", plugin_id, 1));
        }
        serde_json::from_value(manifest).unwrap()
    }

    fn package(
        manifest: PluginManifestV2,
        resources: BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
    ) -> PluginPackageCatalogSnapshotV2 {
        PluginPackageCatalogSnapshotV2::try_new(manifest, resources).unwrap()
    }

    fn registry_with_packages(
        packages: Vec<PluginPackageCatalogSnapshotV2>,
    ) -> PluginPackageRegistryV2 {
        let source = InMemoryPluginPackageSourceV2::new(packages);
        PluginPackageRegistryV2::from_sources(&[PluginPackageSourceRegistrationV2::new(
            PluginPackageSourceIdV2::new(BUNDLED_PLUGIN_SOURCE_ID).unwrap(),
            &source,
        )])
    }

    fn catalog_from_test_registry(
        registry: &PluginPackageRegistryV2,
    ) -> Result<DurePluginCatalogEntryV2, String> {
        catalog_entry_for_test_registry(registry, "dure.beads")
    }

    fn catalog_entry_for_test_registry(
        registry: &PluginPackageRegistryV2,
        plugin_id: &str,
    ) -> Result<DurePluginCatalogEntryV2, String> {
        let plugin_id = PluginIdV2::new(plugin_id).unwrap();
        let package = registry
            .package(&plugin_id)
            .map_err(|error| error.to_string())?;
        catalog_entry_v2(registry, package).map_err(|rejection| rejection.message)
    }

    fn json_bytes(value: &serde_json::Value) -> Arc<[u8]> {
        Arc::from(serde_json::to_vec(value).unwrap())
    }

    fn settings_only_manifest_and_resources(
        plugin_id: &str,
        display_name: &str,
    ) -> (
        PluginManifestV2,
        BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
    ) {
        let mut manifest = renamed_beads_manifest(plugin_id, display_name);
        manifest.contributions.retain(|contribution| {
            contribution.family.as_str() == "dure.settings"
        });
        manifest.permissions.clear();
        manifest.agent_integrations.clear();
        let settings_path = manifest.contributions[0].resource.clone();
        let settings = bundled_contribution_resources()
            .remove(&settings_path)
            .expect("settings fixture resource exists");
        (manifest, BTreeMap::from([(settings_path, settings)]))
    }

    fn settings_only_package(
        plugin_id: &str,
        display_name: &str,
    ) -> PluginPackageCatalogSnapshotV2 {
        let (manifest, resources) =
            settings_only_manifest_and_resources(plugin_id, display_name);
        package(manifest, resources)
    }

    fn write_installed_settings_package(app_root: &Path, candidate_id: &str, plugin_id: &str) {
        let package_root = app_root
            .join(INSTALLED_PLUGIN_PACKAGES_DIRECTORY)
            .join(candidate_id);
        std::fs::create_dir_all(package_root.join("contributions")).unwrap();
        let (manifest, resources) =
            settings_only_manifest_and_resources(plugin_id, "Installed test plugin");
        std::fs::write(
            package_root.join("dure-plugin.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        for (resource_path, bytes) in resources {
            std::fs::write(
                package_root.join(resource_path.as_str().trim_start_matches("./")),
                bytes,
            )
            .unwrap();
        }
    }

    fn settings_target(
        registry: &PluginPackageRegistryV2,
        plugin_id: &str,
    ) -> DurePluginSettingsTargetV2 {
        let plugin_id = PluginIdV2::new(plugin_id).unwrap();
        let package = registry.package(&plugin_id).unwrap();
        catalog_entry_v2(registry, package)
            .unwrap()
            .settings_contribution
            .unwrap()
            .target
    }

    #[test]
    fn bundled_catalog_negotiates_both_agent_integrations() {
        let state = DurePluginState::default();
        let registry = state.registry();
        // Beads, Core, GitHub, Slack.
        assert_eq!(registry.available_len(), 4);
        let package = registry
            .package(&PluginIdV2::new("dure.beads").unwrap())
            .unwrap();
        assert_eq!(package.source_id().as_str(), BUNDLED_PLUGIN_SOURCE_ID);
        assert_eq!(package.contribution_resource_count(), 3);
        let entry = bundled_beads().unwrap();
        assert!(entry.installed);
        assert!(!entry.removable);
        assert_eq!(entry.manifest.id.as_str(), "dure.beads");
        assert_eq!(
            entry
                .settings_contribution
                .as_ref()
                .unwrap()
                .schema
                .settings
                .len(),
            6
        );
        match entry.compatibility {
            PluginCompatibilityOutcomeV2::Supported {
                contributions,
                enabled_agent_integrations,
                ..
            } => {
                assert_eq!(contributions.len(), 3);
                assert_eq!(enabled_agent_integrations.len(), 2);
            }
            other => panic!("expected supported bundled plugin, got {other:?}"),
        }
        assert_eq!(entry.issue_tracker_contributions.len(), 1);
        assert_eq!(entry.view_contributions.len(), 1);
        assert!(entry.workflow_contributions.is_empty());
        let core = bundled_plugin_entry(&PluginIdV2::new("dure.core").unwrap()).unwrap();
        assert!(core.settings_contribution.is_none());
        assert!(core.issue_tracker_contributions.is_empty());
        assert!(core.view_contributions.is_empty());
        assert_eq!(core.workflow_contributions.len(), 1);
        assert_eq!(
            core.workflow_contributions[0].contribution_id.as_str(),
            "dure.core.delegate-once"
        );
        assert_eq!(
            core.workflow_contributions[0].workflow.kind.as_str(),
            "workflow.delegate_once"
        );
        let legacy_catalog = legacy_plugin_catalog(&state).unwrap();
        // Beads and GitHub carry settings; Core does not and stays out of the
        // legacy projection.
        assert_eq!(legacy_catalog.len(), 2);
        let legacy_wire = serde_json::to_value(&legacy_catalog).unwrap();
        assert!(legacy_wire.is_array());
        assert!(legacy_wire[0].get("settings_schema").is_some());
        assert!(legacy_wire[0].get("settings_contribution").is_none());
        let snapshot = plugin_catalog_v2(&state);
        assert_eq!(snapshot.schema_version, PLUGIN_CATALOG_SCHEMA_VERSION_V2);
        assert_eq!(snapshot.outcomes.len(), 4);
        assert!(snapshot.outcomes.iter().any(|outcome| matches!(
            outcome,
            DurePluginCatalogOutcomeV2::Available { identity, entry }
                if identity.source_id == BUNDLED_PLUGIN_SOURCE_ID
                    && identity.candidate_id == BUNDLED_BEADS_CANDIDATE_ID
                    && entry.manifest.id.as_str() == "dure.beads"
        )));
        assert!(snapshot.outcomes.iter().any(|outcome| matches!(
            outcome,
            DurePluginCatalogOutcomeV2::Available { identity, entry }
                if identity.source_id == BUNDLED_PLUGIN_SOURCE_ID
                    && identity.candidate_id == BUNDLED_CORE_CANDIDATE_ID
                    && entry.manifest.id.as_str() == "dure.core"
        )));
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["schema_version"], serde_json::json!(2));
        assert_eq!(wire["outcomes"][0]["status"], "available");
        assert_eq!(
            wire["outcomes"][0]["identity"],
            serde_json::json!({
                "source_id": BUNDLED_PLUGIN_SOURCE_ID,
                "candidate_id": BUNDLED_BEADS_CANDIDATE_ID,
            })
        );
        assert!(wire["outcomes"][0]["entry"].get("settings_schema").is_none());
        assert_eq!(
            wire["outcomes"][0]["entry"]["settings_contribution"]["contribution_id"],
            "dure.beads.settings"
        );
        assert_eq!(
            wire["outcomes"][0]["entry"]["settings_contribution"]["target"],
            serde_json::json!({
                "identity": {
                    "source_id": BUNDLED_PLUGIN_SOURCE_ID,
                    "candidate_id": BUNDLED_BEADS_CANDIDATE_ID,
                },
                "plugin_id": "dure.beads",
                "version": "0.2.1",
                "contribution_id": "dure.beads.settings",
            })
        );
        assert_eq!(
            bundled_agent_claim_statuses("dure.beads", "dure.beads.issue-tracker").unwrap(),
            ["in_progress"]
        );
        let (_, provider_bytes) = bundled_contribution_resource(
            "dure.beads",
            "dure.beads.issue-tracker",
            "dure.issue-tracker",
        )
        .unwrap();
        let provider: IssueTrackerProviderV1 = serde_json::from_slice(provider_bytes).unwrap();
        assert_eq!(provider, entry.issue_tracker_contributions[0].provider);
    }

    #[test]
    fn workflow_catalog_rejects_unknown_duplicate_and_executable_shapes() {
        let cases = [
            ("kind", serde_json::json!("workflow.future")),
            ("command", serde_json::json!("codex")),
        ];
        for (field, value) in cases {
            let manifest = core_manifest();
            let mut resource: serde_json::Value =
                serde_json::from_slice(BUNDLED_CORE_WORKFLOWS).unwrap();
            resource[field] = value;
            let registry = test_registry(
                manifest,
                BTreeMap::from([(
                    PluginResourcePathV2::new("./contributions/workflows.json").unwrap(),
                    json_bytes(&resource),
                )]),
                BUNDLED_PLUGIN_SOURCE_ID,
            );
            let error = catalog_entry_for_test_registry(&registry, "dure.core")
                .expect_err("unsupported workflow shape must fail closed");
            assert!(error.contains("workflow") || error.contains("unknown field"));
        }

        let mut manifest = core_manifest();
        let mut duplicate = manifest.contributions[0].clone();
        duplicate.id = ContributionIdV2::new("dure.core.delegate-again").unwrap();
        duplicate.resource =
            PluginResourcePathV2::new("./contributions/workflows-again.json").unwrap();
        manifest.contributions.push(duplicate);
        let mut resources = bundled_core_contribution_resources();
        resources.insert(
            PluginResourcePathV2::new("./contributions/workflows-again.json").unwrap(),
            Arc::from(BUNDLED_CORE_WORKFLOWS),
        );
        let registry = test_registry(manifest, resources, BUNDLED_PLUGIN_SOURCE_ID);
        let error = catalog_entry_for_test_registry(&registry, "dure.core")
            .expect_err("duplicate workflow kinds must fail closed");
        assert!(error.contains("more than once"));
    }

    #[test]
    fn negotiated_workflow_resource_is_required_even_when_manifest_marks_it_optional() {
        let mut manifest = core_manifest();
        manifest.contributions[0].required = false;
        let registry = test_registry(manifest, BTreeMap::new(), BUNDLED_PLUGIN_SOURCE_ID);
        let error = catalog_entry_for_test_registry(&registry, "dure.core")
            .expect_err("consumed workflow resource must exist");
        assert!(error.contains("resource"));
    }

    #[test]
    fn settings_less_agent_only_package_is_available_without_a_synthetic_schema() {
        let mut manifest = renamed_beads_manifest("example.agent-only", "Agent only");
        manifest.contributions.clear();
        manifest.permissions.clear();
        let registry = registry_with_packages(vec![package(manifest, BTreeMap::new())]);

        let snapshot = catalog_snapshot_from_registry(&registry);
        let [DurePluginCatalogOutcomeV2::Available { identity, entry }] =
            snapshot.outcomes.as_slice()
        else {
            panic!("agent-only package must remain available")
        };
        assert_eq!(identity.source_id, BUNDLED_PLUGIN_SOURCE_ID);
        assert_eq!(entry.manifest.id.as_str(), "example.agent-only");
        assert!(entry.settings_contribution.is_none());
        assert!(entry.issue_tracker_contributions.is_empty());
        assert!(entry.view_contributions.is_empty());
        assert!(legacy_catalog_entry(entry).is_none());
        assert!(matches!(
            &entry.compatibility,
            PluginCompatibilityOutcomeV2::Supported {
                enabled_agent_integrations,
                ..
            } if enabled_agent_integrations.len() == 2
        ));
    }

    #[test]
    fn legacy_projection_includes_settings_contributions_from_available_plugins() {
        let mut sibling_manifest =
            renamed_beads_manifest("example.agent-only", "Agent only");
        sibling_manifest.contributions.clear();
        sibling_manifest.permissions.clear();
        let registry = registry_with_packages(vec![
            package(beads_manifest(), bundled_contribution_resources()),
            package(sibling_manifest, BTreeMap::new()),
        ]);
        let legacy = legacy_catalog_projection(catalog_snapshot_from_registry(&registry)).unwrap();
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].manifest.id.as_str(), "dure.beads");

        let mut settings_less_beads = beads_manifest();
        settings_less_beads.contributions.clear();
        settings_less_beads.permissions.clear();
        let registry = registry_with_packages(vec![package(
            settings_less_beads,
            BTreeMap::new(),
        )]);
        assert!(legacy_catalog_projection(catalog_snapshot_from_registry(&registry))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn malformed_package_is_rejected_without_hiding_beads_or_legacy_projection() {
        let beads = package(beads_manifest(), bundled_contribution_resources());
        let broken_manifest = renamed_beads_manifest("example.broken", "Broken");
        let mut broken_resources = bundled_contribution_resources();
        broken_resources.insert(
            PluginResourcePathV2::new("./contributions/settings.json").unwrap(),
            Arc::from(b"{".as_slice()),
        );
        let broken = package(broken_manifest, broken_resources);
        let registry = registry_with_packages(vec![broken, beads]);

        let snapshot = catalog_snapshot_from_registry(&registry);
        assert!(snapshot.outcomes.iter().any(|outcome| matches!(
            outcome,
            DurePluginCatalogOutcomeV2::Available { entry, .. }
                if entry.manifest.id.as_str() == "dure.beads"
        )));
        assert!(snapshot.outcomes.iter().any(|outcome| matches!(
            outcome,
            DurePluginCatalogOutcomeV2::Rejected {
                manifest: Some(manifest),
                reason: DurePluginCatalogRejectionV2::InvalidContribution {
                    contribution_id: Some(contribution_id),
                    family: Some(family),
                },
                ..
            } if manifest.id.as_str() == "example.broken"
                && contribution_id.as_str() == "example.broken.settings"
                && family.as_str() == "dure.settings"
        )));
        let wire = serde_json::to_value(&snapshot).unwrap();
        let rejection = wire["outcomes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|outcome| outcome["status"] == "rejected")
            .unwrap();
        assert_eq!(
            rejection["reason"],
            serde_json::json!({
                "kind": "invalid_contribution",
                "contribution_id": "example.broken.settings",
                "family": "dure.settings",
            })
        );
        let legacy = legacy_catalog_projection(snapshot).unwrap();
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].manifest.id.as_str(), "dure.beads");
    }

    #[test]
    fn incompatible_package_is_a_typed_rejection() {
        let mut manifest = renamed_beads_manifest("example.future", "Future");
        manifest.contributions.clear();
        manifest.permissions.clear();
        manifest.host_api = ContractVersionRangeV2::new(9, 10);
        let registry = registry_with_packages(vec![package(manifest, BTreeMap::new())]);

        let snapshot = catalog_snapshot_from_registry(&registry);
        assert!(matches!(
            snapshot.outcomes.as_slice(),
            [DurePluginCatalogOutcomeV2::Rejected {
                manifest: Some(manifest),
                reason: DurePluginCatalogRejectionV2::Incompatible {
                    compatibility: PluginCompatibilityOutcomeV2::IncompatibleHostApi { .. },
                },
                ..
            }] if manifest.id.as_str() == "example.future"
        ));
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["outcomes"][0]["status"], "rejected");
        assert_eq!(wire["outcomes"][0]["reason"]["kind"], "incompatible");
        assert_eq!(
            wire["outcomes"][0]["reason"]["compatibility"]["status"],
            "incompatible_host_api"
        );
    }

    #[test]
    fn unavailable_source_policy_is_a_typed_rejection() {
        let registry = test_registry(
            beads_manifest(),
            bundled_contribution_resources(),
            "example.unmanaged",
        );

        let state = DurePluginState::from_registry(registry);
        let snapshot = plugin_catalog_v2(&state);
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["outcomes"][0]["status"], "rejected");
        assert_eq!(
            wire["outcomes"][0]["identity"]["source_id"],
            "example.unmanaged"
        );
        assert_eq!(
            wire["outcomes"][0]["reason"],
            serde_json::json!({ "kind": "catalog_policy_unavailable" })
        );
    }

    #[test]
    fn production_registry_composes_bundled_and_installed_sources() {
        let app_root = tempfile::tempdir().unwrap();
        write_installed_settings_package(
            app_root.path(),
            "example.installed",
            "example.installed",
        );

        let state = DurePluginState::from_app_root(app_root.path());
        let snapshot = plugin_catalog_v2(&state);

        // The four bundled packages plus the installed one.
        assert_eq!(state.registry().available_len(), 5);
        assert!(snapshot.outcomes.iter().any(|outcome| matches!(
            outcome,
            DurePluginCatalogOutcomeV2::Available { identity, entry }
                if identity.source_id == INSTALLED_PLUGIN_SOURCE_ID
                    && entry.manifest.id.as_str() == "example.installed"
        )));
    }

    #[test]
    fn installed_package_cannot_override_a_bundled_plugin_id() {
        let app_root = tempfile::tempdir().unwrap();
        write_installed_settings_package(app_root.path(), "example.shadow", "dure.beads");

        let state = DurePluginState::from_app_root(app_root.path());
        let snapshot = plugin_catalog_v2(&state);

        // The shadowed Beads id is a conflict; Core, GitHub and Slack stay available.
        assert_eq!(state.registry().available_len(), 3);
        assert!(snapshot.outcomes.iter().any(|outcome| matches!(
            outcome,
            DurePluginCatalogOutcomeV2::Conflict { plugin_id, candidates }
                if plugin_id.as_str() == "dure.beads"
                    && candidates.len() == 2
                    && candidates.iter().any(|candidate| {
                        candidate.source_id == BUNDLED_PLUGIN_SOURCE_ID
                    })
                    && candidates.iter().any(|candidate| {
                        candidate.source_id == INSTALLED_PLUGIN_SOURCE_ID
                    })
        )));
    }

    #[test]
    fn duplicate_plugin_id_is_one_conflict_without_selecting_a_candidate() {
        let registry = registry_with_packages(vec![
            package(beads_manifest(), bundled_contribution_resources()),
            package(beads_manifest(), bundled_contribution_resources()),
        ]);

        let snapshot = catalog_snapshot_from_registry(&registry);
        assert!(matches!(
            snapshot.outcomes.as_slice(),
            [DurePluginCatalogOutcomeV2::Conflict {
                plugin_id,
                candidates,
            }] if plugin_id.as_str() == "dure.beads" && candidates.len() == 2
        ));
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["outcomes"][0]["status"], "conflict");
        assert_eq!(wire["outcomes"][0]["plugin_id"], "dure.beads");
        assert_eq!(wire["outcomes"][0]["candidates"].as_array().unwrap().len(), 2);
        assert!(wire["outcomes"][0]["candidates"][0]
            .get("candidate_id")
            .is_some());
        assert!(legacy_catalog_projection(snapshot).unwrap().is_empty());
    }

    struct RejectedSiblingSource;

    impl PluginPackageSourceV2 for RejectedSiblingSource {
        fn load(&self) -> Vec<PluginPackageSourceCandidateV2> {
            vec![
                PluginPackageSourceCandidateV2::rejected(
                    PluginPackageCandidateIdV2::new("candidate.broken").unwrap(),
                    PluginPackageSourceErrorV2::new(
                        "failed below /Users/private/installed-plugin",
                    ),
                ),
                PluginPackageSourceCandidateV2::accepted(
                    PluginPackageCandidateIdV2::new("candidate.beads").unwrap(),
                    package(beads_manifest(), bundled_contribution_resources()),
                ),
            ]
        }
    }

    #[test]
    fn source_rejection_is_secret_free_and_does_not_hide_a_valid_sibling() {
        let registry = PluginPackageRegistryV2::from_sources(&[
            PluginPackageSourceRegistrationV2::new(
                PluginPackageSourceIdV2::new(BUNDLED_PLUGIN_SOURCE_ID).unwrap(),
                &RejectedSiblingSource,
            ),
        ]);

        let snapshot = catalog_snapshot_from_registry(&registry);
        assert!(matches!(
            snapshot.outcomes.as_slice(),
            [
                DurePluginCatalogOutcomeV2::Available { entry, .. },
                DurePluginCatalogOutcomeV2::Rejected {
                    manifest: None,
                    reason: DurePluginCatalogRejectionV2::SourceRejected,
                    ..
                }
            ] if entry.manifest.id.as_str() == "dure.beads"
        ));
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["outcomes"][1]["status"], "rejected");
        assert_eq!(wire["outcomes"][1]["manifest"], serde_json::Value::Null);
        assert_eq!(
            wire["outcomes"][1]["reason"],
            serde_json::json!({ "kind": "source_rejected" })
        );
        assert_eq!(
            wire["outcomes"][1]["identity"]["candidate_id"],
            "candidate.broken"
        );
        let serialized = serde_json::to_string(&wire).unwrap();
        assert!(!serialized.contains("/Users/private"));
    }

    #[test]
    fn settings_less_issue_tracker_view_without_setting_references_is_available() {
        let mut manifest = beads_manifest();
        manifest
            .contributions
            .retain(|contribution| contribution.family.as_str() != "dure.settings");
        let mut resources = bundled_contribution_resources();
        resources.remove(&PluginResourcePathV2::new("./contributions/settings.json").unwrap());
        let mut views: serde_json::Value = serde_json::from_slice(BUNDLED_BEADS_VIEWS).unwrap();
        views["views"][0]["default_query_setting_key"] = serde_json::Value::Null;
        views["views"][0]["watch_interval_setting_key"] = serde_json::Value::Null;
        views["views"][0]["agent_claims"] = serde_json::Value::Null;
        resources.insert(
            PluginResourcePathV2::new("./contributions/views.json").unwrap(),
            json_bytes(&views),
        );
        let registry = registry_with_packages(vec![package(manifest, resources)]);

        let snapshot = catalog_snapshot_from_registry(&registry);
        let [DurePluginCatalogOutcomeV2::Available { entry, .. }] =
            snapshot.outcomes.as_slice()
        else {
            panic!("settings-less view without setting references must remain available")
        };
        assert!(entry.settings_contribution.is_none());
        assert_eq!(entry.issue_tracker_contributions.len(), 1);
        assert_eq!(entry.view_contributions[0].views.views.len(), 1);
    }

    #[test]
    fn settings_less_view_may_not_reference_a_setting_key() {
        let mut manifest = beads_manifest();
        manifest
            .contributions
            .retain(|contribution| contribution.family.as_str() != "dure.settings");
        let mut resources = bundled_contribution_resources();
        resources.remove(&PluginResourcePathV2::new("./contributions/settings.json").unwrap());
        let registry = registry_with_packages(vec![package(manifest, resources)]);

        let snapshot = catalog_snapshot_from_registry(&registry);
        assert!(matches!(
            snapshot.outcomes.as_slice(),
            [DurePluginCatalogOutcomeV2::Rejected {
                manifest: Some(manifest),
                reason: DurePluginCatalogRejectionV2::InvalidContribution {
                    family: Some(family),
                    ..
                },
                ..
            }] if manifest.id.as_str() == "dure.beads" && family.as_str() == "dure.views"
        ));
    }

    #[test]
    fn catalog_settings_views_provider_and_claims_share_the_injected_snapshot() {
        let mut resources = bundled_contribution_resources();
        let mut settings: serde_json::Value = serde_json::from_slice(BUNDLED_BEADS_SETTINGS).unwrap();
        settings["settings"][3]["default"] = serde_json::Value::Bool(false);
        resources.insert(
            PluginResourcePathV2::new("./contributions/settings.json").unwrap(),
            json_bytes(&settings),
        );

        let mut provider: serde_json::Value =
            serde_json::from_slice(BUNDLED_BEADS_ISSUE_TRACKER).unwrap();
        provider["operations"]
            .as_array_mut()
            .unwrap()
            .retain(|operation| operation != "human");
        resources.insert(
            PluginResourcePathV2::new("./contributions/issue-tracker.json").unwrap(),
            json_bytes(&provider),
        );

        let mut views: serde_json::Value = serde_json::from_slice(BUNDLED_BEADS_VIEWS).unwrap();
        views["views"][0]["title"]["default"] = serde_json::Value::String("주입된 이슈".into());
        views["views"][0]["agent_claims"]["statuses"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::Value::String("blocked".into()));
        resources.insert(
            PluginResourcePathV2::new("./contributions/views.json").unwrap(),
            json_bytes(&views),
        );

        let registry = test_registry(beads_manifest(), resources, BUNDLED_PLUGIN_SOURCE_ID);
        let entry = catalog_from_test_registry(&registry).unwrap();
        assert!(
            entry
                .settings_contribution
                .as_ref()
                .unwrap()
                .schema
                .settings
                .iter()
                .any(|setting| matches!(
                    setting,
                    PluginSettingDefinitionV1::Boolean { key, default: false, .. }
                        if key.as_str() == "notifications"
                ))
        );
        assert!(
            !entry.issue_tracker_contributions[0]
                .provider
                .supports(IssueTrackerOperationV1::Human)
        );
        assert_eq!(
            entry.view_contributions[0].views.views[0]
                .title
                .default,
            "주입된 이슈"
        );
        assert_eq!(
            agent_claim_statuses(&entry, "dure.beads.issue-tracker"),
            ["blocked", "in_progress"]
        );
    }

    #[test]
    fn consumed_contribution_resources_fail_closed_when_missing() {
        for path in [
            "./contributions/settings.json",
            "./contributions/issue-tracker.json",
            "./contributions/views.json",
        ] {
            let mut resources = bundled_contribution_resources();
            resources.remove(&PluginResourcePathV2::new(path).unwrap());
            let mut manifest = beads_manifest();
            manifest
                .contributions
                .iter_mut()
                .find(|contribution| contribution.resource.as_str() == path)
                .unwrap()
                .required = false;
            let registry = test_registry(manifest, resources, BUNDLED_PLUGIN_SOURCE_ID);
            let error = catalog_from_test_registry(&registry)
                .expect_err("consumed resource must fail the catalog entry");
            assert!(error.contains("resource"), "unexpected error for {path}: {error}");
        }
    }

    #[test]
    fn unnegotiated_optional_resource_is_not_loaded() {
        let mut manifest = beads_manifest();
        manifest.contributions.push(ContributionDescriptorV2 {
            id: ContributionIdV2::new("dure.beads.future").unwrap(),
            family: ContributionFamilyIdV2::new("example.future").unwrap(),
            family_api: ContractVersionRangeV2::new(1, 1),
            required: false,
            placement: dure_app::PluginPlacementV2::Ui,
            resource: PluginResourcePathV2::new("./contributions/missing-future.json").unwrap(),
        });
        let registry = test_registry(
            manifest,
            bundled_contribution_resources(),
            BUNDLED_PLUGIN_SOURCE_ID,
        );

        let entry = catalog_from_test_registry(&registry).unwrap();
        let PluginCompatibilityOutcomeV2::Supported {
            ignored_optional_contributions,
            ..
        } = entry.compatibility
        else {
            panic!("fixture must remain compatible")
        };
        assert_eq!(
            ignored_optional_contributions,
            [ContributionIdV2::new("dure.beads.future").unwrap()]
        );
    }

    #[test]
    fn catalog_policy_comes_from_host_source_identity_not_manifest_publisher() {
        let (manifest, resources) =
            settings_only_manifest_and_resources("example.installed", "Installed");
        let registry = test_registry(
            manifest,
            resources,
            INSTALLED_PLUGIN_SOURCE_ID,
        );

        let entry = catalog_entry_for_test_registry(&registry, "example.installed").unwrap();
        let wire = serde_json::to_value(entry).unwrap();

        assert_eq!(wire["distribution"], "installed");
        assert_eq!(wire["installed"], true);
        assert_eq!(wire["removable"], true);
    }

    #[test]
    fn installed_source_policy_rejects_native_integrations_even_for_injected_packages() {
        let registry = test_registry(
            beads_manifest(),
            bundled_contribution_resources(),
            INSTALLED_PLUGIN_SOURCE_ID,
        );

        let error = catalog_from_test_registry(&registry)
            .expect_err("installed source policy must reject native integrations");

        assert!(error.contains("does not allow native agent integrations"));
    }

    #[test]
    fn scoped_file_names_do_not_retain_workspace_or_profile_identity() {
        let workspace = settings_file_name(
            &PluginSettingScopeV1::Workspace,
            Some("/Users/example/private-project"),
        );
        assert!(workspace.starts_with("workspace-"));
        assert!(!workspace.contains("example"));
        assert!(!workspace.contains("private-project"));
    }

    #[test]
    fn non_beads_catalog_package_round_trips_user_and_workspace_settings() {
        let registry = registry_with_packages(vec![settings_only_package(
            "example.preferences",
            "Example preferences",
        )]);
        let root = tempfile::tempdir().unwrap();
        let target = settings_target(&registry, "example.preferences");
        let notifications = PluginSettingKeyV1::new("notifications").unwrap();
        let watch_interval = PluginSettingKeyV1::new("watch_interval_seconds").unwrap();

        let mut user = read_snapshot(
            &registry,
            root.path(),
            target.clone(),
            PluginSettingScopeV1::User,
            None,
        )
        .unwrap();
        assert_eq!(
            user.values.get(&notifications),
            Some(&PluginSettingValueV1::Boolean(true))
        );
        user.values
            .insert(notifications.clone(), PluginSettingValueV1::Boolean(false));
        let saved_user = save_snapshot(&registry, root.path(), user).unwrap();
        assert_eq!(
            saved_user.values.get(&notifications),
            Some(&PluginSettingValueV1::Boolean(false))
        );

        let mut workspace = read_snapshot(
            &registry,
            root.path(),
            target,
            PluginSettingScopeV1::Workspace,
            Some("workspace-a".to_owned()),
        )
        .unwrap();
        assert_eq!(
            workspace.values.get(&watch_interval),
            Some(&PluginSettingValueV1::Integer(30))
        );
        workspace
            .values
            .insert(watch_interval.clone(), PluginSettingValueV1::Integer(45));
        let saved_workspace = save_snapshot(&registry, root.path(), workspace).unwrap();
        assert_eq!(
            saved_workspace.values.get(&watch_interval),
            Some(&PluginSettingValueV1::Integer(45))
        );
    }

    #[test]
    fn unknown_and_settings_less_packages_fail_without_creating_storage() {
        let mut manifest = renamed_beads_manifest("example.agent-only", "Agent only");
        manifest.contributions.clear();
        manifest.permissions.clear();
        let registry = registry_with_packages(vec![package(manifest, BTreeMap::new())]);
        let root = tempfile::tempdir().unwrap();
        let package = registry
            .package(&PluginIdV2::new("example.agent-only").unwrap())
            .unwrap();
        let settings_less_target = package_settings_target(
            package,
            ContributionIdV2::new("example.agent-only.settings").unwrap(),
        );

        let settings_less = read_snapshot(
            &registry,
            root.path(),
            settings_less_target.clone(),
            PluginSettingScopeV1::User,
            None,
        )
        .unwrap_err();
        assert!(settings_less.contains("does not declare settings"));

        let unknown_target = DurePluginSettingsTargetV2 {
            plugin_id: PluginIdV2::new("example.unknown").unwrap(),
            ..settings_less_target
        };
        let unknown = read_snapshot(
            &registry,
            root.path(),
            unknown_target,
            PluginSettingScopeV1::User,
            None,
        )
        .unwrap_err();
        assert!(unknown.contains("example.unknown"));
        assert!(!root.path().join(SETTINGS_DIRECTORY).exists());
    }

    #[test]
    fn mismatched_package_settings_identity_fails_before_creating_storage() {
        let registry = registry_with_packages(vec![settings_only_package(
            "example.preferences",
            "Example preferences",
        )]);
        let target = settings_target(&registry, "example.preferences");
        let mismatched = [
            DurePluginSettingsTargetV2 {
                identity: DurePluginCatalogCandidateIdentityV2 {
                    candidate_id: "package.other".to_owned(),
                    ..target.identity.clone()
                },
                ..target.clone()
            },
            DurePluginSettingsTargetV2 {
                version: PluginVersionV2::new("9.0.0").unwrap(),
                ..target.clone()
            },
            DurePluginSettingsTargetV2 {
                contribution_id: ContributionIdV2::new("example.preferences.other").unwrap(),
                ..target
            },
        ];

        for target in mismatched {
            let root = tempfile::tempdir().unwrap();
            let error = read_snapshot(
                &registry,
                root.path(),
                target,
                PluginSettingScopeV1::User,
                None,
            )
            .unwrap_err();
            assert!(error.contains("does not match"));
            assert!(!root.path().join(SETTINGS_DIRECTORY).exists());
        }
    }

    #[test]
    fn unregistered_local_workspace_uses_host_identity_and_persists_claim_policy() {
        let settings_root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let target = settings_target(bundled_plugin_registry(), "dure.beads");
        let workspace_identity = PluginWorkspaceIdentityV2::from_host_hmac(format!(
            "sha256:{}",
            "b".repeat(64)
        ))
        .unwrap();
        let resolved = authoritative_workspace_scope(
            None,
            &workspace_identity,
            workspace.path(),
        )
        .unwrap();
        assert_eq!(
            resolved.scope_key.as_deref(),
            Some(workspace_identity.as_str())
        );
        assert_eq!(
            resolved.canonical_workspace_root.as_deref(),
            Some(workspace.path())
        );
        assert!(authoritative_workspace_scope(
            Some(format!("sha256:{}", "c".repeat(64))),
            &workspace_identity,
            workspace.path(),
        )
        .is_err());

        let mut snapshot = read_snapshot(
            bundled_plugin_registry(),
            settings_root.path(),
            target.clone(),
            PluginSettingScopeV1::Workspace,
            resolved.scope_key.clone(),
        )
        .unwrap();

        assert_eq!(snapshot.scope_key, resolved.scope_key);
        assert_eq!(snapshot.settings_revision, "0");
        assert_eq!(
            snapshot
                .values
                .get(&PluginSettingKeyV1::new("show_agent_claims").unwrap()),
            Some(&PluginSettingValueV1::Boolean(true))
        );
        snapshot.values.insert(
            PluginSettingKeyV1::new("show_agent_claims").unwrap(),
            PluginSettingValueV1::Boolean(false),
        );
        let saved = save_snapshot(
            bundled_plugin_registry(),
            settings_root.path(),
            snapshot,
        )
        .unwrap();
        assert_eq!(saved.settings_revision, "1");
        assert_eq!(
            saved
                .values
                .get(&PluginSettingKeyV1::new("show_agent_claims").unwrap()),
            Some(&PluginSettingValueV1::Boolean(false))
        );
        let policy_update = resolved_agent_claim_policy_update(
            &saved,
            resolved.canonical_workspace_root.as_deref(),
        )
        .unwrap();
        let epochs = apply_agent_claim_policy_update(
            &DureIssueTrackerState::default(),
            "dure.beads",
            policy_update,
        )
        .unwrap();
        assert!(epochs.contains_key("dure.beads.issue-tracker"));
        let reloaded = read_snapshot(
            bundled_plugin_registry(),
            settings_root.path(),
            target,
            PluginSettingScopeV1::Workspace,
            Some(workspace_identity.as_str().to_owned()),
        )
        .unwrap();
        assert_eq!(reloaded.settings_revision, "1");
        assert_eq!(
            reloaded
                .values
                .get(&PluginSettingKeyV1::new("show_agent_claims").unwrap()),
            Some(&PluginSettingValueV1::Boolean(false))
        );
    }

    #[test]
    fn legacy_local_workspace_hint_cannot_select_another_workspaces_settings() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let target = settings_target(bundled_plugin_registry(), "dure.beads");
        let legacy_scope_key = "local:local:other-workspace";
        let show_agent_claims = PluginSettingKeyV1::new("show_agent_claims").unwrap();
        let legacy_path = settings_path(
            root.path(),
            &target.plugin_id,
            &PluginSettingScopeV1::Workspace,
            Some(legacy_scope_key),
        );
        let legacy_bytes = b"not-json-from-another-workspace\n".to_vec();
        write_owner_only(&legacy_path, &legacy_bytes).unwrap();

        let workspace_identity = PluginWorkspaceIdentityV2::from_host_hmac(format!(
            "sha256:{}",
            "d".repeat(64)
        ))
        .unwrap();
        let resolved = authoritative_workspace_scope(
            Some(legacy_scope_key.into()),
            &workspace_identity,
            workspace.path(),
        )
        .unwrap();

        let resolved_snapshot = read_resolved_snapshot(
            bundled_plugin_registry(),
            root.path(),
            target.clone(),
            PluginSettingScopeV1::Workspace,
            &resolved,
        )
        .unwrap();
        assert_eq!(
            resolved_snapshot.scope_key.as_deref(),
            Some(workspace_identity.as_str())
        );
        assert_eq!(resolved_snapshot.settings_revision, "0");
        assert_eq!(
            resolved_snapshot.values.get(&show_agent_claims),
            Some(&PluginSettingValueV1::Boolean(true))
        );
        assert!(legacy_path.exists());
        assert_eq!(std::fs::read(&legacy_path).unwrap(), legacy_bytes);

        let canonical_path = settings_path(
            root.path(),
            &target.plugin_id,
            &PluginSettingScopeV1::Workspace,
            Some(workspace_identity.as_str()),
        );
        assert!(!canonical_path.exists());
    }

    #[test]
    fn stale_settings_revision_is_rejected_before_policy_publication() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let target = settings_target(bundled_plugin_registry(), "dure.beads");
        let workspace_identity = PluginWorkspaceIdentityV2::from_host_hmac(format!(
            "sha256:{}",
            "e".repeat(64)
        ))
        .unwrap();
        let mut current = read_snapshot(
            bundled_plugin_registry(),
            root.path(),
            target.clone(),
            PluginSettingScopeV1::Workspace,
            Some(workspace_identity.as_str().to_owned()),
        )
        .unwrap();
        current.values.insert(
            PluginSettingKeyV1::new("show_agent_claims").unwrap(),
            PluginSettingValueV1::Boolean(false),
        );
        let current = save_snapshot(bundled_plugin_registry(), root.path(), current).unwrap();
        let tracker = DureIssueTrackerState::default();
        let current_update = resolved_agent_claim_policy_update(
            &current,
            Some(workspace.path()),
        )
        .unwrap();
        let current_epoch = apply_agent_claim_policy_update(
            &tracker,
            "dure.beads",
            current_update,
        )
        .unwrap()["dure.beads.issue-tracker"];

        let mut stale = current.clone();
        stale.settings_revision = "0".into();
        stale.values.insert(
            PluginSettingKeyV1::new("show_agent_claims").unwrap(),
            PluginSettingValueV1::Boolean(true),
        );
        let stale_result = (|| {
            ensure_settings_revision_matches(&stale, &current)?;
            apply_agent_claim_policy_update(
                &tracker,
                "dure.beads",
                resolved_agent_claim_policy_update(&stale, Some(workspace.path()))?,
            )
        })();
        assert_eq!(stale_result.unwrap_err(), "plugin settings revision conflict");
        let unchanged_epoch = apply_agent_claim_policy_update(
            &tracker,
            "dure.beads",
            resolved_agent_claim_policy_update(&current, Some(workspace.path())).unwrap(),
        )
        .unwrap()["dure.beads.issue-tracker"];
        assert_eq!(unchanged_epoch, current_epoch);
        let reloaded = read_snapshot(
            bundled_plugin_registry(),
            root.path(),
            target,
            PluginSettingScopeV1::Workspace,
            Some(workspace_identity.as_str().to_owned()),
        )
        .unwrap();
        assert_eq!(reloaded.settings_revision, "1");
        assert_eq!(
            reloaded
                .values
                .get(&PluginSettingKeyV1::new("show_agent_claims").unwrap()),
            Some(&PluginSettingValueV1::Boolean(false))
        );
    }

    #[test]
    fn settings_round_trip_defaults_and_reject_invalid_values() {
        let root = tempfile::tempdir().unwrap();
        let target = settings_target(bundled_plugin_registry(), "dure.beads");
        let initial = read_snapshot(
            bundled_plugin_registry(),
            root.path(),
            target.clone(),
            PluginSettingScopeV1::User,
            None,
        )
        .unwrap();
        assert_eq!(
            initial
                .values
                .get(&PluginSettingKeyV1::new("notifications").unwrap()),
            Some(&PluginSettingValueV1::Boolean(true))
        );

        let mut updated = initial;
        updated.values.insert(
            PluginSettingKeyV1::new("notifications").unwrap(),
            PluginSettingValueV1::Boolean(false),
        );
        let saved = save_snapshot(bundled_plugin_registry(), root.path(), updated).unwrap();
        assert_eq!(
            saved
                .values
                .get(&PluginSettingKeyV1::new("notifications").unwrap()),
            Some(&PluginSettingValueV1::Boolean(false))
        );

        let invalid = DurePluginSettingsSnapshot {
            target,
            scope: PluginSettingScopeV1::User,
            scope_key: None,
            values: BTreeMap::from([(
                PluginSettingKeyV1::new("notifications").unwrap(),
                PluginSettingValueV1::String("yes".to_owned()),
            )]),
            settings_revision: "0".into(),
            agent_claim_policy_epochs: BTreeMap::new(),
        };
        assert!(save_snapshot(bundled_plugin_registry(), root.path(), invalid).is_err());
    }

    #[test]
    fn saved_snapshot_return_is_canonicalized_from_validated_values() {
        let root = tempfile::tempdir().unwrap();
        let target = settings_target(bundled_plugin_registry(), "dure.beads");
        let notifications = PluginSettingKeyV1::new("notifications").unwrap();
        let snapshot = DurePluginSettingsSnapshot {
            target: target.clone(),
            scope: PluginSettingScopeV1::User,
            scope_key: None,
            values: BTreeMap::from([(
                notifications.clone(),
                PluginSettingValueV1::Boolean(false),
            )]),
            settings_revision: "0".into(),
            agent_claim_policy_epochs: BTreeMap::from([(
                "dure.beads.issue-tracker".to_owned(),
                41,
            )]),
        };

        let saved = save_snapshot(bundled_plugin_registry(), root.path(), snapshot).unwrap();

        assert_eq!(
            saved.values.get(&notifications),
            Some(&PluginSettingValueV1::Boolean(false))
        );
        assert_eq!(saved.values.len(), 3);
        assert!(saved.agent_claim_policy_epochs.is_empty());
        assert_eq!(
            read_snapshot(
                bundled_plugin_registry(),
                root.path(),
                target,
                PluginSettingScopeV1::User,
                None,
            )
            .unwrap(),
            saved
        );
}
}
