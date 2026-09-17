//! Owner-only rendezvous sockets shared by managed provider process drivers.

use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::Path;
use tokio::net::UnixListener;

pub(crate) fn validate_socket_target(path: &Path) -> Result<(), &'static str> {
    if !path.is_absolute() || fs::symlink_metadata(path).is_ok() {
        return Err("socket_target_invalid");
    }
    let parent = path.parent().ok_or("socket_parent_invalid")?;
    let metadata = fs::symlink_metadata(parent).map_err(|_| "socket_parent_invalid")?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err("socket_parent_unsafe");
    }
    Ok(())
}

pub(crate) fn bind_endpoint(path: &Path) -> Result<UnixListener, &'static str> {
    let listener = UnixListener::bind(path).map_err(|_| "endpoint_bind_failed")?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "endpoint_permissions_failed")?;
    Ok(listener)
}

pub(crate) fn cleanup_socket(path: &Path) {
    if fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.file_type().is_socket() && metadata.uid() == unsafe { libc::geteuid() }
    }) {
        let _ = fs::remove_file(path);
    }
}
