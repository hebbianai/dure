//! Fail-closed hand-off from an artifact builder to the protected TUF signer.
//!
//! The candidate is deliberately unsigned. It proves that one closed,
//! byte-exact artifact set agrees with the metadata the signer will place in
//! TUF targets. The signer remains responsible for authorization and signing.

use auditable_serde::{Source as AuditSource, VersionInfo as AuditVersionInfo};
use flate2::bufread::{GzDecoder, ZlibDecoder};
use hmux_release_trust::{
    ArtifactTarget, MAX_TARGET_BYTES, ProtocolVersion, ReleaseChannel, SignedTargetMetadata,
    validate_build_id,
};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tempfile::tempfile;
use thiserror::Error;

const TARGETS: [ArtifactTarget; 2] = [
    ArtifactTarget::Aarch64LinuxMusl,
    ArtifactTarget::X86_64LinuxMusl,
];
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_CANDIDATE_BYTES: u64 = 256 * 1024;
const MAX_BINARY_BYTES: u64 = 128 * 1024 * 1024;
const MAX_AUDIT_DATA_BYTES: u64 = 64 * 1024;
const MAX_AUDIT_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TAR_OVERHEAD_BYTES: u64 = 1024 * 1024;
const MAX_CHECKSUM_BYTES: u64 = 64 * 1024;
const TAR_BLOCK_BYTES: usize = 512;
const SOURCE_COMMIT_LENGTH: usize = 40;
const SOURCE_COMMIT_PREFIX_LENGTH: usize = 12;

/// Inputs for one immutable candidate generation.
#[derive(Debug)]
pub struct CandidateOptions {
    pub channel: ReleaseChannel,
    pub source_commit: String,
    pub workflow_run_id: u64,
    pub workflow_run_attempt: u64,
    pub artifact_root: PathBuf,
    pub output: PathBuf,
}

/// Inputs used by the protected signer to revalidate a downloaded hand-off.
#[derive(Debug)]
pub struct VerifyCandidateOptions {
    pub channel: ReleaseChannel,
    pub source_commit: String,
    pub workflow_run_id: u64,
    pub workflow_run_attempt: u64,
    pub artifact_root: PathBuf,
    pub candidate: PathBuf,
}

/// Complete unsigned input for the protected TUF publisher.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReleaseCandidate {
    schema_version: u64,
    channel: ReleaseChannel,
    source_commit: String,
    workflow_run_id: u64,
    workflow_run_attempt: u64,
    artifacts: Vec<CandidateArtifact>,
    publication_order: [String; 5],
}

