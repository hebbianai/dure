//! Fail-closed verification for signed Hmux release artifacts.
//!
//! TUF signature, threshold, rotation, expiry, rollback, and mix-and-match
//! verification is delegated to the pinned `tough` implementation. This crate
//! adds the product contract that TUF intentionally treats as opaque:
//! channel binding, absolute byte limits, target identity, protocol
//! compatibility, and success-only trusted-state advancement.

#[cfg(feature = "conformance")]
mod conformance;

#[cfg(feature = "conformance")]
pub use conformance::run_conformance_client;

use async_trait::async_trait;
use futures_util::StreamExt;
use semver::Version;
use serde::de::{self, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::error::Error as _;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::TempDir;
use thiserror::Error;
use tokio::io::AsyncReadExt;
use tough::{
    Bytes, ExpirationEnforcement, IntoVec, Limits, Prefix, RepositoryLoader, TargetName, Transport,
    TransportError, TransportErrorKind, TransportStream,
};
use url::Url;

/// Maximum successful sequential root transitions accepted in one refresh.
pub const MAX_ROOT_ROTATIONS: u64 = 32;
/// Absolute maximum bytes for one root role.
pub const MAX_ROOT_BYTES: u64 = 512 * 1024;
/// Absolute maximum bytes for timestamp metadata.
pub const MAX_TIMESTAMP_BYTES: u64 = 64 * 1024;
/// Absolute maximum bytes for snapshot metadata.
pub const MAX_SNAPSHOT_BYTES: u64 = 512 * 1024;
/// Absolute maximum bytes for top-level targets metadata.
pub const MAX_TARGETS_BYTES: u64 = 2 * 1024 * 1024;
/// Absolute maximum bytes for one release target.
pub const MAX_TARGET_BYTES: u64 = 256 * 1024 * 1024;
/// Maximum targets allowed in top-level targets metadata.
pub const MAX_TARGETS: usize = 64;
/// Maximum checkpoint plus sequential roots retained for one refresh.
pub const MAX_TRUSTED_ROOTS: usize = MAX_ROOT_ROTATIONS as usize + 1;
/// Maximum encoded owner-protected proof size accepted before JSON parsing.
pub const MAX_PROOF_BYTES: usize = 128 * 1024 * 1024;
const ROOT_EXPIRY_HORIZON_SECONDS: i64 = 365 * 24 * 60 * 60;
const TARGETS_EXPIRY_HORIZON_SECONDS: i64 = 90 * 24 * 60 * 60;
const SNAPSHOT_EXPIRY_HORIZON_SECONDS: i64 = 7 * 24 * 60 * 60;
const TIMESTAMP_EXPIRY_HORIZON_SECONDS: i64 = 24 * 60 * 60;
const RECEIPT_SCHEMA_VERSION: u64 = 1;
const STABLE_METADATA_BASE_URL: &str = "https://updates.dureai.dev/hmux/stable/metadata/";
const STABLE_TARGETS_BASE_URL: &str = "https://updates.dureai.dev/hmux/stable/targets/";
const CANARY_METADATA_BASE_URL: &str = "https://updates.dureai.dev/hmux/canary/metadata/";
const CANARY_TARGETS_BASE_URL: &str = "https://updates.dureai.dev/hmux/canary/targets/";

const STATE_FILES: [&str; 5] = [
    "root.json",
    "timestamp.json",
    "snapshot.json",
    "targets.json",
    "latest_known_time.json",
];

/// A release feed whose root, URLs, and trusted state are isolated.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseChannel {
    /// Production release feed.
    Stable,
    /// Development-only release feed.
    Canary,
}

impl fmt::Display for ReleaseChannel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stable => formatter.write_str("stable"),
            Self::Canary => formatter.write_str("canary"),
        }
    }
}

/// A supported remote artifact destination.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub enum ArtifactTarget {
    /// Static x86-64 Linux build.
    #[serde(rename = "x86_64-unknown-linux-musl")]
    X86_64LinuxMusl,
    /// Static AArch64 Linux build.
    #[serde(rename = "aarch64-unknown-linux-musl")]
    Aarch64LinuxMusl,
}

impl ArtifactTarget {
    /// Return the exact Rust target triple.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::X86_64LinuxMusl => "x86_64-unknown-linux-musl",
            Self::Aarch64LinuxMusl => "aarch64-unknown-linux-musl",
        }
    }
}

impl fmt::Display for ArtifactTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A numeric Hmux wire protocol version.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub struct ProtocolVersion {
    major: u64,
    minor: u64,
}

impl ProtocolVersion {
    /// Construct a protocol version.
    #[must_use]
    pub const fn new(major: u64, minor: u64) -> Self {
        Self { major, minor }
    }

    /// Parse the exact unsigned `major.minor` wire representation.
    ///
    /// Release publishers use the same parser as verifiers so a candidate
    /// cannot sign a compatibility interval that the application interprets
    /// differently.
    pub fn parse(value: &str) -> Result<Self, VerifyError> {
        let (major, minor) = value
            .split_once('.')
            .ok_or_else(|| VerifyError::InvalidProtocolVersion(value.to_owned()))?;
        if major.is_empty()
            || minor.is_empty()
            || !major.bytes().all(|byte| byte.is_ascii_digit())
            || !minor.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(VerifyError::InvalidProtocolVersion(value.to_owned()));
        }
        Ok(Self {
            major: major
                .parse()
                .map_err(|_| VerifyError::InvalidProtocolVersion(value.to_owned()))?,
            minor: minor
                .parse()
                .map_err(|_| VerifyError::InvalidProtocolVersion(value.to_owned()))?,
        })
    }
}

/// Channel-bound TUF bootstrap inputs.
#[derive(Clone, Debug)]
pub struct ChannelTrust {
    channel: ReleaseChannel,
    bootstrap_root: Vec<u8>,
    metadata_base_url: Url,
    targets_base_url: Url,
    fixture_policy_reference_unix_seconds: Option<i64>,
}

impl ChannelTrust {
    /// Bind a channel to one pinned public root and two HTTPS base URLs.
    pub fn new(
        channel: ReleaseChannel,
        bootstrap_root: Vec<u8>,
        metadata_base_url: Url,
        targets_base_url: Url,
    ) -> Result<Self, VerifyError> {
        Self::new_at(
            channel,
            bootstrap_root,
            metadata_base_url,
            targets_base_url,
            None,
        )
    }

    /// Construct trust for committed public fixtures.
    ///
    /// This escape hatch is limited to RFC 2606 `.invalid` origins, so a
    /// caller cannot use a synthetic policy clock with a reachable release
    /// feed. Production callers must use [`Self::new`].
    #[doc(hidden)]
    pub fn new_for_fixture(
        channel: ReleaseChannel,
        bootstrap_root: Vec<u8>,
        metadata_base_url: Url,
        targets_base_url: Url,
        policy_reference_unix_seconds: i64,
    ) -> Result<Self, VerifyError> {
        Self::new_at(
            channel,
            bootstrap_root,
            metadata_base_url,
            targets_base_url,
            Some(policy_reference_unix_seconds),
        )
    }

    fn new_at(
        channel: ReleaseChannel,
        bootstrap_root: Vec<u8>,
        metadata_base_url: Url,
        targets_base_url: Url,
        fixture_policy_reference_unix_seconds: Option<i64>,
    ) -> Result<Self, VerifyError> {
        validate_base_url(&metadata_base_url)?;
        validate_base_url(&targets_base_url)?;
        let fixture = fixture_policy_reference_unix_seconds.is_some();
        if fixture && (!is_fixture_url(&metadata_base_url) || !is_fixture_url(&targets_base_url)) {
            return Err(VerifyError::FixtureClockRequiresInvalidOrigin);
        }
        if same_base_url(&metadata_base_url, &targets_base_url) {
            return Err(VerifyError::OverlappingRepositoryBases);
        }
        let metadata_base_url = with_trailing_slash(metadata_base_url);
        let targets_base_url = with_trailing_slash(targets_base_url);
        if !fixture {
            let (expected_metadata, expected_targets) = production_repository_bases(channel);
            if metadata_base_url.as_str() != expected_metadata
                || targets_base_url.as_str() != expected_targets
            {
                return Err(VerifyError::ProductionRepositoryMismatch);
            }
        }
        if bootstrap_root.len() as u64 > MAX_ROOT_BYTES {
            return Err(VerifyError::BootstrapRootTooLarge {
                actual: bootstrap_root.len() as u64,
                maximum: MAX_ROOT_BYTES,
            });
        }
        Ok(Self {
            channel,
            bootstrap_root,
            metadata_base_url,
            targets_base_url,
            fixture_policy_reference_unix_seconds,
        })
    }
}

/// Exact immutable trusted metadata from a previously successful refresh.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TrustedState {
    /// Digest of the compiled bootstrap root that established this local
    /// owner-protected checkpoint.
    bootstrap_root_sha256: Option<String>,
    /// Most recently trusted root.
    root_json: Option<Vec<u8>>,
    /// Most recently trusted timestamp.
    timestamp_json: Option<Vec<u8>>,
    /// Most recently trusted snapshot.
    snapshot_json: Option<Vec<u8>>,
    /// Most recently trusted targets.
    targets_json: Option<Vec<u8>>,
    /// `tough`'s monotonic wall-clock watermark.
    latest_known_time_json: Option<Vec<u8>>,
    /// Length-delimited digest of all exact files and the root chain.
    integrity_sha256: Option<String>,
    /// Exact local checkpoint-to-current chain for the most recent refresh.
    ///
    /// The first entry is the previously trusted current root (or the compiled
    /// bootstrap for the first refresh); later entries are the roots observed
    /// during this refresh. Older transitions are compacted after promotion.
    #[serde(deserialize_with = "deserialize_root_chain")]
    root_chain: Vec<Vec<u8>>,
}

