use crate::recovery_journal::{
    self, RecoveryJournalGcPolicy, RecoveryJournalGcReport, RecoveryJournalInspection,
    RecoverySourceLockInspection, managed_create_ledger,
};
use crate::{
    ExitedSessionRetirementCursor, ExitedSessionRetirementMode, LocalProcessGenerationStatus,
    LocalSessionCatalog, MAX_EXITED_SESSION_RETIREMENT_TARGETS, ProcessDescriptor, SessionSelector,
    probe_local_process_generation,
};
use hmux_host::local_discovery::{
    DiscoveryError, DiscoveryGcHygiene, DiscoveryGcMode, DiscoveryGcPolicy,
    DiscoveryGcProcessStatus, DiscoveryGcReport, DiscoveryGcSelection,
    DiscoveryRegistrationCapacity, DiscoveryRoot, SessionLookupKey,
};
use hmux_session_protocol::ProcessProof;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Default)]
pub struct LocalStateGcPolicy {
    pub discovery: DiscoveryGcPolicy,
    pub recovery_journal: RecoveryJournalGcPolicy,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStateGcReport {
    pub schema_version: u16,
    pub mode: &'static str,
    pub discovery_selection: &'static str,
    pub discovery_root_present: bool,
    pub recovery_source_busy: bool,
    pub recovery_source_locks: RecoverySourceLockInspection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovery: Option<DiscoveryGcReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_before: Option<RecoveryJournalInspection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_gc: Option<RecoveryJournalGcReport>,
}

#[derive(Debug)]
pub enum LocalStateGcError {
    Discovery(DiscoveryError),
    RecoveryJournal(String),
    ManagedCreateLedger(String),
    ExitedRetirement(String),
    PendingSourceIdentity(String),
    ProtectionBusy,
    RootInspection(std::io::Error),
}

impl fmt::Display for LocalStateGcError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Discovery(error) => write!(formatter, "{error}"),
            Self::RecoveryJournal(error) => write!(formatter, "{error}"),
            Self::ManagedCreateLedger(error) => write!(formatter, "{error}"),
            Self::ExitedRetirement(error) => write!(formatter, "{error}"),
            Self::PendingSourceIdentity(error) => {
                write!(formatter, "hmux_state_gc_invalid_pending_source: {error}")
            }
            Self::ProtectionBusy => write!(
                formatter,
                "hmux_state_gc_protection_busy: recovery or create admission is in use"
            ),
            Self::RootInspection(error) => {
                write!(formatter, "hmux_state_gc_root_unreadable: {error}")
            }
        }
    }
}

impl std::error::Error for LocalStateGcError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Discovery(error) => Some(error),
            Self::RootInspection(error) => Some(error),
            Self::RecoveryJournal(_)
            | Self::ManagedCreateLedger(_)
            | Self::ExitedRetirement(_)
            | Self::PendingSourceIdentity(_)
            | Self::ProtectionBusy => None,
        }
    }
}

impl From<DiscoveryError> for LocalStateGcError {
    fn from(error: DiscoveryError) -> Self {
        Self::Discovery(error)
    }
}

pub fn collect_local_state(
    discovery_root: &Path,
    mode: DiscoveryGcMode,
    policy: &LocalStateGcPolicy,
) -> Result<LocalStateGcReport, LocalStateGcError> {
    let mode_name = match mode {
        DiscoveryGcMode::Preview => "preview",
        DiscoveryGcMode::Apply => "apply",
    };
    let selection_name = match policy.discovery.selection {
        DiscoveryGcSelection::Retention => "retention",
        DiscoveryGcSelection::AllEligible => "all_eligible",
    };
    match discovery_root.try_exists() {
        Ok(false) => {
            return Ok(LocalStateGcReport {
                schema_version: 1,
                mode: mode_name,
                discovery_selection: selection_name,
                discovery_root_present: false,
                recovery_source_busy: false,
                recovery_source_locks: RecoverySourceLockInspection::default(),
                discovery: None,
                recovery_before: None,
                recovery_gc: None,
            });
        }
        Ok(true) => {}
        Err(error) => return Err(LocalStateGcError::RootInspection(error)),
    }

    let root = DiscoveryRoot::open(discovery_root)?;
    let maintenance = match mode {
        DiscoveryGcMode::Preview => None,
        // Journal admission owns repair/inspection. Sharing discovery here
        // allows unrelated registrations while those narrower locks are busy.
        DiscoveryGcMode::Apply => Some(root.acquire_maintenance_shared()?),
    };
    // Repair a raw-entry overflow before authoritative inspection. Otherwise
    // the bounded inspector would reject the journal and `hmux gc --apply`
    // could never reach the only safe self-healing path.
    let mut recovery_gc = match mode {
        DiscoveryGcMode::Preview => None,
        DiscoveryGcMode::Apply => Some(
            recovery_journal::recover_scan_capacity_for_state_gc(discovery_root)
                .map_err(LocalStateGcError::RecoveryJournal)?,
        ),
    };
    let mut recovery_before = match mode {
        DiscoveryGcMode::Preview => recovery_journal::inspect_existing(discovery_root),
        DiscoveryGcMode::Apply => recovery_journal::inspect(discovery_root),
    }
    .map_err(LocalStateGcError::RecoveryJournal)?;
    let mut protected_paths = protected_paths(&recovery_before)?;
    protected_paths.extend(
        managed_create_ledger::pending_session_paths(discovery_root)
            .map_err(LocalStateGcError::ManagedCreateLedger)?,
    );
    // Preview observes only existing lock files and never publishes state. Its
    // result is informational; apply repeats the same inspection while holding
    // the maintenance-exclusive fence before it authorizes any deletion.
    let mut recovery_source_locks = recovery_journal::inspect_recovery_source_locks(discovery_root)
        .map_err(LocalStateGcError::RecoveryJournal)?;
    drop(maintenance);

    // A source lock can predate publication of its Reserved journal. Without
    // knowing that exact source, a destructive pass must protect the entire
    // discovery tree instead of guessing which candidate the operation owns.
    let discovery = if recovery_source_locks.busy_source_locks > 0 {
        None
    } else {
        match mode {
            DiscoveryGcMode::Preview => Some(root.preview_garbage_with_process_probe(
                &policy.discovery,
                &protected_paths,
                probe_process,
            )?),
            DiscoveryGcMode::Apply => {
                let (report, fresh) = apply_discovery_garbage(
                    &root,
                    &policy.discovery,
                    &protected_paths,
                    probe_process,
                )?;
                recovery_before = fresh.recovery;
                recovery_source_locks = fresh.sources;
                report
            }
        }
    };
    let recovery_source_busy = recovery_source_locks.busy_source_locks > 0;
    match mode {
        DiscoveryGcMode::Preview => {
            recovery_gc = Some(
                recovery_journal::preview_garbage_collect_completed(
                    discovery_root,
                    policy.recovery_journal,
                )
                .map_err(LocalStateGcError::RecoveryJournal)?,
            );
        }
        DiscoveryGcMode::Apply if !recovery_source_busy => {
            let _maintenance = root.acquire_maintenance_shared()?;
            let applied = recovery_journal::garbage_collect_completed(
                discovery_root,
                policy.recovery_journal,
            )
            .map_err(LocalStateGcError::RecoveryJournal)?;
            recovery_gc
                .as_mut()
                .expect("apply initializes overflow recovery report")
                .merge(applied);
        }
        DiscoveryGcMode::Apply => {
            if !recovery_gc
                .as_ref()
                .is_some_and(RecoveryJournalGcReport::removed_anything)
            {
                recovery_gc = None;
            }
        }
    }

    Ok(LocalStateGcReport {
        schema_version: 1,
        mode: mode_name,
        discovery_selection: selection_name,
        discovery_root_present: true,
        recovery_source_busy,
        recovery_source_locks,
        discovery,
        recovery_before: Some(recovery_before),
        recovery_gc,
    })
}