/// One exact archive and the custom metadata to sign for it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CandidateArtifact {
    logical_target_path: String,
    length: u64,
    sha256: String,
    custom: SignedTargetMetadata,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InstallManifest {
    schema_version: u64,
    build_id: String,
    package_version: String,
    profile: String,
    target_triple: ArtifactTarget,
    protocol: ProtocolRange,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct ProtocolRange {
    minimum: String,
    maximum: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BinaryProvenance {
    schema_version: u64,
    product: String,
    binary: String,
    build_id: String,
    source_commit: String,
    target_triple: ArtifactTarget,
}

#[derive(Clone, Copy)]
struct ExpectedBinaryIdentity<'a> {
    target: ArtifactTarget,
    binary: &'a str,
    build_id: &'a str,
    package_version: &'a str,
    source_commit: &'a str,
}

#[derive(Debug)]
struct TreeProof {
    manifest: InstallManifest,
    manifest_bytes: Vec<u8>,
    member_sha256: BTreeMap<&'static str, String>,
    installed_tree_sha256: String,
}

#[derive(Debug)]
struct ArchiveProof {
    length: u64,
    sha256: String,
    member_sha256: BTreeMap<&'static str, String>,
    manifest_bytes: Vec<u8>,
    manifest: InstallManifest,
    installed_tree_sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ArchiveMemberKind {
    Directory,
    Regular,
}

#[derive(Debug, Error)]
pub enum CandidateError {
    #[error("hmux_release_candidate_io: {context}: {source}")]
    Io {
        context: String,
        #[source]
        source: io::Error,
    },
    #[error("hmux_release_candidate_root_unsafe: {0}")]
    RootUnsafe(String),
    #[error("hmux_release_candidate_inventory_invalid: {0}")]
    InventoryInvalid(String),
    #[error("hmux_release_candidate_file_unsafe: {0}")]
    FileUnsafe(String),
    #[error("hmux_release_candidate_file_too_large: {0}")]
    FileTooLarge(String),
    #[error("hmux_release_candidate_manifest_invalid: {0}")]
    ManifestInvalid(String),
    #[error("hmux_release_candidate_protocol_invalid: {0}")]
    ProtocolInvalid(String),
    #[error("hmux_release_candidate_build_identity_invalid: {0}")]
    BuildIdentityInvalid(String),
    #[error("hmux_release_candidate_checksums_invalid: {0}")]
    ChecksumsInvalid(String),
    #[error("hmux_release_candidate_archive_invalid: {0}")]
    ArchiveInvalid(String),
    #[error("hmux_release_candidate_archive_tree_mismatch: {0}")]
    ArchiveTreeMismatch(String),
    #[error("hmux_release_candidate_output_unsafe: {0}")]
    OutputUnsafe(String),
    #[error("hmux_release_candidate_json: {0}")]
    Json(#[from] serde_json::Error),
}

/// Validate the closed artifact set, then durably create the candidate.
pub fn create_release_candidate(
    options: CandidateOptions,
) -> Result<ReleaseCandidate, CandidateError> {
    validate_source_commit(&options.source_commit)?;
    validate_directory(&options.artifact_root, "artifact root")?;
    validate_directory(
        options
            .output
            .parent()
            .ok_or_else(|| CandidateError::OutputUnsafe(options.output.display().to_string()))?,
        "output parent",
    )
    .map_err(|_| CandidateError::OutputUnsafe(options.output.display().to_string()))?;

    let trees = TARGETS
        .into_iter()
        .map(|target| {
            let proof = inspect_tree(
                &options.artifact_root.join(target.as_str()),
                target,
                &options.source_commit,
                options.workflow_run_id,
                options.workflow_run_attempt,
            )?;
            Ok((target, proof))
        })
        .collect::<Result<BTreeMap<_, _>, CandidateError>>()?;

    let archive_names = trees
        .values()
        .map(|proof| format!("{}.tar.gz", proof.manifest.build_id))
        .collect::<BTreeSet<_>>();
    let invocations = trees
        .iter()
        .map(|(target, proof)| {
            proof
                .manifest
                .build_id
                .strip_suffix(&format!(".{target}.release"))
                .expect("manifest validation established the target suffix")
        })
        .collect::<BTreeSet<_>>();
    if invocations.len() != 1 {
        return Err(CandidateError::BuildIdentityInvalid(
            "both targets must come from one workflow invocation".to_owned(),
        ));
    }
    validate_inventory(&options.artifact_root, &archive_names)?;
    let checksums = read_checksums(&options.artifact_root.join("SHA256SUMS"), &archive_names)?;

    let mut artifacts = Vec::with_capacity(TARGETS.len());
    for target in TARGETS {
        let tree = trees
            .get(&target)
            .expect("all fixed targets were inspected");
        let archive_name = format!("{}.tar.gz", tree.manifest.build_id);
        let archive = inspect_archive(
            &options.artifact_root.join(&archive_name),
            target,
            &archive_name,
            &options.source_commit,
            options.workflow_run_id,
            options.workflow_run_attempt,
        )?;
        if checksums.get(&archive_name) != Some(&archive.sha256) {
            return Err(CandidateError::ChecksumsInvalid(archive_name));
        }
        if archive.manifest_bytes != tree.manifest_bytes
            || archive.member_sha256 != tree.member_sha256
        {
            return Err(CandidateError::ArchiveTreeMismatch(archive_name));
        }
        artifacts.push(CandidateArtifact {
            logical_target_path: archive_name,
            length: archive.length,
            sha256: archive.sha256,
            custom: SignedTargetMetadata {
                schema_version: 1,
                product: "hmux".to_owned(),
                channel: options.channel,
                build_id: tree.manifest.build_id.clone(),
                source_commit: options.source_commit.clone(),
                target_triple: target,
                archive_format: "tar.gz".to_owned(),
                package_version: tree.manifest.package_version.clone(),
                protocol_minimum: tree.manifest.protocol.minimum.clone(),
                protocol_maximum: tree.manifest.protocol.maximum.clone(),
                installed_tree_sha256: tree.installed_tree_sha256.clone(),
            },
        });
    }

    let candidate = ReleaseCandidate {
        schema_version: 1,
        channel: options.channel,
        source_commit: options.source_commit,
        workflow_run_id: options.workflow_run_id,
        workflow_run_attempt: options.workflow_run_attempt,
        artifacts,
        publication_order: publication_order(),
    };
    write_candidate(&options.output, &candidate)?;
    Ok(candidate)
}

/// Recompute and compare every field from the exact downloaded bundle.
///
/// This is the protected publisher boundary: the unsigned candidate is only a
/// hint until this function has reproduced it from the archive bytes.
pub fn verify_release_candidate(
    options: VerifyCandidateOptions,
) -> Result<ReleaseCandidate, CandidateError> {
    validate_source_commit(&options.source_commit)?;
    validate_directory(&options.artifact_root, "artifact root")?;
    if options.candidate.parent() != Some(options.artifact_root.as_path())
        || options.candidate.file_name().and_then(|name| name.to_str())
            != Some("release-candidate.json")
    {
        return Err(CandidateError::OutputUnsafe(
            options.candidate.display().to_string(),
        ));
    }
    let candidate_bytes = read_bounded_file(&options.candidate, MAX_CANDIDATE_BYTES, Some(0o644))?;
    let candidate: ReleaseCandidate = serde_json::from_slice(&candidate_bytes)?;
    if candidate.schema_version != 1
        || candidate.channel != options.channel
        || candidate.source_commit != options.source_commit
        || candidate.workflow_run_id != options.workflow_run_id
        || candidate.workflow_run_attempt != options.workflow_run_attempt
        || candidate.publication_order != publication_order()
        || candidate.artifacts.len() != TARGETS.len()
    {
        return Err(CandidateError::ManifestInvalid(
            "candidate envelope".to_owned(),
        ));
    }
    let archive_names = candidate
        .artifacts
        .iter()
        .map(|artifact| artifact.logical_target_path.clone())
        .collect::<BTreeSet<_>>();
    if archive_names.len() != TARGETS.len() {
        return Err(CandidateError::InventoryInvalid(
            "candidate archive identities".to_owned(),
        ));
    }
    validate_bundle_inventory(&options.artifact_root, &archive_names)?;
    let checksums = read_checksums(&options.artifact_root.join("SHA256SUMS"), &archive_names)?;

    let mut recomputed = Vec::with_capacity(TARGETS.len());
    for (index, target) in TARGETS.into_iter().enumerate() {
        let hinted = &candidate.artifacts[index];
        if hinted.custom.target_triple != target
            || hinted.logical_target_path != format!("{}.tar.gz", hinted.custom.build_id)
        {
            return Err(CandidateError::ManifestInvalid(
                "candidate target identity".to_owned(),
            ));
        }
        let archive = inspect_archive(
            &options.artifact_root.join(&hinted.logical_target_path),
            target,
            &hinted.logical_target_path,
            &options.source_commit,
            options.workflow_run_id,
            options.workflow_run_attempt,
        )?;
        if checksums.get(&hinted.logical_target_path) != Some(&archive.sha256) {
            return Err(CandidateError::ChecksumsInvalid(
                hinted.logical_target_path.clone(),
            ));
        }
        recomputed.push(artifact_from_archive(
            options.channel,
            &options.source_commit,
            target,
            &hinted.logical_target_path,
            &archive,
        ));
    }
    validate_cross_target_invocation(recomputed.iter().map(|artifact| {
        (
            artifact.custom.target_triple,
            artifact.custom.build_id.as_str(),
        )
    }))?;
    let expected = ReleaseCandidate {
        schema_version: 1,
        channel: options.channel,
        source_commit: options.source_commit,
        workflow_run_id: options.workflow_run_id,
        workflow_run_attempt: options.workflow_run_attempt,
        artifacts: recomputed,
        publication_order: publication_order(),
    };
    if candidate != expected {
        return Err(CandidateError::ManifestInvalid(
            "candidate does not reproduce the bundle".to_owned(),
        ));
    }
    let mut canonical = serde_json::to_vec_pretty(&expected)?;
    canonical.push(b'\n');
    if candidate_bytes != canonical {
        return Err(CandidateError::ManifestInvalid(
            "candidate JSON is not canonical".to_owned(),
        ));
    }
    Ok(expected)
}

fn publication_order() -> [String; 5] {
    [
        "sequential_versioned_roots".to_owned(),
        "hash_prefixed_target".to_owned(),
        "versioned_targets".to_owned(),
        "versioned_snapshot".to_owned(),
        "timestamp".to_owned(),
    ]
}

fn validate_cross_target_invocation<'a>(
    identities: impl IntoIterator<Item = (ArtifactTarget, &'a str)>,
) -> Result<(), CandidateError> {
    let invocations = identities
        .into_iter()
        .map(|(target, build_id)| {
            build_id
                .strip_suffix(&format!(".{target}.release"))
                .ok_or_else(|| CandidateError::BuildIdentityInvalid(build_id.to_owned()))
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if invocations.len() != 1 {
        return Err(CandidateError::BuildIdentityInvalid(
            "both targets must come from one workflow invocation".to_owned(),
        ));
    }
    Ok(())
}

fn artifact_from_archive(
    channel: ReleaseChannel,
    source_commit: &str,
    target: ArtifactTarget,
    archive_name: &str,
    archive: &ArchiveProof,
) -> CandidateArtifact {
    CandidateArtifact {
        logical_target_path: archive_name.to_owned(),
        length: archive.length,
        sha256: archive.sha256.clone(),
        custom: SignedTargetMetadata {
            schema_version: 1,
            product: "hmux".to_owned(),
            channel,
            build_id: archive.manifest.build_id.clone(),
            source_commit: source_commit.to_owned(),
            target_triple: target,
            archive_format: "tar.gz".to_owned(),
            package_version: archive.manifest.package_version.clone(),
            protocol_minimum: archive.manifest.protocol.minimum.clone(),
            protocol_maximum: archive.manifest.protocol.maximum.clone(),
            installed_tree_sha256: archive.installed_tree_sha256.clone(),
        },
    }
}

fn validate_source_commit(source_commit: &str) -> Result<(), CandidateError> {
    if source_commit.len() != SOURCE_COMMIT_LENGTH
        || !source_commit
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(CandidateError::BuildIdentityInvalid(
            "source commit must be 40 lowercase hexadecimal characters".to_owned(),
        ));
    }
    Ok(())
}

fn inspect_tree(
    tree: &Path,
    target: ArtifactTarget,
    source_commit: &str,
    workflow_run_id: u64,
    workflow_run_attempt: u64,
) -> Result<TreeProof, CandidateError> {
    validate_directory(tree, target.as_str())?;
    validate_directory(&tree.join("bin"), &format!("{target}/bin"))?;
    let expected = BTreeSet::from(["bin".to_owned(), "install.json".to_owned()]);
    validate_directory_inventory(tree, &expected)?;
    let expected_bin = BTreeSet::from(["hmux".to_owned(), "hmux-runtime".to_owned()]);
    validate_directory_inventory(&tree.join("bin"), &expected_bin)?;

    let manifest_bytes =
        read_bounded_file(&tree.join("install.json"), MAX_MANIFEST_BYTES, Some(0o644))?;
    let manifest: InstallManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| CandidateError::ManifestInvalid(error.to_string()))?;
    validate_manifest(
        &manifest,
        target,
        source_commit,
        workflow_run_id,
        workflow_run_attempt,
    )?;

    let member_sha256 = BTreeMap::from([
        ("install.json", sha256_hex(&manifest_bytes)),
        (
            "bin/hmux",
            inspect_binary(
                &tree.join("bin/hmux"),
                target,
                "hmux",
                &manifest.build_id,
                &manifest.package_version,
                source_commit,
            )?,
        ),
        (
            "bin/hmux-runtime",
            inspect_binary(
                &tree.join("bin/hmux-runtime"),
                target,
                "hmux-runtime",
                &manifest.build_id,
                &manifest.package_version,
                source_commit,
            )?,
        ),
    ]);
    let installed_tree_sha256 = installed_tree_digest(&member_sha256);
    Ok(TreeProof {
        manifest,
        manifest_bytes,
        member_sha256,
        installed_tree_sha256,
    })
}

fn validate_manifest(
    manifest: &InstallManifest,
    target: ArtifactTarget,
    source_commit: &str,
    workflow_run_id: u64,
    workflow_run_attempt: u64,
) -> Result<(), CandidateError> {
    if manifest.schema_version != 1
        || manifest.profile != "release"
        || manifest.target_triple != target
    {
        return Err(CandidateError::ManifestInvalid(target.to_string()));
    }
    Version::parse(&manifest.package_version)
        .map_err(|error| CandidateError::ManifestInvalid(error.to_string()))?;
    validate_build_id(&manifest.build_id, target)
        .map_err(|error| CandidateError::BuildIdentityInvalid(error.to_string()))?;
    let minimum = ProtocolVersion::parse(&manifest.protocol.minimum)
        .map_err(|error| CandidateError::ProtocolInvalid(error.to_string()))?;
    let maximum = ProtocolVersion::parse(&manifest.protocol.maximum)
        .map_err(|error| CandidateError::ProtocolInvalid(error.to_string()))?;
    if minimum > maximum {
        return Err(CandidateError::ProtocolInvalid(format!(
            "{} is newer than {}",
            manifest.protocol.minimum, manifest.protocol.maximum
        )));
    }
    let prefix = &source_commit[..SOURCE_COMMIT_PREFIX_LENGTH];
    let expected_prefix = format!("{}+{prefix}.run-", manifest.package_version);
    let expected_suffix = format!(".{target}.release");
    let expected_invocation = format!("{workflow_run_id}-{workflow_run_attempt}");
    let invocation = manifest
        .build_id
        .strip_prefix(&expected_prefix)
        .and_then(|value| value.strip_suffix(&expected_suffix));
    if workflow_run_id == 0
        || workflow_run_attempt == 0
        || invocation != Some(expected_invocation.as_str())
    {
        return Err(CandidateError::BuildIdentityInvalid(
            manifest.build_id.clone(),
        ));
    }
    Ok(())
}

fn validate_inventory(root: &Path, archive_names: &BTreeSet<String>) -> Result<(), CandidateError> {
    let mut expected = archive_names.clone();
    expected.insert("SHA256SUMS".to_owned());
    expected.extend(TARGETS.map(|target| target.to_string()));
    validate_directory_inventory(root, &expected)
}

fn validate_bundle_inventory(
    root: &Path,
    archive_names: &BTreeSet<String>,
) -> Result<(), CandidateError> {
    let mut expected = archive_names.clone();
    expected.insert("SHA256SUMS".to_owned());
    expected.insert("release-candidate.json".to_owned());
    validate_directory_inventory(root, &expected)
}

fn validate_directory_inventory(
    directory: &Path,
    expected: &BTreeSet<String>,
) -> Result<(), CandidateError> {
    let mut actual = BTreeSet::new();
    let entries = fs::read_dir(directory).map_err(|source| CandidateError::Io {
        context: directory.display().to_string(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| CandidateError::Io {
            context: directory.display().to_string(),
            source,
        })?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| CandidateError::InventoryInvalid(directory.display().to_string()))?;
        if !actual.insert(name) {
            return Err(CandidateError::InventoryInvalid(
                directory.display().to_string(),
            ));
        }
    }
    if &actual != expected {
        return Err(CandidateError::InventoryInvalid(format!(
            "{} expected {expected:?}, found {actual:?}",
            directory.display()
        )));
    }
    Ok(())
}

fn read_checksums(
    path: &Path,
    archive_names: &BTreeSet<String>,
) -> Result<BTreeMap<String, String>, CandidateError> {
    let bytes = read_bounded_file(path, MAX_CHECKSUM_BYTES, Some(0o644))?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|error| CandidateError::ChecksumsInvalid(error.to_string()))?;
    if !bytes.ends_with(b"\n") {
        return Err(CandidateError::ChecksumsInvalid(
            "checksum file must end with a newline".to_owned(),
        ));
    }
    let mut result = BTreeMap::new();
    let mut previous_name = None;
    for line in text.lines() {
        let (digest, name) = line
            .split_once("  ")
            .ok_or_else(|| CandidateError::ChecksumsInvalid(line.to_owned()))?;
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !archive_names.contains(name)
            || result.insert(name.to_owned(), digest.to_owned()).is_some()
        {
            return Err(CandidateError::ChecksumsInvalid(line.to_owned()));
        }
        if previous_name
            .as_deref()
            .is_some_and(|previous| previous >= name)
        {
            return Err(CandidateError::ChecksumsInvalid(
                "checksum entries must be unique and sorted".to_owned(),
            ));
        }
        previous_name = Some(name.to_owned());
    }
    if result.keys().collect::<BTreeSet<_>>() != archive_names.iter().collect::<BTreeSet<_>>() {
        return Err(CandidateError::ChecksumsInvalid(
            "checksum inventory does not match archives".to_owned(),
        ));
    }
    Ok(result)
}

fn inspect_archive(
    path: &Path,
    target: ArtifactTarget,
    archive_name: &str,
    source_commit: &str,
    workflow_run_id: u64,
    workflow_run_attempt: u64,
) -> Result<ArchiveProof, CandidateError> {
    let (mut snapshot, length, sha256) = snapshot_file(path, MAX_TARGET_BYTES)?;
    snapshot
        .seek(SeekFrom::Start(0))
        .map_err(|source| CandidateError::Io {
            context: archive_name.to_owned(),
            source,
        })?;
    let mut decoder = GzDecoder::new(BufReader::new(snapshot));
    let expected = BTreeMap::from([
        (
            format!("{target}/"),
            (ArchiveMemberKind::Directory, 0o755, 0),
        ),
        (
            format!("{target}/bin/"),
            (ArchiveMemberKind::Directory, 0o755, 0),
        ),
        (
            format!("{target}/bin/hmux"),
            (ArchiveMemberKind::Regular, 0o755, MAX_BINARY_BYTES),
        ),
        (
            format!("{target}/bin/hmux-runtime"),
            (ArchiveMemberKind::Regular, 0o755, MAX_BINARY_BYTES),
        ),
        (
            format!("{target}/install.json"),
            (ArchiveMemberKind::Regular, 0o644, MAX_MANIFEST_BYTES),
        ),
    ]);
    let mut observed = BTreeSet::new();
    let mut member_sha256 = BTreeMap::new();
    let mut binary_snapshots = BTreeMap::new();
    let mut manifest_bytes = None;
    let mut unpacked = 0_u64;
    let mut stream_bytes = 0_u64;
    let maximum_stream_bytes = MAX_UNPACKED_BYTES + MAX_TAR_OVERHEAD_BYTES;
    let mut zero_blocks = 0_u8;
    loop {
        let mut header = [0_u8; TAR_BLOCK_BYTES];
        read_exact_tar(
            &mut decoder,
            &mut header,
            &mut stream_bytes,
            maximum_stream_bytes,
            archive_name,
        )?;
        if header.iter().all(|byte| *byte == 0) {
            zero_blocks += 1;
            if zero_blocks == 2 {
                break;
            }
            continue;
        }
        if zero_blocks != 0 {
            return Err(CandidateError::ArchiveInvalid(format!(
                "{archive_name}: data after end marker"
            )));
        }
        validate_tar_checksum(&header, archive_name)?;
        let member = canonical_tar_text(&header[0..100], archive_name, "path")?;
        if header[345..500].iter().any(|byte| *byte != 0) {
            return Err(CandidateError::ArchiveInvalid(format!(
                "{archive_name}: prefixed paths are forbidden"
            )));
        }
        let kind = match header[156] {
            0 | b'0' => ArchiveMemberKind::Regular,
            b'5' => ArchiveMemberKind::Directory,
            _ => {
                return Err(CandidateError::ArchiveInvalid(format!(
                    "{archive_name}: forbidden member type"
                )));
            }
        };
        if header[157..257].iter().any(|byte| *byte != 0) {
            return Err(CandidateError::ArchiveInvalid(format!(
                "{archive_name}: link target is forbidden"
            )));
        }
        let mode = parse_tar_octal(&header[100..108], archive_name, "mode")?;
        let size = parse_tar_octal(&header[124..136], archive_name, "size")?;
        let (expected_type, expected_mode, maximum) = expected
            .get(&member)
            .ok_or_else(|| CandidateError::ArchiveInvalid(format!("{archive_name}: {member}")))?;
        if !observed.insert(member.clone())
            || kind != *expected_type
            || mode & 0o7777 != *expected_mode
        {
            return Err(CandidateError::ArchiveInvalid(format!(
                "{archive_name}: {member}"
            )));
        }
        if size > *maximum {
            return Err(CandidateError::FileTooLarge(format!(
                "{archive_name}: {member}"
            )));
        }
        unpacked = unpacked.checked_add(size).ok_or_else(|| {
            CandidateError::FileTooLarge(format!("{archive_name}: unpacked overflow"))
        })?;
        if unpacked > MAX_UNPACKED_BYTES {
            return Err(CandidateError::FileTooLarge(format!(
                "{archive_name}: unpacked total"
            )));
        }
        if *expected_type == ArchiveMemberKind::Regular {
            let mut digest = Sha256::new();
            if member.ends_with("/install.json") {
                let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
                copy_tar_member(
                    &mut decoder,
                    &mut bytes,
                    size,
                    &mut digest,
                    &mut stream_bytes,
                    maximum_stream_bytes,
                    archive_name,
                )?;
                manifest_bytes = Some(bytes);
            } else {
                let logical_name = if member.ends_with("/hmux-runtime") {
                    "bin/hmux-runtime"
                } else {
                    "bin/hmux"
                };
                let mut binary = tempfile().map_err(|source| CandidateError::Io {
                    context: "temporary binary snapshot".to_owned(),
                    source,
                })?;
                copy_tar_member(
                    &mut decoder,
                    &mut binary,
                    size,
                    &mut digest,
                    &mut stream_bytes,
                    maximum_stream_bytes,
                    archive_name,
                )?;
                binary_snapshots.insert(logical_name, binary);
            }
            let logical_name = if member.ends_with("/install.json") {
                "install.json"
            } else if member.ends_with("/hmux-runtime") {
                "bin/hmux-runtime"
            } else {
                "bin/hmux"
            };
            member_sha256.insert(logical_name, hex::encode(digest.finalize()));
        } else if size != 0 {
            return Err(CandidateError::ArchiveInvalid(format!(
                "{archive_name}: non-empty directory"
            )));
        }
        let padding =
            (TAR_BLOCK_BYTES as u64 - size % TAR_BLOCK_BYTES as u64) % TAR_BLOCK_BYTES as u64;
        if padding > 0 {
            let padding = usize::try_from(padding).expect("tar padding is below one block");
            let mut bytes = [0_u8; TAR_BLOCK_BYTES];
            read_exact_tar(
                &mut decoder,
                &mut bytes[..padding],
                &mut stream_bytes,
                maximum_stream_bytes,
                archive_name,
            )?;
            if bytes[..padding].iter().any(|byte| *byte != 0) {
                return Err(CandidateError::ArchiveInvalid(format!(
                    "{archive_name}: non-zero member padding"
                )));
            }
        }
    }
    if observed != expected.keys().cloned().collect() {
        return Err(CandidateError::ArchiveInvalid(format!(
            "{archive_name}: incomplete member inventory"
        )));
    }
    let manifest_bytes =
        manifest_bytes.ok_or_else(|| CandidateError::ArchiveInvalid(archive_name.to_owned()))?;
    let manifest: InstallManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| CandidateError::ManifestInvalid(error.to_string()))?;
    validate_manifest(
        &manifest,
        target,
        source_commit,
        workflow_run_id,
        workflow_run_attempt,
    )?;
    for (logical_name, binary_name) in [("bin/hmux", "hmux"), ("bin/hmux-runtime", "hmux-runtime")]
    {
        let binary = binary_snapshots
            .get_mut(logical_name)
            .expect("closed archive inventory contains both binaries");
        let binary_length = binary
            .metadata()
            .map_err(|source| CandidateError::Io {
                context: archive_name.to_owned(),
                source,
            })?
            .len();
        inspect_elf(
            binary,
            binary_length,
            ExpectedBinaryIdentity {
                target,
                binary: binary_name,
                build_id: &manifest.build_id,
                package_version: &manifest.package_version,
                source_commit,
            },
            archive_name,
        )?;
    }
    let mut trailing = [0_u8; 64 * 1024];
    loop {
        let read = decoder
            .read(&mut trailing)
            .map_err(|error| CandidateError::ArchiveInvalid(format!("{archive_name}: {error}")))?;
        if read == 0 {
            break;
        }
        stream_bytes = stream_bytes
            .checked_add(read as u64)
            .ok_or_else(|| CandidateError::FileTooLarge(format!("{archive_name}: tar stream")))?;
        if stream_bytes > maximum_stream_bytes || trailing[..read].iter().any(|byte| *byte != 0) {
            return Err(CandidateError::ArchiveInvalid(format!(
                "{archive_name}: trailing tar data"
            )));
        }
    }
    let mut compressed = decoder.into_inner();
    let mut trailing_compressed = [0_u8; 1];
    if compressed
        .read(&mut trailing_compressed)
        .map_err(|error| CandidateError::ArchiveInvalid(format!("{archive_name}: {error}")))?
        != 0
    {
        return Err(CandidateError::ArchiveInvalid(format!(
            "{archive_name}: multiple gzip members or trailing bytes"
        )));
    }
    let installed_tree_sha256 = installed_tree_digest(&member_sha256);
    Ok(ArchiveProof {
        length,
        sha256,
        member_sha256,
        installed_tree_sha256,
        manifest_bytes,
        manifest,
    })
}

fn copy_tar_member<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    expected: u64,
    digest: &mut Sha256,
    stream_bytes: &mut u64,
    maximum_stream_bytes: u64,
    context: &str,
) -> Result<(), CandidateError> {
    let mut remaining = expected;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        let limit = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let read = reader
            .read(&mut buffer[..limit])
            .map_err(|error| CandidateError::ArchiveInvalid(format!("{context}: {error}")))?;
        if read == 0 {
            return Err(CandidateError::ArchiveInvalid(format!(
                "{context}: truncated member"
            )));
        }
        *stream_bytes = stream_bytes
            .checked_add(read as u64)
            .ok_or_else(|| CandidateError::FileTooLarge(format!("{context}: tar stream")))?;
        if *stream_bytes > maximum_stream_bytes {
            return Err(CandidateError::FileTooLarge(format!(
                "{context}: tar stream"
            )));
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|source| CandidateError::Io {
                context: context.to_owned(),
                source,
            })?;
        digest.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(())
}

