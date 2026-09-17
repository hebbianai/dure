use fs2::FileExt;
use hmux_host::local_discovery::{DiscoveryMaintenanceLock, DiscoveryRoot};
use hmux_local_platform::private_storage::{self, PrivateFileIdentity, StorageError};
use hmux_runtime_contract::{
    MANAGED_REHOST_RECOVERY_ACTION, MANAGED_REHOST_RECOVERY_ID_PREFIX,
    MAX_RECOVERY_OPERATION_PAYLOAD_BYTES, ManagedCreateReceipt, ManagedRehostLaunchIdentity,
    ManagedRehostResolution, ManagedStopReceipt,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

mod completion_acknowledgement;
pub mod existing_operation;
pub mod managed_create_ledger;
mod managed_rehost_observation;
mod managed_rehost_resolution;
mod managed_rehost_successor_index;
pub mod managed_replacement;
pub mod managed_stop;
mod operation_reservation;
mod validated_json;
pub use operation_reservation::RecoveryReservationPhase;
use operation_reservation::{RecoveryReservationInput, reserve_internal};
pub mod prepared_standalone_create;
mod private_json_shard;
#[cfg(feature = "local-runtime")]
pub mod standalone_broker_admission;
#[cfg(feature = "local-runtime")]
pub mod standalone_launch;
#[cfg(feature = "local-runtime")]
pub mod standalone_upgrade;
pub use managed_rehost_observation::{
    observe_managed_rehost_operation, read_completed_managed_rehost_receipt,
    read_managed_rehost_predecessor, resolve_managed_rehost_operation_identity,
};
pub use managed_rehost_resolution::resolve_managed_rehost_current;

const RECOVERY_SCHEMA_VERSION: u16 = 1;
const MAX_RECORD_BYTES: u64 = 64 * 1024;
const MAX_GENERAL_OPERATION_RECORDS: usize = 256;
const MAX_MANAGED_STOP_OPERATION_RECORDS: usize = 512;
const MAX_OPERATION_RECORDS: usize =
    MAX_GENERAL_OPERATION_RECORDS + MAX_MANAGED_STOP_OPERATION_RECORDS;
const MAX_SOURCE_LOCK_FILES: usize = 512;
pub(crate) const MAX_JOURNAL_SCAN_ENTRIES: usize = 4_096;
const MAX_JOURNAL_OVERFLOW_SCAN_ENTRIES: usize = 16_384;
// Leave room for every admitted operation to publish one temporary update
// while maintenance is observing the stable journal, plus the production
// stale-attach sequence's two source locks and one new operation's lock/record.
// The record is published through a temporary file, but it replaces that
// temporary atomically, so the operation contributes at most two entries.
// Active operations are protected by their operation locks.
const JOURNAL_OVERFLOW_HEADROOM: usize = MAX_OPERATION_RECORDS + 4;
const JOURNAL_SCAN_LOW_WATER: usize = MAX_JOURNAL_SCAN_ENTRIES - JOURNAL_OVERFLOW_HEADROOM;

/// Internal capacity seam for exercising the exact overflow algorithm without
/// manufacturing thousands of filesystem entries in every fault test.
/// Product entry points always select [`PRODUCTION_JOURNAL_SCAN_CAPACITY`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct JournalScanCapacity {
    authoritative_entries: usize,
    overflow_entries: usize,
    low_water_entries: usize,
}

