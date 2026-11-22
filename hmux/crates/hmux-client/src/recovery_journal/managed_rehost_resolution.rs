//! Concurrent successor readers share one admission-fenced journal snapshot.
//! The snapshot is a read transaction: its shared file lock fences legacy and
//! current writers until the last admitted reader exits. Between transactions
//! the reader registry keeps only the records the last transaction decoded and
//! the record files it decoded them from, never the lock. Every transaction
//! still scans and validates the whole journal under its own lock; it reuses
//! those records only when it finds exactly the same record files.

use super::*;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Instant;

#[cfg(test)]
mod tests;

/// Every record write publishes a new file under the exclusive admission
/// lock, so a changed record shows a new identity, size or timestamp. A
/// filesystem that reuses file numbers and keeps coarse timestamps could still
/// hide a same-size rewrite inside one timestamp tick, so decoded records are
/// never reused past this age.
const DECODED_RECORDS_MAX_AGE: Duration = Duration::from_secs(30);

/// Managed rehost records keyed by their exact source.
type SourceRecords = BTreeMap<(String, String), Vec<RecoveryRecord>>;

/// One operation record file as a journal scan observed it.
#[derive(Debug, Eq, PartialEq)]
struct RecordFile {
    digest: String,
    identity: PrivateFileIdentity,
    bytes: u64,
    modified_unix_ms: u64,
}

fn record_files(entries: &[JournalEntry]) -> Vec<RecordFile> {
    let mut files: Vec<_> = entries
        .iter()
        .filter_map(|entry| match &entry.kind {
            JournalEntryKind::OperationRecord(digest) => Some(RecordFile {
                digest: digest.clone(),
                identity: entry.identity,
                bytes: entry.bytes,
                modified_unix_ms: entry.modified_unix_ms,
            }),
            _ => None,
        })
        .collect();
    files.sort_unstable_by(|left, right| left.digest.cmp(&right.digest));
    files
}

/// Records one transaction decoded, and the record files it read them from.
struct DecodedRecords {
    files: Vec<RecordFile>,
    records: Arc<SourceRecords>,
    observed_at: Instant,
}

impl DecodedRecords {
    fn fresh(&self) -> bool {
        self.observed_at.elapsed() < DECODED_RECORDS_MAX_AGE
    }

    fn reusable_for(&self, files: &[RecordFile]) -> bool {
        self.fresh() && self.files == files
    }
}

/// One journal directory's readers: the cohort still preparing, if any, and
/// the records the last successful transaction decoded.
#[derive(Default)]
struct DirectoryReaders {
    flight: Weak<ReadFlight>,
    decoded: Option<Arc<DecodedRecords>>,
}

impl DirectoryReaders {
    fn retained(&self) -> bool {
        self.flight.strong_count() > 0
            || self.decoded.as_ref().is_some_and(|decoded| decoded.fresh())
    }
}

/// The process-wide reader registry. It is held only to join a cohort or to
/// read or replace decoded records, never across journal I/O.
fn readers() -> Result<MutexGuard<'static, BTreeMap<PathBuf, DirectoryReaders>>, String> {
    static READERS: OnceLock<Mutex<BTreeMap<PathBuf, DirectoryReaders>>> = OnceLock::new();
    READERS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "hmux_recovery_journal_failed: reader admission is poisoned".to_string())
}

/// Decode and validate every operation record. Resolution keeps the managed
/// rehost records and valid completed rehost receipts.
fn decode_source_records(entries: &[JournalEntry]) -> Result<SourceRecords, String> {
    let mut records = SourceRecords::new();
    for entry in entries {
        let Some(record) = read_journal_entry_record(&entry.path, &entry.kind)? else {
            continue;
        };
        if is_refused_managed_rehost_record(&record) {
            continue;
        }
        if record.action != MANAGED_REHOST_RECOVERY_ACTION
            && !is_valid_completed_rehost_receipt_record(&record)
        {
            continue;
        }
        let key = (
            record.source_workspace_id.clone(),
            record.source_session_id.clone(),
        );
        records.entry(key).or_default().push(record);
    }
    Ok(records)
}

struct Snapshot {
    records: Arc<SourceRecords>,
    _admission: RecoveryLock,
}

impl Snapshot {
    fn load(directory: &Path) -> Result<Self, String> {
        let file = open_private_lock(&directory.join(ADMISSION_LOCK_NAME))?;
        FileExt::lock_shared(&file)
            .map_err(|_| "hmux_recovery_journal_failed: read admission lock failed".to_string())?;
        let admission = RecoveryLock { file };
        let observed_at = Instant::now();
        let entries = scan_journal(directory, false)?;
        let files = record_files(&entries);
        let previous = readers()?
            .get(directory)
            .and_then(|readers| readers.decoded.clone());
        if let Some(previous) = previous.filter(|previous| previous.reusable_for(&files)) {
            return Ok(Self {
                records: Arc::clone(&previous.records),
                _admission: admission,
            });
        }
        let records = Arc::new(decode_source_records(&entries)?);
        readers()?
            .entry(directory.to_path_buf())
            .or_default()
            .decoded = Some(Arc::new(DecodedRecords {
            files,
            records: Arc::clone(&records),
            observed_at,
        }));
        Ok(Self {
            records,
            _admission: admission,
        })
    }
}

