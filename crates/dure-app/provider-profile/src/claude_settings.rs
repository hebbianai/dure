//! The one Claude settings document of a launch.
//!
//! Claude Code reads a single flag-settings document per launch: a second
//! `--settings` replaces the first instead of merging, and the hooks in the
//! first stop running. Every Dure-owned Claude setting of a launch is therefore
//! composed into one document: the managed hooks the runtime integration
//! publishes, the settings the launch selection contributes (such as
//! `ultracode`) and the per-project memory directory
//! ([`crate::claude_memory`]). A composition is an immutable owner-only file
//! named by its digest, which keeps settings contents out of argv and durable
//! command recipes.

use super::{create_or_require_owned_directory, lock_profile, typed_error};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// Compositions of a published settings document live beside it.
const COMPOSITIONS_DIRECTORY: &str = "claude-launch-settings";

fn error(detail: &str) -> String {
    typed_error("claude_settings_unavailable", detail)
}

/// Read a bounded, owned, single-link regular file that does not change while
/// it is read.
pub(crate) fn read_regular(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| error("cannot open memory or settings file"))?;
    let metadata = file
        .metadata()
        .map_err(|_| error("cannot inspect memory or settings file"))?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || metadata.len() > MAX_FILE_BYTES
    {
        return Err(error(
            "memory and settings must be bounded, owned, single-link files",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("cannot read memory or settings file"))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(error("file exceeds memory limit"));
    }
    let after = file
        .metadata()
        .map_err(|_| error("cannot recheck memory or settings file"))?;
    if super::FileGeneration::from(&metadata) != super::FileGeneration::from(&after)
        || bytes.len() as u64 != metadata.len()
    {
        return Err(error(
            "memory or settings changed during preparation; retry launch",
        ));
    }
    Ok(bytes)
}

/// Publish `bytes` at `path` once. An existing file must already hold exactly
/// these bytes, owner-only.
pub(crate) fn publish_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.mode() & 0o077 != 0 || read_regular(path)? != bytes {
                return Err(error("published Claude settings or memory changed"));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut transaction = super::OverlayTransaction::default();
            let mut fault = super::FaultInjection {
                fail_after: None,
                mutations: 0,
            };
            super::atomic_replace_regular_file(
                path,
                &mut transaction,
                &mut fault,
                |file| {
                    file.write_all(bytes)
                        .map_err(|_| error("cannot publish Claude settings or memory"))
                },
                || Ok(()),
            )?;
            transaction.commit()?;
        }
        Err(_) => return Err(error("cannot inspect published Claude settings or memory")),
    }
    Ok(())
}

fn object(bytes: &[u8]) -> Result<Map<String, Value>, String> {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| error("Claude launch settings must be a JSON object"))
}

fn digest_name(bytes: &[u8]) -> String {
    format!("{:x}.json", Sha256::digest(bytes))
}

/// Read one `--settings` value: an inline JSON object or a settings file.
pub fn read(value: &str) -> Result<Map<String, Value>, String> {
    if value.trim_start().starts_with('{') {
        object(value.as_bytes())
    } else {
        object(&read_regular(Path::new(value))?)
    }
}

/// Read a composition this module published, which is named by its digest.
pub(crate) fn read_published(path: &Path) -> Result<Map<String, Value>, String> {
    let bytes = read_regular(path)?;
    if path.file_name().and_then(|name| name.to_str()) != Some(digest_name(&bytes).as_str()) {
        return Err(error("published Claude settings changed"));
    }
    object(&bytes)
}

/// Publish `document` in `root`, named by its digest. The caller holds the lock
/// that serializes publications into `root`.
pub(crate) fn publish(root: &Path, document: &Map<String, Value>) -> Result<PathBuf, String> {
    let bytes =
        serde_json::to_vec(document).map_err(|_| error("cannot serialize Claude settings"))?;
    let path = root.join(digest_name(&bytes));
    publish_private_file(&path, &bytes)?;
    Ok(path)
}

/// Publish `document`, a composition of the settings file at `base`, beside
/// `base`. A launch passes the returned path as its one `--settings`.
pub fn publish_beside(base: &str, document: &Map<String, Value>) -> Result<String, String> {
    let directory = Path::new(base)
        .parent()
        .ok_or_else(|| error("Claude settings file has no directory"))?;
    let root = create_or_require_owned_directory(
        &directory.join(COMPOSITIONS_DIRECTORY),
        "Claude launch settings",
        0o700,
    )?;
    let _lock = lock_profile(&root, COMPOSITIONS_DIRECTORY)?;
    Ok(publish(&root, document)?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn managed_settings(directory: &Path) -> String {
        let path = directory.join("managed-claude-settings.json");
        fs::write(&path, br#"{"hooks":{"SessionStart":[{"hooks":[]}]}}"#).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn ultracode(base: &str) -> Map<String, Value> {
        let mut document = read(base).unwrap();
        document.insert("ultracode".into(), Value::Bool(true));
        document
    }

    #[test]
    fn a_composition_is_published_once_beside_its_base() {
        let root = tempfile::tempdir().unwrap();
        let base = managed_settings(root.path());
        let document = ultracode(&base);

        let composed = publish_beside(&base, &document).unwrap();
        let path = Path::new(&composed);
        assert_eq!(
            path.parent().unwrap(),
            root.path()
                .canonicalize()
                .unwrap()
                .join(COMPOSITIONS_DIRECTORY)
        );
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            Value::Object(read_published(path).unwrap()),
            serde_json::json!({
                "hooks": {"SessionStart": [{"hooks": []}]},
                "ultracode": true,
            })
        );
        // The same composition is the same immutable file.
        assert_eq!(publish_beside(&base, &document).unwrap(), composed);
    }

    #[test]
    fn a_changed_composition_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let base = managed_settings(root.path());
        let document = ultracode(&base);
        let composed = publish_beside(&base, &document).unwrap();
        fs::write(&composed, b"{}").unwrap();
        assert!(read_published(Path::new(&composed)).is_err());
        assert!(publish_beside(&base, &document).is_err());
    }
}