fn deserialize_root_chain<'de, D>(deserializer: D) -> Result<Vec<Vec<u8>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct RootChainVisitor;

    impl<'de> Visitor<'de> for RootChainVisitor {
        type Value = Vec<Vec<u8>>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a bounded trusted-root transition chain")
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            let capacity = sequence.size_hint().unwrap_or(0).min(MAX_TRUSTED_ROOTS);
            let mut roots = Vec::with_capacity(capacity);
            while roots.len() < MAX_TRUSTED_ROOTS {
                let Some(root) = sequence.next_element::<BoundedRootBytes>()? else {
                    return Ok(roots);
                };
                roots.push(root.0);
            }
            if sequence.next_element::<de::IgnoredAny>()?.is_some() {
                return Err(de::Error::custom(
                    "trusted root transition count exceeds local bound",
                ));
            }
            Ok(roots)
        }
    }

    deserializer.deserialize_seq(RootChainVisitor)
}

struct BoundedRootBytes(Vec<u8>);

impl<'de> Deserialize<'de> for BoundedRootBytes {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct RootBytesVisitor;

        impl<'de> Visitor<'de> for RootBytesVisitor {
            type Value = BoundedRootBytes;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("bounded trusted-root bytes")
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let maximum = usize::try_from(MAX_ROOT_BYTES).unwrap_or(usize::MAX);
                let capacity = sequence.size_hint().unwrap_or(0).min(maximum);
                let mut bytes = Vec::with_capacity(capacity);
                while bytes.len() < maximum {
                    let Some(byte) = sequence.next_element::<u8>()? else {
                        return Ok(BoundedRootBytes(bytes));
                    };
                    bytes.push(byte);
                }
                if sequence.next_element::<de::IgnoredAny>()?.is_some() {
                    return Err(de::Error::custom("trusted root bytes exceed local bound"));
                }
                Ok(BoundedRootBytes(bytes))
            }
        }

        deserializer.deserialize_seq(RootBytesVisitor)
    }
}

impl TrustedState {
    /// Return whether this opaque state contains a successful refresh.
    #[must_use]
    pub fn is_initialized(&self) -> bool {
        !self.is_empty()
    }

    fn is_empty(&self) -> bool {
        self.present_count() == 0
            && self.bootstrap_root_sha256.is_none()
            && self.integrity_sha256.is_none()
            && self.root_chain.is_empty()
    }

    fn present_count(&self) -> usize {
        [
            &self.root_json,
            &self.timestamp_json,
            &self.snapshot_json,
            &self.targets_json,
            &self.latest_known_time_json,
        ]
        .into_iter()
        .filter(|value| value.is_some())
        .count()
    }

    fn validate(&self) -> Result<(), VerifyError> {
        if self.is_empty() {
            return Ok(());
        }
        if self.present_count() != STATE_FILES.len() {
            return Err(VerifyError::IncompleteTrustedState);
        }
        let bootstrap_root_sha256 = self
            .bootstrap_root_sha256
            .as_deref()
            .ok_or(VerifyError::IncompleteTrustedState)?;
        validate_lower_hex(bootstrap_root_sha256, 64)
            .map_err(|()| VerifyError::TrustedStateIntegrityMismatch)?;
        if self.root_chain.is_empty() {
            return Err(VerifyError::IncompleteTrustedState);
        }
        if self.root_chain.len() > maximum_root_chain_len() {
            return Err(VerifyError::TooManyTrustedRoots {
                actual: self.root_chain.len(),
                maximum: maximum_root_chain_len(),
            });
        }
        for root in &self.root_chain {
            validate_json_state("root-chain", Some(root), MAX_ROOT_BYTES)?;
        }
        validate_json_state("root.json", self.root_json.as_deref(), MAX_ROOT_BYTES)?;
        validate_json_state(
            "timestamp.json",
            self.timestamp_json.as_deref(),
            MAX_TIMESTAMP_BYTES,
        )?;
        validate_json_state(
            "snapshot.json",
            self.snapshot_json.as_deref(),
            MAX_SNAPSHOT_BYTES,
        )?;
        validate_json_state(
            "targets.json",
            self.targets_json.as_deref(),
            MAX_TARGETS_BYTES,
        )?;
        validate_json_state(
            "latest_known_time.json",
            self.latest_known_time_json.as_deref(),
            128,
        )?;
        let actual = self
            .integrity_sha256
            .as_deref()
            .ok_or(VerifyError::IncompleteTrustedState)?;
        validate_lower_hex(actual, 64).map_err(|()| VerifyError::TrustedStateIntegrityMismatch)?;
        if actual != self.compute_integrity_sha256() {
            return Err(VerifyError::TrustedStateIntegrityMismatch);
        }
        Ok(())
    }

    fn refresh_integrity_sha256(&mut self) -> Result<(), VerifyError> {
        if self.present_count() != STATE_FILES.len() {
            return Err(VerifyError::IncompleteTrustedState);
        }
        self.integrity_sha256 = Some(self.compute_integrity_sha256());
        Ok(())
    }

    async fn write_to(&self, directory: &Path) -> Result<(), VerifyError> {
        if self.is_empty() {
            return Ok(());
        }
        for (name, bytes) in self.entries() {
            tokio::fs::write(directory.join(name), bytes)
                .await
                .map_err(|source| VerifyError::StateIo { name, source })?;
        }
        Ok(())
    }

    async fn read_from(directory: &Path) -> Result<Self, VerifyError> {
        let state = Self {
            bootstrap_root_sha256: None,
            root_json: Some(read_state_file(directory, "root.json").await?),
            timestamp_json: Some(read_state_file(directory, "timestamp.json").await?),
            snapshot_json: Some(read_state_file(directory, "snapshot.json").await?),
            targets_json: Some(read_state_file(directory, "targets.json").await?),
            latest_known_time_json: Some(
                read_state_file(directory, "latest_known_time.json").await?,
            ),
            integrity_sha256: None,
            root_chain: Vec::new(),
        };
        Ok(state)
    }

    fn replace_with_observed(
        &mut self,
        observed: &Arc<Mutex<ObservedMetadata>>,
        bootstrap_root: &[u8],
        previous_state: &Self,
    ) -> Result<(), VerifyError> {
        let observed = observed
            .lock()
            .map_err(|_| VerifyError::ObservedMetadataUnavailable)?;
        self.bootstrap_root_sha256 = Some(sha256_hex(bootstrap_root));
        self.root_chain = vec![
            previous_state
                .root_json
                .as_deref()
                .unwrap_or(bootstrap_root)
                .to_vec(),
        ];
        self.root_chain.extend(observed.roots.values().cloned());
        self.root_json = self.root_chain.last().cloned();
        self.timestamp_json = Some(
            observed
                .timestamp
                .clone()
                .ok_or(VerifyError::ObservedMetadataUnavailable)?,
        );
        self.snapshot_json = Some(
            observed
                .snapshot
                .clone()
                .ok_or(VerifyError::ObservedMetadataUnavailable)?,
        );
        self.targets_json = Some(
            observed
                .targets
                .clone()
                .ok_or(VerifyError::ObservedMetadataUnavailable)?,
        );
        self.integrity_sha256 = None;
        self.refresh_integrity_sha256()
    }

    fn entries(&self) -> [(&'static str, &[u8]); 5] {
        [
            (
                "root.json",
                self.root_json.as_deref().expect("validated complete state"),
            ),
            (
                "timestamp.json",
                self.timestamp_json
                    .as_deref()
                    .expect("validated complete state"),
            ),
            (
                "snapshot.json",
                self.snapshot_json
                    .as_deref()
                    .expect("validated complete state"),
            ),
            (
                "targets.json",
                self.targets_json
                    .as_deref()
                    .expect("validated complete state"),
            ),
            (
                "latest_known_time.json",
                self.latest_known_time_json
                    .as_deref()
                    .expect("validated complete state"),
            ),
        ]
    }

    fn compute_integrity_sha256(&self) -> String {
        let mut digest = Sha256::new();
        for (name, bytes) in self.entries() {
            digest.update(u64::try_from(name.len()).unwrap_or(u64::MAX).to_be_bytes());
            digest.update(name.as_bytes());
            digest.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
            digest.update(bytes);
        }
        let bootstrap_root_sha256 = self
            .bootstrap_root_sha256
            .as_deref()
            .expect("validated complete state");
        digest.update(
            u64::try_from(bootstrap_root_sha256.len())
                .unwrap_or(u64::MAX)
                .to_be_bytes(),
        );
        digest.update(bootstrap_root_sha256.as_bytes());
        digest.update(
            u64::try_from(self.root_chain.len())
                .unwrap_or(u64::MAX)
                .to_be_bytes(),
        );
        for root in &self.root_chain {
            digest.update(u64::try_from(root.len()).unwrap_or(u64::MAX).to_be_bytes());
            digest.update(root);
        }
        hex::encode(digest.finalize())
    }
}

/// Caller-controlled selection that must agree with signed target metadata.
#[derive(Clone, Debug)]
pub struct ExpectedTarget {
    /// Logical TUF target name.
    pub target_name: String,
    /// Explicit remote destination triple.
    pub destination: ArtifactTarget,
    /// Protocol spoken by the installer/runtime pair.
    pub protocol: ProtocolVersion,
}

/// Signed application-specific target fields.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SignedTargetMetadata {
    /// Custom metadata schema.
    pub schema_version: u64,
    /// Must be `hmux`.
    pub product: String,
    /// Must match the root-bound channel.
    pub channel: ReleaseChannel,
    /// Target-specific immutable build identity.
    pub build_id: String,
    /// Full lowercase source commit.
    pub source_commit: String,
    /// Explicit artifact destination.
    pub target_triple: ArtifactTarget,
    /// Must be `tar.gz`.
    pub archive_format: String,
    /// SemVer package version.
    pub package_version: String,
    /// Inclusive minimum protocol.
    pub protocol_minimum: String,
    /// Inclusive maximum protocol.
    pub protocol_maximum: String,
    /// Expected digest of the extracted immutable tree.
    pub installed_tree_sha256: String,
}

