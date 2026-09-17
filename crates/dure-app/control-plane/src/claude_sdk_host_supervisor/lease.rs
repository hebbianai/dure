use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use hmux_client::{
    LocalProcessGenerationStatus, ProcessDescriptor, probe_local_process_generation,
};
use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub struct ClaudeSdkHostSupervisorError {
    reason: &'static str,
    /// Bounded spawn evidence, never part of the machine-matched reason code.
    detail: Option<String>,
}

impl ClaudeSdkHostSupervisorError {
    pub(super) fn contract(reason: &'static str) -> Self {
        Self {
            reason,
            detail: None,
        }
    }

    pub(super) fn with_detail(mut self, detail: Option<String>) -> Self {
        self.detail = detail;
        self
    }

    #[must_use]
    pub fn reason(&self) -> &'static str {
        self.reason
    }

    #[must_use]
    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }
}

impl fmt::Display for ClaudeSdkHostSupervisorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "dure_claude_sdk_host_supervisor_{}", self.reason)?;
        if let Some(detail) = &self.detail {
            write!(formatter, ": {detail}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ClaudeSdkHostSupervisorError {}

#[derive(Clone)]
pub struct ClaudeSdkHostLease {
    pub(super) capability: String,
    pub(super) endpoint: PathBuf,
    pub(super) host_generation: String,
    pub(super) process_id: u32,
}

impl ClaudeSdkHostLease {
    #[must_use]
    pub fn capability(&self) -> &str {
        &self.capability
    }
    #[must_use]
    pub fn endpoint(&self) -> &Path {
        &self.endpoint
    }
    #[must_use]
    pub fn host_generation(&self) -> &str {
        &self.host_generation
    }
    #[must_use]
    pub fn process_id(&self) -> u32 {
        self.process_id
    }
}

impl fmt::Debug for ClaudeSdkHostLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeSdkHostLease")
            .field("capability", &"<redacted>")
            .field("endpoint", &self.endpoint)
            .field("host_generation", &self.host_generation)
            .field("process_id", &self.process_id)
            .finish()
    }
}

/// The launch authority is durable; a controller only borrows this capability.
/// The OS generation proves absence before a successor may be published.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PublishedHost {
    schema_version: u32,
    capability: String,
    endpoint: PathBuf,
    host_generation: String,
    pub process: ProcessDescriptor,
    pub runtime_directory: PathBuf,
}

impl PublishedHost {
    pub fn new(
        lease: ClaudeSdkHostLease,
        process: ProcessDescriptor,
        runtime_directory: PathBuf,
    ) -> Self {
        Self {
            schema_version: 1,
            capability: lease.capability,
            endpoint: lease.endpoint,
            host_generation: lease.host_generation,
            process,
            runtime_directory,
        }
    }

    pub fn live(&self) -> Result<bool, ClaudeSdkHostSupervisorError> {
        process_is_live(&self.process)
    }

    pub fn lease(&self) -> ClaudeSdkHostLease {
        ClaudeSdkHostLease {
            capability: self.capability.clone(),
            endpoint: self.endpoint.clone(),
            host_generation: self.host_generation.clone(),
            process_id: self.process.process_id,
        }
    }
}

pub(super) fn process_is_live(
    process: &ProcessDescriptor,
) -> Result<bool, ClaudeSdkHostSupervisorError> {
    probe_local_process_generation(process)
        .map(|state| state == LocalProcessGenerationStatus::Live)
        .map_err(|_| ClaudeSdkHostSupervisorError::contract("host_observe_failed"))
}

/// Serializes only discovery/spawn publication, never conversation work.
pub(super) struct HostLaunchLock {
    _file: File,
    root: PathBuf,
}