struct ReadFlight {
    directory: PathBuf,
    snapshot: OnceLock<Result<Snapshot, String>>,
}

impl ReadFlight {
    fn join(directory: &Path) -> Result<Arc<Self>, String> {
        let mut readers = readers()?;
        readers.retain(|_, readers| readers.retained());
        let readers = readers.entry(directory.to_path_buf()).or_default();
        if let Some(flight) = readers.flight.upgrade() {
            // Close the cohort when preparation finishes. Later requests must
            // not perpetually extend an old transaction and starve writers.
            if flight.snapshot.get().is_none() {
                return Ok(flight);
            }
        }
        let flight = Arc::new(Self {
            directory: directory.to_path_buf(),
            snapshot: OnceLock::new(),
        });
        readers.flight = Arc::downgrade(&flight);
        Ok(flight)
    }

    fn snapshot(&self) -> Result<&Snapshot, String> {
        self.snapshot
            .get_or_init(|| Snapshot::load(&self.directory))
            .as_ref()
            .map_err(Clone::clone)
    }
}

/// Resolve an exact retired managed source through every durable completed
/// rehost edge. A pending edge fails closed so clients retry that operation
/// instead of guessing whether its destructive boundary was crossed.
pub fn resolve_managed_rehost_current(
    discovery_root: &Path,
    source_workspace_id: &str,
    source_session_id: &str,
) -> Result<ManagedRehostResolutionLookup, String> {
    if source_workspace_id.is_empty()
        || source_session_id.is_empty()
        || source_workspace_id.chars().any(char::is_control)
        || source_session_id.chars().any(char::is_control)
    {
        return Err(
            "hmux_managed_rehost_resolution_invalid: exact source identity is required".to_string(),
        );
    }
    let directory = discovery_root.join(".recovery");
    match fs::symlink_metadata(&directory) {
        Ok(_) => validate_existing_private_directory(&directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ManagedRehostResolutionLookup::NotFound);
        }
        Err(_) => {
            return Err("hmux_recovery_journal_invalid: directory is unreadable".to_string());
        }
    }
    let flight = ReadFlight::join(&directory)?;
    let snapshot = flight.snapshot()?;
    resolve_snapshot(
        &directory,
        &snapshot.records,
        source_workspace_id,
        source_session_id,
    )
}

fn resolve_snapshot(
    directory: &Path,
    records: &SourceRecords,
    source_workspace_id: &str,
    source_session_id: &str,
) -> Result<ManagedRehostResolutionLookup, String> {
    let mut key = (
        source_workspace_id.to_string(),
        source_session_id.to_string(),
    );
    let mut visited = BTreeSet::new();
    let mut resolution: Option<ManagedRehostResolution> = None;
    loop {
        if !visited.insert(key.clone()) {
            return Err(
                "hmux_managed_rehost_resolution_conflict: successor index contains a cycle"
                    .to_string(),
            );
        }
        let journal = rehost_record(records, &key)?;
        let edge =
            match managed_rehost_observation::direct_edge(directory, &key.0, &key.1, journal)? {
                ManagedRehostResolutionLookup::Resolved(edge) => *edge,
                ManagedRehostResolutionLookup::NotFound => break,
                pending @ ManagedRehostResolutionLookup::RetryRequired { .. } => {
                    return Ok(pending);
                }
            };
        if let Some(current) = resolution.as_mut() {
            current
                .append_resolution(&edge)
                .map_err(|error| format!("hmux_managed_rehost_resolution_invalid: {error}"))?;
        } else {
            resolution = Some(edge);
        }
        key = (
            resolution
                .as_ref()
                .expect("one edge initializes the resolution")
                .current_generation()
                .workspace_id()
                .to_string(),
            resolution
                .as_ref()
                .expect("one edge initializes the resolution")
                .current_generation()
                .session_id()
                .to_string(),
        );
    }
    let Some(resolution) = resolution else {
        return Ok(ManagedRehostResolutionLookup::NotFound);
    };
    resolution
        .validate()
        .map_err(|error| format!("hmux_managed_rehost_resolution_invalid: {error}"))?;
    Ok(ManagedRehostResolutionLookup::Resolved(Box::new(
        resolution,
    )))
}

fn rehost_record<'a>(
    records: &'a SourceRecords,
    key: &(String, String),
) -> Result<Option<&'a RecoveryRecord>, String> {
    let Some(candidates) = records.get(key) else {
        return Ok(None);
    };
    let mut completed = candidates
        .iter()
        .filter(|record| matches!(&record.state, RecoveryRecordState::Completed { .. }));
    if let Some(record) = completed.next() {
        if completed.next().is_none() {
            return Ok(Some(record));
        }
    } else if candidates.len() == 1 {
        return Ok(candidates.first());
    }
    Err(
        "hmux_managed_rehost_resolution_conflict: source has multiple authoritative operations"
            .to_string(),
    )
}