/// Role versions and exact-byte digests retained for activation and rollback.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VerificationReceipt {
    /// Receipt schema for durable compatibility checks.
    pub schema_version: u64,
    /// Feed used for verification.
    pub channel: ReleaseChannel,
    /// Digest of the out-of-band bootstrap root used for this refresh.
    pub bootstrap_root_sha256: String,
    /// Exact metadata feed base used for this refresh.
    pub metadata_base_url: String,
    /// Exact target feed base used for this refresh.
    pub targets_base_url: String,
    /// Fixed policy clock sampled when the refresh began.
    pub policy_reference_unix_seconds: i64,
    /// Installer protocol checked against the signed compatibility interval.
    pub verifier_protocol: ProtocolVersion,
    /// Logical target path.
    pub target_name: String,
    /// Signed custom metadata.
    pub target: SignedTargetMetadata,
    /// Signed target length.
    pub target_length: u64,
    /// Signed and observed target SHA-256.
    pub target_sha256: String,
    /// Root metadata version.
    pub root_version: u64,
    /// Timestamp metadata version.
    pub timestamp_version: u64,
    /// Snapshot metadata version.
    pub snapshot_version: u64,
    /// Targets metadata version.
    pub targets_version: u64,
    /// SHA-256 digests of the exact persisted signed metadata bytes.
    pub trusted_metadata_sha256: TrustedMetadataDigests,
}

/// Exact persisted metadata byte digests.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TrustedMetadataDigests {
    /// Root bytes.
    pub root_json: String,
    /// Timestamp bytes.
    pub timestamp_json: String,
    /// Snapshot bytes.
    pub snapshot_json: String,
    /// Targets bytes.
    pub targets_json: String,
    /// Monotonic-time watermark bytes.
    pub latest_known_time_json: String,
}

/// Durable proof that binds one receipt to one exact trusted generation.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReleaseProof {
    receipt: VerificationReceipt,
    trusted_state: TrustedState,
}

impl fmt::Debug for ReleaseProof {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReleaseProof")
            .field("channel", &self.receipt.channel)
            .field("root_version", &self.receipt.root_version)
            .field("targets_version", &self.receipt.targets_version)
            .finish_non_exhaustive()
    }
}

/// A fully verified file and its inseparable durable proof.
pub struct VerifiedRelease {
    proof: ReleaseProof,
    staging: TempDir,
    target_path: PathBuf,
}

impl fmt::Debug for VerifiedRelease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedRelease")
            .field("proof", &self.proof)
            .field("target_path", &"<verified temporary file>")
            .finish()
    }
}

impl VerifiedRelease {
    /// Return the verified target file.
    ///
    /// The file remains available for the lifetime of this result and is
    /// deleted when the result is dropped. Callers must durably copy or rename
    /// it into their own isolated install staging generation before then.
    #[must_use]
    pub fn target_path(&self) -> &Path {
        debug_assert!(self.target_path.starts_with(self.staging.path()));
        &self.target_path
    }

    /// Return the durable proof and next trusted state as one bundle.
    #[must_use]
    pub const fn proof(&self) -> &ReleaseProof {
        &self.proof
    }
}

impl ReleaseProof {
    /// Return the redacted verification receipt.
    #[must_use]
    pub const fn receipt(&self) -> &VerificationReceipt {
        &self.receipt
    }

    /// Return the next trusted state for a subsequent refresh.
    #[must_use]
    pub const fn trusted_state(&self) -> &TrustedState {
        &self.trusted_state
    }

    /// Serialize the receipt and state together for owner-only persistence.
    ///
    /// The application must durably store these bytes in its owner-protected
    /// install journal. They are a local corruption-detection record, not a
    /// transferable authentication token.
    pub fn to_owner_protected_json(&self) -> Result<Vec<u8>, VerifyError> {
        self.trusted_state.validate()?;
        let bytes = serde_json::to_vec(self).map_err(VerifyError::ProofEncoding)?;
        if bytes.len() > MAX_PROOF_BYTES {
            return Err(VerifyError::ProofTooLarge {
                actual: bytes.len(),
                maximum: MAX_PROOF_BYTES,
            });
        }
        Ok(bytes)
    }

    /// Decode a proof loaded from the owner-protected local install journal.
    ///
    /// Call [`Self::revalidate_owner_protected`] with the compiled channel
    /// anchor and exact artifact before activation or rollback. Network,
    /// recovery-bundle, or otherwise untrusted proof JSON must go through a
    /// fresh [`verify_release`] instead.
    pub fn from_owner_protected_json(bytes: &[u8]) -> Result<Self, VerifyError> {
        if bytes.len() > MAX_PROOF_BYTES {
            return Err(VerifyError::ProofTooLarge {
                actual: bytes.len(),
                maximum: MAX_PROOF_BYTES,
            });
        }
        let proof: Self = serde_json::from_slice(bytes).map_err(VerifyError::ProofEncoding)?;
        proof.trusted_state.validate()?;
        Ok(proof)
    }

    /// Revalidate the complete proof against the compiled channel anchor and
    /// the exact candidate artifact.
    ///
    /// Expiration-at-refresh is intentionally not re-applied so a previously
    /// installed immutable version remains rollback-capable after metadata
    /// expires. Signatures, root continuity, product expiry horizons, metadata
    /// references, receipt bindings, target identity, length, and digest are
    /// all checked again.
    pub async fn revalidate_owner_protected(
        &self,
        trust: &ChannelTrust,
        expected: &ExpectedTarget,
        target_path: &Path,
    ) -> Result<(), VerifyError> {
        self.trusted_state.validate()?;
        self.verify_anchor(trust)?;
        let transport = ProofTransport::new(trust, &self.trusted_state)?;
        let staging = TempDir::new().map_err(VerifyError::StagingCreate)?;
        let trusted_root = self
            .trusted_state
            .root_json
            .as_deref()
            .ok_or(VerifyError::IncompleteTrustedState)?;
        let repository = RepositoryLoader::new(
            &trusted_root,
            trust.metadata_base_url.clone(),
            trust.targets_base_url.clone(),
        )
        .transport(transport)
        .limits(Limits {
            max_root_size: MAX_ROOT_BYTES,
            max_targets_size: MAX_TARGETS_BYTES,
            max_timestamp_size: MAX_TIMESTAMP_BYTES,
            max_snapshot_size: MAX_SNAPSHOT_BYTES,
            max_root_updates: MAX_ROOT_ROTATIONS + 1,
        })
        .datastore(staging.path())
        .expiration_enforcement(ExpirationEnforcement::Unsafe)
        .load()
        .await
        .map_err(|error| VerifyError::Tuf(Box::new(error)))?;

        verify_repository_policy(
            &repository,
            self.receipt.channel,
            self.receipt.policy_reference_unix_seconds,
        )?;
        self.verify_repository_receipt(&repository)?;

        if expected.target_name != self.receipt.target_name {
            return Err(VerifyError::ProofMismatch);
        }
        let target_name = TargetName::new(&expected.target_name)
            .map_err(|error| VerifyError::InvalidTargetName(Box::new(error)))?;
        let target = repository
            .targets()
            .signed
            .targets
            .get(&target_name)
            .ok_or_else(|| VerifyError::TargetNotFound(expected.target_name.clone()))?;
        verify_targets_policy(&repository, target)?;
        let signed_target = parse_and_validate_custom(
            &target.custom,
            &expected.target_name,
            self.receipt.channel,
            expected,
        )?;
        if signed_target != self.receipt.target
            || target.length != self.receipt.target_length
            || hex::encode(target.hashes.sha256.as_ref()) != self.receipt.target_sha256
        {
            return Err(VerifyError::ProofMismatch);
        }
        let observed_length = tokio::fs::metadata(target_path)
            .await
            .map_err(|source| VerifyError::StateIo {
                name: "proof-target",
                source,
            })?
            .len();
        if observed_length != self.receipt.target_length
            || sha256_file(target_path).await? != self.receipt.target_sha256
        {
            return Err(VerifyError::ProofMismatch);
        }
        Ok(())
    }

    fn verify_anchor(&self, trust: &ChannelTrust) -> Result<(), VerifyError> {
        let roots = &self.trusted_state.root_chain;
        if self.receipt.schema_version != RECEIPT_SCHEMA_VERSION
            || self.receipt.channel != trust.channel
            || self.receipt.bootstrap_root_sha256 != sha256_hex(&trust.bootstrap_root)
            || self.trusted_state.bootstrap_root_sha256.as_deref()
                != Some(self.receipt.bootstrap_root_sha256.as_str())
            || self.receipt.metadata_base_url != trust.metadata_base_url.as_str()
            || self.receipt.targets_base_url != trust.targets_base_url.as_str()
            || roots.last().map(Vec::as_slice) != self.trusted_state.root_json.as_deref()
            || roots.len() > maximum_root_chain_len()
            || self.receipt.trusted_metadata_sha256
                != TrustedMetadataDigests::from_state(&self.trusted_state)
        {
            return Err(VerifyError::ProofMismatch);
        }
        verify_trusted_root_chain(
            trust,
            &self.trusted_state,
            self.receipt.policy_reference_unix_seconds,
        )?;
        Ok(())
    }

    fn verify_repository_receipt(&self, repository: &tough::Repository) -> Result<(), VerifyError> {
        if self.receipt.root_version != repository.root().signed.version.get()
            || self.receipt.timestamp_version != repository.timestamp().signed.version.get()
            || self.receipt.snapshot_version != repository.snapshot().signed.version.get()
            || self.receipt.targets_version != repository.targets().signed.version.get()
        {
            return Err(VerifyError::ProofMismatch);
        }
        Ok(())
    }
}

/// Stable, redacted failure classification for application diagnostics.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerifyFailureKind {
    /// Signature, threshold, root, or channel authority failed.
    Trust,
    /// Signed metadata was expired.
    Expired,
    /// The system clock moved behind its trusted watermark.
    ClockRollback,
    /// Metadata versions or references moved backward.
    MetadataRollback,
    /// Signed length or digest verification failed.
    Integrity,
    /// A local absolute size, count, or update bound was exceeded.
    Bounds,
    /// Target identity, platform, build, archive, or protocol did not match.
    Identity,
    /// Repository transport failed within an allowed origin.
    Transport,
    /// Prior or staging trusted state was incomplete, corrupt, or unavailable.
    State,
    /// The signed schema requested an unsupported feature.
    Unsupported,
    /// Signed or trusted metadata could not be parsed.
    Malformed,
}