impl HostLaunchLock {
    pub fn acquire(root: &Path) -> Result<Self, ClaudeSdkHostSupervisorError> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(root.join("host-launch.lock"))
            .map_err(|_| ClaudeSdkHostSupervisorError::contract("host_launch_lock_unavailable"))?;
        owner_file(&file)?;
        // SAFETY: the descriptor stays owned until this guard is dropped.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(ClaudeSdkHostSupervisorError::contract(
                "host_launch_lock_unavailable",
            ));
        }
        Ok(Self {
            _file: file,
            root: root.to_path_buf(),
        })
    }

    pub fn read(
        &self,
        address_root: &Path,
    ) -> Result<Option<PublishedHost>, ClaudeSdkHostSupervisorError> {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.root.join("current-host.json"))
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => {
                return Err(ClaudeSdkHostSupervisorError::contract(
                    "host_lease_unreadable",
                ));
            }
        };
        owner_file(&file)?;
        if file
            .metadata()
            .map_err(|_| ClaudeSdkHostSupervisorError::contract("host_lease_unreadable"))?
            .len()
            > 64 * 1024
        {
            return Err(ClaudeSdkHostSupervisorError::contract("host_lease_invalid"));
        }
        let host: PublishedHost = serde_json::from_reader(file)
            .map_err(|_| ClaudeSdkHostSupervisorError::contract("host_lease_invalid"))?;
        let name = host
            .runtime_directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if host.schema_version != 1
            || host.runtime_directory.parent() != Some(self.root.as_path())
            || !name.strip_prefix("ch.").is_some_and(|token| {
                token.len() == 16 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            || host.endpoint != address_root.join(name).join("host.sock")
            || host.capability.len() != 64
            || !host.capability.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !super::safe_token(&host.host_generation)
        {
            return Err(ClaudeSdkHostSupervisorError::contract("host_lease_invalid"));
        }
        Ok(Some(host))
    }

    pub fn publish(&self, host: &PublishedHost) -> Result<(), ClaudeSdkHostSupervisorError> {
        let staging = self
            .root
            .join(format!(".current-host.{}.tmp", super::random_hex::<8>()?));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&staging)
            .map_err(|_| ClaudeSdkHostSupervisorError::contract("host_lease_publish_failed"))?;
        let result = (|| {
            serde_json::to_writer(&mut file, host).map_err(std::io::Error::other)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            fs::rename(&staging, self.root.join("current-host.json"))?;
            File::open(&self.root)?.sync_all()
        })();
        if result.is_err() {
            let _ = fs::remove_file(&staging);
        }
        result.map_err(|_| ClaudeSdkHostSupervisorError::contract("host_lease_publish_failed"))
    }
}

fn owner_file(file: &File) -> Result<(), ClaudeSdkHostSupervisorError> {
    let metadata = file
        .metadata()
        .map_err(|_| ClaudeSdkHostSupervisorError::contract("host_lease_unreadable"))?;
    // SAFETY: geteuid only reads the caller's effective user identity.
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(ClaudeSdkHostSupervisorError::contract("host_lease_unsafe"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_client::exact_local_process_generation;

    fn fixture(root: &Path) -> PublishedHost {
        let process = exact_local_process_generation(std::process::id()).unwrap();
        let runtime_directory = root.join("ch.0123456789abcdef");
        PublishedHost::new(
            ClaudeSdkHostLease {
                capability: "a".repeat(64),
                endpoint: runtime_directory.join("host.sock"),
                host_generation: "independent-host-generation".into(),
                process_id: process.process_id,
            },
            process,
            runtime_directory,
        )
    }

    #[test]
    fn private_lease_round_trips_one_exact_native_generation() {
        let root = tempfile::tempdir().unwrap();
        let lock = HostLaunchLock::acquire(root.path()).unwrap();
        let original = fixture(root.path());
        lock.publish(&original).unwrap();
        let adopted = lock.read(root.path()).unwrap().unwrap();
        assert!(adopted.live().unwrap());
        assert_eq!(adopted.process, original.process);
        assert_eq!(adopted.lease().capability(), original.lease().capability());
        assert!(!format!("{:?}", adopted.lease()).contains(&"a".repeat(64)));
    }

    #[test]
    fn unsafe_or_retargeted_lease_never_becomes_an_adopted_handle() {
        let root = tempfile::tempdir().unwrap();
        let lock = HostLaunchLock::acquire(root.path()).unwrap();
        lock.publish(&fixture(root.path())).unwrap();
        assert!(lock.read(&root.path().join("another-backend")).is_err());
        let path = root.path().join("current-host.json");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(lock.read(root.path()).is_err());
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(root.path().join("missing"), &path).unwrap();
        assert!(lock.read(root.path()).is_err());
    }
}
