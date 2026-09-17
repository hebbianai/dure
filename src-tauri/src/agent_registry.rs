use fs2::FileExt;
use std::ffi::OsString;
#[cfg(unix)]
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_REGISTRY_BYTES: usize = 16 * 1024 * 1024;

struct PublicationPaths {
    lock: PathBuf,
    temporary: PathBuf,
    backup: PathBuf,
}

fn sidecar_path(destination: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "agent registry destination has no parent".to_string())?;
    let file_name = destination
        .file_name()
        .ok_or_else(|| "agent registry destination has no file name".to_string())?;
    let mut sidecar = OsString::from(".");
    sidecar.push(file_name);
    sidecar.push(suffix);
    Ok(parent.join(sidecar))
}

fn publication_paths(destination: &Path) -> Result<PublicationPaths, String> {
    Ok(PublicationPaths {
        lock: sidecar_path(destination, ".lock")?,
        temporary: sidecar_path(destination, ".pending")?,
        backup: sidecar_path(destination, ".backup")?,
    })
}

fn owner_only_options(_options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        _options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
}

#[cfg(unix)]
fn replace_file(temporary: &Path, destination: &Path, _backup: &Path) -> Result<(), String> {
    std::fs::rename(temporary, destination).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn replace_file(temporary: &Path, destination: &Path, backup: &Path) -> Result<(), String> {
    if !destination.exists() {
        return std::fs::rename(temporary, destination).map_err(|error| error.to_string());
    }
    let _ = std::fs::remove_file(backup);
    std::fs::rename(destination, backup).map_err(|error| error.to_string())?;
    match std::fs::rename(temporary, destination) {
        Ok(()) => {
            std::fs::remove_file(backup).map_err(|error| error.to_string())?;
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::rename(backup, destination);
            Err(error.to_string())
        }
    }
}

fn recover_interrupted_replacement(destination: &Path, backup: &Path) -> Result<(), String> {
    let destination_exists = destination
        .try_exists()
        .map_err(|error| error.to_string())?;
    let backup_exists = backup.try_exists().map_err(|error| error.to_string())?;
    match (destination_exists, backup_exists) {
        (false, true) => std::fs::rename(backup, destination).map_err(|error| error.to_string()),
        (true, true) => std::fs::remove_file(backup).map_err(|error| error.to_string()),
        _ => Ok(()),
    }
}

fn open_publication_lock(path: &Path) -> Result<std::fs::File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    owner_only_options(&mut options);
    let lock = options
        .open(path)
        .map_err(|error| format!("agent registry lock is unavailable: {error}"))?;
    lock.lock_exclusive()
        .map_err(|error| format!("agent registry lock failed: {error}"))?;
    Ok(lock)
}

pub(crate) fn recover(destination: &Path) -> Result<(), String> {
    let paths = publication_paths(destination)?;
    let _lock = open_publication_lock(&paths.lock)?;
    recover_interrupted_replacement(destination, &paths.backup)
        .map_err(|error| format!("agent registry recovery failed: {error}"))
}

pub(crate) fn publish_guarded(
    destination: &Path,
    json: &str,
    before_replace: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if json.is_empty() || json.len() > MAX_REGISTRY_BYTES {
        return Err("agent registry JSON is empty or exceeds its byte bound".to_string());
    }
    let parsed: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "agent registry JSON is malformed".to_string())?;
    if !parsed.is_object() {
        return Err("agent registry JSON must be an object".to_string());
    }
    let paths = publication_paths(destination)?;
    #[cfg(unix)]
    let parent = destination
        .parent()
        .ok_or_else(|| "agent registry destination has no parent".to_string())?;
    let _lock = open_publication_lock(&paths.lock)?;
    let result = (|| {
        recover_interrupted_replacement(destination, &paths.backup)?;
        match std::fs::remove_file(&paths.temporary) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        owner_only_options(&mut options);
        let mut file = options
            .open(&paths.temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(json.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        before_replace()?;
        replace_file(&paths.temporary, destination, &paths.backup)?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&paths.temporary);
    }
    result.map_err(|error| format!("agent registry publication failed: {error}"))
}

pub(crate) fn publish(destination: &Path, json: &str) -> Result<(), String> {
    publish_guarded(destination, json, || Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = r#"{"version":3,"agents":[{"id":"old"}]}"#;
    const NEW: &str = r#"{"version":3,"agents":[{"id":"new"}]}"#;

    #[test]
    fn destination_stays_complete_until_atomic_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("agents.json");
        std::fs::write(&destination, OLD).unwrap();

        publish_guarded(&destination, NEW, || {
            assert_eq!(std::fs::read_to_string(&destination).unwrap(), OLD);
            Ok(())
        })
        .unwrap();

        assert_eq!(std::fs::read_to_string(&destination).unwrap(), NEW);
        assert!(!publication_paths(&destination).unwrap().temporary.exists());
    }

    #[test]
    fn failed_replacement_preserves_the_previous_registry() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("agents.json");
        std::fs::write(&destination, OLD).unwrap();

        let error =
            publish_guarded(&destination, NEW, || Err("fault_before_replace".into())).unwrap_err();

        assert!(error.contains("fault_before_replace"));
        assert_eq!(std::fs::read_to_string(&destination).unwrap(), OLD);
        assert!(!publication_paths(&destination).unwrap().temporary.exists());
    }

    #[test]
    fn refuses_empty_malformed_and_non_object_publications() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("agents.json");

        for invalid in ["", "{", "[]"] {
            assert!(publish(&destination, invalid).is_err());
            assert!(!destination.exists());
        }
    }

    #[test]
    fn publication_artifacts_are_scoped_to_the_destination() {
        let directory = tempfile::tempdir().unwrap();
        let agents = publication_paths(&directory.path().join("agents.json")).unwrap();
        let credentials =
            publication_paths(&directory.path().join("ssh-credential-registry.json")).unwrap();

        assert_ne!(agents.lock, credentials.lock);
        assert_ne!(agents.temporary, credentials.temporary);
        assert_ne!(agents.backup, credentials.backup);
    }

    #[test]
    fn recovery_restores_a_destination_specific_backup() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("ssh-credential-registry.json");
        let paths = publication_paths(&destination).unwrap();
        std::fs::write(&paths.backup, OLD).unwrap();

        recover(&destination).unwrap();

        assert_eq!(std::fs::read_to_string(destination).unwrap(), OLD);
        assert!(!paths.backup.exists());
    }

    #[cfg(unix)]
    #[test]
    fn publication_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("agents.json");
        publish(&destination, NEW).unwrap();

        assert_eq!(
            std::fs::metadata(destination).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