/// Verify one exact target without mutating the caller's trusted state.
pub async fn verify_release<T>(
    trust: ChannelTrust,
    previous_state: &TrustedState,
    expected: &ExpectedTarget,
    transport: T,
) -> Result<VerifiedRelease, VerifyError>
where
    T: Transport + Send + Sync + 'static,
{
    let policy_reference_unix_seconds = policy_reference_for_refresh(
        trust.fixture_policy_reference_unix_seconds,
        unix_seconds_now,
    )?;
    previous_state.validate()?;
    verify_trusted_root_chain(&trust, previous_state, policy_reference_unix_seconds)?;
    let staging = TempDir::new().map_err(VerifyError::StagingCreate)?;
    previous_state.write_to(staging.path()).await?;
    let observed_metadata = Arc::new(Mutex::new(ObservedMetadata::default()));
    let absolute_limit_exceeded = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let bounded_transport = BoundedTransport::new(
        transport,
        trust.metadata_base_url.clone(),
        trust.targets_base_url.clone(),
        PreviousMetadata {
            timestamp: previous_state.timestamp_json.clone(),
            snapshot: previous_state.snapshot_json.clone(),
            targets: previous_state.targets_json.clone(),
        },
        TransportAudit {
            observed_metadata: Arc::clone(&observed_metadata),
            absolute_limit_exceeded: Arc::clone(&absolute_limit_exceeded),
        },
    );

    // `tough` checks the bound before attempting the next root. Its value
    // therefore includes the final not-found probe: 33 permits 32 transitions.
    let trusted_root = previous_state
        .root_json
        .as_deref()
        .unwrap_or(&trust.bootstrap_root);
    let repository = RepositoryLoader::new(
        &trusted_root,
        trust.metadata_base_url.clone(),
        trust.targets_base_url.clone(),
    )
    .transport(bounded_transport)
    .limits(Limits {
        max_root_size: MAX_ROOT_BYTES,
        max_targets_size: MAX_TARGETS_BYTES,
        max_timestamp_size: MAX_TIMESTAMP_BYTES,
        max_snapshot_size: MAX_SNAPSHOT_BYTES,
        max_root_updates: MAX_ROOT_ROTATIONS + 1,
    })
    .datastore(staging.path())
    .expiration_enforcement(ExpirationEnforcement::Safe)
    .load()
    .await
    .map_err(|error| VerifyError::Tuf(Box::new(error)))?;
    if absolute_limit_exceeded.load(Ordering::Acquire) {
        return Err(VerifyError::AbsoluteBoundExceeded);
    }

    verify_repository_policy(&repository, trust.channel, policy_reference_unix_seconds)?;
    let mut next_state = TrustedState::read_from(staging.path()).await?;
    next_state.replace_with_observed(&observed_metadata, &trust.bootstrap_root, previous_state)?;
    next_state.validate()?;
    verify_trusted_root_chain(&trust, &next_state, policy_reference_unix_seconds)?;

    let target_name = TargetName::new(&expected.target_name)
        .map_err(|error| VerifyError::InvalidTargetName(Box::new(error)))?;
    let target = repository
        .targets()
        .signed
        .targets
        .get(&target_name)
        .ok_or_else(|| VerifyError::TargetNotFound(expected.target_name.clone()))?;
    verify_targets_policy(&repository, target)?;
    let signed_target = parse_and_validate_custom(
        &target.custom,
        &expected.target_name,
        trust.channel,
        expected,
    )?;

    let target_directory = staging.path().join("verified-target");
    tokio::fs::create_dir(&target_directory)
        .await
        .map_err(|source| VerifyError::StateIo {
            name: "verified-target",
            source,
        })?;
    repository
        .save_target(&target_name, &target_directory, Prefix::None)
        .await
        .map_err(|error| VerifyError::Tuf(Box::new(error)))?;
    let target_path = target_directory.join(target_name.resolved());
    let target_file = tokio::fs::OpenOptions::new()
        .read(true)
        .open(&target_path)
        .await
        .map_err(|source| VerifyError::StateIo {
            name: "verified-target",
            source,
        })?;
    target_file
        .sync_all()
        .await
        .map_err(|source| VerifyError::StateIo {
            name: "verified-target",
            source,
        })?;
    let target_length = target_file
        .metadata()
        .await
        .map_err(|source| VerifyError::StateIo {
            name: "verified-target",
            source,
        })?
        .len();
    if target_length != target.length {
        return Err(VerifyError::TargetLengthMismatch {
            expected: target.length,
            actual: target_length,
        });
    }
    let observed_sha256 = sha256_file(&target_path).await?;

    let signed_sha256 = hex::encode(target.hashes.sha256.as_ref());
    if observed_sha256 != signed_sha256 {
        return Err(VerifyError::TargetDigestMismatch);
    }
    let receipt = VerificationReceipt {
        schema_version: RECEIPT_SCHEMA_VERSION,
        channel: trust.channel,
        bootstrap_root_sha256: sha256_hex(&trust.bootstrap_root),
        metadata_base_url: trust.metadata_base_url.to_string(),
        targets_base_url: trust.targets_base_url.to_string(),
        policy_reference_unix_seconds,
        verifier_protocol: expected.protocol,
        target_name: expected.target_name.clone(),
        target: signed_target,
        target_length: target.length,
        target_sha256: signed_sha256,
        root_version: repository.root().signed.version.get(),
        timestamp_version: repository.timestamp().signed.version.get(),
        snapshot_version: repository.snapshot().signed.version.get(),
        targets_version: repository.targets().signed.version.get(),
        trusted_metadata_sha256: TrustedMetadataDigests::from_state(&next_state),
    };
    Ok(VerifiedRelease {
        proof: ReleaseProof {
            receipt,
            trusted_state: next_state,
        },
        staging,
        target_path,
    })
}

impl TrustedMetadataDigests {
    fn from_state(state: &TrustedState) -> Self {
        Self {
            root_json: sha256_hex(
                state
                    .root_json
                    .as_deref()
                    .expect("verified state is complete"),
            ),
            timestamp_json: sha256_hex(
                state
                    .timestamp_json
                    .as_deref()
                    .expect("verified state is complete"),
            ),
            snapshot_json: sha256_hex(
                state
                    .snapshot_json
                    .as_deref()
                    .expect("verified state is complete"),
            ),
            targets_json: sha256_hex(
                state
                    .targets_json
                    .as_deref()
                    .expect("verified state is complete"),
            ),
            latest_known_time_json: sha256_hex(
                state
                    .latest_known_time_json
                    .as_deref()
                    .expect("verified state is complete"),
            ),
        }
    }
}

fn verify_repository_policy(
    repository: &tough::Repository,
    expected_channel: ReleaseChannel,
    reference_unix_seconds: i64,
) -> Result<(), VerifyError> {
    let root = repository.root();
    verify_root_channel(root, expected_channel)?;
    verify_root_policy(&root.signed)?;
    verify_spec_version(&root.signed.spec_version)?;
    verify_spec_version(&repository.targets().signed.spec_version)?;
    verify_spec_version(&repository.snapshot().signed.spec_version)?;
    verify_spec_version(&repository.timestamp().signed.spec_version)?;
    verify_expiry_horizon(
        root.signed.expires.as_second(),
        reference_unix_seconds,
        ROOT_EXPIRY_HORIZON_SECONDS,
    )?;
    verify_expiry_horizon(
        repository.targets().signed.expires.as_second(),
        reference_unix_seconds,
        TARGETS_EXPIRY_HORIZON_SECONDS,
    )?;
    verify_expiry_horizon(
        repository.snapshot().signed.expires.as_second(),
        reference_unix_seconds,
        SNAPSHOT_EXPIRY_HORIZON_SECONDS,
    )?;
    verify_expiry_horizon(
        repository.timestamp().signed.expires.as_second(),
        reference_unix_seconds,
        TIMESTAMP_EXPIRY_HORIZON_SECONDS,
    )?;
    Ok(())
}

fn verify_trusted_root_chain(
    trust: &ChannelTrust,
    state: &TrustedState,
    reference_unix_seconds: i64,
) -> Result<(), VerifyError> {
    if state.is_empty() {
        return Ok(());
    }
    if state.root_chain.len() > maximum_root_chain_len() {
        return Err(VerifyError::TooManyTrustedRoots {
            actual: state.root_chain.len(),
            maximum: maximum_root_chain_len(),
        });
    }
    if state.bootstrap_root_sha256.as_deref() != Some(sha256_hex(&trust.bootstrap_root).as_str())
        || state.root_chain.last().map(Vec::as_slice) != state.root_json.as_deref()
    {
        return Err(VerifyError::ProofMismatch);
    }
    let mut previous: Option<tough::schema::Signed<tough::schema::Root>> = None;
    for bytes in &state.root_chain {
        let root: tough::schema::Signed<tough::schema::Root> = serde_json::from_slice(bytes)
            .map_err(|source| VerifyError::CorruptState {
                name: "root-chain",
                source,
            })?;
        if let Some(prior) = &previous {
            if root.signed.version.get() != prior.signed.version.get().saturating_add(1) {
                return Err(VerifyError::ProofMismatch);
            }
            prior
                .signed
                .verify_role(&root)
                .map_err(|error| VerifyError::RootSignature(Box::new(error)))?;
        }
        root.signed
            .verify_role(&root)
            .map_err(|error| VerifyError::RootSignature(Box::new(error)))?;
        verify_root_channel(&root, trust.channel)?;
        verify_root_policy(&root.signed)?;
        verify_spec_version(&root.signed.spec_version)?;
        verify_expiry_horizon(
            root.signed.expires.as_second(),
            reference_unix_seconds,
            ROOT_EXPIRY_HORIZON_SECONDS,
        )?;
        previous = Some(root);
    }
    Ok(())
}

fn verify_targets_policy(
    repository: &tough::Repository,
    target: &tough::schema::Target,
) -> Result<(), VerifyError> {
    if repository.targets().signed.delegations.is_some() {
        return Err(VerifyError::DelegationsUnsupported);
    }
    let target_count = repository.all_targets().count();
    if target_count > MAX_TARGETS {
        return Err(VerifyError::TooManyTargets {
            actual: target_count,
            maximum: MAX_TARGETS,
        });
    }
    if target.length > MAX_TARGET_BYTES {
        return Err(VerifyError::TargetTooLarge {
            actual: target.length,
            maximum: MAX_TARGET_BYTES,
        });
    }
    Ok(())
}