struct GcProtection {
    recovery: RecoveryJournalInspection,
    paths: BTreeSet<PathBuf>,
    sources: RecoverySourceLockInspection,
}

impl GcProtection {
    // Call only under the root mutation fence. Never wait for narrower locks
    // here: they can belong to an operation that needs discovery admission.
    fn try_read(root: &DiscoveryRoot) -> Result<Option<Self>, LocalStateGcError> {
        let Some(recovery) = recovery_journal::try_inspect_for_state_gc(root.path())
            .map_err(LocalStateGcError::RecoveryJournal)?
        else {
            return Ok(None);
        };
        let Some(mut paths) = managed_create_ledger::try_pending_session_paths(root.path())
            .map_err(LocalStateGcError::ManagedCreateLedger)?
        else {
            return Ok(None);
        };
        paths.extend(protected_paths(&recovery)?);
        let sources = recovery_journal::inspect_recovery_source_locks(root.path())
            .map_err(LocalStateGcError::RecoveryJournal)?;
        Ok(Some(Self {
            recovery,
            paths,
            sources,
        }))
    }
}

fn apply_discovery_garbage(
    root: &DiscoveryRoot,
    policy: &DiscoveryGcPolicy,
    preliminary_protection: &BTreeSet<PathBuf>,
    mut process_probe: impl FnMut(&ProcessProof) -> DiscoveryGcProcessStatus,
) -> Result<(Option<DiscoveryGcReport>, GcProtection), LocalStateGcError> {
    let plan =
        root.plan_garbage_with_process_probe(policy, preliminary_protection, &mut process_probe)?;
    let maintenance = root.acquire_maintenance_exclusive()?;
    let fresh = GcProtection::try_read(root)?.ok_or(LocalStateGcError::ProtectionBusy)?;
    if fresh.sources.busy_source_locks > 0 {
        return Ok((None, fresh));
    }
    let sweep = root.quarantine_registration_garbage_locked(
        &maintenance,
        plan,
        &fresh.paths,
        &mut process_probe,
    )?;
    drop(maintenance);
    let hygiene = sweep.sweep_for_full_gc()?;
    finish_discovery_garbage(root, hygiene, fresh)
}

fn finish_discovery_garbage(
    root: &DiscoveryRoot,
    hygiene: DiscoveryGcHygiene,
    fresh: GcProtection,
) -> Result<(Option<DiscoveryGcReport>, GcProtection), LocalStateGcError> {
    // Reference inspection, archive quarantine and prior session-residue
    // hygiene retain the fence; detached cold deletion does not. A newly
    // admitted recovery cannot undo session reclamation already completed.
    let maintenance = match root.acquire_maintenance_exclusive() {
        Ok(maintenance) => maintenance,
        Err(DiscoveryError::AlreadyLocked { .. }) => {
            return Ok((
                Some(hygiene.defer("remaining hygiene deferred: discovery admission is busy")),
                fresh,
            ));
        }
        Err(error) => return Err(error.into()),
    };
    let Some(current) = GcProtection::try_read(root)? else {
        return Ok((
            Some(hygiene.defer("remaining hygiene deferred: recovery or create admission is busy")),
            fresh,
        ));
    };
    let report = if current.sources.busy_source_locks > 0 {
        hygiene.defer("remaining hygiene deferred: recovery source is busy")
    } else {
        let sweep = root.quarantine_hygiene_locked(&maintenance, hygiene)?;
        drop(maintenance);
        sweep.sweep()?
    };
    Ok((Some(report), current))
}

