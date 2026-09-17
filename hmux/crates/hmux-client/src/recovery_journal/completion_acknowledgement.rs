use super::{
    RecoveryIdentity, digest, ensure_private_directory, ensure_same_open_file,
    open_private_existing, open_private_new, private_directory_exists, private_path_exists,
    replace_private_file, sync_private_directory, valid_recovery_identity_fields,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub(super) const DIRECTORY_NAME: &str = ".completion-acknowledgements-v1";
const SCHEMA_VERSION: u16 = 1;
const SHARDS: usize = 256;
const MAX_SHARD_RECORDS: usize = 8_192;
const MAX_SHARD_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    recovery_id: String,
    source_session_id: String,
    source_workspace_id: String,
    request_fingerprint: String,
    action: String,
}

impl Record {
    fn new(identity: &RecoveryIdentity) -> Self {
        Self {
            recovery_id: identity.recovery_id.clone(),
            source_session_id: identity.source_session_id.clone(),
            source_workspace_id: identity.source_workspace_id.clone(),
            request_fingerprint: identity.request_fingerprint.clone(),
            action: identity.action.to_string(),
        }
    }

    fn validate(&self) -> Result<(), String> {
        if !valid_recovery_identity_fields(
            &self.recovery_id,
            &self.source_session_id,
            &self.source_workspace_id,
            &self.request_fingerprint,
            &self.action,
        ) {
            return Err("hmux_recovery_journal_invalid: acknowledgement is malformed".to_string());
        }
        Ok(())
    }