fn verify_root_channel(
    root: &tough::schema::Signed<tough::schema::Root>,
    expected: ReleaseChannel,
) -> Result<(), VerifyError> {
    let actual = root
        .signed
        ._extra
        .get("x-hmux-channel")
        .and_then(Value::as_str)
        .ok_or(VerifyError::RootChannelMissing)?;
    if actual != expected.to_string() {
        return Err(VerifyError::RootChannelMismatch {
            expected,
            actual: actual.to_owned(),
        });
    }
    Ok(())
}

fn verify_root_policy(root: &tough::schema::Root) -> Result<(), VerifyError> {
    use tough::schema::RoleType;
    use tough::schema::key::Key;

    if !root.consistent_snapshot || root.roles.len() != 4 {
        return Err(VerifyError::RootPolicyMismatch);
    }
    let expected_roles = [
        (RoleType::Root, 3_usize, 2_u64),
        (RoleType::Targets, 3, 2),
        (RoleType::Snapshot, 1, 1),
        (RoleType::Timestamp, 1, 1),
    ];
    let mut all_role_keys = HashSet::new();
    for (role, key_count, threshold) in expected_roles {
        let role_keys = root
            .roles
            .get(&role)
            .ok_or(VerifyError::RootPolicyMismatch)?;
        if role_keys.keyids.len() != key_count
            || role_keys.threshold.get() != threshold
            || role_keys
                .keyids
                .iter()
                .map(|key_id| hex::encode(key_id.as_ref()))
                .collect::<HashSet<_>>()
                .len()
                != key_count
        {
            return Err(VerifyError::RootPolicyMismatch);
        }
        for key_id in &role_keys.keyids {
            let key = root
                .keys
                .get(key_id)
                .ok_or(VerifyError::RootPolicyMismatch)?;
            if !matches!(key, Key::Ed25519 { .. })
                || !all_role_keys.insert(hex::encode(key_id.as_ref()))
            {
                return Err(VerifyError::RootPolicyMismatch);
            }
        }
    }
    if root.keys.len() != all_role_keys.len() {
        return Err(VerifyError::RootPolicyMismatch);
    }
    Ok(())
}

fn verify_spec_version(value: &str) -> Result<(), VerifyError> {
    let version = Version::parse(value).map_err(|_| VerifyError::UnsupportedSpecVersion)?;
    if version.major != 1 || version.minor != 0 {
        return Err(VerifyError::UnsupportedSpecVersion);
    }
    Ok(())
}

fn verify_expiry_horizon(
    expires_unix_seconds: i64,
    reference_unix_seconds: i64,
    maximum_seconds: i64,
) -> Result<(), VerifyError> {
    if expires_unix_seconds > reference_unix_seconds.saturating_add(maximum_seconds) {
        return Err(VerifyError::ExpiryHorizonExceeded);
    }
    Ok(())
}

fn parse_and_validate_custom(
    custom: &std::collections::HashMap<String, Value>,
    target_name: &str,
    channel: ReleaseChannel,
    expected: &ExpectedTarget,
) -> Result<SignedTargetMetadata, VerifyError> {
    let object = custom
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let metadata: SignedTargetMetadata =
        serde_json::from_value(Value::Object(object)).map_err(VerifyError::CustomMetadata)?;
    if metadata.schema_version != 1 {
        return Err(VerifyError::UnsupportedCustomSchema(
            metadata.schema_version,
        ));
    }
    if metadata.product != "hmux" {
        return Err(VerifyError::WrongProduct(metadata.product));
    }
    if metadata.channel != channel {
        return Err(VerifyError::WrongChannel {
            expected: channel,
            actual: metadata.channel,
        });
    }
    if metadata.target_triple != expected.destination {
        return Err(VerifyError::WrongDestination {
            expected: expected.destination,
            actual: metadata.target_triple,
        });
    }
    if metadata.archive_format != "tar.gz" {
        return Err(VerifyError::WrongArchiveFormat(metadata.archive_format));
    }
    validate_build_id(&metadata.build_id, metadata.target_triple)?;
    validate_lower_hex(&metadata.source_commit, 40)
        .map_err(|()| VerifyError::InvalidSourceCommit)?;
    Version::parse(&metadata.package_version)
        .map_err(|_| VerifyError::InvalidPackageVersion(metadata.package_version.clone()))?;
    validate_lower_hex(&metadata.installed_tree_sha256, 64)
        .map_err(|()| VerifyError::InvalidInstalledTreeDigest)?;
    let minimum = ProtocolVersion::parse(&metadata.protocol_minimum)?;
    let maximum = ProtocolVersion::parse(&metadata.protocol_maximum)?;
    if minimum > maximum {
        return Err(VerifyError::ReversedProtocolRange);
    }
    if expected.protocol < minimum || expected.protocol > maximum {
        return Err(VerifyError::IncompatibleProtocol {
            minimum,
            maximum,
            actual: expected.protocol,
        });
    }
    let expected_name = format!("{}.tar.gz", metadata.build_id);
    if target_name != expected_name {
        return Err(VerifyError::TargetIdentityMismatch {
            expected: expected_name,
            actual: target_name.to_owned(),
        });
    }
    Ok(metadata)
}

/// Validate the exact build-identity/path-component contract shared by release
/// publishers and clients.
pub fn validate_build_id(value: &str, target: ArtifactTarget) -> Result<(), VerifyError> {
    let suffix = format!(".{target}.release");
    let prefix = value
        .strip_suffix(&suffix)
        .ok_or_else(|| VerifyError::InvalidBuildId(value.to_owned()))?;
    if prefix.is_empty()
        || value.len() > 128
        || !prefix
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        || !prefix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
    {
        return Err(VerifyError::InvalidBuildId(value.to_owned()));
    }
    Ok(())
}

fn validate_lower_hex(value: &str, expected_len: usize) -> Result<(), ()> {
    if value.len() == expected_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(())
    }
}

fn validate_json_state(
    name: &'static str,
    bytes: Option<&[u8]>,
    maximum: u64,
) -> Result<(), VerifyError> {
    let bytes = bytes.ok_or(VerifyError::IncompleteTrustedState)?;
    if bytes.len() as u64 > maximum {
        return Err(VerifyError::StateFileTooLarge {
            name,
            actual: bytes.len() as u64,
            maximum,
        });
    }
    serde_json::from_slice::<Value>(bytes)
        .map_err(|source| VerifyError::CorruptState { name, source })?;
    Ok(())
}

async fn read_state_file(directory: &Path, name: &'static str) -> Result<Vec<u8>, VerifyError> {
    tokio::fs::read(directory.join(name))
        .await
        .map_err(|source| VerifyError::StateIo { name, source })
}

fn validate_base_url(url: &Url) -> Result<(), VerifyError> {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(VerifyError::UnsafeRepositoryUrl(url.clone()));
    }
    Ok(())
}

fn production_repository_bases(channel: ReleaseChannel) -> (&'static str, &'static str) {
    match channel {
        ReleaseChannel::Stable => (STABLE_METADATA_BASE_URL, STABLE_TARGETS_BASE_URL),
        ReleaseChannel::Canary => (CANARY_METADATA_BASE_URL, CANARY_TARGETS_BASE_URL),
    }
}

fn maximum_root_chain_len() -> usize {
    MAX_TRUSTED_ROOTS
}

fn is_fixture_url(url: &Url) -> bool {
    url.host_str()
        .is_some_and(|host| host == "invalid" || host.ends_with(".invalid"))
}

fn unix_seconds_now() -> Result<i64, VerifyError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| VerifyError::ClockUnavailable)?
        .as_secs();
    i64::try_from(seconds).map_err(|_| VerifyError::ClockUnavailable)
}

fn policy_reference_for_refresh(
    fixture_reference: Option<i64>,
    now: impl FnOnce() -> Result<i64, VerifyError>,
) -> Result<i64, VerifyError> {
    match fixture_reference {
        Some(reference) => Ok(reference),
        None => now(),
    }
}

fn same_base_url(left: &Url, right: &Url) -> bool {
    let left = with_trailing_slash(left.clone()).to_string();
    let right = with_trailing_slash(right.clone()).to_string();
    left.starts_with(&right) || right.starts_with(&left)
}

fn with_trailing_slash(mut url: Url) -> Url {
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    url
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

async fn sha256_file(path: &Path) -> Result<String, VerifyError> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|source| VerifyError::StateIo {
            name: "verified-target",
            source,
        })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|source| VerifyError::StateIo {
                name: "verified-target",
                source,
            })?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex::encode(digest.finalize()))
}

#[derive(Debug, Default)]
struct ObservedMetadata {
    roots: BTreeMap<u64, Vec<u8>>,
    timestamp: Option<Vec<u8>>,
    snapshot: Option<Vec<u8>>,
    targets: Option<Vec<u8>>,
}

#[derive(Debug, Default)]
struct PreviousMetadata {
    timestamp: Option<Vec<u8>>,
    snapshot: Option<Vec<u8>>,
    targets: Option<Vec<u8>>,
}

#[derive(Clone, Debug)]
struct TransportAudit {
    observed_metadata: Arc<Mutex<ObservedMetadata>>,
    absolute_limit_exceeded: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Clone, Debug)]
struct ProofTransport {
    responses: Arc<HashMap<String, Vec<u8>>>,
}

impl ProofTransport {
    fn new(trust: &ChannelTrust, state: &TrustedState) -> Result<Self, VerifyError> {
        let mut responses = HashMap::new();
        let mut expected_root_version = None;
        for (index, bytes) in state.root_chain.iter().enumerate() {
            let root: tough::schema::Signed<tough::schema::Root> = serde_json::from_slice(bytes)
                .map_err(|source| VerifyError::CorruptState {
                    name: "root-chain",
                    source,
                })?;
            let version = root.signed.version.get();
            if let Some(expected) = expected_root_version {
                if version != expected {
                    return Err(VerifyError::ProofMismatch);
                }
            }
            expected_root_version = Some(version.saturating_add(1));
            if index > 0 {
                responses.insert(
                    format!("{}{version}.root.json", trust.metadata_base_url),
                    bytes.clone(),
                );
            }
        }
        let timestamp = state
            .timestamp_json
            .clone()
            .ok_or(VerifyError::IncompleteTrustedState)?;
        let snapshot = state
            .snapshot_json
            .clone()
            .ok_or(VerifyError::IncompleteTrustedState)?;
        let targets = state
            .targets_json
            .clone()
            .ok_or(VerifyError::IncompleteTrustedState)?;
        responses.insert(
            format!("{}timestamp.json", trust.metadata_base_url),
            timestamp,
        );
        responses.insert(
            format!(
                "{}{}.snapshot.json",
                trust.metadata_base_url,
                metadata_version(&snapshot).ok_or(VerifyError::ProofMismatch)?
            ),
            snapshot,
        );
        responses.insert(
            format!(
                "{}{}.targets.json",
                trust.metadata_base_url,
                metadata_version(&targets).ok_or(VerifyError::ProofMismatch)?
            ),
            targets,
        );
        Ok(Self {
            responses: Arc::new(responses),
        })
    }
}