fn read_exact_tar<R: Read>(
    reader: &mut R,
    buffer: &mut [u8],
    stream_bytes: &mut u64,
    maximum_stream_bytes: u64,
    context: &str,
) -> Result<(), CandidateError> {
    reader
        .read_exact(buffer)
        .map_err(|error| CandidateError::ArchiveInvalid(format!("{context}: {error}")))?;
    *stream_bytes = stream_bytes
        .checked_add(buffer.len() as u64)
        .ok_or_else(|| CandidateError::FileTooLarge(format!("{context}: tar stream")))?;
    if *stream_bytes > maximum_stream_bytes {
        return Err(CandidateError::FileTooLarge(format!(
            "{context}: tar stream"
        )));
    }
    Ok(())
}

fn canonical_tar_text(field: &[u8], context: &str, label: &str) -> Result<String, CandidateError> {
    let end = field
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(field.len());
    if field[end..].iter().any(|byte| *byte != 0) {
        return Err(CandidateError::ArchiveInvalid(format!(
            "{context}: non-canonical {label}"
        )));
    }
    let value = std::str::from_utf8(&field[..end])
        .map_err(|_| CandidateError::ArchiveInvalid(format!("{context}: invalid {label}")))?;
    if value.is_empty() {
        return Err(CandidateError::ArchiveInvalid(format!(
            "{context}: empty {label}"
        )));
    }
    Ok(value.to_owned())
}

