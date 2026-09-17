#![cfg(unix)]

//! Native credential-only provider profiles.
//!
//! Reviewed state is projected from the canonical provider home while auth
//! remains private to each profile. See the credential-only switching design.

pub mod transcript;
mod claude_shared_state;
#[cfg(test)]
mod codex_config_tests;
mod overlay_topology;
#[cfg(test)]
mod refresh_tests;

mod app_home {
    pub const DIR_NAME: &str = ".dure";
    #[cfg(not(windows))]
    pub const LEGACY_DIR_NAME: &str = ".hebbian";
}

use dure_app::provider_credential_environment_policy_v1;
use fs2::FileExt;
use hmux_runtime_contract::ProviderStateEnvironment;
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const CODEX_SHARED_DIRECTORIES: &[&str] = &[
    "attachments",
    "memories",
    "plugins",
    "rules",
    "sessions",
    "shell_snapshots",
    "skills",
    "vendor_imports",
];
const CODEX_SHARED_TOOLING_DIRECTORIES: &[&str] = &["packages/standalone"];
const CODEX_APPEND_FILES: &[&str] = &["history.jsonl", "session_index.jsonl"];
const CODEX_SPAWN_SYNC_FILES: &[&str] = &[
    ".codex-global-state.json",
    ".personality_migration",
    ".sandbox_migration",
    "config.toml",
    "hooks.json",
    "installation_id",
    "models_cache.json",
    "version.json",
];
const CLAUDE_SHARED_DIRECTORIES: &[&str] = &[
    "agents",
    "commands",
    "file-history",
    "hooks",
    "output-styles",
    "plans",
    "plugins",
    "projects",
    "rules",
    "session-env",
    "sessions",
    "shell-snapshots",
    "skills",
    "tasks",
];
const CLAUDE_APPEND_FILES: &[&str] = &["history.jsonl"];
const CLAUDE_SPAWN_SYNC_FILES: &[&str] = &["CLAUDE.md", "settings.json", "settings.local.json"];

pub struct OverlayPolicy {
    pub canonical_directory_name: &'static str,
    pub credential_file_name: &'static str,
    pub credential_label: &'static str,
    pub shared_directories: &'static [&'static str],
    pub shared_tooling_directories: &'static [&'static str],
    pub append_files: &'static [&'static str],
    pub spawn_sync_files: &'static [&'static str],
}

pub struct PreparedProviderProfileLaunch {
    directory: PathBuf,
    directory_device: u64,
    directory_inode: u64,
    environment: ProviderStateEnvironment,
}

impl PreparedProviderProfileLaunch {
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn directory_device(&self) -> u64 {
        self.directory_device
    }

    pub fn directory_inode(&self) -> u64 {
        self.directory_inode
    }

    pub fn into_environment(self) -> ProviderStateEnvironment {
        self.environment
    }
}

const CODEX_OVERLAY_POLICY: OverlayPolicy = OverlayPolicy {
    canonical_directory_name: ".codex",
    credential_file_name: "auth.json",
    credential_label: "Codex",
    shared_directories: CODEX_SHARED_DIRECTORIES,
    shared_tooling_directories: CODEX_SHARED_TOOLING_DIRECTORIES,
    append_files: CODEX_APPEND_FILES,
    spawn_sync_files: CODEX_SPAWN_SYNC_FILES,
};
const CLAUDE_OVERLAY_POLICY: OverlayPolicy = OverlayPolicy {
    canonical_directory_name: ".claude",
    credential_file_name: ".credentials.json",
    credential_label: "Claude",
    shared_directories: CLAUDE_SHARED_DIRECTORIES,
    shared_tooling_directories: &[],
    append_files: CLAUDE_APPEND_FILES,
    spawn_sync_files: CLAUDE_SPAWN_SYNC_FILES,
};
static OVERLAY_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const MAX_TRANSFER_CREDENTIAL_BYTES: u64 = 4 * 1024 * 1024;

pub fn reviewed_overlay_policy(provider: &str) -> Result<&'static OverlayPolicy, String> {
    match provider {
        "codex" => Ok(&CODEX_OVERLAY_POLICY),
        "claude" => Ok(&CLAUDE_OVERLAY_POLICY),
        _ => Err(typed_error(
            "remote_credential_overlay_unsupported",
            format!("{provider} has no reviewed remote overlay policy"),
        )),
    }
}

/// Read the single reviewed credential artifact for an outbound transfer.
///
/// The renderer never chooses a filename and never receives these bytes. The
/// local overlay is prepared first so its ordinary trust checks and permission
/// hardening run at the same boundary as a process launch.
pub fn read_profile_credential(
    provider: &str,
    home: &str,
    account_dir: &str,
) -> Result<(String, Vec<u8>), String> {
    read_profile_credential_with_codex_notify(provider, home, account_dir, None)
}

pub fn read_profile_credential_with_codex_notify(
    provider: &str,
    home: &str,
    account_dir: &str,
    codex_notify_command: Option<&str>,
) -> Result<(String, Vec<u8>), String> {
    ensure_overlay_with_codex_notify(provider, home, account_dir, codex_notify_command)?;
    let policy = reviewed_overlay_policy(provider)?;
    let account_directory = resolve_account_directory(
        provider,
        home,
        Some("remote-credential-transfer"),
        Some(account_dir),
    )?
    .ok_or_else(|| typed_error("credential_reference_required", "profile is required"))?;
    let credential_path = account_directory.join(policy.credential_file_name);
    let credential = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&credential_path)
        .map_err(|error| {
            typed_error(
                "credential_transfer_unavailable",
                format!("open {} credential: {error}", policy.credential_label),
            )
        })?;
    let metadata = credential.metadata().map_err(|error| {
        typed_error(
            "credential_file_untrusted",
            format!("inspect {} credential: {error}", policy.credential_label),
        )
    })?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0
    {
        return Err(typed_error(
            "credential_file_untrusted",
            format!(
                "{} credential must be an owner-only, single-link regular file",
                policy.credential_label
            ),
        ));
    }
    if metadata.len() > MAX_TRANSFER_CREDENTIAL_BYTES {
        return Err(typed_error(
            "credential_transfer_too_large",
            format!(
                "{} credential exceeds the {} byte transfer limit",
                policy.credential_label, MAX_TRANSFER_CREDENTIAL_BYTES
            ),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    credential
        .take(MAX_TRANSFER_CREDENTIAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            typed_error(
                "credential_transfer_unavailable",
                format!("read {} credential: {error}", policy.credential_label),
            )
        })?;
    if bytes.len() as u64 > MAX_TRANSFER_CREDENTIAL_BYTES {
        return Err(typed_error(
            "credential_transfer_too_large",
            format!(
                "{} credential exceeds the {} byte transfer limit",
                policy.credential_label, MAX_TRANSFER_CREDENTIAL_BYTES
            ),
        ));
    }
    Ok((policy.credential_file_name.to_string(), bytes))
}

fn typed_error(code: &str, message: impl AsRef<str>) -> String {
    format!("{code}: {}", message.as_ref())
}

fn require_owned_real_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        typed_error(
            "credential_directory_untrusted",
            format!("{label}: {error}"),
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(typed_error(
            "credential_directory_untrusted",
            format!("{label} must be a real directory"),
        ));
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(typed_error(
            "credential_directory_untrusted",
            format!("{label} must be owned by the current user"),
        ));
    }
    std::fs::canonicalize(path).map_err(|error| {
        typed_error(
            "credential_directory_untrusted",
            format!("{label}: {error}"),
        )
    })
}

fn create_or_require_owned_directory(
    path: &Path,
    label: &str,
    mode: u32,
) -> Result<PathBuf, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(typed_error(
                        "credential_directory_create_failed",
                        format!("{label}: {error}"),
                    ));
                }
            }
        }
        Err(error) => {
            return Err(typed_error(
                "credential_directory_untrusted",
                format!("{label}: {error}"),
            ));
        }
    }
    let canonical = require_owned_real_directory(path, label)?;
    std::fs::set_permissions(&canonical, std::fs::Permissions::from_mode(mode)).map_err(
        |error| {
            typed_error(
                "credential_directory_create_failed",
                format!("secure {label}: {error}"),
            )
        },
    )?;
    Ok(canonical)
}

fn validate_legacy_app_root_alias(home: &Path) -> Result<Option<PathBuf>, String> {
    let alias = home.join(crate::app_home::LEGACY_DIR_NAME);
    let metadata = match std::fs::symlink_metadata(&alias) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(typed_error(
                "credential_directory_untrusted",
                format!("legacy app root: {error}"),
            ));
        }
    };
    if !metadata.file_type().is_symlink() {
        return Err(typed_error(
            "credential_directory_untrusted",
            "legacy app root must be migrated to .dure",
        ));
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(typed_error(
            "credential_directory_untrusted",
            "legacy app root alias must be owned by the current user",
        ));
    }
    let target = std::fs::read_link(&alias).map_err(|error| {
        typed_error(
            "credential_directory_untrusted",
            format!("inspect legacy app root alias: {error}"),
        )
    })?;
    let direct_relative = target == Path::new(crate::app_home::DIR_NAME);
    let direct_absolute = target == home.join(crate::app_home::DIR_NAME)
        || (target.is_absolute()
            && std::fs::canonicalize(&target)
                .ok()
                .zip(std::fs::canonicalize(home.join(crate::app_home::DIR_NAME)).ok())
                .is_some_and(|(target, root)| target == root));
    if !direct_relative && !direct_absolute {
        return Err(typed_error(
            "credential_directory_untrusted",
            "legacy app root alias must point directly to the home .dure directory",
        ));
    }
    Ok(Some(alias))
}

fn credential_app_root(home: &Path, create: bool) -> Result<PathBuf, String> {
    // Validate the legacy entry before creating anything. An unrelated symlink
    // must not turn a rejected request into a partial migration.
    let legacy_alias = validate_legacy_app_root_alias(home)?;
    let root_path = home.join(crate::app_home::DIR_NAME);
    let root = if create {
        create_or_require_owned_directory(&root_path, "Dure root", 0o700)?
    } else {
        require_owned_real_directory(&root_path, "Dure root")?
    };
    if let Some(alias) = legacy_alias {
        let alias_target = std::fs::canonicalize(&alias).map_err(|error| {
            typed_error(
                "credential_directory_untrusted",
                format!("resolve legacy app root alias: {error}"),
            )
        })?;
        if alias_target != root {
            return Err(typed_error(
                "credential_directory_untrusted",
                "legacy app root alias must resolve to the Dure root",
            ));
        }
    }
    Ok(root)
}

pub fn create_account_profile_directory(
    provider: &str,
    home: &str,
    name: &str,
) -> Result<PathBuf, String> {
    let platform_home = Path::new(home);
    let app_root = credential_app_root(platform_home, true)?;
    create_account_profile_directory_at_app_root(provider, &app_root, platform_home, name)
}