    fn validate_exact(&self, identity: &RecoveryIdentity) -> Result<(), String> {
        self.validate()?;
        if self.recovery_id != identity.recovery_id
            || self.source_session_id != identity.source_session_id
            || self.source_workspace_id != identity.source_workspace_id
            || self.request_fingerprint != identity.request_fingerprint
            || self.action != identity.action
        {
            return Err(
                "hmux_recovery_idempotency_conflict: recovery id belongs to another request"
                    .to_string(),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Shard {
    schema_version: u16,
    records: BTreeMap<String, Record>,
}

impl Default for Shard {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            records: BTreeMap::new(),
        }
    }
}

/// Checks one retired operation without creating acknowledgement storage.
pub(super) fn validate_exact(
    recovery_directory: &Path,
    identity: &RecoveryIdentity,
) -> Result<bool, String> {
    let Some(record) = lookup(recovery_directory, &identity.recovery_id)? else {
        return Ok(false);
    };
    record.validate_exact(identity)?;
    Ok(true)
}

pub(super) fn refuse_binding(
    recovery_directory: &Path,
    recovery_id: &str,
    source_session_id: &str,
    source_workspace_id: &str,
    request_fingerprint: Option<&str>,
    action: &str,
    acknowledged_code: &str,
) -> Result<(), String> {
    let Some(record) = lookup(recovery_directory, recovery_id)? else {
        return Ok(());
    };
    if record.recovery_id != recovery_id
        || record.source_session_id != source_session_id
        || record.source_workspace_id != source_workspace_id
        || request_fingerprint != Some(record.request_fingerprint.as_str())
        || record.action != action
    {
        return Err(
            "hmux_recovery_idempotency_conflict: recovery id belongs to another request"
                .to_string(),
        );
    }
    Err(format!(
        "{acknowledged_code}: operation completion was acknowledged"
    ))
}

/// Publishes an immutable stale-operation fence before the general journal
/// record is removed. The caller holds the journal admission lock, which is
/// the sole writer lock for every shard.
pub(super) fn publish(
    recovery_directory: &Path,
    identity: &RecoveryIdentity,
) -> Result<(), String> {
    publish_bounded(
        recovery_directory,
        identity,
        MAX_SHARD_RECORDS,
        MAX_SHARD_BYTES,
    )
}

fn publish_bounded(
    recovery_directory: &Path,
    identity: &RecoveryIdentity,
    maximum_records: usize,
    maximum_bytes: u64,
) -> Result<(), String> {
    Record::new(identity).validate()?;
    let directory = recovery_directory.join(DIRECTORY_NAME);
    ensure_private_directory(&directory)?;
    let key = digest(&identity.recovery_id);
    let index = shard_index(&key)?;
    let path = shard_path(&directory, index);
    let mut shard = read_shard_or_default(&path, index, maximum_records, maximum_bytes)?;
    if let Some(existing) = shard.records.get(&key) {
        return existing.validate_exact(identity);
    }
    if shard.records.len() >= maximum_records {
        return Err(format!(
            "hmux_recovery_acknowledgement_capacity: shard reached {maximum_records} retired operations"
        ));
    }
    shard.records.insert(key, Record::new(identity));
    write_shard(
        &directory,
        &path,
        index,
        &shard,
        maximum_records,
        maximum_bytes,
    )
}

fn lookup(recovery_directory: &Path, recovery_id: &str) -> Result<Option<Record>, String> {
    let directory = recovery_directory.join(DIRECTORY_NAME);
    if !private_directory_exists(&directory)? {
        return Ok(None);
    }
    let key = digest(recovery_id);
    let index = shard_index(&key)?;
    let path = shard_path(&directory, index);
    if !private_path_exists(&path)? {
        return Ok(None);
    }
    let shard = read_shard(&path, index, MAX_SHARD_RECORDS, MAX_SHARD_BYTES)?;
    Ok(shard.records.get(&key).cloned())
}

fn read_shard_or_default(
    path: &Path,
    index: usize,
    maximum_records: usize,
    maximum_bytes: u64,
) -> Result<Shard, String> {
    if private_path_exists(path)? {
        read_shard(path, index, maximum_records, maximum_bytes)
    } else {
        Ok(Shard::default())
    }
}

fn read_shard(
    path: &Path,
    index: usize,
    maximum_records: usize,
    maximum_bytes: u64,
) -> Result<Shard, String> {
    let file = open_private_existing(path, "acknowledgement shard")?;
    let metadata = file.metadata().map_err(|_| {
        "hmux_recovery_journal_invalid: acknowledgement shard is unreadable".to_string()
    })?;
    if metadata.len() > maximum_bytes {
        return Err("hmux_recovery_acknowledgement_capacity: shard is too large".to_string());
    }
    let mut payload = Vec::new();
    file.take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut payload)
        .map_err(|_| {
            "hmux_recovery_journal_invalid: acknowledgement shard is unreadable".to_string()
        })?;
    if payload.len() as u64 > maximum_bytes {
        return Err("hmux_recovery_acknowledgement_capacity: shard is too large".to_string());
    }
    let shard: Shard = serde_json::from_slice(&payload).map_err(|_| {
        "hmux_recovery_journal_invalid: acknowledgement shard is malformed".to_string()
    })?;
    validate_shard(&shard, index, maximum_records)?;
    Ok(shard)
}

fn validate_shard(shard: &Shard, index: usize, maximum_records: usize) -> Result<(), String> {
    if shard.schema_version != SCHEMA_VERSION || shard.records.len() > maximum_records {
        return Err(
            "hmux_recovery_journal_invalid: acknowledgement shard is malformed".to_string(),
        );
    }
    for (key, record) in &shard.records {
        record.validate()?;
        if key != &digest(&record.recovery_id) || shard_index(key)? != index {
            return Err(
                "hmux_recovery_journal_invalid: acknowledgement shard identity changed".to_string(),
            );
        }
    }
    Ok(())
}

fn write_shard(
    directory: &Path,
    path: &Path,
    index: usize,
    shard: &Shard,
    maximum_records: usize,
    maximum_bytes: u64,
) -> Result<(), String> {
    validate_shard(shard, index, maximum_records)?;
    let payload = serde_json::to_vec(shard).map_err(|_| {
        "hmux_recovery_journal_failed: acknowledgement shard serialization failed".to_string()
    })?;
    if payload.len() as u64 > maximum_bytes {
        return Err("hmux_recovery_acknowledgement_capacity: shard is too large".to_string());
    }
    let temporary = directory.join(format!(".shard_{index:02x}.tmp"));
    remove_stale_temporary(directory, &temporary)?;
    let result = (|| -> Result<(), String> {
        let mut file = open_private_new(&temporary)?;
        file.write_all(&payload).map_err(|_| {
            "hmux_recovery_journal_failed: acknowledgement shard write failed".to_string()
        })?;
        file.sync_all().map_err(|_| {
            "hmux_recovery_journal_failed: acknowledgement shard sync failed".to_string()
        })?;
        ensure_same_open_file(&temporary, &file)?;
        if private_path_exists(path)? {
            let existing = open_private_existing(path, "acknowledgement shard")?;
            ensure_same_open_file(path, &existing)?;
        }
        drop(file);
        replace_private_file(&temporary, path).map_err(|_| {
            "hmux_recovery_journal_failed: acknowledgement shard publish failed".to_string()
        })?;
        sync_private_directory(directory)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn remove_stale_temporary(directory: &Path, temporary: &Path) -> Result<(), String> {
    if !private_path_exists(temporary)? {
        return Ok(());
    }
    let stale = open_private_existing(temporary, "acknowledgement temporary shard")?;
    ensure_same_open_file(temporary, &stale)?;
    fs::remove_file(temporary).map_err(|_| {
        "hmux_recovery_journal_failed: stale acknowledgement temporary removal failed".to_string()
    })?;
    sync_private_directory(directory)
}

fn shard_path(directory: &Path, index: usize) -> PathBuf {
    directory.join(format!("shard_{index:02x}.json"))
}

fn shard_index(key: &str) -> Result<usize, String> {
    if key.len() != 32 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(
            "hmux_recovery_journal_invalid: acknowledgement digest is malformed".to_string(),
        );
    }
    let index = usize::from_str_radix(&key[..2], 16).map_err(|_| {
        "hmux_recovery_journal_invalid: acknowledgement digest is malformed".to_string()
    })?;
    if index >= SHARDS {
        return Err(
            "hmux_recovery_journal_invalid: acknowledgement shard is malformed".to_string(),
        );
    }
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recovery_journal::request_fingerprint;

    fn identity(recovery_id: impl Into<String>) -> RecoveryIdentity {
        RecoveryIdentity {
            recovery_id: recovery_id.into(),
            source_session_id: "source-session".to_string(),
            source_workspace_id: "source-workspace".to_string(),
            request_fingerprint: request_fingerprint(&["request"]),
            action: "test_action_v1",
        }
    }

    #[test]
    fn exact_fences_share_a_bounded_shard_and_refuse_overflow() {
        let state = tempfile::tempdir().unwrap();
        let recovery_directory = state.path().join(".recovery");
        ensure_private_directory(&recovery_directory).unwrap();
        let first = identity("first");
        let first_shard = shard_index(&digest(&first.recovery_id)).unwrap();
        let mut same_shard = (0..10_000)
            .map(|index| identity(format!("second-{index}")))
            .filter(|candidate| {
                shard_index(&digest(&candidate.recovery_id)).unwrap() == first_shard
            });
        let second = same_shard.next().unwrap();
        let overflow = same_shard.next().unwrap();

        publish_bounded(&recovery_directory, &first, 2, MAX_SHARD_BYTES).unwrap();
        publish_bounded(&recovery_directory, &second, 2, MAX_SHARD_BYTES).unwrap();
        assert!(validate_exact(&recovery_directory, &first).unwrap());
        assert!(validate_exact(&recovery_directory, &second).unwrap());
        assert_eq!(
            publish_bounded(&recovery_directory, &overflow, 2, MAX_SHARD_BYTES).unwrap_err(),
            "hmux_recovery_acknowledgement_capacity: shard reached 2 retired operations"
        );
        assert_eq!(
            fs::read_dir(recovery_directory.join(DIRECTORY_NAME))
                .unwrap()
                .count(),
            1,
            "many logical fences must not become one file per operation"
        );
    }
}
