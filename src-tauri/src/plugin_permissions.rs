//! Hardened local persistence for plugin permission decisions.
//!
//! This adapter owns the machine-local workspace pseudonym and the durable
//! decision journal. It deliberately does not expose the HMAC key, accept a
//! workspace identity from IPC, or execute plugin/native code.

#[path = "plugin_permission_compaction.rs"]
mod compaction;
#[path = "plugin_permission_callback.rs"]
mod callback;
#[path = "plugin_permission_journal.rs"]
mod journal;
#[path = "plugin_permission_store_io.rs"]
mod store_io;

use callback::*;
use journal::*;
use store_io::*;

use fs2::FileExt;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs::{DirBuilder, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock, Weak};
use subtle::ConstantTimeEq;

#[cfg(test)]
use std::cell::Cell;

use dure_app::{
    apply_plugin_permission_decision_event, apply_plugin_permission_decision_request,
    evaluate_plugin_permission_execution, revalidate_plugin_permission_execution_lease,
    PermissionKindIdV2, PluginIdV2, PluginPermissionDecisionEventDispositionV2,
    PluginPermissionDecisionEventBodyV2, PluginPermissionDecisionEventV2,
    PluginPermissionDecisionFoldCheckpointV2, PluginPermissionDecisionFoldV2,
    PluginPermissionDecisionKeyV2, PluginPermissionDecisionReplayBodyV2,
    PluginPermissionDecisionReplayReceiptV2,
    PluginPermissionDecisionRequestIdV2, PluginPermissionDecisionRequestV2,
    PluginPermissionDecisionStateV2, PluginPermissionDecisionV2, PluginPermissionEnablementV2,
    PluginPermissionExecutionLeaseV2, PluginPermissionPlanDigestV2, PluginPermissionPlanV2,
    PluginWorkspaceIdentityV2, MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2,
    MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2,
};

const STORE_DIRECTORY: &str = "plugin-permissions-v1";
const SECRET_FILE: &str = "workspace-hmac-v1.key";
const JOURNAL_FILE: &str = "decisions-v1.jsonl";
const LOCK_FILE: &str = "decisions-v1.lock";
const TRANSITION_LOCK_FILE: &str = "transitions-v1.lock";
const JOURNAL_SCHEMA_VERSION: u16 = 1;
const SECRET_BYTES: usize = 32;
const MAX_ACTIVE_JOURNAL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_JOURNAL_LINE_BYTES: usize = 16 * 1024;
const MAX_ACTIVE_JOURNAL_EVENTS: usize = 8_192;
const MAX_PERMISSION_KEYS: usize = 1_024;
const MAX_LEGACY_JOURNAL_BYTES: u64 = MAX_ACTIVE_JOURNAL_BYTES
    + (MAX_PERMISSION_KEYS as u64 * MAX_JOURNAL_LINE_BYTES as u64);
// Schema 1 keeps its historical 8 MiB active boundary. A compact checkpoint
// may retain one maximum review projection per admitted key, so schema 2 gets
// one additional reserve-sized active segment. Both formats still preserve a
// final physical segment for one maximum-size emergency disable per key.
const MAX_COMPACT_ACTIVE_JOURNAL_BYTES: u64 = MAX_LEGACY_JOURNAL_BYTES;
const MAX_JOURNAL_BYTES: u64 = MAX_COMPACT_ACTIVE_JOURNAL_BYTES
    + (MAX_PERMISSION_KEYS as u64 * MAX_JOURNAL_LINE_BYTES as u64);
const MAX_JOURNAL_EVENTS: usize = MAX_ACTIVE_JOURNAL_EVENTS + MAX_PERMISSION_KEYS;

#[cfg(test)]
std::thread_local! {
    static TEST_ACTIVE_JOURNAL_BYTE_LIMITS: Cell<Option<(u64, u64)>> = const {
        Cell::new(None)
    };
}

#[cfg(test)]
struct TestJournalByteLimitsGuard(Option<(u64, u64)>);

#[cfg(test)]
impl Drop for TestJournalByteLimitsGuard {
    fn drop(&mut self) {
        TEST_ACTIVE_JOURNAL_BYTE_LIMITS.with(|limits| limits.set(self.0));
    }
}

#[cfg(test)]
fn test_journal_byte_limits(legacy: u64, compact: u64) -> TestJournalByteLimitsGuard {
    let previous = TEST_ACTIVE_JOURNAL_BYTE_LIMITS.with(|limits| limits.replace(Some((legacy, compact))));
    TestJournalByteLimitsGuard(previous)
}

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PluginPermissionStoreError {
    code: &'static str,
    detail: String,
}

impl PluginPermissionStoreError {
    fn new(code: &'static str, detail: impl std::fmt::Display) -> Self {
        Self {
            code,
            detail: detail.to_string(),
        }
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for PluginPermissionStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code(), self.detail)
    }
}

impl std::error::Error for PluginPermissionStoreError {}

type StoreResult<T> = Result<T, PluginPermissionStoreError>;

fn io_error(action: &str, path: &Path, error: std::io::Error) -> PluginPermissionStoreError {
    PluginPermissionStoreError::new(
        "plugin_permission_store_io",
        format!("{action} {}: {error}", path.display()),
    )
}

fn untrusted(path: &Path, detail: impl std::fmt::Display) -> PluginPermissionStoreError {
    PluginPermissionStoreError::new(
        "plugin_permission_store_untrusted",
        format!("{} {detail}", path.display()),
    )
}

fn invalid_journal(detail: impl std::fmt::Display) -> PluginPermissionStoreError {
    PluginPermissionStoreError::new("plugin_permission_journal_invalid", detail)
}

fn too_large(detail: impl std::fmt::Display) -> PluginPermissionStoreError {
    PluginPermissionStoreError::new("plugin_permission_journal_too_large", detail)
}

fn active_capacity_exhausted(detail: impl std::fmt::Display) -> PluginPermissionStoreError {
    PluginPermissionStoreError::new(
        "plugin_permission_journal_active_capacity_exhausted",
        detail,
    )
}

fn current_uid() -> u32 {
    // SAFETY: `geteuid` has no preconditions and does not borrow memory.
    unsafe { libc::geteuid() }
}

fn exact_mode(metadata: &std::fs::Metadata, expected: u32) -> bool {
    metadata.mode() & 0o7777 == expected
}

fn trusted_directory_shape(
    is_symlink: bool,
    is_directory: bool,
    owner_uid: u32,
    mode: u32,
) -> bool {
    !is_symlink && is_directory && owner_uid == current_uid() && mode & 0o7777 == 0o700
}

fn trusted_file_shape(is_file: bool, owner_uid: u32, links: u64, mode: u32) -> bool {
    is_file && owner_uid == current_uid() && links == 1 && mode & 0o7777 == 0o600
}

fn validate_owned_directory(path: &Path) -> StoreResult<()> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| io_error("inspect directory", path, error))?;
    if !trusted_directory_shape(
        metadata.file_type().is_symlink(),
        metadata.is_dir(),
        metadata.uid(),
        metadata.mode(),
    ) {
        return Err(untrusted(
            path,
            "must be a real 0700 directory owned by the current user",
        ));
    }
    Ok(())
}

fn validate_control_root(path: &Path) -> StoreResult<PathBuf> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| io_error("canonicalize app-channel control root", path, error))?;
    let metadata = std::fs::symlink_metadata(&canonical)
        .map_err(|error| io_error("inspect app-channel control root", &canonical, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || metadata.uid() != current_uid() {
        return Err(untrusted(
            &canonical,
            "must resolve to a real directory owned by the current user",
        ));
    }
    Ok(canonical)
}

fn open_owned_file(path: &Path, writable: bool) -> StoreResult<File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(writable)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let file = options
        .open(path)
        .map_err(|error| io_error("open protected file", path, error))?;
    validate_open_file(path, &file)?;
    Ok(file)
}

fn validate_open_file(path: &Path, file: &File) -> StoreResult<()> {
    let metadata = file
        .metadata()
        .map_err(|error| io_error("inspect protected file", path, error))?;
    if !trusted_file_shape(
        metadata.is_file(),
        metadata.uid(),
        metadata.nlink(),
        metadata.mode(),
    ) {
        return Err(untrusted(
            path,
            "must be a singly linked 0600 regular file owned by the current user",
        ));
    }
    Ok(())
}

fn create_owned_file(path: &Path) -> StoreResult<File> {
    let file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| io_error("create protected file", path, error))?;
    validate_open_file(path, &file)?;
    Ok(file)
}

fn sync_directory(path: &Path) -> StoreResult<()> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| io_error("sync directory", path, error))
}

fn random_suffix() -> StoreResult<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| {
        PluginPermissionStoreError::new("plugin_permission_store_random_unavailable", error)
    })?;
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(encoded)
}

fn cleanup_initialization_directory(path: &Path) {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != current_uid()
        || !exact_mode(&metadata, 0o700)
    {
        return;
    }
    for name in [SECRET_FILE, JOURNAL_FILE, LOCK_FILE, TRANSITION_LOCK_FILE] {
        let candidate = path.join(name);
        if let Ok(metadata) = std::fs::symlink_metadata(&candidate) {
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.uid() == current_uid()
                && metadata.nlink() == 1
            {
                let _ = std::fs::remove_file(candidate);
            }
        }
    }
    let _ = std::fs::remove_dir(path);
}

fn initialize_store(control_root: &Path, store_directory: &Path) -> StoreResult<()> {
    let suffix = random_suffix()?;
    let staging = control_root.join(format!(".{STORE_DIRECTORY}.init-{suffix}"));
    DirBuilder::new()
        .mode(0o700)
        .create(&staging)
        .map_err(|error| io_error("create permission store staging directory", &staging, error))?;

    let initialize_staging = || -> StoreResult<()> {
        validate_owned_directory(&staging)?;
        let mut secret = [0u8; SECRET_BYTES];
        getrandom::fill(&mut secret).map_err(|error| {
            PluginPermissionStoreError::new("plugin_permission_store_random_unavailable", error)
        })?;

        let mut key_file = create_owned_file(&staging.join(SECRET_FILE))?;
        key_file
            .write_all(&secret)
            .and_then(|_| key_file.sync_all())
            .map_err(|error| {
                io_error(
                    "initialize workspace HMAC key",
                    &staging.join(SECRET_FILE),
                    error,
                )
            })?;
        create_owned_file(&staging.join(JOURNAL_FILE))?
            .sync_all()
            .map_err(|error| {
                io_error(
                    "initialize permission journal",
                    &staging.join(JOURNAL_FILE),
                    error,
                )
            })?;
        let mut lock_file = create_owned_file(&staging.join(LOCK_FILE))?;
        lock_file
            .write_all(&Sha256::digest(secret))
            .and_then(|_| lock_file.sync_all())
            .map_err(|error| {
                io_error(
                    "initialize permission lock",
                    &staging.join(LOCK_FILE),
                    error,
                )
            })?;
        create_owned_file(&staging.join(TRANSITION_LOCK_FILE))?
            .sync_all()
            .map_err(|error| {
                io_error(
                    "initialize permission transition lock",
                    &staging.join(TRANSITION_LOCK_FILE),
                    error,
                )
            })?;
        sync_directory(&staging)
    };

    if let Err(error) = initialize_staging() {
        cleanup_initialization_directory(&staging);
        return Err(error);
    }

    match std::fs::rename(&staging, store_directory) {
        Ok(()) => sync_directory(control_root),
        Err(error)
            if error
                .raw_os_error()
                .is_some_and(|code| code == libc::EEXIST || code == libc::ENOTEMPTY) =>
        {
            cleanup_initialization_directory(&staging);
            validate_owned_directory(store_directory)?;
            sync_directory(control_root)
        }
        Err(error) => {
            cleanup_initialization_directory(&staging);
            Err(io_error(
                "publish permission store directory",
                store_directory,
                error,
            ))
        }
    }
}

