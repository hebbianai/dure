//! Which key belongs to which paired device, so revocation is a command.
//!
//! Losing a phone is the case this file answers. Without it, revocation is
//! "ssh into each box and grep for a key you have to recognise by sight", which
//! is not an answer — it is slow at exactly the moment speed matters, it scales
//! with the fleet, and it silently misses the server the owner forgot about.
//!
//! So every pairing records the exact `authorized_keys` line it wrote and the
//! exact list of hosts it wrote it to. `hmux pair revoke <device>` then removes
//! that byte-identical line from those hosts and reports each one.
//!
//! Hosts that *failed* to install are recorded too, with their failure. A phone
//! that reached three of four servers must still be revocable from all four,
//! because "the install failed" and "the install failed silently after
//! succeeding" are indistinguishable from the laptop a week later — and the
//! cost of attempting a removal that finds nothing is one wasted ssh.
//!
//! Nothing secret is stored: a public key, a fingerprint, and host coordinates
//! the desktop app already holds. The file is still written 0600 in a 0700
//! directory, because it is a map of which device can reach which server.

use crate::CliError;
use fs2::FileExt as _;
use hmux_client::online_pairing::pairing_time_remaining;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Overrides where paired-device records live. Set by the tests.
pub(crate) const REGISTRY_PATH_ENV: &str = "HMUX_PAIRING_DEVICES";

