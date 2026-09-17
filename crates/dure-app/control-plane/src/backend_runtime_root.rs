use std::fs::{self, DirBuilder};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt, symlink};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use super::{ControlPlaneError, assert_owner_directory};

const BACKEND_ALIAS_DIGEST_HEX: usize = 16;
const UNIX_SOCKET_PATH_LIMIT: usize = 100;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BackendRuntimeRoot {
    durable: PathBuf,
    address_alias: PathBuf,
}

impl BackendRuntimeRoot {
    pub(crate) fn durable(&self) -> &Path {
        &self.durable
    }

    pub(crate) fn address_for(&self, durable_path: &Path) -> Result<PathBuf, ControlPlaneError> {
        let relative = durable_path
            .strip_prefix(&self.durable)
            .map_err(|_| ControlPlaneError::Invalid("runtime path is outside the backend root"))?;
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(ControlPlaneError::Invalid("runtime path is invalid"));
        }
        self.ensure_alias()?;
        Ok(self.address_alias.join(relative))
    }

    /// The alias lives under the OS temp tree, which macOS reaps by age: a
    /// long-lived server whose alias was swept would hand out addresses whose
    /// symlink no longer exists, and every new runtime socket dies with
    /// ENOENT (the 2026-09-01 hmux socket outage was this class one layer
    /// down). Every address handout re-proves the alias instead of trusting
    /// the boot-time claim.
    fn ensure_alias(&self) -> Result<(), ControlPlaneError> {
        if let Some(parent) = self.address_alias.parent() {
            match DirBuilder::new().mode(0o700).create(parent) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        match symlink(&self.durable, &self.address_alias) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        if managed_alias_target(&self.address_alias)? != self.durable {
            return Err(ControlPlaneError::Invalid(
                "backend runtime alias conflicts with DURE_HOME",
            ));
        }
        Ok(())
    }

    pub(crate) fn control_plane_socket(
        &self,
        schema_version: u16,
        generation: &str,
    ) -> Result<PathBuf, ControlPlaneError> {
        let durable_socket = match schema_version {
            1 | 2 => self.durable.join("control-plane.sock"),
            3..=5 => generation_socket_path(&self.durable, generation),
            _ => {
                return Err(ControlPlaneError::Invalid(
                    "control-plane descriptor schema is unsupported",
                ));
            }
        };
        let socket = if schema_version == 5 {
            self.address_for(&durable_socket)?
        } else {
            durable_socket
        };
        if schema_version == 5 && socket.as_os_str().as_bytes().len() >= UNIX_SOCKET_PATH_LIMIT {
            return Err(ControlPlaneError::Invalid(
                "local socket path exceeds the Unix address budget",
            ));
        }
        Ok(socket)
    }
}

fn generation_socket_path(root: &Path, generation: &str) -> PathBuf {
    let digest = format!("{:x}", Sha256::digest(generation.as_bytes()));
    root.join(format!("cp.{}.sock", &digest[..32]))
}

fn runtime_root_for(uid: u32) -> PathBuf {
    Path::new("/tmp").join(format!("d.{uid}"))
}

fn runtime_root() -> PathBuf {
    runtime_root_for(unsafe { libc::geteuid() })
}

fn backend_alias_path(durable_root: &Path) -> PathBuf {
    let digest = format!("{:x}", Sha256::digest(durable_root.as_os_str().as_bytes()));
    runtime_root().join(format!("b.{}", &digest[..BACKEND_ALIAS_DIGEST_HEX]))
}

fn managed_alias_target(alias: &Path) -> Result<PathBuf, ControlPlaneError> {
    let expected_runtime_root = runtime_root();
    if alias.parent() != Some(expected_runtime_root.as_path()) {
        return Err(ControlPlaneError::Invalid(
            "backend runtime alias is invalid",
        ));
    }
    assert_owner_directory(&expected_runtime_root)?;
    let metadata = fs::symlink_metadata(alias)?;
    if !metadata.file_type().is_symlink() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(ControlPlaneError::Invalid(
            "backend runtime alias is invalid",
        ));
    }
    let target = fs::read_link(alias)?;
    if !target.is_absolute()
        || target.file_name().and_then(|name| name.to_str()) != Some("backend")
        || backend_alias_path(&target) != alias
    {
        return Err(ControlPlaneError::Invalid(
            "backend runtime alias is invalid",
        ));
    }
    assert_owner_directory(&target)?;
    Ok(target)
}

pub(crate) fn from_durable(root: &Path) -> Result<BackendRuntimeRoot, ControlPlaneError> {
    assert_owner_directory(root)?;
    Ok(BackendRuntimeRoot {
        durable: root.to_path_buf(),
        address_alias: backend_alias_path(root),
    })
}

