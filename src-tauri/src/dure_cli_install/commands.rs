use std::path::{Path, PathBuf};

use super::{canonicalize_optional, channel_install_root, validate_executable_file};

pub(super) fn startup_bundle(channel: &str, resource_dir: &Path) -> Option<PathBuf> {
    (channel == "stable" && cfg!(target_os = "macos"))
        .then(|| resource_dir.join("resources/dure-cli/current"))
}

pub(crate) fn resolve_channel_dure_payload(
    channel: &str,
    home: &Path,
) -> Result<Option<PathBuf>, String> {
    let install_root = channel_install_root(channel, home);
    let command = install_root.join("current").join("bin").join("dure");
    let Some(canonical_root) = canonicalize_optional(&install_root, "Dure CLI install root")?
    else {
        return Ok(None);
    };
    let Some(canonical_command) = canonicalize_optional(&command, "Dure CLI command")? else {
        return Ok(None);
    };
    if !canonical_command.starts_with(canonical_root.join("versions")) {
        return Err("Dure CLI command escaped its immutable channel install".to_string());
    }
    validate_executable_file(&canonical_command, "channel-pinned Dure CLI")?;
    Ok(Some(canonical_command))
}

/// Resolve the companion from the same immutable installation as the CLI.
/// PATH and another version's companion cannot select the hook runtime.
#[cfg(unix)]
pub(crate) fn resolve_control_plane_companion(
    channel: &str,
    home: &Path,
    resource_dir: &Path,
) -> Result<PathBuf, String> {
    // Stable startup installs the CLI asynchronously. The same bundle that
    // owns that bootstrap already contains this companion, so publication does
    // not race first installation or select an older installed generation.
    if let Some(bundle) = startup_bundle(channel, resource_dir) {
        return bundled_companion(&bundle);
    }
    let payload = resolve_channel_dure_payload(channel, home)?
        .ok_or_else(|| "managed provider runtime is not installed".to_string())?;
    let directory = payload
        .parent()
        .ok_or_else(|| "managed provider runtime has no install directory".to_string())?;
    companion_in(directory)
}

/// The app bundle carries exactly one CLI version behind `current`, and an app
/// update replaces the whole bundle while this process keeps running until it
/// restarts. Validate the version `current` selects now, then name the
/// companion through `current` so published hooks follow the installed bundle
/// rather than a version directory the update removed.
#[cfg(unix)]
fn bundled_companion(current: &Path) -> Result<PathBuf, String> {
    const UNAVAILABLE: &str = "bundled managed provider runtime is unavailable";
    let root = current
        .parent()
        .and_then(|root| root.canonicalize().ok())
        .ok_or_else(|| UNAVAILABLE.to_string())?;
    let current = root.join("current");
    let directory = current
        .join("bin")
        .canonicalize()
        .map_err(|_| UNAVAILABLE.to_string())?;
    if !directory.starts_with(root.join("versions")) {
        return Err("bundled managed provider runtime escaped its app bundle".to_string());
    }
    companion_in(&directory)?;
    Ok(current.join("bin").join("dure-control-plane"))
}