#[async_trait]
impl Transport for ProofTransport {
    async fn fetch(&self, url: Url) -> Result<TransportStream, TransportError> {
        let Some(bytes) = self.responses.get(url.as_str()) else {
            return Err(TransportError::new(
                TransportErrorKind::FileNotFound,
                url.as_str(),
            ));
        };
        Ok(bytes_stream(bytes))
    }
}

#[derive(Clone, Debug)]
struct BoundedTransport {
    inner: Box<dyn Transport + Send + Sync>,
    metadata_base: String,
    targets_base: String,
    previous_timestamp: Option<Arc<Vec<u8>>>,
    previous_snapshot: Option<Arc<Vec<u8>>>,
    previous_targets: Option<Arc<Vec<u8>>>,
    use_cached_metadata: Arc<std::sync::atomic::AtomicBool>,
    observed_metadata: Arc<Mutex<ObservedMetadata>>,
    absolute_limit_exceeded: Arc<std::sync::atomic::AtomicBool>,
}

impl BoundedTransport {
    fn new<T>(
        inner: T,
        metadata_base: Url,
        targets_base: Url,
        previous: PreviousMetadata,
        audit: TransportAudit,
    ) -> Self
    where
        T: Transport + Send + Sync + 'static,
    {
        Self {
            inner: Box::new(inner),
            metadata_base: with_trailing_slash(metadata_base).to_string(),
            targets_base: with_trailing_slash(targets_base).to_string(),
            previous_timestamp: previous.timestamp.map(Arc::new),
            previous_snapshot: previous.snapshot.map(Arc::new),
            previous_targets: previous.targets.map(Arc::new),
            use_cached_metadata: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            observed_metadata: audit.observed_metadata,
            absolute_limit_exceeded: audit.absolute_limit_exceeded,
        }
    }

    fn limit_for(&self, url: &Url) -> Result<u64, TransportError> {
        let value = url.as_str();
        if let Some(relative) = value.strip_prefix(&self.metadata_base) {
            if relative == "timestamp.json" {
                return Ok(MAX_TIMESTAMP_BYTES);
            }
            if relative.ends_with(".root.json") && versioned_role_name(relative, ".root.json") {
                return Ok(MAX_ROOT_BYTES);
            }
            if relative.ends_with(".snapshot.json")
                && versioned_role_name(relative, ".snapshot.json")
            {
                return Ok(MAX_SNAPSHOT_BYTES);
            }
            if relative.ends_with(".targets.json") && versioned_role_name(relative, ".targets.json")
            {
                return Ok(MAX_TARGETS_BYTES);
            }
            return Err(TransportError::new(TransportErrorKind::Other, url.as_str()));
        }
        if value.starts_with(&self.targets_base) {
            return Ok(MAX_TARGET_BYTES);
        }
        Err(TransportError::new(TransportErrorKind::Other, url.as_str()))
    }

    fn record_metadata(&self, url: &Url, bytes: &[u8]) -> Result<(), TransportError> {
        let Some(relative) = url.as_str().strip_prefix(&self.metadata_base) else {
            return Ok(());
        };
        let mut observed = self
            .observed_metadata
            .lock()
            .map_err(|_| TransportError::new(TransportErrorKind::Other, "metadata capture"))?;
        if relative == "timestamp.json" {
            observed.timestamp = Some(bytes.to_vec());
        } else if let Some(version) = role_version(relative, ".root.json") {
            observed.roots.insert(version, bytes.to_vec());
        } else if role_version(relative, ".snapshot.json").is_some() {
            observed.snapshot = Some(bytes.to_vec());
        } else if role_version(relative, ".targets.json").is_some() {
            observed.targets = Some(bytes.to_vec());
        }
        Ok(())
    }
}

#[async_trait]
impl Transport for BoundedTransport {
    async fn fetch(&self, url: Url) -> Result<TransportStream, TransportError> {
        let maximum = self.limit_for(&url)?;
        if self.use_cached_metadata.load(Ordering::Acquire) {
            let relative = url.as_str().strip_prefix(&self.metadata_base);
            if let Some(previous) = relative
                .and_then(|name| cached_role(name, ".snapshot.json", &self.previous_snapshot))
            {
                self.record_metadata(&url, previous)?;
                return Ok(bytes_stream(previous));
            }
            if let Some(previous) =
                relative.and_then(|name| cached_role(name, ".targets.json", &self.previous_targets))
            {
                self.record_metadata(&url, previous)?;
                return Ok(bytes_stream(previous));
            }
        }
        let stream = self.inner.fetch(url.clone()).await?;
        let seen = Arc::new(AtomicU64::new(0));
        let bounded_url = url.clone();
        let absolute_limit_exceeded = Arc::clone(&self.absolute_limit_exceeded);
        let limited = stream.map(move |item| {
            let bytes = item?;
            let length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
            let previous = seen.fetch_add(length, Ordering::Relaxed);
            if previous.saturating_add(length) > maximum {
                absolute_limit_exceeded.store(true, Ordering::Release);
                return Err(TransportError::new_with_cause(
                    TransportErrorKind::Other,
                    bounded_url.as_str(),
                    AbsoluteLimitExceeded,
                ));
            }
            Ok(bytes)
        });
        let limited: TransportStream = Box::pin(limited);
        if url.as_str().starts_with(&self.metadata_base) {
            let candidate = limited.into_vec().await?;
            if let Some(previous) = &self.previous_timestamp {
                if url.as_str() == format!("{}timestamp.json", self.metadata_base)
                    && same_metadata_version(previous, &candidate)
                    && previous.as_slice() != candidate
                {
                    self.use_cached_metadata.store(true, Ordering::Release);
                    self.record_metadata(&url, previous)?;
                    return Ok(bytes_stream(previous));
                }
            }
            self.record_metadata(&url, &candidate)?;
            return Ok(bytes_stream(&candidate));
        }
        Ok(limited)
    }
}

fn cached_role<'a>(
    requested_name: &str,
    suffix: &str,
    previous: &'a Option<Arc<Vec<u8>>>,
) -> Option<&'a [u8]> {
    let previous = previous.as_deref()?;
    let requested_version = requested_name.strip_suffix(suffix)?.parse::<u64>().ok()?;
    (metadata_version(previous) == Some(requested_version)).then_some(previous.as_slice())
}

fn bytes_stream(bytes: &[u8]) -> TransportStream {
    let bytes = Bytes::copy_from_slice(bytes);
    Box::pin(futures_util::stream::once(async move { Ok(bytes) }))
}

fn same_metadata_version(left: &[u8], right: &[u8]) -> bool {
    metadata_version(left).is_some_and(|left_version| Some(left_version) == metadata_version(right))
}

fn metadata_version(bytes: &[u8]) -> Option<u64> {
    serde_json::from_slice::<Value>(bytes)
        .ok()?
        .get("signed")?
        .get("version")?
        .as_u64()
}

fn versioned_role_name(value: &str, suffix: &str) -> bool {
    role_version(value, suffix).is_some()
}

fn role_version(value: &str, suffix: &str) -> Option<u64> {
    value.strip_suffix(suffix)?.parse().ok()
}

#[derive(Debug, Error)]
#[error("repository response exceeded its absolute local byte bound")]
struct AbsoluteLimitExceeded;