pub fn maintain_registration_capacity(
    discovery_root: &Path,
) -> Result<DiscoveryRegistrationCapacity, LocalStateGcError> {
    maintain_registration_capacity_with_policy(discovery_root, &LocalStateGcPolicy::default())
}

fn maintain_registration_capacity_with_policy(
    discovery_root: &Path,
    policy: &LocalStateGcPolicy,
) -> Result<DiscoveryRegistrationCapacity, LocalStateGcError> {
    let root = DiscoveryRoot::open(discovery_root)?;
    let capacity = root.registration_capacity()?;
    let high_watermark = policy.discovery.max_session_entries;
    if capacity.used < high_watermark {
        return Ok(capacity);
    }
    // Leave a quarter of the high-water budget available for subsequent
    // admissions. Reclaiming one slot makes every next create repeat full GC.
    let retained_before_admission = high_watermark.saturating_sub((high_watermark / 4).max(1));
    let retirement_limit = capacity.used.saturating_sub(retained_before_admission);
    // Preserve overflow recovery before retirement needs a complete journal.
    // Journal-local admission owns this repair; a shared discovery lease lets
    // new registrations proceed and excludes only destructive root GC.
    {
        let _maintenance = root.acquire_maintenance_shared()?;
        recovery_journal::recover_scan_capacity_for_state_gc(discovery_root)
            .map_err(LocalStateGcError::RecoveryJournal)?;
    }
    // The normal age floor preserves history while there is headroom. Once
    // the high-water mark is reached, exact Exited generations are the reserve
    // that must yield immediately so the configured ceiling remains useful.
    archive_exited_generations_for_capacity(discovery_root, retirement_limit, 0)?;
    let mut policy = policy.clone();
    policy.discovery.max_session_entries = retained_before_admission;
    // Archival updates directory mtimes. Reclaim in the same fenced pass, and
    // include exact absent crash debris, rather than postponing headroom for a
    // second maintenance cycle.
    policy.discovery.minimum_age_ms = 0;
    reclaim_registration_capacity(&root, &policy.discovery)?;
    DiscoveryRoot::open(discovery_root)?
        .registration_capacity()
        .map_err(Into::into)
}

fn reclaim_registration_capacity(
    root: &DiscoveryRoot,
    policy: &DiscoveryGcPolicy,
) -> Result<(), LocalStateGcError> {
    // Scanning is observational. New registration and recovery can proceed;
    // the plan is not trusted until all protections are reread under the fence.
    let plan = root.plan_registration_garbage(policy, probe_process)?;
    let maintenance = root.wait_for_maintenance_exclusive()?;
    let Some(protection) = GcProtection::try_read(root)? else {
        return Ok(());
    };
    if protection.sources.busy_source_locks > 0 {
        return Ok(());
    }
    let sweep = root.quarantine_registration_garbage_locked(
        &maintenance,
        plan,
        &protection.paths,
        probe_process,
    )?;
    drop(maintenance);
    // Only already-quarantined registration debris is swept here. Cold
    // history and completed-journal hygiene remain owned by full state GC.
    sweep.sweep()?;
    Ok(())
}

fn archive_exited_generations_for_capacity(
    discovery_root: &Path,
    limit: usize,
    minimum_age_ms: u64,
) -> Result<usize, LocalStateGcError> {
    if limit == 0 {
        return Ok(0);
    }
    let catalog = LocalSessionCatalog::new(discovery_root);
    let now_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| LocalStateGcError::ExitedRetirement(error.to_string()))?
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    let mut cursor: Option<ExitedSessionRetirementCursor> = None;
    let mut eligible = Vec::new();
    loop {
        let page = catalog
            .exited_retirement_candidates_after(cursor.as_ref())
            .map_err(|error| LocalStateGcError::ExitedRetirement(error.to_string()))?;
        let has_more = page.has_more;
        let next_cursor = page.next_cursor;
        for target in page.targets {
            let selector =
                SessionSelector::new(target.session_id.clone(), Some(target.workspace_id.clone()));
            let descriptor = match catalog.find(&selector) {
                Ok(descriptor) => descriptor,
                Err(error) if error.is_session_absent() => continue,
                Err(error) => {
                    return Err(LocalStateGcError::ExitedRetirement(error.to_string()));
                }
            };
            let changed_unix_ms = descriptor
                .lifecycle_changed_unix_ms
                .parse::<u64>()
                .map_err(|error| LocalStateGcError::ExitedRetirement(error.to_string()))?;
            if now_unix_ms.saturating_sub(changed_unix_ms) >= minimum_age_ms {
                eligible.push((changed_unix_ms, target));
            }
        }
        if !has_more {
            break;
        }
        cursor = next_cursor;
        if cursor.is_none() {
            return Err(LocalStateGcError::ExitedRetirement(
                "exited retirement census omitted its continuation cursor".into(),
            ));
        }
    }
    eligible.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.workspace_id.cmp(&right.1.workspace_id))
            .then_with(|| left.1.session_id.cmp(&right.1.session_id))
    });
    let mut archived = 0;
    let mut targets = eligible.into_iter().map(|(_, target)| target);
    while archived < limit {
        let batch = targets
            .by_ref()
            .take(
                limit
                    .saturating_sub(archived)
                    .min(MAX_EXITED_SESSION_RETIREMENT_TARGETS),
            )
            .collect::<Vec<_>>();
        if batch.is_empty() {
            break;
        }
        let report = catalog
            .retire_exited_sessions(batch, ExitedSessionRetirementMode::Apply)
            .map_err(|error| LocalStateGcError::ExitedRetirement(error.to_string()))?;
        archived = archived
            .saturating_add(report.retired)
            .saturating_add(report.already_retired);
    }
    Ok(archived)
}