fn resolve_store_directory(control_root: &Path) -> StoreResult<PathBuf> {
    let control_root = validate_control_root(control_root)?;
    let store_directory = control_root.join(STORE_DIRECTORY);
    match std::fs::symlink_metadata(&store_directory) {
        Ok(_) => validate_owned_directory(&store_directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            initialize_store(&control_root, &store_directory)?;
            validate_owned_directory(&store_directory)?;
        }
        Err(error) => {
            return Err(io_error(
                "inspect permission store directory",
                &store_directory,
                error,
            ));
        }
    }
    ensure_transition_lock(&store_directory)?;
    Ok(store_directory)
}

fn ensure_transition_lock(directory: &Path) -> StoreResult<()> {
    let path = directory.join(TRANSITION_LOCK_FILE);
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {
            open_owned_file(&path, false)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let created = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&path);
            match created {
                Ok(file) => {
                    validate_open_file(&path, &file)?;
                    file.sync_all().map_err(|error| {
                        io_error("initialize permission transition lock", &path, error)
                    })?;
                    sync_directory(directory)
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    open_owned_file(&path, false)?;
                    Ok(())
                }
                Err(error) => Err(io_error(
                    "initialize permission transition lock",
                    &path,
                    error,
                )),
            }
        }
        Err(error) => Err(io_error(
            "inspect permission transition lock",
            &path,
            error,
        )),
    }
}

fn read_secret(directory: &Path) -> StoreResult<[u8; SECRET_BYTES]> {
    let path = directory.join(SECRET_FILE);
    let mut file = open_owned_file(&path, false)?;
    let metadata = file
        .metadata()
        .map_err(|error| io_error("inspect workspace HMAC key", &path, error))?;
    if metadata.len() != SECRET_BYTES as u64 {
        return Err(untrusted(
            &path,
            format!("must contain exactly {SECRET_BYTES} bytes"),
        ));
    }
    let mut secret = [0u8; SECRET_BYTES];
    file.read_exact(&mut secret)
        .map_err(|error| io_error("read workspace HMAC key", &path, error))?;
    let mut extra = [0u8; 1];
    if file
        .read(&mut extra)
        .map_err(|error| io_error("bound workspace HMAC key", &path, error))?
        != 0
    {
        return Err(untrusted(
            &path,
            format!("must contain exactly {SECRET_BYTES} bytes"),
        ));
    }
    Ok(secret)
}

fn verify_secret_commitment(
    lock_path: &Path,
    lock: &mut File,
    secret: &[u8; SECRET_BYTES],
) -> StoreResult<()> {
    let metadata = lock
        .metadata()
        .map_err(|error| io_error("inspect permission lock commitment", lock_path, error))?;
    if metadata.len() < SECRET_BYTES as u64 {
        return Err(untrusted(
            lock_path,
            format!("must begin with {SECRET_BYTES} commitment bytes"),
        ));
    }
    let mut commitment = [0u8; SECRET_BYTES];
    lock.seek(SeekFrom::Start(0))
        .and_then(|_| lock.read_exact(&mut commitment))
        .map_err(|error| io_error("read permission lock commitment", lock_path, error))?;
    let expected = Sha256::digest(secret);
    if !bool::from(commitment.ct_eq(expected.as_slice())) {
        return Err(untrusted(
            lock_path,
            "does not match the immutable workspace HMAC key",
        ));
    }
    Ok(())
}

