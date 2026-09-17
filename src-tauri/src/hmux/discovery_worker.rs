//! Private reader helpers are staged beside the desktop by Tauri and shipped
//! in its signed bundle. Independent Host installs and overrides may be older.

use std::path::{Path, PathBuf};

pub(super) fn resolve(executable: &Path) -> Result<PathBuf, String> {
    let executable = executable.canonicalize().map_err(|error| {
        format!("hmux_discovery_worker_unavailable: desktop executable is unavailable: {error}")
    })?;
    let directory = executable
        .parent()
        .ok_or("hmux_discovery_worker_unavailable: desktop directory is unavailable")?;
    let worker = directory.join(format!("hmux-runtime{}", std::env::consts::EXE_SUFFIX));
    let valid = std::fs::symlink_metadata(&worker).is_ok_and(|metadata| {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    });
    if !valid {
        return Err(
            "hmux_discovery_worker_unavailable: the desktop's bundled reader is missing or invalid"
                .into(),
        );
    }
    Ok(worker)
}
