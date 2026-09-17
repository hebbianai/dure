use super::manifest_store::read_current_manifest_at;
use super::private_storage;
use super::{DiscoveryError, DiscoveryKey, DiscoveryManifest, DiscoveryRoot, ManifestGeneration};
#[cfg(feature = "ghostty-core-proof")]
use super::{PRESENTATION_CHECKPOINT_MAX_BYTES, PresentationCheckpoint};
use crate::local_protocol::ProcessProof;
use fs2::FileExt;
use serde::Serialize;
#[cfg(any(unix, windows))]
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io;
#[cfg(feature = "ghostty-core-proof")]
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) const MAINTENANCE_LOCK_FILE_NAME: &str = ".state-gc.lock";
const REGISTRATION_LOCK_FILE_NAME: &str = ".registration.lock";
const QUARANTINE_SESSION_PREFIX: &str = ".gc-session_";
#[cfg(feature = "ghostty-core-proof")]
const COLD_HISTORY_DIRECTORY_NAME: &str = ".terminal-history-v2";
#[cfg(feature = "ghostty-core-proof")]
const COLD_HISTORY_LEASE_FILE_NAME: &str = "lease.lock";
#[cfg(feature = "ghostty-core-proof")]
const QUARANTINE_COLD_HISTORY_PREFIX: &str = ".gc-history_";
#[cfg(feature = "ghostty-core-proof")]
const PRESENTATION_CHECKPOINT_FILE_NAME: &str = "presentation.json";
const MANIFEST_FILE_NAME: &str = "manifest.json";
const LIFETIME_LOCK_FILE_NAME: &str = "lifetime.lock";
const DEFAULT_MINIMUM_AGE_MS: u64 = 24 * 60 * 60 * 1_000;
const DEFAULT_MAXIMUM_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_SESSION_ENTRIES: usize = 512;
const DEFAULT_MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_MAX_SCAN_ENTRIES: usize = 16_384;
const DEFAULT_MAX_DIAGNOSTICS: usize = 64;
const MAX_QUARANTINE_NAME_ATTEMPTS: usize = 64;
static QUARANTINE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiscoveryGcMode {
    Preview,
    Apply,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiscoveryGcProcessStatus {
    Live,
    Absent,
    Unknown,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DiscoveryGcSelection {
    #[default]
    Retention,
    AllEligible,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveryGcPolicy {
    pub selection: DiscoveryGcSelection,
    pub minimum_age_ms: u64,
    pub maximum_age_ms: u64,
    pub max_session_entries: usize,
    pub max_total_bytes: u64,
    pub max_scan_entries: usize,
    pub max_diagnostics: usize,
}

impl Default for DiscoveryGcPolicy {
    fn default() -> Self {
        Self {
            selection: DiscoveryGcSelection::Retention,
            minimum_age_ms: DEFAULT_MINIMUM_AGE_MS,
            maximum_age_ms: DEFAULT_MAXIMUM_AGE_MS,
            max_session_entries: DEFAULT_MAX_SESSION_ENTRIES,
            max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
            max_scan_entries: DEFAULT_MAX_SCAN_ENTRIES,
            max_diagnostics: DEFAULT_MAX_DIAGNOSTICS,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryGcDiagnostic {
    pub relative_path: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryGcReport {
    pub scanned_sessions: usize,
    pub scanned_entries: usize,
    pub protected_sessions: usize,
    pub eligible_sessions: usize,
    pub eligible_oldest_age_ms: Option<u64>,
    pub planned_sessions: usize,
    pub planned_oldest_age_ms: Option<u64>,
    pub quarantined_sessions: usize,
    pub removed_sessions: usize,
    pub removed_bytes: u64,
    pub quarantine_residue_removed: usize,
    pub quarantine_residue_bytes: u64,
    pub scanned_cold_archives: usize,
    pub protected_cold_archives: usize,
    pub planned_cold_archives: usize,
    pub removed_cold_archives: usize,
    pub removed_cold_history_bytes: u64,
    pub remaining_sessions: usize,
    pub remaining_bytes: u64,
    pub remaining_state_incomplete: bool,
    pub budget_unmet: bool,
    pub diagnostics_truncated: bool,
    pub diagnostics: Vec<DiscoveryGcDiagnostic>,
}

#[derive(Debug)]
pub struct DiscoveryMaintenanceLock {
    file: File,
    root: PathBuf,
    exclusive: bool,
}

#[derive(Clone, Copy)]
struct DiscoveryGcMutationAuthority<'a> {
    // Keeping this borrow alive proves that Apply still owns the root-wide
    // exclusive lease while it releases narrower per-session resources.
    _maintenance: &'a DiscoveryMaintenanceLock,
}

impl<'a> DiscoveryGcMutationAuthority<'a> {
    fn new(
        root: &DiscoveryRoot,
        maintenance: &'a DiscoveryMaintenanceLock,
    ) -> Result<Self, DiscoveryError> {
        if maintenance.root != root.path() || !maintenance.exclusive {
            return Err(DiscoveryError::LockScopeMismatch);
        }
        Ok(Self {
            _maintenance: maintenance,
        })
    }
}

impl Drop for DiscoveryMaintenanceLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[derive(Debug)]
struct Candidate {
    path: PathBuf,
    relative_path: PathBuf,
    workspace_path: PathBuf,
    directory_identity: DirectoryIdentity,
    bytes: u64,
    modified_unix_ms: u64,
    fingerprint: [u8; 32],
    kind: CandidateKind,
}

#[derive(Debug)]
enum CandidateKind {
    Debris,
    AbandonedReady {
        expected_generation: ManifestGeneration,
    },
}

#[derive(Debug)]
struct QuarantinedCandidate {
    path: PathBuf,
    directory_identity: DirectoryIdentity,
    bytes: u64,
    durable: bool,
    kind: QuarantineKind,
}

#[derive(Debug)]
enum QuarantineKind {
    Session,
    #[cfg(feature = "ghostty-core-proof")]
    ColdHistory {
        _lease: File,
    },
}

/// An observational plan. Its private candidates must pass the exclusive
/// mutation boundary again; callers cannot construct deletion authority.
pub struct DiscoveryGcPlan {
    root: PathBuf,
    policy: DiscoveryGcPolicy,
    report: DiscoveryGcReport,
    planned: Vec<Candidate>,
    workspaces: Vec<PathBuf>,
    residues: Vec<(PathBuf, Option<DirectoryIdentity>)>,
    complete: bool,
    now_unix_ms: u64,
}

/// Only directories already detached from the registration namespace. This
/// value deliberately borrows no maintenance lease, so slow removal need not
/// exclude new registration. Dropping it leaves recoverable quarantine residue.
pub struct DiscoveryGcSweep {
    root: PathBuf,
    policy: DiscoveryGcPolicy,
    report: DiscoveryGcReport,
    quarantines: Vec<(QuarantinedCandidate, PathBuf)>,
    workspaces: Vec<PathBuf>,
    residues: Vec<(PathBuf, Option<DirectoryIdentity>)>,
    complete: bool,
}

/// The remaining full-GC work after registration deletion. The original
/// bounded census and root scope travel with the report, not caller paths.
pub struct DiscoveryGcHygiene {
    root: PathBuf,
    policy: DiscoveryGcPolicy,
    report: DiscoveryGcReport,
    workspaces: Vec<PathBuf>,
    residues: Vec<(PathBuf, Option<DirectoryIdentity>)>,
    complete: bool,
}

impl DiscoveryGcHygiene {
    pub fn defer(mut self, reason: &str) -> DiscoveryGcReport {
        self.report.budget_unmet = true;
        self.report.remaining_state_incomplete = true;
        push_diagnostic(&mut self.report, &self.policy, Path::new("."), reason);
        self.report
    }
}

impl DiscoveryGcSweep {
    pub fn sweep(self) -> Result<DiscoveryGcReport, DiscoveryError> {
        Ok(self.sweep_for_full_gc()?.report)
    }

    pub fn sweep_for_full_gc(mut self) -> Result<DiscoveryGcHygiene, DiscoveryError> {
        for (quarantined, workspace) in self.quarantines {
            let removed = if directory_identity(&quarantined.path)
                .is_ok_and(|identity| identity == quarantined.directory_identity)
            {
                fs::remove_dir_all(&quarantined.path)
            } else {
                Err(io::Error::other("quarantined directory identity changed"))
            };
            match removed {
                Ok(()) => {
                    private_storage::sync_directory(&workspace)?;
                    match &quarantined.kind {
                        QuarantineKind::Session => {
                            self.report.removed_sessions += 1;
                            self.report.removed_bytes =
                                self.report.removed_bytes.saturating_add(quarantined.bytes);
                        }
                        #[cfg(feature = "ghostty-core-proof")]
                        QuarantineKind::ColdHistory { .. } => {
                            self.report.removed_cold_archives += 1;
                            self.report.removed_cold_history_bytes = self
                                .report
                                .removed_cold_history_bytes
                                .saturating_add(quarantined.bytes);
                        }
                    }
                }
                Err(error) => {
                    if matches!(&quarantined.kind, QuarantineKind::Session) {
                        self.report.remaining_sessions += 1;
                    }
                    self.report.remaining_bytes = self
                        .report
                        .remaining_bytes
                        .saturating_add(quarantined.bytes);
                    self.report.budget_unmet = true;
                    self.report.remaining_state_incomplete = true;
                    push_diagnostic(
                        &mut self.report,
                        &self.policy,
                        relative(&self.root, &quarantined.path),
                        &format!("quarantine sweep failed: {error}"),
                    );
                }
            }
        }
        Ok(DiscoveryGcHygiene {
            root: self.root,
            policy: self.policy,
            report: self.report,
            workspaces: self.workspaces,
            residues: self.residues,
            complete: self.complete,
        })
    }
}

struct QuarantineRuntime<'a, P, S> {
    process_probe: &'a mut P,
    scanned_entries: &'a mut usize,
    sync_parent: &'a mut S,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectoryIdentity {
    volume: u64,
    object: u128,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct TreeFacts {
    bytes: u64,
    modified_unix_ms: u64,
    fingerprint: [u8; 32],
}

#[derive(Debug)]
enum TreeInspection {
    Valid(TreeFacts),
    Unsafe(&'static str),
    ScanLimit,
}

impl DiscoveryRoot {
    pub fn acquire_maintenance_shared(&self) -> Result<DiscoveryMaintenanceLock, DiscoveryError> {
        self.acquire_maintenance(false)
    }

    pub fn acquire_maintenance_exclusive(
        &self,
    ) -> Result<DiscoveryMaintenanceLock, DiscoveryError> {
        self.acquire_maintenance(true)
    }

    /// Proves one exact registration has no current manifest or creator while
    /// the caller holds the root-wide exclusive maintenance fence.
    pub fn exact_session_absence_is_quiescent_locked(
        &self,
        maintenance: &DiscoveryMaintenanceLock,
        key: &DiscoveryKey,
    ) -> Result<bool, DiscoveryError> {
        if maintenance.root != self.path() || !maintenance.exclusive {
            return Err(DiscoveryError::LockScopeMismatch);
        }
        let Some(session) = self.open_session_if_present(key.clone())? else {
            return Ok(true);
        };
        if session.read_manifest_if_present()?.is_some() {
            return Ok(false);
        }
        let lifetime_path = session.path().join(LIFETIME_LOCK_FILE_NAME);
        if !private_storage::path_entry_exists(&lifetime_path)? {
            return Ok(false);
        }
        let lifetime = private_storage::open_existing_file(&lifetime_path)?;
        match FileExt::try_lock_exclusive(&lifetime) {
            Ok(()) => {}
            Err(error) if super::file_lock::is_contended(&error) => return Ok(false),
            Err(error) => {
                return Err(DiscoveryError::io(
                    "acquire exact absence lifetime lock",
                    &lifetime_path,
                    error,
                ));
            }
        }
        Ok(session.read_manifest_if_present()?.is_none())
    }

    /// Serialize a correctness-critical discovery registration behind any
    /// active creator or GC pass. Maintenance tooling keeps its non-blocking
    /// exclusive API above; user-visible creation must wait rather than turn
    /// ordinary contention into a refusal.
    pub(crate) fn acquire_registration_exclusive(
        &self,
    ) -> Result<DiscoveryMaintenanceLock, DiscoveryError> {
        private_storage::validate_directory(self.path())?;
        let path = self.path().join(REGISTRATION_LOCK_FILE_NAME);
        let file = private_storage::open_lock_file(&path)?;
        FileExt::lock_exclusive(&file).map_err(|error| {
            DiscoveryError::io("acquire discovery registration lock", &path, error)
        })?;
        Ok(DiscoveryMaintenanceLock {
            file,
            root: self.path().to_path_buf(),
            exclusive: true,
        })
    }

    fn acquire_maintenance(
        &self,
        exclusive: bool,
    ) -> Result<DiscoveryMaintenanceLock, DiscoveryError> {
        self.acquire_maintenance_with(exclusive, |file| {
            if exclusive {
                FileExt::try_lock_exclusive(file)
            } else {
                // Correctness-critical writers wait for an existing mutation
                // fence instead of failing an ordinary session operation.
                FileExt::lock_shared(file)
            }
        })
    }

    /// A finite capacity worker may queue its short mutation phase behind
    /// readers. It owns no journal/session locks while waiting, and must keep
    /// discovery planning and recursive sweeping outside this lease.
    pub fn wait_for_maintenance_exclusive(
        &self,
    ) -> Result<DiscoveryMaintenanceLock, DiscoveryError> {
        self.acquire_maintenance_with(true, FileExt::lock_exclusive)
    }

    fn acquire_maintenance_with(
        &self,
        exclusive: bool,
        acquire: impl FnOnce(&File) -> io::Result<()>,
    ) -> Result<DiscoveryMaintenanceLock, DiscoveryError> {
        private_storage::validate_directory(self.path())?;
        let path = self.path().join(MAINTENANCE_LOCK_FILE_NAME);
        let file = private_storage::open_lock_file(&path)?;
        match acquire(&file) {
            Ok(()) => Ok(DiscoveryMaintenanceLock {
                file,
                root: self.path().to_path_buf(),
                exclusive,
            }),
            Err(error) if super::file_lock::is_contended(&error) => {
                Err(DiscoveryError::AlreadyLocked { path })
            }
            Err(error) => Err(DiscoveryError::io(
                "acquire discovery maintenance lock",
                &path,
                error,
            )),
        }
    }

    pub fn collect_garbage_locked(
        &self,
        maintenance: &DiscoveryMaintenanceLock,
        mode: DiscoveryGcMode,
        policy: &DiscoveryGcPolicy,
        protected_relative_paths: &BTreeSet<PathBuf>,
    ) -> Result<DiscoveryGcReport, DiscoveryError> {
        self.collect_garbage_locked_with_process_probe(
            maintenance,
            mode,
            policy,
            protected_relative_paths,
            |_| DiscoveryGcProcessStatus::Unknown,
        )
    }

    pub fn collect_garbage_locked_with_process_probe(
        &self,
        maintenance: &DiscoveryMaintenanceLock,
        mode: DiscoveryGcMode,
        policy: &DiscoveryGcPolicy,
        protected_relative_paths: &BTreeSet<PathBuf>,
        mut process_probe: impl FnMut(&ProcessProof) -> DiscoveryGcProcessStatus,
    ) -> Result<DiscoveryGcReport, DiscoveryError> {
        let mutation_authority = DiscoveryGcMutationAuthority::new(self, maintenance)?;
        self.collect_garbage(
            mode,
            policy,
            protected_relative_paths,
            &mut process_probe,
            &mut |path| sync_quarantine_parent(path).is_ok(),
            Some(mutation_authority),
        )
    }

    pub fn preview_garbage_with_process_probe(
        &self,
        policy: &DiscoveryGcPolicy,
        protected_relative_paths: &BTreeSet<PathBuf>,
        mut process_probe: impl FnMut(&ProcessProof) -> DiscoveryGcProcessStatus,
    ) -> Result<DiscoveryGcReport, DiscoveryError> {
        self.collect_garbage(
            DiscoveryGcMode::Preview,
            policy,
            protected_relative_paths,
            &mut process_probe,
            &mut |path| sync_quarantine_parent(path).is_ok(),
            None,
        )
    }

    /// Read-only registration planning; a plan never grants deletion authority.
    pub fn plan_registration_garbage(
        &self,
        policy: &DiscoveryGcPolicy,
        process_probe: impl FnMut(&ProcessProof) -> DiscoveryGcProcessStatus,
    ) -> Result<DiscoveryGcPlan, DiscoveryError> {
        self.plan_garbage_with_process_probe(policy, &BTreeSet::new(), process_probe)
    }

    pub fn plan_garbage_with_process_probe(
        &self,
        policy: &DiscoveryGcPolicy,
        protected_relative_paths: &BTreeSet<PathBuf>,
        mut process_probe: impl FnMut(&ProcessProof) -> DiscoveryGcProcessStatus,
    ) -> Result<DiscoveryGcPlan, DiscoveryError> {
        self.scan_garbage(policy, protected_relative_paths, &mut process_probe)
    }

    /// Revalidate a plan against current pending-source protection and exact
    /// lifetime/process evidence before detaching registration directories.
    pub fn quarantine_registration_garbage_locked(
        &self,
        maintenance: &DiscoveryMaintenanceLock,
        plan: DiscoveryGcPlan,
        protected_relative_paths: &BTreeSet<PathBuf>,
        mut process_probe: impl FnMut(&ProcessProof) -> DiscoveryGcProcessStatus,
    ) -> Result<DiscoveryGcSweep, DiscoveryError> {
        self.quarantine_garbage(
            plan,
            DiscoveryGcMutationAuthority::new(self, maintenance)?,
            protected_relative_paths,
            &mut process_probe,
            &mut |path| sync_quarantine_parent(path).is_ok(),
        )
    }

    /// Full hygiene requires fresh caller-owned recovery protection and the
    /// exclusive fence. It never rescans ordinary session trees. The returned
    /// cold sweep owns exact archive leases, not the root lease, through deletion.
    pub fn quarantine_hygiene_locked(
        &self,
        maintenance: &DiscoveryMaintenanceLock,
        hygiene: DiscoveryGcHygiene,
    ) -> Result<DiscoveryGcSweep, DiscoveryError> {
        let _authority = DiscoveryGcMutationAuthority::new(self, maintenance)?;
        self.quarantine_hygiene(DiscoveryGcMode::Apply, hygiene)
    }

    fn collect_garbage(
        &self,
        mode: DiscoveryGcMode,
        policy: &DiscoveryGcPolicy,
        protected_relative_paths: &BTreeSet<PathBuf>,
        process_probe: &mut impl FnMut(&ProcessProof) -> DiscoveryGcProcessStatus,
        sync_quarantine: &mut impl FnMut(&Path) -> bool,
        mutation_authority: Option<DiscoveryGcMutationAuthority<'_>>,
    ) -> Result<DiscoveryGcReport, DiscoveryError> {
        let plan = self.scan_garbage(policy, protected_relative_paths, process_probe)?;
        if !plan.complete {
            return Ok(plan.report);
        }
        if mode == DiscoveryGcMode::Preview {
            return self
                .quarantine_hygiene(
                    mode,
                    DiscoveryGcHygiene {
                        root: plan.root,
                        policy: plan.policy,
                        report: plan.report,
                        workspaces: plan.workspaces,
                        residues: plan.residues,
                        complete: plan.complete,
                    },
                )?
                .sweep();
        }
        let hygiene = self
            .quarantine_garbage(
                plan,
                mutation_authority.ok_or(DiscoveryError::LockScopeMismatch)?,
                protected_relative_paths,
                process_probe,
                sync_quarantine,
            )?
            .sweep_for_full_gc()?;
        self.quarantine_hygiene(mode, hygiene)?.sweep()
    }

    fn quarantine_hygiene(
        &self,
        mode: DiscoveryGcMode,
        hygiene: DiscoveryGcHygiene,
    ) -> Result<DiscoveryGcSweep, DiscoveryError> {
        if hygiene.root != self.path() {
            return Err(DiscoveryError::LockScopeMismatch);
        }
        let DiscoveryGcHygiene {
            policy,
            report,
            workspaces,
            residues,
            complete,
            ..
        } = hygiene;
        let mut sweep = DiscoveryGcSweep {
            root: self.path().to_path_buf(),
            policy,
            report,
            quarantines: Vec::new(),
            workspaces: Vec::new(),
            residues: Vec::new(),
            complete: false,
        };
        if !complete {
            return Ok(sweep);
        }
        let report = &mut sweep.report;
        let policy = &sweep.policy;
        for (path, identity) in residues {
            // Another collector may have swept this residue while the root
            // fence was released. Never substitute a replacement directory.
            if !private_storage::path_entry_exists(&path)? {
                continue;
            }
            report.remaining_sessions += 1;
            let workspace = path.parent().expect("quarantine has workspace");
            if private_storage::validate_directory(workspace).is_err()
                || identity.is_none()
                || directory_identity(&path).ok() != identity
            {
                report.budget_unmet = true;
                report.remaining_state_incomplete = true;
                retain_quarantine_bytes(&path, report, None);
                push_diagnostic(
                    report,
                    policy,
                    relative(self.path(), &path),
                    "quarantine residue identity changed or was unreadable",
                );
                continue;
            }
            inspect_or_sweep_quarantine(self.path(), workspace, &path, mode, policy, report)?;
        }
        // Removing an empty workspace must not race a new creator, even though
        // detached registration deletion itself needs no root fence.
        for workspace in workspaces {
            if mode == DiscoveryGcMode::Apply && fs::remove_dir(&workspace).is_ok() {
                private_storage::sync_directory(self.path())?;
            }
        }
        #[cfg(feature = "ghostty-core-proof")]
        quarantine_cold_history_garbage(
            self,
            mode,
            policy,
            report,
            &mut sweep.quarantines,
            |path| private_storage::sync_directory(path).is_ok(),
        )?;
        Ok(sweep)
    }

    fn scan_garbage(
        &self,
        policy: &DiscoveryGcPolicy,
        protected_relative_paths: &BTreeSet<PathBuf>,
        process_probe: &mut impl FnMut(&ProcessProof) -> DiscoveryGcProcessStatus,
    ) -> Result<DiscoveryGcPlan, DiscoveryError> {
        if policy.maximum_age_ms < policy.minimum_age_ms
            || policy.max_scan_entries == 0
            || policy.max_diagnostics == 0
        {
            return Err(DiscoveryError::GcPolicyInvalid);
        }

        private_storage::validate_directory(self.path())?;
        let mut report = DiscoveryGcReport::default();
        let finish = |report, planned, workspaces, residues, complete| DiscoveryGcPlan {
            root: self.path().to_path_buf(),
            policy: policy.clone(),
            report,
            planned,
            workspaces,
            residues,
            complete,
            now_unix_ms: unix_time_ms(),
        };

        let now_unix_ms = unix_time_ms();
        let mut candidates = Vec::new();
        let mut workspaces = Vec::new();
        let mut residues = Vec::new();
        let root_entries = fs::read_dir(self.path()).map_err(|error| {
            DiscoveryError::io("read discovery root for gc", self.path(), error)
        })?;
        for workspace_entry in root_entries {
            report.scanned_entries = report.scanned_entries.saturating_add(1);
            if report.scanned_entries > policy.max_scan_entries {
                report.budget_unmet = true;
                report.remaining_state_incomplete = true;
                push_diagnostic(
                    &mut report,
                    policy,
                    Path::new("."),
                    "gc root scan limit was reached; no session deletion was attempted",
                );
                return Ok(finish(report, Vec::new(), Vec::new(), Vec::new(), false));
            }
            let Ok(workspace_entry) = workspace_entry else {
                push_diagnostic(
                    &mut report,
                    policy,
                    Path::new("."),
                    "workspace entry became unreadable",
                );
                report.budget_unmet = true;
                report.remaining_state_incomplete = true;
                continue;
            };
            let workspace_path = workspace_entry.path();
            if !has_component_prefix(&workspace_path, "w_") {
                continue;
            }
            if private_storage::validate_directory(&workspace_path).is_err() {
                push_diagnostic(
                    &mut report,
                    policy,
                    relative(self.path(), &workspace_path),
                    "workspace is not an owner-only real directory",
                );
                report.budget_unmet = true;
                report.remaining_state_incomplete = true;
                continue;
            }
            workspaces.push(workspace_path.clone());
            let session_entries = match fs::read_dir(&workspace_path) {
                Ok(entries) => entries,
                Err(_) => {
                    push_diagnostic(
                        &mut report,
                        policy,
                        relative(self.path(), &workspace_path),
                        "workspace could not be enumerated",
                    );
                    report.budget_unmet = true;
                    report.remaining_state_incomplete = true;
                    continue;
                }
            };
            for session_entry in session_entries {
                report.scanned_entries = report.scanned_entries.saturating_add(1);
                if report.scanned_entries > policy.max_scan_entries {
                    report.budget_unmet = true;
                    report.remaining_state_incomplete = true;
                    push_diagnostic(
                        &mut report,
                        policy,
                        relative(self.path(), &workspace_path),
                        "gc workspace scan limit was reached; no session deletion was attempted",
                    );
                    return Ok(finish(report, Vec::new(), Vec::new(), Vec::new(), false));
                }
                let Ok(session_entry) = session_entry else {
                    push_diagnostic(
                        &mut report,
                        policy,
                        relative(self.path(), &workspace_path),
                        "session entry became unreadable",
                    );
                    report.budget_unmet = true;
                    report.remaining_state_incomplete = true;
                    continue;
                };
                let session_path = session_entry.path();
                if has_component_prefix(&session_path, QUARANTINE_SESSION_PREFIX) {
                    let identity = directory_identity(&session_path).ok();
                    residues.push((session_path, identity));
                    continue;
                }
                if !has_component_prefix(&session_path, "s_") {
                    continue;
                }
                report.scanned_sessions += 1;
                report.remaining_sessions += 1;
                if report.scanned_sessions > policy.max_scan_entries {
                    report.budget_unmet = true;
                    report.remaining_state_incomplete = true;
                    push_diagnostic(
                        &mut report,
                        policy,
                        Path::new("."),
                        "gc session scan limit was reached; no deletion was attempted",
                    );
                    return Ok(finish(report, Vec::new(), Vec::new(), Vec::new(), false));
                }
                let relative_path = relative(self.path(), &session_path).to_path_buf();
                let directory_identity = match directory_identity(&session_path) {
                    Ok(identity) => identity,
                    Err(_) => {
                        report.protected_sessions += 1;
                        report.budget_unmet = true;
                        report.remaining_state_incomplete = true;
                        report.remaining_bytes = report.remaining_bytes.saturating_add(
                            fs::symlink_metadata(&session_path)
                                .map(|metadata| metadata.len())
                                .unwrap_or(0),
                        );
                        push_diagnostic(
                            &mut report,
                            policy,
                            &relative_path,
                            "session directory identity is unreadable",
                        );
                        continue;
                    }
                };
                let facts = match inspect_session_tree(
                    &session_path,
                    policy,
                    &mut report.scanned_entries,
                ) {
                    TreeInspection::Valid(facts) => facts,
                    TreeInspection::Unsafe(reason) => {
                        report.protected_sessions += 1;
                        report.budget_unmet = true;
                        report.remaining_state_incomplete = true;
                        report.remaining_bytes = report.remaining_bytes.saturating_add(
                            fs::symlink_metadata(&session_path)
                                .map(|metadata| metadata.len())
                                .unwrap_or(0),
                        );
                        push_diagnostic(&mut report, policy, &relative_path, reason);
                        continue;
                    }
                    TreeInspection::ScanLimit => {
                        report.budget_unmet = true;
                        report.remaining_state_incomplete = true;
                        push_diagnostic(
                            &mut report,
                            policy,
                            &relative_path,
                            "gc tree scan limit was reached; no deletion was attempted",
                        );
                        return Ok(finish(report, Vec::new(), Vec::new(), Vec::new(), false));
                    }
                };
                report.remaining_bytes = report.remaining_bytes.saturating_add(facts.bytes);
                if protected_relative_paths.contains(&relative_path) {
                    report.protected_sessions += 1;
                    push_diagnostic(
                        &mut report,
                        policy,
                        &relative_path,
                        "pending recovery protects this session",
                    );
                    continue;
                }
                let kind = match read_current_manifest_for_gc(self, &session_path) {
                    Some(DiscoveryManifest::Ready(ready)) => {
                        if policy.selection != DiscoveryGcSelection::AllEligible {
                            report.protected_sessions += 1;
                            continue;
                        }
                        let expected_generation = DiscoveryManifest::Ready(ready).generation();
                        match abandoned_ready_is_reservable(
                            self,
                            &session_path,
                            &expected_generation,
                            policy,
                            &mut report.scanned_entries,
                            process_probe,
                        ) {
                            Ok(true) => CandidateKind::AbandonedReady {
                                expected_generation,
                            },
                            Ok(false) => {
                                report.protected_sessions += 1;
                                continue;
                            }
                            Err(_) => {
                                report.protected_sessions += 1;
                                report.budget_unmet = true;
                                push_diagnostic(
                                    &mut report,
                                    policy,
                                    &relative_path,
                                    "active generation could not be proven abandoned",
                                );
                                continue;
                            }
                        }
                    }
                    Some(DiscoveryManifest::Starting(_) | DiscoveryManifest::Exited(_)) => {
                        report.protected_sessions += 1;
                        continue;
                    }
                    None => {
                        let process_proofs = match retired_process_proofs(
                            self,
                            &session_path,
                            policy,
                            &mut report.scanned_entries,
                        ) {
                            Ok(proofs) => proofs,
                            Err(_) => {
                                report.protected_sessions += 1;
                                report.budget_unmet = true;
                                push_diagnostic(
                                    &mut report,
                                    policy,
                                    &relative_path,
                                    "retired process evidence became unreadable",
                                );
                                continue;
                            }
                        };
                        if process_proofs
                            .iter()
                            .any(|proof| process_probe(proof) != DiscoveryGcProcessStatus::Absent)
                        {
                            report.protected_sessions += 1;
                            push_diagnostic(
                                &mut report,
                                policy,
                                &relative_path,
                                "retired process generation is live or could not be disproven",
                            );
                            continue;
                        }
                        CandidateKind::Debris
                    }
                };
                if facts.modified_unix_ms > now_unix_ms {
                    report.protected_sessions += 1;
                    push_diagnostic(
                        &mut report,
                        policy,
                        &relative_path,
                        "future-dated state is protected",
                    );
                    continue;
                }
                let age_ms = now_unix_ms.saturating_sub(facts.modified_unix_ms);
                if age_ms < policy.minimum_age_ms {
                    report.protected_sessions += 1;
                    continue;
                }
                report.eligible_sessions += 1;
                report.eligible_oldest_age_ms = Some(
                    report
                        .eligible_oldest_age_ms
                        .unwrap_or_default()
                        .max(age_ms),
                );
                candidates.push(Candidate {
                    path: session_path,
                    relative_path,
                    workspace_path: workspace_path.clone(),
                    directory_identity,
                    bytes: facts.bytes,
                    modified_unix_ms: facts.modified_unix_ms,
                    fingerprint: facts.fingerprint,
                    kind,
                });
            }
        }

        candidates.sort_by(|left, right| {
            left.modified_unix_ms
                .cmp(&right.modified_unix_ms)
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        let mut remaining_sessions = report.remaining_sessions;
        let mut remaining_bytes = report.remaining_bytes;
        let mut planned = Vec::new();
        for candidate in candidates {
            let age_ms = now_unix_ms.saturating_sub(candidate.modified_unix_ms);
            let expired = age_ms >= policy.maximum_age_ms;
            let over_budget = remaining_sessions > policy.max_session_entries
                || remaining_bytes > policy.max_total_bytes;
            if policy.selection == DiscoveryGcSelection::Retention && !expired && !over_budget {
                continue;
            }
            remaining_sessions = remaining_sessions.saturating_sub(1);
            remaining_bytes = remaining_bytes.saturating_sub(candidate.bytes);
            let age_ms = now_unix_ms.saturating_sub(candidate.modified_unix_ms);
            report.planned_oldest_age_ms =
                Some(report.planned_oldest_age_ms.unwrap_or_default().max(age_ms));
            planned.push(candidate);
        }
        report.planned_sessions = planned.len();
        report.remaining_sessions = remaining_sessions;
        report.remaining_bytes = remaining_bytes;
        report.budget_unmet |= remaining_sessions > policy.max_session_entries
            || remaining_bytes > policy.max_total_bytes;

        Ok(finish(report, planned, workspaces, residues, true))
    }

    fn quarantine_garbage(
        &self,
        plan: DiscoveryGcPlan,
        mutation_authority: DiscoveryGcMutationAuthority<'_>,
        protected_relative_paths: &BTreeSet<PathBuf>,
        process_probe: &mut impl FnMut(&ProcessProof) -> DiscoveryGcProcessStatus,
        sync_quarantine: &mut impl FnMut(&Path) -> bool,
    ) -> Result<DiscoveryGcSweep, DiscoveryError> {
        if plan.root != self.path() {
            return Err(DiscoveryError::LockScopeMismatch);
        }
        let DiscoveryGcPlan {
            policy,
            mut report,
            planned,
            now_unix_ms,
            workspaces,
            residues,
            complete,
            ..
        } = plan;
        let policy = &policy;
        let mut quarantines = Vec::new();
        let mut retained_planned_bytes = 0_u64;
        for candidate in planned {
            let mut runtime = QuarantineRuntime {
                process_probe,
                scanned_entries: &mut report.scanned_entries,
                sync_parent: sync_quarantine,
            };
            match quarantine_candidate(
                self,
                &candidate,
                protected_relative_paths,
                now_unix_ms,
                policy,
                &mut runtime,
                &mutation_authority,
            ) {
                Ok(Some(quarantined)) => {
                    report.quarantined_sessions += 1;
                    if !quarantined.durable {
                        retained_planned_bytes =
                            retained_planned_bytes.saturating_add(quarantined.bytes);
                        report.quarantine_residue_bytes = report
                            .quarantine_residue_bytes
                            .saturating_add(quarantined.bytes);
                        report.budget_unmet = true;
                        push_diagnostic(
                            &mut report,
                            policy,
                            relative(self.path(), &quarantined.path),
                            "quarantine rename directory sync failed; residue was retained",
                        );
                        continue;
                    }
                    quarantines.push((quarantined, candidate.workspace_path.clone()));
                }
                Ok(None) => {
                    retained_planned_bytes = retained_planned_bytes.saturating_add(candidate.bytes);
                    report.protected_sessions += 1;
                    report.budget_unmet = true;
                    report.remaining_state_incomplete = true;
                    push_diagnostic(
                        &mut report,
                        policy,
                        &candidate.relative_path,
                        "candidate changed or became locked before quarantine",
                    );
                }
                Err(error) => {
                    retained_planned_bytes = retained_planned_bytes.saturating_add(candidate.bytes);
                    report.budget_unmet = true;
                    report.remaining_state_incomplete = true;
                    push_diagnostic(
                        &mut report,
                        policy,
                        &candidate.relative_path,
                        &format!("candidate quarantine failed: {error}"),
                    );
                }
            }
        }
        report.remaining_sessions = report
            .remaining_sessions
            .saturating_add(report.planned_sessions - quarantines.len());
        report.remaining_bytes = report
            .remaining_bytes
            .saturating_add(retained_planned_bytes);
        Ok(DiscoveryGcSweep {
            root: self.path().to_path_buf(),
            policy: policy.clone(),
            report,
            quarantines,
            workspaces,
            residues,
            complete,
        })
    }
}

#[cfg(feature = "ghostty-core-proof")]
struct ColdHistoryGcCandidate {
    path: PathBuf,
    directory_name: String,
    bytes: u64,
    lease: File,
    directory_identity: DirectoryIdentity,
}

#[cfg(feature = "ghostty-core-proof")]
fn quarantine_cold_history_garbage(
    root: &DiscoveryRoot,
    mode: DiscoveryGcMode,
    policy: &DiscoveryGcPolicy,
    report: &mut DiscoveryGcReport,
    quarantines: &mut Vec<(QuarantinedCandidate, PathBuf)>,
    mut sync_parent: impl FnMut(&Path) -> bool,
) -> Result<(), DiscoveryError> {
    let history_root = root.path().join(COLD_HISTORY_DIRECTORY_NAME);
    if !private_storage::path_entry_exists(&history_root)? {
        return Ok(());
    }
    if private_storage::validate_directory(&history_root).is_err() {
        report.budget_unmet = true;
        report.remaining_state_incomplete = true;
        push_diagnostic(
            report,
            policy,
            Path::new(COLD_HISTORY_DIRECTORY_NAME),
            "cold history root is not an owner-only real directory",
        );
        return Ok(());
    }
    let Some(references) = collect_cold_history_references(root, policy, report)? else {
        push_diagnostic(
            report,
            policy,
            Path::new(COLD_HISTORY_DIRECTORY_NAME),
            "cold history reference census is incomplete; no archive deletion was attempted",
        );
        report.budget_unmet = true;
        report.remaining_state_incomplete = true;
        return Ok(());
    };
    let mut candidates = Vec::new();
    let mut archive_scan_entries = 0;
    let entries = fs::read_dir(&history_root).map_err(|error| {
        DiscoveryError::io("read cold history root for gc", &history_root, error)
    })?;
    for entry in entries {
        if !record_census_entry(
            &mut report.scanned_entries,
            &mut archive_scan_entries,
            policy.max_scan_entries,
        ) {
            report.budget_unmet = true;
            report.remaining_state_incomplete = true;
            push_diagnostic(
                report,
                policy,
                Path::new(COLD_HISTORY_DIRECTORY_NAME),
                "cold history scan limit was reached; no archive deletion was attempted",
            );
            return Ok(());
        }
        let Ok(entry) = entry else {
            report.budget_unmet = true;
            report.remaining_state_incomplete = true;
            continue;
        };
        let path = entry.path();
        let Some(name) = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string)
        else {
            report.budget_unmet = true;
            report.remaining_state_incomplete = true;
            continue;
        };
        let residue = name.starts_with(QUARANTINE_COLD_HISTORY_PREFIX);
        if !residue && !name.starts_with("h_") {
            // Nothing else is owned by cold-history GC. Do not silently omit
            // unknown state from an otherwise-complete report: a future
            // producer or tampered tree must remain visible and fail closed.
            report.budget_unmet = true;
            report.remaining_state_incomplete = true;
            push_diagnostic(
                report,
                policy,
                relative(root.path(), &path),
                "cold history root contains an entry outside GC ownership",
            );
            continue;
        }
        if !residue {
            report.scanned_cold_archives = report.scanned_cold_archives.saturating_add(1);
        }
        if !residue && !is_cold_history_directory_name(&name) {
            report.protected_cold_archives = report.protected_cold_archives.saturating_add(1);
            report.budget_unmet = true;
            report.remaining_state_incomplete = true;
            push_diagnostic(
                report,
                policy,
                relative(root.path(), &path),
                "cold history archive name is outside GC ownership",
            );
            continue;
        }
        let facts = match inspect_cold_history_tree(
            &path,
            policy,
            &mut report.scanned_entries,
            &mut archive_scan_entries,
        ) {
            TreeInspection::Valid(facts) => facts,
            TreeInspection::Unsafe(reason) => {
                report.protected_cold_archives = report.protected_cold_archives.saturating_add(1);
                report.budget_unmet = true;
                report.remaining_state_incomplete = true;
                push_diagnostic(report, policy, relative(root.path(), &path), reason);
                continue;
            }
            TreeInspection::ScanLimit => {
                report.budget_unmet = true;
                report.remaining_state_incomplete = true;
                return Ok(());
            }
        };
        if references.contains(&name) {
            report.protected_cold_archives = report.protected_cold_archives.saturating_add(1);
            report.remaining_bytes = report.remaining_bytes.saturating_add(facts.bytes);
            continue;
        }
        if residue && mode == DiscoveryGcMode::Preview {
            report.remaining_bytes = report.remaining_bytes.saturating_add(facts.bytes);
            continue;
        }
        let identity = match directory_identity(&path) {
            Ok(identity) => identity,
            Err(_) => {
                report.protected_cold_archives += 1;
                report.remaining_bytes = report.remaining_bytes.saturating_add(facts.bytes);
                report.budget_unmet = true;
                report.remaining_state_incomplete = true;
                continue;
            }
        };
        let lease_path = path.join(COLD_HISTORY_LEASE_FILE_NAME);
        // Interrupted deletion may already have removed a residue's lease.
        // Reestablish it under the root fence before returning deferred work;
        // competing collectors must respect a queued sweep's archive lease.
        let lease = match if residue {
            private_storage::open_lock_file(&lease_path)
        } else {
            private_storage::open_existing_file(&lease_path)
        } {
            Ok(lease) => lease,
            Err(_) => {
                report.protected_cold_archives = report.protected_cold_archives.saturating_add(1);
                report.remaining_bytes = report.remaining_bytes.saturating_add(facts.bytes);
                report.budget_unmet = true;
                report.remaining_state_incomplete = true;
                push_diagnostic(
                    report,
                    policy,
                    relative(root.path(), &path),
                    "cold history lease is missing or unsafe",
                );
                continue;
            }
        };
        match FileExt::try_lock_exclusive(&lease) {
            Ok(()) => {}
            Err(error) if super::file_lock::is_contended(&error) => {
                report.protected_cold_archives = report.protected_cold_archives.saturating_add(1);
                report.remaining_bytes = report.remaining_bytes.saturating_add(facts.bytes);
                continue;
            }
            Err(error) => {
                return Err(DiscoveryError::io(
                    "acquire cold history gc lease",
                    &lease_path,
                    error,
                ));
            }
        }
        if !residue {
            report.planned_cold_archives = report.planned_cold_archives.saturating_add(1);
        }
        if mode == DiscoveryGcMode::Preview {
            let _ = FileExt::unlock(&lease);
        } else {
            candidates.push(ColdHistoryGcCandidate {
                path,
                directory_name: name,
                bytes: facts.bytes,
                lease,
                directory_identity: identity,
            });
        }
    }
    if mode == DiscoveryGcMode::Preview {
        report.budget_unmet |= report.remaining_bytes > policy.max_total_bytes;
        return Ok(());
    }

    // Re-read every durable reference after all candidate writer leases are
    // held. Any unreadable checkpoint protects the entire candidate set.
    let Some(references) = collect_cold_history_references(root, policy, report)? else {
        report.budget_unmet = true;
        report.remaining_state_incomplete = true;
        for candidate in candidates {
            report.remaining_bytes = report.remaining_bytes.saturating_add(candidate.bytes);
            let _ = FileExt::unlock(&candidate.lease);
        }
        return Ok(());
    };
    for candidate in candidates {
        if references.contains(&candidate.directory_name) {
            report.protected_cold_archives = report.protected_cold_archives.saturating_add(1);
            report.remaining_bytes = report.remaining_bytes.saturating_add(candidate.bytes);
            let _ = FileExt::unlock(&candidate.lease);
            continue;
        }
        let path = candidate.path.clone();
        let bytes = candidate.bytes;
        match quarantine_cold_history_candidate(&history_root, candidate, &mut sync_parent) {
            Ok(quarantined) if quarantined.durable => {
                quarantines.push((quarantined, history_root.clone()))
            }
            result => {
                report.remaining_bytes = report.remaining_bytes.saturating_add(bytes);
                report.budget_unmet = true;
                report.remaining_state_incomplete = true;
                push_diagnostic(
                    report,
                    policy,
                    relative(root.path(), &path),
                    &match result {
                        Ok(_) => "cold history quarantine sync failed; residue was retained".into(),
                        Err(error) => format!("cold history quarantine failed: {error}"),
                    },
                );
            }
        }
    }
    report.budget_unmet |= report.remaining_bytes > policy.max_total_bytes;
    Ok(())
}

#[cfg(feature = "ghostty-core-proof")]
fn quarantine_cold_history_candidate(
    history_root: &Path,
    candidate: ColdHistoryGcCandidate,
    mut sync_parent: impl FnMut(&Path) -> bool,
) -> Result<QuarantinedCandidate, DiscoveryError> {
    for _ in 0..MAX_QUARANTINE_NAME_ATTEMPTS {
        let sequence = QUARANTINE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let quarantine = history_root.join(format!(
            "{QUARANTINE_COLD_HISTORY_PREFIX}{}-{sequence}",
            std::process::id()
        ));
        if private_storage::path_entry_exists(&quarantine)? {
            continue;
        }
        if directory_identity(&candidate.path).ok() != Some(candidate.directory_identity) {
            return Err(DiscoveryError::GenerationMismatch);
        }
        fs::rename(&candidate.path, &quarantine).map_err(|error| {
            DiscoveryError::io("quarantine cold history", &candidate.path, error)
        })?;
        return Ok(QuarantinedCandidate {
            path: quarantine,
            directory_identity: candidate.directory_identity,
            bytes: candidate.bytes,
            durable: sync_parent(history_root),
            kind: QuarantineKind::ColdHistory {
                _lease: candidate.lease,
            },
        });
    }
    Err(DiscoveryError::TemporaryFileCollisionLimit {
        attempts: MAX_QUARANTINE_NAME_ATTEMPTS,
    })
}

#[cfg(feature = "ghostty-core-proof")]
fn collect_cold_history_references(
    root: &DiscoveryRoot,
    policy: &DiscoveryGcPolicy,
    report: &mut DiscoveryGcReport,
) -> Result<Option<BTreeSet<String>>, DiscoveryError> {
    let mut references = BTreeSet::new();
    let mut census_scan_entries = 0;
    let entries = fs::read_dir(root.path()).map_err(|error| {
        DiscoveryError::io("read discovery root for cold gc", root.path(), error)
    })?;
    for workspace in entries {
        if !record_census_entry(
            &mut report.scanned_entries,
            &mut census_scan_entries,
            policy.max_scan_entries,
        ) {
            return Ok(None);
        }
        let Ok(workspace) = workspace else {
            return Ok(None);
        };
        let workspace_path = workspace.path();
        if !has_component_prefix(&workspace_path, "w_") {
            continue;
        }
        if private_storage::validate_directory(&workspace_path).is_err() {
            return Ok(None);
        }
        let sessions = match fs::read_dir(&workspace_path) {
            Ok(sessions) => sessions,
            Err(_) => return Ok(None),
        };
        for session in sessions {
            if !record_census_entry(
                &mut report.scanned_entries,
                &mut census_scan_entries,
                policy.max_scan_entries,
            ) {
                return Ok(None);
            }
            let Ok(session) = session else {
                return Ok(None);
            };
            let session_path = session.path();
            if !has_component_prefix(&session_path, "s_") {
                continue;
            }
            if private_storage::validate_directory(&session_path).is_err() {
                return Ok(None);
            }
            let checkpoint_entries = match fs::read_dir(&session_path) {
                Ok(entries) => entries,
                Err(_) => return Ok(None),
            };
            for entry in checkpoint_entries {
                if !record_census_entry(
                    &mut report.scanned_entries,
                    &mut census_scan_entries,
                    policy.max_scan_entries,
                ) {
                    return Ok(None);
                }
                let Ok(entry) = entry else {
                    return Ok(None);
                };
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    return Ok(None);
                };
                let is_checkpoint = name == PRESENTATION_CHECKPOINT_FILE_NAME;
                let is_handoff = presentation_handoff_checkpoint_digest(name).is_some();
                if !is_checkpoint && !is_handoff {
                    continue;
                }
                let checkpoint = match read_gc_presentation_checkpoint(&path) {
                    Ok(checkpoint) => checkpoint,
                    Err(_) => return Ok(None),
                };
                if let Some((history_namespace, store_id)) = checkpoint.cold_history_identity() {
                    references.insert(super::cold_history_storage::history_directory_name(
                        history_namespace,
                        store_id,
                    ));
                }
            }
        }
    }
    Ok(Some(references))
}

#[cfg(feature = "ghostty-core-proof")]
fn read_gc_presentation_checkpoint(path: &Path) -> Result<PresentationCheckpoint, DiscoveryError> {
    let mut file = private_storage::open_existing_file(path)?;
    let length = file
        .metadata()
        .map_err(|error| DiscoveryError::io("inspect gc presentation checkpoint", path, error))?
        .len();
    if length > PRESENTATION_CHECKPOINT_MAX_BYTES as u64 {
        return Err(DiscoveryError::PresentationCheckpointTooLarge {
            actual: length,
            maximum: PRESENTATION_CHECKPOINT_MAX_BYTES,
        });
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| DiscoveryError::io("seek gc presentation checkpoint", path, error))?;
    let mut bytes = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
    Read::by_ref(&mut file)
        .take(PRESENTATION_CHECKPOINT_MAX_BYTES.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| DiscoveryError::io("read gc presentation checkpoint", path, error))?;
    if bytes.len() > PRESENTATION_CHECKPOINT_MAX_BYTES {
        return Err(DiscoveryError::PresentationCheckpointTooLarge {
            actual: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            maximum: PRESENTATION_CHECKPOINT_MAX_BYTES,
        });
    }
    if let Some(expected_digest) = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(presentation_handoff_checkpoint_digest)
    {
        let actual_digest = format!("{:x}", Sha256::digest(&bytes));
        if actual_digest != expected_digest {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "gc presentation handoff digest",
            });
        }
    }
    let checkpoint: PresentationCheckpoint =
        serde_json::from_slice(&bytes).map_err(DiscoveryError::Serialization)?;
    checkpoint.validate()?;
    Ok(checkpoint)
}

#[cfg(feature = "ghostty-core-proof")]
fn inspect_cold_history_tree(
    path: &Path,
    policy: &DiscoveryGcPolicy,
    scanned_entries: &mut usize,
    census_scan_entries: &mut usize,
) -> TreeInspection {
    if private_storage::validate_directory(path).is_err() {
        return TreeInspection::Unsafe("cold history is not an owner-only real directory");
    }
    let mut facts = match metadata_facts(path) {
        Ok(facts) => facts,
        Err(_) => return TreeInspection::Unsafe("cold history metadata is unreadable"),
    };
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => return TreeInspection::Unsafe("cold history contents are unreadable"),
    };
    for entry in entries {
        if !record_census_entry(
            scanned_entries,
            census_scan_entries,
            policy.max_scan_entries,
        ) {
            return TreeInspection::ScanLimit;
        }
        let Ok(entry) = entry else {
            return TreeInspection::Unsafe("cold history entry became unreadable");
        };
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return TreeInspection::Unsafe("cold history entry name is not UTF-8");
        };
        let numbered_chunk = name
            .strip_prefix("chunk-")
            .and_then(|suffix| suffix.strip_suffix(".bin"))
            .is_some_and(|digits| {
                digits.len() == 20 && digits.bytes().all(|byte| byte.is_ascii_digit())
            });
        let allowed = matches!(name, COLD_HISTORY_LEASE_FILE_NAME | "root.pb")
            || numbered_chunk
            || name.starts_with(".chunk.tmp-")
            || name.starts_with(".root.tmp-");
        if !allowed || private_storage::open_existing_file(&path).is_err() {
            return TreeInspection::Unsafe("cold history contains an unknown or unsafe entry");
        }
        match metadata_facts(&path) {
            Ok(child) => merge_facts(&mut facts, child),
            Err(_) => return TreeInspection::Unsafe("cold history entry metadata is unreadable"),
        }
    }
    TreeInspection::Valid(facts)
}

#[cfg(feature = "ghostty-core-proof")]
fn record_census_entry(aggregate: &mut usize, census: &mut usize, maximum: usize) -> bool {
    *aggregate = aggregate.saturating_add(1);
    *census = census.saturating_add(1);
    *census <= maximum
}

#[cfg(feature = "ghostty-core-proof")]
fn is_cold_history_directory_name(name: &str) -> bool {
    name.strip_prefix("h_").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn read_current_manifest_for_gc(
    root: &DiscoveryRoot,
    session_path: &Path,
) -> Option<DiscoveryManifest> {
    let manifest_path = session_path.join(MANIFEST_FILE_NAME);
    if !matches!(private_storage::path_entry_exists(&manifest_path), Ok(true)) {
        return None;
    }
    read_current_manifest_at(&manifest_path, root.limits()).ok()
}

fn current_manifest_is_valid(root: &DiscoveryRoot, session_path: &Path) -> bool {
    read_current_manifest_for_gc(root, session_path).is_some()
}

fn candidate_manifest_matches(
    root: &DiscoveryRoot,
    session_path: &Path,
    kind: &CandidateKind,
) -> bool {
    match kind {
        CandidateKind::Debris => !current_manifest_is_valid(root, session_path),
        CandidateKind::AbandonedReady {
            expected_generation,
        } => read_current_manifest_for_gc(root, session_path).is_some_and(|manifest| {
            matches!(manifest, DiscoveryManifest::Ready(_))
                && manifest.generation() == *expected_generation
        }),
    }
}

fn active_and_retired_process_proofs(
    root: &DiscoveryRoot,
    session_path: &Path,
    expected_generation: &ManifestGeneration,
    policy: &DiscoveryGcPolicy,
    scanned_entries: &mut usize,
) -> Result<Option<Vec<ProcessProof>>, DiscoveryError> {
    let Some(DiscoveryManifest::Ready(ready)) = read_current_manifest_for_gc(root, session_path)
    else {
        return Ok(None);
    };
    let manifest = DiscoveryManifest::Ready(ready.clone());
    if manifest.generation() != *expected_generation {
        return Ok(None);
    }
    let mut proofs = vec![ready.common.host_process, ready.provider_process];
    proofs.extend(retired_process_proofs(
        root,
        session_path,
        policy,
        scanned_entries,
    )?);
    Ok(Some(proofs))
}

fn abandoned_ready_is_reservable(
    root: &DiscoveryRoot,
    session_path: &Path,
    expected_generation: &ManifestGeneration,
    policy: &DiscoveryGcPolicy,
    scanned_entries: &mut usize,
    process_probe: &mut impl FnMut(&ProcessProof) -> DiscoveryGcProcessStatus,
) -> Result<bool, DiscoveryError> {
    let lifetime_path = session_path.join(LIFETIME_LOCK_FILE_NAME);
    if !private_storage::path_entry_exists(&lifetime_path)? {
        return Ok(false);
    }
    let lifetime_file = private_storage::open_existing_file(&lifetime_path)?;
    match FileExt::try_lock_exclusive(&lifetime_file) {
        Ok(()) => {}
        Err(error) if super::file_lock::is_contended(&error) => return Ok(false),
        Err(error) => {
            return Err(DiscoveryError::io(
                "acquire abandoned generation lifetime lock",
                &lifetime_path,
                error,
            ));
        }
    }
    let result = active_and_retired_process_proofs(
        root,
        session_path,
        expected_generation,
        policy,
        scanned_entries,
    )?
    .is_some_and(|proofs| {
        proofs
            .iter()
            .all(|proof| process_probe(proof) == DiscoveryGcProcessStatus::Absent)
    });
    let _ = FileExt::unlock(&lifetime_file);
    Ok(result)
}

fn quarantine_candidate<P, S>(
    root: &DiscoveryRoot,
    candidate: &Candidate,
    protected_relative_paths: &BTreeSet<PathBuf>,
    now_unix_ms: u64,
    policy: &DiscoveryGcPolicy,
    runtime: &mut QuarantineRuntime<'_, P, S>,
    mutation_authority: &DiscoveryGcMutationAuthority<'_>,
) -> Result<Option<QuarantinedCandidate>, DiscoveryError>
where
    P: FnMut(&ProcessProof) -> DiscoveryGcProcessStatus,
    S: FnMut(&Path) -> bool,
{
    if protected_relative_paths.contains(&candidate.relative_path)
        || private_storage::validate_directory(&candidate.path).is_err()
        || !candidate_manifest_matches(root, &candidate.path, &candidate.kind)
    {
        return Ok(None);
    }
    if directory_identity(&candidate.path).ok() != Some(candidate.directory_identity) {
        return Ok(None);
    }
    let TreeInspection::Valid(before_lock) =
        inspect_session_tree(&candidate.path, policy, runtime.scanned_entries)
    else {
        return Ok(None);
    };
    if before_lock.bytes != candidate.bytes
        || before_lock.modified_unix_ms != candidate.modified_unix_ms
        || before_lock.fingerprint != candidate.fingerprint
    {
        return Ok(None);
    }
    let lifetime_path = candidate.path.join(LIFETIME_LOCK_FILE_NAME);
    let lifetime_existed = private_storage::path_entry_exists(&lifetime_path)?;
    let session_directory_before_lock = metadata_facts(&candidate.path).map_err(|error| {
        DiscoveryError::io("inspect gc session directory", &candidate.path, error)
    })?;
    let lifetime_file = match candidate.kind {
        CandidateKind::Debris => private_storage::open_lock_file(&lifetime_path)?,
        CandidateKind::AbandonedReady { .. } => {
            private_storage::open_existing_file(&lifetime_path)?
        }
    };
    match FileExt::try_lock_exclusive(&lifetime_file) {
        Ok(()) => {}
        Err(error) if super::file_lock::is_contended(&error) => return Ok(None),
        Err(error) => {
            return Err(DiscoveryError::io(
                "acquire gc lifetime lock",
                &lifetime_path,
                error,
            ));
        }
    }
    let mut lifetime_file = Some(lifetime_file);
    let expected_after_lock = if lifetime_existed {
        before_lock
    } else {
        let mut expected = before_lock;
        let lifetime_metadata = lifetime_file
            .as_ref()
            .expect("locked lifetime file remains owned before quarantine")
            .metadata()
            .map_err(|error| {
                DiscoveryError::io("inspect gc lifetime lock", &lifetime_path, error)
            })?;
        let lifetime_facts = metadata_facts_from_metadata(&lifetime_path, &lifetime_metadata)
            .map_err(|error| {
                DiscoveryError::io("fingerprint gc lifetime lock", &lifetime_path, error)
            })?;
        let session_directory_after_lock = metadata_facts(&candidate.path).map_err(|error| {
            DiscoveryError::io("reinspect gc session directory", &candidate.path, error)
        })?;
        expected.bytes = expected
            .bytes
            .saturating_sub(session_directory_before_lock.bytes)
            .saturating_add(session_directory_after_lock.bytes)
            .saturating_add(lifetime_facts.bytes);
        expected.modified_unix_ms = expected
            .modified_unix_ms
            .max(session_directory_after_lock.modified_unix_ms)
            .max(lifetime_facts.modified_unix_ms);
        for (expected, lifetime) in expected
            .fingerprint
            .iter_mut()
            .zip(lifetime_facts.fingerprint)
        {
            *expected ^= lifetime;
        }
        expected
    };
    let result = (|| {
        if directory_identity(&candidate.path).ok() != Some(candidate.directory_identity)
            || !candidate_manifest_matches(root, &candidate.path, &candidate.kind)
        {
            return Ok(None);
        }
        let TreeInspection::Valid(after_lock) =
            inspect_session_tree(&candidate.path, policy, runtime.scanned_entries)
        else {
            return Ok(None);
        };
        if after_lock != expected_after_lock {
            return Ok(None);
        }
        let process_proofs = match &candidate.kind {
            CandidateKind::Debris => {
                retired_process_proofs(root, &candidate.path, policy, runtime.scanned_entries)?
            }
            CandidateKind::AbandonedReady {
                expected_generation,
            } => {
                let Some(proofs) = active_and_retired_process_proofs(
                    root,
                    &candidate.path,
                    expected_generation,
                    policy,
                    runtime.scanned_entries,
                )?
                else {
                    return Ok(None);
                };
                proofs
            }
        };
        if process_proofs
            .iter()
            .any(|proof| (runtime.process_probe)(proof) != DiscoveryGcProcessStatus::Absent)
        {
            return Ok(None);
        }
        let TreeInspection::Valid(facts) =
            inspect_session_tree(&candidate.path, policy, runtime.scanned_entries)
        else {
            return Ok(None);
        };
        if facts != after_lock
            || candidate.modified_unix_ms > now_unix_ms
            || now_unix_ms.saturating_sub(candidate.modified_unix_ms) < policy.minimum_age_ms
        {
            return Ok(None);
        }
        release_lifetime_lock_for_directory_rename(
            &mut lifetime_file,
            &lifetime_path,
            mutation_authority,
        )?;
        for _ in 0..MAX_QUARANTINE_NAME_ATTEMPTS {
            let sequence = QUARANTINE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let quarantine_path = candidate.workspace_path.join(format!(
                "{QUARANTINE_SESSION_PREFIX}{}_{}_{}",
                std::process::id(),
                now_unix_ms,
                sequence
            ));
            if private_storage::path_entry_exists(&quarantine_path)? {
                continue;
            }
            if directory_identity(&candidate.path).ok() != Some(candidate.directory_identity) {
                return Ok(None);
            }
            match fs::rename(&candidate.path, &quarantine_path) {
                Ok(()) => {
                    // Source and quarantine are siblings in one workspace.
                    // A single parent-directory sync makes the atomic rename
                    // durable without the two-directory crash window where
                    // both names could be lost.
                    let durable = (runtime.sync_parent)(&candidate.workspace_path);
                    return Ok(Some(QuarantinedCandidate {
                        path: quarantine_path,
                        directory_identity: candidate.directory_identity,
                        bytes: facts.bytes,
                        durable,
                        kind: QuarantineKind::Session,
                    }));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error) => {
                    return Err(DiscoveryError::io(
                        "quarantine discovery session",
                        &candidate.path,
                        error,
                    ));
                }
            }
        }
        Err(DiscoveryError::TemporaryFileCollisionLimit {
            attempts: MAX_QUARANTINE_NAME_ATTEMPTS,
        })
    })();
    if let Some(lifetime_file) = lifetime_file.as_ref() {
        let _ = FileExt::unlock(lifetime_file);
    }
    result
}

#[cfg(windows)]
fn release_lifetime_lock_for_directory_rename(
    lifetime_file: &mut Option<File>,
    lifetime_path: &Path,
    _mutation_authority: &DiscoveryGcMutationAuthority<'_>,
) -> Result<(), DiscoveryError> {
    // Windows refuses to rename a directory while any child handle is open,
    // even when that child was opened with FILE_SHARE_DELETE. The root-wide
    // mutation authority blocks every conforming lifetime-lock acquisition,
    // so it safely carries exclusivity across this required handle close.
    let lifetime_file = lifetime_file
        .take()
        .expect("Windows lifetime lock is owned until quarantine rename");
    FileExt::unlock(&lifetime_file).map_err(|error| {
        DiscoveryError::io(
            "release gc lifetime lock before directory rename",
            lifetime_path,
            error,
        )
    })?;
    drop(lifetime_file);
    Ok(())
}

#[cfg(not(windows))]
fn release_lifetime_lock_for_directory_rename(
    _lifetime_file: &mut Option<File>,
    _lifetime_path: &Path,
    _mutation_authority: &DiscoveryGcMutationAuthority<'_>,
) -> Result<(), DiscoveryError> {
    Ok(())
}

fn inspect_session_tree(
    path: &Path,
    policy: &DiscoveryGcPolicy,
    scanned_entries: &mut usize,
) -> TreeInspection {
    if private_storage::validate_directory(path).is_err() {
        return TreeInspection::Unsafe("session is not an owner-only real directory");
    }
    let mut facts = match metadata_facts(path) {
        Ok(facts) => facts,
        Err(_) => return TreeInspection::Unsafe("session metadata is unreadable"),
    };
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => return TreeInspection::Unsafe("session contents are unreadable"),
    };
    for entry in entries {
        *scanned_entries = scanned_entries.saturating_add(1);
        if *scanned_entries > policy.max_scan_entries {
            return TreeInspection::ScanLimit;
        }
        let Ok(entry) = entry else {
            return TreeInspection::Unsafe("session entry became unreadable");
        };
        let entry_path = entry.path();
        let Some(name) = entry_path.file_name().and_then(|value| value.to_str()) else {
            return TreeInspection::Unsafe("session entry name is not UTF-8");
        };
        if name == "retired" {
            match inspect_retired_tree(&entry_path, policy, scanned_entries) {
                TreeInspection::Valid(child) => merge_facts(&mut facts, child),
                other => return other,
            }
            continue;
        }
        if !is_allowed_session_file(name) {
            return TreeInspection::Unsafe("session contains an unknown entry");
        }
        if private_storage::open_existing_file(&entry_path).is_err() {
            return TreeInspection::Unsafe("session file is not an owner-only regular file");
        }
        match metadata_facts(&entry_path) {
            Ok(child) => merge_facts(&mut facts, child),
            Err(_) => return TreeInspection::Unsafe("session file metadata is unreadable"),
        }
    }
    TreeInspection::Valid(facts)
}

fn inspect_retired_tree(
    path: &Path,
    policy: &DiscoveryGcPolicy,
    scanned_entries: &mut usize,
) -> TreeInspection {
    if private_storage::validate_directory(path).is_err() {
        return TreeInspection::Unsafe("retired state is not an owner-only real directory");
    }
    let mut facts = match metadata_facts(path) {
        Ok(facts) => facts,
        Err(_) => return TreeInspection::Unsafe("retired state metadata is unreadable"),
    };
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(_) => return TreeInspection::Unsafe("retired state is unreadable"),
    };
    for entry in entries {
        *scanned_entries = scanned_entries.saturating_add(1);
        if *scanned_entries > policy.max_scan_entries {
            return TreeInspection::ScanLimit;
        }
        let Ok(entry) = entry else {
            return TreeInspection::Unsafe("retired entry became unreadable");
        };
        let entry_path = entry.path();
        let allowed = entry_path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| {
                (name.starts_with("g_") && name.ends_with(".json"))
                    || name.starts_with(".retired.tmp-")
            });
        if !allowed || private_storage::open_existing_file(&entry_path).is_err() {
            return TreeInspection::Unsafe("retired state contains an unsafe entry");
        }
        match metadata_facts(&entry_path) {
            Ok(child) => merge_facts(&mut facts, child),
            Err(_) => return TreeInspection::Unsafe("retired entry metadata is unreadable"),
        }
    }
    TreeInspection::Valid(facts)
}

fn retired_process_proofs(
    root: &DiscoveryRoot,
    session_path: &Path,
    policy: &DiscoveryGcPolicy,
    scanned_entries: &mut usize,
) -> Result<Vec<ProcessProof>, DiscoveryError> {
    let retired_path = session_path.join("retired");
    if !private_storage::path_entry_exists(&retired_path)? {
        return Ok(Vec::new());
    }
    private_storage::validate_directory(&retired_path)?;
    let entries = fs::read_dir(&retired_path)
        .map_err(|error| DiscoveryError::io("read retired state for gc", &retired_path, error))?;
    let mut proofs = Vec::new();
    for entry in entries {
        *scanned_entries = scanned_entries.saturating_add(1);
        if *scanned_entries > policy.max_scan_entries {
            return Err(DiscoveryError::LookupScanLimitExceeded {
                maximum: policy.max_scan_entries,
            });
        }
        let entry = entry.map_err(|error| {
            DiscoveryError::io("read retired state entry for gc", &retired_path, error)
        })?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            return Err(DiscoveryError::GcPolicyInvalid);
        };
        if name.starts_with(".retired.tmp-") {
            private_storage::open_existing_file(&path)?;
            continue;
        }
        if !name.starts_with("g_") || !name.ends_with(".json") {
            return Err(DiscoveryError::GcPolicyInvalid);
        }
        match super::manifest_store::read_manifest_at(&path, root.limits()) {
            Ok(DiscoveryManifest::Exited(exited)) => {
                proofs.push(exited.common.host_process);
                proofs.push(exited.tombstone.provider_process);
            }
            Ok(_) => {}
            Err(DiscoveryError::Serialization(_))
            | Err(DiscoveryError::ManifestValidation(_))
            | Err(DiscoveryError::ManifestTooLarge { .. }) => {
                return Err(DiscoveryError::StaleDiscovery {
                    path,
                    reason: super::StaleDiscoveryReason::InvalidManifest,
                });
            }
            Err(error) => return Err(error),
        }
    }
    Ok(proofs)
}