pub fn create_account_profile_directory_at_app_root(
    provider: &str,
    app_root: &Path,
    platform_home: &Path,
    name: &str,
) -> Result<PathBuf, String> {
    if !matches!(provider, "codex" | "claude" | "kimi") {
        return Err(typed_error(
            "credential_alias_unsupported",
            "provider has no reviewed per-process credential root",
        ));
    }
    let safe: String = name
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect();
    if safe.is_empty() {
        return Err("The name is empty".to_string());
    }
    let dure = create_or_require_owned_directory(app_root, "Dure root", 0o700)?;
    let account_root =
        create_or_require_owned_directory(&dure.join("accounts"), "account root", 0o700)?;
    let account_directory = create_or_require_owned_directory(
        &account_root.join(format!("{provider}-{safe}")),
        "profile directory",
        0o700,
    )?;
    match provider {
        "codex" => {
            create_or_require_owned_directory(
                &platform_home.join(".codex"),
                "canonical provider state",
                0o700,
            )?;
            prepare_codex_overlay(platform_home, &account_directory, None, None)?;
        }
        "claude" => {
            create_or_require_owned_directory(
                &platform_home.join(".claude"),
                "canonical provider state",
                0o700,
            )?;
            prepare_claude_overlay(platform_home, &account_directory, None)?;
        }
        _ => {}
    }
    Ok(account_directory)
}

fn resolve_account_directory(
    provider: &str,
    home: &str,
    credential_id: Option<&str>,
    credential_directory: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let (_credential_id, credential_directory) = match (credential_id, credential_directory) {
        (None, None) => return Ok(None),
        (Some(_), None) => {
            return Err(typed_error(
                "credential_directory_required",
                "credential reference requires its profile directory",
            ));
        }
        (None, Some(_)) => {
            return Err(typed_error(
                "credential_reference_required",
                "credential directory requires a non-secret reference",
            ));
        }
        (Some(credential_id), Some(credential_directory)) => (credential_id, credential_directory),
    };
    if _credential_id.is_empty() {
        return Err("credential id must not be empty".to_string());
    }

    let home = Path::new(home);
    let account_root_path = credential_app_root(home, false)?.join("accounts");
    let account_root = require_owned_real_directory(&account_root_path, "account root")?;
    let account_directory =
        require_owned_real_directory(Path::new(credential_directory), "profile directory")?;
    let expected_prefix = format!("{provider}-");
    let trusted = account_directory.parent() == Some(account_root.as_path())
        && account_directory
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&expected_prefix));
    if !trusted {
        return Err(typed_error(
            "credential_directory_untrusted",
            "profile is outside the provider account root",
        ));
    }
    Ok(Some(account_directory))
}

/// Read-only consumers that operate on one registered credential profile use
/// the same trust boundary as managed launches. Keeping this wrapper here
/// prevents usage probes from accepting an arbitrary renderer-supplied path.
pub fn resolve_account_profile_directory(
    provider: &str,
    home: &str,
    credential_id: &str,
    credential_directory: &str,
) -> Result<PathBuf, String> {
    resolve_account_directory(
        provider,
        home,
        Some(credential_id),
        Some(credential_directory),
    )?
    .ok_or_else(|| typed_error("credential_reference_required", "profile is required"))
}

/// The thin credential homes share only Codex's canonical SQLite state. Usage
/// probes must validate that root just like managed launches do before export.
pub fn resolve_codex_canonical_state_directory(home: &str) -> Result<PathBuf, String> {
    require_owned_real_directory(
        &PathBuf::from(home).join(".codex"),
        "canonical provider state",
    )
}

/// Resolve a non-secret account reference into the private, per-process state
/// roots carried to a new managed Host. The renderer supplies the profile path
/// from its account registry; this boundary verifies that it is a real
/// directory owned by Dure's account root before accepting it.
pub fn managed_provider_state_environment(
    provider: &str,
    home: &str,
    credential_id: Option<&str>,
    credential_directory: Option<&str>,
) -> Result<ProviderStateEnvironment, String> {
    let Some(account_directory) =
        resolve_account_directory(provider, home, credential_id, credential_directory)?
    else {
        return provider_default_state_environment(provider);
    };
    provider_state_environment(provider, home, account_directory)
}

pub fn provider_default_state_environment(
    provider: &str,
) -> Result<ProviderStateEnvironment, String> {
    let Some(policy) = provider_credential_environment_policy_v1(provider) else {
        return Ok(ProviderStateEnvironment::default());
    };
    let removals = policy
        .state_roots()
        .iter()
        .map(ToString::to_string)
        .collect();
    ProviderStateEnvironment::from_mutations(BTreeMap::new(), removals)
        .map_err(|error| error.to_string())
}

fn provider_state_environment(
    provider: &str,
    home: &str,
    account_directory: PathBuf,
) -> Result<ProviderStateEnvironment, String> {
    let policy = provider_credential_environment_policy_v1(provider).ok_or_else(|| {
        format!("credential_alias_unsupported: {provider} has no reviewed per-process state root")
    })?;
    let account_directory = account_directory.to_string_lossy().into_owned();
    let mut values = BTreeMap::new();
    if provider == "codex" {
        values.insert(policy.state_roots()[0].to_string(), account_directory);
        let canonical = require_owned_real_directory(
            &PathBuf::from(home).join(".codex"),
            "canonical provider state",
        )?;
        values.insert(
            policy.state_roots()[1].to_string(),
            canonical.to_string_lossy().into_owned(),
        );
    } else {
        values.extend(
            policy
                .state_roots()
                .iter()
                .map(|state_root| ((*state_root).to_string(), account_directory.clone())),
        );
    }
    let removals = policy
        .selected_environment_removals()
        .iter()
        .map(ToString::to_string)
        .collect();
    ProviderStateEnvironment::from_mutations(values, removals).map_err(|error| error.to_string())
}

struct ProfileLock {
    file: File,
}

impl Drop for ProfileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

fn lock_profile(account_root: &Path, profile_name: &str) -> Result<ProfileLock, String> {
    let lock_directory = account_root.join(".overlay-locks");
    match std::fs::symlink_metadata(&lock_directory) {
        Ok(metadata) => {
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || metadata.uid() != unsafe { libc::geteuid() }
            {
                return Err(typed_error(
                    "credential_overlay_lock_untrusted",
                    "lock root must be a real directory",
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(&lock_directory) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(typed_error(
                        "credential_overlay_io",
                        format!("create lock root: {error}"),
                    ));
                }
            }
            let metadata = std::fs::symlink_metadata(&lock_directory).map_err(|error| {
                typed_error(
                    "credential_overlay_io",
                    format!("reinspect lock root: {error}"),
                )
            })?;
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || metadata.uid() != unsafe { libc::geteuid() }
            {
                return Err(typed_error(
                    "credential_overlay_lock_untrusted",
                    "lock root must be a real directory",
                ));
            }
        }
        Err(error) => {
            return Err(typed_error(
                "credential_overlay_io",
                format!("inspect lock root: {error}"),
            ));
        }
    }
    std::fs::set_permissions(&lock_directory, std::fs::Permissions::from_mode(0o700)).map_err(
        |error| {
            typed_error(
                "credential_overlay_io",
                format!("secure lock root: {error}"),
            )
        },
    )?;
    let lock_path = lock_directory.join(format!("{profile_name}.lock"));
    if let Ok(metadata) = std::fs::symlink_metadata(&lock_path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(typed_error(
                "credential_overlay_lock_untrusted",
                "profile lock must be a real file",
            ));
        }
    }
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&lock_path)
        .map_err(|error| {
            typed_error(
                "credential_overlay_io",
                format!("open profile lock: {error}"),
            )
        })?;
    let lock_metadata = file.metadata().map_err(|error| {
        typed_error(
            "credential_overlay_io",
            format!("inspect opened profile lock: {error}"),
        )
    })?;
    if !lock_metadata.is_file() || lock_metadata.uid() != unsafe { libc::geteuid() } {
        return Err(typed_error(
            "credential_overlay_lock_untrusted",
            "profile lock must be a regular file owned by the current user",
        ));
    }
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|error| {
            typed_error(
                "credential_overlay_io",
                format!("secure profile lock: {error}"),
            )
        })?;
    file.lock_exclusive().map_err(|error| {
        typed_error(
            "credential_overlay_lock_failed",
            format!("lock profile: {error}"),
        )
    })?;
    Ok(ProfileLock { file })
}

#[derive(Debug)]
struct Replacement {
    published: PublishedPath,
    backup: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileGeneration {
    device: u64,
    inode: u64,
    length: u64,
    mode: u32,
    link_count: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

impl FileGeneration {
    fn from(metadata: &std::fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            length: metadata.len(),
            mode: metadata.mode(),
            link_count: metadata.nlink(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }

    fn identity(self) -> (u64, u64) {
        (self.device, self.inode)
    }

    fn payload(self) -> (u64, u32, i64, i64) {
        (
            self.length,
            self.mode,
            self.modified_seconds,
            self.modified_nanoseconds,
        )
    }

    fn order(self) -> (i64, i64) {
        (self.modified_seconds, self.modified_nanoseconds)
    }
}

#[derive(Debug)]
struct PublishedPath {
    path: PathBuf,
    generation: FileGeneration,
    content_sensitive: bool,
}

impl PublishedPath {
    fn from_metadata(path: PathBuf, metadata: &std::fs::Metadata) -> Self {
        Self {
            path,
            generation: FileGeneration::from(metadata),
            content_sensitive: metadata.is_file() && !metadata.file_type().is_symlink(),
        }
    }

    fn observe(path: PathBuf) -> Result<Self, String> {
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            typed_error(
                "credential_overlay_io",
                format!("observe published overlay entry: {error}"),
            )
        })?;
        Ok(Self::from_metadata(path, &metadata))
    }

    fn is_current(&self) -> bool {
        std::fs::symlink_metadata(&self.path).is_ok_and(|metadata| {
            let current = FileGeneration::from(&metadata);
            current.identity() == self.generation.identity()
                && (!self.content_sensitive || current.payload() == self.generation.payload())
        })
    }
}

#[derive(Default)]
struct OverlayTransaction {
    created: Vec<PublishedPath>,
    created_directories: Vec<PublishedPath>,
    replacements: Vec<Replacement>,
    committed: bool,
}

impl OverlayTransaction {
    fn record_created(&mut self, published: PublishedPath) {
        self.created.push(published);
    }

    fn record_created_directory(&mut self, published: PublishedPath) {
        self.created_directories.push(published);
    }

    fn record_replacement(&mut self, published: PublishedPath, backup: PathBuf) {
        self.replacements.push(Replacement { published, backup });
    }

