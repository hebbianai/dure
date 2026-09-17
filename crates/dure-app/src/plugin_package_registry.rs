//! Immutable declarative plugin package catalogs selected for one active generation.
//!
//! Host-owned source IDs carry distribution policy; manifests cannot declare themselves
//! bundled or removable. Duplicate plugin IDs quarantine every candidate for that ID while
//! unrelated packages remain available. Resource bytes are materialized into each package
//! snapshot and are resolved only by exact plugin, contribution, family, and declared path.
//! Every source outcome also carries a bounded source-local candidate ID, so rejection and
//! conflict diagnostics never depend on parsing a human error message.
//!
//! The legacy catalog digest intentionally owns declarative contribution bytes only. A snapshot
//! may additionally carry a distinct embedded-package authority that covers the exact manifest,
//! contribution, and agent-integration bytes used for native installation. The two digests are
//! deliberately non-interchangeable: catalog approval does not grant native package authority.
//! Optional contributions that the host does not negotiate remain opaque and are never decoded
//! here.

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
    sync::Arc,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::{
    AgentAdapterIdV2, AgentIntegrationDescriptorV2, AgentIntegrationIdV2, ContributionDescriptorV2,
    ContributionFamilyIdV2, ContributionIdV2, PluginIdV2, PluginManifestV2, PluginResourcePathV2,
    PluginVersionV2, StableIdError,
};

pub const MAX_EMBEDDED_PLUGIN_PACKAGE_FILES_V2: usize = 512;
pub const MAX_EMBEDDED_PLUGIN_PACKAGE_FILE_BYTES_V2: usize = 1024 * 1024;
pub const MAX_EMBEDDED_PLUGIN_PACKAGE_BYTES_V2: usize = 16 * 1024 * 1024;
const EMBEDDED_PLUGIN_MANIFEST_PATH_V2: &str = "./dure-plugin.json";

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[ts(type = "string")]
pub struct PluginPackageSourceIdV2(String);