#[cfg(unix)]
fn companion_in(directory: &Path) -> Result<PathBuf, String> {
    let expected = directory.join("dure-control-plane");
    let command = canonicalize_optional(&expected, "managed provider runtime")?
        .ok_or_else(|| "managed provider runtime is not installed".to_string())?;
    if command != expected {
        return Err(
            "managed provider runtime escaped its immutable CLI installation".to_string(),
        );
    }
    validate_executable_file(&command, "managed provider runtime")?;
    Ok(command)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
    };

    /// Stage the bundle layout `install-dure-cli.mjs --bundle` produces: one
    /// version directory selected by a relative `current` symlink.
    #[cfg(target_os = "macos")]
    fn stage_bundled_cli(resources: &Path, version: &str) -> PathBuf {
        let root = resources.join("resources/dure-cli");
        let _ = fs::remove_dir_all(root.join("versions"));
        let _ = fs::remove_file(root.join("current"));
        let bin = root.join("versions").join(version).join("bin");
        fs::create_dir_all(&bin).unwrap();
        let companion = bin.join("dure-control-plane");
        fs::write(
            &companion,
            format!("#!/bin/sh\n/usr/bin/printf '%s' '{version}'\n"),
        )
        .unwrap();
        fs::set_permissions(&companion, fs::Permissions::from_mode(0o700)).unwrap();
        symlink(format!("versions/{version}"), root.join("current")).unwrap();
        companion
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn first_stable_launch_uses_the_bundle_before_any_cli_is_installed() {
        let home = tempfile::tempdir().unwrap();
        let resources = tempfile::tempdir().unwrap();
        let companion = stage_bundled_cli(resources.path(), "0.1.0+fixture");
        let resolved =
            resolve_control_plane_companion("stable", home.path(), resources.path()).unwrap();
        assert_eq!(
            resolved.canonicalize().unwrap(),
            companion.canonicalize().unwrap()
        );
        assert!(fs::read_dir(home.path()).unwrap().next().is_none());
        assert!(resolve_control_plane_companion("dev-fixture", home.path(), resources.path()).is_err());
        fs::remove_file(&companion).unwrap();
        assert!(resolve_control_plane_companion("stable", home.path(), resources.path()).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stable_companion_follows_an_in_place_bundle_update() {
        let home = tempfile::tempdir().unwrap();
        let resources = tempfile::tempdir().unwrap();
        stage_bundled_cli(resources.path(), "0.1.0+old");
        let published =
            resolve_control_plane_companion("stable", home.path(), resources.path()).unwrap();
        let root = resources
            .path()
            .join("resources/dure-cli")
            .canonicalize()
            .unwrap();
        assert_eq!(published, root.join("current/bin/dure-control-plane"));

        // An app update replaces the bundle, and with it the only version
        // directory, while the publishing app keeps running until restart.
        stage_bundled_cli(resources.path(), "0.1.1+new");
        assert!(!root.join("versions/0.1.0+old").exists());
        let output = std::process::Command::new(&published).output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"0.1.1+new");

        let outside = tempfile::tempdir().unwrap();
        let foreign = outside.path().join("bin");
        fs::create_dir_all(&foreign).unwrap();
        fs::copy(
            root.join("current/bin/dure-control-plane"),
            foreign.join("dure-control-plane"),
        )
        .unwrap();
        fs::remove_file(root.join("current")).unwrap();
        symlink(outside.path(), root.join("current")).unwrap();
        assert!(
            resolve_control_plane_companion("stable", home.path(), resources.path())
                .unwrap_err()
                .contains("escaped")
        );
    }

    #[test]
    fn native_companion_must_be_executable_in_the_same_immutable_version() {
        let home = tempfile::tempdir().unwrap();
        let channel = "dev-hook-fixture";
        let root = channel_install_root(channel, home.path());
        let bin = root.join("versions/fixture/bin");
        fs::create_dir_all(&bin).unwrap();
        symlink("versions/fixture", root.join("current")).unwrap();
        for name in ["dure", "dure-control-plane"] {
            let executable = bin.join(name);
            fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
            fs::set_permissions(executable, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let companion = bin.join("dure-control-plane");
        assert_eq!(
            resolve_control_plane_companion(channel, home.path(), home.path()).unwrap(),
            companion.canonicalize().unwrap()
        );
        fs::set_permissions(&companion, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            resolve_control_plane_companion(channel, home.path(), home.path())
                .unwrap_err()
                .contains("not executable")
        );
        fs::remove_file(&companion).unwrap();
        assert!(
            resolve_control_plane_companion(channel, home.path(), home.path())
                .unwrap_err()
                .contains("not installed")
        );
        symlink(bin.join("dure"), &companion).unwrap();
        assert!(
            resolve_control_plane_companion(channel, home.path(), home.path())
                .unwrap_err()
                .contains("escaped")
        );
    }
}
