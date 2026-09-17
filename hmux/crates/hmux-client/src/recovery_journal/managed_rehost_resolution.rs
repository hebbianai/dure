//! Concurrent successor readers share one admission-fenced journal snapshot.
//! The snapshot is a read transaction, not a retained cache: its shared file
//! lock fences legacy and current writers until the last admitted reader exits.

use super::*;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

#[cfg(test)]
mod tests;

struct Snapshot {
    records: BTreeMap<(String, String), Vec<RecoveryRecord>>,
    _admission: RecoveryLock,
}

impl Snapshot {
    fn load(directory: &Path) -> Result<Self, String> {
        let file = open_private_lock(&directory.join(ADMISSION_LOCK_NAME))?;
        FileExt::lock_shared(&file)
            .map_err(|_| "hmux_recovery_journal_failed: read admission lock failed".to_string())?;
        let admission = RecoveryLock { file };
        let mut records = BTreeMap::new();
        for entry in scan_journal(directory, true)? {
            let Some(record) = entry.record else { continue };
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
            records.entry(key).or_insert_with(Vec::new).push(record);
        }
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
        static READERS: OnceLock<Mutex<BTreeMap<PathBuf, Weak<ReadFlight>>>> = OnceLock::new();
        let mut readers = READERS.get_or_init(Mutex::default).lock().map_err(|_| {
            "hmux_recovery_journal_failed: reader admission is poisoned".to_string()
        })?;
        readers.retain(|_, flight| flight.strong_count() > 0);
        if let Some(flight) = readers.get(directory).and_then(Weak::upgrade) {
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
        readers.insert(directory.to_path_buf(), Arc::downgrade(&flight));
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
    records: &BTreeMap<(String, String), Vec<RecoveryRecord>>,
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
    records: &'a BTreeMap<(String, String), Vec<RecoveryRecord>>,
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