impl PluginPackageSourceIdV2 {
    pub fn new(value: impl Into<String>) -> Result<Self, StableIdError> {
        let value = value.into();
        PluginIdV2::new(value.clone())?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[ts(type = "string")]
pub struct PluginPackageCandidateIdV2(String);

impl PluginPackageCandidateIdV2 {
    pub fn new(value: impl Into<String>) -> Result<Self, StableIdError> {
        let value = value.into();
        PluginIdV2::new(value.clone())?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[ts(type = "string")]
pub struct PluginBundledAuthorityIdV2(String);

impl PluginBundledAuthorityIdV2 {
    fn new(value: impl Into<String>) -> Result<Self, StableIdError> {
        let value = value.into();
        PluginIdV2::new(value.clone())?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// SHA-256 of the canonical manifest and materialized declarative contribution resources only.
///
/// This digest does not cover agent-integration directory bytes and is not a whole-package
/// verifier. Native agent integration installation requires a future exact tree verifier.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[ts(type = "string")]
pub struct PluginCatalogSnapshotSha256V2(String);

impl PluginCatalogSnapshotSha256V2 {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// SHA-256 of the exact embedded package bytes and their agent-integration partition.
///
/// This is native package authority. It is intentionally distinct from catalog approval and from
/// a runtime materialization receipt.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct PluginPackageEmbeddedAuthoritySha256V2(String);

impl PluginPackageEmbeddedAuthoritySha256V2 {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// SHA-256 of the exact package-relative file paths and bytes in an embedded package image.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct PluginPackageEmbeddedFileManifestSha256V2(String);

impl PluginPackageEmbeddedFileManifestSha256V2 {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone)]
pub struct PluginAgentIntegrationResourceTreeV2 {
    files: BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
}

impl PluginAgentIntegrationResourceTreeV2 {
    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn files(&self) -> impl ExactSizeIterator<Item = (&PluginResourcePathV2, &[u8])> {
        self.files
            .iter()
            .map(|(path, bytes)| (path, bytes.as_ref()))
    }
}

#[derive(Clone)]
pub struct PluginPackageEmbeddedAuthorityV2 {
    integrations: BTreeMap<AgentIntegrationIdV2, PluginAgentIntegrationResourceTreeV2>,
    package_files: BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
    sha256: PluginPackageEmbeddedAuthoritySha256V2,
    file_manifest_sha256: PluginPackageEmbeddedFileManifestSha256V2,
}

impl PluginPackageEmbeddedAuthorityV2 {
    pub fn sha256(&self) -> &PluginPackageEmbeddedAuthoritySha256V2 {
        &self.sha256
    }

    pub fn file_manifest_sha256(&self) -> &PluginPackageEmbeddedFileManifestSha256V2 {
        &self.file_manifest_sha256
    }

    pub fn package_file_count(&self) -> usize {
        self.package_files.len()
    }

    pub fn package_files(&self) -> impl ExactSizeIterator<Item = (&PluginResourcePathV2, &[u8])> {
        self.package_files
            .iter()
            .map(|(path, bytes)| (path, bytes.as_ref()))
    }

    pub fn integration_resource_tree(
        &self,
        integration_id: &AgentIntegrationIdV2,
    ) -> Option<&PluginAgentIntegrationResourceTreeV2> {
        self.integrations.get(integration_id)
    }
}

#[derive(Clone)]
pub struct PluginPackageCatalogSnapshotV2 {
    manifest: PluginManifestV2,
    contribution_resources: BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
    catalog_snapshot_sha256: PluginCatalogSnapshotSha256V2,
    embedded_authority: Option<PluginPackageEmbeddedAuthorityV2>,
}

impl PluginPackageCatalogSnapshotV2 {
    pub fn try_new(
        manifest: PluginManifestV2,
        contribution_resources: BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
    ) -> Result<Self, PluginPackageRegistryErrorV2> {
        manifest
            .validate()
            .map_err(|error| PluginPackageRegistryErrorV2::InvalidManifest {
                plugin_id: manifest.id.clone(),
                message: error.to_string(),
            })?;
        if let Some(contribution) = manifest.contributions.iter().find(|contribution| {
            contribution.required && !contribution_resources.contains_key(&contribution.resource)
        }) {
            return Err(PluginPackageRegistryErrorV2::ResourceUnavailable {
                plugin_id: manifest.id.clone(),
                contribution_id: contribution.id.clone(),
                resource: contribution.resource.clone(),
            });
        }
        let catalog_snapshot_sha256 =
            match catalog_snapshot_sha256(&manifest, &contribution_resources) {
                Ok(digest) => digest,
                Err(error) => {
                    return Err(PluginPackageRegistryErrorV2::InvalidManifest {
                        plugin_id: manifest.id.clone(),
                        message: format!("failed to canonicalize catalog snapshot: {error}"),
                    });
                }
            };
        Ok(Self {
            manifest,
            contribution_resources,
            catalog_snapshot_sha256,
            embedded_authority: None,
        })
    }

    /// Builds a snapshot whose native package image is made entirely from owned immutable bytes.
    ///
    /// Agent resource paths are relative to their declared integration resource root. The exact
    /// integration set must match the manifest, including optional integrations.
    pub fn try_new_with_embedded_package(
        manifest_bytes: Arc<[u8]>,
        contribution_resources: BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
        agent_resources: BTreeMap<AgentIntegrationIdV2, BTreeMap<PluginResourcePathV2, Arc<[u8]>>>,
    ) -> Result<Self, PluginPackageRegistryErrorV2> {
        if manifest_bytes.len() > MAX_EMBEDDED_PLUGIN_PACKAGE_FILE_BYTES_V2 {
            return Err(PluginPackageRegistryErrorV2::EmbeddedManifestTooLarge {
                maximum_bytes: MAX_EMBEDDED_PLUGIN_PACKAGE_FILE_BYTES_V2,
            });
        }
        let manifest =
            serde_json::from_slice::<PluginManifestV2>(&manifest_bytes).map_err(|error| {
                PluginPackageRegistryErrorV2::EmbeddedManifestInvalid {
                    message: error.to_string(),
                }
            })?;
        preflight_embedded_package_limits(
            &manifest,
            &manifest_bytes,
            &contribution_resources,
            &agent_resources,
        )?;
        let mut snapshot = Self::try_new(manifest, contribution_resources)?;
        snapshot.embedded_authority = Some(embedded_package_authority(
            &snapshot.manifest,
            snapshot.catalog_snapshot_sha256(),
            manifest_bytes,
            &snapshot.contribution_resources,
            agent_resources,
        )?);
        Ok(snapshot)
    }

    pub fn manifest(&self) -> &PluginManifestV2 {
        &self.manifest
    }

    pub fn contribution_resource_count(&self) -> usize {
        self.contribution_resources.len()
    }

    pub fn catalog_snapshot_sha256(&self) -> &PluginCatalogSnapshotSha256V2 {
        &self.catalog_snapshot_sha256
    }

    pub fn embedded_authority(&self) -> Option<&PluginPackageEmbeddedAuthorityV2> {
        self.embedded_authority.as_ref()
    }

    fn contribution_resource(&self, path: &PluginResourcePathV2) -> Option<&[u8]> {
        self.contribution_resources.get(path).map(AsRef::as_ref)
    }

    fn catalog_resource_fingerprints(&self) -> Vec<PluginCatalogResourceFingerprintV2> {
        self.contribution_resources
            .iter()
            .map(|(resource, bytes)| PluginCatalogResourceFingerprintV2 {
                resource: resource.clone(),
                sha256: format!("sha256:{:x}", Sha256::digest(bytes)),
            })
            .collect()
    }
}

/// Read-only fingerprint of one declarative catalog resource.
///
/// It covers only the exact resource bytes and carries no native installation authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginCatalogResourceFingerprintV2 {
    resource: PluginResourcePathV2,
    sha256: String,
}

impl PluginCatalogResourceFingerprintV2 {
    pub fn resource(&self) -> &PluginResourcePathV2 {
        &self.resource
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

fn catalog_snapshot_sha256(
    manifest: &PluginManifestV2,
    contribution_resources: &BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
) -> Result<PluginCatalogSnapshotSha256V2, serde_json::Error> {
    let mut canonical_manifest = manifest.clone();
    canonical_manifest.activation.sort();
    canonical_manifest.contributions.sort();
    canonical_manifest.agent_integrations.sort();
    for permission in &mut canonical_manifest.permissions {
        for values in permission.parameters.values_mut() {
            values.sort();
        }
    }
    canonical_manifest.permissions.sort();
    let manifest_json = serde_json::to_vec(&canonical_manifest)?;

    let mut digest = Sha256::new();
    digest.update(b"dure.plugin.catalog-snapshot.v2\0");
    update_digest_bytes(&mut digest, &manifest_json);
    digest.update((contribution_resources.len() as u64).to_be_bytes());
    for (path, bytes) in contribution_resources {
        update_digest_bytes(&mut digest, path.as_str().as_bytes());
        update_digest_bytes(&mut digest, bytes);
    }
    Ok(PluginCatalogSnapshotSha256V2(format!(
        "sha256:{:x}",
        digest.finalize()
    )))
}

fn update_digest_bytes(digest: &mut Sha256, value: &[u8]) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value);
}

fn embedded_package_authority(
    manifest: &PluginManifestV2,
    catalog_snapshot_sha256: &PluginCatalogSnapshotSha256V2,
    manifest_bytes: Arc<[u8]>,
    contribution_resources: &BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
    mut agent_resources: BTreeMap<AgentIntegrationIdV2, BTreeMap<PluginResourcePathV2, Arc<[u8]>>>,
) -> Result<PluginPackageEmbeddedAuthorityV2, PluginPackageRegistryErrorV2> {
    let descriptors = manifest
        .agent_integrations
        .iter()
        .map(|descriptor| (descriptor.id.clone(), descriptor))
        .collect::<BTreeMap<_, _>>();
    for integration_id in descriptors.keys() {
        if !agent_resources.contains_key(integration_id) {
            return Err(
                PluginPackageRegistryErrorV2::EmbeddedAgentResourcesUnavailable {
                    plugin_id: manifest.id.clone(),
                    integration_id: integration_id.clone(),
                },
            );
        }
    }
    if let Some(integration_id) = agent_resources
        .keys()
        .find(|integration_id| !descriptors.contains_key(*integration_id))
    {
        return Err(
            PluginPackageRegistryErrorV2::UndeclaredEmbeddedAgentResources {
                plugin_id: manifest.id.clone(),
                integration_id: integration_id.clone(),
            },
        );
    }

    let ordered_descriptors = descriptors.values().copied().collect::<Vec<_>>();
    for (index, left) in ordered_descriptors.iter().enumerate() {
        for right in &ordered_descriptors[index + 1..] {
            if resource_paths_conflict(&left.resource, &right.resource) {
                return Err(invalid_embedded_tree(
                    manifest,
                    format!(
                        "integration roots {} and {} overlap",
                        left.resource.as_str(),
                        right.resource.as_str()
                    ),
                ));
            }
        }
    }

    let embedded_manifest_path = PluginResourcePathV2::new(EMBEDDED_PLUGIN_MANIFEST_PATH_V2)
        .expect("embedded manifest path is static and valid");
    for descriptor in &ordered_descriptors {
        if let Some(non_integration_path) = std::iter::once(&embedded_manifest_path)
            .chain(contribution_resources.keys())
            .find(|path| resource_paths_conflict(&descriptor.resource, path))
        {
            return Err(invalid_embedded_tree(
                manifest,
                format!(
                    "integration root {} overlaps non-integration package file {}",
                    descriptor.resource.as_str(),
                    non_integration_path.as_str()
                ),
            ));
        }
    }

    let mut package_files = BTreeMap::new();
    insert_embedded_package_file(
        manifest,
        &mut package_files,
        embedded_manifest_path,
        manifest_bytes,
    )?;
    for (path, bytes) in contribution_resources {
        insert_embedded_package_file(
            manifest,
            &mut package_files,
            path.clone(),
            Arc::clone(bytes),
        )?;
    }

    let mut integrations = BTreeMap::new();
    for (integration_id, descriptor) in descriptors {
        let files = agent_resources
            .remove(&integration_id)
            .expect("the exact integration set was validated above");
        if files.is_empty() {
            return Err(invalid_embedded_tree(
                manifest,
                format!(
                    "integration {} has an empty resource tree",
                    integration_id.as_str()
                ),
            ));
        }
        let paths = files.keys().collect::<Vec<_>>();
        for (index, left) in paths.iter().enumerate() {
            for right in &paths[index + 1..] {
                if resource_paths_conflict(left, right) {
                    return Err(invalid_embedded_tree(
                        manifest,
                        format!(
                            "integration {} paths {} and {} overlap",
                            integration_id.as_str(),
                            left.as_str(),
                            right.as_str()
                        ),
                    ));
                }
            }
        }
        for (relative_path, bytes) in &files {
            let package_path = join_plugin_resource_paths(&descriptor.resource, relative_path)
                .map_err(|message| invalid_embedded_tree(manifest, message))?;
            insert_embedded_package_file(
                manifest,
                &mut package_files,
                package_path,
                Arc::clone(bytes),
            )?;
        }
        integrations.insert(
            integration_id,
            PluginAgentIntegrationResourceTreeV2 { files },
        );
    }
    let file_manifest_sha256 = embedded_file_manifest_sha256(&package_files);
    let sha256 = embedded_authority_sha256(
        manifest,
        catalog_snapshot_sha256,
        &file_manifest_sha256,
        &integrations,
    );
    Ok(PluginPackageEmbeddedAuthorityV2 {
        integrations,
        package_files,
        sha256,
        file_manifest_sha256,
    })
}

fn insert_embedded_package_file(
    manifest: &PluginManifestV2,
    package_files: &mut BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
    path: PluginResourcePathV2,
    bytes: Arc<[u8]>,
) -> Result<(), PluginPackageRegistryErrorV2> {
    if let Some(existing) = package_files
        .keys()
        .find(|existing| resource_paths_conflict(existing, &path))
    {
        return Err(invalid_embedded_tree(
            manifest,
            format!(
                "package paths {} and {} overlap",
                existing.as_str(),
                path.as_str()
            ),
        ));
    }
    package_files.insert(path, bytes);
    Ok(())
}

fn join_plugin_resource_paths(
    root: &PluginResourcePathV2,
    relative: &PluginResourcePathV2,
) -> Result<PluginResourcePathV2, String> {
    let joined = format!(
        "{}/{}",
        root.as_str().trim_end_matches('/'),
        relative
            .as_str()
            .strip_prefix("./")
            .expect("PluginResourcePathV2 always begins with ./")
    );
    PluginResourcePathV2::new(joined).map_err(|error| error.to_string())
}

fn resource_paths_conflict(left: &PluginResourcePathV2, right: &PluginResourcePathV2) -> bool {
    resource_path_contains(left.as_str(), right.as_str())
        || resource_path_contains(right.as_str(), left.as_str())
}

fn resource_path_contains(parent: &str, child: &str) -> bool {
    child == parent
        || child
            .strip_prefix(parent)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn preflight_embedded_package_limits(
    manifest: &PluginManifestV2,
    manifest_bytes: &[u8],
    contribution_resources: &BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
    agent_resources: &BTreeMap<AgentIntegrationIdV2, BTreeMap<PluginResourcePathV2, Arc<[u8]>>>,
) -> Result<(), PluginPackageRegistryErrorV2> {
    let exceeded = |limit| PluginPackageRegistryErrorV2::EmbeddedPackageResourceLimitExceeded {
        plugin_id: manifest.id.clone(),
        limit,
    };
    if contribution_resources.len() > MAX_EMBEDDED_PLUGIN_PACKAGE_FILES_V2
        || agent_resources.len() > MAX_EMBEDDED_PLUGIN_PACKAGE_FILES_V2
    {
        return Err(exceeded("file_count"));
    }
    let mut file_count = 1usize
        .checked_add(contribution_resources.len())
        .ok_or_else(|| exceeded("file_count"))?;
    for files in agent_resources.values() {
        file_count = file_count
            .checked_add(files.len())
            .ok_or_else(|| exceeded("file_count"))?;
        if file_count > MAX_EMBEDDED_PLUGIN_PACKAGE_FILES_V2 {
            return Err(exceeded("file_count"));
        }
    }
    if file_count > MAX_EMBEDDED_PLUGIN_PACKAGE_FILES_V2 {
        return Err(exceeded("file_count"));
    }

    let mut total_bytes = 0usize;
    let mut account = |bytes: &[u8]| {
        if bytes.len() > MAX_EMBEDDED_PLUGIN_PACKAGE_FILE_BYTES_V2 {
            return Err(exceeded("file_bytes"));
        }
        total_bytes = total_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| exceeded("total_bytes"))?;
        if total_bytes > MAX_EMBEDDED_PLUGIN_PACKAGE_BYTES_V2 {
            return Err(exceeded("total_bytes"));
        }
        Ok(())
    };
    account(manifest_bytes)?;
    for bytes in contribution_resources.values() {
        account(bytes)?;
    }
    for files in agent_resources.values() {
        for bytes in files.values() {
            account(bytes)?;
        }
    }
    Ok(())
}

fn embedded_file_manifest_sha256(
    package_files: &BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
) -> PluginPackageEmbeddedFileManifestSha256V2 {
    let mut digest = Sha256::new();
    digest.update(b"dure.plugin.embedded-file-manifest.v1\0");
    digest.update((package_files.len() as u64).to_be_bytes());
    for (path, bytes) in package_files {
        update_digest_bytes(&mut digest, path.as_str().as_bytes());
        update_digest_bytes(&mut digest, bytes);
    }
    PluginPackageEmbeddedFileManifestSha256V2(format!("sha256:{:x}", digest.finalize()))
}

fn embedded_authority_sha256(
    manifest: &PluginManifestV2,
    catalog_snapshot_sha256: &PluginCatalogSnapshotSha256V2,
    file_manifest_sha256: &PluginPackageEmbeddedFileManifestSha256V2,
    integrations: &BTreeMap<AgentIntegrationIdV2, PluginAgentIntegrationResourceTreeV2>,
) -> PluginPackageEmbeddedAuthoritySha256V2 {
    let descriptors = manifest
        .agent_integrations
        .iter()
        .map(|descriptor| (&descriptor.id, descriptor))
        .collect::<BTreeMap<_, _>>();
    let mut digest = Sha256::new();
    digest.update(b"dure.plugin.embedded-package-authority.v1\0");
    update_digest_bytes(&mut digest, manifest.id.as_str().as_bytes());
    update_digest_bytes(&mut digest, manifest.version.as_str().as_bytes());
    update_digest_bytes(&mut digest, catalog_snapshot_sha256.as_str().as_bytes());
    update_digest_bytes(&mut digest, file_manifest_sha256.as_str().as_bytes());
    digest.update((integrations.len() as u64).to_be_bytes());
    for (integration_id, tree) in integrations {
        let descriptor = descriptors
            .get(integration_id)
            .expect("embedded integration descriptors were validated");
        update_digest_bytes(&mut digest, integration_id.as_str().as_bytes());
        update_digest_bytes(&mut digest, descriptor.adapter.as_str().as_bytes());
        update_digest_bytes(&mut digest, descriptor.resource.as_str().as_bytes());
        digest.update((tree.files.len() as u64).to_be_bytes());
        for (path, bytes) in &tree.files {
            update_digest_bytes(&mut digest, path.as_str().as_bytes());
            update_digest_bytes(&mut digest, bytes);
        }
    }
    PluginPackageEmbeddedAuthoritySha256V2(format!("sha256:{:x}", digest.finalize()))
}

fn invalid_embedded_tree(
    manifest: &PluginManifestV2,
    message: String,
) -> PluginPackageRegistryErrorV2 {
    PluginPackageRegistryErrorV2::InvalidEmbeddedPackageResourceTree {
        plugin_id: manifest.id.clone(),
        message,
    }
}

pub struct PluginPackageSourceCandidateV2 {
    candidate_id: PluginPackageCandidateIdV2,
    outcome: Result<PluginPackageCatalogSnapshotV2, PluginPackageSourceErrorV2>,
}

impl PluginPackageSourceCandidateV2 {
    pub fn accepted(
        candidate_id: PluginPackageCandidateIdV2,
        snapshot: PluginPackageCatalogSnapshotV2,
    ) -> Self {
        Self {
            candidate_id,
            outcome: Ok(snapshot),
        }
    }

    pub fn rejected(
        candidate_id: PluginPackageCandidateIdV2,
        error: PluginPackageSourceErrorV2,
    ) -> Self {
        Self {
            candidate_id,
            outcome: Err(error),
        }
    }

    pub fn candidate_id(&self) -> &PluginPackageCandidateIdV2 {
        &self.candidate_id
    }
}

pub trait PluginPackageSourceV2: Send + Sync {
    /// Materializes this source once for the catalog generation being built.
    ///
    /// Implementations must return owned immutable bytes. Sources reading untrusted storage are
    /// responsible for verification and input limits before constructing a snapshot.
    fn load(&self) -> Vec<PluginPackageSourceCandidateV2>;
}

pub struct PluginPackageSourceRegistrationV2<'a> {
    source_id: PluginPackageSourceIdV2,
    source: &'a dyn PluginPackageSourceV2,
    bundled_authority: Option<PluginBundledAuthorityIdV2>,
}

impl<'a> PluginPackageSourceRegistrationV2<'a> {
    pub fn new(source_id: PluginPackageSourceIdV2, source: &'a dyn PluginPackageSourceV2) -> Self {
        Self {
            source_id,
            source,
            bundled_authority: None,
        }
    }

    /// Registers a host-controlled bundled source. Manifests cannot opt into this authority.
    pub fn trusted_bundled(
        source_id: PluginPackageSourceIdV2,
        source: &'a dyn PluginPackageSourceV2,
        authority: impl Into<String>,
    ) -> Result<Self, StableIdError> {
        Ok(Self {
            source_id,
            source,
            bundled_authority: Some(PluginBundledAuthorityIdV2::new(authority)?),
        })
    }
}

#[derive(Clone, Default)]
pub struct InMemoryPluginPackageSourceV2 {
    packages: Vec<PluginPackageCatalogSnapshotV2>,
}

impl InMemoryPluginPackageSourceV2 {
    pub fn new(packages: Vec<PluginPackageCatalogSnapshotV2>) -> Self {
        Self { packages }
    }
}

impl PluginPackageSourceV2 for InMemoryPluginPackageSourceV2 {
    fn load(&self) -> Vec<PluginPackageSourceCandidateV2> {
        self.packages
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, package)| {
                PluginPackageSourceCandidateV2::accepted(
                    PluginPackageCandidateIdV2::new(format!("package.{index}"))
                        .expect("generated in-memory candidate ID is valid"),
                    package,
                )
            })
            .collect()
    }
}

#[derive(Clone)]
pub struct RegisteredPluginPackageV2 {
    source_id: PluginPackageSourceIdV2,
    candidate_id: PluginPackageCandidateIdV2,
    snapshot: PluginPackageCatalogSnapshotV2,
    bundled_authority: Option<PluginBundledAuthorityIdV2>,
}

impl RegisteredPluginPackageV2 {
    pub fn source_id(&self) -> &PluginPackageSourceIdV2 {
        &self.source_id
    }

    pub fn candidate_id(&self) -> &PluginPackageCandidateIdV2 {
        &self.candidate_id
    }

    pub fn manifest(&self) -> &PluginManifestV2 {
        self.snapshot.manifest()
    }

    pub fn contribution_resource_count(&self) -> usize {
        self.snapshot.contribution_resource_count()
    }

    pub fn bundled_authority(&self) -> Option<&PluginBundledAuthorityIdV2> {
        self.bundled_authority.as_ref()
    }

    pub fn catalog_snapshot_sha256(&self) -> &PluginCatalogSnapshotSha256V2 {
        self.snapshot.catalog_snapshot_sha256()
    }

    pub fn embedded_authority(&self) -> Option<&PluginPackageEmbeddedAuthorityV2> {
        self.snapshot.embedded_authority()
    }

    pub fn has_complete_embedded_authority(&self) -> bool {
        self.embedded_authority().is_some()
    }

    pub fn catalog_resource_fingerprints(&self) -> Vec<PluginCatalogResourceFingerprintV2> {
        self.snapshot.catalog_resource_fingerprints()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginPackageConflictCandidateV2 {
    source_id: PluginPackageSourceIdV2,
    candidate_id: PluginPackageCandidateIdV2,
    version: PluginVersionV2,
}

impl PluginPackageConflictCandidateV2 {
    pub fn source_id(&self) -> &PluginPackageSourceIdV2 {
        &self.source_id
    }

    pub fn candidate_id(&self) -> &PluginPackageCandidateIdV2 {
        &self.candidate_id
    }

    pub fn version(&self) -> &PluginVersionV2 {
        &self.version
    }
}

impl From<&RegisteredPluginPackageV2> for PluginPackageConflictCandidateV2 {
    fn from(package: &RegisteredPluginPackageV2) -> Self {
        Self {
            source_id: package.source_id.clone(),
            candidate_id: package.candidate_id.clone(),
            version: package.manifest().version.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginPackageSourceRejectionV2 {
    source_id: PluginPackageSourceIdV2,
    candidate_id: PluginPackageCandidateIdV2,
    error: PluginPackageSourceErrorV2,
}

impl PluginPackageSourceRejectionV2 {
    pub fn source_id(&self) -> &PluginPackageSourceIdV2 {
        &self.source_id
    }

    pub fn candidate_id(&self) -> &PluginPackageCandidateIdV2 {
        &self.candidate_id
    }

    pub fn error(&self) -> &PluginPackageSourceErrorV2 {
        &self.error
    }
}

pub struct ResolvedPluginContributionV2<'a> {
    descriptor: &'a ContributionDescriptorV2,
    bytes: &'a [u8],
}

pub struct ResolvedPluginAgentIntegrationV2<'a> {
    descriptor: &'a AgentIntegrationDescriptorV2,
    authority: &'a PluginPackageEmbeddedAuthorityV2,
    resource_tree: &'a PluginAgentIntegrationResourceTreeV2,
}

impl<'a> ResolvedPluginAgentIntegrationV2<'a> {
    pub fn descriptor(&self) -> &'a AgentIntegrationDescriptorV2 {
        self.descriptor
    }

    pub fn authority_sha256(&self) -> &'a PluginPackageEmbeddedAuthoritySha256V2 {
        self.authority.sha256()
    }

    pub fn file_manifest_sha256(&self) -> &'a PluginPackageEmbeddedFileManifestSha256V2 {
        self.authority.file_manifest_sha256()
    }

    pub fn files(&self) -> impl ExactSizeIterator<Item = (&'a PluginResourcePathV2, &'a [u8])> {
        self.resource_tree.files()
    }
}

impl<'a> ResolvedPluginContributionV2<'a> {
    pub fn descriptor(&self) -> &'a ContributionDescriptorV2 {
        self.descriptor
    }

    pub fn bytes(&self) -> &'a [u8] {
        self.bytes
    }
}

#[derive(Clone, Default)]
pub struct PluginPackageRegistryV2 {
    available: BTreeMap<PluginIdV2, RegisteredPluginPackageV2>,
    conflicts: BTreeMap<PluginIdV2, Vec<PluginPackageConflictCandidateV2>>,
    source_rejections: Vec<PluginPackageSourceRejectionV2>,
}

impl PluginPackageRegistryV2 {
    pub fn from_sources(sources: &[PluginPackageSourceRegistrationV2<'_>]) -> Self {
        let mut registry = Self::default();
        let mut loaded = Vec::new();
        for registration in sources {
            for candidate in registration.source.load() {
                loaded.push((
                    registration.source_id.clone(),
                    registration.bundled_authority.clone(),
                    candidate,
                ));
            }
        }
        let mut candidate_counts = BTreeMap::new();
        for (source_id, _, candidate) in &loaded {
            *candidate_counts
                .entry((source_id.clone(), candidate.candidate_id.clone()))
                .or_insert(0usize) += 1;
        }
        let mut duplicate_rejections = BTreeSet::new();
        for (source_id, bundled_authority, candidate) in loaded {
            let candidate_id = candidate.candidate_id;
            let identity = (source_id.clone(), candidate_id.clone());
            if candidate_counts.get(&identity).copied().unwrap_or_default() > 1 {
                if duplicate_rejections.insert(identity) {
                    registry
                        .source_rejections
                        .push(PluginPackageSourceRejectionV2 {
                            source_id,
                            candidate_id,
                            error: PluginPackageSourceErrorV2::new(
                                "source returned a duplicate candidate ID",
                            ),
                        });
                }
                continue;
            }
            match candidate.outcome {
                Ok(package)
                    if bundled_authority.is_some()
                        && !package.manifest.agent_integrations.is_empty()
                        && package.embedded_authority.is_none() =>
                {
                    registry
                        .source_rejections
                        .push(PluginPackageSourceRejectionV2 {
                            source_id,
                            candidate_id,
                            error: PluginPackageSourceErrorV2::new(
                                "trusted bundled native package has no embedded package authority",
                            ),
                        });
                }
                Ok(package) => {
                    registry.register(source_id, candidate_id, package, bundled_authority)
                }
                Err(error) => registry
                    .source_rejections
                    .push(PluginPackageSourceRejectionV2 {
                        source_id,
                        candidate_id,
                        error,
                    }),
            }
        }
        for candidates in registry.conflicts.values_mut() {
            candidates.sort_by(|left, right| {
                (&left.source_id, &left.candidate_id, &left.version).cmp(&(
                    &right.source_id,
                    &right.candidate_id,
                    &right.version,
                ))
            });
        }
        registry.source_rejections.sort_by(|left, right| {
            (&left.source_id, &left.candidate_id, &left.error).cmp(&(
                &right.source_id,
                &right.candidate_id,
                &right.error,
            ))
        });
        registry
    }

    fn register(
        &mut self,
        source_id: PluginPackageSourceIdV2,
        candidate_id: PluginPackageCandidateIdV2,
        snapshot: PluginPackageCatalogSnapshotV2,
        bundled_authority: Option<PluginBundledAuthorityIdV2>,
    ) {
        let plugin_id = snapshot.manifest.id.clone();
        let candidate = RegisteredPluginPackageV2 {
            source_id,
            candidate_id,
            snapshot,
            bundled_authority,
        };
        if let Some(conflicts) = self.conflicts.get_mut(&plugin_id) {
            conflicts.push(PluginPackageConflictCandidateV2::from(&candidate));
            return;
        }
        if let Some(existing) = self.available.remove(&plugin_id) {
            self.conflicts.insert(
                plugin_id,
                vec![
                    PluginPackageConflictCandidateV2::from(&existing),
                    PluginPackageConflictCandidateV2::from(&candidate),
                ],
            );
            return;
        }
        self.available.insert(plugin_id, candidate);
    }

    pub fn available_len(&self) -> usize {
        self.available.len()
    }

    pub fn is_empty(&self) -> bool {
        self.available.is_empty() && self.conflicts.is_empty()
    }

    pub fn iter_available(&self) -> impl ExactSizeIterator<Item = &RegisteredPluginPackageV2> {
        self.available.values()
    }

    pub fn conflicted_plugin_ids(&self) -> impl ExactSizeIterator<Item = &PluginIdV2> {
        self.conflicts.keys()
    }

    pub fn iter_conflicts(
        &self,
    ) -> impl ExactSizeIterator<Item = (&PluginIdV2, &[PluginPackageConflictCandidateV2])> {
        self.conflicts
            .iter()
            .map(|(plugin_id, candidates)| (plugin_id, candidates.as_slice()))
    }

    pub fn source_rejections(&self) -> &[PluginPackageSourceRejectionV2] {
        &self.source_rejections
    }

    pub fn package(
        &self,
        plugin_id: &PluginIdV2,
    ) -> Result<&RegisteredPluginPackageV2, PluginPackageRegistryErrorV2> {
        if let Some(candidates) = self.conflicts.get(plugin_id) {
            return Err(PluginPackageRegistryErrorV2::DuplicatePluginId {
                plugin_id: plugin_id.clone(),
                candidates: candidates.clone(),
            });
        }
        self.available.get(plugin_id).ok_or_else(|| {
            PluginPackageRegistryErrorV2::PluginUnavailable {
                plugin_id: plugin_id.clone(),
            }
        })
    }

    pub fn declared_contribution_resource(
        &self,
        plugin_id: &PluginIdV2,
        contribution_id: &ContributionIdV2,
        expected_family: &ContributionFamilyIdV2,
    ) -> Result<ResolvedPluginContributionV2<'_>, PluginPackageRegistryErrorV2> {
        let package = self.package(plugin_id)?;
        let contribution = package
            .manifest()
            .contributions
            .iter()
            .find(|candidate| candidate.id == *contribution_id)
            .ok_or_else(|| PluginPackageRegistryErrorV2::ContributionUnavailable {
                plugin_id: plugin_id.clone(),
                contribution_id: contribution_id.clone(),
            })?;
        if contribution.family != *expected_family {
            return Err(PluginPackageRegistryErrorV2::ContributionFamilyMismatch {
                plugin_id: plugin_id.clone(),
                contribution_id: contribution_id.clone(),
                expected_family: expected_family.clone(),
                actual_family: contribution.family.clone(),
            });
        }
        let bytes = package
            .snapshot
            .contribution_resource(&contribution.resource)
            .ok_or_else(|| PluginPackageRegistryErrorV2::ResourceUnavailable {
                plugin_id: plugin_id.clone(),
                contribution_id: contribution_id.clone(),
                resource: contribution.resource.clone(),
            })?;
        Ok(ResolvedPluginContributionV2 {
            descriptor: contribution,
            bytes,
        })
    }