    fn commit(mut self) -> Result<(), String> {
        // The overlay is already published. Backup cleanup must never make
        // Drop interpret it as uncommitted and remove a live destination.
        self.committed = true;
        let mut cleanup_error = None;
        for replacement in &self.replacements {
            if let Err(error) = std::fs::remove_file(&replacement.backup) {
                cleanup_error.get_or_insert_with(|| {
                    typed_error(
                        "credential_overlay_io",
                        format!("remove transaction backup: {error}"),
                    )
                });
            } else {
                let _ = sync_parent_directory(&replacement.published.path);
            }
        }
        cleanup_error.map_or(Ok(()), Err)
    }
}

impl Drop for OverlayTransaction {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        for replacement in self.replacements.iter().rev() {
            if replacement.published.is_current() {
                let _ = std::fs::remove_file(&replacement.published.path);
                let _ = std::fs::rename(&replacement.backup, &replacement.published.path);
                let _ = sync_parent_directory(&replacement.published.path);
            } else {
                let _ = std::fs::remove_file(&replacement.backup);
                let _ = sync_parent_directory(&replacement.published.path);
            }
        }
        for created in self.created.iter().rev() {
            if created.is_current() {
                let _ = std::fs::remove_file(&created.path);
                let _ = sync_parent_directory(&created.path);
            }
        }
        for created in self.created_directories.iter().rev() {
            if created.is_current() {
                let _ = std::fs::remove_dir(&created.path);
                let _ = sync_parent_directory(&created.path);
            }
        }
    }
}

#[derive(Default)]
struct FaultInjection {
    fail_after: Option<usize>,
    mutations: usize,
}

impl FaultInjection {
    fn after_mutation(&mut self) -> Result<(), String> {
        self.mutations += 1;
        if self.fail_after == Some(self.mutations) {
            return Err(typed_error(
                "credential_overlay_fault_injected",
                "test mutation boundary",
            ));
        }
        Ok(())
    }
}

fn unique_sidecar_path(destination: &Path, kind: &str) -> Result<PathBuf, String> {
    let parent = destination.parent().ok_or_else(|| {
        typed_error(
            "credential_overlay_io",
            "overlay entry has no parent directory",
        )
    })?;
    let sequence = OVERLAY_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(parent.join(format!(
        ".hebbian-overlay-{kind}-{}-{timestamp}-{sequence}",
        std::process::id(),
    )))
}

fn sync_parent_directory(path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| {
        typed_error(
            "credential_overlay_io",
            "overlay entry has no parent directory",
        )
    })?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            typed_error(
                "credential_overlay_io",
                format!("sync overlay directory: {error}"),
            )
        })
}

fn canonical_entry_exists(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(typed_error(
            "credential_overlay_io",
            format!("inspect canonical entry: {error}"),
        )),
    }
}

fn require_canonical_entry(path: &Path, expected_directory: bool) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        typed_error(
            "credential_overlay_source_untrusted",
            format!("inspect canonical entry: {error}"),
        )
    })?;
    let valid = if expected_directory {
        metadata.is_dir() && !metadata.file_type().is_symlink()
    } else {
        metadata.is_file() && !metadata.file_type().is_symlink()
    };
    if !valid || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(typed_error(
            "credential_overlay_source_untrusted",
            "canonical entry has an unexpected type or owner",
        ));
    }
    Ok(())
}

fn existing_canonical_directory(
    canonical: &Path,
    relative_path: &Path,
) -> Result<Option<PathBuf>, String> {
    let mut source = canonical.to_path_buf();
    let mut has_component = false;
    for component in relative_path.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(typed_error(
                "credential_overlay_policy_invalid",
                "shared tooling path must be relative",
            ));
        };
        has_component = true;
        source.push(name);
        match std::fs::symlink_metadata(&source) {
            Ok(_) => require_canonical_entry(&source, true)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(typed_error(
                    "credential_overlay_io",
                    format!("inspect canonical shared tooling path: {error}"),
                ));
            }
        }
    }
    if !has_component {
        return Err(typed_error(
            "credential_overlay_policy_invalid",
            "shared tooling path must not be empty",
        ));
    }
    Ok(Some(source))
}

fn ensure_directory_symlink(
    source: &Path,
    destination: &Path,
    transaction: &mut OverlayTransaction,
    fault: &mut FaultInjection,
) -> Result<bool, String> {
    require_canonical_entry(source, true)?;
    match std::fs::symlink_metadata(destination) {
        Ok(metadata) => {
            if !metadata.file_type().is_symlink() {
                return Err(typed_error(
                    "credential_overlay_wrong_type",
                    "shared directory entry must be a symlink",
                ));
            }
            let target = std::fs::read_link(destination).map_err(|error| {
                typed_error(
                    "credential_overlay_io",
                    format!("read shared directory target: {error}"),
                )
            })?;
            if target != source {
                return Err(typed_error(
                    "credential_overlay_wrong_target",
                    "shared directory points outside the canonical provider state",
                ));
            }
            Ok(false)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::os::unix::fs::symlink(source, destination).map_err(|error| {
                typed_error(
                    "credential_overlay_io",
                    format!("create shared directory link: {error}"),
                )
            })?;
            transaction.record_created(PublishedPath::observe(destination.to_path_buf())?);
            sync_parent_directory(destination)?;
            fault.after_mutation()?;
            Ok(true)
        }
        Err(error) => Err(typed_error(
            "credential_overlay_io",
            format!("inspect shared directory entry: {error}"),
        )),
    }
}

fn ensure_overlay_parent_directories(
    account_directory: &Path,
    relative_path: &Path,
    transaction: &mut OverlayTransaction,
    fault: &mut FaultInjection,
) -> Result<(), String> {
    let Some(parent) = relative_path.parent() else {
        return Ok(());
    };
    let mut destination = account_directory.to_path_buf();
    for component in parent.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(typed_error(
                "credential_overlay_policy_invalid",
                "shared tooling path must be relative",
            ));
        };
        destination.push(name);
        let existed = canonical_entry_exists(&destination)?;
        create_or_require_owned_directory(&destination, "shared tooling parent", 0o700)?;
        if !existed {
            transaction.record_created_directory(PublishedPath::observe(destination.clone())?);
            sync_parent_directory(&destination)?;
            fault.after_mutation()?;
        }
    }
    Ok(())
}

fn ensure_append_hardlink(
    source: &Path,
    destination: &Path,
    transaction: &mut OverlayTransaction,
    fault: &mut FaultInjection,
) -> Result<bool, String> {
    require_canonical_entry(source, false)?;
    let source_metadata = std::fs::metadata(source).map_err(|error| {
        typed_error(
            "credential_overlay_io",
            format!("inspect canonical append file: {error}"),
        )
    })?;
    match std::fs::symlink_metadata(destination) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(typed_error(
                    "credential_overlay_wrong_type",
                    "shared append entry must be a regular hard link",
                ));
            }
            if (source_metadata.dev(), source_metadata.ino()) != (metadata.dev(), metadata.ino()) {
                return Err(typed_error(
                    "credential_overlay_wrong_target",
                    "shared append entry is not the canonical inode",
                ));
            }
            Ok(false)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::hard_link(source, destination).map_err(|error| {
                typed_error(
                    "credential_overlay_io",
                    format!("create shared append hard link: {error}"),
                )
            })?;
            transaction.record_created(PublishedPath::observe(destination.to_path_buf())?);
            sync_parent_directory(destination)?;
            fault.after_mutation()?;
            Ok(true)
        }
        Err(error) => Err(typed_error(
            "credential_overlay_io",
            format!("inspect shared append entry: {error}"),
        )),
    }
}

fn atomic_sync_regular_file(
    source: &Path,
    destination: &Path,
    transaction: &mut OverlayTransaction,
    fault: &mut FaultInjection,
) -> Result<bool, String> {
    require_canonical_entry(source, false)?;
    let mut source_file = File::open(source).map_err(|error| {
        typed_error(
            "credential_overlay_io",
            format!("open canonical spawn state: {error}"),
        )
    })?;
    if unchanged_spawn_file(source, &mut source_file, destination).map_err(|error| {
        typed_error(
            "credential_overlay_io",
            format!("compare spawn state: {error}"),
        )
    })? {
        return Ok(false);
    }
    source_file.rewind().map_err(|error| {
        typed_error(
            "credential_overlay_io",
            format!("rewind canonical spawn state: {error}"),
        )
    })?;
    atomic_replace_regular_file(
        destination,
        transaction,
        fault,
        |destination_file| {
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = source_file.read(&mut buffer).map_err(|error| {
                    typed_error(
                        "credential_overlay_io",
                        format!("read canonical spawn state: {error}"),
                    )
                })?;
                if count == 0 {
                    break;
                }
                destination_file
                    .write_all(&buffer[..count])
                    .map_err(|error| {
                        typed_error(
                            "credential_overlay_io",
                            format!("write spawn state temporary: {error}"),
                        )
                    })?;
            }
            Ok(())
        },
        || Ok(()),
    )
}

/// Avoid publishing and syncing an identical private copy. Compare current bytes
/// with bounded memory; metadata alone cannot establish content equality.
fn unchanged_spawn_file(
    source_path: &Path,
    source: &mut File,
    destination_path: &Path,
) -> std::io::Result<bool> {
    let source_generation = FileGeneration::from(&source.metadata()?);
    let Ok(metadata) = std::fs::symlink_metadata(destination_path) else {
        return Ok(false);
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o600
        || metadata.len() != source_generation.length
    {
        return Ok(false);
    }
    let destination_generation = FileGeneration::from(&metadata);
    let Ok(mut destination) = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(destination_path)
    else {
        return Ok(false);
    };
    if FileGeneration::from(&destination.metadata()?) != destination_generation {
        return Ok(false);
    }
    let mut source_bytes = [0_u8; 64 * 1024];
    let mut destination_bytes = [0_u8; 64 * 1024];
    loop {
        let count = source.read(&mut source_bytes)?;
        if count == 0 {
            break;
        }
        if destination.read_exact(&mut destination_bytes[..count]).is_err()
            || source_bytes[..count] != destination_bytes[..count]
        {
            return Ok(false);
        }
    }
    // A concurrent replacement or write invalidates the comparison. The existing
    // atomic publication path remains responsible for all changed/unsafe copies.
    Ok([
        (source_path, source_generation),
        (destination_path, destination_generation),
    ]
    .into_iter()
    .all(|(path, generation)| {
        std::fs::symlink_metadata(path)
            .is_ok_and(|metadata| FileGeneration::from(&metadata) == generation)
    }))
}

fn atomic_replace_regular_file(
    destination: &Path,
    transaction: &mut OverlayTransaction,
    fault: &mut FaultInjection,
    write_staged: impl FnOnce(&mut File) -> Result<(), String>,
    pre_publish: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    let destination_exists = match std::fs::symlink_metadata(destination) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(typed_error(
                    "credential_overlay_wrong_type",
                    "managed replacement destination must be a regular file",
                ));
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(typed_error(
                "credential_overlay_io",
                format!("inspect managed replacement destination: {error}"),
            ));
        }
    };
    let temporary = unique_sidecar_path(destination, "new")?;
    let mut destination_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&temporary)
        .map_err(|error| {
            typed_error(
                "credential_overlay_io",
                format!("create managed replacement temporary: {error}"),
            )
        })?;
    let copy_result = (|| -> Result<(), String> {
        write_staged(&mut destination_file)?;
        destination_file.sync_all().map_err(|error| {
            typed_error(
                "credential_overlay_io",
                format!("sync managed replacement temporary: {error}"),
            )
        })
    })();
    if let Err(error) = copy_result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    let published = match destination_file.metadata() {
        Ok(metadata) => PublishedPath::from_metadata(destination.to_path_buf(), &metadata),
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(typed_error(
                "credential_overlay_io",
                format!("inspect staged managed replacement: {error}"),
            ));
        }
    };
    drop(destination_file);
    if let Err(error) = pre_publish() {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }

    if destination_exists {
        let backup = unique_sidecar_path(destination, "old")?;
        if let Err(error) = std::fs::hard_link(destination, &backup) {
            let _ = std::fs::remove_file(&temporary);
            return Err(typed_error(
                "credential_overlay_io",
                format!("backup prior managed file: {error}"),
            ));
        }
        if let Err(error) = std::fs::rename(&temporary, destination) {
            let _ = std::fs::remove_file(&temporary);
            let _ = std::fs::remove_file(&backup);
            return Err(typed_error(
                "credential_overlay_io",
                format!("publish managed replacement: {error}"),
            ));
        }
        transaction.record_replacement(published, backup);
    } else {
        if let Err(error) = std::fs::rename(&temporary, destination) {
            let _ = std::fs::remove_file(&temporary);
            return Err(typed_error(
                "credential_overlay_io",
                format!("publish managed replacement: {error}"),
            ));
        }
        transaction.record_created(published);
    }
    sync_parent_directory(destination)?;
    fault.after_mutation()?;
    Ok(true)
}