fn parse_tar_octal(field: &[u8], context: &str, label: &str) -> Result<u64, CandidateError> {
    let start = field
        .iter()
        .position(|byte| *byte != b' ')
        .unwrap_or(field.len());
    let end = field[start..]
        .iter()
        .position(|byte| *byte == b' ' || *byte == 0)
        .map_or(field.len(), |offset| start + offset);
    let value = &field[start..end];
    if value.is_empty()
        || !value.iter().all(|byte| (b'0'..=b'7').contains(byte))
        || field[end..].iter().any(|byte| *byte != b' ' && *byte != 0)
    {
        return Err(CandidateError::ArchiveInvalid(format!(
            "{context}: invalid {label}"
        )));
    }
    let text = std::str::from_utf8(value)
        .map_err(|_| CandidateError::ArchiveInvalid(format!("{context}: invalid {label}")))?;
    u64::from_str_radix(text, 8)
        .map_err(|_| CandidateError::ArchiveInvalid(format!("{context}: invalid {label}")))
}

fn validate_tar_checksum(
    header: &[u8; TAR_BLOCK_BYTES],
    context: &str,
) -> Result<(), CandidateError> {
    let expected = parse_tar_octal(&header[148..156], context, "checksum")?;
    let actual = header
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            if (148..156).contains(&index) {
                u64::from(b' ')
            } else {
                u64::from(*byte)
            }
        })
        .sum::<u64>();
    if actual != expected {
        return Err(CandidateError::ArchiveInvalid(format!(
            "{context}: checksum mismatch"
        )));
    }
    Ok(())
}

