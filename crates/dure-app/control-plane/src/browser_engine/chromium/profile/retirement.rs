//! A durable retirement occupies the native claim name before stored data is removed.
use super::*;
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::os::fd::AsRawFd;

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetirementClaim {
    schema_version: u32,
    kind: RetirementKind,
    profile_id: BrowserProfileIdV1,
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum RetirementKind {
    StorageRetirement,
}

fn lock(file: &File) -> Result<(), BrowserEngineError> {
    // This lock coordinates retirement attempts only. Native startup is fenced
    // by the same exclusive claim pathname, including after a process crash.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        Ok(())
    } else {
        Err(BrowserEngineError::before(
            "browser_profile_deletion_in_progress",
        ))
    }
}

fn claim(root: &Path, id: &BrowserProfileIdV1) -> Result<File, BrowserEngineError> {
    let error = |_| BrowserEngineError::before("browser_profile_storage_unavailable");
    let path = root.join("native-claim.json");
    let expected = RetirementClaim {
        schema_version: 1,
        kind: RetirementKind::StorageRetirement,
        profile_id: id.clone(),
    };
    let mut staged = tempfile::NamedTempFile::new_in(root).map_err(error)?;
    staged
        .write_all(
            &serde_json::to_vec(&expected)
                .map_err(|_| BrowserEngineError::before("browser_profile_storage_unavailable"))?,
        )
        .map_err(error)?;
    staged.as_file().sync_all().map_err(error)?;
    lock(staged.as_file())?;
    let mut file = match staged.persist_noclobber(&path) {
        Ok(file) => file,
        Err(failure) if failure.error.kind() == std::io::ErrorKind::AlreadyExists => {
            drop(failure);
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&path)
                .map_err(error)?;
            lock(&file)?;
            file
        }
        Err(_) => {
            return Err(BrowserEngineError::before(
                "browser_profile_storage_unavailable",
            ));
        }
    };
    let metadata = file.metadata().map_err(error)?;
    let current = fs::symlink_metadata(&path).map_err(error)?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || !current.is_file()
        || metadata.dev() != current.dev()
        || metadata.ino() != current.ino()
    {
        return Err(BrowserEngineError::before(
            "browser_profile_storage_unavailable",
        ));
    }
    file.seek(SeekFrom::Start(0)).map_err(error)?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() > 4096
        || serde_json::from_slice::<RetirementClaim>(&bytes)
            .ok()
            .as_ref()
            != Some(&expected)
    {
        // A native or malformed claim is not evidence that its process exited.
        return Err(BrowserEngineError::before(
            "browser_profile_exit_unconfirmed",
        ));
    }
    File::open(root)
        .and_then(|root| root.sync_all())
        .map_err(error)?;
    Ok(file)
}

/// The catalog must be Retiring and every retained native owner closed first.
/// The permanent claim also fences a stale startup admitted by another backend.
pub(crate) fn retire_storage(
    directory: &Path,
    id: &BrowserProfileIdV1,
) -> Result<(), BrowserEngineError> {
    let root = storage_root(directory, id)?;
    let retained = claim(&root, id)?;
    let error = |_| BrowserEngineError::after("browser_profile_storage_retirement_unconfirmed");
    for entry in fs::read_dir(&root).map_err(error)? {
        let entry = entry.map_err(error)?;
        if entry.file_name() == "native-claim.json" {
            continue;
        }
        if entry.file_type().map_err(error)?.is_dir() {
            // std's removal unlinks nested symlinks; it does not follow them.
            fs::remove_dir_all(entry.path()).map_err(error)?;
        } else {
            fs::remove_file(entry.path()).map_err(error)?;
        }
    }
    let owned = retained.metadata().map_err(error)?;
    let current = fs::symlink_metadata(root.join("native-claim.json")).map_err(error)?;
    if !current.is_file() || owned.dev() != current.dev() || owned.ino() != current.ino() {
        return Err(BrowserEngineError::after(
            "browser_profile_storage_retirement_unconfirmed",
        ));
    }
    File::open(&root)
        .and_then(|root| root.sync_all())
        .map_err(error)?;
    Ok(())
}

#[cfg(test)]
mod tests;