const PRODUCTION_JOURNAL_SCAN_CAPACITY: JournalScanCapacity = JournalScanCapacity {
    authoritative_entries: MAX_JOURNAL_SCAN_ENTRIES,
    overflow_entries: MAX_JOURNAL_OVERFLOW_SCAN_ENTRIES,
    low_water_entries: JOURNAL_SCAN_LOW_WATER,
};
const ADMISSION_LOCK_NAME: &str = "journal_admission.lock";
pub const SAVED_RECIPE_RECOVERY_NAMESPACE: &str = "saved_recipe_v1";
pub const MANAGED_STOP_RECOVERY_ACTION: &str = "managed_stop_complete_fence_v1";
pub const STANDALONE_CREATE_OPERATION_RECOVERY_ACTION: &str = "create_standalone_session_v1";
pub const STANDALONE_CREATE_OPERATION_COMPLETION_OUTCOME: &str = "created";
pub const RECOVERY_COMPLETION_ACKNOWLEDGED_CODE: &str = "hmux_recovery_completion_acknowledged";
pub const RECOVERY_RECORD_CAPACITY_EXCEEDED_CODE: &str = "hmux_recovery_record_capacity_exceeded";

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRecoverySource {
    pub workspace_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryJournalInspection {
    pub pending_sources: BTreeSet<PendingRecoverySource>,
    pub operation_records: usize,
    pub pending_records: usize,
    pub completed_records: usize,
    pub operation_record_bytes: u64,
    pub operation_lock_files: usize,
    pub source_lock_files: usize,
    pub temporary_files: usize,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ManagedRehostResolutionLookup {
    NotFound,
    RetryRequired { operation_id: String },
    Resolved(Box<ManagedRehostResolution>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryJournalGcPolicy {
    /// Completed receipts younger than this are never removed.
    pub minimum_completed_age: Duration,
    pub maximum_completed_records: usize,
    pub maximum_completed_bytes: u64,
    /// Unlocked source locks, record-less operation locks, and interrupted
    /// temporary files younger than this are never removed.
    pub minimum_orphan_age: Duration,
    pub maximum_source_lock_files: usize,
    pub maximum_orphan_operation_locks: usize,
    pub maximum_temporary_files: usize,
}

impl RecoveryJournalGcPolicy {
    /// Pressure retention for completed stops, shared by admission and raw
    /// journal overflow repair. The permanent create ledger owns retired-session
    /// replay; pending operations and other actions are never eligible here.
    pub fn managed_stop_capacity() -> Self {
        Self {
            minimum_completed_age: Duration::ZERO,
            maximum_completed_records: MAX_MANAGED_STOP_OPERATION_RECORDS - 1,
            maximum_completed_bytes: 12 * 1024 * 1024,
            ..Self::default()
        }
    }
}

impl Default for RecoveryJournalGcPolicy {
    fn default() -> Self {
        Self {
            minimum_completed_age: Duration::from_secs(7 * 24 * 60 * 60),
            maximum_completed_records: 128,
            maximum_completed_bytes: 4 * 1024 * 1024,
            minimum_orphan_age: Duration::from_secs(24 * 60 * 60),
            maximum_source_lock_files: 384,
            maximum_orphan_operation_locks: 64,
            maximum_temporary_files: 64,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryJournalGcReport {
    pub planned_completed_records: usize,
    pub planned_completed_bytes: u64,
    pub planned_source_locks: usize,
    pub planned_orphan_operation_locks: usize,
    pub planned_temporary_files: usize,
    pub removed_completed_records: usize,
    pub removed_completed_bytes: u64,
    pub removed_source_locks: usize,
    pub removed_orphan_operation_locks: usize,
    pub removed_temporary_files: usize,
    pub busy_entries: usize,
    pub remaining: RecoveryJournalInspection,
}

impl RecoveryJournalGcReport {
    pub(crate) fn merge(&mut self, next: Self) {
        self.planned_completed_records = self
            .planned_completed_records
            .saturating_add(next.planned_completed_records);
        self.planned_completed_bytes = self
            .planned_completed_bytes
            .saturating_add(next.planned_completed_bytes);
        self.planned_source_locks = self
            .planned_source_locks
            .saturating_add(next.planned_source_locks);
        self.planned_orphan_operation_locks = self
            .planned_orphan_operation_locks
            .saturating_add(next.planned_orphan_operation_locks);
        self.planned_temporary_files = self
            .planned_temporary_files
            .saturating_add(next.planned_temporary_files);
        self.removed_completed_records = self
            .removed_completed_records
            .saturating_add(next.removed_completed_records);
        self.removed_completed_bytes = self
            .removed_completed_bytes
            .saturating_add(next.removed_completed_bytes);
        self.removed_source_locks = self
            .removed_source_locks
            .saturating_add(next.removed_source_locks);
        self.removed_orphan_operation_locks = self
            .removed_orphan_operation_locks
            .saturating_add(next.removed_orphan_operation_locks);
        self.removed_temporary_files = self
            .removed_temporary_files
            .saturating_add(next.removed_temporary_files);
        self.busy_entries = self.busy_entries.saturating_add(next.busy_entries);
        self.remaining = next.remaining;
    }

    #[cfg(feature = "local-runtime")]
    pub(crate) fn removed_anything(&self) -> bool {
        self.removed_completed_records > 0
            || self.removed_source_locks > 0
            || self.removed_orphan_operation_locks > 0
            || self.removed_temporary_files > 0
    }
}

#[derive(Clone, Debug)]
pub struct RecoveryIdentity {
    pub recovery_id: String,
    pub source_session_id: String,
    pub source_workspace_id: String,
    pub request_fingerprint: String,
    pub action: &'static str,
}

/// A bounded JSON operation payload admitted once before journal mutation.
#[derive(Debug)]
pub struct RecoveryOperationPayload(String);

impl RecoveryOperationPayload {
    pub fn new(value: String) -> Result<Self, String> {
        validate_operation_payload(&value)?;
        Ok(Self(value))
    }

    fn into_inner(self) -> String {
        self.0
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug)]
pub struct PreparedRecoveryIdentity {
    pub recovery_id: String,
    pub source_session_id: String,
    pub source_workspace_id: String,
    pub action: &'static str,
    /// Compatibility proof for a record written before prepared operation
    /// checkpoints existed. Already-prepared retries leave this absent.
    pub legacy_request_fingerprint: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryCompletion {
    pub target_session_id: String,
    pub target_workspace_id: String,
    pub target_build_id: String,
    pub action: String,
    pub outcome: String,
    pub resume_checkpoint: Option<RecoveryResumeCheckpoint>,
    pub operation_checkpoint: Option<RecoveryOperationCheckpoint>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryCompletionAcknowledgement {
    Acknowledged,
    AlreadyAcknowledged,
    Absent,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecoveryCompletionLookup {
    Completed(Box<RecoveryCompletion>),
    Acknowledged,
    Absent,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryResumeCheckpoint {
    pub provider_id: String,
    pub resume_identity: String,
    pub provider_cwd: String,
    pub source_host_process_id: u32,
    pub source_host_start_marker: String,
    pub source_provider_process_id: u32,
    pub source_provider_start_marker: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_host_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_terminal_epoch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_host_proof_marker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_provider_proof_marker: Option<String>,
    pub source_terminated: bool,
    pub attempt: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryOperationCheckpoint {
    pub canonical_payload: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_stop_receipt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement_receipt: Option<String>,
}

#[derive(Debug)]
pub enum RecoveryReservationState {
    Pending(RecoveryReservation),
    Completed(RecoveryCompletion),
}

#[derive(Debug)]
pub struct RecoveryReservation {
    record_path: Box<PathBuf>,
    directory: PathBuf,
    record: RecoveryRecord,
    was_existing: bool,
    fingerprint_binding: FingerprintBinding,
    _lock: RecoveryLock,
}

#[derive(Clone, Copy, Debug)]
enum FingerprintBinding {
    AdmittedRequest,
    CanonicalPayload,
}

#[derive(Debug)]
struct RecoveryLock {
    file: File,
}

#[derive(Debug)]
struct JournalAdmissionLock {
    _lock: RecoveryLock,
}

#[derive(Debug)]
pub struct RecoverySourceLock {
    _lock: RecoveryLock,
}

#[derive(Debug)]
pub enum RecoverySourceLockState {
    Acquired(RecoverySourceLock),
    Busy,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySourceLockInspection {
    pub schema_version: u16,
    pub present_source_locks: usize,
    pub busy_source_locks: usize,
    pub idle_source_locks: usize,
}

impl Default for RecoverySourceLockInspection {
    fn default() -> Self {
        Self {
            schema_version: 1,
            present_source_locks: 0,
            busy_source_locks: 0,
            idle_source_locks: 0,
        }
    }
}

/// Cross-process destructive fence for one recovery source.
///
/// The admission lock stays held across the caller's pending check and
/// destructive boundary, so a journal-first recovery cannot publish a new
/// Reserved record in the check/use window. A pre-existing source lock is then
/// acquired non-creatively to exclude a source-lock-first recovery.
#[derive(Debug)]
pub struct RecoverySourceRetirementFence {
    _source_lock: Option<RecoverySourceLock>,
    _admission: JournalAdmissionLock,
    _maintenance: DiscoveryMaintenanceLock,
    pending_sources: BTreeSet<PendingRecoverySource>,
}

impl RecoverySourceRetirementFence {
    #[must_use]
    pub fn source_is_pending(&self, workspace_id: &str, session_id: &str) -> bool {
        self.pending_sources.contains(&PendingRecoverySource {
            workspace_id: workspace_id.to_string(),
            session_id: session_id.to_string(),
        })
    }
}

#[derive(Debug)]
pub enum RecoverySourceRetirementFenceState {
    Acquired(RecoverySourceRetirementFence),
    Busy,
}

impl RecoveryLock {
    fn acquire(file: File) -> Result<Self, String> {
        file.try_lock_exclusive()
            .map_err(|_| "hmux_recovery_busy: recovery operation is already running".to_string())?;
        Ok(Self { file })
    }

    fn acquire_admission(file: File) -> Result<Self, String> {
        file.lock_exclusive()
            .map_err(|_| "hmux_recovery_journal_failed: admission lock failed".to_string())?;
        Ok(Self { file })
    }

    fn try_acquire_for_maintenance(file: File) -> Result<Option<Self>, String> {
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Some(Self { file })),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(_) => Err("hmux_recovery_journal_failed: entry lock failed".to_string()),
        }
    }
}

impl Drop for RecoveryLock {
    fn drop(&mut self) {
        // A concurrent fork can retain this file description until exec.
        let _ = FileExt::unlock(&self.file);
    }
}

impl RecoveryReservation {
    pub fn recovery_id(&self) -> &str {
        &self.record.recovery_id
    }

    pub fn was_existing(&self) -> bool {
        self.was_existing
    }

    pub fn resume_checkpoint(&self) -> Option<&RecoveryResumeCheckpoint> {
        match &self.record.state {
            RecoveryRecordState::Reserved {
                resume_checkpoint, ..
            } => resume_checkpoint.as_ref(),
            RecoveryRecordState::Completed { .. } => None,
        }
    }

    pub fn operation_checkpoint(&self) -> Option<&RecoveryOperationCheckpoint> {
        match &self.record.state {
            RecoveryRecordState::Reserved {
                operation_checkpoint,
                ..
            } => operation_checkpoint.as_ref(),
            RecoveryRecordState::Completed { .. } => None,
        }
    }

    pub fn prepare_operation_payload(
        &mut self,
        canonical_payload: RecoveryOperationPayload,
    ) -> Result<(), String> {
        self.prepare_operation_payload_internal(canonical_payload, None)
    }

    /// Persist a prepared payload only when its largest typed completion can
    /// use the same bounded record. The caller supplies semantic field bounds;
    /// this journal remains the sole authority for outer JSON escaping and the
    /// durable byte limit.
    pub fn prepare_operation_payload_for_completion(
        &mut self,
        canonical_payload: RecoveryOperationPayload,
        completion_capacity: RecoveryCompletion,
    ) -> Result<(), String> {
        self.prepare_operation_payload_internal(canonical_payload, Some(completion_capacity))
    }

    fn prepare_operation_payload_internal(
        &mut self,
        canonical_payload: RecoveryOperationPayload,
        completion_capacity: Option<RecoveryCompletion>,
    ) -> Result<(), String> {
        let canonical_payload = canonical_payload.into_inner();
        if let Some(existing) = self.operation_checkpoint() {
            return if existing.canonical_payload == canonical_payload {
                Ok(())
            } else {
                Err(
                    "hmux_recovery_idempotency_conflict: canonical operation payload changed"
                        .to_string(),
                )
            };
        }
        let mut candidate = self.record.clone();
        if matches!(
            self.fingerprint_binding,
            FingerprintBinding::CanonicalPayload
        ) {
            candidate.request_fingerprint = request_fingerprint(&[&canonical_payload]);
        }
        let resume_checkpoint = self.resume_checkpoint().cloned();
        candidate.state = RecoveryRecordState::Reserved {
            resume_checkpoint,
            operation_checkpoint: Some(RecoveryOperationCheckpoint {
                canonical_payload,
                source_stop_receipt: None,
                replacement_receipt: None,
            }),
        };
        if let Some(completion) = completion_capacity {
            let prepared_payload = match &candidate.state {
                RecoveryRecordState::Reserved {
                    operation_checkpoint: Some(checkpoint),
                    ..
                } => Some(checkpoint.canonical_payload.as_str()),
                _ => None,
            };
            if completion
                .operation_checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.canonical_payload.as_str())
                != prepared_payload
            {
                return Err(
                    "hmux_recovery_journal_invalid: completion capacity changed the operation payload"
                        .to_string(),
                );
            }
            let mut completed = completed_record(&candidate, completion)?;
            let RecoveryRecordState::Completed {
                completed_unix_ms, ..
            } = &mut completed.state
            else {
                unreachable!("completion capacity always produces a completed record")
            };
            *completed_unix_ms = Some(u64::MAX);
            serialize_record(&completed)?;
        }
        let admission = acquire_admission_lock(&self.directory)?;
        #[cfg(feature = "local-runtime")]
        standalone_upgrade::admit_prepared(&admission, &self.directory, &candidate)?;
        write_record_admitted(&admission, &self.directory, &self.record_path, &candidate)?;
        self.record = candidate;
        Ok(())
    }

    pub fn checkpoint_resume(
        &mut self,
        checkpoint: RecoveryResumeCheckpoint,
    ) -> Result<(), String> {
        validate_resume_checkpoint(&checkpoint)?;
        let operation_checkpoint = self.operation_checkpoint().cloned();
        let mut candidate = self.record.clone();
        candidate.state = RecoveryRecordState::Reserved {
            resume_checkpoint: Some(checkpoint),
            operation_checkpoint,
        };
        write_record(&self.directory, &self.record_path, &candidate)?;
        self.record = candidate;
        Ok(())
    }

    pub fn checkpoint_source_stop_receipt(&mut self, receipt: String) -> Result<(), String> {
        validate_private_json("source stop receipt", &receipt)?;
        let mut checkpoint = self.operation_checkpoint().cloned().ok_or_else(|| {
            "hmux_recovery_journal_invalid: operation payload is missing".to_string()
        })?;
        if let Some(existing) = checkpoint.source_stop_receipt.as_deref() {
            return if existing == receipt {
                Ok(())
            } else {
                Err("hmux_recovery_idempotency_conflict: source stop receipt changed".to_string())
            };
        }
        checkpoint.source_stop_receipt = Some(receipt);
        let resume_checkpoint = self.resume_checkpoint().cloned();
        let mut candidate = self.record.clone();
        candidate.state = RecoveryRecordState::Reserved {
            resume_checkpoint,
            operation_checkpoint: Some(checkpoint),
        };
        write_record(&self.directory, &self.record_path, &candidate)?;
        self.record = candidate;
        Ok(())
    }

    pub fn checkpoint_replacement_receipt(&mut self, receipt: String) -> Result<(), String> {
        validate_private_json("replacement receipt", &receipt)?;
        let mut checkpoint = self.operation_checkpoint().cloned().ok_or_else(|| {
            "hmux_recovery_journal_invalid: operation payload is missing".to_string()
        })?;
        if let Some(existing) = checkpoint.replacement_receipt.as_deref() {
            return if existing == receipt {
                Ok(())
            } else {
                Err("hmux_recovery_idempotency_conflict: replacement receipt changed".to_string())
            };
        }
        checkpoint.replacement_receipt = Some(receipt);
        let resume_checkpoint = self.resume_checkpoint().cloned();
        let mut candidate = self.record.clone();
        candidate.state = RecoveryRecordState::Reserved {
            resume_checkpoint,
            operation_checkpoint: Some(checkpoint),
        };
        write_record(&self.directory, &self.record_path, &candidate)?;
        self.record = candidate;
        Ok(())
    }

    pub fn complete(&mut self, completion: RecoveryCompletion) -> Result<(), String> {
        let completed = completed_record(&self.record, completion)?;
        let admission = acquire_admission_lock(&self.directory)?;
        publish_managed_rehost_launch_identity(&self.directory, &completed)?;
        #[cfg(feature = "local-runtime")]
        standalone_upgrade::publish_completion(&self.directory, &completed)?;
        write_record_admitted(&admission, &self.directory, &self.record_path, &completed)?;
        self.record = completed;
        publish_managed_rehost_successor(&self.directory, &self.record)
    }
}

fn completed_record(
    record: &RecoveryRecord,
    completion: RecoveryCompletion,
) -> Result<RecoveryRecord, String> {
    if completion.action != record.action {
        return Err("hmux_recovery_idempotency_conflict: completion action changed".to_string());
    }
    let current_resume = match &record.state {
        RecoveryRecordState::Reserved {
            resume_checkpoint, ..
        } => resume_checkpoint.clone(),
        RecoveryRecordState::Completed { .. } => None,
    };
    let current_operation = match &record.state {
        RecoveryRecordState::Reserved {
            operation_checkpoint,
            ..
        } => operation_checkpoint.clone(),
        RecoveryRecordState::Completed { .. } => None,
    };
    let mut completed = record.clone();
    completed.state = RecoveryRecordState::Completed {
        target_session_id: completion.target_session_id,
        target_workspace_id: completion.target_workspace_id,
        target_build_id: completion.target_build_id,
        outcome: completion.outcome,
        resume_checkpoint: completion.resume_checkpoint.or(current_resume),
        operation_checkpoint: completion.operation_checkpoint.or(current_operation),
        completed_unix_ms: Some(unix_time_ms()),
    };
    Ok(completed)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryRecord {
    schema_version: u16,
    recovery_id: String,
    source_session_id: String,
    source_workspace_id: String,
    request_fingerprint: String,
    action: String,
    created_unix_ms: u64,
    #[serde(flatten)]
    state: RecoveryRecordState,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum RecoveryRecordState {
    Reserved {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume_checkpoint: Option<RecoveryResumeCheckpoint>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        operation_checkpoint: Option<RecoveryOperationCheckpoint>,
    },
    Completed {
        target_session_id: String,
        target_workspace_id: String,
        target_build_id: String,
        outcome: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume_checkpoint: Option<RecoveryResumeCheckpoint>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        operation_checkpoint: Option<RecoveryOperationCheckpoint>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        completed_unix_ms: Option<u64>,
    },
}

pub fn reserve(
    discovery_root: &Path,
    identity: RecoveryIdentity,
) -> Result<RecoveryReservationState, String> {
    reserve_internal(
        discovery_root,
        RecoveryReservationInput {
            recovery_id: &identity.recovery_id,
            source_session_id: &identity.source_session_id,
            source_workspace_id: &identity.source_workspace_id,
            action: identity.action,
            expected_request_fingerprint: Some(&identity.request_fingerprint),
            canonical_payload: None,
            legacy_request_fingerprint: None,
            fingerprint_binding: FingerprintBinding::AdmittedRequest,
        },
        &|_| (),
    )
}

/// Reserve a journal-first operation whose complete private execution payload
/// must survive the destructive boundary.
///
/// A new operation requires `canonical_payload`; an existing operation may be
/// reopened with `None` and will return only the payload already stored under
/// the owner-only journal. Repeated client hints neither rebuild nor override
/// that payload; only the stable operation and source identity select it.
pub fn reserve_prepared(
    discovery_root: &Path,
    identity: PreparedRecoveryIdentity,
    canonical_payload: Option<String>,
) -> Result<RecoveryReservationState, String> {
    reserve_prepared_observed(discovery_root, identity, canonical_payload, |_| ())
}

/// Observe synchronous reservation stages without changing journal authority.
/// The returned scope is dropped at the end of each stage, including errors.
/// Observers must not mutate the journal or reenter reservation. The ordinary
/// entry point uses a zero-sized no-op; the journal never reads a clock itself.
pub fn reserve_prepared_observed<G>(
    discovery_root: &Path,
    identity: PreparedRecoveryIdentity,
    canonical_payload: Option<String>,
    observe: impl Fn(RecoveryReservationPhase) -> G,
) -> Result<RecoveryReservationState, String> {
    if let Some(payload) = canonical_payload.as_deref() {
        validate_operation_payload(payload)?;
    }
    #[cfg(feature = "local-runtime")]
    let (operation_root, canonical_payload) =
        standalone_upgrade::prepared_location(discovery_root, &identity, canonical_payload)?;
    #[cfg(feature = "local-runtime")]
    let discovery_root = operation_root.as_path();
    reserve_internal(
        discovery_root,
        RecoveryReservationInput {
            recovery_id: &identity.recovery_id,
            source_session_id: &identity.source_session_id,
            source_workspace_id: &identity.source_workspace_id,
            action: identity.action,
            expected_request_fingerprint: None,
            canonical_payload: canonical_payload.as_deref(),
            legacy_request_fingerprint: identity.legacy_request_fingerprint.as_deref(),
            fingerprint_binding: FingerprintBinding::CanonicalPayload,
        },
        &observe,
    )
}

/// Read-only exact-record prefilter for a prepared operation.
///
/// A `true` result is not mutation authority: the caller must still reopen and
/// validate the record under its operation lock. Concurrent publication or
/// removal may make either result stale, but this function never creates a
/// journal directory, lock, or record while locating an operation across
/// bounded compatibility roots.
#[doc(hidden)]
pub fn prepared_operation_exists(
    discovery_root: &Path,
    identity: &PreparedRecoveryIdentity,
) -> Result<bool, String> {
    let Some(record) =
        existing_operation::read_existing_record(discovery_root, &identity.recovery_id)?
    else {
        return Ok(false);
    };
    validate_prepared_record(&record, identity, None)?;
    Ok(true)
}

/// Reads one exact completed operation without creating journal state.
///
/// This is the observation half of a completion acknowledgement. The caller
/// may inspect external lifecycle state before passing the unchanged result to
/// [`acknowledge_completion`], whose compare-and-swap closes the race.
pub fn read_completed_existing(
    discovery_root: &Path,
    identity: &RecoveryIdentity,
) -> Result<RecoveryCompletionLookup, String> {
    with_existing_operation(discovery_root, identity, |operation| {
        completed_from_record(&operation.record)
    })
    .map(|operation| match operation {
        ExistingRecoveryOperation::Present(completion) => {
            RecoveryCompletionLookup::Completed(Box::new(completion))
        }
        ExistingRecoveryOperation::Acknowledged => RecoveryCompletionLookup::Acknowledged,
        ExistingRecoveryOperation::Absent => RecoveryCompletionLookup::Absent,
    })
}

/// Deletes one exact completed operation after its consumer has durably
/// accepted the terminal fact.
///
/// An exact acknowledgement fence is an idempotent success. Never-submitted
/// state remains distinct so an arbitrary operation id cannot be retired by
/// acknowledgement alone. Existing state is removed only while holding its
/// existing operation lock and only when both the recovery identity and
/// completion still match. This path never creates a directory, lock,
/// reservation, or replacement record.
pub fn acknowledge_completion(
    discovery_root: &Path,
    identity: &RecoveryIdentity,
    expected: &RecoveryCompletion,
) -> Result<RecoveryCompletionAcknowledgement, String> {
    acknowledge_completion_internal(discovery_root, identity, expected, None)
}

/// Acknowledge a completion and reclaim one exact idle source-lock inode in
/// the same admission transaction. This is for terminal owners whose durable
/// request proves which reusable source coordinate it acquired.
pub fn acknowledge_completion_releasing_source(
    discovery_root: &Path,
    identity: &RecoveryIdentity,
    expected: &RecoveryCompletion,
    source: &PendingRecoverySource,
) -> Result<RecoveryCompletionAcknowledgement, String> {
    acknowledge_completion_internal(discovery_root, identity, expected, Some(source))
}

fn acknowledge_completion_internal(
    discovery_root: &Path,
    identity: &RecoveryIdentity,
    expected: &RecoveryCompletion,
    released_source: Option<&PendingRecoverySource>,
) -> Result<RecoveryCompletionAcknowledgement, String> {
    with_existing_operation(discovery_root, identity, |operation| {
        let current = completed_from_record(&operation.record)?;
        if current != *expected {
            return Err(
                "hmux_recovery_idempotency_conflict: completed acknowledgement changed".to_string(),
            );
        }
        let directory = &operation.directory;
        if let Some(source) = released_source {
            remove_idle_source_lock(directory, &source.workspace_id, &source.session_id)?;
        }
        let operation_digest = digest(&identity.recovery_id);
        let lock_path = directory.join(format!("operation_{operation_digest}.lock"));
        completion_acknowledgement::publish(directory, identity)?;
        transactional_remove_record(directory, &operation.record_path, &operation_digest)?;
        remove_opened_file(directory, &lock_path, &operation._lock.file)?;
        Ok(RecoveryCompletionAcknowledgement::Acknowledged)
    })
    .map(|operation| match operation {
        ExistingRecoveryOperation::Present(result) => result,
        ExistingRecoveryOperation::Acknowledged => {
            RecoveryCompletionAcknowledgement::AlreadyAcknowledged
        }
        ExistingRecoveryOperation::Absent => RecoveryCompletionAcknowledgement::Absent,
    })
}

enum ExistingRecoveryOperation<T> {
    Present(T),
    Acknowledged,
    Absent,
}

fn with_existing_operation<T>(
    discovery_root: &Path,
    identity: &RecoveryIdentity,
    action: impl FnOnce(RecoveryReservation) -> Result<T, String>,
) -> Result<ExistingRecoveryOperation<T>, String> {
    let directory = discovery_root.join(".recovery");
    match fs::symlink_metadata(&directory) {
        Ok(_) => validate_existing_private_directory(&directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ExistingRecoveryOperation::Absent);
        }
        Err(_) => {
            return Err("hmux_recovery_journal_invalid: directory is unreadable".to_string());
        }
    }
    let admission = RecoveryLock::acquire_admission(open_private_existing_lock(
        &directory.join(ADMISSION_LOCK_NAME),
    )?)?;
    let operation_digest = digest(&identity.recovery_id);
    let record_path = directory.join(format!("operation_{operation_digest}.json"));
    if !private_path_exists(&record_path)? {
        let acknowledged = completion_acknowledgement::validate_exact(&directory, identity)?;
        return Ok(if acknowledged {
            ExistingRecoveryOperation::Acknowledged
        } else {
            ExistingRecoveryOperation::Absent
        });
    }
    let operation_lock = RecoveryLock::acquire(open_private_existing_lock(
        &directory.join(format!("operation_{operation_digest}.lock")),
    )?)?;
    let record = read_record(&record_path)?;
    validate_record(&record, identity)?;
    let result = action(RecoveryReservation {
        record_path: Box::new(record_path),
        directory,
        record,
        was_existing: true,
        fingerprint_binding: FingerprintBinding::AdmittedRequest,
        _lock: operation_lock,
    })?;
    drop(admission);
    Ok(ExistingRecoveryOperation::Present(result))
}

fn refuse_acknowledged_binding(
    directory: &Path,
    recovery_id: &str,
    source_session_id: &str,
    source_workspace_id: &str,
    request_fingerprint: Option<&str>,
    action: &str,
) -> Result<(), String> {
    completion_acknowledgement::refuse_binding(
        directory,
        recovery_id,
        source_session_id,
        source_workspace_id,
        request_fingerprint,
        action,
        RECOVERY_COMPLETION_ACKNOWLEDGED_CODE,
    )
}

fn completed_from_record(record: &RecoveryRecord) -> Result<RecoveryCompletion, String> {
    let RecoveryRecordState::Completed {
        target_session_id,
        target_workspace_id,
        target_build_id,
        outcome,
        resume_checkpoint,
        operation_checkpoint,
        ..
    } = &record.state
    else {
        return Err(
            "hmux_recovery_pending: completion acknowledgement is still pending".to_string(),
        );
    };
    Ok(RecoveryCompletion {
        target_session_id: target_session_id.clone(),
        target_workspace_id: target_workspace_id.clone(),
        target_build_id: target_build_id.clone(),
        action: record.action.clone(),
        outcome: outcome.clone(),
        resume_checkpoint: resume_checkpoint.clone(),
        operation_checkpoint: operation_checkpoint.clone(),
    })
}

/// Atomically replace one exact completed prepared-operation outcome with a
/// terminal failure outcome discovered while replaying it.
///
/// The original target identity and private operation checkpoint are retained.
/// The compare-and-swap against `expected` prevents a stale replay from
/// overwriting a concurrent completion or a different terminal diagnosis.
pub fn record_prepared_replay_terminal_outcome(
    discovery_root: &Path,
    identity: &PreparedRecoveryIdentity,
    expected: &RecoveryCompletion,
    terminal_outcome: &'static str,
) -> Result<RecoveryCompletion, String> {
    if !terminal_outcome.starts_with("failed_") {
        return Err(
            "hmux_recovery_journal_invalid: replay terminal outcome must be a failure".to_string(),
        );
    }
    let maintenance = acquire_discovery_maintenance_shared(discovery_root)?;
    let directory = discovery_root.join(".recovery");
    ensure_private_directory(&directory)?;
    let digest = digest(&identity.recovery_id);
    let lock_path = directory.join(format!("operation_{digest}.lock"));
    let record_path = directory.join(format!("operation_{digest}.json"));
    let _lock = RecoveryLock::acquire(open_private_lock(&lock_path)?)?;
    let mut record = read_record(&record_path)?;
    drop(maintenance);
    validate_prepared_record(&record, identity, None)?;
    let action = record.action.clone();
    let RecoveryRecordState::Completed {
        target_session_id,
        target_workspace_id,
        target_build_id,
        outcome,
        resume_checkpoint,
        operation_checkpoint,
        completed_unix_ms,
    } = &mut record.state
    else {
        return Err(
            "hmux_recovery_idempotency_conflict: replay outcome requires a completed operation"
                .to_string(),
        );
    };
    let current = RecoveryCompletion {
        target_session_id: target_session_id.clone(),
        target_workspace_id: target_workspace_id.clone(),
        target_build_id: target_build_id.clone(),
        action: action.clone(),
        outcome: outcome.clone(),
        resume_checkpoint: resume_checkpoint.clone(),
        operation_checkpoint: operation_checkpoint.clone(),
    };
    if current != *expected {
        return if current.outcome == terminal_outcome {
            Ok(current)
        } else {
            Err("hmux_recovery_idempotency_conflict: completed replay outcome changed".to_string())
        };
    }
    *outcome = terminal_outcome.to_string();
    *completed_unix_ms = Some(unix_time_ms());
    write_record(&directory, &record_path, &record)?;
    Ok(RecoveryCompletion {
        target_session_id: expected.target_session_id.clone(),
        target_workspace_id: expected.target_workspace_id.clone(),
        target_build_id: expected.target_build_id.clone(),
        action,
        outcome: terminal_outcome.to_string(),
        resume_checkpoint: expected.resume_checkpoint.clone(),
        operation_checkpoint: expected.operation_checkpoint.clone(),
    })
}

pub fn lock_source(
    discovery_root: &Path,
    source_workspace_id: &str,
    source_session_id: &str,
) -> Result<RecoverySourceLock, String> {
    match try_lock_source(discovery_root, source_workspace_id, source_session_id)? {
        RecoverySourceLockState::Acquired(lock) => Ok(lock),
        RecoverySourceLockState::Busy => {
            Err("hmux_recovery_source_busy: another operation owns this source session".to_string())
        }
    }
}

pub fn try_lock_source(
    discovery_root: &Path,
    source_workspace_id: &str,
    source_session_id: &str,
) -> Result<RecoverySourceLockState, String> {
    let maintenance = acquire_discovery_maintenance_shared(discovery_root)?;
    let directory = discovery_root.join(".recovery");
    ensure_private_directory(&directory)?;
    let path = source_lock_path(&directory, source_workspace_id, source_session_id);
    let admission = acquire_admission_lock(&directory)?;
    let was_existing = private_path_exists(&path)?;
    let entries = scan_journal(&directory, false)?;
    if !was_existing
        && entries
            .iter()
            .filter(|entry| matches!(entry.kind, JournalEntryKind::SourceLock))
            .count()
            >= MAX_SOURCE_LOCK_FILES
    {
        return Err(
            "hmux_recovery_source_capacity_exceeded: source lock limit reached".to_string(),
        );
    }
    ensure_raw_admission_capacity(entries.len(), usize::from(!was_existing))?;
    match RecoveryLock::acquire(open_private_lock(&path)?) {
        Ok(lock) => {
            drop(admission);
            drop(maintenance);
            Ok(RecoverySourceLockState::Acquired(RecoverySourceLock {
                _lock: lock,
            }))
        }
        Err(_) => {
            drop(admission);
            drop(maintenance);
            Ok(RecoverySourceLockState::Busy)
        }
    }
}

fn source_lock_path(directory: &Path, workspace_id: &str, session_id: &str) -> PathBuf {
    let source = digest(&format!("{workspace_id}\0{session_id}"));
    directory.join(format!("source_{source}.lock"))
}

fn remove_idle_source_lock(
    directory: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let path = source_lock_path(directory, workspace_id, session_id);
    if !private_path_exists(&path)? {
        return Ok(());
    }
    let Some(lock) = RecoveryLock::try_acquire_for_maintenance(open_private_existing_lock(&path)?)?
    else {
        return Err("hmux_recovery_source_busy: completion source is still active".to_string());
    };
    remove_opened_file(directory, &path, &lock.file)?;
    drop(lock);
    Ok(())
}

/// Acquire the recovery source and journal-admission fences required to retire
/// one exact source without racing a journal-first recovery.
pub fn try_fence_source_retirement(
    discovery_root: &Path,
    source_workspace_id: &str,
    source_session_id: &str,
) -> Result<RecoverySourceRetirementFenceState, String> {
    // Lock order is the same as discovery GC: maintenance before journal
    // admission. Retaining the shared guard through the caller's destructive
    // boundary prevents GC from owning maintenance-exclusive while waiting on
    // the admission lock held here.
    let maintenance = acquire_discovery_maintenance_shared(discovery_root)?;
    let directory = discovery_root.join(".recovery");
    ensure_private_directory(&directory)?;
    let admission = acquire_admission_lock(&directory)?;
    let pending_sources = inspect_locked(&directory)?.pending_sources;

    // Do not create source lock debris for retirement. Admission prevents a
    // journal-first recovery from creating this exact lock until the archive
    // completes. If a lock already exists, non-creatively acquire it so a
    // source-lock-first recovery remains protected as well.
    let source_path = source_lock_path(&directory, source_workspace_id, source_session_id);
    let source_lock = if private_path_exists(&source_path)? {
        match RecoveryLock::acquire(open_private_existing_lock(&source_path)?) {
            Ok(lock) => Some(RecoverySourceLock { _lock: lock }),
            Err(_) => return Ok(RecoverySourceRetirementFenceState::Busy),
        }
    } else {
        None
    };
    Ok(RecoverySourceRetirementFenceState::Acquired(
        RecoverySourceRetirementFence {
            _source_lock: source_lock,
            _admission: admission,
            _maintenance: maintenance,
            pending_sources,
        },
    ))
}

fn acquire_discovery_maintenance_shared(
    discovery_root: &Path,
) -> Result<DiscoveryMaintenanceLock, String> {
    #[cfg(all(test, unix))]
    {
        use std::os::unix::fs::PermissionsExt;

        // tempfile roots are 0755 on macOS. Production discovery creation is
        // always 0700; normalize only the test fixture root so the test still
        // exercises the production path-security checks below.
        fs::set_permissions(discovery_root, fs::Permissions::from_mode(0o700))
            .map_err(|_| "hmux_recovery_journal_failed: test root setup failed".to_string())?;
    }
    let root = DiscoveryRoot::open(discovery_root)
        .map_err(|error| format!("hmux_recovery_journal_invalid: {error}"))?;
    root.acquire_maintenance_shared()
        .map_err(|_| "hmux_recovery_maintenance_busy: discovery GC is running".to_string())
}

/// Inspects every recovery-journal record under one coherent admission fence.
///
/// A malformed record or unsafe path fails the whole inspection. Callers use
/// `pending_sources` as a deletion-protection set, so returning a partial set
/// would turn corruption into permission to delete a live source.
pub fn inspect(discovery_root: &Path) -> Result<RecoveryJournalInspection, String> {
    let directory = discovery_root.join(".recovery");
    ensure_private_directory(&directory)?;
    let _admission = acquire_admission_lock(&directory)?;
    inspect_locked(&directory)
}

/// A complete, coherently fenced snapshot or a deferral. Never wait for
/// journal admission while capacity maintenance excludes registration.
#[cfg(feature = "local-runtime")]
pub(crate) fn try_inspect_for_state_gc(
    discovery_root: &Path,
) -> Result<Option<RecoveryJournalInspection>, String> {
    let directory = discovery_root.join(".recovery");
    ensure_private_directory(&directory)?;
    let Some(_admission) = RecoveryLock::try_acquire_for_maintenance(open_private_lock(
        &directory.join(ADMISSION_LOCK_NAME),
    )?)?
    else {
        return Ok(None);
    };
    inspect_locked(&directory).map(Some)
}

/// Read-only best-effort inspection for cleanup preview.
///
/// Missing journal state is empty. Existing state is validated and scanned
/// without creating the directory or admission lock; concurrent publication
/// can make the preview stale, but preview never grants deletion authority.
pub fn inspect_existing(discovery_root: &Path) -> Result<RecoveryJournalInspection, String> {
    let directory = discovery_root.join(".recovery");
    match fs::symlink_metadata(&directory) {
        Ok(_) => validate_existing_private_directory(&directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecoveryJournalInspection::default());
        }
        Err(_) => {
            return Err("hmux_recovery_journal_invalid: directory is unreadable".to_string());
        }
    }
    inspect_entries(scan_journal(&directory, true)?)
}

struct CompletedRehostEdge {
    operation_id: String,
    source: ManagedStopReceipt,
    replacement: ManagedCreateReceipt,
    launch_identity: Option<ManagedRehostLaunchIdentity>,
}

fn resolution_edge(record: &RecoveryRecord) -> Result<ManagedRehostResolution, String> {
    let edge = completed_rehost_receipts(record)?;
    ManagedRehostResolution::from_receipts_with_launch_identity(
        edge.operation_id,
        &edge.source,
        &edge.replacement,
        edge.launch_identity,
    )
    .map_err(|error| format!("hmux_managed_rehost_resolution_invalid: {error}"))
}

fn publish_managed_rehost_successor(
    recovery_directory: &Path,
    record: &RecoveryRecord,
) -> Result<(), String> {
    let completed = matches!(&record.state, RecoveryRecordState::Completed { .. });
    if !completed
        || is_refused_managed_rehost_record(record)
        || (record.action != MANAGED_REHOST_RECOVERY_ACTION
            && !is_valid_completed_rehost_receipt_record(record))
    {
        return Ok(());
    }
    let resolution = resolution_edge(record)?;
    managed_rehost_successor_index::publish(recovery_directory, &resolution)
}

fn publish_managed_rehost_launch_identity(
    recovery_directory: &Path,
    record: &RecoveryRecord,
) -> Result<(), String> {
    if is_refused_managed_rehost_record(record)
        || record.action != MANAGED_REHOST_RECOVERY_ACTION
        || !matches!(&record.state, RecoveryRecordState::Completed { .. })
    {
        return Ok(());
    }
    let resolution = resolution_edge(record)?;
    managed_rehost_successor_index::publish_launch_identity(recovery_directory, &resolution)
}

fn is_refused_managed_rehost_record(record: &RecoveryRecord) -> bool {
    record.action == MANAGED_REHOST_RECOVERY_ACTION
        && matches!(&record.state, RecoveryRecordState::Completed {
            outcome,
            target_session_id,
            target_workspace_id,
            target_build_id,
            operation_checkpoint: Some(RecoveryOperationCheckpoint {
                source_stop_receipt: None,
                replacement_receipt: None,
                ..
            }),
            ..
        } if outcome == "refused_precondition"
            && target_session_id == &record.source_session_id
            && target_workspace_id == &record.source_workspace_id
            && target_build_id == "precondition")
}

fn is_completed_rehost_receipt_record(record: &RecoveryRecord) -> bool {
    matches!(
        &record.state,
        RecoveryRecordState::Completed {
            operation_checkpoint: Some(RecoveryOperationCheckpoint {
                source_stop_receipt: Some(_),
                replacement_receipt: Some(_),
                ..
            }),
            ..
        }
    )
}

fn is_valid_completed_rehost_receipt_record(record: &RecoveryRecord) -> bool {
    is_completed_rehost_receipt_record(record) && completed_rehost_receipts(record).is_ok()
}

fn completed_rehost_receipts(record: &RecoveryRecord) -> Result<CompletedRehostEdge, String> {
    let operation_id = rehost_operation_id(record);
    let RecoveryRecordState::Completed {
        target_session_id,
        target_workspace_id,
        operation_checkpoint,
        ..
    } = &record.state
    else {
        return Err(
            "hmux_managed_rehost_resolution_invalid: completion is not durable".to_string(),
        );
    };
    let checkpoint = operation_checkpoint.as_ref().ok_or_else(|| {
        "hmux_managed_rehost_resolution_invalid: completion lost its checkpoint".to_string()
    })?;
    let source = decode_completed_source_stop_receipt(
        checkpoint.source_stop_receipt.as_deref().ok_or_else(|| {
            "hmux_managed_rehost_resolution_invalid: completion lost its source receipt".to_string()
        })?,
    )?;
    let replacement: ManagedCreateReceipt =
        serde_json::from_str(checkpoint.replacement_receipt.as_deref().ok_or_else(|| {
            "hmux_managed_rehost_resolution_invalid: completion lost its replacement receipt"
                .to_string()
        })?)
        .map_err(|_| {
            "hmux_managed_rehost_resolution_invalid: replacement receipt is malformed".to_string()
        })?;
    source.validate().map_err(|error| {
        format!("hmux_managed_rehost_resolution_invalid: source receipt: {error}")
    })?;
    replacement.validate().map_err(|error| {
        format!("hmux_managed_rehost_resolution_invalid: replacement receipt: {error}")
    })?;
    if source.workspace_id() != record.source_workspace_id
        || source.session_id() != record.source_session_id
        || replacement.workspace_id() != target_workspace_id
        || replacement.session_id() != target_session_id
    {
        return Err(
            "hmux_managed_rehost_resolution_invalid: durable identities changed".to_string(),
        );
    }
    let launch_identity = if record.action == MANAGED_REHOST_RECOVERY_ACTION
        && record.request_fingerprint == request_fingerprint(&[&checkpoint.canonical_payload])
    {
        prepared_launch_identity(&checkpoint.canonical_payload)?
    } else {
        None
    };
    Ok(CompletedRehostEdge {
        operation_id,
        source,
        replacement,
        launch_identity,
    })
}

fn prepared_launch_identity(
    canonical_payload: &str,
) -> Result<Option<ManagedRehostLaunchIdentity>, String> {
    let payload: serde_json::Value = serde_json::from_str(canonical_payload).map_err(|_| {
        "hmux_managed_rehost_resolution_invalid: prepared payload is malformed".to_string()
    })?;
    let Some(reference) = payload.get("launchReference") else {
        return Ok(None);
    };
    let Some(conversation_id) = payload.get("conversationId") else {
        return Ok(None);
    };
    let reference = match reference {
        serde_json::Value::Null => None,
        serde_json::Value::String(reference) => Some(reference.clone()),
        _ => {
            return Err(
                "hmux_managed_rehost_resolution_invalid: prepared launch reference is malformed"
                    .to_string(),
            );
        }
    };
    let conversation_id = match conversation_id {
        serde_json::Value::Null => None,
        serde_json::Value::String(conversation_id) => Some(conversation_id.clone()),
        _ => {
            return Err(
                "hmux_managed_rehost_resolution_invalid: prepared conversation id is malformed"
                    .to_string(),
            );
        }
    };
    ManagedRehostLaunchIdentity::new(reference, conversation_id)
        .map(Some)
        .map_err(|error| format!("hmux_managed_rehost_resolution_invalid: {error}"))
}

fn rehost_operation_id(record: &RecoveryRecord) -> String {
    record
        .recovery_id
        .strip_prefix(MANAGED_REHOST_RECOVERY_ID_PREFIX)
        .filter(|value| !value.is_empty())
        .unwrap_or(&record.recovery_id)
        .to_string()
}

#[derive(Deserialize)]
struct ManagedStopReceiptEnvelope {
    kind: String,
    receipt: ManagedStopReceipt,
}

fn decode_completed_source_stop_receipt(serialized: &str) -> Result<ManagedStopReceipt, String> {
    if let Ok(receipt) = serde_json::from_str(serialized) {
        return Ok(receipt);
    }
    let envelope: ManagedStopReceiptEnvelope = serde_json::from_str(serialized).map_err(|_| {
        "hmux_managed_rehost_resolution_invalid: source receipt is malformed".to_string()
    })?;
    if envelope.kind != "managed_stop" {
        return Err(
            "hmux_managed_rehost_resolution_invalid: source receipt envelope is unsupported"
                .to_string(),
        );
    }
    Ok(envelope.receipt)
}

/// Plans completed-receipt and inactive-debris cleanup from an existing
/// journal snapshot without creating or acquiring any lock.
///
/// The result is advisory. Apply mode rescans under the admission lock and
/// records its own authoritative plan before removing anything.
pub fn preview_garbage_collect_completed(
    discovery_root: &Path,
    policy: RecoveryJournalGcPolicy,
) -> Result<RecoveryJournalGcReport, String> {
    preview_garbage_collect_completed_at(discovery_root, policy, unix_time_ms())
}

fn preview_garbage_collect_completed_at(
    discovery_root: &Path,
    policy: RecoveryJournalGcPolicy,
    now_unix_ms: u64,
) -> Result<RecoveryJournalGcReport, String> {
    let directory = discovery_root.join(".recovery");
    match fs::symlink_metadata(&directory) {
        Ok(_) => validate_existing_private_directory(&directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecoveryJournalGcReport::default());
        }
        Err(_) => {
            return Err("hmux_recovery_journal_invalid: directory is unreadable".to_string());
        }
    }
    let entries = scan_journal(&directory, true)?;
    plan_garbage_collection(&entries, &policy, now_unix_ms, None)
}

/// Inspects existing source locks without publishing files.
///
/// Preview callers receive a point-in-time, read-only observation. Destructive
/// callers must hold the host-wide maintenance lock exclusively so source-lock
/// admission cannot race the enumeration. Every journal entry is validated and
/// unknown or unsafe state still fails closed.
pub fn inspect_recovery_source_locks(
    discovery_root: &Path,
) -> Result<RecoverySourceLockInspection, String> {
    let directory = discovery_root.join(".recovery");
    match fs::symlink_metadata(&directory) {
        Ok(_) => validate_existing_private_directory(&directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecoverySourceLockInspection::default());
        }
        Err(_) => {
            return Err("hmux_recovery_journal_invalid: directory is unreadable".to_string());
        }
    }
    let entries = scan_journal(&directory, false)?;
    let mut inspection = RecoverySourceLockInspection::default();
    for entry in entries {
        if !matches!(entry.kind, JournalEntryKind::SourceLock) {
            continue;
        }
        inspection.present_source_locks = inspection.present_source_locks.saturating_add(1);
        match RecoveryLock::try_acquire_for_maintenance(open_private_existing_lock(&entry.path)?)? {
            Some(lock) => {
                inspection.idle_source_locks = inspection.idle_source_locks.saturating_add(1);
                drop(lock);
            }
            None => {
                inspection.busy_source_locks = inspection.busy_source_locks.saturating_add(1);
            }
        }
    }
    Ok(inspection)
}

/// Reports whether any existing source lock is currently held.
///
/// The caller must hold the host-wide maintenance lock exclusively when this
/// result will authorize mutation.
pub fn recovery_sources_busy(discovery_root: &Path) -> Result<bool, String> {
    inspect_recovery_source_locks(discovery_root).map(|inspection| inspection.busy_source_locks > 0)
}

/// Removes only completed recovery receipts and inactive journal debris.
///
/// The journal-local admission lock is the maintenance context: new operation
/// and source IDs cannot appear while the plan is being applied. Each
/// operation/source lock is still acquired separately, because an admitted
/// recovery may remain active after releasing the admission lock.
pub fn garbage_collect_completed(
    discovery_root: &Path,
    policy: RecoveryJournalGcPolicy,
) -> Result<RecoveryJournalGcReport, String> {
    garbage_collect_completed_at(discovery_root, policy, unix_time_ms(), None)
}

/// Applies completed-record retention to one semantic action only. Other
/// recovery receipts and every pending operation remain untouched. For an
/// action-scoped collection, `maximum_completed_records` is the low-water mark
/// for all records of that action. Eligible completed receipts are removed
/// until the action reaches that mark, or until no eligible receipt remains.
pub fn garbage_collect_completed_action(
    discovery_root: &Path,
    action: &str,
    policy: RecoveryJournalGcPolicy,
) -> Result<RecoveryJournalGcReport, String> {
    garbage_collect_completed_at(discovery_root, policy, unix_time_ms(), Some(action))
}

#[cfg(feature = "local-runtime")]
pub(crate) fn recover_scan_capacity_for_state_gc(
    discovery_root: &Path,
) -> Result<RecoveryJournalGcReport, String> {
    let directory = discovery_root.join(".recovery");
    ensure_private_directory(&directory)?;
    let admission = acquire_admission_lock(&directory)?;
    let mut report = RecoveryJournalGcReport::default();
    let entries = scan_journal_with_capacity_recovery(
        &admission,
        &directory,
        &mut report,
        PRODUCTION_JOURNAL_SCAN_CAPACITY,
    )?;
    report.remaining = inspect_entries(entries)?;
    Ok(report)
}

fn garbage_collect_completed_at(
    discovery_root: &Path,
    policy: RecoveryJournalGcPolicy,
    now_unix_ms: u64,
    action: Option<&str>,
) -> Result<RecoveryJournalGcReport, String> {
    garbage_collect_completed_at_with_capacity(
        discovery_root,
        policy,
        now_unix_ms,
        action,
        PRODUCTION_JOURNAL_SCAN_CAPACITY,
    )
}

fn garbage_collect_completed_at_with_capacity(
    discovery_root: &Path,
    policy: RecoveryJournalGcPolicy,
    now_unix_ms: u64,
    action: Option<&str>,
    scan_capacity: JournalScanCapacity,
) -> Result<RecoveryJournalGcReport, String> {
    let directory = discovery_root.join(".recovery");
    ensure_private_directory(&directory)?;
    let admission = acquire_admission_lock(&directory)?;
    let mut report = RecoveryJournalGcReport::default();
    let entries =
        scan_journal_with_capacity_recovery(&admission, &directory, &mut report, scan_capacity)?;
    merge_gc_plan(
        &mut report,
        plan_garbage_collection(&entries, &policy, now_unix_ms, action)?,
    );
    for candidate in planned_completed_candidates(&entries, &policy, now_unix_ms, action) {
        if !try_retire_completed_candidate(&directory, &candidate, |_| true)? {
            report.busy_entries += 1;
            continue;
        }
        report.removed_completed_records += 1;
        report.removed_completed_bytes = report
            .removed_completed_bytes
            .saturating_add(candidate.bytes);
    }

    if action.is_none() {
        cleanup_orphans(&directory, &policy, now_unix_ms, &mut report)?;
    }
    report.remaining = inspect_locked(&directory)?;
    Ok(report)
}

fn plan_garbage_collection(
    entries: &[JournalEntry],
    policy: &RecoveryJournalGcPolicy,
    now_unix_ms: u64,
    action: Option<&str>,
) -> Result<RecoveryJournalGcReport, String> {
    let mut report = RecoveryJournalGcReport::default();
    for candidate in planned_completed_candidates(entries, policy, now_unix_ms, action) {
        report.planned_completed_records += 1;
        report.planned_completed_bytes = report
            .planned_completed_bytes
            .saturating_add(candidate.bytes);
    }

    if action.is_some() {
        report.remaining = inspect_entries(entries.to_vec())?;
        return Ok(report);
    }

    let record_digests: BTreeSet<&str> = entries
        .iter()
        .filter_map(|entry| match &entry.kind {
            JournalEntryKind::OperationRecord(digest) => Some(digest.as_str()),
            _ => None,
        })
        .collect();
    report.planned_source_locks = planned_bounded_entries(
        entries
            .iter()
            .filter(|entry| matches!(entry.kind, JournalEntryKind::SourceLock)),
        policy.maximum_source_lock_files,
        policy.minimum_orphan_age,
        now_unix_ms,
    );
    report.planned_orphan_operation_locks = planned_bounded_entries(
        entries.iter().filter(|entry| {
            matches!(
                &entry.kind,
                JournalEntryKind::OperationLock(digest)
                    if !record_digests.contains(digest.as_str())
            )
        }),
        policy.maximum_orphan_operation_locks,
        policy.minimum_orphan_age,
        now_unix_ms,
    );
    report.planned_temporary_files = planned_bounded_entries(
        entries
            .iter()
            .filter(|entry| matches!(entry.kind, JournalEntryKind::Temporary { .. })),
        policy.maximum_temporary_files,
        policy.minimum_orphan_age,
        now_unix_ms,
    );
    report.remaining = inspect_entries(entries.to_vec())?;
    Ok(report)
}

fn planned_completed_candidates(
    entries: &[JournalEntry],
    policy: &RecoveryJournalGcPolicy,
    now_unix_ms: u64,
    action: Option<&str>,
) -> Vec<CompletedCandidate> {
    let mut completed: Vec<CompletedCandidate> = entries
        .iter()
        .filter_map(|entry| {
            let record = entry.record.as_ref()?;
            if action.is_some_and(|action| record.action != action) {
                return None;
            }
            if requires_durable_completion_replay(record) {
                return None;
            }
            completed_candidate(entry)
        })
        .collect();
    completed.sort_by(|left, right| {
        left.completed_unix_ms
            .cmp(&right.completed_unix_ms)
            .then_with(|| left.digest.cmp(&right.digest))
    });
    let mut bounded_record_count = action.map_or(completed.len(), |action| {
        entries
            .iter()
            .filter_map(|entry| entry.record.as_ref())
            .filter(|record| record.action == action)
            .count()
    });
    let mut completed_bytes = completed.iter().map(|entry| entry.bytes).sum::<u64>();
    let mut planned = Vec::new();
    for candidate in completed {
        if bounded_record_count <= policy.maximum_completed_records
            && completed_bytes <= policy.maximum_completed_bytes
        {
            break;
        }
        if !old_enough(
            now_unix_ms,
            candidate.completed_unix_ms,
            policy.minimum_completed_age,
        ) {
            continue;
        }
        bounded_record_count -= 1;
        completed_bytes = completed_bytes.saturating_sub(candidate.bytes);
        planned.push(candidate);
    }
    planned
}

fn merge_gc_plan(report: &mut RecoveryJournalGcReport, plan: RecoveryJournalGcReport) {
    report.merge(plan);
}

fn planned_bounded_entries<'a>(
    entries: impl Iterator<Item = &'a JournalEntry>,
    maximum: usize,
    minimum_age: Duration,
    now_unix_ms: u64,
) -> usize {
    let mut entries: Vec<&JournalEntry> = entries.collect();
    entries.sort_by(|left, right| {
        left.modified_unix_ms
            .cmp(&right.modified_unix_ms)
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut remaining = entries.len();
    let mut planned = 0;
    for entry in entries {
        if remaining <= maximum {
            break;
        }
        if !old_enough(now_unix_ms, entry.modified_unix_ms, minimum_age) {
            continue;
        }
        remaining -= 1;
        planned += 1;
    }
    planned
}

fn inspect_locked(directory: &Path) -> Result<RecoveryJournalInspection, String> {
    inspect_entries(scan_journal(directory, true)?)
}

fn inspect_entries(entries: Vec<JournalEntry>) -> Result<RecoveryJournalInspection, String> {
    let mut inspection = RecoveryJournalInspection::default();
    for entry in entries {
        inspection.total_bytes = inspection.total_bytes.saturating_add(entry.bytes);
        match entry.kind {
            JournalEntryKind::AdmissionLock => {}
            JournalEntryKind::OperationLock(_) => inspection.operation_lock_files += 1,
            JournalEntryKind::SourceLock => inspection.source_lock_files += 1,
            JournalEntryKind::Temporary { .. } => inspection.temporary_files += 1,
            JournalEntryKind::OperationRecord(_) => {
                inspection.operation_records += 1;
                inspection.operation_record_bytes = inspection
                    .operation_record_bytes
                    .saturating_add(entry.bytes);
                let record = entry.record.ok_or_else(|| {
                    "hmux_recovery_journal_invalid: record inspection was incomplete".to_string()
                })?;
                match record.state {
                    RecoveryRecordState::Reserved { .. } => {
                        inspection.pending_records += 1;
                        inspection.pending_sources.insert(PendingRecoverySource {
                            workspace_id: record.source_workspace_id,
                            session_id: record.source_session_id,
                        });
                    }
                    RecoveryRecordState::Completed { .. } => {
                        inspection.completed_records += 1;
                    }
                }
            }
        }
    }
    Ok(inspection)
}

fn cleanup_orphans(
    directory: &Path,
    policy: &RecoveryJournalGcPolicy,
    now_unix_ms: u64,
    report: &mut RecoveryJournalGcReport,
) -> Result<(), String> {
    let entries = scan_journal(directory, false)?;
    let record_digests: BTreeSet<String> = entries
        .iter()
        .filter_map(|entry| match &entry.kind {
            JournalEntryKind::OperationRecord(digest) => Some(digest.clone()),
            _ => None,
        })
        .collect();

    let source_locks: Vec<JournalEntry> = entries
        .iter()
        .filter(|entry| matches!(entry.kind, JournalEntryKind::SourceLock))
        .cloned()
        .collect();
    report.removed_source_locks += cleanup_unlocked_entries(
        directory,
        source_locks,
        policy.maximum_source_lock_files,
        policy.minimum_orphan_age,
        now_unix_ms,
        report,
    )?;

    let orphan_operation_locks: Vec<JournalEntry> = entries
        .iter()
        .filter(|entry| {
            matches!(
                &entry.kind,
                JournalEntryKind::OperationLock(digest) if !record_digests.contains(digest)
            )
        })
        .cloned()
        .collect();
    report.removed_orphan_operation_locks += cleanup_unlocked_entries(
        directory,
        orphan_operation_locks,
        policy.maximum_orphan_operation_locks,
        policy.minimum_orphan_age,
        now_unix_ms,
        report,
    )?;

    let mut temporary: Vec<JournalEntry> = entries
        .into_iter()
        .filter(|entry| matches!(entry.kind, JournalEntryKind::Temporary { .. }))
        .collect();
    temporary.sort_by(|left, right| {
        left.modified_unix_ms
            .cmp(&right.modified_unix_ms)
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut remaining = temporary.len();
    for entry in temporary {
        if remaining <= policy.maximum_temporary_files {
            break;
        }
        if !old_enough(
            now_unix_ms,
            entry.modified_unix_ms,
            policy.minimum_orphan_age,
        ) {
            continue;
        }
        let JournalEntryKind::Temporary { operation_digest } = &entry.kind else {
            unreachable!("temporary list contains only temporary files")
        };
        let operation_lock = if let Some(digest) = operation_digest {
            let lock_path = directory.join(format!("operation_{digest}.lock"));
            if private_path_exists(&lock_path)? {
                match RecoveryLock::try_acquire_for_maintenance(open_private_existing_lock(
                    &lock_path,
                )?)? {
                    Some(lock) => Some(lock),
                    None => {
                        report.busy_entries += 1;
                        continue;
                    }
                }
            } else {
                None
            }
        } else {
            None
        };
        let file = open_private_existing(&entry.path, "temporary record")?;
        remove_opened_file(directory, &entry.path, &file)?;
        drop(file);
        drop(operation_lock);
        remaining -= 1;
        report.removed_temporary_files += 1;
    }
    Ok(())
}

fn cleanup_unlocked_entries(
    directory: &Path,
    mut entries: Vec<JournalEntry>,
    maximum: usize,
    minimum_age: Duration,
    now_unix_ms: u64,
    report: &mut RecoveryJournalGcReport,
) -> Result<usize, String> {
    entries.sort_by(|left, right| {
        left.modified_unix_ms
            .cmp(&right.modified_unix_ms)
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut remaining = entries.len();
    let mut removed = 0;
    for entry in entries {
        if remaining <= maximum {
            break;
        }
        if !old_enough(now_unix_ms, entry.modified_unix_ms, minimum_age) {
            continue;
        }
        let file = open_private_existing_lock(&entry.path)?;
        let Some(lock) = RecoveryLock::try_acquire_for_maintenance(file)? else {
            report.busy_entries += 1;
            continue;
        };
        remove_opened_file(directory, &entry.path, &lock.file)?;
        drop(lock);
        remaining -= 1;
        removed += 1;
    }
    Ok(removed)
}

fn transactional_remove_record(
    directory: &Path,
    record_path: &Path,
    digest: &str,
) -> Result<(), String> {
    let record_file = open_private_existing(record_path, "record")?;
    let retired = directory.join(format!(
        ".gc-operation_{digest}-{}-{}.tmp",
        std::process::id(),
        unix_time_ms()
    ));
    if private_path_exists(&retired)? {
        return Err("hmux_recovery_journal_failed: gc staging collision".to_string());
    }
    ensure_same_open_file(record_path, &record_file)?;
    replace_private_file(record_path, &retired)
        .map_err(|_| "hmux_recovery_journal_failed: record retirement failed".to_string())?;
    sync_private_directory(directory)?;
    remove_opened_file(directory, &retired, &record_file)
}

fn remove_opened_file(directory: &Path, path: &Path, file: &File) -> Result<(), String> {
    ensure_same_open_file(path, file)?;
    fs::remove_file(path)
        .map_err(|_| "hmux_recovery_journal_failed: journal entry removal failed".to_string())?;
    sync_private_directory(directory)
}

fn old_enough(now_unix_ms: u64, then_unix_ms: u64, minimum_age: Duration) -> bool {
    let minimum_ms = minimum_age.as_millis().try_into().unwrap_or(u64::MAX);
    now_unix_ms.saturating_sub(then_unix_ms) >= minimum_ms
}

pub fn request_fingerprint(fields: &[&str]) -> String {
    let mut digest = Sha256::new();
    for field in fields {
        digest.update(field.len().to_le_bytes());
        digest.update(field.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn validate_record(record: &RecoveryRecord, identity: &RecoveryIdentity) -> Result<(), String> {
    validate_stored_record(record)?;
    if record.schema_version != RECOVERY_SCHEMA_VERSION
        || record.recovery_id != identity.recovery_id
        || record.source_session_id != identity.source_session_id
        || record.source_workspace_id != identity.source_workspace_id
        || record.request_fingerprint != identity.request_fingerprint
        || record.action != identity.action
    {
        return Err(
            "hmux_recovery_idempotency_conflict: recovery id belongs to another request"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_prepared_record(
    record: &RecoveryRecord,
    identity: &PreparedRecoveryIdentity,
    canonical_payload: Option<&str>,
) -> Result<(), String> {
    validate_stored_record(record)?;
    if record.schema_version != RECOVERY_SCHEMA_VERSION
        || record.recovery_id != identity.recovery_id
        || record.source_session_id != identity.source_session_id
        || record.source_workspace_id != identity.source_workspace_id
        || record.action != identity.action
    {
        return Err(
            "hmux_recovery_idempotency_conflict: recovery id belongs to another request"
                .to_string(),
        );
    }
    let stored = match &record.state {
        RecoveryRecordState::Reserved {
            operation_checkpoint,
            ..
        }
        | RecoveryRecordState::Completed {
            operation_checkpoint,
            ..
        } => operation_checkpoint.as_ref(),
    };
    let Some(stored) = stored else {
        return if identity
            .legacy_request_fingerprint
            .as_ref()
            .is_some_and(|fingerprint| fingerprint == &record.request_fingerprint)
        {
            Ok(())
        } else {
            Err(
                "hmux_recovery_idempotency_conflict: legacy operation fingerprint changed"
                    .to_string(),
            )
        };
    };
    if record.request_fingerprint != request_fingerprint(&[&stored.canonical_payload]) {
        return Err(
            "hmux_recovery_journal_invalid: prepared operation fingerprint changed".to_string(),
        );
    }
    if canonical_payload.is_some_and(|payload| payload != stored.canonical_payload) {
        return Err(
            "hmux_recovery_idempotency_conflict: canonical operation payload changed".to_string(),
        );
    }
    Ok(())
}

fn validate_stored_record(record: &RecoveryRecord) -> Result<(), String> {
    if record.schema_version != RECOVERY_SCHEMA_VERSION
        || !valid_recovery_identity_fields(
            &record.recovery_id,
            &record.source_session_id,
            &record.source_workspace_id,
            &record.request_fingerprint,
            &record.action,
        )
        || record.created_unix_ms == 0
    {
        return Err("hmux_recovery_journal_invalid: recovery record is malformed".to_string());
    }
    let bounded = valid_recovery_identity_field;
    match &record.state {
        RecoveryRecordState::Reserved {
            resume_checkpoint,
            operation_checkpoint,
        } => {
            if let Some(checkpoint) = resume_checkpoint {
                validate_resume_checkpoint(checkpoint)?;
            }
            if let Some(checkpoint) = operation_checkpoint {
                validate_operation_checkpoint(checkpoint)?;
            }
        }
        RecoveryRecordState::Completed {
            target_session_id,
            target_workspace_id,
            target_build_id,
            outcome,
            resume_checkpoint,
            operation_checkpoint,
            completed_unix_ms,
        } => {
            if !bounded(target_session_id)
                || !bounded(target_workspace_id)
                || !bounded(target_build_id)
                || !bounded(outcome)
                || completed_unix_ms
                    .is_some_and(|value| value == 0 || value < record.created_unix_ms)
            {
                return Err(
                    "hmux_recovery_journal_invalid: recovery record is malformed".to_string(),
                );
            }
            if let Some(checkpoint) = resume_checkpoint {
                validate_resume_checkpoint(checkpoint)?;
            }
            if let Some(checkpoint) = operation_checkpoint {
                validate_operation_checkpoint(checkpoint)?;
            }
        }
    }
    Ok(())
}

fn valid_recovery_identity_fields(
    recovery_id: &str,
    source_session_id: &str,
    source_workspace_id: &str,
    request_fingerprint: &str,
    action: &str,
) -> bool {
    [recovery_id, source_session_id, source_workspace_id, action]
        .into_iter()
        .all(valid_recovery_identity_field)
        && request_fingerprint.len() == 64
        && request_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_recovery_identity_field(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4_096 && !value.chars().any(char::is_control)
}

fn validate_operation_checkpoint(checkpoint: &RecoveryOperationCheckpoint) -> Result<(), String> {
    validate_operation_payload(&checkpoint.canonical_payload)?;
    if let Some(receipt) = checkpoint.source_stop_receipt.as_deref() {
        validate_private_json("source stop receipt", receipt)?;
    }
    if let Some(receipt) = checkpoint.replacement_receipt.as_deref() {
        validate_private_json("replacement receipt", receipt)?;
    }
    Ok(())
}

fn validate_private_json(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_RECOVERY_OPERATION_PAYLOAD_BYTES
        || serde_json::from_str::<validated_json::ValidatedJson>(value).is_err()
    {
        return Err(format!(
            "hmux_recovery_journal_invalid: {name} is not bounded canonical JSON"
        ));
    }
    Ok(())
}

/// Pure boundary check for a private operation payload before a journal write
/// is attempted. Callers can settle deterministic oversize/shape refusals
/// without conflating them with persistence failure.
fn validate_operation_payload(value: &str) -> Result<(), String> {
    validate_private_json("canonical operation payload", value)
}

fn validate_resume_checkpoint(checkpoint: &RecoveryResumeCheckpoint) -> Result<(), String> {
    let bounded = |value: &str| {
        !value.is_empty() && value.len() <= 4_096 && !value.chars().any(char::is_control)
    };
    if !bounded(&checkpoint.provider_id)
        || !bounded(&checkpoint.resume_identity)
        || !bounded(&checkpoint.provider_cwd)
        || !bounded(&checkpoint.source_host_start_marker)
        || !bounded(&checkpoint.source_provider_start_marker)
        || checkpoint.source_host_process_id == 0
        || checkpoint.source_provider_process_id == 0
        || checkpoint.attempt > 1_000
        || [
            checkpoint.source_host_instance_id.as_deref(),
            checkpoint.source_terminal_epoch.as_deref(),
            checkpoint.source_host_proof_marker.as_deref(),
            checkpoint.source_provider_proof_marker.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|value| !bounded(value))
        || {
            let fence_fields = [
                checkpoint.source_host_instance_id.is_some(),
                checkpoint.source_terminal_epoch.is_some(),
                checkpoint.source_host_proof_marker.is_some(),
                checkpoint.source_provider_proof_marker.is_some(),
            ];
            fence_fields.iter().any(|present| *present)
                && !fence_fields.iter().all(|present| *present)
        }
    {
        return Err("hmux_recovery_journal_invalid: resume checkpoint is malformed".to_string());
    }
    Ok(())
}

fn read_record(path: &Path) -> Result<RecoveryRecord, String> {
    #[cfg(test)]
    RECORD_READ_COUNT.set(RECORD_READ_COUNT.get() + 1);
    let payload = read_private_payload(path, "record")?;
    let record: RecoveryRecord = serde_json::from_slice(&payload)
        .map_err(|_| "hmux_recovery_journal_invalid: record is malformed".to_string())?;
    validate_stored_record(&record)?;
    Ok(record)
}

fn read_private_payload(path: &Path, label: &str) -> Result<Vec<u8>, String> {
    let file = open_private_existing(path, label)?;
    let metadata = file
        .metadata()
        .map_err(|_| format!("hmux_recovery_journal_invalid: {label} is unreadable"))?;
    if metadata.len() > MAX_RECORD_BYTES {
        return Err(format!(
            "hmux_recovery_journal_invalid: {label} is too large"
        ));
    }
    let mut payload = Vec::new();
    file.take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut payload)
        .map_err(|_| format!("hmux_recovery_journal_invalid: {label} is unreadable"))?;
    if payload.len() as u64 > MAX_RECORD_BYTES {
        return Err(format!(
            "hmux_recovery_journal_invalid: {label} is too large"
        ));
    }
    Ok(payload)
}

fn write_record(directory: &Path, path: &Path, record: &RecoveryRecord) -> Result<(), String> {
    let admission = acquire_admission_lock(directory)?;
    write_record_admitted(&admission, directory, path, record)
}

fn write_record_admitted(
    _admission: &JournalAdmissionLock,
    directory: &Path,
    path: &Path,
    record: &RecoveryRecord,
) -> Result<(), String> {
    let payload = serialize_record(record)?;
    let record_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("operation");
    let temporary = directory.join(format!(
        ".{record_name}-{}-{}.tmp",
        std::process::id(),
        unix_time_ms()
    ));
    let write_result = (|| -> Result<(), String> {
        let mut file = open_private_new(&temporary)?;
        file.write_all(&payload)
            .map_err(|_| "hmux_recovery_journal_failed: record write failed".to_string())?;
        file.sync_all()
            .map_err(|_| "hmux_recovery_journal_failed: record sync failed".to_string())?;
        ensure_same_open_file(&temporary, &file)?;
        let existing = private_path_exists(path)?
            .then(|| open_private_existing(path, "record"))
            .transpose()?;
        if let Some(existing) = existing.as_ref() {
            ensure_same_open_file(path, existing)?;
        }
        drop(existing);
        drop(file);
        private_storage::replace_file(&temporary, path)
            .map_err(|_| "hmux_recovery_journal_failed: record publish failed".to_string())?;
        sync_private_directory(directory)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn serialize_record(record: &RecoveryRecord) -> Result<Vec<u8>, String> {
    validate_stored_record(record)?;
    let payload = serde_json::to_vec(record)
        .map_err(|_| "hmux_recovery_journal_failed: record serialization failed".to_string())?;
    if payload.len() as u64 > MAX_RECORD_BYTES {
        return Err(RECOVERY_RECORD_CAPACITY_EXCEEDED_CODE.to_string());
    }
    Ok(payload)
}

fn digest(value: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(value.as_bytes());
    format!("{:x}", digest.finalize())[..32].to_string()
}

#[derive(Clone, Debug)]
struct JournalEntry {
    path: PathBuf,
    kind: JournalEntryKind,
    bytes: u64,
    modified_unix_ms: u64,
    identity: PrivateFileIdentity,
    record: Option<RecoveryRecord>,
}

#[derive(Clone, Debug)]
enum JournalEntryKind {
    AdmissionLock,
    OperationRecord(String),
    OperationLock(String),
    SourceLock,
    Temporary { operation_digest: Option<String> },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum JournalRecordScan {
    Skip,
    // Validate every record, but discard all payloads if the journal exceeds
    // this bound. Overflow repair must not retain an oversized/partial snapshot.
    RetainThrough(usize),
}

#[derive(Clone, Debug)]
struct CompletedCandidate {
    digest: String,
    path: PathBuf,
    bytes: u64,
    completed_unix_ms: u64,
}

fn completed_candidate(entry: &JournalEntry) -> Option<CompletedCandidate> {
    let JournalEntryKind::OperationRecord(digest) = &entry.kind else {
        return None;
    };
    let record = entry.record.as_ref()?;
    let RecoveryRecordState::Completed {
        completed_unix_ms, ..
    } = &record.state
    else {
        return None;
    };
    Some(CompletedCandidate {
        digest: digest.clone(),
        path: entry.path.clone(),
        bytes: entry.bytes,
        completed_unix_ms: completed_unix_ms.unwrap_or(entry.modified_unix_ms),
    })
}

fn requires_durable_completion_replay(record: &RecoveryRecord) -> bool {
    // A terminal refusal is also an operation result. Only its consumer can
    // acknowledge it after durable compensation; GC must not authorize replay.
    record.action == STANDALONE_CREATE_OPERATION_RECOVERY_ACTION
        && matches!(&record.state, RecoveryRecordState::Completed { .. })
}

fn compact_completed_operations_for_admission(
    directory: &Path,
    entries: &[JournalEntry],
    required: usize,
) -> Result<usize, String> {
    let now_unix_ms = unix_time_ms();
    let minimum_completed_age = RecoveryJournalGcPolicy::default().minimum_completed_age;
    let mut candidates: Vec<CompletedCandidate> = entries
        .iter()
        .filter_map(|entry| {
            let record = entry.record.as_ref()?;
            let candidate = completed_candidate(entry)?;
            (record.action != MANAGED_STOP_RECOVERY_ACTION
                && !requires_durable_completion_replay(record)
                && (is_valid_completed_rehost_receipt_record(record)
                    || old_enough(
                        now_unix_ms,
                        candidate.completed_unix_ms,
                        minimum_completed_age,
                    )))
            .then_some(candidate)
        })
        .collect();
    candidates.sort_by(|left, right| {
        left.completed_unix_ms
            .cmp(&right.completed_unix_ms)
            .then_with(|| left.digest.cmp(&right.digest))
    });
    let mut compacted = 0;
    for candidate in candidates {
        if try_retire_completed_candidate(directory, &candidate, |record| {
            record.action != MANAGED_STOP_RECOVERY_ACTION
                && !requires_durable_completion_replay(record)
                && (is_valid_completed_rehost_receipt_record(record)
                    || old_enough(
                        now_unix_ms,
                        candidate.completed_unix_ms,
                        minimum_completed_age,
                    ))
        })? {
            compacted += 1;
            if compacted == required {
                break;
            }
        }
    }
    Ok(compacted)
}

fn try_retire_completed_candidate(
    directory: &Path,
    candidate: &CompletedCandidate,
    eligible: impl FnOnce(&RecoveryRecord) -> bool,
) -> Result<bool, String> {
    let lock_path = directory.join(format!("operation_{}.lock", candidate.digest));
    let Some(operation_lock) =
        RecoveryLock::try_acquire_for_maintenance(open_private_lock(&lock_path)?)?
    else {
        return Ok(false);
    };
    let current = read_record(&candidate.path)?;
    if !matches!(&current.state, RecoveryRecordState::Completed { .. }) || !eligible(&current) {
        return Err(
            "hmux_recovery_journal_invalid: completed record changed during maintenance"
                .to_string(),
        );
    }
    publish_managed_rehost_successor(directory, &current)?;
    #[cfg(feature = "local-runtime")]
    standalone_upgrade::publish_completion(directory, &current)?;
    transactional_remove_record(directory, &candidate.path, &candidate.digest)?;
    remove_opened_file(directory, &lock_path, &operation_lock.file)?;
    drop(operation_lock);
    Ok(true)
}

fn acquire_admission_lock(directory: &Path) -> Result<JournalAdmissionLock, String> {
    acquire_admission_lock_observed(directory, || ())
}

fn acquire_admission_lock_observed<G>(
    directory: &Path,
    observe: impl FnOnce() -> G,
) -> Result<JournalAdmissionLock, String> {
    let file = open_private_lock(&directory.join(ADMISSION_LOCK_NAME))?;
    // Exclude pathname validation/open from the blocking lock interval.
    let _scope = observe();
    RecoveryLock::acquire_admission(file).map(|lock| JournalAdmissionLock { _lock: lock })
}

fn scan_journal_with_capacity_recovery(
    _admission: &JournalAdmissionLock,
    directory: &Path,
    report: &mut RecoveryJournalGcReport,
    capacity: JournalScanCapacity,
) -> Result<Vec<JournalEntry>, String> {
    debug_assert!(capacity.low_water_entries < capacity.authoritative_entries);
    debug_assert!(capacity.authoritative_entries < capacity.overflow_entries);
    // Reuse a complete bounded snapshot while admission still fences record
    // publication. Oversized journals retain metadata only for overflow repair;
    // actual mutations require a fresh authoritative scan afterward.
    let mut entries = scan_journal_bounded(
        directory,
        JournalRecordScan::RetainThrough(capacity.authoritative_entries),
        capacity.overflow_entries,
        "overflow recovery scan",
    )?;
    if entries.len() <= capacity.authoritative_entries {
        return Ok(entries);
    }

    let record_digests: BTreeSet<String> = entries
        .iter()
        .filter_map(|entry| match &entry.kind {
            JournalEntryKind::OperationRecord(digest) => Some(digest.clone()),
            _ => None,
        })
        .collect();
    entries.sort_by(|left, right| {
        left.modified_unix_ms
            .cmp(&right.modified_unix_ms)
            .then_with(|| left.path.cmp(&right.path))
    });

    let removal_needed = entries.len().saturating_sub(capacity.low_water_entries);
    let mut candidates = Vec::with_capacity(removal_needed);
    for entry in entries {
        if overflow_candidate_is_inactive(directory, &entry, &record_digests)? {
            candidates.push(entry);
            if candidates.len() == removal_needed {
                break;
            }
        }
    }
    if candidates.len() != removal_needed {
        return Err(format!(
            "hmux_recovery_journal_capacity: protected entries prevent recovery below {}",
            capacity.low_water_entries
        ));
    }

    // Phase two begins only after the complete outer scan and every liveness
    // check succeeded. Re-open and compare the planned inode before each
    // deletion so a replaced path is never mistaken for the validated orphan.
    for candidate in candidates {
        remove_overflow_candidate(directory, &candidate, report)?;
    }
    scan_journal_bounded(
        directory,
        JournalRecordScan::RetainThrough(capacity.authoritative_entries),
        capacity.authoritative_entries,
        "entry scan",
    )
}

fn overflow_candidate_is_inactive(
    directory: &Path,
    entry: &JournalEntry,
    record_digests: &BTreeSet<String>,
) -> Result<bool, String> {
    match &entry.kind {
        JournalEntryKind::Temporary {
            operation_digest: Some(digest),
        } => {
            let lock_path = directory.join(format!("operation_{digest}.lock"));
            if !private_path_exists(&lock_path)? {
                return Ok(true);
            }
            Ok(
                RecoveryLock::try_acquire_for_maintenance(open_private_existing_lock(&lock_path)?)?
                    .is_some(),
            )
        }
        JournalEntryKind::OperationLock(digest) if !record_digests.contains(digest) => Ok(
            RecoveryLock::try_acquire_for_maintenance(open_private_existing_lock(&entry.path)?)?
                .is_some(),
        ),
        JournalEntryKind::SourceLock => Ok(RecoveryLock::try_acquire_for_maintenance(
            open_private_existing_lock(&entry.path)?,
        )?
        .is_some()),
        _ => Ok(false),
    }
}

fn remove_overflow_candidate(
    directory: &Path,
    entry: &JournalEntry,
    report: &mut RecoveryJournalGcReport,
) -> Result<(), String> {
    match &entry.kind {
        JournalEntryKind::Temporary {
            operation_digest: Some(digest),
        } => {
            let lock_path = directory.join(format!("operation_{digest}.lock"));
            let operation_lock = if private_path_exists(&lock_path)? {
                let Some(lock) = RecoveryLock::try_acquire_for_maintenance(
                    open_private_existing_lock(&lock_path)?,
                )?
                else {
                    return Err(
                        "hmux_recovery_journal_capacity: operation became active during overflow recovery"
                            .to_string(),
                    );
                };
                Some(lock)
            } else {
                None
            };
            let file = open_private_existing(&entry.path, "temporary record")?;
            ensure_planned_open_file(entry, &file)?;
            remove_opened_file(directory, &entry.path, &file)?;
            drop(file);
            drop(operation_lock);
            report.planned_temporary_files += 1;
            report.removed_temporary_files += 1;
        }
        JournalEntryKind::OperationLock(_) => {
            let Some(lock) = RecoveryLock::try_acquire_for_maintenance(
                open_private_existing_lock(&entry.path)?,
            )?
            else {
                return Err(
                    "hmux_recovery_journal_capacity: operation became active during overflow recovery"
                        .to_string(),
                );
            };
            ensure_planned_open_file(entry, &lock.file)?;
            remove_opened_file(directory, &entry.path, &lock.file)?;
            drop(lock);
            report.planned_orphan_operation_locks += 1;
            report.removed_orphan_operation_locks += 1;
        }
        JournalEntryKind::SourceLock => {
            let Some(lock) = RecoveryLock::try_acquire_for_maintenance(
                open_private_existing_lock(&entry.path)?,
            )?
            else {
                return Err(
                    "hmux_recovery_journal_capacity: source became active during overflow recovery"
                        .to_string(),
                );
            };
            ensure_planned_open_file(entry, &lock.file)?;
            remove_opened_file(directory, &entry.path, &lock.file)?;
            drop(lock);
            report.planned_source_locks += 1;
            report.removed_source_locks += 1;
        }
        _ => {
            return Err(
                "hmux_recovery_journal_invalid: semantic entry selected for overflow recovery"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn ensure_planned_open_file(entry: &JournalEntry, file: &File) -> Result<(), String> {
    if private_storage::open_file_identity(&entry.path, file).map_err(private_storage_invalid)?
        != entry.identity
    {
        return Err(
            "hmux_recovery_journal_invalid: file changed during overflow recovery".to_string(),
        );
    }
    Ok(())
}

fn ensure_raw_admission_capacity(
    current_entries: usize,
    additional_entries: usize,
) -> Result<(), String> {
    if current_entries.saturating_add(additional_entries) > MAX_JOURNAL_SCAN_ENTRIES {
        return Err("hmux_recovery_journal_capacity_exceeded: raw entry limit reached".to_string());
    }
    Ok(())
}

fn scan_journal(directory: &Path, read_records: bool) -> Result<Vec<JournalEntry>, String> {
    scan_journal_bounded(
        directory,
        if read_records {
            JournalRecordScan::RetainThrough(MAX_JOURNAL_SCAN_ENTRIES)
        } else {
            JournalRecordScan::Skip
        },
        MAX_JOURNAL_SCAN_ENTRIES,
        "entry scan",
    )
}

fn scan_journal_bounded(
    directory: &Path,
    record_scan: JournalRecordScan,
    maximum_entries: usize,
    capacity_label: &str,
) -> Result<Vec<JournalEntry>, String> {
    #[cfg(test)]
    JOURNAL_SCAN_COUNT.set(JOURNAL_SCAN_COUNT.get() + 1);
    let mut entries: Vec<JournalEntry> = Vec::new();
    let iterator = fs::read_dir(directory)
        .map_err(|_| "hmux_recovery_journal_invalid: directory is unreadable".to_string())?;
    for entry in iterator {
        let entry = entry.map_err(|_| {
            "hmux_recovery_journal_invalid: directory entry is unreadable".to_string()
        })?;
        let name = entry.file_name().into_string().map_err(|_| {
            "hmux_recovery_journal_invalid: journal entry name is not UTF-8".to_string()
        })?;
        let path = entry.path();
        if name == completion_acknowledgement::DIRECTORY_NAME {
            validate_existing_private_directory(&path)?;
            continue;
        }
        if entries.len() >= maximum_entries {
            return Err(format!(
                "hmux_recovery_journal_capacity: {capacity_label} exceeds {maximum_entries}"
            ));
        }
        if let JournalRecordScan::RetainThrough(limit) = record_scan {
            if entries.len() == limit {
                for retained in &mut entries {
                    retained.record = None;
                }
            }
        }
        let kind = classify_entry_name(&name)?;
        let private_storage::PrivateFileMetadata { identity, metadata } =
            private_storage::file_metadata(&path).map_err(|error| match error {
                StorageError::Io { .. } => {
                    "hmux_recovery_journal_invalid: file is unreadable".to_string()
                }
                _ => private_storage_invalid(error),
            })?;
        #[cfg(test)]
        if let Some(observer) = JOURNAL_AFTER_METADATA_READ.with_borrow_mut(Option::take) {
            observer(&path);
        }
        if matches!(kind, JournalEntryKind::Temporary { .. }) && metadata.len() > MAX_RECORD_BYTES {
            return Err("hmux_recovery_journal_invalid: temporary record is too large".to_string());
        }
        let record = match record_scan {
            JournalRecordScan::RetainThrough(limit) => {
                let record = read_journal_entry_record(&path, &kind)?;
                record.filter(|_| entries.len() < limit)
            }
            _ => None,
        };
        entries.push(JournalEntry {
            path,
            kind,
            bytes: metadata.len(),
            modified_unix_ms: metadata_time_ms(&metadata)?,
            identity,
            record,
        });
    }
    Ok(entries)
}

fn read_journal_entry_record(
    path: &Path,
    kind: &JournalEntryKind,
) -> Result<Option<RecoveryRecord>, String> {
    let JournalEntryKind::OperationRecord(file_digest) = kind else {
        return Ok(None);
    };
    let record = read_record(path)?;
    if digest(&record.recovery_id) != *file_digest {
        return Err(
            "hmux_recovery_journal_invalid: record identity does not match its path".to_string(),
        );
    }
    Ok(Some(record))
}

fn classify_entry_name(name: &str) -> Result<JournalEntryKind, String> {
    if name == ADMISSION_LOCK_NAME {
        return Ok(JournalEntryKind::AdmissionLock);
    }
    if let Some(digest) = named_digest(name, "operation_", ".json") {
        return Ok(JournalEntryKind::OperationRecord(digest));
    }
    if let Some(digest) = named_digest(name, "operation_", ".lock") {
        return Ok(JournalEntryKind::OperationLock(digest));
    }
    if named_digest(name, "source_", ".lock").is_some() {
        return Ok(JournalEntryKind::SourceLock);
    }
    if name.ends_with(".tmp") {
        let operation_digest = [".operation_", ".gc-operation_"]
            .into_iter()
            .find_map(|prefix| temporary_operation_digest(name, prefix));
        if operation_digest.is_some() {
            return Ok(JournalEntryKind::Temporary { operation_digest });
        }
    }
    Err(format!(
        "hmux_recovery_journal_invalid: unexpected journal entry {name}"
    ))
}

fn named_digest(name: &str, prefix: &str, suffix: &str) -> Option<String> {
    let value = name.strip_prefix(prefix)?.strip_suffix(suffix)?;
    valid_digest(value).then(|| value.to_string())
}

fn temporary_operation_digest(name: &str, prefix: &str) -> Option<String> {
    let rest = name.strip_prefix(prefix)?;
    let digest = rest.get(..32)?;
    let suffix = rest.get(32..)?;
    (valid_digest(digest) && suffix.starts_with('-') && suffix.ends_with(".tmp"))
        .then(|| digest.to_string())
}

fn valid_digest(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn metadata_time_ms(metadata: &fs::Metadata) -> Result<u64, String> {
    metadata
        .modified()
        .map_err(|_| "hmux_recovery_journal_invalid: file timestamp is unreadable".to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "hmux_recovery_journal_invalid: file timestamp is invalid".to_string())?
        .as_millis()
        .try_into()
        .map_err(|_| "hmux_recovery_journal_invalid: file timestamp is invalid".to_string())
}

fn private_path_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            private_storage::file_identity(path).map_err(private_storage_invalid)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("hmux_recovery_journal_invalid: file is unreadable".to_string()),
    }
}

fn private_directory_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            validate_existing_private_directory(path)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("hmux_recovery_journal_invalid: directory is unreadable".to_string()),
    }
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "hmux_recovery_journal_failed: directory has no parent".to_string())?;
    private_storage::create_directory(path).map_err(private_directory_error)?;
    // A child-directory sync cannot make its newly created name durable. Sync
    // the validated parent on every retry so an earlier sync failure converges.
    private_storage::sync_directory(parent)
        .map_err(|_| "hmux_recovery_journal_failed: parent directory sync failed".to_string())
}

#[cfg(all(test, unix))]
fn ensure_private_directory_with_parent_sync(
    path: &Path,
    mut sync_parent: impl FnMut(&File) -> std::io::Result<()>,
) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::os::unix::fs::OpenOptionsExt;

    let parent = path
        .parent()
        .ok_or_else(|| "hmux_recovery_journal_failed: directory has no parent".to_string())?;
    let parent_directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(parent)
        .map_err(|_| "hmux_recovery_journal_invalid: directory is unreadable".to_string())?;
    private_storage::create_directory(path).map_err(private_directory_error)?;
    sync_parent(&parent_directory)
        .map_err(|_| "hmux_recovery_journal_failed: parent directory sync failed".to_string())
}

fn validate_existing_private_directory(path: &Path) -> Result<(), String> {
    private_storage::validate_directory(path).map_err(private_directory_error)
}

fn open_private_lock(path: &Path) -> Result<File, String> {
    private_storage::open_lock_file(path)
        .map_err(|_| "hmux_recovery_journal_failed: lock open failed".to_string())
}

fn open_private_new(path: &Path) -> Result<File, String> {
    private_storage::open_new_file(path)
        .map_err(|_| "hmux_recovery_journal_failed: temporary record open failed".to_string())
}

fn open_private_existing(path: &Path, label: &str) -> Result<File, String> {
    private_storage::open_existing_file(path)
        .map_err(|_| format!("hmux_recovery_journal_invalid: {label} is unreadable"))
}

fn open_private_existing_lock(path: &Path) -> Result<File, String> {
    private_storage::open_existing_lock_file(path)
        .map_err(|_| "hmux_recovery_journal_invalid: lock is unreadable".to_string())
}

fn ensure_same_open_file(path: &Path, file: &File) -> Result<(), String> {
    private_storage::open_file_identity(path, file)
        .map(|_| ())
        .map_err(private_storage_invalid)
}

fn sync_private_directory(path: &Path) -> Result<(), String> {
    private_storage::sync_directory(path)
        .map_err(|_| "hmux_recovery_journal_failed: directory sync failed".to_string())
}

fn replace_private_file(source: &Path, target: &Path) -> Result<(), String> {
    private_storage::replace_file(source, target)
        .map_err(|_| "hmux_recovery_journal_failed: file replace failed".to_string())
}

fn private_storage_invalid(_error: StorageError) -> String {
    "hmux_recovery_journal_invalid: file is not private".to_string()
}

fn private_directory_error(error: StorageError) -> String {
    match error {
        StorageError::Io { .. } => {
            "hmux_recovery_journal_failed: directory creation failed".to_string()
        }
        _ => "hmux_recovery_journal_invalid: directory is not private".to_string(),
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
#[cfg(all(test, unix))]
mod tests;

#[cfg(test)]
type JournalMetadataReadObserver = Box<dyn FnOnce(&Path)>;

#[cfg(test)]
thread_local! {
    static RECORD_READ_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static JOURNAL_SCAN_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static JOURNAL_AFTER_METADATA_READ: std::cell::RefCell<Option<JournalMetadataReadObserver>> = const { std::cell::RefCell::new(None) };
}