fn canonical_workspace_root(workspace_root: &Path) -> StoreResult<PathBuf> {
    let metadata = std::fs::symlink_metadata(workspace_root)
        .map_err(|error| io_error("inspect workspace root", workspace_root, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(PluginPermissionStoreError::new(
            "plugin_permission_workspace_invalid",
            format!(
                "{} must be an existing non-symlink directory",
                workspace_root.display()
            ),
        ));
    }
    let canonical = std::fs::canonicalize(workspace_root)
        .map_err(|error| io_error("canonicalize workspace root", workspace_root, error))?;
    let canonical_metadata = std::fs::symlink_metadata(&canonical)
        .map_err(|error| io_error("inspect canonical workspace root", &canonical, error))?;
    if canonical_metadata.file_type().is_symlink() || !canonical_metadata.is_dir() {
        return Err(PluginPermissionStoreError::new(
            "plugin_permission_workspace_invalid",
            format!(
                "{} did not resolve to a real directory",
                workspace_root.display()
            ),
        ));
    }
    Ok(canonical)
}

fn workspace_hmac(secret: &[u8; SECRET_BYTES], canonical_root: &Path) -> StoreResult<String> {
    const DOMAIN: &[u8] = b"dure.plugin.workspace.v1\0";
    let path = canonical_root.as_os_str().as_bytes();
    let path_len = u64::try_from(path.len()).map_err(|_| {
        PluginPermissionStoreError::new(
            "plugin_permission_workspace_invalid",
            "canonical workspace path exceeds the HMAC framing limit",
        )
    })?;
    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| {
        PluginPermissionStoreError::new(
            "plugin_permission_store_untrusted",
            "workspace HMAC key has an invalid length",
        )
    })?;
    mac.update(DOMAIN);
    mac.update(&path_len.to_be_bytes());
    mac.update(path);
    let digest = mac.finalize().into_bytes();
    let mut identity = String::with_capacity("sha256:".len() + digest.len() * 2);
    identity.push_str("sha256:");
    for byte in digest {
        write!(&mut identity, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(identity)
}

#[derive(Debug)]
struct PluginPermissionStore {
    directory: PathBuf,
}

impl PluginPermissionStore {
    fn open_default() -> StoreResult<Self> {
        let channel = crate::app_channel::current().map_err(|error| {
            PluginPermissionStoreError::new("plugin_permission_store_unavailable", error)
        })?;
        Self::open_at(&channel.control_dir)
    }

    fn open_at(control_root: &Path) -> StoreResult<Self> {
        let directory = resolve_store_directory(control_root)?;
        // Opening the full store here rejects a partially initialized or
        // corrupted store instead of turning it into an empty authority.
        let store = Self { directory };
        store.load()?;
        Ok(store)
    }

    #[cfg(test)]
    fn workspace_identity_string(&self, workspace_root: &Path) -> StoreResult<String> {
        let journal = LockedJournal::open(&self.directory)?;
        journal
            .workspace_identity(workspace_root)
            .map(|(_, identity)| identity)
    }

    fn resolve_workspace(
        &self,
        workspace_root: &Path,
    ) -> StoreResult<ResolvedPluginPermissionWorkspace> {
        let journal = LockedJournal::open(&self.directory)?;
        let (canonical_root, identity) = journal.workspace_identity(workspace_root)?;
        let identity = PluginWorkspaceIdentityV2::from_host_hmac(identity).map_err(|error| {
            PluginPermissionStoreError::new(
                "plugin_permission_workspace_invalid",
                format!("derived workspace identity was rejected: {error}"),
            )
        })?;
        Ok(ResolvedPluginPermissionWorkspace {
            identity,
            canonical_root,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedPluginPermissionWorkspace {
    identity: PluginWorkspaceIdentityV2,
    canonical_root: PathBuf,
}

impl ResolvedPluginPermissionWorkspace {
    pub(crate) fn identity(&self) -> &PluginWorkspaceIdentityV2 {
        &self.identity
    }

    pub(crate) fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ExecutionGateKey {
    workspace_identity: String,
    plugin_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedPluginPermissionTarget {
    workspace: ResolvedPluginPermissionWorkspace,
    plugin_id: PluginIdV2,
    gate_key: ExecutionGateKey,
}

impl ResolvedPluginPermissionTarget {
    pub(crate) fn workspace(&self) -> &ResolvedPluginPermissionWorkspace {
        &self.workspace
    }

    pub(crate) fn decision_key(&self) -> PluginPermissionDecisionKeyV2 {
        PluginPermissionDecisionKeyV2::new(
            self.workspace.identity().clone(),
            self.plugin_id.clone(),
        )
    }
}

pub(crate) struct PluginPermissionDecisionCas<'a> {
    request_id: PluginPermissionDecisionRequestIdV2,
    expected_record_revision: u64,
    expected_plan_digest: &'a PluginPermissionPlanDigestV2,
    current_plan: &'a PluginPermissionPlanV2,
    decision: PluginPermissionDecisionV2,
}

impl<'a> PluginPermissionDecisionCas<'a> {
    pub(crate) fn new(
        request_id: PluginPermissionDecisionRequestIdV2,
        expected_record_revision: u64,
        expected_plan_digest: &'a PluginPermissionPlanDigestV2,
        current_plan: &'a PluginPermissionPlanV2,
        decision: PluginPermissionDecisionV2,
    ) -> Self {
        Self {
            request_id,
            expected_record_revision,
            expected_plan_digest,
            current_plan,
            decision,
        }
    }
}

pub(crate) struct PluginPermissionExecutionRequest<'a> {
    current_plan: &'a PluginPermissionPlanV2,
    permission_kind: &'a PermissionKindIdV2,
    parameter: &'a str,
    value: &'a str,
}

impl<'a> PluginPermissionExecutionRequest<'a> {
    pub(crate) fn new(
        current_plan: &'a PluginPermissionPlanV2,
        permission_kind: &'a PermissionKindIdV2,
        parameter: &'a str,
        value: &'a str,
    ) -> Self {
        Self {
            current_plan,
            permission_kind,
            parameter,
            value,
        }
    }
}

#[derive(Debug)]
pub(crate) struct DurePluginPermissionState {
    store: PluginPermissionStore,
    execution_gates: Mutex<std::collections::HashMap<ExecutionGateKey, Weak<RwLock<()>>>>,
}

#[derive(Debug)]
pub(crate) struct PluginPermissionRetiringTransitionReceipt<T, R, E> {
    authoritative_transition: T,
    retirement: PluginPermissionRetirementOutcome<R, E>,
}

impl<T, R, E> PluginPermissionRetiringTransitionReceipt<T, R, E> {
    pub(crate) fn into_parts(self) -> (T, PluginPermissionRetirementOutcome<R, E>) {
        (self.authoritative_transition, self.retirement)
    }
}

#[derive(Debug)]
pub(crate) enum PluginPermissionRetirementOutcome<R, E> {
    Attempted(Result<R, E>),
    SkippedCurrentEnabled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PluginPermissionDisablePersistence {
    Recorded,
    RetirementRepairNoTransition,
}

#[derive(Debug)]
pub(crate) struct PluginPermissionDisableTransition {
    state: PluginPermissionDecisionStateV2,
    persistence: PluginPermissionDisablePersistence,
}

impl PluginPermissionDisableTransition {
    fn recorded(state: PluginPermissionDecisionStateV2) -> Self {
        Self {
            state,
            persistence: PluginPermissionDisablePersistence::Recorded,
        }
    }

    fn retirement_repair(state: PluginPermissionDecisionStateV2) -> Self {
        Self {
            state,
            persistence: PluginPermissionDisablePersistence::RetirementRepairNoTransition,
        }
    }

    pub(crate) fn state(&self) -> &PluginPermissionDecisionStateV2 {
        &self.state
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        PluginPermissionDecisionStateV2,
        PluginPermissionDisablePersistence,
    ) {
        (self.state, self.persistence)
    }
}

impl DurePluginPermissionState {
    pub(crate) fn open_default() -> StoreResult<Self> {
        reject_callback_reentry()?;
        PluginPermissionStore::open_default().map(Self::from_store)
    }

    #[cfg(test)]
    fn open_at(control_root: &Path) -> StoreResult<Self> {
        reject_callback_reentry()?;
        PluginPermissionStore::open_at(control_root).map(Self::from_store)
    }

    fn from_store(store: PluginPermissionStore) -> Self {
        Self {
            store,
            execution_gates: Mutex::new(std::collections::HashMap::new()),
        }
    }

    pub(crate) fn resolve_target(
        &self,
        workspace_root: &Path,
        plugin_id: &PluginIdV2,
    ) -> StoreResult<ResolvedPluginPermissionTarget> {
        reject_callback_reentry()?;
        let workspace = self.store.resolve_workspace(workspace_root)?;
        let gate_key = ExecutionGateKey {
            workspace_identity: workspace.identity().as_str().to_string(),
            plugin_id: plugin_id.as_str().to_string(),
        };
        Ok(ResolvedPluginPermissionTarget {
            workspace,
            plugin_id: plugin_id.clone(),
            gate_key,
        })
    }

    pub(crate) fn snapshot(
        &self,
        target: &ResolvedPluginPermissionTarget,
    ) -> StoreResult<PluginPermissionDecisionStateV2> {
        reject_callback_reentry()?;
        let gate = self.execution_gate(target)?;
        let _guard = gate.read().map_err(|_| {
            PluginPermissionStoreError::new(
                "plugin_permission_execution_gate_poisoned",
                "plugin permission execution gate is poisoned",
            )
        })?;
        self.store.snapshot(target)
    }

    pub(crate) fn decide_with_retirement<R, E>(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request: PluginPermissionDecisionCas<'_>,
        retire: impl FnOnce(&PluginPermissionDecisionStateV2) -> Result<R, E>,
    ) -> Result<PluginPermissionRetiringTransitionReceipt<PluginPermissionDecisionStateV2, R, E>, E>
    where
        E: From<PluginPermissionStoreError>,
    {
        let recovery_request_id = request.request_id.clone();
        let mutation_request_id = request.request_id;
        let expected_record_revision = request.expected_record_revision;
        let expected_plan_digest = request.expected_plan_digest;
        let current_plan = request.current_plan;
        let decision = request.decision;
        self.with_retiring_transition(
            target,
            move |store| {
                match store.decide(
                        target,
                        mutation_request_id,
                        expected_record_revision,
                        expected_plan_digest,
                        current_plan,
                        decision,
                    ) {
                    Ok(state) => Ok(state),
                    Err(original_error)
                        if original_error.code() == "plugin_permission_store_io" =>
                    {
                        match store.recover_decision_transition(
                            target,
                            &recovery_request_id,
                            expected_record_revision,
                            current_plan,
                            decision,
                        ) {
                            Ok(Some(state)) => Ok(state),
                            Ok(None) | Err(_) => Err(E::from(original_error)),
                        }
                    }
                    Err(error) => Err(E::from(error)),
                }
            },
            |current| current.enablement() == PluginPermissionEnablementV2::Disabled,
            retire,
        )
    }

    pub(crate) fn disable_with_retirement<R, E>(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request_id: PluginPermissionDecisionRequestIdV2,
        retire: impl FnOnce(&PluginPermissionDecisionStateV2) -> Result<R, E>,
    ) -> Result<PluginPermissionRetiringTransitionReceipt<PluginPermissionDisableTransition, R, E>, E>
    where
        E: From<PluginPermissionStoreError>,
    {
        reject_callback_reentry().map_err(E::from)?;
        let _transition_guard = self.store.lock_transition().map_err(E::from)?;
        let gate = self.execution_gate(target).map_err(E::from)?;
        let _guard = gate.write().map_err(|_| {
            E::from(PluginPermissionStoreError::new(
                "plugin_permission_execution_gate_poisoned",
                "plugin permission execution gate is poisoned",
            ))
        })?;
        let transition = match self
            .store
            .disable_transition_unconditionally(target, request_id.clone())
        {
            Ok(transition) => transition,
            Err(original_error) if original_error.code() == "plugin_permission_store_io" => {
                match self
                    .store
                    .recover_disable_transition(target, &request_id)
                {
                    Ok(Some(transition)) => transition,
                    Ok(None) | Err(_) => return Err(E::from(original_error)),
                }
            }
            Err(error) => return Err(E::from(error)),
        };
        let retirement = {
            let _callback_scope = PermissionCallbackScope::enter().map_err(E::from)?;
            PluginPermissionRetirementOutcome::Attempted(retire(transition.state()))
        };
        Ok(PluginPermissionRetiringTransitionReceipt {
            authoritative_transition: transition,
            retirement,
        })
    }

    /// Enables only while holding the same exclusive fence used by disable and
    /// decision retirement, so no read-side execution can overlap the durable
    /// generation change.
    #[cfg(test)]
    pub(crate) fn enable(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request_id: PluginPermissionDecisionRequestIdV2,
        expected_record_revision: u64,
        expected_plan_digest: &PluginPermissionPlanDigestV2,
        current_plan: &PluginPermissionPlanV2,
    ) -> StoreResult<PluginPermissionDecisionStateV2> {
        reject_callback_reentry()?;
        let _transition_guard = self.store.lock_transition()?;
        let gate = self.execution_gate(target)?;
        let _guard = gate.write().map_err(|_| {
            PluginPermissionStoreError::new(
                "plugin_permission_execution_gate_poisoned",
                "plugin permission execution gate is poisoned",
            )
        })?;
        self.store.enable(
            target,
            request_id,
            expected_record_revision,
            expected_plan_digest,
            current_plan,
        )
    }

    /// Reconciles caller-owned runtime state before publishing a new durable
    /// enablement. Exact request replays return their authoritative state
    /// without stopping an already enabled runtime.
    pub(crate) fn enable_after_retirement<R, E>(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request_id: PluginPermissionDecisionRequestIdV2,
        expected_record_revision: u64,
        expected_plan_digest: &PluginPermissionPlanDigestV2,
        current_plan: &PluginPermissionPlanV2,
        retire: impl FnOnce() -> Result<R, E>,
    ) -> Result<PluginPermissionDecisionStateV2, E>
    where
        E: From<PluginPermissionStoreError>,
    {
        reject_callback_reentry().map_err(E::from)?;
        let _transition_guard = self.store.lock_transition().map_err(E::from)?;
        let gate = self.execution_gate(target).map_err(E::from)?;
        let _guard = gate.write().map_err(|_| {
            E::from(PluginPermissionStoreError::new(
                "plugin_permission_execution_gate_poisoned",
                "plugin permission execution gate is poisoned",
            ))
        })?;
        if let Some(current) = self
            .store
            .preflight_enable(
                target,
                &request_id,
                expected_record_revision,
                expected_plan_digest,
                current_plan,
            )
            .map_err(E::from)?
        {
            return Ok(current);
        }
        {
            let _callback_scope = PermissionCallbackScope::enter().map_err(E::from)?;
            retire()?;
        }
        match self.store.enable_after_preflight(
                target,
                request_id.clone(),
                expected_record_revision,
                expected_plan_digest,
                current_plan,
            )
        {
            Ok(state) => Ok(state),
            Err(original_error) if original_error.code() == "plugin_permission_store_io" => {
                match self.store.recover_enable_transition(
                    target,
                    &request_id,
                    expected_record_revision,
                    current_plan,
                ) {
                    Ok(Some(state)) => Ok(state),
                    Ok(None) | Err(_) => Err(E::from(original_error)),
                }
            }
            Err(error) => Err(E::from(error)),
        }
    }

    fn execution_gate(
        &self,
        target: &ResolvedPluginPermissionTarget,
    ) -> StoreResult<Arc<RwLock<()>>> {
        let mut gates = self.execution_gates.lock().map_err(|_| {
            PluginPermissionStoreError::new(
                "plugin_permission_execution_gate_poisoned",
                "plugin permission execution gate registry is poisoned",
            )
        })?;
        gates.retain(|_, gate| gate.strong_count() != 0);
        if let Some(gate) = gates.get(&target.gate_key).and_then(Weak::upgrade) {
            return Ok(gate);
        }
        if gates.len() >= MAX_PERMISSION_KEYS {
            return Err(PluginPermissionStoreError::new(
                "plugin_permission_execution_gate_capacity",
                format!("plugin permission execution gates exceed {MAX_PERMISSION_KEYS} live keys"),
            ));
        }
        let gate = Arc::new(RwLock::new(()));
        gates.insert(target.gate_key.clone(), Arc::downgrade(&gate));
        Ok(gate)
    }

    /// Authorizes, executes, revalidates, and publishes while holding both the
    /// per-workspace/plugin shared gate and the cross-process journal shared
    /// lock for the entire sequence.
    ///
    /// Watch callers put cache/event publication in `publish`; query callers
    /// use it to attach the lease epoch to their response. A disabling writer
    /// cannot begin its durable transition between any of these boundaries,
    /// even from another cooperative app process using the same channel.
    /// Both callbacks are synchronous, non-reentrant critical sections. They
    /// must not call a permission-state API or wait on another thread that
    /// does; same-thread reentry fails with a stable error instead of blocking.
    pub(crate) fn with_authorized_execution<T, R, E>(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request: PluginPermissionExecutionRequest<'_>,
        execute: impl FnOnce(&PluginPermissionExecutionLeaseV2) -> Result<T, E>,
        publish: impl FnOnce(T, &PluginPermissionExecutionLeaseV2) -> Result<R, E>,
    ) -> Result<R, E>
    where
        E: From<PluginPermissionStoreError>,
    {
        reject_callback_reentry().map_err(E::from)?;
        let gate = self.execution_gate(target).map_err(E::from)?;
        let _guard = gate.read().map_err(|_| {
            E::from(PluginPermissionStoreError::new(
                "plugin_permission_execution_gate_poisoned",
                "plugin permission execution gate is poisoned",
            ))
        })?;
        let mut journal = self.store.lock_execution().map_err(E::from)?;
        let lease = self
            .store
            .authorize_execution_locked(
                &journal,
                target,
                request.current_plan,
                request.permission_kind,
                request.parameter,
                request.value,
            )
            .map_err(E::from)?;
        let _callback_scope = PermissionCallbackScope::enter().map_err(E::from)?;
        let output = execute(&lease)?;
        journal.refresh().map_err(E::from)?;
        self.store
            .revalidate_execution_locked(&journal, target, request.current_plan, &lease)
            .map_err(E::from)?;
        publish(output, &lease)
    }

    /// Holds the exclusive execution fence across a durable transition and
    /// caller-owned runtime retirement.
    ///
    /// `transition` must complete its journal operation before it returns. Its
    /// internal file lock is therefore released before `retire` may acquire a
    /// runtime mutex. A retirement failure never rolls back the already durable
    /// disabling/decision transition; the exclusive fence is still held until
    /// the callback reports that failure. A decision exact replay whose
    /// authoritative current state is enabled skips retirement; disabled
    /// replays still retry it to heal a prior partial retirement.
    fn with_retiring_transition<T, R, E>(
        &self,
        target: &ResolvedPluginPermissionTarget,
        transition: impl FnOnce(&PluginPermissionStore) -> Result<T, E>,
        should_retire: impl FnOnce(&T) -> bool,
        retire: impl FnOnce(&T) -> Result<R, E>,
    ) -> Result<PluginPermissionRetiringTransitionReceipt<T, R, E>, E>
    where
        E: From<PluginPermissionStoreError>,
    {
        reject_callback_reentry().map_err(E::from)?;
        let _transition_guard = self.store.lock_transition().map_err(E::from)?;
        let gate = self.execution_gate(target).map_err(E::from)?;
        let _guard = gate.write().map_err(|_| {
            E::from(PluginPermissionStoreError::new(
                "plugin_permission_execution_gate_poisoned",
                "plugin permission execution gate is poisoned",
            ))
        })?;
        let transition = transition(&self.store)?;
        let retirement = if should_retire(&transition) {
            let _callback_scope = PermissionCallbackScope::enter().map_err(E::from)?;
            PluginPermissionRetirementOutcome::Attempted(retire(&transition))
        } else {
            PluginPermissionRetirementOutcome::SkippedCurrentEnabled
        };
        Ok(PluginPermissionRetiringTransitionReceipt {
            authoritative_transition: transition,
            retirement,
        })
    }
}

fn decision_error(error: impl std::fmt::Display) -> PluginPermissionStoreError {
    PluginPermissionStoreError::new("plugin_permission_decision_invalid", error)
}

fn execution_error(error: impl std::fmt::Display) -> PluginPermissionStoreError {
    PluginPermissionStoreError::new("plugin_permission_execution_denied", error)
}

impl PluginPermissionStore {
    fn ensure_plan_target(
        target: &ResolvedPluginPermissionTarget,
        plan: &PluginPermissionPlanV2,
    ) -> StoreResult<()> {
        if PluginPermissionDecisionKeyV2::from_plan(plan) != target.decision_key() {
            return Err(PluginPermissionStoreError::new(
                "plugin_permission_plan_target_mismatch",
                "the current permission plan does not belong to the internally derived workspace/plugin target",
            ));
        }
        Ok(())
    }

    fn ensure_reviewed_digest(
        current_plan: &PluginPermissionPlanV2,
        expected_plan_digest: &PluginPermissionPlanDigestV2,
    ) -> StoreResult<()> {
        if current_plan.digest() != expected_plan_digest {
            return Err(PluginPermissionStoreError::new(
                "plugin_permission_plan_changed",
                "the current permission plan differs from the plan reviewed by the user",
            ));
        }
        Ok(())
    }

    fn apply_request(
        &self,
        request: PluginPermissionDecisionRequestV2,
    ) -> StoreResult<PluginPermissionDecisionStateV2> {
        let mut journal = LockedJournal::open(&self.directory)?;
        Self::apply_request_locked(&mut journal, request, true)
    }

    fn apply_request_without_compaction(
        &self,
        request: PluginPermissionDecisionRequestV2,
    ) -> StoreResult<PluginPermissionDecisionStateV2> {
        let mut journal = LockedJournal::open(&self.directory)?;
        Self::apply_request_locked(&mut journal, request, false)
    }

    fn apply_request_locked(
        journal: &mut LockedJournal,
        request: PluginPermissionDecisionRequestV2,
        allow_compaction: bool,
    ) -> StoreResult<PluginPermissionDecisionStateV2> {
        let mut loaded = LoadedPermissionJournal::read(journal)?;
        let event_count = loaded.event_count;
        let format = loaded.format;
        let key = request.key().clone();
        let has_prior_request = loaded.prior_request(&key, request.request_id()).is_some();
        if !has_prior_request && event_count >= MAX_ACTIVE_JOURNAL_EVENTS {
            return Err(active_capacity_exhausted(
                "permission journal reached its regular lifetime event capacity",
            ));
        }
        if !has_prior_request
            && loaded.key_event_count(&key) >= MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2
        {
            return Err(active_capacity_exhausted(
                "plugin permission key reached its regular lifetime event capacity",
            ));
        }
        let application = apply_plugin_permission_decision_request(loaded.fold_mut(&key)?, request)
            .map_err(decision_error)?;
        let event_to_append = application.event_to_append().cloned();
        let state = application.state().clone();
        if let Some(event) = event_to_append {
            match append_envelope(journal, format, event_count, &event) {
                Ok(()) => {}
                Err(error)
                    if error.code()
                        == "plugin_permission_journal_active_capacity_exhausted"
                        && allow_compaction =>
                {
                    let required_tail_bytes = encode_envelope(event_count, &event)?.len();
                    let current = LoadedPermissionJournal::read(journal)?;
                    let (bytes, generation) = current.compacted_bytes(required_tail_bytes)?;
                    journal.publish_compacted_bytes(bytes, generation)?;
                    append_envelope(
                        journal,
                        PermissionJournalFormat::Compact { generation },
                        event_count,
                        &event,
                    )?;
                }
                Err(error) => return Err(error),
            }
        } else {
            // Exact replay is still a lifecycle transition authority. Pin an
            // unanchored legacy source before its caller may release the
            // journal lock and enter runtime retirement.
            journal.ensure_authority_anchor()?;
        }
        Ok(state)
    }

    fn load(&self) -> StoreResult<Vec<PluginPermissionDecisionStateV2>> {
        let journal = LockedJournal::open(&self.directory)?;
        let loaded = LoadedPermissionJournal::read(&journal)?;
        Ok(loaded
            .folds
            .into_iter()
            .map(PluginPermissionDecisionFoldV2::into_state)
            .collect())
    }

    fn snapshot(
        &self,
        target: &ResolvedPluginPermissionTarget,
    ) -> StoreResult<PluginPermissionDecisionStateV2> {
        let journal = LockedJournal::open(&self.directory)?;
        let loaded = LoadedPermissionJournal::read(&journal)?;
        Ok(loaded.state(&target.decision_key()))
    }

    fn decide(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request_id: PluginPermissionDecisionRequestIdV2,
        expected_record_revision: u64,
        expected_plan_digest: &PluginPermissionPlanDigestV2,
        current_plan: &PluginPermissionPlanV2,
        decision: PluginPermissionDecisionV2,
    ) -> StoreResult<PluginPermissionDecisionStateV2> {
        Self::ensure_plan_target(target, current_plan)?;
        Self::ensure_reviewed_digest(current_plan, expected_plan_digest)?;
        self.apply_request(PluginPermissionDecisionRequestV2::decide(
            request_id,
            expected_record_revision,
            current_plan,
            decision,
        ))
    }

    #[cfg(test)]
    fn enable(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request_id: PluginPermissionDecisionRequestIdV2,
        expected_record_revision: u64,
        expected_plan_digest: &PluginPermissionPlanDigestV2,
        current_plan: &PluginPermissionPlanV2,
    ) -> StoreResult<PluginPermissionDecisionStateV2> {
        Self::ensure_plan_target(target, current_plan)?;
        Self::ensure_reviewed_digest(current_plan, expected_plan_digest)?;
        self.apply_request(PluginPermissionDecisionRequestV2::enable(
            request_id,
            expected_record_revision,
            current_plan,
        ))
    }

    fn enable_after_preflight(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request_id: PluginPermissionDecisionRequestIdV2,
        expected_record_revision: u64,
        expected_plan_digest: &PluginPermissionPlanDigestV2,
        current_plan: &PluginPermissionPlanV2,
    ) -> StoreResult<PluginPermissionDecisionStateV2> {
        Self::ensure_plan_target(target, current_plan)?;
        Self::ensure_reviewed_digest(current_plan, expected_plan_digest)?;
        self.apply_request_without_compaction(PluginPermissionDecisionRequestV2::enable(
            request_id,
            expected_record_revision,
            current_plan,
        ))
    }

    /// Returns the authoritative current state for an exact replay. A new
    /// enable request returns `None` after validating its target, digest, CAS,
    /// and lifetime capacity. If the next event needs byte compaction, that
    /// maintenance publication completes here before runtime retirement.
    fn preflight_enable(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request_id: &PluginPermissionDecisionRequestIdV2,
        expected_record_revision: u64,
        expected_plan_digest: &PluginPermissionPlanDigestV2,
        current_plan: &PluginPermissionPlanV2,
    ) -> StoreResult<Option<PluginPermissionDecisionStateV2>> {
        Self::ensure_plan_target(target, current_plan)?;
        Self::ensure_reviewed_digest(current_plan, expected_plan_digest)?;
        let mut journal = LockedJournal::open(&self.directory)?;
        let mut loaded = LoadedPermissionJournal::read(&journal)?;
        let key = target.decision_key();
        let has_prior_request = loaded.prior_request(&key, request_id).is_some();
        if !has_prior_request && loaded.event_count >= MAX_ACTIVE_JOURNAL_EVENTS {
            return Err(active_capacity_exhausted(
                "permission journal reached its regular lifetime event capacity",
            ));
        }
        if !has_prior_request
            && loaded.key_event_count(&key) >= MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2
        {
            return Err(active_capacity_exhausted(
                "plugin permission key reached its regular lifetime event capacity",
            ));
        }
        let application = apply_plugin_permission_decision_request(
            loaded.fold_mut(&key)?,
            PluginPermissionDecisionRequestV2::enable(
                request_id.clone(),
                expected_record_revision,
                current_plan,
            ),
        )
        .map_err(decision_error)?;
        let Some(event) = application.event_to_append() else {
            return Ok(Some(application.state().clone()));
        };
        let required_tail_bytes = encode_envelope(loaded.event_count, event)?.len();
        let next_len = journal
            .bytes
            .len()
            .checked_add(required_tail_bytes)
            .ok_or_else(|| too_large("permission journal length overflow"))?;
        if next_len as u64 > loaded.format.active_byte_limit() {
            let current = LoadedPermissionJournal::read(&journal)?;
            let (bytes, generation) = current.compacted_bytes(required_tail_bytes)?;
            journal.publish_compacted_bytes(bytes, generation)?;
        } else {
            // The first enable on an unanchored legacy store must publish the
            // store-level capability fence before the journal lock is released
            // for runtime retirement. Older writers reject the extended lock
            // shape instead of racing this process's transition flock.
            journal.ensure_authority_anchor()?;
        }
        Ok(None)
    }

    #[cfg(test)]
    fn disable_unconditionally(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request_id: PluginPermissionDecisionRequestIdV2,
    ) -> StoreResult<PluginPermissionDecisionStateV2> {
        self.disable_transition_unconditionally(target, request_id)
            .map(|transition| transition.into_parts().0)
    }

    fn disable_transition_unconditionally(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request_id: PluginPermissionDecisionRequestIdV2,
    ) -> StoreResult<PluginPermissionDisableTransition> {
        let key = target.decision_key();
        let mut journal = LockedJournal::open(&self.directory)?;
        let mut loaded = LoadedPermissionJournal::read(&journal)?;
        let prior_expected_record_revision = loaded
            .prior_request(&key, &request_id)
            .map(PluginPermissionDecisionReplayReceiptV2::expected_record_revision);
        let current = loaded.state(&key);
        let event_count = loaded.event_count;
        let key_event_count = loaded.key_event_count(&key);
        let new_key_capacity_exhausted = key_event_count == 0
            && loaded.folds.len() >= MAX_PERMISSION_KEYS;
        if prior_expected_record_revision.is_none()
            && current.enablement() == PluginPermissionEnablementV2::Disabled
            && (event_count >= MAX_ACTIVE_JOURNAL_EVENTS
                || journal.bytes.len() as u64 >= loaded.format.active_byte_limit()
                || key_event_count >= MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2
                || new_key_capacity_exhausted)
        {
            journal.ensure_authority_anchor()?;
            return Ok(PluginPermissionDisableTransition::retirement_repair(
                current,
            ));
        }
        let expected_record_revision = prior_expected_record_revision
            .unwrap_or_else(|| current.record_revision());
        let admission = if current.enablement() == PluginPermissionEnablementV2::Enabled {
            JournalAppendAdmission::EmergencyDisable
        } else {
            JournalAppendAdmission::Regular
        };
        let application = apply_plugin_permission_decision_request(
            loaded.fold_mut(&key)?,
            PluginPermissionDecisionRequestV2::disable(
                request_id,
                expected_record_revision,
                key,
            ),
        )
        .map_err(decision_error)?;
        let event_to_append = application.event_to_append().cloned();
        let state = application.state().clone();
        if state.enablement() != PluginPermissionEnablementV2::Disabled {
            return Err(PluginPermissionStoreError::new(
                "plugin_permission_disable_replay_stale",
                "the disable request was consumed before a later re-enable; use a new request id",
            ));
        }
        if let Some(event) = event_to_append {
            if let Err(error) = append_envelope_with_admission(
                &mut journal,
                loaded.format,
                event_count,
                &event,
                admission,
            )
            {
                if admission == JournalAppendAdmission::Regular
                    && error.code() == "plugin_permission_journal_active_capacity_exhausted"
                {
                    return Ok(PluginPermissionDisableTransition::retirement_repair(
                        current,
                    ));
                }
                return Err(error);
            }
        } else {
            journal.ensure_authority_anchor()?;
        }
        Ok(PluginPermissionDisableTransition::recorded(state))
    }

    /// Reconciles an ambiguous append result without issuing another write.
    /// A rename may have published the event even when the following directory
    /// fsync reported an error; retirement must still continue in that case.
    fn recover_disable_transition(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request_id: &PluginPermissionDecisionRequestIdV2,
    ) -> StoreResult<Option<PluginPermissionDisableTransition>> {
        let key = target.decision_key();
        let journal = LockedJournal::open_shared(&self.directory)?;
        let loaded = LoadedPermissionJournal::read(&journal)?;
        let state = loaded.state(&key);
        let Some(previous) = loaded.prior_request(&key, request_id) else {
            return Ok((state.enablement() == PluginPermissionEnablementV2::Disabled)
                .then(|| PluginPermissionDisableTransition::retirement_repair(state)));
        };
        if matches!(
            previous.body(),
            PluginPermissionDecisionReplayBodyV2::Disabled
        ) && previous.record_revision() == state.record_revision()
            && state.enablement() == PluginPermissionEnablementV2::Disabled
        {
            Ok(Some(PluginPermissionDisableTransition::recorded(state)))
        } else {
            Ok(None)
        }
    }

    /// Resolves an enable append whose final filesystem durability signal was
    /// ambiguous. The caller still holds the cross-process transition fence,
    /// so an exact published request cannot be superseded for this target
    /// while it is reconciled.
    fn recover_enable_transition(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request_id: &PluginPermissionDecisionRequestIdV2,
        expected_record_revision: u64,
        current_plan: &PluginPermissionPlanV2,
    ) -> StoreResult<Option<PluginPermissionDecisionStateV2>> {
        let key = target.decision_key();
        let journal = LockedJournal::open(&self.directory)?;
        let mut loaded = LoadedPermissionJournal::read(&journal)?;
        let application = match apply_plugin_permission_decision_request(
            loaded.fold_mut(&key)?,
            PluginPermissionDecisionRequestV2::enable(
                request_id.clone(),
                expected_record_revision,
                current_plan,
            ),
        ) {
            Ok(application)
                if application.disposition()
                    == PluginPermissionDecisionEventDispositionV2::ExactReplay =>
            {
                application
            }
            Ok(_) | Err(_) => return Ok(None),
        };
        let state = application.state().clone();
        if application.event().record_revision() != state.record_revision()
            || state.enablement() != PluginPermissionEnablementV2::Enabled
        {
            return Ok(None);
        }
        Ok(Some(state))
    }

    fn recover_decision_transition(
        &self,
        target: &ResolvedPluginPermissionTarget,
        request_id: &PluginPermissionDecisionRequestIdV2,
        expected_record_revision: u64,
        current_plan: &PluginPermissionPlanV2,
        decision: PluginPermissionDecisionV2,
    ) -> StoreResult<Option<PluginPermissionDecisionStateV2>> {
        let key = target.decision_key();
        let journal = LockedJournal::open(&self.directory)?;
        let mut loaded = LoadedPermissionJournal::read(&journal)?;
        let application = match apply_plugin_permission_decision_request(
            loaded.fold_mut(&key)?,
            PluginPermissionDecisionRequestV2::decide(
                request_id.clone(),
                expected_record_revision,
                current_plan,
                decision,
            ),
        ) {
            Ok(application)
                if application.disposition()
                    == PluginPermissionDecisionEventDispositionV2::ExactReplay =>
            {
                application
            }
            Ok(_) | Err(_) => return Ok(None),
        };
        let state = application.state().clone();
        if application.event().record_revision() != state.record_revision() {
            return Ok(None);
        }
        Ok(Some(state))
    }

    fn lock_transition(&self) -> StoreResult<File> {
        let path = self.directory.join(TRANSITION_LOCK_FILE);
        let lock = open_owned_file(&path, false)?;
        FileExt::lock_exclusive(&lock).map_err(|error| {
            PluginPermissionStoreError::new(
                "plugin_permission_transition_lock_failed",
                format!("lock {}: {error}", path.display()),
            )
        })?;
        Ok(lock)
    }

    fn lock_execution(&self) -> StoreResult<LockedJournal> {
        LockedJournal::open_shared(&self.directory)
    }

    fn authorize_execution_locked(
        &self,
        journal: &LockedJournal,
        target: &ResolvedPluginPermissionTarget,
        current_plan: &PluginPermissionPlanV2,
        permission_kind: &PermissionKindIdV2,
        parameter: &str,
        value: &str,
    ) -> StoreResult<PluginPermissionExecutionLeaseV2> {
        Self::ensure_plan_target(target, current_plan)?;
        let state = LoadedPermissionJournal::read(journal)?.state(&target.decision_key());
        evaluate_plugin_permission_execution(
            &state,
            current_plan,
            permission_kind,
            parameter,
            value,
        )
        .map_err(execution_error)
    }

    fn revalidate_execution_locked(
        &self,
        journal: &LockedJournal,
        target: &ResolvedPluginPermissionTarget,
        current_plan: &PluginPermissionPlanV2,
        lease: &PluginPermissionExecutionLeaseV2,
    ) -> StoreResult<()> {
        Self::ensure_plan_target(target, current_plan)?;
        if lease.key() != &target.decision_key() {
            return Err(PluginPermissionStoreError::new(
                "plugin_permission_execution_denied",
                "the execution lease belongs to a different workspace/plugin target",
            ));
        }
        let state = LoadedPermissionJournal::read(journal)?.state(&target.decision_key());
        revalidate_plugin_permission_execution_lease(lease, &state, current_plan)
            .map_err(execution_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Barrier,
    };
    use std::time::Duration;
    use tempfile::TempDir;

    #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct TestEvent {
        workspace_identity: String,
        action: String,
    }

    fn fixture() -> (TempDir, PathBuf) {
        let temporary = tempfile::tempdir().expect("tempdir");
        let control_root = temporary.path().join("channel");
        DirBuilder::new()
            .mode(0o700)
            .create(&control_root)
            .expect("control root");
        (temporary, control_root)
    }

    fn store_directory(control_root: &Path) -> PathBuf {
        control_root.join(STORE_DIRECTORY)
    }

    fn journal_path(control_root: &Path) -> PathBuf {
        store_directory(control_root).join(JOURNAL_FILE)
    }

    fn key_path(control_root: &Path) -> PathBuf {
        store_directory(control_root).join(SECRET_FILE)
    }

    fn request_id(value: &str) -> PluginPermissionDecisionRequestIdV2 {
        PluginPermissionDecisionRequestIdV2::new(value).unwrap()
    }

    fn beads_target_and_plan(
        state: &DurePluginPermissionState,
        workspace: &Path,
    ) -> (ResolvedPluginPermissionTarget, PluginPermissionPlanV2) {
        let plugin_id = PluginIdV2::new("dure.beads").unwrap();
        let target = state.resolve_target(workspace, &plugin_id).unwrap();
        let plan = crate::plugin_catalog::bundled_permission_plan(
            &plugin_id,
            target.workspace().identity().clone(),
        )
        .unwrap();
        (target, plan)
    }

    fn replace_file(path: &Path, bytes: &[u8]) {
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .expect("open fixture file");
        file.write_all(bytes).expect("write fixture file");
        file.sync_all().expect("sync fixture file");
    }

    #[test]
    fn fresh_store_is_complete_and_owner_only() {
        let (_temporary, control_root) = fixture();
        PluginPermissionStore::open_at(&control_root).expect("open store");

        let directory = store_directory(&control_root);
        let directory_metadata = std::fs::symlink_metadata(&directory).expect("store metadata");
        assert!(directory_metadata.is_dir());
        assert_eq!(directory_metadata.mode() & 0o7777, 0o700);
        for file in [SECRET_FILE, JOURNAL_FILE, LOCK_FILE, TRANSITION_LOCK_FILE] {
            let metadata = std::fs::symlink_metadata(directory.join(file)).expect("file metadata");
            assert!(metadata.is_file());
            assert_eq!(metadata.mode() & 0o7777, 0o600);
            assert_eq!(metadata.uid(), current_uid());
            assert_eq!(metadata.nlink(), 1);
        }
        assert_eq!(
            std::fs::read(key_path(&control_root)).unwrap().len(),
            SECRET_BYTES
        );
    }

    #[test]
    fn restart_preserves_workspace_identity_and_separates_roots() {
        let (_temporary, control_root) = fixture();
        let workspace_a = control_root.join("workspace-a");
        let workspace_b = control_root.join("workspace-b");
        std::fs::create_dir(&workspace_a).unwrap();
        std::fs::create_dir(&workspace_b).unwrap();

        let first = PluginPermissionStore::open_at(&control_root).unwrap();
        let identity_a = first.workspace_identity_string(&workspace_a).unwrap();
        let identity_b = first.workspace_identity_string(&workspace_b).unwrap();
        drop(first);
        let restarted = PluginPermissionStore::open_at(&control_root).unwrap();

        assert_eq!(
            restarted.workspace_identity_string(&workspace_a).unwrap(),
            identity_a
        );
        assert_ne!(identity_a, identity_b);
        assert!(identity_a.starts_with("sha256:"));
        assert_eq!(identity_a.len(), "sha256:".len() + 64);
    }

    #[test]
    fn hmac_sha256_dependency_matches_rfc4231_case_one() {
        let mut mac = HmacSha256::new_from_slice(&[0x0b; 20]).unwrap();
        mac.update(b"Hi There");
        let digest = mac.finalize().into_bytes();
        let encoded = digest.iter().fold(String::new(), |mut encoded, byte| {
            write!(&mut encoded, "{byte:02x}").unwrap();
            encoded
        });
        assert_eq!(
            encoded,
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn canonical_ancestor_alias_has_the_same_identity_but_final_symlink_is_rejected() {
        let (_temporary, control_root) = fixture();
        let parent = control_root.join("workspaces");
        let workspace = parent.join("real");
        std::fs::create_dir(&parent).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let parent_alias = control_root.join("workspaces-alias");
        symlink(&parent, &parent_alias).unwrap();
        let aliased_workspace = parent_alias.join("real");
        let final_alias = control_root.join("final-alias");
        symlink(&workspace, &final_alias).unwrap();
        let store = PluginPermissionStore::open_at(&control_root).unwrap();

        assert_eq!(
            store.workspace_identity_string(&workspace).unwrap(),
            store.workspace_identity_string(&aliased_workspace).unwrap()
        );
        assert_eq!(
            store
                .workspace_identity_string(&final_alias)
                .unwrap_err()
                .code(),
            "plugin_permission_workspace_invalid"
        );
    }

    #[test]
    fn journal_contains_only_workspace_hmac_not_the_raw_path() {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("raw-workspace-name-must-not-leak");
        std::fs::create_dir(&workspace).unwrap();
        let state = DurePluginPermissionState::open_at(&control_root).unwrap();
        let (target, plan) = beads_target_and_plan(&state, &workspace);
        let identity = target.workspace().identity().as_str().to_owned();
        state
            .store
            .decide(
                &target,
                request_id("review-with-pseudonymous-workspace"),
                0,
                plan.digest(),
                &plan,
                PluginPermissionDecisionV2::Approve,
            )
            .unwrap();

        let encoded = std::fs::read(journal_path(&control_root)).unwrap();
        assert!(!encoded
            .windows(workspace.as_os_str().as_bytes().len())
            .any(|window| window == workspace.as_os_str().as_bytes()));
        assert!(String::from_utf8(encoded).unwrap().contains(&identity));
    }

    #[test]
    fn incomplete_tail_is_rejected_without_repair() {
        let (_temporary, control_root) = fixture();
        PluginPermissionStore::open_at(&control_root).unwrap();
        let path = journal_path(&control_root);
        replace_file(&path, br#"{"schemaVersion":1"#);
        let before = std::fs::read(&path).unwrap();

        let error = PluginPermissionStore::open_at(&control_root).unwrap_err();

        assert_eq!(error.code(), "plugin_permission_journal_invalid");
        assert_eq!(std::fs::read(path).unwrap(), before);
    }

    #[test]
    fn unknown_schema_and_unknown_fields_are_rejected() {
        let unknown_schema = br#"{"schemaVersion":2,"seq":1,"event":{"workspaceIdentity":"sha256:00","action":"approve"}}
"#;
        assert_eq!(
            parse_journal::<TestEvent>(unknown_schema)
                .unwrap_err()
                .code(),
            "plugin_permission_journal_invalid"
        );
        let unknown_field = br#"{"schemaVersion":1,"seq":1,"event":{"workspaceIdentity":"sha256:00","action":"approve"},"surprise":true}
"#;
        assert_eq!(
            parse_journal::<TestEvent>(unknown_field)
                .unwrap_err()
                .code(),
            "plugin_permission_journal_invalid"
        );
    }

    #[test]
    fn oversized_journal_and_line_are_rejected_before_parsing() {
        let (_temporary, control_root) = fixture();
        PluginPermissionStore::open_at(&control_root).unwrap();
        let path = journal_path(&control_root);
        let file = OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(MAX_JOURNAL_BYTES + 1).unwrap();
        file.sync_all().unwrap();
        assert_eq!(
            PluginPermissionStore::open_at(&control_root)
                .unwrap_err()
                .code(),
            "plugin_permission_journal_too_large"
        );

        let mut oversized_line = vec![b'a'; MAX_JOURNAL_LINE_BYTES];
        oversized_line.push(b'\n');
        assert_eq!(
            parse_journal::<TestEvent>(&oversized_line)
                .unwrap_err()
                .code(),
            "plugin_permission_journal_too_large"
        );
    }

    #[test]
    fn journal_event_count_is_bounded_independently_of_byte_size() {
        let event = TestEvent {
            workspace_identity: format!("sha256:{}", "a".repeat(64)),
            action: "approve".to_string(),
        };
        let mut bytes = Vec::new();
        for index in 0..=MAX_JOURNAL_EVENTS {
            let envelope = JournalEnvelope {
                schema_version: JOURNAL_SCHEMA_VERSION,
                seq: u64::try_from(index).unwrap() + 1,
                event: &event,
            };
            bytes.extend(serde_json::to_vec(&envelope).unwrap());
            bytes.push(b'\n');
        }
        assert!(bytes.len() as u64 <= MAX_JOURNAL_BYTES);

        assert_eq!(
            parse_journal::<TestEvent>(&bytes).unwrap_err().code(),
            "plugin_permission_journal_too_large"
        );
    }

    #[test]
    fn symlinked_and_hardlinked_files_are_rejected() {
        let (_temporary, control_root) = fixture();
        PluginPermissionStore::open_at(&control_root).unwrap();
        let path = journal_path(&control_root);
        let backing = control_root.join("journal-backing");
        std::fs::rename(&path, &backing).unwrap();
        symlink(&backing, &path).unwrap();
        assert_eq!(
            PluginPermissionStore::open_at(&control_root)
                .unwrap_err()
                .code(),
            "plugin_permission_store_io"
        );

        std::fs::remove_file(&path).unwrap();
        std::fs::hard_link(&backing, &path).unwrap();
        assert_eq!(
            PluginPermissionStore::open_at(&control_root)
                .unwrap_err()
                .code(),
            "plugin_permission_store_untrusted"
        );
    }

    #[test]
    fn missing_or_invalid_secret_never_regenerates_an_existing_store() {
        let (_temporary, control_root) = fixture();
        PluginPermissionStore::open_at(&control_root).unwrap();
        let path = key_path(&control_root);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            PluginPermissionStore::open_at(&control_root)
                .unwrap_err()
                .code(),
            "plugin_permission_store_io"
        );
        assert!(!path.exists());

        let mut replacement = create_owned_file(&path).unwrap();
        replacement.write_all(b"short").unwrap();
        replacement.sync_all().unwrap();
        assert_eq!(
            PluginPermissionStore::open_at(&control_root)
                .unwrap_err()
                .code(),
            "plugin_permission_store_untrusted"
        );
        assert_eq!(std::fs::read(path).unwrap(), b"short");
    }

    #[test]
    fn valid_length_secret_replacement_fails_its_immutable_commitment() {
        let (_temporary, control_root) = fixture();
        PluginPermissionStore::open_at(&control_root).unwrap();
        let path = key_path(&control_root);
        replace_file(&path, &[0x5a; SECRET_BYTES]);

        assert_eq!(
            PluginPermissionStore::open_at(&control_root)
                .unwrap_err()
                .code(),
            "plugin_permission_store_untrusted"
        );
        assert_eq!(std::fs::read(path).unwrap(), [0x5a; SECRET_BYTES]);
    }

    #[test]
    fn wrong_modes_and_symlinked_store_directory_fail_closed() {
        let (_temporary, control_root) = fixture();
        PluginPermissionStore::open_at(&control_root).unwrap();
        let path = key_path(&control_root);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            PluginPermissionStore::open_at(&control_root)
                .unwrap_err()
                .code(),
            "plugin_permission_store_untrusted"
        );

        let (_temporary, control_root) = fixture();
        let elsewhere = control_root.join("elsewhere");
        DirBuilder::new().mode(0o700).create(&elsewhere).unwrap();
        symlink(&elsewhere, store_directory(&control_root)).unwrap();
        assert_eq!(
            PluginPermissionStore::open_at(&control_root)
                .unwrap_err()
                .code(),
            "plugin_permission_store_untrusted"
        );
    }

    #[test]
    fn wrong_owner_shapes_are_rejected_without_requiring_privileged_chown() {
        let foreign_uid = current_uid().wrapping_add(1);
        assert!(!trusted_directory_shape(false, true, foreign_uid, 0o700));
        assert!(!trusted_file_shape(true, foreign_uid, 1, 0o600));
        assert!(trusted_directory_shape(false, true, current_uid(), 0o700));
        assert!(trusted_file_shape(true, current_uid(), 1, 0o600));
    }

    #[test]
    fn corrupted_middle_event_is_rejected_without_repair() {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let state = DurePluginPermissionState::open_at(&control_root).unwrap();
        let (target, plan) = beads_target_and_plan(&state, &workspace);
        state
            .store
            .decide(
                &target,
                request_id("approve-before-corruption"),
                0,
                plan.digest(),
                &plan,
                PluginPermissionDecisionV2::Approve,
            )
            .unwrap();
        state
            .store
            .enable(
                &target,
                request_id("enable-before-corruption"),
                1,
                plan.digest(),
                &plan,
            )
            .unwrap();
        let path = journal_path(&control_root);
        let mut corrupted = std::fs::read(&path).unwrap();
        let first_line_end = corrupted.iter().position(|byte| *byte == b'\n').unwrap();
        assert!(first_line_end + 1 < corrupted.len());
        corrupted[0] = b'!';
        replace_file(&path, &corrupted);

        assert_eq!(
            DurePluginPermissionState::open_at(&control_root)
                .unwrap_err()
                .code(),
            "plugin_permission_journal_invalid"
        );
        assert_eq!(std::fs::read(path).unwrap(), corrupted);
    }

    #[test]
    fn persisted_unknown_envelope_schema_fails_store_open() {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let state = DurePluginPermissionState::open_at(&control_root).unwrap();
        let (target, plan) = beads_target_and_plan(&state, &workspace);
        state
            .store
            .decide(
                &target,
                request_id("approve-before-schema-change"),
                0,
                plan.digest(),
                &plan,
                PluginPermissionDecisionV2::Approve,
            )
            .unwrap();
        let path = journal_path(&control_root);
        let mut corrupted = std::fs::read(&path).unwrap();
        let needle = b"\"schemaVersion\":1";
        let offset = corrupted
            .windows(needle.len())
            .position(|window| window == needle)
            .unwrap();
        corrupted[offset + needle.len() - 1] = b'2';
        replace_file(&path, &corrupted);

        assert_eq!(
            DurePluginPermissionState::open_at(&control_root)
                .unwrap_err()
                .code(),
            "plugin_permission_journal_invalid"
        );
        assert_eq!(std::fs::read(path).unwrap(), corrupted);
    }

    #[test]
    fn decision_enable_disable_and_restart_replay_exact_core_state() {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let state = DurePluginPermissionState::open_at(&control_root).unwrap();
        let (target, plan) = beads_target_and_plan(&state, &workspace);

        let approved_receipt = state
            .decide_with_retirement(
                &target,
                PluginPermissionDecisionCas::new(
                    request_id("approve-1"),
                    0,
                    plan.digest(),
                    &plan,
                    PluginPermissionDecisionV2::Approve,
                ),
                |_approved| Ok::<_, PluginPermissionStoreError>(()),
            )
            .unwrap();
        let (approved, retirement) = approved_receipt.into_parts();
        assert!(matches!(
            retirement,
            PluginPermissionRetirementOutcome::Attempted(Ok(()))
        ));
        assert_eq!(approved.record_revision(), 1);
        assert_eq!(approved.enablement_epoch(), 1);
        assert_eq!(
            approved.enablement(),
            PluginPermissionEnablementV2::Disabled
        );

        let restarted = DurePluginPermissionState::open_at(&control_root).unwrap();
        let (restarted_target, restarted_plan) = beads_target_and_plan(&restarted, &workspace);
        let replayed = restarted.snapshot(&restarted_target).unwrap();
        assert_eq!(replayed, approved);

        let enabled = restarted
            .enable(
                &restarted_target,
                request_id("enable-1"),
                1,
                restarted_plan.digest(),
                &restarted_plan,
            )
            .unwrap();
        assert_eq!(enabled.record_revision(), 2);
        assert_eq!(enabled.enablement_epoch(), 2);
        assert_eq!(enabled.enablement(), PluginPermissionEnablementV2::Enabled);

        let disabled_receipt = restarted
            .disable_with_retirement(&restarted_target, request_id("disable-1"), |_disabled| {
                Ok::<_, PluginPermissionStoreError>(())
            })
            .unwrap();
        let (disabled, retirement) = disabled_receipt.into_parts();
        let (disabled, persistence) = disabled.into_parts();
        assert_eq!(persistence, PluginPermissionDisablePersistence::Recorded);
        assert!(matches!(
            retirement,
            PluginPermissionRetirementOutcome::Attempted(Ok(()))
        ));
        assert_eq!(disabled.record_revision(), 3);
        assert_eq!(disabled.enablement_epoch(), 3);
        assert_eq!(
            disabled.enablement(),
            PluginPermissionEnablementV2::Disabled
        );
        assert_eq!(restarted.store.load().unwrap(), vec![disabled]);
    }

    #[test]
    fn reviewed_digest_mismatch_is_rejected_before_journal_mutation() {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let state = DurePluginPermissionState::open_at(&control_root).unwrap();
        let (target, plan) = beads_target_and_plan(&state, &workspace);
        let wrong_digest =
            PluginPermissionPlanDigestV2::new(format!("sha256:{}", "0".repeat(64))).unwrap();

        let error = state
            .store
            .decide(
                &target,
                request_id("approve-stale-plan"),
                0,
                &wrong_digest,
                &plan,
                PluginPermissionDecisionV2::Approve,
            )
            .unwrap_err();

        assert_eq!(error.code(), "plugin_permission_plan_changed");
        assert_eq!(state.store.snapshot(&target).unwrap().record_revision(), 0);
        assert!(std::fs::read(journal_path(&control_root))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn old_disable_request_id_cannot_claim_success_after_reenable() {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let state = DurePluginPermissionState::open_at(&control_root).unwrap();
        let (target, plan) = beads_target_and_plan(&state, &workspace);
        state
            .store
            .decide(
                &target,
                request_id("approve-disable-replay"),
                0,
                plan.digest(),
                &plan,
                PluginPermissionDecisionV2::Approve,
            )
            .unwrap();
        state
            .enable(
                &target,
                request_id("enable-before-disable-replay"),
                1,
                plan.digest(),
                &plan,
            )
            .unwrap();
        state
            .store
            .disable_unconditionally(&target, request_id("replayed-disable"))
            .unwrap();
        state
            .enable(
                &target,
                request_id("reenable-after-disable"),
                3,
                plan.digest(),
                &plan,
            )
            .unwrap();

        let error = state
            .store
            .disable_unconditionally(&target, request_id("replayed-disable"))
            .unwrap_err();

        assert_eq!(error.code(), "plugin_permission_disable_replay_stale");
        assert_eq!(
            state.snapshot(&target).unwrap().enablement(),
            PluginPermissionEnablementV2::Enabled
        );
    }

    #[test]
    fn approved_request_replay_after_enable_never_retires_enabled_runtime() {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let state = DurePluginPermissionState::open_at(&control_root).unwrap();
        let (target, plan) = beads_target_and_plan(&state, &workspace);
        let retire_calls = Arc::new(AtomicUsize::new(0));

        let first_calls = Arc::clone(&retire_calls);
        let first = state
            .decide_with_retirement(
                &target,
                PluginPermissionDecisionCas::new(
                    request_id("approve-replayed-after-enable"),
                    0,
                    plan.digest(),
                    &plan,
                    PluginPermissionDecisionV2::Approve,
                ),
                move |_disabled| {
                    first_calls.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, PluginPermissionStoreError>(())
                },
            )
            .unwrap();
        let (first_state, first_retirement) = first.into_parts();
        assert_eq!(
            first_state.enablement(),
            PluginPermissionEnablementV2::Disabled
        );
        assert!(matches!(
            first_retirement,
            PluginPermissionRetirementOutcome::Attempted(Ok(()))
        ));

        let healing_calls = Arc::clone(&retire_calls);
        let healing = state
            .decide_with_retirement(
                &target,
                PluginPermissionDecisionCas::new(
                    request_id("approve-replayed-after-enable"),
                    0,
                    plan.digest(),
                    &plan,
                    PluginPermissionDecisionV2::Approve,
                ),
                move |_disabled| {
                    healing_calls.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, PluginPermissionStoreError>(())
                },
            )
            .unwrap();
        let (healing_state, healing_retirement) = healing.into_parts();
        assert_eq!(healing_state.record_revision(), 1);
        assert!(matches!(
            healing_retirement,
            PluginPermissionRetirementOutcome::Attempted(Ok(()))
        ));
        assert_eq!(retire_calls.load(Ordering::SeqCst), 2);

        state
            .enable(
                &target,
                request_id("enable-before-approve-replay"),
                1,
                plan.digest(),
                &plan,
            )
            .unwrap();

        let forbidden_calls = Arc::clone(&retire_calls);
        let replay = state
            .decide_with_retirement(
                &target,
                PluginPermissionDecisionCas::new(
                    request_id("approve-replayed-after-enable"),
                    0,
                    plan.digest(),
                    &plan,
                    PluginPermissionDecisionV2::Approve,
                ),
                move |_enabled| {
                    forbidden_calls.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, PluginPermissionStoreError>(())
                },
            )
            .unwrap();
        let (authoritative, retirement) = replay.into_parts();

        assert_eq!(
            authoritative.enablement(),
            PluginPermissionEnablementV2::Enabled
        );
        assert_eq!(authoritative.record_revision(), 2);
        assert!(matches!(
            retirement,
            PluginPermissionRetirementOutcome::SkippedCurrentEnabled
        ));
        assert_eq!(retire_calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            state.snapshot(&target).unwrap().enablement(),
            PluginPermissionEnablementV2::Enabled
        );
    }

    #[test]
    fn two_store_handles_enforce_one_cas_winner() {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let first = Arc::new(DurePluginPermissionState::open_at(&control_root).unwrap());
        let second = Arc::new(DurePluginPermissionState::open_at(&control_root).unwrap());
        let (first_target, first_plan) = beads_target_and_plan(&first, &workspace);
        let (second_target, second_plan) = beads_target_and_plan(&second, &workspace);
        let barrier = Arc::new(Barrier::new(3));

        let (first_result, second_result) = std::thread::scope(|scope| {
            let first_barrier = Arc::clone(&barrier);
            let first_state = Arc::clone(&first);
            let first_handle = scope.spawn(move || {
                first_barrier.wait();
                first_state.store.decide(
                    &first_target,
                    request_id("approve-racer-a"),
                    0,
                    first_plan.digest(),
                    &first_plan,
                    PluginPermissionDecisionV2::Approve,
                )
            });
            let second_barrier = Arc::clone(&barrier);
            let second_state = Arc::clone(&second);
            let second_handle = scope.spawn(move || {
                second_barrier.wait();
                second_state.store.decide(
                    &second_target,
                    request_id("approve-racer-b"),
                    0,
                    second_plan.digest(),
                    &second_plan,
                    PluginPermissionDecisionV2::Approve,
                )
            });
            barrier.wait();
            (first_handle.join().unwrap(), second_handle.join().unwrap())
        });

        assert_ne!(first_result.is_ok(), second_result.is_ok());
        let error = first_result.err().or_else(|| second_result.err()).unwrap();
        assert_eq!(error.code(), "plugin_permission_decision_invalid");
        let reloaded = first.store.load().unwrap();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].record_revision(), 1);
    }

    #[test]
    fn shared_execution_gate_spans_authorize_execute_revalidate_and_publish() {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let state = Arc::new(DurePluginPermissionState::open_at(&control_root).unwrap());
        let (target, plan) = beads_target_and_plan(&state, &workspace);
        state
            .store
            .decide(
                &target,
                request_id("approve-for-execution"),
                0,
                plan.digest(),
                &plan,
                PluginPermissionDecisionV2::Approve,
            )
            .unwrap();
        state
            .enable(
                &target,
                request_id("enable-for-execution"),
                1,
                plan.digest(),
                &plan,
            )
            .unwrap();
        let permission_kind = PermissionKindIdV2::new("dure.issue-tracker.read").unwrap();
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let (retired_sender, retired_receiver) = mpsc::channel();

        std::thread::scope(|scope| {
            let execution_state = Arc::clone(&state);
            let execution_target = target.clone();
            let execution = scope.spawn(move || {
                execution_state.with_authorized_execution(
                    &execution_target,
                    PluginPermissionExecutionRequest::new(
                        &plan,
                        &permission_kind,
                        "operations",
                        "list",
                    ),
                    |_lease| {
                        started_sender.send(()).unwrap();
                        release_receiver.recv().unwrap();
                        Ok::<_, PluginPermissionStoreError>("result")
                    },
                    |result, lease| {
                        assert_eq!(lease.enablement_epoch(), 2);
                        Ok::<_, PluginPermissionStoreError>(result)
                    },
                )
            });
            started_receiver.recv().unwrap();

            let retiring_state = Arc::clone(&state);
            let retiring_target = target.clone();
            let retirement = scope.spawn(move || {
                retiring_state.disable_with_retirement(
                    &retiring_target,
                    request_id("disable-during-execution"),
                    |disabled| {
                        assert_eq!(
                            disabled.enablement(),
                            PluginPermissionEnablementV2::Disabled
                        );
                        retired_sender.send(()).unwrap();
                        Ok::<_, PluginPermissionStoreError>(())
                    },
                )
            });

            assert!(retired_receiver
                .recv_timeout(Duration::from_millis(100))
                .is_err());
            release_sender.send(()).unwrap();
            assert_eq!(execution.join().unwrap().unwrap(), "result");
            retired_receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap();
            let receipt = retirement.join().unwrap().unwrap();
            let (disabled, retirement) = receipt.into_parts();
            let (disabled, persistence) = disabled.into_parts();
            assert_eq!(persistence, PluginPermissionDisablePersistence::Recorded);
            assert!(matches!(
                retirement,
                PluginPermissionRetirementOutcome::Attempted(Ok(()))
            ));
            assert_eq!(
                disabled.enablement(),
                PluginPermissionEnablementV2::Disabled
            );
        });
    }

    #[test]
    fn disabled_states_deny_execution_before_callbacks_run() {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let state = DurePluginPermissionState::open_at(&control_root).unwrap();
        let (target, plan) = beads_target_and_plan(&state, &workspace);
        let permission_kind = PermissionKindIdV2::new("dure.issue-tracker.read").unwrap();
        let execute_calls = Arc::new(AtomicUsize::new(0));
        let publish_calls = Arc::new(AtomicUsize::new(0));

        for expected_revision in [0, 1] {
            if expected_revision == 1 {
                state
                    .store
                    .decide(
                        &target,
                        request_id("approve-but-remain-disabled"),
                        0,
                        plan.digest(),
                        &plan,
                        PluginPermissionDecisionV2::Approve,
                    )
                    .unwrap();
            }

            let execute_calls_for_attempt = Arc::clone(&execute_calls);
            let publish_calls_for_attempt = Arc::clone(&publish_calls);
            let error = state
                .with_authorized_execution(
                    &target,
                    PluginPermissionExecutionRequest::new(
                        &plan,
                        &permission_kind,
                        "operations",
                        "list",
                    ),
                    move |_lease| {
                        execute_calls_for_attempt.fetch_add(1, Ordering::SeqCst);
                        Ok::<_, PluginPermissionStoreError>(())
                    },
                    move |(), _lease| {
                        publish_calls_for_attempt.fetch_add(1, Ordering::SeqCst);
                        Ok::<_, PluginPermissionStoreError>(())
                    },
                )
                .unwrap_err();

            assert_eq!(error.code(), "plugin_permission_execution_denied");
            assert_eq!(
                state.snapshot(&target).unwrap().record_revision(),
                expected_revision
            );
            assert_eq!(execute_calls.load(Ordering::SeqCst), 0);
            assert_eq!(publish_calls.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn second_process_style_disable_waits_until_publication_returns() {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let executing = Arc::new(DurePluginPermissionState::open_at(&control_root).unwrap());
        let disabling = DurePluginPermissionState::open_at(&control_root).unwrap();
        let (executing_target, plan) = beads_target_and_plan(&executing, &workspace);
        let (disabling_target, _same_plan) = beads_target_and_plan(&disabling, &workspace);
        executing
            .store
            .decide(
                &executing_target,
                request_id("approve-cross-process"),
                0,
                plan.digest(),
                &plan,
                PluginPermissionDecisionV2::Approve,
            )
            .unwrap();
        executing
            .enable(
                &executing_target,
                request_id("enable-cross-process"),
                1,
                plan.digest(),
                &plan,
            )
            .unwrap();
        let permission_kind = PermissionKindIdV2::new("dure.issue-tracker.read").unwrap();
        let published = Arc::new(AtomicBool::new(false));
        let (publish_started_sender, publish_started_receiver) = mpsc::channel();
        let (publish_release_sender, publish_release_receiver) = mpsc::channel();
        let (disable_started_sender, disable_started_receiver) = mpsc::channel();
        let (disable_finished_sender, disable_finished_receiver) = mpsc::channel();

        let result = std::thread::scope(|scope| {
            let executing_state = Arc::clone(&executing);
            let published = Arc::clone(&published);
            let execution = scope.spawn(move || {
                executing_state.with_authorized_execution(
                    &executing_target,
                    PluginPermissionExecutionRequest::new(
                        &plan,
                        &permission_kind,
                        "operations",
                        "list",
                    ),
                    |_lease| Ok::<_, PluginPermissionStoreError>("published-result"),
                    |result, _lease| {
                        publish_started_sender.send(()).unwrap();
                        publish_release_receiver.recv().unwrap();
                        published.store(true, Ordering::SeqCst);
                        Ok::<_, PluginPermissionStoreError>(result)
                    },
                )
            });
            publish_started_receiver.recv().unwrap();
            let disable = scope.spawn(move || {
                disable_started_sender.send(()).unwrap();
                let state = disabling.store.disable_unconditionally(
                    &disabling_target,
                    request_id("cross-process-disable"),
                );
                disable_finished_sender.send(()).unwrap();
                state
            });
            disable_started_receiver.recv().unwrap();
            assert!(disable_finished_receiver
                .recv_timeout(Duration::from_millis(100))
                .is_err());
            publish_release_sender.send(()).unwrap();
            let execution = execution.join().unwrap();
            disable_finished_receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap();
            let disabled = disable.join().unwrap().unwrap();
            assert_eq!(
                disabled.enablement(),
                PluginPermissionEnablementV2::Disabled
            );
            execution
        });

        assert_eq!(result.unwrap(), "published-result");
        assert!(published.load(Ordering::SeqCst));
    }

    #[test]
    fn retirement_failure_preserves_the_authoritative_disabled_receipt() {
        let (_temporary, control_root) = fixture();
        let workspace = control_root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let state = DurePluginPermissionState::open_at(&control_root).unwrap();
        let (target, _plan) = beads_target_and_plan(&state, &workspace);

        let receipt = state
            .disable_with_retirement(
                &target,
                request_id("disable-retire-fails"),
                |_disabled| -> StoreResult<()> {
                    Err(PluginPermissionStoreError::new(
                        "fixture_retirement_failed",
                        "fixture retirement failure",
                    ))
                },
            )
            .unwrap();

        let (disabled, retirement) = receipt.into_parts();
        let (disabled, persistence) = disabled.into_parts();
        assert_eq!(persistence, PluginPermissionDisablePersistence::Recorded);
        assert_eq!(
            disabled.enablement(),
            PluginPermissionEnablementV2::Disabled
        );
        let PluginPermissionRetirementOutcome::Attempted(retirement) = retirement else {
            panic!("disabled transition must attempt retirement");
        };
        assert_eq!(
            retirement.as_ref().unwrap_err().code(),
            "fixture_retirement_failed"
        );
        assert_eq!(disabled.record_revision(), 1);
        assert!(retirement.is_err());
    }
}

#[cfg(test)]
#[path = "plugin_permissions_capacity_tests.rs"]
mod capacity_tests;

#[cfg(test)]
#[path = "plugin_permissions_compaction_tests.rs"]
mod compaction_tests;