const REGISTRY_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct PairedHostRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) user: String,
    pub(crate) auth: String,
    pub(crate) key_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) ssh_config_alias: Option<String>,
    /// Endpoint identity observed by the exact SSH process before mutation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) host_key_fingerprint: Option<String>,
    pub(crate) this_laptop: bool,
    pub(crate) installed: bool,
    pub(crate) failure: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct PairedDevice {
    pub(crate) device_id: String,
    pub(crate) device_name: String,
    pub(crate) fingerprint: String,
    /// The exact line written, so removal never has to guess or pattern-match.
    pub(crate) authorized_keys_entry: String,
    pub(crate) paired_at_unix_ms: u64,
    pub(crate) hosts: Vec<PairedHostRecord>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct RegistryFile {
    version: u32,
    #[serde(default)]
    devices: Vec<PairedDevice>,
}

#[derive(Debug)]
pub(crate) struct DeviceRegistry {
    path: PathBuf,
    devices: Vec<PairedDevice>,
}

/// Exclusive ownership of every destructive pairing/revoke transition.
///
/// The separate lock inode survives atomic registry replacement. Keeping this
/// value alive prevents another process from loading a stale whole-file
/// snapshot until the current fleet mutation and its final record are done.
#[derive(Debug)]
pub(crate) struct DeviceRegistryLease {
    registry: DeviceRegistry,
    _lock: File,
}

impl Deref for DeviceRegistryLease {
    type Target = DeviceRegistry;

    fn deref(&self) -> &Self::Target {
        &self.registry
    }
}

impl DeviceRegistry {
    pub(crate) fn default_path() -> Result<PathBuf, CliError> {
        if let Some(explicit) = std::env::var_os(REGISTRY_PATH_ENV) {
            return Ok(PathBuf::from(explicit));
        }
        let home = dirs::home_dir().ok_or_else(|| {
            CliError("pairing could not resolve a home directory for its device registry".into())
        })?;
        Ok(home.join(".hmux").join("paired-devices.json"))
    }

    pub(crate) fn load(path: PathBuf) -> Result<Self, CliError> {
        let path = absolute_registry_path(path)?;
        let devices = match std::fs::read(&path) {
            Ok(raw) => {
                let file: RegistryFile = serde_json::from_slice(&raw).map_err(|error| {
                    CliError(format!(
                        "the paired-device registry at {} is unreadable: {error}. \
                         Move it aside to start a new one; pairing refuses to overwrite \
                         a record of which devices can reach which servers.",
                        path.display()
                    ))
                })?;
                if file.version != REGISTRY_VERSION {
                    return Err(CliError(format!(
                        "the paired-device registry at {} is version {} rather than {REGISTRY_VERSION}",
                        path.display(),
                        file.version
                    )));
                }
                file.devices
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(CliError(format!(
                    "could not read the paired-device registry at {}: {error}",
                    path.display()
                )));
            }
        };
        Ok(Self { path, devices })
    }

    pub(crate) fn acquire(
        path: PathBuf,
        deadline: Option<Instant>,
    ) -> Result<DeviceRegistryLease, CliError> {
        let path = absolute_registry_path(path)?;
        registry_directory(&path)?;
        let lock_path = append_suffix(&path, ".lock");
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|error| {
                CliError(format!(
                    "could not open the paired-device registry lock at {}: {error}",
                    lock_path.display()
                ))
            })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = lock.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        let acquired = match deadline {
            None => lock.lock_exclusive(),
            Some(deadline) => loop {
                let remaining =
                    pairing_time_remaining(deadline).map_err(|code| CliError(code.to_owned()))?;
                match lock.try_lock_exclusive() {
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(remaining.min(Duration::from_millis(10)));
                    }
                    result => break result,
                }
            },
        };
        acquired.map_err(|error| {
            CliError(format!(
                "could not lock the paired-device registry at {}: {error}",
                path.display()
            ))
        })?;
        let registry = Self::load(path)?;
        Ok(DeviceRegistryLease {
            registry,
            _lock: lock,
        })
    }

    pub(crate) fn devices(&self) -> &[PairedDevice] {
        &self.devices
    }

    /// Finds a device by exact id, unique id prefix, or exact name.
    ///
    /// An ambiguous prefix is an error rather than a first match: revoking the
    /// wrong phone is a silent lockout of a device the owner still has.
    pub(crate) fn find(&self, selector: &str) -> Result<&PairedDevice, CliError> {
        let matches: Vec<&PairedDevice> = self
            .devices
            .iter()
            .filter(|device| {
                device.device_id == selector
                    || device.device_name == selector
                    || device.device_id.starts_with(selector)
            })
            .collect();
        match matches.as_slice() {
            [single] => Ok(single),
            [] => Err(CliError(format!(
                "no paired device matches '{selector}'; `hmux pair list` shows what is paired"
            ))),
            several => Err(CliError(format!(
                "'{selector}' matches {} paired devices; use a full device id",
                several.len()
            ))),
        }
    }

    /// Writes the registry atomically, 0600 in a 0700 directory.
    fn write(&self, devices: &[PairedDevice]) -> Result<(), CliError> {
        let directory = registry_directory(&self.path)?;
        let encoded = serde_json::to_vec_pretty(&RegistryFile {
            version: REGISTRY_VERSION,
            devices: devices.to_vec(),
        })
        .map_err(|error| CliError(format!("could not encode the device registry: {error}")))?;
        let temporary = append_suffix(&self.path, ".tmp");
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| {
                CliError(format!("could not write {}: {error}", temporary.display()))
            })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|error| {
                    CliError(format!("could not secure {}: {error}", temporary.display()))
                })?;
        }
        file.write_all(&encoded).map_err(|error| {
            CliError(format!("could not write {}: {error}", temporary.display()))
        })?;
        file.sync_all().map_err(|error| {
            CliError(format!("could not sync {}: {error}", temporary.display()))
        })?;
        drop(file);
        std::fs::rename(&temporary, &self.path).map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            CliError(format!("could not update {}: {error}", self.path.display()))
        })?;
        sync_directory(&directory)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl DeviceRegistryLease {
    /// Replaces one device in memory only after the complete file is durable.
    pub(crate) fn persist(&mut self, device: &PairedDevice) -> Result<(), CliError> {
        let mut devices = self.registry.devices.clone();
        devices.retain(|existing| existing.device_id != device.device_id);
        devices.push(device.clone());
        self.registry.write(&devices)?;
        self.registry.devices = devices;
        Ok(())
    }

    /// Removes one device in memory only after the complete file is durable.
    pub(crate) fn forget(&mut self, device_id: &str) -> Result<(), CliError> {
        let mut devices = self.registry.devices.clone();
        devices.retain(|device| device.device_id != device_id);
        self.registry.write(&devices)?;
        self.registry.devices = devices;
        Ok(())
    }
}

fn registry_directory(path: &Path) -> Result<PathBuf, CliError> {
    let directory = path
        .parent()
        .ok_or_else(|| CliError("the device registry path has no parent".into()))?;
    #[cfg(unix)]
    let mut missing = Vec::new();
    #[cfg(unix)]
    {
        let mut candidate = directory;
        while !candidate.exists() {
            missing.push(candidate.to_path_buf());
            candidate = candidate.parent().ok_or_else(|| {
                CliError(format!(
                    "could not resolve an existing parent for {}",
                    directory.display()
                ))
            })?;
        }
    }
    std::fs::create_dir_all(directory)
        .map_err(|error| CliError(format!("could not create {}: {error}", directory.display())))?;
    #[cfg(unix)]
    for created in missing.iter().rev() {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(created, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| CliError(format!("could not secure {}: {error}", created.display())),
        )?;
        if let Some(parent) = created.parent() {
            sync_directory(parent)?;
        }
    }
    Ok(directory.to_path_buf())
}

