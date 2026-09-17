//! The recorded choice and the install id on disk — `telemetry.json` in the
//! app channel's control directory (honours `DURE_HOME`; a dev channel keeps
//! its own), one small versioned document written atomically. The
//! same hygiene as plugin settings: no symlinks, a size cap, temp-and-rename,
//! owner-only permissions.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use super::consent::Choice;

const FILE_NAME: &str = "telemetry.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_BYTES: u64 = 4096;

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Stored {
    /// Minted on the first Accept, never before: an install that never opted
    /// in has no identifier to leak.
    pub(crate) install_id: Option<String>,
    pub(crate) choice: Option<Choice>,
    pub(crate) decided_at_ms: Option<u64>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Document {
    schema_version: u32,
    #[serde(flatten)]
    stored: Stored,
}

pub(crate) struct Store {
    path: PathBuf,
}

impl Store {
    pub(crate) fn in_directory(directory: &Path) -> Self {
        Self {
            path: directory.join(FILE_NAME),
        }
    }

    /// A missing file is the fresh-install state. Anything unreadable is an
    /// error the caller treats as "no choice": it never becomes permission.
    pub(crate) fn read(&self) -> Result<Stored, String> {
        let metadata = match std::fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Stored::default());
            }
            Err(error) => return Err(error.to_string()),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("telemetry state path is not a regular file".into());
        }
        if metadata.len() > MAX_BYTES {
            return Err("telemetry state file exceeds the size limit".into());
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        std::fs::File::open(&self.path)
            .map_err(|error| error.to_string())?
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("telemetry state file exceeds the size limit".into());
        }
        let document: Document =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if document.schema_version != SCHEMA_VERSION {
            return Err("telemetry state document version is not supported".into());
        }
        Ok(document.stored)
    }

    pub(crate) fn write(&self, stored: &Stored) -> Result<(), String> {
        let directory = self
            .path
            .parent()
            .ok_or_else(|| "telemetry state path has no directory".to_string())?;
        std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        if std::fs::symlink_metadata(&self.path)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err("telemetry state path cannot be a symlink".into());
        }
        let document = Document {
            schema_version: SCHEMA_VERSION,
            stored: stored.clone(),
        };
        let mut bytes = serde_json::to_vec_pretty(&document).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        // A fresh random temp name each time (owner-only, 0o600): a temp left
        // behind by a crashed process can never block a later write.
        let mut temporary = tempfile::Builder::new()
            .prefix(&format!(".{FILE_NAME}."))
            .suffix(".tmp")
            .tempfile_in(directory)
            .map_err(|error| error.to_string())?;
        temporary
            .as_file_mut()
            .write_all(&bytes)
            .map_err(|error| error.to_string())?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        temporary
            .persist(&self.path)
            .map(|_| ())
            .map_err(|error| error.error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_is_the_fresh_install_state() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::in_directory(&directory.path().join("nested"));
        assert_eq!(store.read().unwrap(), Stored::default());
    }

    #[test]
    fn round_trips_the_document_and_creates_the_directory() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::in_directory(&directory.path().join("nested"));
        let stored = Stored {
            install_id: Some("0123456789abcdef0123456789abcdef".into()),
            choice: Some(Choice::Accepted),
            decided_at_ms: Some(1_758_000_000_000),
        };
        store.write(&stored).unwrap();
        assert_eq!(store.read().unwrap(), stored);
        let text = std::fs::read_to_string(directory.path().join("nested").join(FILE_NAME)).unwrap();
        assert!(text.contains("\"schema_version\": 1"), "{text}");
        assert!(text.contains("\"choice\": \"accepted\""), "{text}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(directory.path().join("nested").join(FILE_NAME))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(std::fs::read_dir(directory.path().join("nested"))
            .unwrap()
            .all(|entry| entry.unwrap().file_name() == FILE_NAME));
    }

    #[test]
    fn refuses_unsupported_versions_oversized_files_and_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::in_directory(directory.path());
        let path = directory.path().join(FILE_NAME);

        std::fs::write(&path, "{\"schema_version\": 2}\n").unwrap();
        assert!(store.read().unwrap_err().contains("version"));

        std::fs::write(&path, "x".repeat(MAX_BYTES as usize + 1)).unwrap();
        assert!(store.read().unwrap_err().contains("size limit"));

        std::fs::write(&path, "not json").unwrap();
        assert!(store.read().is_err());

        #[cfg(unix)]
        {
            let target = directory.path().join("elsewhere.json");
            std::fs::write(&target, "{\"schema_version\": 1}\n").unwrap();
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(&target, &path).unwrap();
            assert!(store.read().unwrap_err().contains("regular file"));
            assert!(store.write(&Stored::default()).unwrap_err().contains("symlink"));
        }
    }
}