/// Verification failure. Messages deliberately omit target bytes and metadata.
#[derive(Error)]
pub enum VerifyError {
    /// A repository URL could escape the pinned HTTPS trust domain.
    #[error("repository URL is not an origin-bound HTTPS base")]
    UnsafeRepositoryUrl(Url),
    /// A synthetic fixture clock was requested for a reachable origin.
    #[error("fixture policy clocks require an unreachable .invalid origin")]
    FixtureClockRequiresInvalidOrigin,
    /// Production feeds must use the exact channel URL pair compiled into the
    /// verifier.
    #[error("repository URLs do not match the selected production channel")]
    ProductionRepositoryMismatch,
    /// Metadata and targets must not share one indistinguishable base.
    #[error("metadata and target repository bases overlap")]
    OverlappingRepositoryBases,
    /// The local clock could not provide a safe Unix timestamp.
    #[error("system clock is outside the supported range")]
    ClockUnavailable,
    /// Pinned root is locally oversized.
    #[error("bootstrap root is {actual} bytes; maximum is {maximum}")]
    BootstrapRootTooLarge { actual: u64, maximum: u64 },
    /// Prior state was partly missing.
    #[error("trusted state must be empty or contain one complete generation")]
    IncompleteTrustedState,
    /// A persisted state attempted to exceed the refresh root-transition cap.
    #[error("trusted state root chain contains {actual} roots; maximum is {maximum}")]
    TooManyTrustedRoots { actual: usize, maximum: usize },
    /// Exact state files did not match their generation digest.
    #[error("trusted state integrity digest does not match its exact files")]
    TrustedStateIntegrityMismatch,
    /// Prior state contained invalid JSON.
    #[error("trusted state file {name} is invalid JSON")]
    CorruptState {
        name: &'static str,
        #[source]
        source: serde_json::Error,
    },
    /// Prior state exceeded a local absolute bound.
    #[error("trusted state file {name} is {actual} bytes; maximum is {maximum}")]
    StateFileTooLarge {
        name: &'static str,
        actual: u64,
        maximum: u64,
    },
    /// A staging state file could not be read or written.
    #[error("trusted state I/O failed for {name}")]
    StateIo {
        name: &'static str,
        #[source]
        source: std::io::Error,
    },
    /// Staging generation creation failed.
    #[error("unable to create isolated trusted-state staging generation")]
    StagingCreate(#[source] std::io::Error),
    /// Exact verified metadata bytes could not be retained.
    #[error("verified metadata capture was unavailable")]
    ObservedMetadataUnavailable,
    /// A durable proof could not be encoded or decoded.
    #[error("release proof encoding is invalid")]
    ProofEncoding(#[source] serde_json::Error),
    /// Proof bytes are bounded before JSON parsing.
    #[error("release proof is {actual} bytes; maximum is {maximum}")]
    ProofTooLarge { actual: usize, maximum: usize },
    /// Receipt, trusted state, channel anchor, or target did not agree.
    #[error("release proof does not match its trust anchor or artifact")]
    ProofMismatch,
    /// The pinned TUF implementation rejected the repository or target. The
    /// inner error is classified internally but deliberately not exposed as an
    /// error source because transport failures can contain repository URLs.
    #[error("TUF verification failed")]
    Tuf(Box<tough::error::Error>),
    /// Root did not declare its channel binding.
    #[error("trusted root is missing its channel binding")]
    RootChannelMissing,
    /// Root was bound to another channel.
    #[error("trusted root channel does not match the selected feed")]
    RootChannelMismatch {
        expected: ReleaseChannel,
        actual: String,
    },
    /// Root weakened or changed the product role/key policy.
    #[error("trusted root does not match the required role and key policy")]
    RootPolicyMismatch,
    /// A retained root was not signed by the previous and current thresholds.
    #[error("trusted root signature verification failed")]
    RootSignature(Box<tough::schema::Error>),
    /// Metadata used a TUF version outside the adopted POUF.
    #[error("metadata TUF specification version is unsupported")]
    UnsupportedSpecVersion,
    /// Signed metadata remains valid longer than product policy allows.
    #[error("signed metadata expiry exceeds the product policy horizon")]
    ExpiryHorizonExceeded,
    /// A repository response crossed a role-specific absolute byte bound.
    #[error("repository response exceeded an absolute local byte bound")]
    AbsoluteBoundExceeded,
    /// Delegated targets are outside schema version 1.
    #[error("delegated targets are unsupported by release trust schema 1")]
    DelegationsUnsupported,
    /// Too many targets were signed.
    #[error("targets metadata contains {actual} targets; maximum is {maximum}")]
    TooManyTargets { actual: usize, maximum: usize },
    /// Logical target name was unsafe.
    #[error("invalid target name")]
    InvalidTargetName(Box<tough::error::Error>),
    /// Requested target was not signed.
    #[error("requested target is not present in signed metadata")]
    TargetNotFound(String),
    /// Signed target length exceeded the absolute limit.
    #[error("target is {actual} bytes; maximum is {maximum}")]
    TargetTooLarge { actual: u64, maximum: u64 },
    /// Custom metadata was absent, malformed, or had unknown fields.
    #[error("signed target custom metadata is invalid")]
    CustomMetadata(serde_json::Error),
    /// Unsupported custom metadata schema.
    #[error("unsupported signed target schema")]
    UnsupportedCustomSchema(u64),
    /// Target named another product.
    #[error("signed target product is unsupported")]
    WrongProduct(String),
    /// Target named another channel.
    #[error("signed target channel does not match the selected feed")]
    WrongChannel {
        expected: ReleaseChannel,
        actual: ReleaseChannel,
    },
    /// Target named another destination.
    #[error("signed destination does not match the requested platform")]
    WrongDestination {
        expected: ArtifactTarget,
        actual: ArtifactTarget,
    },
    /// Target named another archive format.
    #[error("signed archive format is unsupported")]
    WrongArchiveFormat(String),
    /// Build identity was not target-specific or had unsafe characters.
    #[error("invalid target-specific build id")]
    InvalidBuildId(String),
    /// Source commit was not a full lowercase SHA-1 object id.
    #[error("source commit must be exactly 40 lowercase hex characters")]
    InvalidSourceCommit,
    /// Package version was not SemVer.
    #[error("invalid package version")]
    InvalidPackageVersion(String),
    /// Installed-tree digest was malformed.
    #[error("installed-tree SHA-256 must be exactly 64 lowercase hex characters")]
    InvalidInstalledTreeDigest,
    /// Protocol version had invalid grammar.
    #[error("invalid protocol version")]
    InvalidProtocolVersion(String),
    /// Signed protocol interval was reversed.
    #[error("signed protocol range is reversed")]
    ReversedProtocolRange,
    /// Installer protocol is outside the signed interval.
    #[error("installer protocol is outside the signed compatibility range")]
    IncompatibleProtocol {
        minimum: ProtocolVersion,
        maximum: ProtocolVersion,
        actual: ProtocolVersion,
    },
    /// Logical target name disagreed with signed identity.
    #[error("target identity does not match signed metadata")]
    TargetIdentityMismatch { expected: String, actual: String },
    /// Fully consumed target length disagreed with signed length.
    #[error("target length {actual} does not match signed length {expected}")]
    TargetLengthMismatch { expected: u64, actual: u64 },
    /// Fully consumed target digest disagreed with signed digest.
    #[error("target digest does not match signed SHA-256")]
    TargetDigestMismatch,
}

impl fmt::Debug for VerifyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifyError")
            .field("kind", &self.kind())
            .finish_non_exhaustive()
    }
}

impl VerifyError {
    /// Return a stable category without exposing metadata, target bytes, or
    /// transport internals.
    #[must_use]
    pub fn kind(&self) -> VerifyFailureKind {
        match self {
            Self::Tuf(error) => classify_tuf_error(error),
            Self::UnsafeRepositoryUrl(_)
            | Self::FixtureClockRequiresInvalidOrigin
            | Self::ProductionRepositoryMismatch
            | Self::OverlappingRepositoryBases
            | Self::RootChannelMissing
            | Self::RootChannelMismatch { .. }
            | Self::RootPolicyMismatch
            | Self::RootSignature(_) => VerifyFailureKind::Trust,
            Self::BootstrapRootTooLarge { .. }
            | Self::StateFileTooLarge { .. }
            | Self::TooManyTrustedRoots { .. }
            | Self::ProofTooLarge { .. }
            | Self::TooManyTargets { .. }
            | Self::TargetTooLarge { .. }
            | Self::ExpiryHorizonExceeded
            | Self::AbsoluteBoundExceeded => VerifyFailureKind::Bounds,
            Self::IncompleteTrustedState
            | Self::TrustedStateIntegrityMismatch
            | Self::CorruptState { .. }
            | Self::StateIo { .. }
            | Self::StagingCreate(_)
            | Self::ObservedMetadataUnavailable
            | Self::ProofEncoding(_)
            | Self::ClockUnavailable => VerifyFailureKind::State,
            Self::DelegationsUnsupported
            | Self::UnsupportedCustomSchema(_)
            | Self::UnsupportedSpecVersion => VerifyFailureKind::Unsupported,
            Self::InvalidTargetName(_)
            | Self::TargetNotFound(_)
            | Self::WrongProduct(_)
            | Self::WrongChannel { .. }
            | Self::WrongDestination { .. }
            | Self::WrongArchiveFormat(_)
            | Self::InvalidBuildId(_)
            | Self::InvalidSourceCommit
            | Self::InvalidPackageVersion(_)
            | Self::InvalidInstalledTreeDigest
            | Self::InvalidProtocolVersion(_)
            | Self::ReversedProtocolRange
            | Self::IncompatibleProtocol { .. }
            | Self::TargetIdentityMismatch { .. } => VerifyFailureKind::Identity,
            Self::TargetLengthMismatch { .. }
            | Self::TargetDigestMismatch
            | Self::ProofMismatch => VerifyFailureKind::Integrity,
            Self::CustomMetadata(_) => VerifyFailureKind::Malformed,
        }
    }
}

