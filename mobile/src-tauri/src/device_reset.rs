//! One authoritative reset for device-local connection state.
//!
//! The configuration directory contains the SSH server inventory, its private
//! keys, paired Hub tokens, and remembered Hub layouts. Renaming that directory
//! makes the visible transition from the complete old snapshot to no snapshot
//! one filesystem operation; deleting each store in turn would expose a
//! half-reset device when a later delete fails.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

const QUARANTINE_SUFFIX: &str = ".device-reset";
static CONFIG_MUTATION_LOCK: Mutex<()> = Mutex::new(());
static CONFIG_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
pub(crate) struct ConfigGeneration(u64);

#[derive(Debug)]
pub enum DeviceResetError {
    InvalidConfigRoot,
    MutationSuperseded,
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl std::fmt::Display for DeviceResetError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfigRoot => formatter.write_str("the app config directory has no name"),
            Self::MutationSuperseded => {
                formatter.write_str("device configuration was reset during this operation")
            }
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl std::error::Error for DeviceResetError {}

impl DeviceResetError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidConfigRoot => "device_reset_invalid_config_root",
            Self::MutationSuperseded => "device_reset_superseded_mutation",
            Self::Io { .. } => "device_reset_io",
        }
    }
}

pub(crate) fn current_generation() -> ConfigGeneration {
    ConfigGeneration(CONFIG_GENERATION.load(Ordering::Acquire))
}

pub(crate) fn mutation_guard(
    generation: ConfigGeneration,
) -> Result<MutexGuard<'static, ()>, DeviceResetError> {
    let guard = config_guard();
    if generation.0 == CONFIG_GENERATION.load(Ordering::Acquire) {
        Ok(guard)
    } else {
        Err(DeviceResetError::MutationSuperseded)
    }
}

/// Removes all device-local connection state as one visible snapshot change.
///
/// A failed cleanup leaves only the quarantined snapshot. The ordinary store
/// paths already read as empty, and the next call finishes removing that
/// quarantine before attempting another reset.
pub fn reset(config_root: &Path) -> Result<(), DeviceResetError> {
    let _guard = config_guard();
    let quarantine = quarantine_path(config_root)?;
    remove_snapshot(&quarantine)?;

    let result = match fs::rename(config_root, &quarantine) {
        Ok(()) => remove_snapshot(&quarantine),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(DeviceResetError::Io {
            operation: "quarantine device configuration",
            source,
        }),
    };
    CONFIG_GENERATION.fetch_add(1, Ordering::AcqRel);
    result
}

fn config_guard() -> MutexGuard<'static, ()> {
    match CONFIG_MUTATION_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn quarantine_path(config_root: &Path) -> Result<PathBuf, DeviceResetError> {
    let mut name: OsString = config_root
        .file_name()
        .ok_or(DeviceResetError::InvalidConfigRoot)?
        .to_os_string();
    name.push(QUARANTINE_SUFFIX);
    Ok(config_root.with_file_name(name))
}

fn remove_snapshot(path: &Path) -> Result<(), DeviceResetError> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(DeviceResetError::Io {
            operation: "delete quarantined device configuration",
            source,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reset_removes_the_complete_device_snapshot() {
        // Given
        let directory = tempfile::tempdir().expect("tempdir");
        let root = directory.path().join("dev.hebbian.ide.mobile");
        fs::create_dir_all(root.join("identities")).expect("create identities");
        for relative in [
            "servers.json",
            "hubs.json",
            "layouts.json",
            "identities/server.attach.key",
        ] {
            fs::write(root.join(relative), b"private device state").expect("seed state");
        }

        // When
        reset(&root).expect("reset device");

        // Then
        assert!(!root.exists());
        assert!(!quarantine_path(&root).expect("quarantine path").exists());
    }

    #[test]
    fn reset_finishes_cleanup_left_by_an_interrupted_reset() {
        // Given
        let directory = tempfile::tempdir().expect("tempdir");
        let root = directory.path().join("dev.hebbian.ide.mobile");
        let quarantine = quarantine_path(&root).expect("quarantine path");
        fs::create_dir_all(quarantine.join("identities")).expect("create quarantine");
        fs::write(
            quarantine.join("identities/server.attach.key"),
            b"private key",
        )
        .expect("seed interrupted reset");

        // When
        reset(&root).expect("finish reset");

        // Then
        assert!(!quarantine.exists());
        assert!(!root.exists());
    }

    #[test]
    fn a_mutation_started_before_reset_cannot_recreate_device_state() {
        // Given
        let directory = tempfile::tempdir().expect("tempdir");
        let root = directory.path().join("dev.hebbian.ide.mobile");
        fs::create_dir_all(&root).expect("create config root");
        let generation = current_generation();
        let writer_root = root.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (continue_tx, continue_rx) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            started_tx.send(()).expect("announce writer");
            continue_rx.recv().expect("resume writer");
            let guard = mutation_guard(generation)?;
            fs::write(writer_root.join("servers.json"), b"late state")
                .expect("write permitted state");
            drop(guard);
            Ok::<(), DeviceResetError>(())
        });
        started_rx.recv().expect("writer started");

        // When
        reset(&root).expect("reset device");
        continue_tx.send(()).expect("resume writer");
        let result = writer.join().expect("join writer");

        // Then
        assert!(matches!(result, Err(DeviceResetError::MutationSuperseded)));
        assert!(!root.exists());
    }
}