pub(crate) fn resolve_socket_parent(
    parent: &Path,
) -> Result<BackendRuntimeRoot, ControlPlaneError> {
    match fs::symlink_metadata(parent) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let durable = managed_alias_target(parent)?;
            Ok(BackendRuntimeRoot {
                durable,
                address_alias: parent.to_path_buf(),
            })
        }
        Ok(_) if parent.file_name().and_then(|name| name.to_str()) == Some("backend") => {
            from_durable(parent)
        }
        Ok(_) => Err(ControlPlaneError::Invalid(
            "gateway endpoint identity is invalid",
        )),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn ensure(home: &Path) -> Result<BackendRuntimeRoot, ControlPlaneError> {
    if !home.is_absolute() {
        return Err(ControlPlaneError::Invalid("DURE_HOME must be absolute"));
    }
    let durable = home.join("backend");
    match fs::create_dir(&durable) {
        Ok(()) => fs::set_permissions(&durable, fs::Permissions::from_mode(0o700))?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    assert_owner_directory(&durable)?;

    let runtime_root = runtime_root();
    match DirBuilder::new().mode(0o700).create(&runtime_root) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    assert_owner_directory(&runtime_root)?;

    let address_alias = backend_alias_path(&durable);
    match symlink(&durable, &address_alias) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    if managed_alias_target(&address_alias)? != durable {
        return Err(ControlPlaneError::Invalid(
            "backend runtime alias conflicts with DURE_HOME",
        ));
    }
    Ok(BackendRuntimeRoot {
        durable,
        address_alias,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Red-first: macOS reaps the OS temp tree by age, so a long-lived
    /// server's alias can vanish mid-flight. Every address handout must
    /// re-prove the alias instead of trusting the boot-time claim.
    #[test]
    fn address_handout_recreates_a_reaped_alias() {
        let home = tempfile::tempdir().unwrap();
        let root = ensure(home.path()).unwrap();
        let alias = root.address_alias.clone();
        fs::remove_file(&alias).unwrap();

        let address = root
            .address_for(&root.durable().join("claude-structured/host"))
            .unwrap();
        assert!(alias.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(fs::read_link(&alias).unwrap(), root.durable());
        assert!(address.starts_with(&alias));
    }

    #[test]
    fn every_managed_socket_stays_below_the_shared_unix_budget() {
        // Worst-case-uid address arithmetic: address_for now re-proves the
        // alias on every handout, so the format is asserted directly instead
        // of through a root that cannot exist on disk.
        let alias = runtime_root_for(u32::MAX).join("b.0123456789abcdef");
        let digest = format!("{:x}", Sha256::digest("g".repeat(128).as_bytes()));
        let paths = [
            alias.join(format!("cp.{}.sock", &digest[..32])),
            alias.join("claude-structured/host/ch.0123456789abcdef/host.sock"),
            alias.join(format!(
                "claude-structured/relays/r.{}/relay.sock",
                "0".repeat(24)
            )),
            alias.join(format!(
                "codex-structured/r.{}/provider.sock",
                "0".repeat(24)
            )),
        ];

        for socket in paths {
            assert!(socket.as_os_str().as_bytes().len() < UNIX_SOCKET_PATH_LIMIT);
        }
    }

    #[test]
    fn durable_files_and_socket_addresses_have_distinct_roots() {
        let home = tempfile::Builder::new()
            .prefix("dure-runtime-root-")
            .tempdir_in("/tmp")
            .unwrap();
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = ensure(home.path()).unwrap();
        let durable_state = root.durable().join("claude-structured");
        fs::create_dir(&durable_state).unwrap();
        fs::set_permissions(&durable_state, fs::Permissions::from_mode(0o700)).unwrap();
        let address_state = root.address_for(&durable_state).unwrap();

        assert_eq!(root.durable(), home.path().join("backend"));
        assert_ne!(durable_state, address_state);
        assert_eq!(
            fs::canonicalize(&address_state).unwrap(),
            fs::canonicalize(&durable_state).unwrap()
        );
        assert_eq!(
            resolve_socket_parent(address_state.parent().unwrap()).unwrap(),
            root
        );

        fs::remove_file(address_state.parent().unwrap()).unwrap();
    }

    #[test]
    fn address_mapping_rejects_paths_outside_the_durable_root() {
        let root = BackendRuntimeRoot {
            durable: PathBuf::from("/state/backend"),
            address_alias: PathBuf::from("/tmp/d.1/b.0123456789abcdef"),
        };

        assert!(root.address_for(Path::new("/state/other/socket")).is_err());
        assert!(
            root.address_for(Path::new("/state/backend/../other/socket"))
                .is_err()
        );
    }
}