fn installed_tree_digest(member_sha256: &BTreeMap<&'static str, String>) -> String {
    let mut digest = Sha256::new();
    for name in ["install.json", "bin/hmux", "bin/hmux-runtime"] {
        digest.update(member_sha256.get(name).expect("fixed members"));
        digest.update(b"  ");
        digest.update(name.as_bytes());
        digest.update(b"\n");
    }
    hex::encode(digest.finalize())
}

fn read_bounded_file(
    path: &Path,
    maximum: u64,
    expected_mode: Option<u32>,
) -> Result<Vec<u8>, CandidateError> {
    let (mut snapshot, length, _) = snapshot_file_with_mode(path, maximum, expected_mode)?;
    snapshot
        .seek(SeekFrom::Start(0))
        .map_err(|source| CandidateError::Io {
            context: path.display().to_string(),
            source,
        })?;
    let capacity = usize::try_from(length)
        .map_err(|_| CandidateError::FileTooLarge(path.display().to_string()))?;
    let mut bytes = Vec::with_capacity(capacity);
    snapshot
        .read_to_end(&mut bytes)
        .map_err(|source| CandidateError::Io {
            context: path.display().to_string(),
            source,
        })?;
    Ok(bytes)
}

fn inspect_binary(
    path: &Path,
    target: ArtifactTarget,
    binary: &str,
    build_id: &str,
    package_version: &str,
    source_commit: &str,
) -> Result<String, CandidateError> {
    let (mut snapshot, length, sha256) =
        snapshot_file_with_mode(path, MAX_BINARY_BYTES, Some(0o755))?;
    inspect_elf(
        &mut snapshot,
        length,
        ExpectedBinaryIdentity {
            target,
            binary,
            build_id,
            package_version,
            source_commit,
        },
        &path.display().to_string(),
    )?;
    Ok(sha256)
}