fn prepare_reviewed_overlay(
    home: &Path,
    account_directory: &Path,
    policy: &OverlayPolicy,
    fail_after: Option<usize>,
    codex_notify_script: Option<&str>,
) -> Result<Vec<String>, String> {
    let account_root = require_owned_real_directory(
        account_directory.parent().ok_or_else(|| {
            typed_error(
                "credential_directory_untrusted",
                "profile has no account root",
            )
        })?,
        "account root",
    )?;
    std::fs::set_permissions(&account_root, std::fs::Permissions::from_mode(0o700)).map_err(
        |error| {
            typed_error(
                "credential_overlay_io",
                format!("secure account root: {error}"),
            )
        },
    )?;
    let account_directory = require_owned_real_directory(account_directory, "profile directory")?;
    std::fs::set_permissions(&account_directory, std::fs::Permissions::from_mode(0o700)).map_err(
        |error| {
            typed_error(
                "credential_overlay_io",
                format!("secure profile directory: {error}"),
            )
        },
    )?;
    let profile_name = account_directory
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            typed_error(
                "credential_directory_untrusted",
                "profile name is not valid UTF-8",
            )
        })?;
    let _lock = lock_profile(&account_root, profile_name)?;

    let credential = account_directory.join(policy.credential_file_name);
    match std::fs::symlink_metadata(&credential) {
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.nlink() != 1
            {
                return Err(typed_error(
                    "credential_file_untrusted",
                    format!(
                        "{} credential must be a real file owned by the current user",
                        policy.credential_label
                    ),
                ));
            }
            std::fs::set_permissions(&credential, std::fs::Permissions::from_mode(0o600)).map_err(
                |error| {
                    typed_error(
                        "credential_overlay_io",
                        format!("secure credential file: {error}"),
                    )
                },
            )?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(typed_error(
                "credential_overlay_io",
                format!("inspect credential file: {error}"),
            ));
        }
    }

    let canonical = create_or_require_owned_directory(
        &home.join(policy.canonical_directory_name),
        "canonical provider state",
        0o700,
    )?;
    let mut created = Vec::new();
    let mut transaction = OverlayTransaction::default();
    let mut fault = FaultInjection {
        fail_after,
        mutations: 0,
    };
    overlay_topology::reserve_reviewed_sources(&canonical, policy)?;
    for name in policy.shared_directories {
        let source = canonical.join(name);
        if ensure_directory_symlink(
            &source,
            &account_directory.join(name),
            &mut transaction,
            &mut fault,
        )? {
            created.push((*name).to_string());
        }
    }
    for name in policy.shared_tooling_directories {
        let relative_path = Path::new(name);
        let Some(source) = existing_canonical_directory(&canonical, relative_path)? else {
            continue;
        };
        ensure_overlay_parent_directories(
            &account_directory,
            relative_path,
            &mut transaction,
            &mut fault,
        )?;
        if ensure_directory_symlink(
            &source,
            &account_directory.join(relative_path),
            &mut transaction,
            &mut fault,
        )? {
            created.push((*name).to_string());
        }
    }
    for name in policy.append_files {
        let source = canonical.join(name);
        if ensure_append_hardlink(
            &source,
            &account_directory.join(name),
            &mut transaction,
            &mut fault,
        )? {
            created.push((*name).to_string());
        }
    }
    for name in policy.spawn_sync_files {
        // Codex config is composed once below, before publishing, so canonical
        // settings cannot erase decisions persisted by the selected account.
        if policy.canonical_directory_name == ".codex" && *name == "config.toml" {
            continue;
        }
        let source = canonical.join(name);
        if !canonical_entry_exists(&source)? {
            continue;
        }
        if atomic_sync_regular_file(
            &source,
            &account_directory.join(name),
            &mut transaction,
            &mut fault,
        )? {
            created.push((*name).to_string());
        }
    }
    if policy.canonical_directory_name == ".codex"
        && sync_codex_overlay_config(
            home,
            &account_directory,
            codex_notify_script,
            &mut transaction,
            &mut fault,
        )?
    {
        created.push("config.toml".to_string());
    }
    transaction.commit()?;
    Ok(created)
}

fn prepare_codex_overlay(
    home: &Path,
    account_directory: &Path,
    fail_after: Option<usize>,
    notify_script: Option<&str>,
) -> Result<Vec<String>, String> {
    prepare_reviewed_overlay(
        home,
        account_directory,
        &CODEX_OVERLAY_POLICY,
        fail_after,
        notify_script,
    )
}

/// Match Codex's canonicalized source keys, including config about to be
/// published. Missing sources with no retained overlay have nothing to rekey.
fn codex_trust_rekey_pairs(home: &Path, account_directory: &Path) -> Vec<(String, String)> {
    let overlay_root = std::fs::canonicalize(account_directory)
        .unwrap_or_else(|_| account_directory.to_path_buf());
    ["hooks.json", "config.toml"]
        .iter()
        .filter_map(|name| {
            let canonical = home.join(".codex").join(name);
            let overlay = overlay_root.join(name);
            if !canonical.is_file() && !overlay.is_file() {
                return None;
            }
            // Match absolute canonical paths, including macOS /var aliases.
            let canonical = std::fs::canonicalize(&canonical).unwrap_or(canonical);
            Some((
                format!("{}:", canonical.to_string_lossy()),
                format!("{}:", overlay.to_string_lossy()),
            ))
        })
        .collect()
}

/// Compose once under the existing profile lock and rollback transaction.
fn sync_codex_overlay_config(
    home: &Path,
    account_directory: &Path,
    notify_script: Option<&str>,
    transaction: &mut OverlayTransaction,
    fault: &mut FaultInjection,
) -> Result<bool, String> {
    let path = account_directory.join("config.toml");
    let canonical_path = home.join(".codex/config.toml");
    let canonical = read_codex_config(&canonical_path)?;
    let previous = read_codex_config(&path)?;
    let current = previous
        .as_ref()
        .map_or(&[][..], |(content, _)| content.as_slice());
    let source = canonical
        .as_ref()
        .map_or(current, |(content, _)| content.as_slice());
    let local = std::str::from_utf8(current)
        .ok()
        .and_then(|content| toml::from_str::<toml::Table>(content).ok());
    let local_state = local
        .as_ref()
        .and_then(|document| document.get("hooks"))
        .and_then(|hooks| hooks.get("state"))
        .and_then(toml::Value::as_table);
    let rekey_pairs = codex_trust_rekey_pairs(home, account_directory);
    let next = std::str::from_utf8(source)
        .ok()
        .and_then(|source| {
            composed_codex_overlay_config(source, notify_script, &rekey_pairs, local_state)
        })
        .map(String::into_bytes)
        .unwrap_or_else(|| source.to_vec());
    let unchanged = next == current
        || local.as_ref().is_some_and(|document| {
            std::str::from_utf8(&next)
                .ok()
                .and_then(|next| toml::from_str::<toml::Table>(next).ok())
                .is_some_and(|next| next == *document)
        });
    let validate_sources = || {
        for (path, snapshot) in [(&canonical_path, &canonical), (&path, &previous)] {
            let observed = match std::fs::symlink_metadata(path) {
                Ok(metadata) => Some(FileGeneration::from(&metadata)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(typed_error("credential_overlay_io", error.to_string())),
            };
            if observed != snapshot.as_ref().map(|(_, generation)| *generation) {
                return Err(typed_error(
                    "credential_overlay_source_changed",
                    "Codex config changed during preparation",
                ));
            }
        }
        Ok(())
    };
    if unchanged
        && (previous.is_some() || canonical.is_none())
        && previous.as_ref().is_none_or(|(_, generation)| {
            generation.mode & 0o7777 == 0o600 && generation.link_count == 1
        })
    {
        validate_sources()?;
        return Ok(false);
    }
    atomic_replace_regular_file(
        &path,
        transaction,
        fault,
        |file| {
            file.write_all(if unchanged { current } else { &next })
                .map_err(|error| typed_error("credential_overlay_io", error.to_string()))
        },
        validate_sources,
    )
}

/// Read only an owned regular file; pin its generation across composition so a
/// provider's concurrent approval write is not silently replaced by stale data.
fn read_codex_config(path: &Path) -> Result<Option<(Vec<u8>, FileGeneration)>, String> {
    if !canonical_entry_exists(path)? {
        return Ok(None);
    }
    require_canonical_entry(path, false)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(|error| typed_error("credential_overlay_io", error.to_string()))?;
    let metadata = file
        .metadata()
        .map_err(|error| typed_error("credential_overlay_io", error.to_string()))?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(typed_error(
            "credential_overlay_source_untrusted",
            "Codex config must be an owned regular file",
        ));
    }
    let mut content = Vec::new();
    file.read_to_end(&mut content)
        .map_err(|error| typed_error("credential_overlay_io", error.to_string()))?;
    Ok(Some((content, FileGeneration::from(&metadata))))
}

/// 순수 합성 — None은 "쓰지 않는다"(비파괴 우선): 파싱 불가하거나 의미 있는
/// 변경이 없으면 파일을 그대로 둔다(바이트 재포맷도 하지 않는다).
///
/// 두 가지 변환을 한 번의 기록으로 합친다:
/// - notify 주입: 사용자 notify는 체인 인자로 보존, 문자열 배열이 아니면
///   notify만 포기(재키잉은 계속).
/// - 훅 trust 재키잉: canonical 원천(~/.codex/hooks.json·config.toml)으로
///   기록된 [hooks.state] 신뢰를 오버레이 사본 경로 키로 복제한다. 해시는
///   훅 내용을 가리키므로 값 복사는 신뢰 확장이 아니다 — 내용이 다르면
///   codex가 리뷰로 fail-closed한다. 이 불일치가 매 spawn "hooks need
///   review" 모달을 만들었다(2026-08-02 E2E 실측, bead h9oz).
fn merged_codex_overlay_config(
    current: &str,
    notify_script: Option<&str>,
    rekey_pairs: &[(String, String)],
) -> Option<String> {
    composed_codex_overlay_config(current, notify_script, rekey_pairs, None)
}

