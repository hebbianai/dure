use super::{
    ensure_same_open_file, open_private_existing, open_private_new, private_path_exists,
    replace_private_file, sync_private_directory,
};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

/// Bounded private JSON shards published under their owner's existing writer
/// lock. Record shape, keys and lifecycle remain the caller's responsibility.
pub(super) fn read_or_default<T: Default + DeserializeOwned>(
    path: &Path,
    maximum_bytes: u64,
    context: &str,
) -> Result<T, String> {
    if !private_path_exists(path)? {
        return Ok(T::default());
    }
    let file = open_private_existing(path, "recovery index shard")?;
    let metadata = file
        .metadata()
        .map_err(|_| format!("{context}_invalid: shard is unreadable"))?;
    if metadata.len() > maximum_bytes {
        return Err(format!("{context}_capacity: shard is too large"));
    }
    let mut payload = Vec::new();
    file.take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut payload)
        .map_err(|_| format!("{context}_invalid: shard is unreadable"))?;
    if payload.len() as u64 > maximum_bytes {
        return Err(format!("{context}_capacity: shard is too large"));
    }
    serde_json::from_slice(&payload).map_err(|_| format!("{context}_invalid: shard is malformed"))
}

pub(super) fn write<T: Serialize>(
    directory: &Path,
    path: &Path,
    shard: &T,
    maximum_bytes: u64,
    context: &str,
) -> Result<(), String> {
    let payload = serde_json::to_vec(shard)
        .map_err(|_| format!("{context}_failed: shard serialization failed"))?;
    if payload.len() as u64 > maximum_bytes {
        return Err(format!("{context}_capacity: shard is too large"));
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("{context}_invalid: shard path is malformed"))?;
    let temporary = directory.join(format!(".{stem}.tmp"));
    if private_path_exists(&temporary)? {
        let stale = open_private_existing(&temporary, "recovery index temporary shard")?;
        ensure_same_open_file(&temporary, &stale)?;
        fs::remove_file(&temporary)
            .map_err(|_| format!("{context}_failed: stale temporary removal failed"))?;
        sync_private_directory(directory)?;
    }
    let write_result = (|| -> Result<(), String> {
        let mut file = open_private_new(&temporary)?;
        file.write_all(&payload)
            .map_err(|_| format!("{context}_failed: shard write failed"))?;
        file.sync_all()
            .map_err(|_| format!("{context}_failed: shard sync failed"))?;
        ensure_same_open_file(&temporary, &file)?;
        if private_path_exists(path)? {
            let existing = open_private_existing(path, "recovery index shard")?;
            ensure_same_open_file(path, &existing)?;
        }
        drop(file);
        replace_private_file(&temporary, path)
            .map_err(|_| format!("{context}_failed: shard publish failed"))?;
        sync_private_directory(directory)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}
