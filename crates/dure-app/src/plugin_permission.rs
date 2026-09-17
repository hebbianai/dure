//! Canonical plugin permission review plans.
//!
//! This module does not grant permissions or enable plugins. A registry-bound bundled-package
//! context, an opaque workspace HMAC, the current host contract, and a validated host policy are
//! reduced to a read-only review plan. Persisted code may compare plan digests, but that comparison
//! is not authorization; durable decisions and activation are intentionally owned by later layers.

use std::{cmp::Ordering, collections::BTreeMap, error::Error, fmt};

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::{
    AgentIntegrationDescriptorV2, AgentIntegrationIdV2, ContributionIdV2, PermissionKindIdV2,
    PermissionRequestV2, PluginActivationEventV2, PluginBundledAuthorityIdV2,
    PluginCatalogResourceFingerprintV2, PluginCatalogSnapshotSha256V2,
    PluginCompatibilityOutcomeV2, PluginHostContractV2, PluginIdV2, PluginManifestV2,
    PluginPackageCandidateIdV2, PluginPackageSourceIdV2, PluginPlacementV2, PluginPublisherIdV2,
    PluginResourcePathV2, PluginVersionV2, RegisteredPluginPackageV2, contract::validate_stable_id,
    negotiate_plugin_manifest,
};

pub const PLUGIN_PERMISSION_PLAN_SCHEMA_VERSION_V2: u16 = 2;
pub const PLUGIN_PERMISSION_REVIEW_PROJECTION_SCHEMA_VERSION_V2: u16 = 2;
/// Permission-plan V2 is reviewable by construction. Inputs exceeding either bound are rejected
/// before a durable decision can be recorded instead of silently falling back to digest-only UI.
pub const MAX_PLUGIN_PERMISSION_REVIEW_ENTRIES_V2: usize = 256;
pub const MAX_PLUGIN_PERMISSION_REVIEW_PROJECTION_BYTES_V2: usize = 8 * 1024;

const MAX_PLUGIN_PERMISSION_REVIEW_KEY_SEGMENTS_V2: usize = 4;
const MAX_PLUGIN_PERMISSION_REVIEW_KEY_SEGMENT_BYTES_V2: usize = 512;
const MAX_PLUGIN_PERMISSION_REVIEW_VALUE_BYTES_V2: usize = 512;
const MAX_PLUGIN_PERMISSION_REVIEW_LIST_VALUES_V2: usize = 128;

type ValidatedPermissionPolicy =
    BTreeMap<PermissionKindIdV2, BTreeMap<String, (bool, Vec<String>)>>;