fn composed_codex_overlay_config(
    current: &str,
    notify_script: Option<&str>,
    rekey_pairs: &[(String, String)],
    local_state: Option<&toml::Table>,
) -> Option<String> {
    let mut document: toml::Table = toml::from_str(current).ok()?;
    let mut changed = false;
    // Keep only already persisted hook decisions, including explicit disables.
    // Never derive a hash: Codex still reviews new/changed hook definitions.
    if let Some(local_state) = local_state.filter(|state| !state.is_empty()) {
        let hooks = document
            .entry("hooks")
            .or_insert_with(|| toml::Value::Table(toml::Table::new()))
            .as_table_mut()?;
        let state = hooks
            .entry("state")
            .or_insert_with(|| toml::Value::Table(toml::Table::new()))
            .as_table_mut()?;
        for (key, value) in local_state {
            if state.get(key) != Some(value) {
                state.insert(key.clone(), value.clone());
                changed = true;
            }
        }
    }
    if let Some(script) = notify_script {
        let chain: Option<Vec<String>> = match document.get("notify") {
            None => Some(Vec::new()),
            Some(toml::Value::Array(items)) => items
                .iter()
                .map(|item| item.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()
                .map(|chain| {
                    chain
                        .into_iter()
                        .filter(|item| !item.ends_with("/managed-codex-notify.sh"))
                        .collect()
                }),
            Some(_) => None,
        };
        if let Some(chain) = chain {
            let mut notify = Vec::with_capacity(chain.len() + 1);
            notify.push(toml::Value::String(script.to_string()));
            notify.extend(chain.into_iter().map(toml::Value::String));
            let notify = toml::Value::Array(notify);
            if document.get("notify") != Some(&notify) {
                document.insert("notify".to_string(), notify);
                changed = true;
            }
        }
    }
    if let Some(state) = document
        .get_mut("hooks")
        .and_then(|hooks| hooks.as_table_mut())
        .and_then(|hooks| hooks.get_mut("state"))
        .and_then(|state| state.as_table_mut())
    {
        let mut additions: Vec<(String, toml::Value)> = Vec::new();
        for (key, value) in state.iter() {
            for (canonical_prefix, overlay_prefix) in rekey_pairs {
                if let Some(rest) = key.strip_prefix(canonical_prefix.as_str()) {
                    let overlay_key = format!("{overlay_prefix}{rest}");
                    if !state.contains_key(&overlay_key) {
                        additions.push((overlay_key, value.clone()));
                    }
                }
            }
        }
        for (key, value) in additions {
            state.insert(key, value);
            changed = true;
        }
    }
    if !changed {
        return None;
    }
    toml::to_string(&document).ok()
}

/// 설정 화면용 오버레이 배선 프로브 — 읽기 전용(mutate-to-probe 금지).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOverlayWiring {
    /// overlay config.toml의 notify에 managed 스크립트가 서 있는가
    pub notify_merged: bool,
    /// canonical 훅 신뢰가 오버레이 경로 키로 전부 복제돼 있는가
    pub trust_rekeyed: bool,
}

pub fn codex_overlay_wiring(home: &Path, account_directory: &Path) -> CodexOverlayWiring {
    let current =
        std::fs::read_to_string(account_directory.join("config.toml")).unwrap_or_default();
    let Ok(document) = toml::from_str::<toml::Table>(&current) else {
        // 파싱 불가 = 배선 상태 미상 — 화면에는 미배선으로 fail-closed 표시.
        return CodexOverlayWiring {
            notify_merged: false,
            trust_rekeyed: false,
        };
    };
    let notify_merged = document
        .get("notify")
        .and_then(toml::Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.as_str()
                    .is_some_and(|entry| entry.ends_with("/managed-codex-notify.sh"))
            })
        });
    let pairs = codex_trust_rekey_pairs(home, account_directory);
    // 재키잉이 추가할 항목이 없으면 현행이다(파싱은 위에서 이미 성공했으므로
    // None은 "변경 불요"만 뜻한다). notify는 이 판정에 관여시키지 않는다.
    let trust_rekeyed = merged_codex_overlay_config(&current, None, &pairs).is_none();
    CodexOverlayWiring {
        notify_merged,
        trust_rekeyed,
    }
}

fn prepare_claude_overlay(
    home: &Path,
    account_directory: &Path,
    fail_after: Option<usize>,
) -> Result<Vec<String>, String> {
    let created = prepare_reviewed_overlay(
        home,
        account_directory,
        &CLAUDE_OVERLAY_POLICY,
        fail_after,
        None,
    )?;
    converge_optional_claude_state(home, account_directory.parent(), Some(account_directory));
    Ok(created)
}

fn converge_default_claude_state(home: &Path, account_root: &Path) {
    match std::fs::symlink_metadata(account_root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        _ => {}
    }
    converge_optional_claude_state(home, Some(account_root), None);
}

fn converge_optional_claude_state(
    home: &Path,
    account_root: Option<&Path>,
    current_profile: Option<&Path>,
) {
    let Some(account_root) = account_root else {
        report_skipped_claude_shared_state("credential_directory_untrusted");
        return;
    };
    if let Err(error) = claude_shared_state::converge(home, account_root, current_profile, None) {
        report_skipped_claude_shared_state(&error);
    }
}

fn report_skipped_claude_shared_state(error: &str) {
    let code = error.split_once(':').map_or(error, |(code, _)| code);
    eprintln!("claude shared state convergence skipped: {code}");
}

/// Converge optional provider-default shared state while retaining the
/// provider's native home layout and credential/environment authority.
pub fn prepare_provider_default_profile_state(
    provider: &str,
    dure_home: &Path,
    platform_home: &Path,
) {
    if provider == "claude" {
        converge_default_claude_state(platform_home, &dure_home.join("accounts"));
    }
}

/// Validate the non-secret profile reference, harden its credential boundary,
/// synchronize reviewed shared state immediately before spawn, and only then
/// produce the private Host environment.
pub fn prepare_managed_provider_profile(
    provider: &str,
    home: &str,
    credential_id: Option<&str>,
    credential_directory: Option<&str>,
) -> Result<ProviderStateEnvironment, String> {
    prepare_managed_provider_profile_with_codex_notify(
        provider,
        home,
        credential_id,
        credential_directory,
        None,
    )
}

pub fn prepare_managed_provider_profile_with_codex_notify(
    provider: &str,
    home: &str,
    credential_id: Option<&str>,
    credential_directory: Option<&str>,
    codex_notify_command: Option<&str>,
) -> Result<ProviderStateEnvironment, String> {
    let Some(account_directory) =
        resolve_account_directory(provider, home, credential_id, credential_directory)?
    else {
        prepare_provider_default_profile_state(
            provider,
            &Path::new(home).join(app_home::DIR_NAME),
            Path::new(home),
        );
        return provider_default_state_environment(provider);
    };
    prepare_provider_profile_directory(
        provider,
        Path::new(home),
        &account_directory,
        codex_notify_command,
    )?;
    provider_state_environment(provider, home, account_directory)
}

/// Converge one already-authorized provider profile immediately before exec.
fn prepare_provider_profile_directory(
    provider: &str,
    home: &Path,
    account_directory: &Path,
    codex_notify_command: Option<&str>,
) -> Result<Vec<String>, String> {
    match provider {
        "codex" => prepare_codex_overlay(home, account_directory, None, codex_notify_command),
        "claude" => prepare_claude_overlay(home, account_directory, None),
        _ => Ok(Vec::new()),
    }
}

/// Converge one authorized profile and return the exact environment for exec.
pub fn prepare_provider_profile_launch(
    provider: &str,
    dure_home: &Path,
    platform_home: &Path,
    account_directory: &Path,
    codex_notify_command: Option<&str>,
) -> Result<PreparedProviderProfileLaunch, String> {
    let dure_home = require_owned_real_directory(dure_home, "Dure root")?;
    let account_root = require_owned_real_directory(&dure_home.join("accounts"), "account root")?;
    let before = require_owned_real_directory(account_directory, "profile directory")?;
    let expected_prefix = format!("{provider}-");
    if before.parent() != Some(account_root.as_path())
        || !before
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&expected_prefix))
    {
        return Err(typed_error(
            "credential_directory_untrusted",
            "profile is outside the provider account root",
        ));
    }
    let before_metadata = std::fs::symlink_metadata(&before).map_err(|error| {
        typed_error(
            "credential_directory_untrusted",
            format!("inspect profile directory: {error}"),
        )
    })?;
    prepare_provider_profile_directory(provider, platform_home, &before, codex_notify_command)?;
    let after = require_owned_real_directory(account_directory, "profile directory")?;
    let after_metadata = std::fs::symlink_metadata(&after).map_err(|error| {
        typed_error(
            "credential_directory_untrusted",
            format!("inspect profile directory: {error}"),
        )
    })?;
    if before != after
        || before_metadata.dev() != after_metadata.dev()
        || before_metadata.ino() != after_metadata.ino()
    {
        return Err(typed_error(
            "credential_directory_untrusted",
            "profile changed while it was prepared",
        ));
    }
    let home = platform_home
        .to_str()
        .ok_or_else(|| typed_error("credential_directory_untrusted", "home is not UTF-8"))?;
    let environment = provider_state_environment(provider, home, after.clone())?;
    Ok(PreparedProviderProfileLaunch {
        directory: after,
        directory_device: after_metadata.dev(),
        directory_inode: after_metadata.ino(),
        environment,
    })
}

/// Compatibility command used by legacy PTY launches. Managed Hosts call
/// `prepare_managed_provider_profile` in the backend immediately before spawn.
pub fn ensure_overlay(
    provider: &str,
    home: &str,
    account_dir: &str,
) -> Result<Vec<String>, String> {
    ensure_overlay_with_codex_notify(provider, home, account_dir, None)
}

pub fn ensure_overlay_with_codex_notify(
    provider: &str,
    home: &str,
    account_dir: &str,
    codex_notify_command: Option<&str>,
) -> Result<Vec<String>, String> {
    let account_directory = resolve_account_directory(
        provider,
        home,
        Some("legacy-pty-profile"),
        Some(account_dir),
    )?
    .ok_or_else(|| typed_error("credential_reference_required", "profile is required"))?;
    match provider {
        "codex" | "claude" => prepare_provider_profile_directory(
            provider,
            Path::new(home),
            &account_directory,
            codex_notify_command,
        ),
        _ => Err(format!("unsupported overlay provider: {provider}")),
    }
}

#[cfg(test)]
fn prepare_codex_overlay_for_test(
    home: &Path,
    account_directory: &Path,
    fail_after: Option<usize>,
) -> Result<Vec<String>, String> {
    prepare_codex_overlay(home, account_directory, fail_after, None)
}