    pub fn declared_agent_integration_resource(
        &self,
        plugin_id: &PluginIdV2,
        integration_id: &AgentIntegrationIdV2,
        expected_adapter: &AgentAdapterIdV2,
    ) -> Result<ResolvedPluginAgentIntegrationV2<'_>, PluginPackageRegistryErrorV2> {
        let package = self.package(plugin_id)?;
        let integration = package
            .manifest()
            .agent_integrations
            .iter()
            .find(|candidate| candidate.id == *integration_id)
            .ok_or_else(
                || PluginPackageRegistryErrorV2::AgentIntegrationUnavailable {
                    plugin_id: plugin_id.clone(),
                    integration_id: integration_id.clone(),
                },
            )?;
        if integration.adapter != *expected_adapter {
            return Err(
                PluginPackageRegistryErrorV2::AgentIntegrationAdapterMismatch {
                    plugin_id: plugin_id.clone(),
                    integration_id: integration_id.clone(),
                    expected_adapter: expected_adapter.clone(),
                    actual_adapter: integration.adapter.clone(),
                },
            );
        }
        let authority = package.embedded_authority().ok_or_else(|| {
            PluginPackageRegistryErrorV2::EmbeddedPackageAuthorityUnavailable {
                plugin_id: plugin_id.clone(),
            }
        })?;
        let resource_tree = authority
            .integration_resource_tree(integration_id)
            .ok_or_else(
                || PluginPackageRegistryErrorV2::EmbeddedAgentResourcesUnavailable {
                    plugin_id: plugin_id.clone(),
                    integration_id: integration_id.clone(),
                },
            )?;
        Ok(ResolvedPluginAgentIntegrationV2 {
            descriptor: integration,
            authority,
            resource_tree,
        })
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct PluginPackageSourceErrorV2 {
    message: String,
}

impl PluginPackageSourceErrorV2 {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for PluginPackageSourceErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for PluginPackageSourceErrorV2 {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginPackageRegistryErrorV2 {
    EmbeddedManifestTooLarge {
        maximum_bytes: usize,
    },
    EmbeddedManifestInvalid {
        message: String,
    },
    InvalidManifest {
        plugin_id: PluginIdV2,
        message: String,
    },
    DuplicatePluginId {
        plugin_id: PluginIdV2,
        candidates: Vec<PluginPackageConflictCandidateV2>,
    },
    PluginUnavailable {
        plugin_id: PluginIdV2,
    },
    ContributionUnavailable {
        plugin_id: PluginIdV2,
        contribution_id: ContributionIdV2,
    },
    ContributionFamilyMismatch {
        plugin_id: PluginIdV2,
        contribution_id: ContributionIdV2,
        expected_family: ContributionFamilyIdV2,
        actual_family: ContributionFamilyIdV2,
    },
    ResourceUnavailable {
        plugin_id: PluginIdV2,
        contribution_id: ContributionIdV2,
        resource: PluginResourcePathV2,
    },
    AgentIntegrationUnavailable {
        plugin_id: PluginIdV2,
        integration_id: AgentIntegrationIdV2,
    },
    AgentIntegrationAdapterMismatch {
        plugin_id: PluginIdV2,
        integration_id: AgentIntegrationIdV2,
        expected_adapter: AgentAdapterIdV2,
        actual_adapter: AgentAdapterIdV2,
    },
    EmbeddedPackageAuthorityUnavailable {
        plugin_id: PluginIdV2,
    },
    EmbeddedAgentResourcesUnavailable {
        plugin_id: PluginIdV2,
        integration_id: AgentIntegrationIdV2,
    },
    UndeclaredEmbeddedAgentResources {
        plugin_id: PluginIdV2,
        integration_id: AgentIntegrationIdV2,
    },
    InvalidEmbeddedPackageResourceTree {
        plugin_id: PluginIdV2,
        message: String,
    },
    EmbeddedPackageResourceLimitExceeded {
        plugin_id: PluginIdV2,
        limit: &'static str,
    },
}

impl fmt::Display for PluginPackageRegistryErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmbeddedManifestTooLarge { maximum_bytes } => write!(
                formatter,
                "embedded plugin manifest exceeds the {maximum_bytes}-byte limit"
            ),
            Self::EmbeddedManifestInvalid { message } => {
                write!(formatter, "embedded plugin manifest is invalid: {message}")
            }
            Self::InvalidManifest { plugin_id, message } => write!(
                formatter,
                "plugin {} has an invalid manifest: {message}",
                plugin_id.as_str()
            ),
            Self::DuplicatePluginId {
                plugin_id,
                candidates,
            } => write!(
                formatter,
                "plugin {} has {} conflicting package candidates",
                plugin_id.as_str(),
                candidates.len()
            ),
            Self::PluginUnavailable { plugin_id } => {
                write!(formatter, "plugin {} is unavailable", plugin_id.as_str())
            }
            Self::ContributionUnavailable {
                plugin_id,
                contribution_id,
            } => write!(
                formatter,
                "plugin {} contribution {} is unavailable",
                plugin_id.as_str(),
                contribution_id.as_str()
            ),
            Self::ContributionFamilyMismatch {
                plugin_id,
                contribution_id,
                expected_family,
                actual_family,
            } => write!(
                formatter,
                "plugin {} contribution {} has family {}, expected {}",
                plugin_id.as_str(),
                contribution_id.as_str(),
                actual_family.as_str(),
                expected_family.as_str()
            ),
            Self::ResourceUnavailable {
                plugin_id,
                contribution_id,
                resource,
            } => write!(
                formatter,
                "plugin {} contribution {} resource {} is unavailable",
                plugin_id.as_str(),
                contribution_id.as_str(),
                resource.as_str()
            ),
            Self::AgentIntegrationUnavailable {
                plugin_id,
                integration_id,
            } => write!(
                formatter,
                "plugin {} agent integration {} is unavailable",
                plugin_id.as_str(),
                integration_id.as_str()
            ),
            Self::AgentIntegrationAdapterMismatch {
                plugin_id,
                integration_id,
                expected_adapter,
                actual_adapter,
            } => write!(
                formatter,
                "plugin {} agent integration {} has adapter {}, expected {}",
                plugin_id.as_str(),
                integration_id.as_str(),
                actual_adapter.as_str(),
                expected_adapter.as_str()
            ),
            Self::EmbeddedPackageAuthorityUnavailable { plugin_id } => write!(
                formatter,
                "plugin {} has no embedded package authority",
                plugin_id.as_str()
            ),
            Self::EmbeddedAgentResourcesUnavailable {
                plugin_id,
                integration_id,
            } => write!(
                formatter,
                "plugin {} embedded resources for agent integration {} are unavailable",
                plugin_id.as_str(),
                integration_id.as_str()
            ),
            Self::UndeclaredEmbeddedAgentResources {
                plugin_id,
                integration_id,
            } => write!(
                formatter,
                "plugin {} has embedded resources for undeclared agent integration {}",
                plugin_id.as_str(),
                integration_id.as_str()
            ),
            Self::InvalidEmbeddedPackageResourceTree { plugin_id, message } => write!(
                formatter,
                "plugin {} has an invalid embedded package resource tree: {message}",
                plugin_id.as_str()
            ),
            Self::EmbeddedPackageResourceLimitExceeded { plugin_id, limit } => write!(
                formatter,
                "plugin {} embedded package exceeds the {limit} limit",
                plugin_id.as_str()
            ),
        }
    }
}

impl Error for PluginPackageRegistryErrorV2 {}