fn protected_paths(
    inspection: &RecoveryJournalInspection,
) -> Result<BTreeSet<PathBuf>, LocalStateGcError> {
    inspection
        .pending_sources
        .iter()
        .map(|source| {
            SessionLookupKey::new(&source.workspace_id, &source.session_id)
                .map(|key| key.relative_path())
                .map_err(|error| LocalStateGcError::PendingSourceIdentity(error.to_string()))
        })
        .collect()
}

fn probe_process(proof: &ProcessProof) -> DiscoveryGcProcessStatus {
    let descriptor = ProcessDescriptor {
        process_id: proof.process_id,
        start_marker: proof.start_marker.clone(),
    };
    match probe_local_process_generation(&descriptor) {
        Ok(LocalProcessGenerationStatus::Live) => DiscoveryGcProcessStatus::Live,
        Ok(LocalProcessGenerationStatus::Absent) => DiscoveryGcProcessStatus::Absent,
        Err(_) => DiscoveryGcProcessStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::recovery_journal::MAX_JOURNAL_SCAN_ENTRIES;
    use crate::recovery_journal::{
        RecoveryIdentity, RecoveryReservationState, RecoverySourceLockState, lock_source,
        managed_create_ledger, managed_create_ledger::ManagedCreateLedgerState,
        request_fingerprint, reserve, try_lock_source,
    };
    use hmux_host::local_discovery::DiscoveryKey;
    use hmux_host::local_discovery::{
        ClaimLinkage, DiscoveryManifest, ExitedManifest, HostLifetimeIdentity, LocalEndpoint,
        LocalEndpointKind, ManifestCommon, SessionClass as DiscoverySessionClass, StartingManifest,
    };
    use hmux_host::provider_epoch::{ExitTombstone, ProviderExitKind};
    use hmux_runtime_contract::{
        ManagedCreateGenerationFence, ManagedCreateOutcome, ManagedCreateReceipt,
        ManagedStopOutcome, ManagedStopReceipt, ManagedStopRequest, PermissionMode,
    };
    use hmux_session_protocol::{
        Exit, ProtocolVersion, RuntimeContext, SessionFence, VersionRange,
    };
    use tempfile::TempDir;

    fn aggressive_policy() -> LocalStateGcPolicy {
        LocalStateGcPolicy {
            discovery: DiscoveryGcPolicy {
                selection: DiscoveryGcSelection::Retention,
                minimum_age_ms: 0,
                maximum_age_ms: 0,
                max_session_entries: 0,
                max_total_bytes: 0,
                max_scan_entries: 1_024,
                max_diagnostics: 32,
            },
            recovery_journal: RecoveryJournalGcPolicy {
                minimum_completed_age: std::time::Duration::ZERO,
                maximum_completed_records: 0,
                maximum_completed_bytes: 0,
                minimum_orphan_age: std::time::Duration::ZERO,
                maximum_source_lock_files: 0,
                maximum_orphan_operation_locks: 0,
                maximum_temporary_files: 0,
            },
        }
    }

    fn publish_managed_exited_generation(
        root: &DiscoveryRoot,
        finalize_create_retirement: bool,
    ) -> PathBuf {
        publish_managed_exited_generation_at(root, finalize_create_retirement, 3)
    }

    fn publish_managed_exited_generation_at(
        root: &DiscoveryRoot,
        finalize_create_retirement: bool,
        exited_unix_ms: u64,
    ) -> PathBuf {
        let workspace_id = "workspace-retired";
        let session_id = "session-retired";
        let idempotency_key = "create-retired";
        let runner_principal = "principal-retired";
        let runner_instance = "runner-retired";
        let channel_epoch = 7;
        let host_instance_id = "host-retired";
        let terminal_epoch = "terminal-retired";
        let process_id = std::process::id();
        let absent_generation = ProcessProof {
            process_id,
            start_marker: format!("{process_id}-1"),
        };
        let host_process = absent_generation.clone();
        let provider_process = absent_generation;
        let discovery = root
            .session(
                DiscoveryKey::new(workspace_id, session_id, runner_instance, channel_epoch)
                    .unwrap(),
            )
            .unwrap();
        let common = ManifestCommon {
            schema_version: 1,
            host_build_version: "build-retired".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: Vec::new(),
            lifetime: HostLifetimeIdentity {
                workspace_id: workspace_id.into(),
                session_id: session_id.into(),
                runner_principal: runner_principal.into(),
                runner_instance: runner_instance.into(),
                channel_epoch,
            },
            host_instance_id: host_instance_id.into(),
            provider_id: "fixture".into(),
            runtime_context: RuntimeContext::default(),
            claim_linkage: ClaimLinkage {
                claim_id: None,
                kickoff_action_id: Some(idempotency_key.into()),
            },
            host_process: host_process.clone(),
            created_unix_ms: 1,
            session_class: DiscoverySessionClass::Managed,
            session_name: None,
            retirement_policy: None,
            launch_program: None,
        };
        let exited = ExitedManifest {
            common: common.clone(),
            tombstone: Box::new(ExitTombstone {
                provider_conversation_identity: None,
                fence: SessionFence {
                    workspace_id: workspace_id.into(),
                    session_id: session_id.into(),
                    runner_principal: runner_principal.into(),
                    runner_instance: runner_instance.into(),
                    channel_epoch,
                    host_instance_id: host_instance_id.into(),
                    terminal_epoch: terminal_epoch.into(),
                },
                provider_process,
                exit: Exit {
                    final_output_seq: 1,
                    exit_code: Some(0),
                    platform_status: None,
                    reason: "fixture".into(),
                },
                exit_kind: ProviderExitKind::Normal,
                created_unix_ms: exited_unix_ms,
                failure: None,
            }),
            endpoint: LocalEndpoint {
                kind: LocalEndpointKind::UnixSocket,
                address: "fixture.sock".into(),
            },
            capability_token: "fixture-token".into(),
            exited_unix_ms,
        };
        let lock = discovery.acquire_lifetime_lock().unwrap();
        discovery
            .publish_starting(
                &lock,
                StartingManifest {
                    common,
                    starting_unix_ms: 2,
                },
            )
            .unwrap();
        discovery.publish_exited(&lock, exited).unwrap();
        drop(lock);

        let ManagedCreateLedgerState::Prepared(mut reservation) = managed_create_ledger::reserve(
            root.path(),
            workspace_id,
            session_id,
            idempotency_key,
            &request_fingerprint(&[idempotency_key]),
        )
        .unwrap() else {
            panic!("fixture create must be prepared")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation
            .mark_spawn_reserved(ProcessDescriptor {
                process_id: host_process.process_id,
                start_marker: host_process.start_marker,
            })
            .unwrap();
        reservation.release_with_barrier_proof().unwrap();
        let create = ManagedCreateReceipt::new(
            idempotency_key,
            session_id,
            workspace_id,
            "fixture",
            PermissionMode::Default,
            root.path(),
            ManagedCreateOutcome::Created,
        )
        .unwrap()
        .with_generation_fence(
            ManagedCreateGenerationFence::new(
                runner_principal,
                runner_instance,
                channel_epoch,
                host_instance_id,
                terminal_epoch,
            )
            .unwrap(),
        )
        .unwrap();
        reservation
            .complete(serde_json::to_string(&create).unwrap())
            .unwrap();
        if finalize_create_retirement {
            let stop = ManagedStopReceipt::from_request(
                &ManagedStopRequest::new("stop-retired", session_id, workspace_id)
                    .unwrap()
                    .with_expected_fence(
                        runner_principal,
                        runner_instance,
                        channel_epoch,
                        host_instance_id,
                        terminal_epoch,
                    )
                    .unwrap(),
                ManagedStopOutcome::Stopped,
                "managed_provider_stopped",
            )
            .unwrap();
            managed_create_ledger::checkpoint_retirement_exact(root.path(), &stop).unwrap();
            managed_create_ledger::finalize_retirement_exact(root.path(), &stop).unwrap();
        }
        discovery.path().to_path_buf()
    }

    #[cfg(unix)]
    fn create_recovery_journal_overflow(root: &DiscoveryRoot) -> PathBuf {
        use std::os::unix::fs::OpenOptionsExt;

        let RecoveryReservationState::Pending(reservation) = reserve(
            root.path(),
            RecoveryIdentity {
                recovery_id: "overflow-authority".into(),
                source_session_id: "source-overflow".into(),
                source_workspace_id: "workspace".into(),
                request_fingerprint: request_fingerprint(&["overflow-authority"]),
                action: "restore_plain_shell_with_current_build",
            },
        )
        .unwrap() else {
            panic!("overflow fixture reservation must remain pending")
        };
        drop(reservation);
        let directory = root.path().join(".recovery");
        let digest = &request_fingerprint(&["state-gc-overflow"])[..32];
        for index in 0..=MAX_JOURNAL_SCAN_ENTRIES {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(directory.join(format!(".gc-operation_{digest}-state-gc-{index}.tmp")))
                .unwrap();
        }
        directory
    }

    #[test]
    fn absent_root_preview_is_empty_and_does_not_create_state() {
        let temp = TempDir::new().unwrap();
        let missing = temp.path().join("missing");
        let mut policy = LocalStateGcPolicy::default();
        policy.discovery.selection = DiscoveryGcSelection::AllEligible;

        let report = collect_local_state(&missing, DiscoveryGcMode::Preview, &policy).unwrap();

        assert!(!report.discovery_root_present);
        assert_eq!(report.discovery_selection, "all_eligible");
        assert!(report.discovery.is_none());
        assert!(!missing.exists());
    }

    #[test]
    fn existing_empty_root_preview_does_not_create_locks_or_journal_state() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let before = std::fs::read_dir(root.path()).unwrap().count();

        let report = collect_local_state(
            root.path(),
            DiscoveryGcMode::Preview,
            &LocalStateGcPolicy::default(),
        )
        .unwrap();

        assert!(report.discovery_root_present);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), before);
        assert!(!root.path().join(".state-gc.lock").exists());
        assert!(!root.path().join(".recovery").exists());
    }

    #[test]
    #[cfg(unix)]
    fn public_apply_repairs_journal_overflow_before_authoritative_inspection() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let directory = create_recovery_journal_overflow(&root);

        let report =
            collect_local_state(root.path(), DiscoveryGcMode::Apply, &aggressive_policy()).unwrap();
        let journal = report
            .recovery_gc
            .expect("apply must report the overflow repair");

        assert!(journal.planned_temporary_files > 0);
        assert_eq!(
            journal.removed_temporary_files,
            journal.planned_temporary_files
        );
        assert!(std::fs::read_dir(&directory).unwrap().count() <= 2_048);
        let RecoveryReservationState::Pending(reservation) = reserve(
            root.path(),
            RecoveryIdentity {
                recovery_id: "after-overflow-repair".into(),
                source_session_id: "new-source".into(),
                source_workspace_id: "workspace".into(),
                request_fingerprint: request_fingerprint(&["after-overflow-repair"]),
                action: "restore_plain_shell_with_current_build",
            },
        )
        .unwrap() else {
            panic!("public apply must restore recovery admission")
        };
        drop(reservation);
    }

    #[test]
    #[cfg(unix)]
    fn registration_capacity_repairs_journal_overflow_before_retirement() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        root.session(DiscoveryKey::new("workspace", "debris", "runner", 1).unwrap())
            .unwrap();
        let directory = create_recovery_journal_overflow(&root);
        let capacity =
            maintain_registration_capacity_with_policy(root.path(), &aggressive_policy()).unwrap();
        assert_eq!(capacity.used, 0);
        assert!(std::fs::read_dir(&directory).unwrap().count() < MAX_JOURNAL_SCAN_ENTRIES);
        assert_eq!(
            recovery_journal::inspect(root.path())
                .unwrap()
                .pending_records,
            1
        );
    }

    #[test]
    #[cfg(unix)]
    fn public_preview_reports_journal_overflow_without_mutating_it() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let directory = create_recovery_journal_overflow(&root);
        let before = std::fs::read_dir(&directory).unwrap().count();

        let error =
            collect_local_state(root.path(), DiscoveryGcMode::Preview, &aggressive_policy())
                .unwrap_err();

        assert!(
            error
                .to_string()
                .contains(&format!("entry scan exceeds {MAX_JOURNAL_SCAN_ENTRIES}"))
        );
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), before);
    }

    #[test]
    fn pending_recovery_is_the_authority_that_protects_retired_source_state() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let source = root
            .session(DiscoveryKey::new("workspace", "source", "runner", 1).unwrap())
            .unwrap();
        let source_path = source.path().to_path_buf();
        drop(source);
        let RecoveryReservationState::Pending(reservation) = reserve(
            root.path(),
            RecoveryIdentity {
                recovery_id: "recovery-1".into(),
                source_session_id: "source".into(),
                source_workspace_id: "workspace".into(),
                request_fingerprint: request_fingerprint(&["request"]),
                action: "restore_plain_shell_with_current_build",
            },
        )
        .unwrap() else {
            panic!("new recovery must remain pending")
        };
        drop(reservation);

        reclaim_registration_capacity(&root, &aggressive_policy().discovery).unwrap();
        assert!(
            source_path.exists(),
            "capacity GC must retain pending recovery"
        );
        let report =
            collect_local_state(root.path(), DiscoveryGcMode::Apply, &aggressive_policy()).unwrap();

        assert_eq!(report.recovery_before.unwrap().pending_records, 1);
        assert_eq!(report.discovery.unwrap().removed_sessions, 0);
        assert!(source_path.exists());
    }

    #[test]
    fn unresolved_managed_create_protects_its_launch_witness_from_gc() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let ManagedCreateLedgerState::Prepared(mut reservation) = managed_create_ledger::reserve(
            root.path(),
            "workspace",
            "pending-create",
            "create-1",
            &request_fingerprint(&["pending-create"]),
        )
        .unwrap() else {
            panic!("new managed create must be prepared")
        };
        reservation.checkpoint_pre_spawn_absence().unwrap();
        reservation
            .mark_spawn_reserved(ProcessDescriptor {
                process_id: 42,
                start_marker: "exact-host-42".into(),
            })
            .unwrap();
        reservation.release_with_barrier_proof().unwrap();
        let witness = root
            .session(DiscoveryKey::new("workspace", "pending-create", "runner", 1).unwrap())
            .unwrap();
        let witness_path = witness.path().to_path_buf();
        drop(witness);

        reclaim_registration_capacity(&root, &aggressive_policy().discovery).unwrap();
        assert!(
            witness_path.exists(),
            "capacity GC must retain pending create"
        );
        let report =
            collect_local_state(root.path(), DiscoveryGcMode::Apply, &aggressive_policy()).unwrap();

        assert_eq!(report.discovery.unwrap().removed_sessions, 0);
        assert!(witness_path.exists());
    }

    #[test]
    fn full_gc_refreshes_recovery_published_during_unlocked_session_scan() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let source = publish_managed_exited_generation(&root, true);
        assert_eq!(
            archive_exited_generations_for_capacity(root.path(), 1, 0).unwrap(),
            1
        );
        let mut published = false;
        let (report, protection) = apply_discovery_garbage(
            &root,
            &aggressive_policy().discovery,
            &BTreeSet::new(),
            |_| {
                if !published {
                    // Process proof is part of the real session tree scan.
                    // Neither a shared nor exclusive root lease may span it.
                    drop(root.acquire_maintenance_exclusive().unwrap());
                    let RecoveryReservationState::Pending(reservation) = reserve(
                        root.path(),
                        RecoveryIdentity {
                            recovery_id: "during-full-gc".into(),
                            source_session_id: "session-retired".into(),
                            source_workspace_id: "workspace-retired".into(),
                            request_fingerprint: request_fingerprint(&["during-full-gc"]),
                            action: "managed_rehost",
                        },
                    )
                    .unwrap() else {
                        panic!("new recovery must remain pending")
                    };
                    drop(reservation);
                    published = true;
                }
                DiscoveryGcProcessStatus::Absent
            },
        )
        .unwrap();
        assert!(published);
        assert!(source.exists());
        assert_eq!(report.unwrap().removed_sessions, 0);
        assert_eq!(protection.recovery.pending_records, 1);
    }

    #[test]
    fn full_gc_preserves_reclamation_report_when_a_new_creator_defers_hygiene() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let garbage = root
            .session(DiscoveryKey::new("workspace", "garbage", "runner", 1).unwrap())
            .unwrap();
        let path = garbage.path().to_path_buf();
        drop(garbage);
        let plan = root
            .plan_registration_garbage(&aggressive_policy().discovery, probe_process)
            .unwrap();
        let maintenance = root.acquire_maintenance_exclusive().unwrap();
        let protection = GcProtection::try_read(&root).unwrap().unwrap();
        let sweep = root
            .quarantine_registration_garbage_locked(
                &maintenance,
                plan,
                &protection.paths,
                probe_process,
            )
            .unwrap();
        drop(maintenance);
        let hygiene = sweep.sweep_for_full_gc().unwrap();
        let creating = root
            .session(DiscoveryKey::new("workspace", "new", "runner", 1).unwrap())
            .unwrap();
        let (report, _) = finish_discovery_garbage(&root, hygiene, protection).unwrap();
        let report = report.unwrap();
        assert_eq!(report.removed_sessions, 1);
        assert!(report.remaining_state_incomplete);
        assert!(!path.exists());
        assert!(creating.path().exists());
    }

    #[test]
    fn unverified_managed_create_preserves_missing_manifest_evidence_during_gc() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let ManagedCreateLedgerState::Prepared(reservation) = managed_create_ledger::reserve(
            root.path(),
            "workspace",
            "unverified-create",
            "create-1",
            &request_fingerprint(&["unverified-create"]),
        )
        .unwrap() else {
            panic!("new managed create must be unverified")
        };
        drop(reservation);
        let witness = root
            .session(DiscoveryKey::new("workspace", "unverified-create", "runner", 1).unwrap())
            .unwrap();
        let witness_path = witness.path().to_path_buf();
        drop(witness);

        let report =
            collect_local_state(root.path(), DiscoveryGcMode::Apply, &aggressive_policy()).unwrap();

        assert_eq!(report.discovery.unwrap().removed_sessions, 0);
        assert!(
            witness_path.exists(),
            "GC must preserve MissingManifest evidence until absence is checkpointed"
        );
        let reconcile = hmux_runtime_contract::ManagedCreateReconcileRequest::new(
            "create-1",
            "unverified-create",
            "workspace",
        )
        .unwrap();
        assert!(matches!(
            managed_create_ledger::reconcile_identity(root.path(), &reconcile).unwrap(),
            managed_create_ledger::ManagedCreateReconcileLedgerState::PreSpawnAbsenceUnverified(_)
        ));
    }

    #[test]
    fn exact_retired_managed_generation_is_collectable() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let retired_path = publish_managed_exited_generation(&root, true);

        assert_eq!(
            archive_exited_generations_for_capacity(root.path(), 1, 0).unwrap(),
            1
        );
        let report =
            collect_local_state(root.path(), DiscoveryGcMode::Apply, &aggressive_policy()).unwrap();

        assert_eq!(report.discovery.unwrap().removed_sessions, 1);
        assert!(!retired_path.exists());
    }

    #[test]
    fn naturally_exited_managed_generation_becomes_reclaimable() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let exited_path = publish_managed_exited_generation(&root, false);
        assert!(
            managed_create_ledger::pending_session_paths(root.path())
                .unwrap()
                .contains(exited_path.strip_prefix(root.path()).unwrap()),
            "the unretired create ledger reproduces the live capacity leak"
        );

        assert_eq!(
            archive_exited_generations_for_capacity(root.path(), 1, 0).unwrap(),
            1
        );
        let report =
            collect_local_state(root.path(), DiscoveryGcMode::Apply, &aggressive_policy()).unwrap();

        assert_eq!(report.discovery.unwrap().removed_sessions, 1);
        assert!(!exited_path.exists());
        assert!(
            !managed_create_ledger::pending_session_paths(root.path())
                .unwrap()
                .contains(exited_path.strip_prefix(root.path()).unwrap()),
            "the exact Exited manifest must terminalize its managed-create ledger"
        );
    }

    #[test]
    fn registration_maintenance_runs_before_capacity_is_exhausted() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_managed_exited_generation(&root, false);
        let before = root.registration_capacity().unwrap();
        assert_eq!(before.used, 1);
        assert!(before.remaining > 0, "the repro is not capacity exhaustion");

        let after =
            maintain_registration_capacity_with_policy(root.path(), &aggressive_policy()).unwrap();

        assert_eq!(after.used, 0);
        assert_eq!(after.remaining, after.maximum);
    }

    #[test]
    fn registration_maintenance_treats_retention_limit_as_a_high_watermark() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        publish_managed_exited_generation(&root, false);
        let mut policy = aggressive_policy();
        policy.discovery.max_session_entries = 1;
        policy.discovery.max_total_bytes = u64::MAX;
        policy.discovery.maximum_age_ms = u64::MAX;
        assert_eq!(root.registration_capacity().unwrap().used, 1);

        let after = maintain_registration_capacity_with_policy(root.path(), &policy).unwrap();

        assert_eq!(after.used, 0, "the high-water mark must trigger cleanup");
    }

    #[test]
    fn registration_maintenance_leaves_headroom_for_more_than_one_creation() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        for index in 0..8 {
            root.session(
                DiscoveryKey::new("workspace", format!("debris-{index}"), "runner", 1).unwrap(),
            )
            .unwrap();
        }
        let mut policy = aggressive_policy();
        policy.discovery.max_session_entries = 8;
        policy.discovery.max_total_bytes = u64::MAX;
        policy.discovery.maximum_age_ms = u64::MAX;

        let after = maintain_registration_capacity_with_policy(root.path(), &policy).unwrap();
        assert_eq!(
            after.used, 6,
            "one pass must reserve a batch, not just one slot"
        );
        root.session(DiscoveryKey::new("workspace", "next-create", "runner", 1).unwrap())
            .unwrap();
        let after_next = maintain_registration_capacity_with_policy(root.path(), &policy).unwrap();
        assert_eq!(
            after_next.used, 7,
            "the next admission must not repeat collection"
        );
    }

    #[test]
    fn registration_high_watermark_overrides_the_history_age_floor() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let now_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .try_into()
            .unwrap();
        publish_managed_exited_generation_at(&root, false, now_unix_ms);
        let mut policy = LocalStateGcPolicy::default();
        policy.discovery.max_session_entries = 1;
        policy.discovery.max_total_bytes = u64::MAX;
        policy.discovery.maximum_age_ms = u64::MAX;

        let after = maintain_registration_capacity_with_policy(root.path(), &policy).unwrap();

        assert_eq!(
            after.used, 0,
            "capacity headroom must not wait for the normal history-retention age"
        );
    }

    #[test]
    fn pending_recovery_protects_its_exact_retired_managed_generation() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let retired_path = publish_managed_exited_generation(&root, true);
        let RecoveryReservationState::Pending(reservation) = reserve(
            root.path(),
            RecoveryIdentity {
                recovery_id: "retired-source-recovery".into(),
                source_session_id: "session-retired".into(),
                source_workspace_id: "workspace-retired".into(),
                request_fingerprint: request_fingerprint(&["retired-source-recovery"]),
                action: "managed_rehost",
            },
        )
        .unwrap() else {
            panic!("new source recovery must remain pending")
        };
        drop(reservation);

        assert_eq!(
            archive_exited_generations_for_capacity(root.path(), 1, 0).unwrap(),
            0
        );
        let report =
            collect_local_state(root.path(), DiscoveryGcMode::Apply, &aggressive_policy()).unwrap();

        assert_eq!(report.discovery.unwrap().removed_sessions, 0);
        assert!(retired_path.exists());
        assert!(matches!(
            root.open_session(
                DiscoveryKey::new("workspace-retired", "session-retired", "runner-retired", 7)
                    .unwrap()
            )
            .unwrap()
            .read_manifest()
            .unwrap(),
            DiscoveryManifest::Exited(_)
        ));
    }

    #[test]
    fn busy_source_lock_skips_all_destructive_gc_until_recovery_releases_it() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let source = root
            .session(DiscoveryKey::new("workspace", "source", "runner", 1).unwrap())
            .unwrap();
        let source_path = source.path().to_path_buf();
        drop(source);
        let source_lock = lock_source(root.path(), "workspace", "source").unwrap();

        reclaim_registration_capacity(&root, &aggressive_policy().discovery).unwrap();
        assert!(
            source_path.exists(),
            "capacity GC must defer while a source is busy"
        );
        drop(root.acquire_maintenance_exclusive().unwrap());
        let preview =
            collect_local_state(root.path(), DiscoveryGcMode::Preview, &aggressive_policy())
                .unwrap();
        assert!(preview.recovery_source_busy);
        assert_eq!(preview.recovery_source_locks.present_source_locks, 1);
        assert_eq!(preview.recovery_source_locks.busy_source_locks, 1);
        assert_eq!(preview.recovery_source_locks.idle_source_locks, 0);
        assert!(preview.discovery.is_none());
        assert_eq!(
            preview
                .recovery_gc
                .expect("preview reports the non-locking journal plan")
                .planned_source_locks,
            1
        );
        assert!(matches!(
            try_lock_source(root.path(), "workspace", "source").unwrap(),
            RecoverySourceLockState::Busy
        ));
        assert!(source_path.exists());

        let busy =
            collect_local_state(root.path(), DiscoveryGcMode::Apply, &aggressive_policy()).unwrap();
        assert!(busy.recovery_source_busy);
        assert!(busy.discovery.is_none());
        assert!(busy.recovery_gc.is_none());
        assert!(source_path.exists());

        drop(source_lock);
        let released =
            collect_local_state(root.path(), DiscoveryGcMode::Apply, &aggressive_policy()).unwrap();
        assert!(!released.recovery_source_busy);
        assert_eq!(released.discovery.unwrap().removed_sessions, 1);
        assert!(!source_path.exists());
    }

    #[test]
    fn idle_source_lock_file_does_not_hide_the_read_only_discovery_plan() {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let source = root
            .session(DiscoveryKey::new("workspace", "source", "runner", 1).unwrap())
            .unwrap();
        drop(source);
        drop(lock_source(root.path(), "workspace", "source").unwrap());

        let preview =
            collect_local_state(root.path(), DiscoveryGcMode::Preview, &aggressive_policy())
                .unwrap();

        assert!(!preview.recovery_source_busy);
        assert_eq!(preview.recovery_source_locks.present_source_locks, 1);
        assert_eq!(preview.recovery_source_locks.busy_source_locks, 0);
        assert_eq!(preview.recovery_source_locks.idle_source_locks, 1);
        assert_eq!(
            preview
                .discovery
                .expect("an idle source-lock file must not hide the read-only plan")
                .planned_sessions,
            1
        );
    }
}