#[cfg(test)]
fn sync_codex_overlay_config_for_test(
    home: &Path,
    account: &Path,
    notify: Option<&str>,
) -> Result<(), String> {
    let mut transaction = OverlayTransaction::default();
    sync_codex_overlay_config(
        home,
        account,
        notify,
        &mut transaction,
        &mut FaultInjection {
            fail_after: None,
            mutations: 0,
        },
    )?;
    transaction.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_defaults_remove_inherited_credential_selectors() {
        let codex = managed_provider_state_environment("codex", "/unused", None, None).unwrap();
        assert_eq!(
            serde_json::to_value(codex).unwrap(),
            serde_json::json!({
                "CODEX_HOME": null,
                "CODEX_SQLITE_HOME": null,
            })
        );

        let claude = managed_provider_state_environment("claude", "/unused", None, None).unwrap();
        assert_eq!(
            serde_json::to_value(claude).unwrap(),
            serde_json::json!({
                "ANTHROPIC_CONFIG_DIR": null,
                "CLAUDE_CONFIG_DIR": null,
            })
        );
    }

    #[test]
    fn kimi_provider_default_removes_its_inherited_credential_selector() {
        let kimi = managed_provider_state_environment("kimi", "/unused", None, None).unwrap();
        assert_eq!(
            serde_json::to_value(kimi).unwrap(),
            serde_json::json!({ "KIMI_CODE_HOME": null })
        );
    }

    #[test]
    fn selected_provider_profiles_remove_ambient_auth_overrides() {
        let root = tempfile::tempdir().unwrap();
        let canonical_codex = root.path().join(".codex");
        let codex_profile = root.path().join("codex-profile");
        let claude_profile = root.path().join("claude-profile");
        let kimi_profile = root.path().join("kimi-profile");
        for directory in [
            &canonical_codex,
            &codex_profile,
            &claude_profile,
            &kimi_profile,
        ] {
            std::fs::create_dir(directory).unwrap();
        }
        let canonical_codex = std::fs::canonicalize(canonical_codex).unwrap();
        let home = root.path().to_str().unwrap();

        let codex = provider_state_environment("codex", home, codex_profile.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(codex).unwrap(),
            serde_json::json!({
                "CODEX_ACCESS_TOKEN": null,
                "CODEX_API_KEY": null,
                "CODEX_HOME": codex_profile,
                "CODEX_SQLITE_HOME": canonical_codex,
                "OPENAI_API_KEY": null,
                "OPENAI_FEDERATION_RULE_ID": null,
                "OPENAI_IDENTITY_TOKEN_FILE": null,
            })
        );

        let claude = provider_state_environment("claude", home, claude_profile.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(claude).unwrap(),
            serde_json::json!({
                "ANTHROPIC_CONFIG_DIR": claude_profile,
                "ANTHROPIC_API_KEY": null,
                "ANTHROPIC_AUTH_TOKEN": null,
                "ANTHROPIC_FEDERATION_RULE_ID": null,
                "ANTHROPIC_ORGANIZATION_ID": null,
                "ANTHROPIC_PROFILE": null,
                "CLAUDE_CODE_OAUTH_TOKEN": null,
                "CLAUDE_CODE_USE_ANTHROPIC_AWS": null,
                "CLAUDE_CODE_USE_BEDROCK": null,
                "CLAUDE_CODE_USE_FOUNDRY": null,
                "CLAUDE_CODE_USE_MANTLE": null,
                "CLAUDE_CODE_USE_VERTEX": null,
                "CLAUDE_CONFIG_DIR": claude_profile,
            })
        );

        let kimi = provider_state_environment("kimi", home, kimi_profile.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(kimi).unwrap(),
            serde_json::json!({
                "KIMI_CODE_CUSTOM_HEADERS": null,
                "KIMI_CODE_HOME": kimi_profile,
                "KIMI_MODEL_API_KEY": null,
                "KIMI_MODEL_BASE_URL": null,
                "KIMI_MODEL_NAME": null,
                "KIMI_MODEL_PROVIDER_TYPE": null,
                "KIMI_WEB_FETCH_API_KEY": null,
                "KIMI_WEB_FETCH_BASE_URL": null,
                "KIMI_WEB_SEARCH_API_KEY": null,
                "KIMI_WEB_SEARCH_BASE_URL": null,
            })
        );
    }

    #[test]
    fn codex_overlay_allowlists_never_include_credentials_or_sqlite_files() {
        assert!(!CODEX_SHARED_DIRECTORIES.contains(&"auth.json"));
        assert!(!CODEX_SHARED_TOOLING_DIRECTORIES.contains(&"auth.json"));
        assert!(!CODEX_APPEND_FILES.contains(&"auth.json"));
        assert!(!CODEX_SPAWN_SYNC_FILES.contains(&"auth.json"));
        assert!(
            CODEX_SHARED_DIRECTORIES
                .iter()
                .all(|name| !name.ends_with(".sqlite"))
        );
        assert!(CODEX_APPEND_FILES.contains(&"history.jsonl"));
        assert!(CODEX_SHARED_TOOLING_DIRECTORIES.contains(&"packages/standalone"));
        assert!(CODEX_SPAWN_SYNC_FILES.contains(&"config.toml"));
    }

    #[test]
    fn codex_notify_merge_prepends_managed_script_and_chains_user_notify() {
        let merged = merged_codex_overlay_config(
            "model = \"gpt-5.6\"\nnotify = [\"/usr/local/bin/my-notify\", \"--flag\"]\n\n[projects.\"/a\"]\ntrust_level = \"trusted\"\n",
            Some("/ctl/managed-codex-notify.sh"),
            &[],
        )
        .unwrap();
        let document: toml::Table = toml::from_str(&merged).unwrap();
        let notify: Vec<&str> = document["notify"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        assert_eq!(
            notify,
            [
                "/ctl/managed-codex-notify.sh",
                "/usr/local/bin/my-notify",
                "--flag"
            ]
        );
        // 사용자 설정의 나머지는 의미 보존된다.
        assert_eq!(document["model"].as_str(), Some("gpt-5.6"));
        assert_eq!(
            document["projects"]["/a"]["trust_level"].as_str(),
            Some("trusted")
        );
    }

    #[test]
    fn codex_notify_merge_is_idempotent_across_channels_and_respawns() {
        // canonical config가 없어 이전 합성본이 남은 경우: 기존 managed 항목
        // (다른 채널 포함)은 걷어내고 현재 채널 것 하나만 앞에 선다.
        let merged = merged_codex_overlay_config(
            "notify = [\"/old-channel/managed-codex-notify.sh\", \"/user/notify\"]\n",
            Some("/new-channel/managed-codex-notify.sh"),
            &[],
        )
        .unwrap();
        let document: toml::Table = toml::from_str(&merged).unwrap();
        let notify: Vec<&str> = document["notify"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        assert_eq!(
            notify,
            ["/new-channel/managed-codex-notify.sh", "/user/notify"]
        );
    }

    #[test]
    fn codex_trust_rekey_clones_canonical_hook_trust_to_overlay_paths() {
        let pairs = vec![(
            "/home/.codex/hooks.json:".to_string(),
            "/home/.dure/accounts/codex-a/hooks.json:".to_string(),
        )];
        let current = concat!(
            "model = \"gpt-5.6\"\n\n",
            "[hooks.state.\"/home/.codex/hooks.json:stop:0:0\"]\n",
            "trusted_hash = \"sha256:aaaa\"\n\n",
            "[hooks.state.\"/home/.codex/hooks.json.bak:stop:0:0\"]\n",
            "trusted_hash = \"sha256:bbbb\"\n\n",
            "[hooks.state.\"/proj/.codex/hooks.json:session_start:0:0\"]\n",
            "trusted_hash = \"sha256:cccc\"\n",
        );
        let merged = merged_codex_overlay_config(current, None, &pairs).unwrap();
        let document: toml::Table = toml::from_str(&merged).unwrap();
        let state = document["hooks"]["state"].as_table().unwrap();
        // canonical 항목은 유지, 오버레이 키가 같은 해시로 복제된다.
        assert_eq!(
            state["/home/.dure/accounts/codex-a/hooks.json:stop:0:0"]["trusted_hash"].as_str(),
            Some("sha256:aaaa")
        );
        assert!(state.contains_key("/home/.codex/hooks.json:stop:0:0"));
        // 접두는 구분자(:) 포함 정확 매칭 — .bak 등 유사 경로는 건드리지 않는다.
        assert!(
            !state
                .keys()
                .any(|key| key.contains("codex-a/hooks.json.bak"))
        );
        // 무관한 프로젝트 경로 신뢰는 그대로.
        assert_eq!(state.len(), 4);
        // 멱등: 같은 입력을 다시 합성하면 변경 없음(None).
        assert!(merged_codex_overlay_config(&merged, None, &pairs).is_none());
    }

    #[test]
    fn codex_trust_rekey_without_changes_leaves_bytes_untouched() {
        // 재키잉 대상도 notify도 없으면 재포맷조차 하지 않는다 — spawn-sync
        // 바이트 동일성(concurrent prepare 테스트의 전제)을 보존한다.
        assert!(merged_codex_overlay_config("shared=true", None, &[]).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn codex_trust_rekey_applies_through_overlay_preparation() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account = home.join(".dure/accounts/codex-work");
        std::fs::create_dir_all(canonical.join("sessions")).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(canonical.join("hooks.json"), b"{\"hooks\":{}}").unwrap();
        let canonical_hooks = std::fs::canonicalize(canonical.join("hooks.json")).unwrap();
        std::fs::write(
            canonical.join("config.toml"),
            format!(
                "[hooks.state.\"{}:stop:0:0\"]\ntrusted_hash = \"sha256:dddd\"\n",
                canonical_hooks.display()
            ),
        )
        .unwrap();
        prepare_codex_overlay_for_test(&home, &account, None).unwrap();
        let overlay_hooks = std::fs::canonicalize(&account).unwrap().join("hooks.json");
        let merged: toml::Table =
            toml::from_str(&std::fs::read_to_string(account.join("config.toml")).unwrap()).unwrap();
        let state = merged["hooks"]["state"].as_table().unwrap();
        assert_eq!(
            state[&format!("{}:stop:0:0", overlay_hooks.display())]["trusted_hash"].as_str(),
            Some("sha256:dddd")
        );
    }

    #[cfg(unix)]
    #[test]
    fn memory_idle_entry_survives_account_switch_and_repeated_preparation() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        std::fs::create_dir_all(&canonical).unwrap();
        let source = r#"
[mcp_servers.memory]
command = "/immutable/bin/dure-control-plane"
args = ["mcp-memory-relay", "--node", "/pinned/node", "--worker", "/pinned/memory.js", "--memory-file", "/existing/graph.jsonl"]
tool_timeout_sec = 60
disabled_tools = ["delete_entities"]
[mcp_servers.memory.env]
MEMORY_FILE_PATH = "/existing/graph.jsonl"
[mcp_servers.keep]
command = "/unchanged/server"
"#;
        std::fs::write(canonical.join("config.toml"), source).unwrap();
        let expected: toml::Table = toml::from_str(source).unwrap();
        for name in ["first", "second", "first"] {
            let account = home.join(format!(".dure/accounts/codex-{name}"));
            std::fs::create_dir_all(&account).unwrap();
            prepare_codex_overlay_for_test(&home, &account, None).unwrap();
            let actual: toml::Table = toml::from_str(
                &std::fs::read_to_string(account.join("config.toml")).unwrap(),
            )
            .unwrap();
            assert_eq!(actual["mcp_servers"], expected["mcp_servers"]);
        }
        assert_eq!(
            std::fs::read_to_string(canonical.join("config.toml")).unwrap(),
            source
        );
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_codex_notify_syncs_never_share_a_staging_file() {
        // Several panes can switch into the same account at once (a deferred
        // credential switch batch after a reload). A staging path shared by
        // those writers lets one rename a file another is still truncating,
        // publishing a truncated config.toml into the live account directory.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("config.toml"), "model = \"gpt-5.6\"\n").unwrap();
        let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::<PathBuf>::new()));
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let observed = std::sync::Arc::clone(&observed);
                scope.spawn(move || {
                    let staging = unique_sidecar_path(&dir.join("config.toml"), "notify").unwrap();
                    observed.lock().unwrap().push(staging);
                });
            }
        });
        let staging_paths = observed.lock().unwrap().clone();
        let unique: std::collections::BTreeSet<&PathBuf> = staging_paths.iter().collect();
        assert_eq!(unique.len(), staging_paths.len());
        for staging in &staging_paths {
            assert_eq!(staging.parent(), Some(dir));
            assert_ne!(
                staging.file_name(),
                Some(std::ffi::OsStr::new("config.toml"))
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn codex_notify_overlay_sync_leaves_no_staging_file_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("config.toml"), "model = \"gpt-5.6\"\n").unwrap();
        sync_codex_overlay_config_for_test(tmp.path(), dir, Some("/ctl/managed-codex-notify.sh"))
            .unwrap();
        let leftovers: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != "config.toml")
            .collect();
        assert!(
            leftovers.is_empty(),
            "leftover staging files: {leftovers:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_notify_overlay_write_is_owner_only_and_idempotent() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("config.toml"), "model = \"gpt-5.6\"\n").unwrap();
        sync_codex_overlay_config_for_test(tmp.path(), dir, Some("/ctl/managed-codex-notify.sh"))
            .unwrap();
        let path = dir.join("config.toml");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let merged = std::fs::read_to_string(&path).unwrap();
        assert!(merged.contains("managed-codex-notify.sh"));
        // 같은 스크립트로 재실행하면 파일이 그대로다(불필요한 재작성 없음).
        sync_codex_overlay_config_for_test(tmp.path(), dir, Some("/ctl/managed-codex-notify.sh"))
            .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), merged);
    }

    #[test]
    fn codex_notify_merge_declines_rather_than_destroys_unknown_shapes() {
        // 파싱 불가 → 주입 포기(사용자 파일 그대로).
        assert!(merged_codex_overlay_config("model = [broken", Some("/ctl/s.sh"), &[]).is_none());
        // notify가 문자열 배열이 아니면 추측 편집하지 않는다.
        assert!(
            merged_codex_overlay_config("notify = \"prog\"\n", Some("/ctl/s.sh"), &[]).is_none()
        );
        assert!(merged_codex_overlay_config("notify = [1, 2]\n", Some("/ctl/s.sh"), &[]).is_none());
        // 빈 문서에는 notify만 선다.
        let merged =
            merged_codex_overlay_config("", Some("/ctl/managed-codex-notify.sh"), &[]).unwrap();
        let document: toml::Table = toml::from_str(&merged).unwrap();
        assert_eq!(
            document["notify"].as_array().unwrap()[0].as_str(),
            Some("/ctl/managed-codex-notify.sh")
        );
    }

    #[test]
    fn claude_overlay_allowlists_keep_credentials_and_identity_metadata_private() {
        assert!(!CLAUDE_SHARED_DIRECTORIES.contains(&".credentials.json"));
        assert!(!CLAUDE_APPEND_FILES.contains(&".credentials.json"));
        assert!(!CLAUDE_SPAWN_SYNC_FILES.contains(&".credentials.json"));
        assert!(!CLAUDE_SHARED_DIRECTORIES.contains(&".claude.json"));
        assert!(!CLAUDE_APPEND_FILES.contains(&".claude.json"));
        assert!(!CLAUDE_SPAWN_SYNC_FILES.contains(&".claude.json"));
        assert!(CLAUDE_SHARED_DIRECTORIES.contains(&"projects"));
        assert!(CLAUDE_SHARED_DIRECTORIES.contains(&"plugins"));
        assert!(CLAUDE_SHARED_DIRECTORIES.contains(&"skills"));
        assert!(CLAUDE_APPEND_FILES.contains(&"history.jsonl"));
        assert!(CLAUDE_SPAWN_SYNC_FILES.contains(&"settings.json"));
    }

    #[cfg(unix)]
    #[test]
    fn account_profile_creation_accepts_the_exact_dure_compatibility_alias() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(home.join(".dure")).unwrap();
        std::os::unix::fs::symlink(".dure", home.join(".hebbian")).unwrap();

        for provider in ["codex", "claude", "kimi"] {
            let profile =
                create_account_profile_directory(provider, home.to_str().unwrap(), "work").unwrap();
            assert_eq!(
                profile,
                std::fs::canonicalize(home.join(format!(".dure/accounts/{provider}-work")))
                    .unwrap()
            );
        }

        let absolute_home = tmp.path().join("absolute-home");
        std::fs::create_dir(&absolute_home).unwrap();
        std::fs::create_dir(absolute_home.join(".dure")).unwrap();
        std::os::unix::fs::symlink(absolute_home.join(".dure"), absolute_home.join(".hebbian"))
            .unwrap();
        assert!(
            create_account_profile_directory("codex", absolute_home.to_str().unwrap(), "migrated",)
                .is_ok()
        );
    }

    #[cfg(unix)]
    #[test]
    fn account_profile_creation_is_private_idempotent_and_rejects_a_symlink_root() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let profile =
            create_account_profile_directory("codex", home.to_str().unwrap(), "work").unwrap();
        let repeated =
            create_account_profile_directory("codex", home.to_str().unwrap(), "work").unwrap();
        assert_eq!(profile, repeated);
        assert_eq!(
            std::fs::metadata(home.join(".dure/accounts"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let other_home = tmp.path().join("other-home");
        let outside = tmp.path().join("outside");
        std::fs::create_dir(&other_home).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, other_home.join(".dure")).unwrap();
        let error = create_account_profile_directory("codex", other_home.to_str().unwrap(), "work")
            .unwrap_err();
        assert!(error.starts_with("credential_directory_untrusted:"));
        assert!(!error.contains("Hebbian root"));
        assert!(!outside.join("accounts").exists());

        let legacy_home = tmp.path().join("legacy-home");
        let legacy_outside = tmp.path().join("legacy-outside");
        std::fs::create_dir(&legacy_home).unwrap();
        std::fs::create_dir(&legacy_outside).unwrap();
        std::os::unix::fs::symlink(&legacy_outside, legacy_home.join(".hebbian")).unwrap();
        let error =
            create_account_profile_directory("codex", legacy_home.to_str().unwrap(), "work")
                .unwrap_err();
        assert!(error.starts_with("credential_directory_untrusted:"));
        assert!(!legacy_home.join(".dure").exists());
        assert!(!legacy_outside.join("accounts").exists());

        let unmigrated_home = tmp.path().join("unmigrated-home");
        std::fs::create_dir(&unmigrated_home).unwrap();
        std::fs::create_dir(unmigrated_home.join(".hebbian")).unwrap();
        let error =
            create_account_profile_directory("codex", unmigrated_home.to_str().unwrap(), "work")
                .unwrap_err();
        assert!(error.starts_with("credential_directory_untrusted:"));
        assert!(error.contains("must be migrated to .dure"));
        assert!(!unmigrated_home.join(".dure").exists());
    }

    #[test]
    fn managed_codex_profile_resolves_to_private_auth_and_shared_sqlite_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account = home.join(".dure/accounts/codex-crispy");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&account).unwrap();

        let environment = managed_provider_state_environment(
            "codex",
            home.to_str().unwrap(),
            Some("acc-crispy"),
            Some(account.to_str().unwrap()),
        )
        .unwrap();

        assert_eq!(
            environment.values().get("CODEX_HOME").map(String::as_str),
            std::fs::canonicalize(&account).unwrap().to_str()
        );
        assert_eq!(
            environment
                .values()
                .get("CODEX_SQLITE_HOME")
                .map(String::as_str),
            std::fs::canonicalize(&canonical).unwrap().to_str()
        );
    }

    #[cfg(unix)]
    #[test]
    fn prepare_claude_profile_shares_reviewed_state_but_not_auth_or_identity_metadata() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".claude");
        let account = home.join(".dure/accounts/claude-work");
        std::fs::create_dir_all(canonical.join("projects")).unwrap();
        std::fs::create_dir_all(canonical.join("plugins")).unwrap();
        std::fs::create_dir_all(canonical.join("skills")).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(canonical.join("history.jsonl"), b"shared-history\n").unwrap();
        std::fs::write(canonical.join("settings.json"), b"{\"theme\":\"shared\"}").unwrap();
        std::fs::write(
            home.join(".claude.json"),
            b"{\"oauthAccount\":\"canonical\"}",
        )
        .unwrap();
        std::fs::write(account.join(".credentials.json"), b"{\"account\":\"work\"}").unwrap();
        std::fs::write(account.join(".claude.json"), b"{\"oauthAccount\":\"work\"}").unwrap();
        std::fs::set_permissions(
            account.join(".credentials.json"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();

        let environment = prepare_managed_provider_profile(
            "claude",
            home.to_str().unwrap(),
            Some("acc-work"),
            Some(account.to_str().unwrap()),
        )
        .unwrap();

        assert_eq!(
            environment
                .values()
                .get("CLAUDE_CONFIG_DIR")
                .map(String::as_str),
            std::fs::canonicalize(&account).unwrap().to_str()
        );
        let canonical_resolved = std::fs::canonicalize(&canonical).unwrap();
        for name in ["projects", "plugins", "skills"] {
            assert_eq!(
                std::fs::read_link(account.join(name)).unwrap(),
                canonical_resolved.join(name)
            );
        }
        let canonical_history = std::fs::metadata(canonical.join("history.jsonl")).unwrap();
        let account_history = std::fs::metadata(account.join("history.jsonl")).unwrap();
        assert_eq!(
            (canonical_history.dev(), canonical_history.ino()),
            (account_history.dev(), account_history.ino())
        );
        assert_eq!(
            std::fs::read(account.join("settings.json")).unwrap(),
            b"{\"theme\":\"shared\"}"
        );
        assert_eq!(
            std::fs::read(account.join(".credentials.json")).unwrap(),
            b"{\"account\":\"work\"}"
        );
        assert_eq!(
            std::fs::metadata(account.join(".credentials.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::read(account.join(".claude.json")).unwrap(),
            b"{\"oauthAccount\":\"work\"}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn current_legacy_claude_profile_is_upgraded_without_replacing_private_state() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".claude");
        let account = home.join(".dure/accounts/claude-legacy");
        std::fs::create_dir_all(canonical.join("projects")).unwrap();
        std::fs::create_dir_all(canonical.join("plugins")).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::os::unix::fs::symlink(
            std::fs::canonicalize(canonical.join("projects")).unwrap(),
            account.join("projects"),
        )
        .unwrap();
        std::fs::write(account.join(".claude.json"), b"{\"profile\":\"legacy\"}").unwrap();

        let prepared =
            create_account_profile_directory("claude", home.to_str().unwrap(), "legacy").unwrap();

        assert_eq!(prepared, std::fs::canonicalize(&account).unwrap());
        assert_eq!(
            std::fs::read_link(account.join("projects")).unwrap(),
            std::fs::canonicalize(canonical.join("projects")).unwrap()
        );
        assert_eq!(
            std::fs::read_link(account.join("plugins")).unwrap(),
            std::fs::canonicalize(canonical.join("plugins")).unwrap()
        );
        assert_eq!(
            std::fs::read(account.join(".claude.json")).unwrap(),
            b"{\"profile\":\"legacy\"}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn claude_file_credentials_are_profile_local_owner_only() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".claude");
        let account = home.join(".dure/accounts/claude-work");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(canonical.join(".credentials.json"), b"canonical-secret").unwrap();
        std::fs::hard_link(
            canonical.join(".credentials.json"),
            account.join(".credentials.json"),
        )
        .unwrap();

        let error = prepare_managed_provider_profile(
            "claude",
            home.to_str().unwrap(),
            Some("acc-work"),
            Some(account.to_str().unwrap()),
        )
        .unwrap_err();
        assert!(error.starts_with("credential_file_untrusted:"));
        assert_eq!(
            std::fs::read(canonical.join(".credentials.json")).unwrap(),
            b"canonical-secret"
        );

        std::fs::remove_file(account.join(".credentials.json")).unwrap();
        std::fs::write(account.join(".credentials.json"), b"profile-secret").unwrap();
        prepare_managed_provider_profile(
            "claude",
            home.to_str().unwrap(),
            Some("acc-work"),
            Some(account.to_str().unwrap()),
        )
        .unwrap();
        let metadata = std::fs::metadata(account.join(".credentials.json")).unwrap();
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn outbound_credential_read_is_backend_allowlisted_owner_only_and_bounded() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account = home.join(".dure/accounts/codex-work");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(account.join("auth.json"), b"reviewed-credential").unwrap();
        std::fs::set_permissions(
            account.join("auth.json"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();

        let (name, bytes) =
            read_profile_credential("codex", home.to_str().unwrap(), account.to_str().unwrap())
                .unwrap();
        assert_eq!(name, "auth.json");
        assert_eq!(bytes, b"reviewed-credential");
        assert_eq!(
            std::fs::metadata(account.join("auth.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        std::fs::write(
            account.join("auth.json"),
            vec![0_u8; MAX_TRANSFER_CREDENTIAL_BYTES as usize + 1],
        )
        .unwrap();
        let error =
            read_profile_credential("codex", home.to_str().unwrap(), account.to_str().unwrap())
                .unwrap_err();
        assert!(error.starts_with("credential_transfer_too_large:"));
    }

    #[test]
    fn managed_provider_profile_rejects_partial_or_unowned_references() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let account = home.join(".dure/accounts/codex-work");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&account).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        assert!(
            managed_provider_state_environment(
                "codex",
                home.to_str().unwrap(),
                Some("acc-work"),
                None,
            )
            .unwrap_err()
            .starts_with("credential_directory_required:")
        );
        assert!(
            managed_provider_state_environment(
                "codex",
                home.to_str().unwrap(),
                None,
                Some(account.to_str().unwrap()),
            )
            .unwrap_err()
            .starts_with("credential_reference_required:")
        );
        assert!(
            managed_provider_state_environment(
                "codex",
                home.to_str().unwrap(),
                Some("acc-outside"),
                Some(outside.to_str().unwrap()),
            )
            .unwrap_err()
            .starts_with("credential_directory_untrusted:")
        );
    }

    #[cfg(unix)]
    #[test]
    fn prepare_codex_profile_builds_only_reviewed_shared_state_and_hardens_credentials() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account = home.join(".dure/accounts/codex-work");
        std::fs::create_dir_all(canonical.join("sessions")).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(canonical.join("auth.json"), b"{\"account\":\"canonical\"}").unwrap();
        std::fs::write(canonical.join("config.toml"), b"model='shared'").unwrap();
        std::fs::write(canonical.join("history.jsonl"), b"shared-history\n").unwrap();
        std::fs::write(canonical.join("state_5.sqlite"), b"canonical-db").unwrap();
        std::fs::write(canonical.join("future-provider-state.json"), b"unknown").unwrap();
        std::fs::create_dir(canonical.join("future-provider-state")).unwrap();
        std::fs::write(account.join("auth.json"), b"{\"account\":\"work\"}").unwrap();
        std::fs::set_permissions(
            account.join("auth.json"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();

        let environment = prepare_managed_provider_profile(
            "codex",
            home.to_str().unwrap(),
            Some("acc-work"),
            Some(account.to_str().unwrap()),
        )
        .unwrap();

        let canonical_resolved = std::fs::canonicalize(&canonical).unwrap();
        let canonical_string = canonical_resolved.to_string_lossy().into_owned();
        assert_eq!(
            environment.values().get("CODEX_SQLITE_HOME"),
            Some(&canonical_string)
        );
        assert!(
            account
                .join("sessions")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            std::fs::read_link(account.join("sessions")).unwrap(),
            canonical_resolved.join("sessions")
        );
        assert_eq!(
            std::fs::read(account.join("config.toml")).unwrap(),
            b"model='shared'"
        );
        let canonical_history = std::fs::metadata(canonical.join("history.jsonl")).unwrap();
        let account_history = std::fs::metadata(account.join("history.jsonl")).unwrap();
        assert_eq!(
            (canonical_history.dev(), canonical_history.ino()),
            (account_history.dev(), account_history.ino())
        );
        assert!(!account.join("state_5.sqlite").exists());
        assert!(!account.join("future-provider-state.json").exists());
        assert!(!account.join("future-provider-state").exists());
        assert_eq!(
            std::fs::metadata(&account).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(account.join("auth.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::read(account.join("auth.json")).unwrap(),
            b"{\"account\":\"work\"}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn prepare_codex_profile_refuses_and_preserves_a_wrong_existing_target() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account = home.join(".dure/accounts/codex-work");
        let wrong = home.join("wrong-sessions");
        std::fs::create_dir_all(canonical.join("sessions")).unwrap();
        std::fs::create_dir_all(&wrong).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::os::unix::fs::symlink(&wrong, account.join("sessions")).unwrap();

        let error = prepare_managed_provider_profile(
            "codex",
            home.to_str().unwrap(),
            Some("acc-work"),
            Some(account.to_str().unwrap()),
        )
        .unwrap_err();

        assert!(error.starts_with("credential_overlay_wrong_target:"));
        assert_eq!(std::fs::read_link(account.join("sessions")).unwrap(), wrong);
    }

    #[cfg(unix)]
    #[test]
    fn prepare_codex_profile_rolls_back_only_new_entries_after_injected_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account = home.join(".dure/accounts/codex-work");
        std::fs::create_dir_all(canonical.join("sessions")).unwrap();
        std::fs::create_dir_all(canonical.join("skills")).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(account.join("auth.json"), b"keep-me").unwrap();

        let error = prepare_codex_overlay_for_test(&home, &account, Some(1)).unwrap_err();

        assert!(error.starts_with("credential_overlay_fault_injected:"));
        assert_eq!(
            std::fs::read(account.join("auth.json")).unwrap(),
            b"keep-me"
        );
        assert!(!account.join("sessions").exists());
        assert!(!account.join("skills").exists());
    }

    #[cfg(unix)]
    #[test]
    fn prepare_codex_profile_restores_replaced_config_after_injected_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account = home.join(".dure/accounts/codex-work");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(canonical.join("config.toml"), b"shared=true").unwrap();
        std::fs::write(account.join("config.toml"), b"prior=true").unwrap();

        let error = prepare_codex_overlay_for_test(&home, &account, Some(1)).unwrap_err();

        assert!(error.starts_with("credential_overlay_fault_injected:"));
        assert_eq!(
            std::fs::read(account.join("config.toml")).unwrap(),
            b"prior=true"
        );
        assert!(std::fs::read_dir(&account).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".hebbian-overlay-")
        }));
    }

    #[cfg(unix)]
    #[test]
    fn prepare_codex_profile_refuses_wrong_entry_type_and_profile_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account_root = home.join(".dure/accounts");
        let account = account_root.join("codex-work");
        std::fs::create_dir_all(canonical.join("sessions")).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::create_dir(account.join("sessions")).unwrap();

        let wrong_type = prepare_managed_provider_profile(
            "codex",
            home.to_str().unwrap(),
            Some("acc-work"),
            Some(account.to_str().unwrap()),
        )
        .unwrap_err();
        assert!(wrong_type.starts_with("credential_overlay_wrong_type:"));
        assert!(account.join("sessions").is_dir());

        let linked_profile = account_root.join("codex-linked");
        std::os::unix::fs::symlink(&account, &linked_profile).unwrap();
        let profile_error = prepare_managed_provider_profile(
            "codex",
            home.to_str().unwrap(),
            Some("acc-linked"),
            Some(linked_profile.to_str().unwrap()),
        )
        .unwrap_err();
        assert!(profile_error.starts_with("credential_directory_untrusted:"));
        assert!(
            linked_profile
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn prepare_codex_profile_rejects_a_hard_linked_credential() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account = home.join(".dure/accounts/codex-work");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(canonical.join("auth.json"), b"canonical-secret").unwrap();
        std::fs::hard_link(canonical.join("auth.json"), account.join("auth.json")).unwrap();

        let error = prepare_managed_provider_profile(
            "codex",
            home.to_str().unwrap(),
            Some("acc-work"),
            Some(account.to_str().unwrap()),
        )
        .unwrap_err();

        assert!(error.starts_with("credential_file_untrusted:"));
        assert_eq!(
            std::fs::read(canonical.join("auth.json")).unwrap(),
            b"canonical-secret"
        );
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_codex_profile_prepare_is_serialized_and_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let canonical = home.join(".codex");
        let account = home.join(".dure/accounts/codex-work");
        std::fs::create_dir_all(canonical.join("sessions")).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(canonical.join("config.toml"), b"shared=true").unwrap();

        let home_a = home.clone();
        let account_a = account.clone();
        let first =
            std::thread::spawn(move || prepare_codex_overlay_for_test(&home_a, &account_a, None));
        let home_b = home.clone();
        let account_b = account.clone();
        let second =
            std::thread::spawn(move || prepare_codex_overlay_for_test(&home_b, &account_b, None));

        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();
        assert_eq!(
            std::fs::read_link(account.join("sessions")).unwrap(),
            std::fs::canonicalize(&canonical).unwrap().join("sessions")
        );
        assert_eq!(
            std::fs::read(account.join("config.toml")).unwrap(),
            b"shared=true"
        );
    }
}