fn is_allowed_session_file(name: &str) -> bool {
    if matches!(
        name,
        MANIFEST_FILE_NAME | LIFETIME_LOCK_FILE_NAME | "presentation.json"
    ) || name.starts_with(".manifest.tmp-")
        || name.starts_with(".presentation.tmp-")
    {
        return true;
    }
    #[cfg(feature = "local-runtime")]
    {
        let durable_handoff = presentation_handoff_checkpoint_digest(name).is_some();
        durable_handoff || name.starts_with(".presentation-handoff.tmp-")
    }
    #[cfg(not(feature = "local-runtime"))]
    {
        false
    }
}

#[cfg(feature = "local-runtime")]
fn presentation_handoff_checkpoint_digest(name: &str) -> Option<&str> {
    let identity = name
        .strip_prefix(super::manifest_store::PRESENTATION_HANDOFF_FILE_PREFIX)?
        .strip_suffix(".json")?;
    let (source_identity, checkpoint_digest) = identity.split_once('-')?;
    let valid_component = |component: &str| {
        component.len() == 64
            && component
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    };
    (valid_component(source_identity) && valid_component(checkpoint_digest))
        .then_some(checkpoint_digest)
}

fn metadata_facts(path: &Path) -> io::Result<TreeFacts> {
    let metadata = fs::symlink_metadata(path)?;
    metadata_facts_from_metadata(path, &metadata)
}