fn absolute_registry_path(path: PathBuf) -> Result<PathBuf, CliError> {
    if path.is_absolute() {
        return Ok(path);
    }
    std::env::current_dir()
        .map(|directory| directory.join(path))
        .map_err(|error| {
            CliError(format!(
                "could not resolve the device registry path: {error}"
            ))
        })
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut suffixed = path.as_os_str().to_os_string();
    suffixed.push(suffix);
    PathBuf::from(suffixed)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), CliError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| CliError(format!("could not sync {}: {error}", path.display())))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), CliError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str, name: &str) -> PairedDevice {
        PairedDevice {
            device_id: id.into(),
            device_name: name.into(),
            fingerprint: "SHA256:abc".into(),
            authorized_keys_entry: "command=\"x\",restrict ssh-ed25519 AAAA hmux-pairing:x".into(),
            paired_at_unix_ms: 0,
            hosts: Vec::new(),
        }
    }

    #[test]
    fn a_recorded_device_survives_a_reload() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested").join("paired-devices.json");
        let mut registry = DeviceRegistry::acquire(path.clone(), None).unwrap();
        registry.persist(&device("d1", "kattpish phone")).unwrap();
        drop(registry);

        let reloaded = DeviceRegistry::load(path).unwrap();
        assert_eq!(reloaded.devices().len(), 1);
        assert_eq!(reloaded.find("d1").unwrap().device_name, "kattpish phone");
        assert_eq!(reloaded.find("kattpish phone").unwrap().device_id, "d1");
    }

    #[test]
    fn a_registry_from_before_endpoint_pins_still_loads() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("paired-devices.json");
        std::fs::write(
            &path,
            br#"{
                "version": 1,
                "devices": [{
                    "device_id": "legacy",
                    "device_name": "old phone",
                    "fingerprint": "SHA256:abc",
                    "authorized_keys_entry": "ssh-ed25519 AAAA old",
                    "paired_at_unix_ms": 0,
                    "hosts": [{
                        "id": "build",
                        "name": "build",
                        "host": "build.example",
                        "port": 22,
                        "user": "builder",
                        "auth": "key",
                        "key_path": null,
                        "this_laptop": false,
                        "installed": true,
                        "failure": null
                    }]
                }]
            }"#,
        )
        .unwrap();

        let registry = DeviceRegistry::load(path).unwrap();
        let host = &registry.find("legacy").unwrap().hosts[0];
        assert_eq!(host.ssh_config_alias, None);
        assert_eq!(host.host_key_fingerprint, None);
    }

    #[test]
    fn an_ambiguous_selector_refuses_rather_than_revoking_the_first_match() {
        let directory = tempfile::tempdir().unwrap();
        let mut registry = DeviceRegistry::acquire(directory.path().join("r.json"), None).unwrap();
        registry.persist(&device("dev-a", "one")).unwrap();
        registry.persist(&device("dev-b", "two")).unwrap();
        let error = registry.find("dev").unwrap_err();
        assert!(error.0.contains("matches 2 paired devices"), "{}", error.0);
    }

    #[test]
    fn a_failed_write_does_not_change_the_in_memory_registry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("paired-devices.json");
        let mut registry = DeviceRegistry::acquire(path.clone(), None).unwrap();
        std::fs::create_dir(&path).unwrap();

        registry.persist(&device("d1", "phone")).unwrap_err();

        assert!(registry.devices().is_empty());
    }

    #[test]
    fn one_lease_excludes_another_registry_writer() {
        use fs2::FileExt as _;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("paired-devices.json");
        let lease = DeviceRegistry::acquire(path.clone(), None).unwrap();
        let contender = OpenOptions::new()
            .read(true)
            .write(true)
            .open(append_suffix(&path, ".lock"))
            .unwrap();

        assert!(contender.try_lock_exclusive().is_err());
        drop(lease);
        contender.try_lock_exclusive().unwrap();
        fs2::FileExt::unlock(&contender).unwrap();
    }

    #[test]
    fn lock_and_staging_paths_append_without_replacing_registry_extensions() {
        assert_eq!(
            append_suffix(Path::new("devices.lock"), ".lock"),
            PathBuf::from("devices.lock.lock")
        );
        assert_eq!(
            append_suffix(Path::new("devices.tmp"), ".tmp"),
            PathBuf::from("devices.tmp.tmp")
        );
    }

    #[test]
    fn relative_registry_paths_resolve_before_missing_parents_are_created() {
        assert_eq!(
            absolute_registry_path(PathBuf::from("state/devices.json")).unwrap(),
            std::env::current_dir()
                .unwrap()
                .join("state")
                .join("devices.json")
        );
    }

    #[test]
    fn a_corrupt_registry_is_refused_rather_than_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("r.json");
        std::fs::write(&path, b"{not json").unwrap();
        let error = DeviceRegistry::load(path).unwrap_err();
        assert!(error.0.contains("refuses to overwrite"), "{}", error.0);
    }
}