fn classify_tuf_error(error: &tough::error::Error) -> VerifyFailureKind {
    use tough::error::Error as ToughError;

    match error {
        ToughError::ExpiredMetadata { .. } => VerifyFailureKind::Expired,
        ToughError::SystemTimeSteppedBackward { .. } => VerifyFailureKind::ClockRollback,
        ToughError::OlderMetadata { .. }
        | ToughError::OlderSnapshotInTimestamp { .. }
        | ToughError::SnapshotRoleMissing { .. }
        | ToughError::SnapshotRoleRollback { .. } => VerifyFailureKind::MetadataRollback,
        ToughError::HashMismatch { .. } => VerifyFailureKind::Integrity,
        ToughError::MaxSizeExceeded { .. } | ToughError::MaxUpdatesExceeded { .. } => {
            VerifyFailureKind::Bounds
        }
        ToughError::Transport { source, .. }
            if source
                .source()
                .is_some_and(|cause| cause.is::<AbsoluteLimitExceeded>()) =>
        {
            VerifyFailureKind::Bounds
        }
        ToughError::Transport { .. } => VerifyFailureKind::Transport,
        ToughError::ParseMetadata { .. }
        | ToughError::ParseTrustedMetadata { .. }
        | ToughError::TimestampMetaLength { .. }
        | ToughError::MissingSnapshotMeta { .. }
        | ToughError::SnapshotTargetsMetaMissing { .. }
        | ToughError::MetaMissing { .. } => VerifyFailureKind::Malformed,
        ToughError::VerifyMetadata { .. }
        | ToughError::VerifyRoleMetadata { .. }
        | ToughError::VerifyTrustedMetadata { .. } => VerifyFailureKind::Trust,
        _ => VerifyFailureKind::Trust,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;
    use serde_json::json;
    use std::cell::Cell;
    use std::collections::HashMap;
    use tough::Bytes;

    #[derive(Clone, Debug)]
    struct StaticTransport {
        bytes: Vec<u8>,
    }

    #[test]
    fn refresh_clock_is_sampled_lazily_except_for_fixtures() {
        let production_calls = Cell::new(0);
        let production_reference = policy_reference_for_refresh(None, || {
            production_calls.set(production_calls.get() + 1);
            Ok(42)
        })
        .expect("production refresh samples its clock");
        assert_eq!(production_reference, 42);
        assert_eq!(production_calls.get(), 1);

        let fixture_calls = Cell::new(0);
        let fixture_reference = policy_reference_for_refresh(Some(7), || {
            fixture_calls.set(fixture_calls.get() + 1);
            Err(VerifyError::ClockUnavailable)
        })
        .expect("fixture refresh keeps its injected clock");
        assert_eq!(fixture_reference, 7);
        assert_eq!(fixture_calls.get(), 0);
    }

    #[async_trait]
    impl Transport for StaticTransport {
        async fn fetch(&self, _url: Url) -> Result<TransportStream, TransportError> {
            Ok(Box::pin(stream::iter([Ok(Bytes::copy_from_slice(
                &self.bytes,
            ))])))
        }
    }

    fn valid_custom() -> HashMap<String, Value> {
        serde_json::from_value(json!({
            "schemaVersion": 1,
            "product": "hmux",
            "channel": "stable",
            "buildId": "0.1.4+fixture.x86_64-unknown-linux-musl.release",
            "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
            "targetTriple": "x86_64-unknown-linux-musl",
            "archiveFormat": "tar.gz",
            "packageVersion": "0.1.4",
            "protocolMinimum": "1.0",
            "protocolMaximum": "1.2",
            "installedTreeSha256": "a".repeat(64)
        }))
        .expect("valid custom map")
    }

    fn expected() -> ExpectedTarget {
        ExpectedTarget {
            target_name: "0.1.4+fixture.x86_64-unknown-linux-musl.release.tar.gz".to_owned(),
            destination: ArtifactTarget::X86_64LinuxMusl,
            protocol: ProtocolVersion::new(1, 1),
        }
    }

    #[test]
    fn validates_exact_signed_target_contract() {
        let metadata = parse_and_validate_custom(
            &valid_custom(),
            &expected().target_name,
            ReleaseChannel::Stable,
            &expected(),
        )
        .expect("valid signed target metadata");
        assert_eq!(metadata.package_version, "0.1.4");
    }

    #[test]
    fn rejects_wrong_destination_before_download() {
        let mut custom = valid_custom();
        custom.insert(
            "targetTriple".to_owned(),
            json!("aarch64-unknown-linux-musl"),
        );
        assert!(matches!(
            parse_and_validate_custom(
                &custom,
                &expected().target_name,
                ReleaseChannel::Stable,
                &expected()
            ),
            Err(VerifyError::WrongDestination { .. })
        ));
    }

    #[test]
    fn rejects_unknown_custom_fields_and_protocol_mismatch() {
        let mut unknown = valid_custom();
        unknown.insert("downloadUrl".to_owned(), json!("https://attacker.invalid"));
        assert!(matches!(
            parse_and_validate_custom(
                &unknown,
                &expected().target_name,
                ReleaseChannel::Stable,
                &expected()
            ),
            Err(VerifyError::CustomMetadata(_))
        ));

        let mut incompatible = valid_custom();
        incompatible.insert("protocolMinimum".to_owned(), json!("2.0"));
        incompatible.insert("protocolMaximum".to_owned(), json!("2.1"));
        assert!(matches!(
            parse_and_validate_custom(
                &incompatible,
                &expected().target_name,
                ReleaseChannel::Stable,
                &expected()
            ),
            Err(VerifyError::IncompatibleProtocol { .. })
        ));
    }

    #[test]
    fn build_id_matches_the_immutable_store_limit() {
        let suffix = ".x86_64-unknown-linux-musl.release";
        let maximum = format!("{}{}", "a".repeat(128 - suffix.len()), suffix);
        assert_eq!(maximum.len(), 128);
        assert!(validate_build_id(&maximum, ArtifactTarget::X86_64LinuxMusl).is_ok());

        let oversized = format!("a{maximum}");
        assert_eq!(oversized.len(), 129);
        assert!(matches!(
            validate_build_id(&oversized, ArtifactTarget::X86_64LinuxMusl),
            Err(VerifyError::InvalidBuildId(_))
        ));
    }

    #[test]
    fn display_and_debug_redact_remote_controlled_values() {
        let secret_url =
            Url::parse("https://user:password@example.invalid/path?token=abc#fragment").unwrap();
        let error = ChannelTrust::new(
            ReleaseChannel::Stable,
            b"{}".to_vec(),
            secret_url,
            Url::parse("https://targets.invalid/").unwrap(),
        )
        .expect_err("credentials are rejected");
        for rendered in [error.to_string(), format!("{error:?}")] {
            for secret in ["user", "password", "token", "fragment"] {
                assert!(!rendered.contains(secret), "{rendered}");
            }
        }

        let injected = VerifyError::InvalidBuildId("bad\nforged log line".to_owned());
        assert_eq!(injected.to_string(), "invalid target-specific build id");
        assert!(!format!("{injected:?}").contains("forged"));
    }

    #[test]
    fn rejects_partial_or_corrupt_previous_state() {
        let partial = TrustedState {
            root_json: Some(b"{}".to_vec()),
            ..TrustedState::default()
        };
        assert!(matches!(
            partial.validate(),
            Err(VerifyError::IncompleteTrustedState)
        ));

        let corrupt = TrustedState {
            bootstrap_root_sha256: Some("0".repeat(64)),
            root_json: Some(b"{}".to_vec()),
            timestamp_json: Some(b"{}".to_vec()),
            snapshot_json: Some(b"{}".to_vec()),
            targets_json: Some(b"{}".to_vec()),
            latest_known_time_json: Some(b"not-json".to_vec()),
            integrity_sha256: None,
            root_chain: vec![b"{}".to_vec()],
        };
        assert!(matches!(
            corrupt.validate(),
            Err(VerifyError::CorruptState {
                name: "latest_known_time.json",
                ..
            })
        ));
    }

    #[test]
    fn rejects_unsafe_or_overlapping_repository_bases() {
        let root = b"{}".to_vec();
        assert!(matches!(
            ChannelTrust::new(
                ReleaseChannel::Stable,
                root.clone(),
                Url::parse("http://updates.invalid/metadata/").unwrap(),
                Url::parse("https://updates.invalid/targets/").unwrap()
            ),
            Err(VerifyError::UnsafeRepositoryUrl(_))
        ));
        assert!(matches!(
            ChannelTrust::new(
                ReleaseChannel::Stable,
                root,
                Url::parse("https://updates.invalid/feed/").unwrap(),
                Url::parse("https://updates.invalid/feed").unwrap()
            ),
            Err(VerifyError::OverlappingRepositoryBases)
        ));
        assert!(matches!(
            ChannelTrust::new(
                ReleaseChannel::Stable,
                b"{}".to_vec(),
                Url::parse("https://mirror.invalid/stable/metadata/").unwrap(),
                Url::parse("https://mirror.invalid/stable/targets/").unwrap()
            ),
            Err(VerifyError::ProductionRepositoryMismatch)
        ));
    }

    #[test]
    fn accepts_only_the_canonical_production_repository_origins() {
        for (channel, metadata, targets) in [
            (
                ReleaseChannel::Stable,
                "https://updates.dureai.dev/hmux/stable/metadata/",
                "https://updates.dureai.dev/hmux/stable/targets/",
            ),
            (
                ReleaseChannel::Canary,
                "https://updates.dureai.dev/hmux/canary/metadata/",
                "https://updates.dureai.dev/hmux/canary/targets/",
            ),
        ] {
            assert!(
                ChannelTrust::new(
                    channel,
                    b"{}".to_vec(),
                    Url::parse(metadata).unwrap(),
                    Url::parse(targets).unwrap(),
                )
                .is_ok()
            );
        }

        assert!(matches!(
            ChannelTrust::new(
                ReleaseChannel::Stable,
                b"{}".to_vec(),
                Url::parse("https://updates.hebbian.ai/hmux/stable/metadata/").unwrap(),
                Url::parse("https://updates.hebbian.ai/hmux/stable/targets/").unwrap(),
            ),
            Err(VerifyError::ProductionRepositoryMismatch)
        ));
    }

    #[test]
    fn trusted_state_rejects_root_chains_above_the_refresh_bound() {
        let mut state = TrustedState {
            bootstrap_root_sha256: Some("0".repeat(64)),
            root_json: Some(b"{}".to_vec()),
            timestamp_json: Some(b"{}".to_vec()),
            snapshot_json: Some(b"{}".to_vec()),
            targets_json: Some(b"{}".to_vec()),
            latest_known_time_json: Some(b"{}".to_vec()),
            integrity_sha256: Some("0".repeat(64)),
            root_chain: vec![b"{}".to_vec(); maximum_root_chain_len() + 1],
        };
        assert!(matches!(
            state.validate(),
            Err(VerifyError::TooManyTrustedRoots { .. })
        ));
        assert!(matches!(state.refresh_integrity_sha256(), Ok(())));
        assert!(matches!(
            state.validate(),
            Err(VerifyError::TooManyTrustedRoots { .. })
        ));
    }

    #[test]
    fn role_name_classifier_is_exact() {
        assert!(versioned_role_name("2.root.json", ".root.json"));
        assert!(!versioned_role_name("root.json", ".root.json"));
        assert!(!versioned_role_name("../2.root.json", ".root.json"));
        assert!(!versioned_role_name(
            "2.targets.json.extra",
            ".targets.json"
        ));
    }

    #[tokio::test]
    async fn transport_enforces_absolute_bound_before_parser() {
        let transport = BoundedTransport::new(
            StaticTransport {
                bytes: vec![b'x'; usize::try_from(MAX_TARGETS_BYTES + 1).unwrap()],
            },
            Url::parse("https://updates.invalid/metadata/").unwrap(),
            Url::parse("https://updates.invalid/targets/").unwrap(),
            PreviousMetadata::default(),
            TransportAudit {
                observed_metadata: Arc::new(Mutex::new(ObservedMetadata::default())),
                absolute_limit_exceeded: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            },
        );
        let error = match transport
            .fetch(Url::parse("https://updates.invalid/metadata/1.targets.json").unwrap())
            .await
        {
            Err(error) => error,
            Ok(_) => panic!("absolute targets bound must reject signed-length bypass"),
        };
        assert_eq!(error.kind(), TransportErrorKind::Other);

        assert_eq!(
            transport
                .limit_for(&Url::parse("https://updates.invalid/metadata/2.root.json").unwrap())
                .unwrap(),
            MAX_ROOT_BYTES
        );
        assert_eq!(
            transport
                .limit_for(
                    &Url::parse("https://updates.invalid/targets/hash.hmux/release.tar.gz")
                        .unwrap()
                )
                .unwrap(),
            MAX_TARGET_BYTES
        );
    }
}