fn metadata_facts_from_metadata(path: &Path, metadata: &fs::Metadata) -> io::Result<TreeFacts> {
    let modified_unix_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| value.as_millis().try_into().ok())
        .unwrap_or(0);
    Ok(TreeFacts {
        bytes: metadata.len(),
        modified_unix_ms,
        fingerprint: if metadata.is_file() {
            metadata_fingerprint(path, metadata)?
        } else {
            [0; 32]
        },
    })
}

#[cfg(unix)]
fn metadata_fingerprint(path: &Path, metadata: &fs::Metadata) -> io::Result<[u8; 32]> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    let mut digest = Sha256::new();
    digest.update(path.as_os_str().as_bytes());
    digest.update(metadata.dev().to_be_bytes());
    digest.update(metadata.ino().to_be_bytes());
    digest.update(metadata.mode().to_be_bytes());
    digest.update(metadata.uid().to_be_bytes());
    digest.update(metadata.gid().to_be_bytes());
    digest.update(metadata.len().to_be_bytes());
    digest.update(metadata.mtime().to_be_bytes());
    digest.update(metadata.mtime_nsec().to_be_bytes());
    digest.update(metadata.ctime().to_be_bytes());
    digest.update(metadata.ctime_nsec().to_be_bytes());
    Ok(digest.finalize().into())
}