macro_rules! sha256_value {
    ($name:ident, $label:literal) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
        #[ts(type = "string")]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, PluginPermissionErrorV2> {
                let value = value.into();
                validate_sha256($label, &value)?;
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

sha256_value!(
    PluginPermissionPolicyDigestV2,
    "plugin permission policy digest"
);
sha256_value!(
    PluginPermissionPlanDigestV2,
    "plugin permission plan digest"
);
sha256_value!(
    PluginPermissionReviewProjectionDigestV2,
    "plugin permission review projection digest"
);

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[ts(type = "string")]
pub struct PluginWorkspaceIdentityV2(String);

impl PluginWorkspaceIdentityV2 {
    /// Accepts only a host-produced opaque value.
    ///
    /// The host must use a host-secret HMAC or a persisted random opaque identity. Hashing a raw
    /// workspace path without a secret is not sufficient and must happen nowhere in this core.
    pub fn from_host_hmac(value: impl Into<String>) -> Result<Self, PluginPermissionErrorV2> {
        let value = value.into();
        validate_sha256("plugin workspace HMAC", &value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PluginWorkspaceIdentityV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_host_hmac(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
pub struct PluginBundledCatalogAuthoritySummaryV2 {
    authority: PluginBundledAuthorityIdV2,
    /// Covers the canonical manifest and declarative contribution resources, not native trees.
    catalog_snapshot_sha256: PluginCatalogSnapshotSha256V2,
}

impl PluginBundledCatalogAuthoritySummaryV2 {
    pub fn authority(&self) -> &PluginBundledAuthorityIdV2 {
        &self.authority
    }

    pub fn catalog_snapshot_sha256(&self) -> &PluginCatalogSnapshotSha256V2 {
        &self.catalog_snapshot_sha256
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
pub struct PluginCatalogSelectionV2 {
    /// Discovery provenance only. This value never grants package authority.
    source_id: PluginPackageSourceIdV2,
    /// Discovery provenance only. This value never grants package authority.
    candidate_id: PluginPackageCandidateIdV2,
}

impl PluginCatalogSelectionV2 {
    pub fn source_id(&self) -> &PluginPackageSourceIdV2 {
        &self.source_id
    }

    pub fn candidate_id(&self) -> &PluginPackageCandidateIdV2 {
        &self.candidate_id
    }
}

/// Opaque non-wire package context binding one registered package to host-verified authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginBundledPermissionPackageV2 {
    manifest: PluginManifestV2,
    authority: PluginBundledCatalogAuthoritySummaryV2,
    catalog_selection: PluginCatalogSelectionV2,
    catalog_resources: Vec<PluginCatalogResourceFingerprintV2>,
}

impl PluginBundledPermissionPackageV2 {
    /// Projects one registry-bound trusted bundled package into permission review scope.
    ///
    /// The catalog snapshot digest excludes native agent-integration directory bytes. A matching
    /// permission plan therefore does not authorize native installation; that requires a future
    /// exact tree verifier.
    pub fn from_registered(
        package: &RegisteredPluginPackageV2,
    ) -> Result<Self, PluginPermissionErrorV2> {
        let authority =
            package
                .bundled_authority()
                .ok_or(PluginPermissionErrorV2::UntrustedPackage {
                    plugin_id: package.manifest().id.clone(),
                })?;
        Ok(Self {
            manifest: package.manifest().clone(),
            authority: PluginBundledCatalogAuthoritySummaryV2 {
                authority: authority.clone(),
                catalog_snapshot_sha256: package.catalog_snapshot_sha256().clone(),
            },
            catalog_selection: PluginCatalogSelectionV2 {
                source_id: package.source_id().clone(),
                candidate_id: package.candidate_id().clone(),
            },
            catalog_resources: package.catalog_resource_fingerprints(),
        })
    }
}

/// Backend-only validated policy parameter. It is deliberately not a wire DTO.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginPermissionParameterPolicyV2 {
    parameter: String,
    required: bool,
    allowed_values: Vec<String>,
}

impl PluginPermissionParameterPolicyV2 {
    pub fn try_new(
        parameter: impl Into<String>,
        required: bool,
        mut allowed_values: Vec<String>,
    ) -> Result<Self, PluginPermissionErrorV2> {
        let parameter = parameter.into();
        validate_stable_id(&parameter).map_err(|error| invalid_policy(error.to_string()))?;
        if allowed_values.is_empty() {
            return Err(invalid_policy(format!(
                "parameter {parameter} has no allowed values"
            )));
        }
        for value in &allowed_values {
            validate_parameter_value(value).map_err(invalid_policy)?;
        }
        allowed_values.sort();
        if allowed_values.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(invalid_policy(format!(
                "parameter {parameter} has duplicate allowed values"
            )));
        }
        Ok(Self {
            parameter,
            required,
            allowed_values,
        })
    }
}

/// Backend-only validated permission-kind policy. It is deliberately not a wire DTO.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginPermissionKindPolicyV2 {
    kind: PermissionKindIdV2,
    parameters: Vec<PluginPermissionParameterPolicyV2>,
}

impl PluginPermissionKindPolicyV2 {
    pub fn try_new(
        kind: PermissionKindIdV2,
        mut parameters: Vec<PluginPermissionParameterPolicyV2>,
    ) -> Result<Self, PluginPermissionErrorV2> {
        parameters.sort_by(|left, right| left.parameter.cmp(&right.parameter));
        if parameters
            .windows(2)
            .any(|pair| pair[0].parameter == pair[1].parameter)
        {
            return Err(invalid_policy(format!(
                "permission {} has duplicate parameters",
                kind.as_str()
            )));
        }
        Ok(Self { kind, parameters })
    }
}

/// Backend-only validated host policy. It is deliberately not a wire DTO.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginPermissionHostPolicyV2 {
    permission_kinds: Vec<PluginPermissionKindPolicyV2>,
}

impl PluginPermissionHostPolicyV2 {
    pub fn try_new(
        mut permission_kinds: Vec<PluginPermissionKindPolicyV2>,
    ) -> Result<Self, PluginPermissionErrorV2> {
        permission_kinds.sort_by(|left, right| left.kind.cmp(&right.kind));
        if permission_kinds
            .windows(2)
            .any(|pair| pair[0].kind == pair[1].kind)
        {
            return Err(invalid_policy("duplicate permission kind"));
        }
        Ok(Self { permission_kinds })
    }

    fn validated(&self) -> ValidatedPermissionPolicy {
        self.permission_kinds
            .iter()
            .map(|kind| {
                (
                    kind.kind.clone(),
                    kind.parameters
                        .iter()
                        .map(|parameter| {
                            (
                                parameter.parameter.clone(),
                                (parameter.required, parameter.allowed_values.clone()),
                            )
                        })
                        .collect(),
                )
            })
            .collect()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PluginPermissionReviewSubjectV2 {
    Plan,
    Identity,
    Authority,
    Workspace,
    CatalogSelection,
    Activation,
    Contribution,
    IgnoredOptionalContribution,
    AgentIntegration,
    IgnoredOptionalAgentIntegration,
    Permission,
    CatalogResource,
}

impl PluginPermissionReviewSubjectV2 {
    fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Identity => "identity",
            Self::Authority => "authority",
            Self::Workspace => "workspace",
            Self::CatalogSelection => "catalog_selection",
            Self::Activation => "activation",
            Self::Contribution => "contribution",
            Self::IgnoredOptionalContribution => "ignored_optional_contribution",
            Self::AgentIntegration => "agent_integration",
            Self::IgnoredOptionalAgentIntegration => "ignored_optional_agent_integration",
            Self::Permission => "permission",
            Self::CatalogResource => "catalog_resource",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PluginPermissionReviewFieldV2 {
    SchemaVersion,
    PluginId,
    Publisher,
    Version,
    AuthorityId,
    CatalogSnapshotSha256,
    WorkspaceIdentity,
    SourceId,
    CandidateId,
    AppliedPolicyDigest,
    NegotiatedHostApiVersion,
    Presence,
    Pattern,
    Family,
    FamilyApiVersion,
    Required,
    Placement,
    Resource,
    Adapter,
    SelectorPlugin,
    SelectorMarketplace,
    GrantedValues,
    ContentSha256,
}

impl PluginPermissionReviewFieldV2 {
    fn as_str(self) -> &'static str {
        match self {
            Self::SchemaVersion => "schema_version",
            Self::PluginId => "plugin_id",
            Self::Publisher => "publisher",
            Self::Version => "version",
            Self::AuthorityId => "authority_id",
            Self::CatalogSnapshotSha256 => "catalog_snapshot_sha256",
            Self::WorkspaceIdentity => "workspace_identity",
            Self::SourceId => "source_id",
            Self::CandidateId => "candidate_id",
            Self::AppliedPolicyDigest => "applied_policy_digest",
            Self::NegotiatedHostApiVersion => "negotiated_host_api_version",
            Self::Presence => "presence",
            Self::Pattern => "pattern",
            Self::Family => "family",
            Self::FamilyApiVersion => "family_api_version",
            Self::Required => "required",
            Self::Placement => "placement",
            Self::Resource => "resource",
            Self::Adapter => "adapter",
            Self::SelectorPlugin => "selector_plugin",
            Self::SelectorMarketplace => "selector_marketplace",
            Self::GrantedValues => "granted_values",
            Self::ContentSha256 => "content_sha256",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginPermissionReviewValueV2 {
    Boolean { value: bool },
    U16 { value: u16 },
    String { value: String },
    StringList { values: Vec<String> },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
pub struct PluginPermissionReviewEntryV2 {
    subject: PluginPermissionReviewSubjectV2,
    field: PluginPermissionReviewFieldV2,
    key_segments: Vec<String>,
    value: PluginPermissionReviewValueV2,
}

impl PluginPermissionReviewEntryV2 {
    pub fn subject(&self) -> PluginPermissionReviewSubjectV2 {
        self.subject
    }

    pub fn field(&self) -> PluginPermissionReviewFieldV2 {
        self.field
    }

    pub fn key_segments(&self) -> &[String] {
        &self.key_segments
    }

    pub fn value(&self) -> &PluginPermissionReviewValueV2 {
        &self.value
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
pub struct PluginPermissionReviewProjectionV2 {
    schema_version: u16,
    plan_digest: PluginPermissionPlanDigestV2,
    entries: Vec<PluginPermissionReviewEntryV2>,
    projection_digest: PluginPermissionReviewProjectionDigestV2,
}

impl PluginPermissionReviewProjectionV2 {
    pub fn schema_version(&self) -> u16 {
        self.schema_version
    }

    pub fn plan_digest(&self) -> &PluginPermissionPlanDigestV2 {
        &self.plan_digest
    }

    pub fn entries(&self) -> &[PluginPermissionReviewEntryV2] {
        &self.entries
    }

    pub fn digest(&self) -> &PluginPermissionReviewProjectionDigestV2 {
        &self.projection_digest
    }

    pub fn validate_binding(
        &self,
        plan_digest: &PluginPermissionPlanDigestV2,
    ) -> Result<(), PluginPermissionErrorV2> {
        self.validate()?;
        if &self.plan_digest != plan_digest {
            return Err(invalid_projection(
                "review projection belongs to a different permission plan digest",
            ));
        }
        Ok(())
    }

    fn new(
        plan_digest: PluginPermissionPlanDigestV2,
        mut entries: Vec<PluginPermissionReviewEntryV2>,
    ) -> Result<Self, PluginPermissionErrorV2> {
        entries.sort_by(compare_review_entry_keys);
        let mut projection = Self {
            schema_version: PLUGIN_PERMISSION_REVIEW_PROJECTION_SCHEMA_VERSION_V2,
            plan_digest,
            entries,
            projection_digest: PluginPermissionReviewProjectionDigestV2(sha256_bytes([])),
        };
        projection.projection_digest = digest_review_projection(&projection);
        projection.validate()?;
        Ok(projection)
    }

    fn validate(&self) -> Result<(), PluginPermissionErrorV2> {
        if self.schema_version != PLUGIN_PERMISSION_REVIEW_PROJECTION_SCHEMA_VERSION_V2 {
            return Err(invalid_projection(format!(
                "unsupported review projection schema version {}",
                self.schema_version
            )));
        }
        if self.entries.len() > MAX_PLUGIN_PERMISSION_REVIEW_ENTRIES_V2 {
            return Err(review_projection_limit(
                "review projection has too many entries",
            ));
        }
        for entry in &self.entries {
            validate_review_entry(entry)?;
        }
        if self
            .entries
            .windows(2)
            .any(|pair| compare_review_entry_keys(&pair[0], &pair[1]) != Ordering::Less)
        {
            return Err(invalid_projection(
                "review projection entries must be bytewise sorted and unique",
            ));
        }
        if digest_review_projection(self) != self.projection_digest {
            return Err(invalid_projection("review projection digest mismatch"));
        }
        let encoded = serde_json::to_vec(self)
            .map_err(|error| invalid_projection(format!("cannot encode projection: {error}")))?;
        if encoded.len() > MAX_PLUGIN_PERMISSION_REVIEW_PROJECTION_BYTES_V2 {
            return Err(review_projection_limit(format!(
                "review projection is {} bytes; maximum is {MAX_PLUGIN_PERMISSION_REVIEW_PROJECTION_BYTES_V2}",
                encoded.len()
            )));
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for PluginPermissionReviewProjectionV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
        enum PersistedValue {
            Boolean { value: bool },
            U16 { value: u16 },
            String { value: String },
            StringList { values: Vec<String> },
        }

        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PersistedEntry {
            subject: PluginPermissionReviewSubjectV2,
            field: PluginPermissionReviewFieldV2,
            key_segments: Vec<String>,
            value: PersistedValue,
        }

        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PersistedProjection {
            schema_version: u16,
            plan_digest: PluginPermissionPlanDigestV2,
            entries: Vec<PersistedEntry>,
            projection_digest: PluginPermissionReviewProjectionDigestV2,
        }

        let persisted = PersistedProjection::deserialize(deserializer)?;
        let projection = Self {
            schema_version: persisted.schema_version,
            plan_digest: persisted.plan_digest,
            entries: persisted
                .entries
                .into_iter()
                .map(|entry| PluginPermissionReviewEntryV2 {
                    subject: entry.subject,
                    field: entry.field,
                    key_segments: entry.key_segments,
                    value: match entry.value {
                        PersistedValue::Boolean { value } => {
                            PluginPermissionReviewValueV2::Boolean { value }
                        }
                        PersistedValue::U16 { value } => {
                            PluginPermissionReviewValueV2::U16 { value }
                        }
                        PersistedValue::String { value } => {
                            PluginPermissionReviewValueV2::String { value }
                        }
                        PersistedValue::StringList { values } => {
                            PluginPermissionReviewValueV2::StringList { values }
                        }
                    },
                })
                .collect(),
            projection_digest: persisted.projection_digest,
        };
        projection.validate().map_err(serde::de::Error::custom)?;
        Ok(projection)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginPermissionReviewChangeV2 {
    Added {
        current: PluginPermissionReviewEntryV2,
    },
    Removed {
        reviewed: PluginPermissionReviewEntryV2,
    },
    Changed {
        reviewed: PluginPermissionReviewEntryV2,
        current: PluginPermissionReviewEntryV2,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
pub struct PluginPermissionReviewDiffV2 {
    changes: Vec<PluginPermissionReviewChangeV2>,
    catalog_snapshot_fingerprint_only: bool,
}

impl PluginPermissionReviewDiffV2 {
    pub fn changes(&self) -> &[PluginPermissionReviewChangeV2] {
        &self.changes
    }

    pub fn catalog_snapshot_fingerprint_only(&self) -> bool {
        self.catalog_snapshot_fingerprint_only
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
pub struct PluginPermissionIdentityV2 {
    plugin_id: PluginIdV2,
    /// Display/discovery metadata, not package authority.
    publisher: PluginPublisherIdV2,
    version: PluginVersionV2,
}

impl PluginPermissionIdentityV2 {
    pub fn plugin_id(&self) -> &PluginIdV2 {
        &self.plugin_id
    }

    pub fn publisher(&self) -> &PluginPublisherIdV2 {
        &self.publisher
    }

    pub fn version(&self) -> &PluginVersionV2 {
        &self.version
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
pub struct PluginPermissionContributionPlanV2 {
    id: ContributionIdV2,
    family: crate::ContributionFamilyIdV2,
    family_api_version: u16,
    required: bool,
    placement: PluginPlacementV2,
    resource: PluginResourcePathV2,
}

impl PluginPermissionContributionPlanV2 {
    pub fn id(&self) -> &ContributionIdV2 {
        &self.id
    }

    pub fn family_api_version(&self) -> u16 {
        self.family_api_version
    }

    pub fn placement(&self) -> &PluginPlacementV2 {
        &self.placement
    }

    pub fn resource(&self) -> &PluginResourcePathV2 {
        &self.resource
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
pub struct PluginPermissionPlanV2 {
    schema_version: u16,
    identity: PluginPermissionIdentityV2,
    authority: PluginBundledCatalogAuthoritySummaryV2,
    workspace_identity: PluginWorkspaceIdentityV2,
    catalog_selection: PluginCatalogSelectionV2,
    applied_policy_digest: PluginPermissionPolicyDigestV2,
    negotiated_host_api_version: u16,
    activation: Vec<PluginActivationEventV2>,
    contributions: Vec<PluginPermissionContributionPlanV2>,
    ignored_optional_contributions: Vec<ContributionIdV2>,
    agent_integrations: Vec<AgentIntegrationDescriptorV2>,
    ignored_optional_agent_integrations: Vec<AgentIntegrationIdV2>,
    permissions: Vec<PermissionRequestV2>,
    digest: PluginPermissionPlanDigestV2,
    #[serde(skip)]
    #[ts(skip)]
    review_projection: Option<PluginPermissionReviewProjectionV2>,
}

impl PluginPermissionPlanV2 {
    pub fn identity(&self) -> &PluginPermissionIdentityV2 {
        &self.identity
    }

    pub fn authority(&self) -> &PluginBundledCatalogAuthoritySummaryV2 {
        &self.authority
    }

    pub fn workspace_identity(&self) -> &PluginWorkspaceIdentityV2 {
        &self.workspace_identity
    }

    pub fn catalog_selection(&self) -> &PluginCatalogSelectionV2 {
        &self.catalog_selection
    }

    pub fn applied_policy_digest(&self) -> &PluginPermissionPolicyDigestV2 {
        &self.applied_policy_digest
    }

    pub fn negotiated_host_api_version(&self) -> u16 {
        self.negotiated_host_api_version
    }

    pub fn contributions(&self) -> &[PluginPermissionContributionPlanV2] {
        &self.contributions
    }

    pub fn ignored_optional_contributions(&self) -> &[ContributionIdV2] {
        &self.ignored_optional_contributions
    }

    pub fn agent_integrations(&self) -> &[AgentIntegrationDescriptorV2] {
        &self.agent_integrations
    }

    pub fn ignored_optional_agent_integrations(&self) -> &[AgentIntegrationIdV2] {
        &self.ignored_optional_agent_integrations
    }

    pub fn permissions(&self) -> &[PermissionRequestV2] {
        &self.permissions
    }

    pub fn digest(&self) -> &PluginPermissionPlanDigestV2 {
        &self.digest
    }

    pub fn review_projection(&self) -> &PluginPermissionReviewProjectionV2 {
        self.review_projection
            .as_ref()
            .expect("canonical permission plans always include a review projection")
    }
}

/// A neutral comparison result. None of these values authorizes or activates a plugin.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PluginPermissionPlanComparisonV2 {
    NoReviewedPlan,
    MatchesReviewedPlan,
    ChangedSinceReview,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginPermissionErrorV2 {
    UntrustedPackage {
        plugin_id: PluginIdV2,
    },
    InvalidPolicy {
        reason: String,
    },
    InvalidManifest {
        message: String,
    },
    UnsupportedManifest {
        reason: String,
    },
    UnknownPermissionKind {
        kind: PermissionKindIdV2,
    },
    UnknownPermissionParameter {
        kind: PermissionKindIdV2,
        parameter: String,
    },
    MissingRequiredPermissionParameter {
        kind: PermissionKindIdV2,
        parameter: String,
    },
    UnknownPermissionParameterValue {
        kind: PermissionKindIdV2,
        parameter: String,
        value: String,
    },
    InvalidPlanInput {
        reason: String,
    },
    ReviewProjectionLimitExceeded {
        reason: String,
    },
    InvalidSha256 {
        label: &'static str,
    },
}

impl fmt::Display for PluginPermissionErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UntrustedPackage { plugin_id } => write!(
                formatter,
                "plugin {} is not from a trusted bundled registration",
                plugin_id.as_str()
            ),
            Self::InvalidPolicy { reason } => {
                write!(formatter, "invalid plugin permission policy: {reason}")
            }
            Self::InvalidManifest { message } => {
                write!(formatter, "invalid plugin manifest: {message}")
            }
            Self::UnsupportedManifest { reason } => write!(
                formatter,
                "plugin manifest is not supported by this host: {reason}"
            ),
            Self::UnknownPermissionKind { kind } => write!(
                formatter,
                "unknown plugin permission kind {}",
                kind.as_str()
            ),
            Self::UnknownPermissionParameter { kind, parameter } => write!(
                formatter,
                "permission {} has unknown parameter {parameter}",
                kind.as_str()
            ),
            Self::MissingRequiredPermissionParameter { kind, parameter } => write!(
                formatter,
                "permission {} is missing required parameter {parameter}",
                kind.as_str()
            ),
            Self::UnknownPermissionParameterValue {
                kind,
                parameter,
                value,
            } => write!(
                formatter,
                "permission {} parameter {parameter} has unknown value {value:?}",
                kind.as_str()
            ),
            Self::InvalidPlanInput { reason } => {
                write!(formatter, "invalid plugin permission plan input: {reason}")
            }
            Self::ReviewProjectionLimitExceeded { reason } => {
                write!(
                    formatter,
                    "plugin permission review projection limit exceeded: {reason}"
                )
            }
            Self::InvalidSha256 { label } => {
                write!(formatter, "{label} must be a lowercase sha256: digest")
            }
        }
    }
}

impl Error for PluginPermissionErrorV2 {}

pub fn canonicalize_plugin_permission_plan(
    package: &PluginBundledPermissionPackageV2,
    host: &PluginHostContractV2,
    workspace_identity: PluginWorkspaceIdentityV2,
    policy: &PluginPermissionHostPolicyV2,
) -> Result<PluginPermissionPlanV2, PluginPermissionErrorV2> {
    let manifest = &package.manifest;
    let outcome = negotiate_plugin_manifest(manifest, host).map_err(|error| {
        PluginPermissionErrorV2::InvalidManifest {
            message: error.to_string(),
        }
    })?;
    let PluginCompatibilityOutcomeV2::Supported {
        negotiated_host_api_version,
        contributions,
        mut ignored_optional_contributions,
        enabled_agent_integrations,
        mut ignored_optional_agent_integrations,
    } = outcome
    else {
        return Err(unsupported_outcome(outcome));
    };

    let descriptors = manifest
        .contributions
        .iter()
        .map(|descriptor| (&descriptor.id, descriptor))
        .collect::<BTreeMap<_, _>>();
    let mut effective_contributions = contributions
        .into_iter()
        .map(|contribution| {
            let descriptor = descriptors
                .get(&contribution.id)
                .expect("negotiation returns only manifest contribution IDs");
            PluginPermissionContributionPlanV2 {
                id: contribution.id,
                family: contribution.family,
                family_api_version: contribution.family_api_version,
                required: descriptor.required,
                placement: contribution.placement,
                resource: descriptor.resource.clone(),
            }
        })
        .collect::<Vec<_>>();
    effective_contributions.sort();
    ignored_optional_contributions.sort();

    let integrations = manifest
        .agent_integrations
        .iter()
        .map(|integration| (&integration.id, integration))
        .collect::<BTreeMap<_, _>>();
    let mut effective_integrations = enabled_agent_integrations
        .into_iter()
        .map(|id| {
            (*integrations
                .get(&id)
                .expect("negotiation returns only manifest integration IDs"))
            .clone()
        })
        .collect::<Vec<_>>();
    effective_integrations.sort();
    ignored_optional_agent_integrations.sort();

    let mut activation = manifest.activation.clone();
    sort_unique("activation events", &mut activation)?;
    let validated_policy = policy.validated();
    let mut permissions = canonical_permissions(&manifest.permissions, &validated_policy)?;
    permissions.sort();
    let applied_policy_digest = digest_applied_policy(&permissions, &validated_policy);

    let mut plan = PluginPermissionPlanV2 {
        schema_version: PLUGIN_PERMISSION_PLAN_SCHEMA_VERSION_V2,
        identity: PluginPermissionIdentityV2 {
            plugin_id: manifest.id.clone(),
            publisher: manifest.publisher.clone(),
            version: manifest.version.clone(),
        },
        authority: package.authority.clone(),
        workspace_identity,
        catalog_selection: package.catalog_selection.clone(),
        applied_policy_digest,
        negotiated_host_api_version,
        activation,
        contributions: effective_contributions,
        ignored_optional_contributions,
        agent_integrations: effective_integrations,
        ignored_optional_agent_integrations,
        permissions,
        digest: PluginPermissionPlanDigestV2(sha256_bytes([])),
        review_projection: None,
    };
    plan.digest = digest_plan(&plan);
    plan.review_projection = Some(build_review_projection(
        &plan,
        &validated_policy,
        &package.catalog_resources,
    )?);
    Ok(plan)
}

/// Compares review-plan identity only. A match is not a permission grant or enablement decision.
pub fn compare_plugin_permission_plan_digest(
    plan: &PluginPermissionPlanV2,
    reviewed_digest: Option<&PluginPermissionPlanDigestV2>,
) -> PluginPermissionPlanComparisonV2 {
    match reviewed_digest {
        None => PluginPermissionPlanComparisonV2::NoReviewedPlan,
        Some(digest) if digest == plan.digest() => {
            PluginPermissionPlanComparisonV2::MatchesReviewedPlan
        }
        Some(_) => PluginPermissionPlanComparisonV2::ChangedSinceReview,
    }
}

pub fn diff_plugin_permission_review_projections(
    reviewed: &PluginPermissionReviewProjectionV2,
    current: &PluginPermissionReviewProjectionV2,
) -> PluginPermissionReviewDiffV2 {
    let mut changes = Vec::new();
    let mut reviewed_index = 0;
    let mut current_index = 0;
    while reviewed_index < reviewed.entries.len() || current_index < current.entries.len() {
        match (
            reviewed.entries.get(reviewed_index),
            current.entries.get(current_index),
        ) {
            (Some(reviewed_entry), Some(current_entry)) => {
                match compare_review_entry_keys(reviewed_entry, current_entry) {
                    Ordering::Less => {
                        changes.push(PluginPermissionReviewChangeV2::Removed {
                            reviewed: reviewed_entry.clone(),
                        });
                        reviewed_index += 1;
                    }
                    Ordering::Greater => {
                        changes.push(PluginPermissionReviewChangeV2::Added {
                            current: current_entry.clone(),
                        });
                        current_index += 1;
                    }
                    Ordering::Equal => {
                        if reviewed_entry != current_entry {
                            changes.push(PluginPermissionReviewChangeV2::Changed {
                                reviewed: reviewed_entry.clone(),
                                current: current_entry.clone(),
                            });
                        }
                        reviewed_index += 1;
                        current_index += 1;
                    }
                }
            }
            (Some(reviewed_entry), None) => {
                changes.push(PluginPermissionReviewChangeV2::Removed {
                    reviewed: reviewed_entry.clone(),
                });
                reviewed_index += 1;
            }
            (None, Some(current_entry)) => {
                changes.push(PluginPermissionReviewChangeV2::Added {
                    current: current_entry.clone(),
                });
                current_index += 1;
            }
            (None, None) => break,
        }
    }
    let catalog_snapshot_changed = changes.iter().any(|change| match change {
        PluginPermissionReviewChangeV2::Added { current } => is_catalog_snapshot_entry(current),
        PluginPermissionReviewChangeV2::Removed { reviewed } => is_catalog_snapshot_entry(reviewed),
        PluginPermissionReviewChangeV2::Changed { reviewed, current } => {
            is_catalog_snapshot_entry(reviewed) || is_catalog_snapshot_entry(current)
        }
    });
    let catalog_resource_fingerprint_changed = changes.iter().any(|change| match change {
        PluginPermissionReviewChangeV2::Added { current } => {
            is_catalog_resource_fingerprint_entry(current)
        }
        PluginPermissionReviewChangeV2::Removed { reviewed } => {
            is_catalog_resource_fingerprint_entry(reviewed)
        }
        PluginPermissionReviewChangeV2::Changed { reviewed, current } => {
            is_catalog_resource_fingerprint_entry(reviewed)
                || is_catalog_resource_fingerprint_entry(current)
        }
    });
    let catalog_snapshot_fingerprint_only =
        catalog_snapshot_changed && !catalog_resource_fingerprint_changed;
    PluginPermissionReviewDiffV2 {
        changes,
        catalog_snapshot_fingerprint_only,
    }
}

fn build_review_projection(
    plan: &PluginPermissionPlanV2,
    policy: &ValidatedPermissionPolicy,
    catalog_resources: &[PluginCatalogResourceFingerprintV2],
) -> Result<PluginPermissionReviewProjectionV2, PluginPermissionErrorV2> {
    let mut entries = vec![
        review_entry(
            PluginPermissionReviewSubjectV2::Plan,
            PluginPermissionReviewFieldV2::SchemaVersion,
            Vec::new(),
            PluginPermissionReviewValueV2::U16 {
                value: plan.schema_version,
            },
        ),
        review_string_entry(
            PluginPermissionReviewSubjectV2::Identity,
            PluginPermissionReviewFieldV2::PluginId,
            Vec::new(),
            plan.identity.plugin_id.as_str(),
        ),
        review_string_entry(
            PluginPermissionReviewSubjectV2::Identity,
            PluginPermissionReviewFieldV2::Publisher,
            Vec::new(),
            plan.identity.publisher.as_str(),
        ),
        review_string_entry(
            PluginPermissionReviewSubjectV2::Identity,
            PluginPermissionReviewFieldV2::Version,
            Vec::new(),
            plan.identity.version.as_str(),
        ),
        review_string_entry(
            PluginPermissionReviewSubjectV2::Authority,
            PluginPermissionReviewFieldV2::AuthorityId,
            Vec::new(),
            plan.authority.authority.as_str(),
        ),
        review_string_entry(
            PluginPermissionReviewSubjectV2::Authority,
            PluginPermissionReviewFieldV2::CatalogSnapshotSha256,
            Vec::new(),
            plan.authority.catalog_snapshot_sha256.as_str(),
        ),
        review_string_entry(
            PluginPermissionReviewSubjectV2::Workspace,
            PluginPermissionReviewFieldV2::WorkspaceIdentity,
            Vec::new(),
            plan.workspace_identity.as_str(),
        ),
        review_string_entry(
            PluginPermissionReviewSubjectV2::CatalogSelection,
            PluginPermissionReviewFieldV2::SourceId,
            Vec::new(),
            plan.catalog_selection.source_id.as_str(),
        ),
        review_string_entry(
            PluginPermissionReviewSubjectV2::CatalogSelection,
            PluginPermissionReviewFieldV2::CandidateId,
            Vec::new(),
            plan.catalog_selection.candidate_id.as_str(),
        ),
        review_string_entry(
            PluginPermissionReviewSubjectV2::Plan,
            PluginPermissionReviewFieldV2::AppliedPolicyDigest,
            Vec::new(),
            plan.applied_policy_digest.as_str(),
        ),
        review_entry(
            PluginPermissionReviewSubjectV2::Plan,
            PluginPermissionReviewFieldV2::NegotiatedHostApiVersion,
            Vec::new(),
            PluginPermissionReviewValueV2::U16 {
                value: plan.negotiated_host_api_version,
            },
        ),
    ];

    for activation in &plan.activation {
        match activation {
            PluginActivationEventV2::Explicit => entries.push(review_entry(
                PluginPermissionReviewSubjectV2::Activation,
                PluginPermissionReviewFieldV2::Presence,
                vec!["explicit".to_owned()],
                PluginPermissionReviewValueV2::Boolean { value: true },
            )),
            PluginActivationEventV2::WorkspaceContains { pattern } => {
                entries.push(review_string_entry(
                    PluginPermissionReviewSubjectV2::Activation,
                    PluginPermissionReviewFieldV2::Pattern,
                    vec![pattern.clone()],
                    pattern,
                ));
            }
        }
    }
    for contribution in &plan.contributions {
        let key = vec![contribution.id.as_str().to_owned()];
        entries.push(review_string_entry(
            PluginPermissionReviewSubjectV2::Contribution,
            PluginPermissionReviewFieldV2::Family,
            key.clone(),
            contribution.family.as_str(),
        ));
        entries.push(review_entry(
            PluginPermissionReviewSubjectV2::Contribution,
            PluginPermissionReviewFieldV2::FamilyApiVersion,
            key.clone(),
            PluginPermissionReviewValueV2::U16 {
                value: contribution.family_api_version,
            },
        ));
        entries.push(review_entry(
            PluginPermissionReviewSubjectV2::Contribution,
            PluginPermissionReviewFieldV2::Required,
            key.clone(),
            PluginPermissionReviewValueV2::Boolean {
                value: contribution.required,
            },
        ));
        entries.push(review_string_entry(
            PluginPermissionReviewSubjectV2::Contribution,
            PluginPermissionReviewFieldV2::Placement,
            key.clone(),
            placement_name(&contribution.placement),
        ));
        entries.push(review_string_entry(
            PluginPermissionReviewSubjectV2::Contribution,
            PluginPermissionReviewFieldV2::Resource,
            key,
            contribution.resource.as_str(),
        ));
    }
    for id in &plan.ignored_optional_contributions {
        entries.push(review_entry(
            PluginPermissionReviewSubjectV2::IgnoredOptionalContribution,
            PluginPermissionReviewFieldV2::Presence,
            vec![id.as_str().to_owned()],
            PluginPermissionReviewValueV2::Boolean { value: true },
        ));
    }
    for integration in &plan.agent_integrations {
        let key = vec![integration.id.as_str().to_owned()];
        entries.push(review_string_entry(
            PluginPermissionReviewSubjectV2::AgentIntegration,
            PluginPermissionReviewFieldV2::Adapter,
            key.clone(),
            integration.adapter.as_str(),
        ));
        entries.push(review_entry(
            PluginPermissionReviewSubjectV2::AgentIntegration,
            PluginPermissionReviewFieldV2::Required,
            key.clone(),
            PluginPermissionReviewValueV2::Boolean {
                value: integration.required,
            },
        ));
        entries.push(review_string_entry(
            PluginPermissionReviewSubjectV2::AgentIntegration,
            PluginPermissionReviewFieldV2::Resource,
            key.clone(),
            integration.resource.as_str(),
        ));
        entries.push(review_string_entry(
            PluginPermissionReviewSubjectV2::AgentIntegration,
            PluginPermissionReviewFieldV2::SelectorPlugin,
            key.clone(),
            integration.selector.plugin.as_str(),
        ));
        entries.push(review_string_entry(
            PluginPermissionReviewSubjectV2::AgentIntegration,
            PluginPermissionReviewFieldV2::SelectorMarketplace,
            key,
            integration.selector.marketplace.as_str(),
        ));
    }
    for id in &plan.ignored_optional_agent_integrations {
        entries.push(review_entry(
            PluginPermissionReviewSubjectV2::IgnoredOptionalAgentIntegration,
            PluginPermissionReviewFieldV2::Presence,
            vec![id.as_str().to_owned()],
            PluginPermissionReviewValueV2::Boolean { value: true },
        ));
    }
    for permission in &plan.permissions {
        let kind = permission.kind.as_str().to_owned();
        entries.push(review_entry(
            PluginPermissionReviewSubjectV2::Permission,
            PluginPermissionReviewFieldV2::Presence,
            vec![kind.clone()],
            PluginPermissionReviewValueV2::Boolean { value: true },
        ));
        let parameter_policy = policy
            .get(&permission.kind)
            .expect("canonical permissions were validated against this policy");
        for (parameter, values) in &permission.parameters {
            let key = vec![kind.clone(), parameter.clone()];
            let required = parameter_policy
                .get(parameter)
                .expect("canonical permission parameters were validated")
                .0;
            entries.push(review_entry(
                PluginPermissionReviewSubjectV2::Permission,
                PluginPermissionReviewFieldV2::Required,
                key.clone(),
                PluginPermissionReviewValueV2::Boolean { value: required },
            ));
            entries.push(review_entry(
                PluginPermissionReviewSubjectV2::Permission,
                PluginPermissionReviewFieldV2::GrantedValues,
                key,
                PluginPermissionReviewValueV2::StringList {
                    values: values.clone(),
                },
            ));
        }
    }
    for resource in catalog_resources {
        entries.push(review_string_entry(
            PluginPermissionReviewSubjectV2::CatalogResource,
            PluginPermissionReviewFieldV2::ContentSha256,
            vec![resource.resource().as_str().to_owned()],
            resource.sha256(),
        ));
    }

    PluginPermissionReviewProjectionV2::new(plan.digest.clone(), entries)
}

fn review_entry(
    subject: PluginPermissionReviewSubjectV2,
    field: PluginPermissionReviewFieldV2,
    key_segments: Vec<String>,
    value: PluginPermissionReviewValueV2,
) -> PluginPermissionReviewEntryV2 {
    PluginPermissionReviewEntryV2 {
        subject,
        field,
        key_segments,
        value,
    }
}

fn review_string_entry(
    subject: PluginPermissionReviewSubjectV2,
    field: PluginPermissionReviewFieldV2,
    key_segments: Vec<String>,
    value: &str,
) -> PluginPermissionReviewEntryV2 {
    review_entry(
        subject,
        field,
        key_segments,
        PluginPermissionReviewValueV2::String {
            value: value.to_owned(),
        },
    )
}

fn placement_name(placement: &PluginPlacementV2) -> &'static str {
    match placement {
        PluginPlacementV2::Ui => "ui",
        PluginPlacementV2::Workspace => "workspace",
        PluginPlacementV2::Either => "either",
    }
}

fn canonical_permissions(
    permissions: &[PermissionRequestV2],
    policy: &ValidatedPermissionPolicy,
) -> Result<Vec<PermissionRequestV2>, PluginPermissionErrorV2> {
    let mut result = Vec::with_capacity(permissions.len());
    for permission in permissions {
        let Some(parameter_policy) = policy.get(&permission.kind) else {
            return Err(PluginPermissionErrorV2::UnknownPermissionKind {
                kind: permission.kind.clone(),
            });
        };
        for required in parameter_policy
            .iter()
            .filter_map(|(parameter, (required, _))| required.then_some(parameter))
        {
            if !permission.parameters.contains_key(required) {
                return Err(
                    PluginPermissionErrorV2::MissingRequiredPermissionParameter {
                        kind: permission.kind.clone(),
                        parameter: required.clone(),
                    },
                );
            }
        }
        let mut parameters = BTreeMap::new();
        for (parameter, values) in &permission.parameters {
            let Some((_, allowed_values)) = parameter_policy.get(parameter) else {
                return Err(PluginPermissionErrorV2::UnknownPermissionParameter {
                    kind: permission.kind.clone(),
                    parameter: parameter.clone(),
                });
            };
            let mut values = values.clone();
            values.sort();
            for value in &values {
                if allowed_values.binary_search(value).is_err() {
                    return Err(PluginPermissionErrorV2::UnknownPermissionParameterValue {
                        kind: permission.kind.clone(),
                        parameter: parameter.clone(),
                        value: value.clone(),
                    });
                }
            }
            parameters.insert(parameter.clone(), values);
        }
        result.push(PermissionRequestV2 {
            kind: permission.kind.clone(),
            parameters,
        });
    }
    Ok(result)
}

fn unsupported_outcome(outcome: PluginCompatibilityOutcomeV2) -> PluginPermissionErrorV2 {
    let reason = match outcome {
        PluginCompatibilityOutcomeV2::IncompatibleHostApi { .. } => "incompatible host API",
        PluginCompatibilityOutcomeV2::UnsupportedRequiredContributions { .. } => {
            "unsupported required contribution"
        }
        PluginCompatibilityOutcomeV2::UnsupportedRequiredAgentIntegrations { .. } => {
            "unsupported required agent integration"
        }
        PluginCompatibilityOutcomeV2::UnsupportedPermissions { .. } => {
            "unsupported permission kind"
        }
        PluginCompatibilityOutcomeV2::Supported { .. } => {
            unreachable!("supported outcomes are handled before this helper")
        }
    };
    PluginPermissionErrorV2::UnsupportedManifest {
        reason: reason.to_owned(),
    }
}

fn digest_applied_policy(
    permissions: &[PermissionRequestV2],
    policy: &ValidatedPermissionPolicy,
) -> PluginPermissionPolicyDigestV2 {
    let mut encoder = DigestEncoder::new(b"dure.plugin.applied-permission-policy.v2\0");
    encoder.sequence(permissions, |encoder, permission| {
        encoder.string(permission.kind.as_str());
        let parameter_policy = policy
            .get(&permission.kind)
            .expect("canonical permissions were validated against this policy");
        encoder.u32(permission.parameters.len() as u32);
        for (parameter, values) in &permission.parameters {
            encoder.string(parameter);
            encoder.boolean(
                parameter_policy
                    .get(parameter)
                    .expect("canonical permission parameters were validated")
                    .0,
            );
            encoder.sequence(values, |encoder, value| encoder.string(value));
        }
    });
    PluginPermissionPolicyDigestV2(sha256_bytes(encoder.finish()))
}

fn digest_plan(plan: &PluginPermissionPlanV2) -> PluginPermissionPlanDigestV2 {
    let mut encoder = DigestEncoder::new(b"dure.plugin.permission-plan.v2\0");
    encoder.u16(plan.schema_version);
    encoder.string(plan.identity.plugin_id.as_str());
    encoder.string(plan.identity.publisher.as_str());
    encoder.string(plan.identity.version.as_str());
    encoder.string(plan.authority.authority.as_str());
    encoder.string(plan.authority.catalog_snapshot_sha256.as_str());
    encoder.string(plan.workspace_identity.as_str());
    encoder.string(plan.catalog_selection.source_id.as_str());
    encoder.string(plan.catalog_selection.candidate_id.as_str());
    encoder.string(plan.applied_policy_digest.as_str());
    encoder.u16(plan.negotiated_host_api_version);
    encoder.sequence(&plan.activation, |encoder, event| match event {
        PluginActivationEventV2::Explicit => encoder.string("explicit"),
        PluginActivationEventV2::WorkspaceContains { pattern } => {
            encoder.string("workspace_contains");
            encoder.string(pattern);
        }
    });
    encoder.sequence(&plan.contributions, |encoder, contribution| {
        encoder.string(contribution.id.as_str());
        encoder.string(contribution.family.as_str());
        encoder.u16(contribution.family_api_version);
        encoder.boolean(contribution.required);
        encoder.string(match contribution.placement {
            PluginPlacementV2::Ui => "ui",
            PluginPlacementV2::Workspace => "workspace",
            PluginPlacementV2::Either => "either",
        });
        encoder.string(contribution.resource.as_str());
    });
    encoder.sequence(&plan.ignored_optional_contributions, |encoder, id| {
        encoder.string(id.as_str())
    });
    encoder.sequence(&plan.agent_integrations, |encoder, integration| {
        encoder.string(integration.id.as_str());
        encoder.string(integration.adapter.as_str());
        encoder.boolean(integration.required);
        encoder.string(integration.resource.as_str());
        encoder.string(integration.selector.plugin.as_str());
        encoder.string(integration.selector.marketplace.as_str());
    });
    encoder.sequence(&plan.ignored_optional_agent_integrations, |encoder, id| {
        encoder.string(id.as_str())
    });
    encoder.sequence(&plan.permissions, |encoder, permission| {
        encoder.string(permission.kind.as_str());
        encoder.u32(permission.parameters.len() as u32);
        for (parameter, values) in &permission.parameters {
            encoder.string(parameter);
            encoder.sequence(values, |encoder, value| encoder.string(value));
        }
    });
    PluginPermissionPlanDigestV2(sha256_bytes(encoder.finish()))
}

fn digest_review_projection(
    projection: &PluginPermissionReviewProjectionV2,
) -> PluginPermissionReviewProjectionDigestV2 {
    let mut encoder = DigestEncoder::new(b"dure.plugin.permission-review-projection.v2\0");
    encoder.u16(projection.schema_version);
    encoder.string(projection.plan_digest.as_str());
    encoder.sequence(&projection.entries, |encoder, entry| {
        encoder.string(entry.subject.as_str());
        encoder.sequence(&entry.key_segments, |encoder, segment| {
            encoder.string(segment)
        });
        encoder.string(entry.field.as_str());
        match &entry.value {
            PluginPermissionReviewValueV2::Boolean { value } => {
                encoder.string("boolean");
                encoder.boolean(*value);
            }
            PluginPermissionReviewValueV2::U16 { value } => {
                encoder.string("u16");
                encoder.u16(*value);
            }
            PluginPermissionReviewValueV2::String { value } => {
                encoder.string("string");
                encoder.string(value);
            }
            PluginPermissionReviewValueV2::StringList { values } => {
                encoder.string("string_list");
                encoder.sequence(values, |encoder, value| encoder.string(value));
            }
        }
    });
    PluginPermissionReviewProjectionDigestV2(sha256_bytes(encoder.finish()))
}

fn compare_review_entry_keys(
    left: &PluginPermissionReviewEntryV2,
    right: &PluginPermissionReviewEntryV2,
) -> Ordering {
    left.subject
        .as_str()
        .as_bytes()
        .cmp(right.subject.as_str().as_bytes())
        .then_with(|| left.key_segments.cmp(&right.key_segments))
        .then_with(|| {
            left.field
                .as_str()
                .as_bytes()
                .cmp(right.field.as_str().as_bytes())
        })
}

fn validate_review_entry(
    entry: &PluginPermissionReviewEntryV2,
) -> Result<(), PluginPermissionErrorV2> {
    if entry.key_segments.len() > MAX_PLUGIN_PERMISSION_REVIEW_KEY_SEGMENTS_V2 {
        return Err(review_projection_limit(
            "review projection entry has too many key segments",
        ));
    }
    if entry
        .key_segments
        .iter()
        .any(|segment| segment.len() > MAX_PLUGIN_PERMISSION_REVIEW_KEY_SEGMENT_BYTES_V2)
    {
        return Err(review_projection_limit(
            "review projection key segment is too large",
        ));
    }
    if entry
        .key_segments
        .iter()
        .any(|segment| segment.is_empty() || segment.contains('\0'))
    {
        return Err(invalid_projection(
            "review projection contains an invalid key",
        ));
    }
    match &entry.value {
        PluginPermissionReviewValueV2::Boolean { .. }
        | PluginPermissionReviewValueV2::U16 { .. } => {}
        PluginPermissionReviewValueV2::String { value } => {
            validate_review_value(value)?;
        }
        PluginPermissionReviewValueV2::StringList { values } => {
            if values.len() > MAX_PLUGIN_PERMISSION_REVIEW_LIST_VALUES_V2 {
                return Err(review_projection_limit(
                    "review projection string list has too many values",
                ));
            }
            for value in values {
                validate_review_value(value)?;
            }
            if values.windows(2).any(|pair| pair[0] >= pair[1]) {
                return Err(invalid_projection(
                    "review projection contains an invalid string list",
                ));
            }
        }
    }
    if !valid_review_entry_shape(entry) {
        return Err(invalid_projection(
            "review projection contains an invalid subject/field/value combination",
        ));
    }
    if matches!(
        entry.field,
        PluginPermissionReviewFieldV2::CatalogSnapshotSha256
            | PluginPermissionReviewFieldV2::AppliedPolicyDigest
            | PluginPermissionReviewFieldV2::ContentSha256
    ) {
        let PluginPermissionReviewValueV2::String { value } = &entry.value else {
            unreachable!("review entry shape requires a string digest")
        };
        validate_sha256("plugin permission review fingerprint", value)?;
    }
    Ok(())
}

fn validate_review_value(value: &str) -> Result<(), PluginPermissionErrorV2> {
    if value.len() > MAX_PLUGIN_PERMISSION_REVIEW_VALUE_BYTES_V2 {
        return Err(review_projection_limit(
            "review projection value is too large",
        ));
    }
    if value.is_empty() || value.contains('\0') {
        Err(invalid_projection(
            "review projection contains an invalid value",
        ))
    } else {
        Ok(())
    }
}

fn valid_review_entry_shape(entry: &PluginPermissionReviewEntryV2) -> bool {
    let key_count = entry.key_segments.len();
    matches!(
        (entry.subject, entry.field, &entry.value, key_count),
        (
            PluginPermissionReviewSubjectV2::Plan,
            PluginPermissionReviewFieldV2::SchemaVersion
                | PluginPermissionReviewFieldV2::NegotiatedHostApiVersion,
            PluginPermissionReviewValueV2::U16 { .. },
            0,
        ) | (
            PluginPermissionReviewSubjectV2::Plan,
            PluginPermissionReviewFieldV2::AppliedPolicyDigest,
            PluginPermissionReviewValueV2::String { .. },
            0,
        ) | (
            PluginPermissionReviewSubjectV2::Identity,
            PluginPermissionReviewFieldV2::PluginId
                | PluginPermissionReviewFieldV2::Publisher
                | PluginPermissionReviewFieldV2::Version,
            PluginPermissionReviewValueV2::String { .. },
            0,
        ) | (
            PluginPermissionReviewSubjectV2::Authority,
            PluginPermissionReviewFieldV2::AuthorityId
                | PluginPermissionReviewFieldV2::CatalogSnapshotSha256,
            PluginPermissionReviewValueV2::String { .. },
            0,
        ) | (
            PluginPermissionReviewSubjectV2::Workspace,
            PluginPermissionReviewFieldV2::WorkspaceIdentity,
            PluginPermissionReviewValueV2::String { .. },
            0,
        ) | (
            PluginPermissionReviewSubjectV2::CatalogSelection,
            PluginPermissionReviewFieldV2::SourceId | PluginPermissionReviewFieldV2::CandidateId,
            PluginPermissionReviewValueV2::String { .. },
            0,
        ) | (
            PluginPermissionReviewSubjectV2::Activation,
            PluginPermissionReviewFieldV2::Presence,
            PluginPermissionReviewValueV2::Boolean { value: true },
            1,
        ) | (
            PluginPermissionReviewSubjectV2::Activation,
            PluginPermissionReviewFieldV2::Pattern,
            PluginPermissionReviewValueV2::String { .. },
            1,
        ) | (
            PluginPermissionReviewSubjectV2::Contribution,
            PluginPermissionReviewFieldV2::Family
                | PluginPermissionReviewFieldV2::Placement
                | PluginPermissionReviewFieldV2::Resource,
            PluginPermissionReviewValueV2::String { .. },
            1,
        ) | (
            PluginPermissionReviewSubjectV2::Contribution,
            PluginPermissionReviewFieldV2::FamilyApiVersion,
            PluginPermissionReviewValueV2::U16 { .. },
            1,
        ) | (
            PluginPermissionReviewSubjectV2::Contribution,
            PluginPermissionReviewFieldV2::Required,
            PluginPermissionReviewValueV2::Boolean { .. },
            1,
        ) | (
            PluginPermissionReviewSubjectV2::IgnoredOptionalContribution
                | PluginPermissionReviewSubjectV2::IgnoredOptionalAgentIntegration,
            PluginPermissionReviewFieldV2::Presence,
            PluginPermissionReviewValueV2::Boolean { value: true },
            1,
        ) | (
            PluginPermissionReviewSubjectV2::AgentIntegration,
            PluginPermissionReviewFieldV2::Adapter
                | PluginPermissionReviewFieldV2::Resource
                | PluginPermissionReviewFieldV2::SelectorPlugin
                | PluginPermissionReviewFieldV2::SelectorMarketplace,
            PluginPermissionReviewValueV2::String { .. },
            1,
        ) | (
            PluginPermissionReviewSubjectV2::AgentIntegration,
            PluginPermissionReviewFieldV2::Required,
            PluginPermissionReviewValueV2::Boolean { .. },
            1,
        ) | (
            PluginPermissionReviewSubjectV2::Permission,
            PluginPermissionReviewFieldV2::Presence,
            PluginPermissionReviewValueV2::Boolean { value: true },
            1,
        ) | (
            PluginPermissionReviewSubjectV2::Permission,
            PluginPermissionReviewFieldV2::Required,
            PluginPermissionReviewValueV2::Boolean { .. },
            2,
        ) | (
            PluginPermissionReviewSubjectV2::Permission,
            PluginPermissionReviewFieldV2::GrantedValues,
            PluginPermissionReviewValueV2::StringList { .. },
            2,
        ) | (
            PluginPermissionReviewSubjectV2::CatalogResource,
            PluginPermissionReviewFieldV2::ContentSha256,
            PluginPermissionReviewValueV2::String { .. },
            1,
        )
    )
}

fn is_catalog_snapshot_entry(entry: &PluginPermissionReviewEntryV2) -> bool {
    entry.subject == PluginPermissionReviewSubjectV2::Authority
        && entry.field == PluginPermissionReviewFieldV2::CatalogSnapshotSha256
}

fn is_catalog_resource_fingerprint_entry(entry: &PluginPermissionReviewEntryV2) -> bool {
    entry.subject == PluginPermissionReviewSubjectV2::CatalogResource
        && entry.field == PluginPermissionReviewFieldV2::ContentSha256
}

struct DigestEncoder {
    bytes: Vec<u8>,
}

impl DigestEncoder {
    fn new(domain: &[u8]) -> Self {
        Self {
            bytes: domain.to_vec(),
        }
    }

    fn string(&mut self, value: &str) {
        self.u32(value.len() as u32);
        self.bytes.extend_from_slice(value.as_bytes());
    }

    fn boolean(&mut self, value: bool) {
        self.bytes.push(u8::from(value));
    }

    fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_be_bytes());
    }

    fn sequence<T>(&mut self, values: &[T], mut encode: impl FnMut(&mut Self, &T)) {
        self.u32(values.len() as u32);
        for value in values {
            encode(self, value);
        }
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

fn validate_sha256(label: &'static str, value: &str) -> Result<(), PluginPermissionErrorV2> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(PluginPermissionErrorV2::InvalidSha256 { label });
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(PluginPermissionErrorV2::InvalidSha256 { label });
    }
    Ok(())
}

fn validate_parameter_value(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 512 || value.contains('\0') {
        Err("permission parameter contains an invalid value".to_owned())
    } else {
        Ok(())
    }
}

fn sort_unique<T: Ord>(label: &str, values: &mut [T]) -> Result<(), PluginPermissionErrorV2> {
    values.sort();
    if values.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(PluginPermissionErrorV2::InvalidPlanInput {
            reason: format!("{label} must be unique"),
        });
    }
    Ok(())
}

fn invalid_policy(reason: impl Into<String>) -> PluginPermissionErrorV2 {
    PluginPermissionErrorV2::InvalidPolicy {
        reason: reason.into(),
    }
}

fn invalid_projection(reason: impl Into<String>) -> PluginPermissionErrorV2 {
    PluginPermissionErrorV2::InvalidPlanInput {
        reason: format!("invalid review projection: {}", reason.into()),
    }
}

fn review_projection_limit(reason: impl Into<String>) -> PluginPermissionErrorV2 {
    PluginPermissionErrorV2::ReviewProjectionLimitExceeded {
        reason: reason.into(),
    }
}

fn sha256_bytes(value: impl AsRef<[u8]>) -> String {
    let digest = Sha256::digest(value.as_ref());
    format!("sha256:{digest:x}")
}