fn inspect_elf(
    file: &mut File,
    length: u64,
    expected: ExpectedBinaryIdentity<'_>,
    context: &str,
) -> Result<(), CandidateError> {
    let ExpectedBinaryIdentity {
        target,
        binary,
        build_id,
        package_version,
        source_commit,
    } = expected;
    let header = read_file_range(file, 0, 64, length, context)?;
    if &header[0..4] != b"\x7fELF"
        || header[4] != 2
        || header[5] != 1
        || header[6] != 1
        || !matches!(header[7], 0 | 3)
        || header[8] != 0
        || read_u16(&header, 16) != Some(2) && read_u16(&header, 16) != Some(3)
    {
        return Err(CandidateError::FileUnsafe(format!(
            "{context}: invalid Linux ELF64 executable"
        )));
    }
    let expected_machine = match target {
        ArtifactTarget::X86_64LinuxMusl => 62,
        ArtifactTarget::Aarch64LinuxMusl => 183,
    };
    if read_u16(&header, 18) != Some(expected_machine) {
        return Err(CandidateError::FileUnsafe(format!(
            "{context}: wrong ELF machine"
        )));
    }

    let program_offset = read_u64(&header, 32)
        .ok_or_else(|| CandidateError::FileUnsafe(format!("{context}: ELF header")))?;
    let program_entry_size = read_u16(&header, 54)
        .ok_or_else(|| CandidateError::FileUnsafe(format!("{context}: ELF header")))?
        as u64;
    let program_count = read_u16(&header, 56)
        .ok_or_else(|| CandidateError::FileUnsafe(format!("{context}: ELF header")))?
        as u64;
    if program_entry_size != 56 || program_count == 0 || program_count > 128 {
        return Err(CandidateError::FileUnsafe(format!(
            "{context}: invalid program headers"
        )));
    }
    let entry_point = read_u64(&header, 24)
        .ok_or_else(|| CandidateError::FileUnsafe(format!("{context}: ELF header")))?;
    if target == ArtifactTarget::Aarch64LinuxMusl && entry_point % 4 != 0 {
        return Err(CandidateError::FileUnsafe(format!(
            "{context}: unaligned AArch64 entry point"
        )));
    }
    let mut entry_in_executable_load = false;
    for index in 0..program_count {
        let offset = program_offset
            .checked_add(index * program_entry_size)
            .ok_or_else(|| CandidateError::FileUnsafe(context.to_owned()))?;
        let program = read_file_range(file, offset, 56, length, context)?;
        let kind = read_u32(&program, 0).expect("fixed ELF field");
        let flags = read_u32(&program, 4).expect("fixed ELF field");
        let file_offset = read_u64(&program, 8).expect("fixed ELF field");
        let virtual_address = read_u64(&program, 16).expect("fixed ELF field");
        let file_size = read_u64(&program, 32).expect("fixed ELF field");
        let memory_size = read_u64(&program, 40).expect("fixed ELF field");
        let alignment = read_u64(&program, 48).expect("fixed ELF field");
        validate_file_range(file_offset, file_size, length, context)?;
        if kind == 3 {
            return Err(CandidateError::FileUnsafe(format!(
                "{context}: dynamically linked ELF"
            )));
        }
        if kind == 1 {
            if memory_size < file_size
                || alignment > 1
                    && (!alignment.is_power_of_two()
                        || file_offset % alignment != virtual_address % alignment)
            {
                return Err(CandidateError::FileUnsafe(format!(
                    "{context}: invalid load segment"
                )));
            }
            let file_backed_end = virtual_address
                .checked_add(file_size)
                .ok_or_else(|| CandidateError::FileUnsafe(context.to_owned()))?;
            virtual_address.checked_add(memory_size).ok_or_else(|| {
                CandidateError::FileUnsafe(format!("{context}: invalid load segment"))
            })?;
            if flags & 1 != 0
                && file_size > 0
                && (virtual_address..file_backed_end).contains(&entry_point)
            {
                entry_in_executable_load = true;
            }
        }
        if kind == 2 {
            inspect_dynamic_segment(file, file_offset, file_size, length, context)?;
        }
    }
    if !entry_in_executable_load {
        return Err(CandidateError::FileUnsafe(format!(
            "{context}: entry point is not in a file-backed executable load segment"
        )));
    }

    let section_offset = read_u64(&header, 40)
        .ok_or_else(|| CandidateError::FileUnsafe(format!("{context}: ELF header")))?;
    let section_entry_size = read_u16(&header, 58)
        .ok_or_else(|| CandidateError::FileUnsafe(format!("{context}: ELF header")))?
        as u64;
    let section_count = read_u16(&header, 60)
        .ok_or_else(|| CandidateError::FileUnsafe(format!("{context}: ELF header")))?
        as u64;
    let names_index = read_u16(&header, 62)
        .ok_or_else(|| CandidateError::FileUnsafe(format!("{context}: ELF header")))?
        as u64;
    if section_entry_size != 64
        || section_count == 0
        || section_count > 4096
        || names_index >= section_count
    {
        return Err(CandidateError::FileUnsafe(format!(
            "{context}: invalid section headers"
        )));
    }
    let names_header = read_file_range(
        file,
        section_offset
            .checked_add(names_index * section_entry_size)
            .ok_or_else(|| CandidateError::FileUnsafe(context.to_owned()))?,
        64,
        length,
        context,
    )?;
    let names_offset = read_u64(&names_header, 24).expect("fixed ELF field");
    let names_length = read_u64(&names_header, 32).expect("fixed ELF field");
    if names_length > 1024 * 1024 {
        return Err(CandidateError::FileUnsafe(format!(
            "{context}: oversized section names"
        )));
    }
    let names = read_file_range(
        file,
        names_offset,
        usize::try_from(names_length)
            .map_err(|_| CandidateError::FileUnsafe(context.to_owned()))?,
        length,
        context,
    )?;
    let mut provenance = None;
    let mut audit_data = None;
    for index in 0..section_count {
        let section = read_file_range(
            file,
            section_offset
                .checked_add(index * section_entry_size)
                .ok_or_else(|| CandidateError::FileUnsafe(context.to_owned()))?,
            64,
            length,
            context,
        )?;
        let name_offset = read_u32(&section, 0).expect("fixed ELF field") as usize;
        let Some(name) = elf_string(&names, name_offset) else {
            return Err(CandidateError::FileUnsafe(format!(
                "{context}: invalid section name"
            )));
        };
        let offset = read_u64(&section, 24).expect("fixed ELF field");
        let size = read_u64(&section, 32).expect("fixed ELF field");
        match name {
            ".hmux.build" => {
                if provenance.is_some() {
                    return Err(CandidateError::FileUnsafe(format!(
                        "{context}: duplicate build provenance"
                    )));
                }
                if read_u32(&section, 4) != Some(1) || size == 0 || size > 4096 {
                    return Err(CandidateError::FileUnsafe(format!(
                        "{context}: invalid build provenance section"
                    )));
                }
                provenance = Some(read_file_range(
                    file,
                    offset,
                    usize::try_from(size).expect("provenance size is bounded"),
                    length,
                    context,
                )?);
            }
            ".dep-v0" => {
                if audit_data.is_some() {
                    return Err(CandidateError::FileUnsafe(format!(
                        "{context}: duplicate cargo audit data"
                    )));
                }
                if read_u32(&section, 4) != Some(1) || size == 0 || size > MAX_AUDIT_DATA_BYTES {
                    return Err(CandidateError::FileUnsafe(format!(
                        "{context}: invalid cargo audit data section"
                    )));
                }
                audit_data = Some(read_file_range(
                    file,
                    offset,
                    usize::try_from(size).expect("audit data size is bounded"),
                    length,
                    context,
                )?);
            }
            _ => {}
        }
    }
    let provenance: BinaryProvenance =
        serde_json::from_slice(&provenance.ok_or_else(|| {
            CandidateError::FileUnsafe(format!("{context}: no build provenance"))
        })?)
        .map_err(|error| CandidateError::FileUnsafe(format!("{context}: {error}")))?;
    if provenance.schema_version != 1
        || provenance.product != "hmux"
        || provenance.binary != binary
        || provenance.build_id != build_id
        || provenance.source_commit != source_commit
        || provenance.target_triple != target
    {
        return Err(CandidateError::FileUnsafe(format!(
            "{context}: build provenance mismatch"
        )));
    }
    inspect_cargo_audit_data(
        &audit_data
            .ok_or_else(|| CandidateError::FileUnsafe(format!("{context}: no cargo audit data")))?,
        binary,
        package_version,
        context,
    )?;
    Ok(())
}