#[cfg(windows)]
fn metadata_fingerprint(path: &Path, _metadata: &fs::Metadata) -> io::Result<[u8; 32]> {
    use std::os::windows::ffi::OsStrExt;

    let facts = private_storage::file_facts(path).map_err(io::Error::other)?;
    let mut digest = Sha256::new();
    for unit in path.as_os_str().encode_wide() {
        digest.update(unit.to_le_bytes());
    }
    digest.update(facts.volume_serial.to_be_bytes());
    digest.update(facts.file_index.to_be_bytes());
    digest.update(facts.creation_time.to_be_bytes());
    digest.update(facts.last_write_time.to_be_bytes());
    digest.update(facts.change_time.to_be_bytes());
    digest.update(facts.attributes.to_be_bytes());
    digest.update(facts.size.to_be_bytes());
    Ok(digest.finalize().into())
}

#[cfg(unix)]
fn directory_identity(path: &Path) -> Result<DirectoryIdentity, DiscoveryError> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::symlink_metadata(path)
        .map_err(|error| DiscoveryError::io("read discovery directory identity", path, error))?;
    Ok(DirectoryIdentity {
        volume: metadata.dev(),
        object: u128::from(metadata.ino()),
    })
}

#[cfg(windows)]
fn directory_identity(path: &Path) -> Result<DirectoryIdentity, DiscoveryError> {
    let (volume, object) = private_storage::directory_identity(path)?;
    Ok(DirectoryIdentity {
        volume,
        object: u128::from(object),
    })
}

