//! Exact, read-only authority for adopting an existing linked Git worktree.
//!
//! A renderer may choose a row returned by [`list`], but it never authorizes
//! the checkout by path alone. [`resolve`] re-observes the repository identity,
//! branch, and HEAD before the spawn saga may register an Agent or open a pane.
//! Ownership observations are informational: an explicit exact selection may
//! intentionally host more than one Agent.

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_WORKTREES: usize = 128;
const MAX_GIT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_CHANNELS: usize = 64;
const MAX_REGISTRY_BYTES: u64 = 16 * 1024 * 1024;
const MAX_REGISTRY_AGENTS: usize = 2_048;
const MAX_EXACT_RUNTIME_TARGETS: usize = 2_048;
const MAX_CLAIMS: usize = 256;
const CLAIM_SCHEMA_VERSION: u8 = 1;
const CLAIM_DIRECTORY: &str = "existing-worktree-claims";
const CLAIM_LOCK: &str = ".existing-worktree-claims.lock";

pub use dure_app::GitCheckoutReferenceV1 as ExistingWorktreeRef;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingWorktreeRepository {
    pub canonical_path: String,
    pub git_common_dir: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingWorktreeOwner {
    pub agent_id: String,
    pub provider: String,
    pub channel: String,
    pub runtime_liveness: &'static str,
    pub pane_liveness: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingWorktreeOwnership {
    pub state: &'static str,
    pub owners: Vec<ExistingWorktreeOwner>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_receipt_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingWorktreeCandidate {
    pub reference: ExistingWorktreeRef,
    pub is_main: bool,
    pub ownership: ExistingWorktreeOwnership,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingWorktreeList {
    pub repository: ExistingWorktreeRepository,
    pub worktrees: Vec<ExistingWorktreeCandidate>,
    pub limit: usize,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedExistingWorktreeHandle {
    pub reference: ExistingWorktreeRef,
    pub disposition: &'static str,
    pub claim_id: String,
    pub receipt_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ExistingWorktreeResolution {
    Resolved {
        handle: Box<ResolvedExistingWorktreeHandle>,
    },
    Refused {
        code: &'static str,
        message: String,
        recovery: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ExistingWorktreeRecovery {
    Recovered {
        #[serde(skip_serializing_if = "Option::is_none")]
        claim_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        receipt_id: Option<String>,
        outcome: &'static str,
    },
    Refused {
        code: &'static str,
        message: String,
        recovery: String,
    },
}

impl ExistingWorktreeRecovery {
    fn refused(
        code: &'static str,
        message: impl Into<String>,
        recovery: impl Into<String>,
    ) -> Self {
        Self::Refused {
            code,
            message: message.into(),
            recovery: recovery.into(),
        }
    }
}

impl ExistingWorktreeResolution {
    fn refused(
        code: &'static str,
        message: impl Into<String>,
        recovery: impl Into<String>,
    ) -> Self {
        Self::Refused {
            code,
            message: message.into(),
            recovery: recovery.into(),
        }
    }
}

#[derive(Clone, Debug)]
struct RepositorySnapshot {
    repository: ExistingWorktreeRepository,
    entries: Vec<SnapshotEntry>,
    omitted: usize,
}

#[derive(Clone, Debug)]
struct SnapshotEntry {
    reference: ExistingWorktreeRef,
    is_main: bool,
}

fn git_output(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(repo).args(args);
    crate::gitx::scrub_git_environment(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("Could not start the Git query: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} query failed", args.join(" "))
        } else {
            stderr
        });
    }
    if output.stdout.len() > MAX_GIT_OUTPUT_BYTES {
        return Err("Git worktree query output exceeded the safety limit".to_string());
    }
    Ok(output.stdout)
}

fn git_line(repo: &Path, args: &[&str]) -> Result<String, String> {
    let raw = git_output(repo, args)?;
    let value = std::str::from_utf8(&raw)
        .map_err(|_| "The Git identity path is not valid UTF-8".to_string())?
        .trim();
    if value.is_empty() {
        return Err(format!("git {} returned an empty result", args.join(" ")));
    }
    Ok(value.to_string())
}

fn canonical(path: &Path, label: &str) -> Result<PathBuf, String> {
    std::fs::canonicalize(path)
        .map_err(|error| format!("Could not find or canonicalize {label}: {error}"))
}

fn path_string(path: &Path, label: &str) -> Result<String, String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| format!("The {label} path is not valid UTF-8"))
}

fn resolve_dot_git(worktree: &Path) -> Result<PathBuf, String> {
    let dot_git = worktree.join(".git");
    let metadata = std::fs::symlink_metadata(&dot_git)
        .map_err(|error| format!("Could not read the {} identity: {error}", dot_git.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Rejected a symlink .git identity: {}",
            dot_git.display()
        ));
    }
    if metadata.is_dir() {
        return canonical(&dot_git, "Git directory");
    }
    if !metadata.is_file() || metadata.len() > 16 * 1024 {
        return Err(format!(
            "Invalid linked worktree .git identity: {}",
            dot_git.display()
        ));
    }
    let raw = std::fs::read_to_string(&dot_git)
        .map_err(|error| format!("Could not read the {} identity: {error}", dot_git.display()))?;
    let relative = raw
        .trim()
        .strip_prefix("gitdir: ")
        .ok_or_else(|| format!("Missing gitdir identity in {}", dot_git.display()))?;
    let path = Path::new(relative);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        worktree.join(path)
    };
    canonical(&resolved, "linked worktree Git directory")
}

#[derive(Default)]
struct PorcelainEntry {
    path: Option<String>,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
}

fn parse_worktree_porcelain(raw: &[u8]) -> Result<Vec<PorcelainEntry>, String> {
    let mut entries = Vec::new();
    let mut current = PorcelainEntry::default();
    for field in raw.split(|byte| *byte == 0) {
        if field.is_empty() {
            if current.path.is_some() {
                entries.push(std::mem::take(&mut current));
            }
            continue;
        }
        let field = std::str::from_utf8(field)
            .map_err(|_| "The Git worktree identity is not valid UTF-8".to_string())?;
        if let Some(value) = field.strip_prefix("worktree ") {
            if current.path.is_some() {
                return Err("The Git worktree porcelain record is ambiguous".to_string());
            }
            current.path = Some(value.to_string());
        } else if let Some(value) = field.strip_prefix("HEAD ") {
            current.head = Some(value.to_string());
        } else if let Some(value) = field.strip_prefix("branch refs/heads/") {
            current.branch = Some(value.to_string());
        } else if field == "detached" {
            current.detached = true;
        }
    }
    if current.path.is_some() {
        entries.push(current);
    }
    Ok(entries)
}

fn valid_head(head: &str) -> bool {
    (head.len() == 40 || head.len() == 64) && head.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn repository_snapshot(repo: &str) -> Result<RepositorySnapshot, String> {
    let input = canonical(Path::new(repo), "repository")?;
    if !input.is_dir() {
        return Err("The repository path is not a directory".to_string());
    }
    let top = canonical(
        Path::new(&git_line(&input, &["rev-parse", "--show-toplevel"])?),
        "repository checkout",
    )?;
    let common = canonical(
        Path::new(&git_line(
            &input,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?),
        "Git common directory",
    )?;
    let repository = ExistingWorktreeRepository {
        canonical_path: path_string(&top, "repository")?,
        git_common_dir: path_string(&common, "Git common directory")?,
    };
    let raw = git_output(&input, &["worktree", "list", "--porcelain", "-z"])?;
    let parsed = parse_worktree_porcelain(&raw)?;
    let mut entries = Vec::new();
    let mut omitted = 0;
    for record in parsed {
        let Some(record_path) = record.path else {
            omitted += 1;
            continue;
        };
        let Some(head) = record.head.filter(|value| valid_head(value)) else {
            omitted += 1;
            continue;
        };
        let branch = match (record.branch, record.detached) {
            (Some(branch), false) if !branch.is_empty() => branch,
            (None, true) => "(detached)".to_string(),
            _ => {
                omitted += 1;
                continue;
            }
        };
        let worktree = match canonical(Path::new(&record_path), "linked worktree") {
            Ok(path) => path,
            Err(_) => {
                omitted += 1;
                continue;
            }
        };
        let git_dir = match resolve_dot_git(&worktree) {
            Ok(path) => path,
            Err(_) => {
                omitted += 1;
                continue;
            }
        };
        entries.push(SnapshotEntry {
            reference: ExistingWorktreeRef {
                canonical_path: path_string(&worktree, "linked worktree")?,
                git_common_dir: repository.git_common_dir.clone(),
                git_dir: path_string(&git_dir, "worktree Git directory")?,
                branch,
                head: head.to_ascii_lowercase(),
            },
            is_main: git_dir == common,
        });
    }
    entries.sort_by(|left, right| {
        left.reference
            .canonical_path
            .cmp(&right.reference.canonical_path)
    });
    Ok(RepositorySnapshot {
        repository,
        entries,
        omitted,
    })
}

fn direct_reference(path: &Path) -> Result<ExistingWorktreeRef, String> {
    let canonical_path = canonical(path, "existing worktree")?;
    let common = canonical(
        Path::new(&git_line(
            &canonical_path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?),
        "Git common directory",
    )?;
    let git_dir = canonical(
        Path::new(&git_line(
            &canonical_path,
            &["rev-parse", "--path-format=absolute", "--absolute-git-dir"],
        )?),
        "worktree Git directory",
    )?;
    let head = git_line(&canonical_path, &["rev-parse", "--verify", "HEAD"])?;
    if !valid_head(&head) {
        return Err("Invalid existing worktree HEAD identity".to_string());
    }
    let branch = git_line(&canonical_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    Ok(ExistingWorktreeRef {
        canonical_path: path_string(&canonical_path, "existing worktree")?,
        git_common_dir: path_string(&common, "Git common directory")?,
        git_dir: path_string(&git_dir, "worktree Git directory")?,
        branch: if branch == "HEAD" {
            "(detached)".to_string()
        } else {
            branch
        },
        head: head.to_ascii_lowercase(),
    })
}

fn validate_target(
    repo: &str,
    expected: &ExistingWorktreeRef,
) -> Result<SnapshotEntry, ExistingWorktreeResolution> {
    let target_path = Path::new(&expected.canonical_path);
    if !target_path.is_absolute() {
        return Err(ExistingWorktreeResolution::refused(
            "existing_worktree_invalid_ref",
            "The existing worktree path is not absolute.",
            "Refresh the list and select the item again.",
        ));
    }
    if !target_path.exists() {
        return Err(ExistingWorktreeResolution::refused(
            "existing_worktree_missing",
            format!("The selected worktree does not exist: {}", expected.canonical_path),
            "Recover the Git worktree or refresh the list and select another checkout.",
        ));
    }
    let snapshot = repository_snapshot(repo).map_err(|error| {
        ExistingWorktreeResolution::refused(
            "existing_worktree_repository_unavailable",
            error,
            "Check repository access and Git status, then try again.",
        )
    })?;
    let direct = direct_reference(target_path).map_err(|error| {
        ExistingWorktreeResolution::refused(
            "existing_worktree_not_git",
            error,
            "Verify that this is a Git linked worktree path and refresh the list.",
        )
    })?;
    if direct.git_common_dir != snapshot.repository.git_common_dir {
        return Err(ExistingWorktreeResolution::refused(
            "existing_worktree_foreign_repository",
            format!(
                "The selected checkout belongs to another repository: {}",
                direct.git_common_dir
            ),
            "Select a linked worktree with the same Git common-dir as the current project.",
        ));
    }
    let matches = snapshot
        .entries
        .iter()
        .filter(|entry| entry.reference.canonical_path == direct.canonical_path)
        .collect::<Vec<_>>();
    if matches.is_empty() {
        return Err(ExistingWorktreeResolution::refused(
            "existing_worktree_missing",
            "The path exists but is not in the current repository's linked worktree list.",
            "Repair the state reported by `git worktree list`, then refresh the list.",
        ));
    }
    if matches.len() != 1 {
        return Err(ExistingWorktreeResolution::refused(
            "existing_worktree_ambiguous",
            "Multiple Git worktree identities were observed at the same canonical path.",
            "Manually repair the duplicate Git worktree metadata, then try again.",
        ));
    }
    let entry = (*matches[0]).clone();
    if entry.is_main {
        return Err(ExistingWorktreeResolution::refused(
            "existing_worktree_not_linked",
            "The main checkout cannot be selected as an existing linked worktree.",
            "Select a separate linked worktree or create a new worktree.",
        ));
    }
    if entry.reference != direct || &direct != expected {
        return Err(ExistingWorktreeResolution::refused(
            "existing_worktree_identity_changed",
            format!(
                "The worktree identity changed after selection (current branch={}, HEAD={}).",
                direct.branch, direct.head
            ),
            "Preserve the checkout's current work, refresh the list, and explicitly select it again.",
        ));
    }
    Ok(entry)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryRuntimeBindingWire {
    runtime: String,
    source: String,
    session_id: String,
    #[serde(default)]
    workspace_id: Option<String>,
}

#[derive(Clone, Debug)]
enum RegistryRuntimeBinding {
    ExactHmux {
        source: String,
        session_id: String,
        workspace_id: String,
    },
    Other,
}

impl<'de> Deserialize<'de> for RegistryRuntimeBinding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = RegistryRuntimeBindingWire::deserialize(deserializer)?;
        if !wire.runtime.starts_with("hmux_") {
            return Ok(Self::Other);
        }
        let workspace_id = wire
            .workspace_id
            .filter(|value| !value.is_empty())
            .ok_or_else(|| <D::Error as serde::de::Error>::missing_field("workspaceId"))?;
        Ok(Self::ExactHmux {
            source: wire.source,
            session_id: wire.session_id,
            workspace_id,
        })
    }
}

impl RegistryRuntimeBinding {
    fn local_hmux_target(&self) -> Option<(String, String)> {
        match self {
            Self::ExactHmux {
                source,
                session_id,
                workspace_id,
            } if source == "local" => Some((workspace_id.clone(), session_id.clone())),
            Self::ExactHmux { .. } | Self::Other => None,
        }
    }
}

#[derive(Clone, Debug)]
struct RegistryAgent {
    id: String,
    provider: String,
    worktree: String,
    runtime_binding: Option<RegistryRuntimeBinding>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryAgentWire {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    provider: String,
    worktree: String,
    #[serde(default)]
    runtime_binding: Option<RegistryRuntimeBinding>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryPresentation {
    #[serde(default)]
    complete: bool,
    #[serde(default)]
    spaces: Vec<RegistrySpace>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct RegistrySpace {
    #[serde(default)]
    panes: Vec<RegistryPane>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryPane {
    #[serde(default)]
    agent_id: Option<String>,
}

#[derive(Clone, Debug)]
struct RegistryDocument {
    agents: Vec<RegistryAgent>,
    client_presentation: RegistryPresentation,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryDocumentWire {
    #[serde(default)]
    version: Option<u64>,
    agents: Vec<RegistryAgentWire>,
    #[serde(default)]
    client_presentation: RegistryPresentation,
}

impl<'de> Deserialize<'de> for RegistryDocument {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = RegistryDocumentWire::deserialize(deserializer)?;
        let agents = wire
            .agents
            .into_iter()
            .map(|agent| {
                let id = match agent.id.filter(|value| !value.is_empty()) {
                    Some(id) => id,
                    None if matches!(wire.version, Some(1..=2)) => agent
                        .name
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            <D::Error as serde::de::Error>::missing_field("id")
                        })?,
                    None => {
                        return Err(<D::Error as serde::de::Error>::missing_field("id"));
                    }
                };
                Ok(RegistryAgent {
                    id,
                    provider: agent.provider,
                    worktree: agent.worktree,
                    runtime_binding: agent.runtime_binding,
                })
            })
            .collect::<Result<Vec<_>, D::Error>>()?;
        Ok(Self {
            agents,
            client_presentation: wire.client_presentation,
        })
    }
}

#[derive(Clone, Debug)]
struct RegistrySnapshot {
    channel: String,
    path: PathBuf,
    digest: [u8; 32],
    channel_liveness: Liveness,
    document: RegistryDocument,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppServerDescriptor {
    schema_version: u8,
    api_version: u32,
    port: u16,
    token: String,
    channel: String,
    generation: String,
    process_id: u32,
    started_at_unix_ms: u128,
}

fn app_channel_liveness(app_root: &Path, channel: &str, current_channel: &str) -> Liveness {
    if channel == current_channel {
        return Liveness::Live;
    }
    let path = crate::app_channel::control_dir_for(app_root, channel).join("server.json");
    match std::fs::symlink_metadata(&path) {
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= 32 * 1024 =>
        {}
        _ => return Liveness::Unknown,
    }
    let raw = match std::fs::read(path) {
        Ok(raw) if raw.len() <= 32 * 1024 => raw,
        _ => return Liveness::Unknown,
    };
    let descriptor: AppServerDescriptor = match serde_json::from_slice(&raw) {
        Ok(descriptor) => descriptor,
        Err(_) => return Liveness::Unknown,
    };
    if descriptor.schema_version != 1
        || descriptor.api_version == 0
        || descriptor.port == 0
        || descriptor.token.is_empty()
        || descriptor.channel != channel
        || descriptor.generation.is_empty()
        || descriptor.process_id == 0
        || descriptor.started_at_unix_ms == 0
    {
        return Liveness::Unknown;
    }
    if crate::process_liveness::definitely_dead(descriptor.process_id) {
        Liveness::Dead
    } else {
        // A PID alone cannot prove the server generation; exact live/unknown
        // owners remain fail-closed until their runtime is inspected.
        Liveness::Unknown
    }
}

fn registry_paths(app_root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let mut paths = vec![("stable".to_string(), app_root.join("agents.json"))];
    let channels = app_root.join("channels");
    let metadata = match std::fs::symlink_metadata(&channels) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(paths),
        Err(error) => return Err(format!("Could not read the app channel list: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("The app channel root is a symlink or is not a directory".to_string());
    }
    let mut channels_found = Vec::new();
    for entry in std::fs::read_dir(&channels)
        .map_err(|error| format!("Could not read the app channel list: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Could not read the app channel entry: {error}"))?;
        let metadata = entry
            .path()
            .symlink_metadata()
            .map_err(|error| format!("Could not read the app channel metadata: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Rejected a symlink app channel: {}",
                entry.path().display()
            ));
        }
        if !metadata.is_dir() {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "The app channel name is not valid UTF-8".to_string())?;
        channels_found.push((name, entry.path().join("agents.json")));
    }
    channels_found.sort_by(|left, right| left.0.cmp(&right.0));
    if channels_found.len() > MAX_CHANNELS {
        return Err(format!(
            "App channels exceeded the safety limit ({MAX_CHANNELS}); worktree ownership could not be fully verified"
        ));
    }
    paths.extend(channels_found);
    Ok(paths)
}

fn load_registries(app_root: &Path) -> Result<Vec<RegistrySnapshot>, String> {
    let current_channel =
        crate::app_channel::current_name().map_err(|error| error.to_string())?;
    let mut snapshots = Vec::new();
    for (channel, path) in registry_paths(app_root)? {
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Could not read the {} registry: {error}",
                    path.display()
                ))
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "Rejected an unsafe agent registry: {}",
                path.display()
            ));
        }
        if metadata.len() > MAX_REGISTRY_BYTES {
            return Err(format!(
                "The agent registry exceeded the byte limit: {}",
                path.display()
            ));
        }
        let raw = std::fs::read(&path).map_err(|error| {
            format!("Could not read the {} registry: {error}", path.display())
        })?;
        let document: RegistryDocument = serde_json::from_slice(&raw)
            .map_err(|error| format!("The {} registry is malformed: {error}", path.display()))?;
        if document.agents.len() > MAX_REGISTRY_AGENTS {
            return Err(format!(
                "The agent registry exceeded the agent limit: {}",
                path.display()
            ));
        }
        let digest = Sha256::digest(&raw).into();
        let channel_liveness = app_channel_liveness(app_root, &channel, &current_channel);
        snapshots.push(RegistrySnapshot {
            channel,
            path,
            digest,
            channel_liveness,
            document,
        });
    }
    Ok(snapshots)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Liveness {
    Live,
    Dead,
    Unknown,
}

impl Liveness {
    fn wire(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Dead => "dead",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RuntimeKey {
    session_id: String,
    workspace_id: String,
}

struct OwnershipCensus {
    registries: Vec<RegistrySnapshot>,
    agent_locations_by_worktree: BTreeMap<String, Vec<(usize, usize)>>,
    runtime: HashMap<RuntimeKey, Liveness>,
}

impl OwnershipCensus {
    fn new(registries: Vec<RegistrySnapshot>) -> Self {
        let mut agent_locations_by_worktree = BTreeMap::<String, Vec<(usize, usize)>>::new();
        for (registry_index, registry) in registries.iter().enumerate() {
            for (agent_index, agent) in registry.document.agents.iter().enumerate() {
                let mut paths = BTreeSet::from([agent.worktree.clone()]);
                if Path::new(&agent.worktree).is_absolute() {
                    paths.extend(canonical_agent_worktree(&agent.worktree));
                }
                for path in paths {
                    agent_locations_by_worktree
                        .entry(path)
                        .or_default()
                        .push((registry_index, agent_index));
                }
            }
        }
        Self {
            registries,
            agent_locations_by_worktree,
            runtime: HashMap::new(),
        }
    }

    fn agents_for_worktree<'a>(
        &'a self,
        target: &str,
    ) -> impl Iterator<Item = (&'a RegistrySnapshot, &'a RegistryAgent)> + 'a {
        self.agent_locations_by_worktree
            .get(target)
            .into_iter()
            .flatten()
            .map(move |&(registry_index, agent_index)| {
                let registry = &self.registries[registry_index];
                (registry, &registry.document.agents[agent_index])
            })
    }
}

fn receipt_hmux_target(receipt_id: &str) -> Option<(String, String)> {
    let receipt = crate::spawn::receipt_for_server(receipt_id).ok()?;
    let artifact = receipt
        .get("steps")?
        .as_array()?
        .iter()
        .find(|step| {
            step.get("step").and_then(serde_json::Value::as_str) == Some("runtime_session")
        })?
        .get("artifacts")?
        .as_array()?
        .iter()
        .find(|artifact| {
            artifact.get("kind").and_then(serde_json::Value::as_str) == Some("hmux_session")
        })?;
    Some((
        artifact.get("workspaceId")?.as_str()?.to_string(),
        artifact.get("id")?.as_str()?.to_string(),
    ))
}

fn load_claims(app_root: &Path) -> Result<Vec<WorktreeClaim>, String> {
    let Some(directory) = claim_directory(app_root)? else {
        return Ok(Vec::new());
    };
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(&directory)
        .map_err(|error| format!("Could not read the worktree claim list: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not read the worktree claim entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let metadata = path
            .symlink_metadata()
            .map_err(|error| format!("Could not read the worktree claim metadata: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 32 * 1024 {
            return Err(format!(
                "Rejected an unsafe worktree claim: {}",
                path.display()
            ));
        }
        paths.push(path);
    }
    paths.sort();
    if paths.len() > MAX_CLAIMS {
        return Err(format!(
            "Worktree claims exceeded the safety limit ({MAX_CLAIMS})"
        ));
    }
    paths
        .into_iter()
        .map(|path| {
            let raw = std::fs::read(&path)
                .map_err(|error| format!("Could not read the {} claim: {error}", path.display()))?;
            let claim: WorktreeClaim = serde_json::from_slice(&raw)
                .map_err(|error| format!("The {} claim is malformed: {error}", path.display()))?;
            let expected_file_name = format!("{}.json", claim.claim_id);
            if claim.schema_version != CLAIM_SCHEMA_VERSION
                || claim.claim_id != claim_id(&claim.reference)
                || claim.channel.is_empty()
                || path.file_name().and_then(|value| value.to_str())
                    != Some(expected_file_name.as_str())
            {
                return Err(format!(
                    "Invalid {} claim identity",
                    path.display()
                ));
            }
            Ok(claim)
        })
        .collect()
}

fn runtime_liveness(summary: &crate::hmux::SessionSummary) -> Liveness {
    if summary.lifecycle == "exited"
        || summary.health == "exited"
        || summary.host_process_alive == Some(false)
    {
        Liveness::Dead
    } else if summary.lifecycle == "ready"
        && (summary.health == "current_healthy" || summary.health == "compatible_old_healthy")
    {
        Liveness::Live
    } else {
        Liveness::Unknown
    }
}

fn ownership_census(
    app_root: &Path,
    hmux: &crate::hmux::HmuxManager,
    target_paths: &BTreeSet<String>,
) -> Result<OwnershipCensus, String> {
    let mut census = OwnershipCensus::new(load_registries(app_root)?);
    let mut keys = BTreeSet::new();
    for target in target_paths {
        for (_, agent) in census.agents_for_worktree(target) {
            let Some(binding) = agent.runtime_binding.as_ref() else {
                continue;
            };
            if let Some(target) = binding.local_hmux_target() {
                keys.insert(target);
            }
        }
    }
    for claim in load_claims(app_root)? {
        if target_paths.contains(&claim.reference.canonical_path) {
            if let Some(target) = receipt_hmux_target(&claim.receipt_id) {
                keys.insert(target);
            }
        }
    }
    if keys.len() > MAX_EXACT_RUNTIME_TARGETS {
        return Err(format!(
            "Exact runtime targets exceeded the safety limit ({MAX_EXACT_RUNTIME_TARGETS})"
        ));
    }
    let targets = keys
        .iter()
        .map(
            |(workspace_id, session_id)| crate::hmux::ExactSessionTarget {
                session_id: session_id.clone(),
                workspace_id: workspace_id.clone(),
            },
        )
        .collect::<Vec<_>>();
    let results = if targets.is_empty() {
        Vec::new()
    } else {
        hmux.inspect_sessions_exact(targets)
            .map_err(|error| format!("Could not inspect exact Hmux liveness: {error}"))?
    };
    let mut runtime = HashMap::new();
    for result in results {
        match result {
            crate::hmux::ExactSessionInspectionResult::Found { session, .. } => {
                runtime.insert(
                    RuntimeKey {
                        session_id: session.session_id.clone(),
                        workspace_id: session.workspace_id.clone(),
                    },
                    runtime_liveness(&session),
                );
            }
            crate::hmux::ExactSessionInspectionResult::NotFound {
                session_id,
                workspace_id,
            } => {
                runtime.insert(
                    RuntimeKey {
                        session_id,
                        workspace_id,
                    },
                    Liveness::Dead,
                );
            }
            crate::hmux::ExactSessionInspectionResult::LookupFailed {
                session_id,
                workspace_id,
                ..
            }
            | crate::hmux::ExactSessionInspectionResult::Unprobed {
                session_id,
                workspace_id,
            } => {
                runtime.insert(
                    RuntimeKey {
                        session_id,
                        workspace_id,
                    },
                    Liveness::Unknown,
                );
            }
        }
    }
    census.runtime = runtime;
    Ok(census)
}

fn exact_census(
    app_root: &Path,
    hmux: &crate::hmux::HmuxManager,
    reference: &ExistingWorktreeRef,
) -> Result<OwnershipCensus, String> {
    ownership_census(
        app_root,
        hmux,
        &BTreeSet::from([reference.canonical_path.clone()]),
    )
}

/** Listing projects observed ownership for presentation. Runtime-dependent
 * owners remain unknown until an explicit inspection probes their sessions. */
fn listing_census(app_root: &Path) -> Result<OwnershipCensus, String> {
    Ok(OwnershipCensus::new(load_registries(app_root)?))
}

#[cfg(test)]
std::thread_local! {
    static AGENT_PATH_CANONICALIZATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn canonical_agent_worktree(path: &str) -> Option<String> {
    #[cfg(test)]
    AGENT_PATH_CANONICALIZATIONS.with(|count| count.set(count.get() + 1));
    std::fs::canonicalize(path)
        .ok()
        .and_then(|path| path.to_str().map(str::to_string))
}

fn pane_liveness(registry: &RegistrySnapshot, agent_id: &str) -> Liveness {
    if registry
        .document
        .client_presentation
        .spaces
        .iter()
        .flat_map(|space| &space.panes)
        .any(|pane| pane.agent_id.as_deref() == Some(agent_id))
    {
        registry.channel_liveness
    } else if registry.document.client_presentation.complete {
        Liveness::Dead
    } else {
        Liveness::Unknown
    }
}

fn agent_runtime_liveness(census: &OwnershipCensus, agent: &RegistryAgent) -> Liveness {
    let Some(binding) = agent.runtime_binding.as_ref() else {
        return Liveness::Unknown;
    };
    let Some((workspace_id, session_id)) = binding.local_hmux_target() else {
        return Liveness::Unknown;
    };
    census
        .runtime
        .get(&RuntimeKey {
            session_id,
            workspace_id,
        })
        .copied()
        .unwrap_or(Liveness::Unknown)
}

fn registry_owners(census: &OwnershipCensus, target: &str) -> Vec<ExistingWorktreeOwner> {
    let mut owners = BTreeMap::new();
    for (registry, agent) in census.agents_for_worktree(target) {
        let runtime = agent_runtime_liveness(census, agent);
        let pane = pane_liveness(registry, &agent.id);
        let key = format!("{}\0{}\0{}", registry.channel, agent.id, agent.provider);
        owners.insert(
            key,
            ExistingWorktreeOwner {
                agent_id: agent.id.clone(),
                provider: agent.provider.clone(),
                channel: registry.channel.clone(),
                runtime_liveness: runtime.wire(),
                pane_liveness: pane.wire(),
            },
        );
    }
    owners.into_values().collect()
}

fn owner_is_live(owner: &ExistingWorktreeOwner) -> bool {
    owner.runtime_liveness == "live" || owner.pane_liveness == "live"
}

fn owner_is_stale(owner: &ExistingWorktreeOwner) -> bool {
    owner.runtime_liveness == "dead" && owner.pane_liveness == "dead"
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeClaim {
    schema_version: u8,
    claim_id: String,
    receipt_id: String,
    channel: String,
    reference: ExistingWorktreeRef,
}

fn claim_id(reference: &ExistingWorktreeRef) -> String {
    let mut digest = Sha256::new();
    for value in [
        &reference.git_common_dir,
        &reference.git_dir,
        &reference.canonical_path,
    ] {
        digest.update(value.as_bytes());
        digest.update([0]);
    }
    format!("wtc_{}", crate::hex_lower(&digest.finalize()))
}

fn claim_directory(app_root: &Path) -> Result<Option<PathBuf>, String> {
    let directory = app_root.join(CLAIM_DIRECTORY);
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err("The existing-worktree claim directory is unsafe".to_string())
        }
        Ok(_) => Ok(Some(directory)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not inspect the claim directory: {error}")),
    }
}

fn claim_path(app_root: &Path, reference: &ExistingWorktreeRef) -> PathBuf {
    let id = claim_id(reference);
    app_root.join(CLAIM_DIRECTORY).join(format!("{id}.json"))
}

fn read_claim_for_identity(
    app_root: &Path,
    reference: &ExistingWorktreeRef,
) -> Result<Option<WorktreeClaim>, String> {
    if claim_directory(app_root)?.is_none() {
        return Ok(None);
    }
    let path = claim_path(app_root, reference);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read the worktree claim: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 32 * 1024 {
        return Err("The existing-worktree claim is unsafe or exceeds the byte limit".to_string());
    }
    let raw = std::fs::read(&path)
        .map_err(|error| format!("Could not read the worktree claim: {error}"))?;
    let claim: WorktreeClaim = serde_json::from_slice(&raw)
        .map_err(|error| format!("The worktree claim is malformed: {error}"))?;
    if claim.schema_version != CLAIM_SCHEMA_VERSION
        || claim.claim_id != claim_id(reference)
        || claim.channel.is_empty()
        || claim.reference.canonical_path != reference.canonical_path
        || claim.reference.git_common_dir != reference.git_common_dir
        || claim.reference.git_dir != reference.git_dir
    {
        return Err("The worktree claim identity does not match the selected checkout".to_string());
    }
    Ok(Some(claim))
}

fn claim_lock(app_root: &Path) -> Result<File, String> {
    let path = app_root.join(CLAIM_LOCK);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Could not open the worktree claim lock: {error}"))?;
    file.lock_exclusive()
        .map_err(|error| format!("Could not acquire the worktree claim lock: {error}"))?;
    Ok(file)
}

fn receipt_agent_id(receipt_id: &str) -> Option<String> {
    let receipt = crate::spawn::receipt_for_server(receipt_id).ok()?;
    receipt
        .get("steps")?
        .as_array()?
        .iter()
        .find(|step| step.get("step").and_then(serde_json::Value::as_str) == Some("pane"))?
        .get("artifacts")?
        .as_array()?
        .iter()
        .find(|artifact| {
            artifact.get("kind").and_then(serde_json::Value::as_str) == Some("agent_registration")
        })?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

fn receipt_state(receipt_id: &str) -> Option<String> {
    crate::spawn::receipt_for_server(receipt_id)
        .ok()?
        .get("state")?
        .as_str()
        .map(str::to_string)
}

fn receipt_reference(receipt_id: &str) -> Option<ExistingWorktreeRef> {
    let receipt = crate::spawn::receipt_for_server(receipt_id).ok()?;
    serde_json::from_value(receipt.get("request")?.get("existingWorktreeRef")?.clone()).ok()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ClaimResourceLiveness {
    runtime: Liveness,
    pane: Liveness,
}

fn claim_resource_liveness(
    census: &OwnershipCensus,
    claim: &WorktreeClaim,
) -> ClaimResourceLiveness {
    let agent_id = receipt_agent_id(&claim.receipt_id);
    let runtime = if let Some((workspace_id, session_id)) = receipt_hmux_target(&claim.receipt_id) {
        census
            .runtime
            .get(&RuntimeKey {
                session_id,
                workspace_id,
            })
            .copied()
            .unwrap_or(Liveness::Unknown)
    } else if agent_id.is_none() {
        // The saga journals agent_registration before store/pane mutation. No
        // such artifact means it never crossed the pane/runtime boundary.
        Liveness::Dead
    } else {
        Liveness::Unknown
    };
    let pane = match agent_id.as_deref() {
        None => Liveness::Dead,
        Some(agent_id) => census
            .registries
            .iter()
            .find(|registry| registry.channel == claim.channel)
            .map(|registry| pane_liveness(registry, agent_id))
            .unwrap_or(Liveness::Unknown),
    };
    ClaimResourceLiveness { runtime, pane }
}

fn ownership(
    census: &OwnershipCensus,
    reference: &ExistingWorktreeRef,
    claim: Option<&WorktreeClaim>,
) -> ExistingWorktreeOwnership {
    let owners = registry_owners(census, &reference.canonical_path);
    let claim_receipt_id = claim.map(|claim| claim.receipt_id.clone());
    let state = if !owners.is_empty() {
        if owners.iter().all(owner_is_live) {
            "live_owned"
        } else if owners.iter().all(owner_is_stale) {
            "stale_owned"
        } else {
            "ambiguous"
        }
    } else if let Some(claim) = claim {
        let resources = claim_resource_liveness(census, claim);
        if resources.runtime == Liveness::Live || resources.pane == Liveness::Live {
            "live_owned"
        } else if resources.runtime == Liveness::Unknown || resources.pane == Liveness::Unknown {
            "ambiguous"
        } else if claim.reference != *reference {
            "stale_owned"
        } else {
            match receipt_state(&claim.receipt_id).as_deref() {
                Some("succeeded")
                | Some("failed")
                | Some("compensated")
                | Some("manual_intervention_required") => "stale_owned",
                Some("running") => "reserved",
                _ => "ambiguous",
            }
        }
    } else {
        "unowned"
    };
    ExistingWorktreeOwnership {
        state,
        owners,
        claim_receipt_id,
    }
}

fn unverified_ownership() -> ExistingWorktreeOwnership {
    ExistingWorktreeOwnership {
        state: "ambiguous",
        owners: Vec::new(),
        claim_receipt_id: None,
    }
}

pub fn list(
    repo: &str,
    preferred_path: Option<&str>,
) -> Result<ExistingWorktreeList, String> {
    let snapshot = repository_snapshot(repo)?;
    let mut entries = snapshot
        .entries
        .into_iter()
        .filter(|entry| !entry.is_main)
        .collect::<Vec<_>>();
    let truncated = snapshot.omitted > 0 || entries.len() > MAX_WORKTREES;
    let canonical_preferred = preferred_path
        .and_then(|path| canonical(Path::new(path), "preferred linked worktree").ok())
        .and_then(|path| path_string(&path, "preferred linked worktree").ok());
    if let Some(index) = canonical_preferred.as_ref().and_then(|path| {
        entries
            .iter()
            .position(|entry| &entry.reference.canonical_path == path)
    }) {
        let preferred = entries.remove(index);
        entries.insert(0, preferred);
    }
    entries.truncate(MAX_WORKTREES);
    let observations = crate::app_channel::current().ok().and_then(|channel| {
        listing_census(&channel.app_root)
            .ok()
            .map(|census| (channel.app_root, census))
    });
    let mut worktrees = Vec::new();
    for entry in entries {
        let ownership = match observations.as_ref() {
            Some((app_root, census)) => match read_claim_for_identity(app_root, &entry.reference) {
                Ok(claim) => ownership(census, &entry.reference, claim.as_ref()),
                Err(_) => unverified_ownership(),
            },
            None => unverified_ownership(),
        };
        worktrees.push(ExistingWorktreeCandidate {
            reference: entry.reference,
            is_main: false,
            ownership,
        });
    }
    let result = ExistingWorktreeList {
        repository: snapshot.repository,
        worktrees,
        limit: MAX_WORKTREES,
        truncated,
    };
    Ok(result)
}

fn inspection_error(refusal: ExistingWorktreeResolution) -> String {
    match refusal {
        ExistingWorktreeResolution::Refused {
            code,
            message,
            recovery,
        } => format!("{code}: {message} {recovery}"),
        ExistingWorktreeResolution::Resolved { .. } => {
            "existing worktree inspection returned an invalid resolved handle".to_string()
        }
    }
}

/** Refresh ownership for one renderer-selected exact ref. This is read-only;
 * the spawn boundary separately revalidates the same Git identity. */
pub fn inspect(
    repo: &str,
    expected: ExistingWorktreeRef,
    hmux: &crate::hmux::HmuxManager,
) -> Result<ExistingWorktreeCandidate, String> {
    let entry = validate_target(repo, &expected).map_err(inspection_error)?;
    let channel = crate::app_channel::current().map_err(|error| error.to_string())?;
    let lock = claim_lock(&channel.app_root)?;
    let result = (|| {
        let census = exact_census(&channel.app_root, hmux, &entry.reference)?;
        let claim = read_claim_for_identity(&channel.app_root, &entry.reference)?;
        let ownership = ownership(&census, &entry.reference, claim.as_ref());
        Ok(ExistingWorktreeCandidate {
            reference: entry.reference,
            is_main: false,
            ownership,
        })
    })();
    let _ = FileExt::unlock(&lock);
    result
}

pub fn resolve(
    repo: &str,
    expected: ExistingWorktreeRef,
    receipt_id: &str,
    _hmux: &crate::hmux::HmuxManager,
) -> ExistingWorktreeResolution {
    if receipt_reference(receipt_id).as_ref() != Some(&expected) {
        return ExistingWorktreeResolution::refused(
            "existing_worktree_receipt_mismatch",
            "The selected worktree ref does not match the durable spawn request.",
            "Explicitly select the list item again in a new Create Agent request.",
        );
    }
    match validate_target(repo, &expected) {
        Ok(current) => ExistingWorktreeResolution::Resolved {
            handle: Box::new(ResolvedExistingWorktreeHandle {
                claim_id: claim_id(&current.reference),
                receipt_id: receipt_id.to_string(),
                disposition: "reused",
                reference: current.reference,
            }),
        },
        Err(refusal) => refusal,
    }
}

fn registry_without_agent(raw: &[u8], agent_id: &str) -> Result<String, String> {
    let mut registry: serde_json::Value = serde_json::from_slice(raw)
        .map_err(|error| format!("The stale owner registry is malformed: {error}"))?;
    let version = registry
        .get("version")
        .and_then(serde_json::Value::as_u64);
    let agents = registry
        .get_mut("agents")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| "The stale owner registry is missing its agents array".to_string())?;
    let before = agents.len();
    agents.retain(|agent| {
        let id = agent.get("id").and_then(serde_json::Value::as_str);
        let legacy_name = agent.get("name").and_then(serde_json::Value::as_str);
        id != Some(agent_id) && !(matches!(version, Some(1..=2)) && legacy_name == Some(agent_id))
    });
    if before.saturating_sub(agents.len()) != 1 {
        return Err("The agent identity in the stale owner registry is not unique".to_string());
    }
    if let Some(spaces) = registry
        .get_mut("clientPresentation")
        .and_then(|value| value.get_mut("spaces"))
        .and_then(serde_json::Value::as_array_mut)
    {
        for space in spaces {
            if let Some(panes) = space
                .get_mut("panes")
                .and_then(serde_json::Value::as_array_mut)
            {
                panes.retain(|pane| {
                    pane.get("agentId").and_then(serde_json::Value::as_str) != Some(agent_id)
                });
            }
        }
    }
    serde_json::to_string(&registry)
        .map_err(|error| format!("Could not serialize the stale owner registry: {error}"))
}

fn recover_dead_registry_owner(
    app_root: &Path,
    census: &OwnershipCensus,
    owners: &[ExistingWorktreeOwner],
) -> Result<(), String> {
    let [owner] = owners else {
        return Err("Recovery requires exactly one stale registry owner".to_string());
    };
    if !owner_is_stale(owner) {
        return Err("The registry owner's runtime and pane are not both confirmed dead".to_string());
    }
    let registry = census
        .registries
        .iter()
        .find(|registry| registry.channel == owner.channel)
        .ok_or_else(|| "Could not find the stale owner registry snapshot".to_string())?;
    if registry.channel_liveness != Liveness::Dead {
        return Err("The owning app channel is not confirmed to have exited".to_string());
    }
    let raw = std::fs::read(&registry.path)
        .map_err(|error| format!("Could not read the stale owner registry: {error}"))?;
    if <[u8; 32]>::from(Sha256::digest(&raw)) != registry.digest {
        return Err("The stale owner registry changed after inspection".to_string());
    }
    let replacement = registry_without_agent(&raw, &owner.agent_id)?;
    let expected_digest = registry.digest;
    let registry_path = registry.path.clone();
    let channel = registry.channel.clone();
    let current_channel = crate::app_channel::current_name().map_err(|error| error.to_string())?;
    crate::agent_registry::publish_guarded(&registry_path, &replacement, || {
        let metadata = std::fs::symlink_metadata(&registry_path)
            .map_err(|error| format!("Could not read the stale owner registry metadata: {error}"))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_REGISTRY_BYTES
        {
            return Err("The stale owner registry became unsafe".to_string());
        }
        let current = std::fs::read(&registry_path)
            .map_err(|error| format!("Could not reread the stale owner registry: {error}"))?;
        if <[u8; 32]>::from(Sha256::digest(&current)) != expected_digest {
            return Err("The stale owner registry changed immediately before recovery".to_string());
        }
        if app_channel_liveness(app_root, &channel, &current_channel) != Liveness::Dead {
            return Err("The owning app channel liveness changed immediately before recovery".to_string());
        }
        Ok(())
    })
}

pub fn recover(
    repo: &str,
    reference: ExistingWorktreeRef,
    expected_receipt_id: Option<&str>,
    hmux: &crate::hmux::HmuxManager,
) -> ExistingWorktreeRecovery {
    let channel = match crate::app_channel::current() {
        Ok(channel) => channel,
        Err(error) => {
            return ExistingWorktreeRecovery::refused(
                "existing_worktree_recovery_unavailable",
                error.to_string(),
                "Repair the Dure data directory permissions and try again.",
            );
        }
    };
    let lock = match claim_lock(&channel.app_root) {
        Ok(lock) => lock,
        Err(error) => {
            return ExistingWorktreeRecovery::refused(
                "existing_worktree_recovery_unavailable",
                error,
                "Repair the claim lock permissions and try again.",
            );
        }
    };
    let result = (|| {
        let entry = validate_target(repo, &reference).map_err(|refusal| match refusal {
            ExistingWorktreeResolution::Refused {
                code,
                message,
                recovery,
            } => ExistingWorktreeRecovery::Refused {
                code,
                message,
                recovery,
            },
            ExistingWorktreeResolution::Resolved { .. } => unreachable!(),
        })?;
        let claim =
            read_claim_for_identity(&channel.app_root, &entry.reference).map_err(|error| {
                ExistingWorktreeRecovery::refused(
                    "existing_worktree_claim_unverified",
                    error,
                    "Diagnose the state without manually changing the claim file.",
                )
            })?;
        let census = exact_census(&channel.app_root, hmux, &entry.reference).map_err(|error| {
            ExistingWorktreeRecovery::refused(
                "existing_worktree_recovery_liveness_unverified",
                error,
                "Recover the registry and exact runtime liveness, then try again.",
            )
        })?;
        let owners = registry_owners(&census, &entry.reference.canonical_path);
        let Some(claim) = claim else {
            if owners.is_empty() {
                return Ok((None, None, "already_recovered"));
            }
            if expected_receipt_id.is_some() {
                return Err(ExistingWorktreeRecovery::refused(
                    "existing_worktree_recovery_receipt_changed",
                    "The current worktree has no spawn claim.",
                    "Refresh the list and check the current stale owner again.",
                ));
            }
            recover_dead_registry_owner(&channel.app_root, &census, &owners).map_err(|error| {
                ExistingWorktreeRecovery::refused(
                    "existing_worktree_recovery_owner_not_dead",
                    error,
                    "Stop the live or unknown pane or runtime, then check again.",
                )
            })?;
            return Ok((None, None, "owners_released"));
        };
        if expected_receipt_id != Some(claim.receipt_id.as_str()) {
            return Err(ExistingWorktreeRecovery::refused(
                "existing_worktree_recovery_receipt_changed",
                format!("The current claim owner is {}.", claim.receipt_id),
                "Refresh the list and check the current receipt again.",
            ));
        }
        let state = receipt_state(&claim.receipt_id).unwrap_or_else(|| "missing".to_string());
        if ![
            "succeeded",
            "failed",
            "compensated",
            "manual_intervention_required",
        ]
        .contains(&state.as_str())
        {
            return Err(ExistingWorktreeRecovery::refused(
                "existing_worktree_recovery_receipt_active",
                format!("Spawn receipt {} has state {state}.", claim.receipt_id),
                "Resume and finish the active receipt first. A new request cannot bypass the claim.",
            ));
        }
        if !owners.is_empty() {
            return Err(ExistingWorktreeRecovery::refused(
                "existing_worktree_recovery_owner_present",
                format!("There are still {} registry owners.", owners.len()),
                "First remove stale registrations using closed-agent cleanup in Session Recovery.",
            ));
        }
        let resources = claim_resource_liveness(&census, &claim);
        if resources.runtime != Liveness::Dead || resources.pane != Liveness::Dead {
            return Err(ExistingWorktreeRecovery::refused(
                "existing_worktree_recovery_resources_not_dead",
                format!(
                    "Claim resource liveness: runtime={}, pane={}.",
                    resources.runtime.wire(),
                    resources.pane.wire()
                ),
                "Try again after both the exact runtime and the owning-channel pane are confirmed dead.",
            ));
        }
        let path = claim_path(&channel.app_root, &entry.reference);
        std::fs::remove_file(&path).map_err(|error| {
            ExistingWorktreeRecovery::refused(
                "existing_worktree_recovery_failed",
                format!("Could not remove the claim: {error}"),
                "Repair the claim storage permissions and try again.",
            )
        })?;
        #[cfg(unix)]
        File::open(path.parent().expect("claim has parent"))
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                ExistingWorktreeRecovery::refused(
                    "existing_worktree_recovery_failed",
                    format!("Could not fsync the claim directory: {error}"),
                    "Refresh and check the recovery state.",
                )
            })?;
        Ok((Some(claim.claim_id), Some(claim.receipt_id), "released"))
    })();
    let _ = FileExt::unlock(&lock);
    match result {
        Ok((claim_id, receipt_id, outcome)) => ExistingWorktreeRecovery::Recovered {
            claim_id,
            receipt_id,
            outcome,
        },
        Err(refusal) => refusal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(root: &Path, args: &[&str]) -> String {
        let mut command = Command::new("git");
        command
            .args(["-c", "commit.gpgsign=false"])
            .arg("-C")
            .arg(root)
            .args(args);
        crate::gitx::scrub_git_environment(&mut command);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-b", "main"]);
        git(
            root.path(),
            &["config", "user.name", "Existing Worktree Test"],
        );
        git(
            root.path(),
            &["config", "user.email", "existing-worktree@example.invalid"],
        );
        std::fs::write(root.path().join("tracked.txt"), "base\n").unwrap();
        git(root.path(), &["add", "tracked.txt"]);
        git(root.path(), &["commit", "-m", "base"]);
        let linked = root.path().join("linked");
        git(
            root.path(),
            &[
                "worktree",
                "add",
                "-b",
                "agent/existing",
                linked.to_str().unwrap(),
                "HEAD",
            ],
        );
        (root, linked)
    }

    fn refusal_code(result: Result<SnapshotEntry, ExistingWorktreeResolution>) -> &'static str {
        match result.unwrap_err() {
            ExistingWorktreeResolution::Refused { code, .. } => code,
            ExistingWorktreeResolution::Resolved { .. } => unreachable!(),
        }
    }

    #[test]
    fn exact_listing_preserves_head_branch_index_and_all_wip() {
        let (root, linked) = fixture();
        std::fs::write(linked.join("staged.txt"), "staged\n").unwrap();
        git(&linked, &["add", "staged.txt"]);
        std::fs::write(linked.join("tracked.txt"), "unstaged\n").unwrap();
        std::fs::write(linked.join("untracked.txt"), "untracked\n").unwrap();

        let before_head = git(&linked, &["rev-parse", "HEAD"]);
        let before_branch = git(&linked, &["symbolic-ref", "--short", "HEAD"]);
        let before_status = git(&linked, &["status", "--porcelain=v1", "-uall"]);
        let before_index = std::fs::read(resolve_dot_git(&linked).unwrap().join("index")).unwrap();
        let before_tracked = std::fs::read(linked.join("tracked.txt")).unwrap();
        let before_untracked = std::fs::read(linked.join("untracked.txt")).unwrap();

        let snapshot = repository_snapshot(root.path().to_str().unwrap()).unwrap();
        let canonical_linked = std::fs::canonicalize(&linked).unwrap();
        let selected = snapshot
            .entries
            .iter()
            .find(|entry| entry.reference.canonical_path == canonical_linked.to_string_lossy())
            .unwrap();
        assert_eq!(direct_reference(&linked).unwrap(), selected.reference);

        assert_eq!(git(&linked, &["rev-parse", "HEAD"]), before_head);
        assert_eq!(
            git(&linked, &["symbolic-ref", "--short", "HEAD"]),
            before_branch
        );
        assert_eq!(
            git(&linked, &["status", "--porcelain=v1", "-uall"]),
            before_status
        );
        assert_eq!(
            std::fs::read(resolve_dot_git(&linked).unwrap().join("index")).unwrap(),
            before_index
        );
        assert_eq!(
            std::fs::read(linked.join("tracked.txt")).unwrap(),
            before_tracked
        );
        assert_eq!(
            std::fs::read(linked.join("untracked.txt")).unwrap(),
            before_untracked
        );
    }

    #[test]
    fn missing_foreign_and_changed_identity_fail_closed() {
        let (root, linked) = fixture();
        let expected = direct_reference(&linked).unwrap();

        let mut missing = expected.clone();
        missing.canonical_path = linked.join("missing").to_string_lossy().into_owned();
        assert_eq!(
            refusal_code(validate_target(root.path().to_str().unwrap(), &missing)),
            "existing_worktree_missing"
        );

        let (foreign_root, foreign_linked) = fixture();
        let foreign = direct_reference(&foreign_linked).unwrap();
        assert_eq!(
            refusal_code(validate_target(root.path().to_str().unwrap(), &foreign)),
            "existing_worktree_foreign_repository"
        );
        drop(foreign_root);

        git(
            &linked,
            &["commit", "--allow-empty", "-m", "identity changed"],
        );
        assert_eq!(
            refusal_code(validate_target(root.path().to_str().unwrap(), &expected)),
            "existing_worktree_identity_changed"
        );
    }

    #[test]
    fn legacy_registry_bindings_without_workspace_id_do_not_abort_census() {
        let app_root = tempfile::tempdir().unwrap();
        let registry_path = app_root.path().join("agents.json");
        let legacy_registry = serde_json::json!({
            "agents": [
                {
                    "id": "legacy-local",
                    "provider": "codex",
                    "worktree": "/repo/.worktrees/legacy-local",
                    "runtimeBinding": {
                        "runtime": "legacy_session_v1",
                        "source": "local",
                        "sessionId": "legacy-local-session"
                    }
                },
                {
                    "id": "legacy-ssh",
                    "provider": "claude",
                    "worktree": "/remote/repo/.worktrees/legacy-ssh",
                    "runtimeBinding": {
                        "runtime": "legacy_ssh_session_v1",
                        "source": "ssh",
                        "sessionId": "legacy-ssh-session"
                    }
                }
            ],
            "clientPresentation": { "complete": true, "spaces": [] }
        });
        std::fs::write(
            &registry_path,
            serde_json::to_vec(&legacy_registry).unwrap(),
        )
        .unwrap();

        let legacy_result = load_registries(app_root.path());
        assert!(
            legacy_result.is_ok(),
            "legacy bindings must not abort ownership census: {:?}",
            legacy_result.err()
        );

        let malformed_hmux_registry = serde_json::json!({
            "agents": [{
                "id": "hmux-without-workspace",
                "provider": "codex",
                "worktree": "/repo/.worktrees/hmux",
                "runtimeBinding": {
                    "runtime": "hmux_managed_v1",
                    "source": "local",
                    "sessionId": "hmux-session"
                }
            }]
        });
        std::fs::write(
            &registry_path,
            serde_json::to_vec(&malformed_hmux_registry).unwrap(),
        )
        .unwrap();

        let error = load_registries(app_root.path()).unwrap_err();
        assert!(error.contains("workspaceId"), "unexpected error: {error}");
    }

    #[test]
    fn pre_id_v2_registry_uses_its_immutable_name_as_owner_identity() {
        let app_root = tempfile::tempdir().unwrap();
        let registry_path = app_root.path().join("agents.json");
        let historical_registry = serde_json::json!({
            "version": 2,
            "agents": [{
                "name": "legacy-managed-agent",
                "provider": "codex",
                "worktree": "/repo/.worktrees/legacy-managed",
                "sessionId": "legacy-managed-session",
                "runtimeBinding": {
                    "runtime": "hmux_managed_v1",
                    "source": "local",
                    "sessionId": "legacy-managed-session",
                    "workspaceId": "legacy-managed-workspace"
                }
            }]
        });
        std::fs::write(
            &registry_path,
            serde_json::to_vec(&historical_registry).unwrap(),
        )
        .unwrap();

        let registries = load_registries(app_root.path()).unwrap();
        assert_eq!(registries[0].document.agents[0].id, "legacy-managed-agent");

        let malformed_current_registry = serde_json::json!({
            "version": 3,
            "agents": [{
                "name": "current-agent",
                "displayName": "Current Agent",
                "provider": "codex",
                "worktree": "/repo/.worktrees/current",
                "runtimeBinding": {
                    "runtime": "hmux_managed_v1",
                    "source": "local",
                    "sessionId": "current-session",
                    "workspaceId": "current-workspace"
                }
            }]
        });
        std::fs::write(
            &registry_path,
            serde_json::to_vec(&malformed_current_registry).unwrap(),
        )
        .unwrap();

        let error = load_registries(app_root.path()).unwrap_err();
        assert!(error.contains("id"), "unexpected error: {error}");
    }

    fn registry_agent(id: &str, provider: &str, path: &str, managed: bool) -> RegistryAgent {
        RegistryAgent {
            id: id.to_string(),
            provider: provider.to_string(),
            worktree: path.to_string(),
            runtime_binding: managed.then(|| RegistryRuntimeBinding::ExactHmux {
                source: "local".to_string(),
                session_id: format!("session-{id}"),
                workspace_id: format!("workspace-{id}"),
            }),
        }
    }

    fn census(agents: Vec<RegistryAgent>, pane_agent_ids: &[&str]) -> OwnershipCensus {
        OwnershipCensus::new(vec![RegistrySnapshot {
            channel: "stable".to_string(),
            path: PathBuf::from("/registry/stable/agents.json"),
            digest: [0; 32],
            channel_liveness: Liveness::Live,
            document: RegistryDocument {
                agents,
                client_presentation: RegistryPresentation {
                    complete: true,
                    spaces: vec![RegistrySpace {
                        panes: pane_agent_ids
                            .iter()
                            .map(|id| RegistryPane {
                                agent_id: Some((*id).to_string()),
                            })
                            .collect(),
                    }],
                },
            },
        }])
    }

    #[test]
    fn provider_independent_ownership_supports_shared_live_worktrees() {
        let reference = ExistingWorktreeRef {
            canonical_path: "/repo/.worktrees/shared".to_string(),
            git_common_dir: "/repo/.git".to_string(),
            git_dir: "/repo/.git/worktrees/shared".to_string(),
            branch: "agent/shared".to_string(),
            head: "0123456789abcdef0123456789abcdef01234567".to_string(),
        };

        let live = census(
            vec![registry_agent(
                "agent-codex",
                "codex",
                &reference.canonical_path,
                false,
            )],
            &["agent-codex"],
        );
        assert_eq!(
            ownership(&live, &reference, None).state,
            "live_owned"
        );

        let shared = census(
            vec![
                registry_agent("agent-codex", "codex", &reference.canonical_path, false),
                registry_agent("agent-claude", "claude", &reference.canonical_path, false),
            ],
            &["agent-codex", "agent-claude"],
        );
        assert_eq!(
            ownership(&shared, &reference, None).state,
            "live_owned"
        );

        let stale_agent = registry_agent("agent-stale", "claude", &reference.canonical_path, true);
        let key = RuntimeKey {
            session_id: "session-agent-stale".to_string(),
            workspace_id: "workspace-agent-stale".to_string(),
        };
        let mut stale = census(vec![stale_agent], &[]);
        stale.runtime.insert(key, Liveness::Dead);
        assert_eq!(
            ownership(&stale, &reference, None).state,
            "stale_owned"
        );

        let uncertain = census(
            vec![registry_agent(
                "agent-unknown",
                "codex",
                &reference.canonical_path,
                true,
            )],
            &[],
        );
        assert_eq!(
            ownership(&uncertain, &reference, None).state,
            "ambiguous"
        );
    }

    #[test]
    fn listing_census_keeps_unprobed_managed_runtime_fail_closed() {
        let app_root = tempfile::tempdir().unwrap();
        let registry = serde_json::json!({
            "version": 3,
            "agents": [{
                "id": "managed-owner",
                "provider": "claude",
                "worktree": "/repo/.worktrees/owned",
                "runtimeBinding": {
                    "runtime": "hmux_managed_v1",
                    "source": "local",
                    "sessionId": "session-managed-owner",
                    "workspaceId": "workspace-managed-owner"
                }
            }],
            "clientPresentation": { "complete": true, "spaces": [] }
        });
        std::fs::write(
            app_root.path().join("agents.json"),
            serde_json::to_vec(&registry).unwrap(),
        )
        .unwrap();

        let census = listing_census(app_root.path()).unwrap();
        let owner = &census.registries[0].document.agents[0];
        assert_eq!(agent_runtime_liveness(&census, owner), Liveness::Unknown);
        assert!(census.runtime.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn persisted_pane_from_a_dead_app_channel_is_not_live() {
        let app_root = tempfile::tempdir().unwrap();
        let channel = app_root.path().join("channels/dev-retired");
        std::fs::create_dir_all(&channel).unwrap();
        let mut process = Command::new("sh").args(["-c", "exit 0"]).spawn().unwrap();
        let process_id = process.id();
        process.wait().unwrap();
        std::fs::write(
            channel.join("server.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "apiVersion": 1,
                "port": 6767,
                "token": "owner-only-test-token",
                "channel": "dev-retired",
                "generation": "dead-generation",
                "processId": process_id,
                "startedAtUnixMs": 1
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            channel.join("agents.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 3,
                "agents": [
                    {
                        "id": "agent-stale",
                        "provider": "codex",
                        "worktree": "/repo/.worktrees/stale",
                        "runtimeBinding": {
                            "runtime": "hmux_managed_v1",
                            "source": "local",
                            "sessionId": "session-agent-stale",
                            "workspaceId": "workspace-agent-stale"
                        }
                    },
                    {
                        "id": "agent-other",
                        "provider": "claude",
                        "worktree": "/repo/.worktrees/other"
                    }
                ],
                "clientPresentation": {
                    "complete": true,
                    "spaces": [{
                        "panes": [
                            { "agentId": "agent-stale" },
                            { "agentId": "agent-other" }
                        ]
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let mut census = OwnershipCensus::new(load_registries(app_root.path()).unwrap());
        let registry = census
            .registries
            .iter()
            .find(|registry| registry.channel == "dev-retired")
            .unwrap();
        assert_eq!(pane_liveness(registry, "agent-stale"), Liveness::Dead);
        census.runtime.insert(
            RuntimeKey {
                session_id: "session-agent-stale".to_string(),
                workspace_id: "workspace-agent-stale".to_string(),
            },
            Liveness::Dead,
        );
        let reference = ExistingWorktreeRef {
            canonical_path: "/repo/.worktrees/stale".to_string(),
            git_common_dir: "/repo/.git".to_string(),
            git_dir: "/repo/.git/worktrees/stale".to_string(),
            branch: "agent/stale".to_string(),
            head: "0123456789abcdef0123456789abcdef01234567".to_string(),
        };
        let owners = registry_owners(&census, &reference.canonical_path);
        assert_eq!(ownership(&census, &reference, None).state, "stale_owned");

        let registry_path = channel.join("agents.json");
        let original = std::fs::read(&registry_path).unwrap();
        let mut changed = original.clone();
        changed.push(b'\n');
        std::fs::write(&registry_path, &changed).unwrap();
        assert!(recover_dead_registry_owner(app_root.path(), &census, &owners).is_err());
        assert_eq!(std::fs::read(&registry_path).unwrap(), changed);
        std::fs::write(&registry_path, original).unwrap();

        recover_dead_registry_owner(app_root.path(), &census, &owners).unwrap();

        let recovered: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&registry_path).unwrap()).unwrap();
        assert_eq!(recovered["agents"][0]["id"], "agent-other");
        assert_eq!(recovered["agents"].as_array().unwrap().len(), 1);
        assert_eq!(
            recovered["clientPresentation"]["spaces"][0]["panes"][0]["agentId"],
            "agent-other"
        );
        assert_eq!(
            recovered["clientPresentation"]["spaces"][0]["panes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn listing_owner_lookup_canonicalizes_each_registry_path_once() {
        const COUNT: usize = 128;
        AGENT_PATH_CANONICALIZATIONS.with(|count| count.set(0));
        let agents = (0..COUNT)
            .map(|index| {
                registry_agent(
                    &format!("agent-{index}"),
                    "codex",
                    &format!("/repo/.worktrees/owner-{index}"),
                    false,
                )
            })
            .collect();
        let census = census(agents, &[]);
        for index in 0..COUNT {
            let reference = ExistingWorktreeRef {
                canonical_path: format!("/repo/.worktrees/candidate-{index}"),
                git_common_dir: "/repo/.git".to_string(),
                git_dir: format!("/repo/.git/worktrees/candidate-{index}"),
                branch: format!("agent/candidate-{index}"),
                head: "0123456789abcdef0123456789abcdef01234567".to_string(),
            };
            let _ = ownership(&census, &reference, None);
        }
        let canonicalizations = AGENT_PATH_CANONICALIZATIONS.with(std::cell::Cell::get);
        assert!(
            canonicalizations <= COUNT,
            "list ownership lookup canonicalized {canonicalizations} agent paths for {COUNT} registry entries"
        );
    }
}