fn inspect_cargo_audit_data(
    compressed: &[u8],
    binary: &str,
    package_version: &str,
    context: &str,
) -> Result<(), CandidateError> {
    let mut decoder = ZlibDecoder::new(compressed);
    let mut json = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = decoder.read(&mut buffer).map_err(|error| {
            CandidateError::FileUnsafe(format!("{context}: invalid cargo audit data: {error}"))
        })?;
        if read == 0 {
            break;
        }
        if json.len().saturating_add(read) > MAX_AUDIT_JSON_BYTES {
            return Err(CandidateError::FileUnsafe(format!(
                "{context}: oversized cargo audit data"
            )));
        }
        json.extend_from_slice(&buffer[..read]);
    }
    if !decoder.into_inner().is_empty() {
        return Err(CandidateError::FileUnsafe(format!(
            "{context}: trailing cargo audit data"
        )));
    }
    let audit: AuditVersionInfo = serde_json::from_slice(&json).map_err(|error| {
        CandidateError::FileUnsafe(format!("{context}: invalid cargo audit data: {error}"))
    })?;
    let expected_root = match binary {
        "hmux" => "hmux-cli",
        "hmux-runtime" => "hmux-runtime",
        _ => {
            return Err(CandidateError::FileUnsafe(format!(
                "{context}: unknown binary audit identity"
            )));
        }
    };
    let mut roots = audit.packages.iter().filter(|package| package.root);
    let root = roots.next().ok_or_else(|| {
        CandidateError::FileUnsafe(format!("{context}: cargo audit data has no root package"))
    })?;
    if roots.next().is_some()
        || audit.format != 1
        || root.name != expected_root
        || root.version.to_string() != package_version
        || !matches!(root.source, AuditSource::Local)
    {
        return Err(CandidateError::FileUnsafe(format!(
            "{context}: cargo audit root package mismatch"
        )));
    }
    Ok(())
}