fn merge_facts(target: &mut TreeFacts, child: TreeFacts) {
    target.bytes = target.bytes.saturating_add(child.bytes);
    target.modified_unix_ms = target.modified_unix_ms.max(child.modified_unix_ms);
    for (target, child) in target.fingerprint.iter_mut().zip(child.fingerprint) {
        *target ^= child;
    }
}

fn sync_quarantine_parent(path: &Path) -> Result<(), DiscoveryError> {
    private_storage::sync_directory(path)
}

fn inspect_or_sweep_quarantine(
    root: &Path,
    workspace: &Path,
    path: &Path,
    mode: DiscoveryGcMode,
    policy: &DiscoveryGcPolicy,
    report: &mut DiscoveryGcReport,
) -> Result<(), DiscoveryError> {
    if private_storage::validate_directory(path).is_err() {
        report.budget_unmet = true;
        report.remaining_state_incomplete = true;
        retain_quarantine_bytes(path, report, None);
        push_diagnostic(
            report,
            policy,
            relative(root, path),
            "quarantine residue is not an owner-only real directory",
        );
        return Ok(());
    }

    let facts = match inspect_session_tree(path, policy, &mut report.scanned_entries) {
        TreeInspection::Valid(facts) => facts,
        TreeInspection::Unsafe(reason) => {
            report.budget_unmet = true;
            report.remaining_state_incomplete = true;
            retain_quarantine_bytes(path, report, None);
            push_diagnostic(report, policy, relative(root, path), reason);
            return Ok(());
        }
        TreeInspection::ScanLimit => {
            report.budget_unmet = true;
            report.remaining_state_incomplete = true;
            retain_quarantine_bytes(path, report, None);
            push_diagnostic(
                report,
                policy,
                relative(root, path),
                "quarantine tree scan limit was reached; residue was retained",
            );
            return Ok(());
        }
    };

    if mode == DiscoveryGcMode::Preview {
        report.budget_unmet = true;
        retain_quarantine_bytes(path, report, Some(facts.bytes));
        push_diagnostic(
            report,
            policy,
            relative(root, path),
            "quarantine residue would be swept by apply",
        );
        return Ok(());
    }

    // The quarantine name and the source name share this one parent. Sync it
    // before deletion so a crash after a previous failed sync resolves to one
    // durable name, never to neither name.
    if let Err(error) = private_storage::sync_directory(workspace) {
        report.budget_unmet = true;
        retain_quarantine_bytes(path, report, Some(facts.bytes));
        push_diagnostic(
            report,
            policy,
            relative(root, path),
            &format!("quarantine parent sync failed; residue was retained: {error}"),
        );
        return Ok(());
    }
    match fs::remove_dir_all(path) {
        Ok(()) => {
            private_storage::sync_directory(workspace)?;
            report.quarantine_residue_removed += 1;
            report.remaining_sessions = report.remaining_sessions.saturating_sub(1);
        }
        Err(error) => {
            report.budget_unmet = true;
            report.remaining_state_incomplete = true;
            retain_quarantine_bytes(path, report, None);
            push_diagnostic(
                report,
                policy,
                relative(root, path),
                &format!("quarantine sweep failed: {error}"),
            );
        }
    }
    Ok(())
}

fn retain_quarantine_bytes(
    path: &Path,
    report: &mut DiscoveryGcReport,
    inspected_bytes: Option<u64>,
) {
    let bytes = inspected_bytes.unwrap_or_else(|| {
        fs::symlink_metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
    });
    report.quarantine_residue_bytes = report.quarantine_residue_bytes.saturating_add(bytes);
    report.remaining_bytes = report.remaining_bytes.saturating_add(bytes);
}

fn push_diagnostic(
    report: &mut DiscoveryGcReport,
    policy: &DiscoveryGcPolicy,
    relative_path: &Path,
    reason: &str,
) {
    if report.diagnostics.len() >= policy.max_diagnostics {
        report.diagnostics_truncated = true;
        return;
    }
    report.diagnostics.push(DiscoveryGcDiagnostic {
        relative_path: relative_path.to_string_lossy().into_owned(),
        reason: reason.to_string(),
    });
}

fn relative<'a>(root: &'a Path, path: &'a Path) -> &'a Path {
    path.strip_prefix(root).unwrap_or(path)
}

fn has_component_prefix(path: &Path, prefix: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(prefix))
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests;