fn inspect_dynamic_segment(
    file: &mut File,
    offset: u64,
    size: u64,
    length: u64,
    context: &str,
) -> Result<(), CandidateError> {
    const ELF64_DYNAMIC_ENTRY_SIZE: u64 = 16;
    const MAX_DYNAMIC_SEGMENT_BYTES: u64 = 1024 * 1024;
    if size == 0 || size > MAX_DYNAMIC_SEGMENT_BYTES || size % ELF64_DYNAMIC_ENTRY_SIZE != 0 {
        return Err(CandidateError::FileUnsafe(format!(
            "{context}: invalid dynamic segment"
        )));
    }
    let entries = read_file_range(
        file,
        offset,
        usize::try_from(size)
            .map_err(|_| CandidateError::FileUnsafe(format!("{context}: dynamic segment")))?,
        length,
        context,
    )?;
    let mut terminated = false;
    for entry in entries.chunks_exact(ELF64_DYNAMIC_ENTRY_SIZE as usize) {
        match read_u64(entry, 0).expect("fixed ELF field") {
            0 => terminated = true,
            1 => {
                return Err(CandidateError::FileUnsafe(format!(
                    "{context}: dynamically linked ELF has DT_NEEDED"
                )));
            }
            _ if terminated => {
                return Err(CandidateError::FileUnsafe(format!(
                    "{context}: data after dynamic terminator"
                )));
            }
            _ => {}
        }
    }
    if !terminated {
        return Err(CandidateError::FileUnsafe(format!(
            "{context}: unterminated dynamic segment"
        )));
    }
    Ok(())
}

fn read_file_range(
    file: &mut File,
    offset: u64,
    size: usize,
    length: u64,
    context: &str,
) -> Result<Vec<u8>, CandidateError> {
    validate_file_range(offset, size as u64, length, context)?;
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| {
            let mut bytes = vec![0_u8; size];
            file.read_exact(&mut bytes).map(|()| bytes)
        })
        .map_err(|source| CandidateError::Io {
            context: context.to_owned(),
            source,
        })
}

fn validate_file_range(
    offset: u64,
    size: u64,
    length: u64,
    context: &str,
) -> Result<(), CandidateError> {
    if offset.checked_add(size).is_none_or(|end| end > length) {
        return Err(CandidateError::FileUnsafe(format!(
            "{context}: ELF range outside file"
        )));
    }
    Ok(())
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        bytes.get(offset..offset + 8)?.try_into().ok()?,
    ))
}

fn elf_string(bytes: &[u8], offset: usize) -> Option<&str> {
    let tail = bytes.get(offset..)?;
    let end = tail.iter().position(|byte| *byte == 0)?;
    std::str::from_utf8(&tail[..end]).ok()
}

fn snapshot_file(path: &Path, maximum: u64) -> Result<(File, u64, String), CandidateError> {
    snapshot_file_with_mode(path, maximum, None)
}

fn snapshot_file_with_mode(
    path: &Path,
    maximum: u64,
    expected_mode: Option<u32>,
) -> Result<(File, u64, String), CandidateError> {
    let mut source = open_regular_nofollow(path, expected_mode)?;
    let metadata = source.metadata().map_err(|source| CandidateError::Io {
        context: path.display().to_string(),
        source,
    })?;
    if metadata.len() > maximum {
        return Err(CandidateError::FileTooLarge(path.display().to_string()));
    }
    let mut snapshot = tempfile().map_err(|source| CandidateError::Io {
        context: "temporary snapshot".to_owned(),
        source,
    })?;
    let mut digest = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|source| CandidateError::Io {
                context: path.display().to_string(),
                source,
            })?;
        if read == 0 {
            break;
        }
        copied = copied
            .checked_add(read as u64)
            .ok_or_else(|| CandidateError::FileTooLarge(path.display().to_string()))?;
        if copied > maximum || copied > metadata.len() {
            return Err(CandidateError::FileTooLarge(path.display().to_string()));
        }
        snapshot
            .write_all(&buffer[..read])
            .map_err(|source| CandidateError::Io {
                context: "temporary snapshot".to_owned(),
                source,
            })?;
        digest.update(&buffer[..read]);
    }
    if copied != metadata.len() {
        return Err(CandidateError::FileUnsafe(path.display().to_string()));
    }
    Ok((snapshot, copied, hex::encode(digest.finalize())))
}

fn open_regular_nofollow(path: &Path, expected_mode: Option<u32>) -> Result<File, CandidateError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options
        .open(path)
        .map_err(|_| CandidateError::FileUnsafe(path.display().to_string()))?;
    let metadata = file
        .metadata()
        .map_err(|_| CandidateError::FileUnsafe(path.display().to_string()))?;
    if !metadata.is_file() {
        return Err(CandidateError::FileUnsafe(path.display().to_string()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.nlink() != 1
            || expected_mode.is_some_and(|mode| metadata.permissions().mode() & 0o7777 != mode)
        {
            return Err(CandidateError::FileUnsafe(path.display().to_string()));
        }
    }
    Ok(file)
}

fn validate_directory(path: &Path, context: &str) -> Result<(), CandidateError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| CandidateError::RootUnsafe(context.to_owned()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(CandidateError::RootUnsafe(context.to_owned()));
    }
    Ok(())
}

fn write_candidate(path: &Path, candidate: &ReleaseCandidate) -> Result<(), CandidateError> {
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| CandidateError::Io {
            context: path.display().to_string(),
            source,
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        output
            .set_permissions(fs::Permissions::from_mode(0o644))
            .map_err(|source| CandidateError::Io {
                context: path.display().to_string(),
                source,
            })?;
    }
    serde_json::to_writer_pretty(&mut output, candidate)?;
    output
        .write_all(b"\n")
        .and_then(|()| output.sync_all())
        .map_err(|source| CandidateError::Io {
            context: path.display().to_string(),
            source,
        })?;
    if let Some(parent) = path.parent() {
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|source| CandidateError::Io {
                context: parent.display().to_string(),
                source,
            })?;
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
