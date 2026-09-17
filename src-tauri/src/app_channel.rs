use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};

pub(crate) const APP_CHANNEL_ENV: &str = "DURE_APP_CHANNEL";
pub(crate) const LEGACY_APP_CHANNEL_ENV: &str = "HEBBIAN_APP_CHANNEL";
const STABLE_CHANNEL: &str = "stable";
const MAX_CHANNEL_BYTES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppChannel {
    pub(crate) name: String,
    pub(crate) app_root: PathBuf,
    pub(crate) control_dir: PathBuf,
}

pub(crate) fn current() -> io::Result<AppChannel> {
    let name = current_name()?;
    let (app_root, _) = crate::app_home::app_root_resolution().map_err(io::Error::other)?;
    let control_dir = control_dir_for(&app_root, &name);
    ensure_control_dir(&control_dir, &name)?;
    Ok(AppChannel {
        name,
        app_root,
        control_dir,
    })
}

pub(crate) fn current_name() -> io::Result<String> {
    Ok(configured_name()?.unwrap_or_else(|| STABLE_CHANNEL.to_string()))
}

pub(crate) fn configured_name() -> io::Result<Option<String>> {
    let canonical = std::env::var_os(APP_CHANNEL_ENV);
    let legacy = std::env::var_os(LEGACY_APP_CHANNEL_ENV);
    crate::worktree_release::resolve_channel(resolve_configured_name(
        canonical.as_deref(), legacy.as_deref(),
    )?)
}

fn resolve_configured_name(
    canonical: Option<&OsStr>,
    legacy: Option<&OsStr>,
) -> io::Result<Option<String>> {
    canonical
        .or(legacy)
        .map(|value| parse_channel(Some(value)))
        .transpose()
}

fn ensure_control_dir(path: &Path, channel: &str) -> io::Result<()> {
    if channel == STABLE_CHANNEL {
        // Stable writes directly below the canonical app root. The resolver
        // never redirects this write to the legacy migration input.
        ensure_stable_control_dir(path)?;
        ensure_isolated_control_dir(&path.join("channels"))?;
    } else {
        let channels_root = path
            .parent()
            .ok_or_else(|| io::Error::other("isolated app channel has no channels directory"))?;
        ensure_isolated_control_dir(channels_root)?;
        ensure_isolated_control_dir(path)?;
    }
    Ok(())
}

fn ensure_stable_control_dir(path: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

        // Preserve existing stable symlink routing without changing its target's
        // permissions. The backend retains its own symlink admission boundary.
        if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Ok(());
        }
        // Tighten only the opened, current-user-owned directory, never its files
        // or a symlink substituted after observation.
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(path)?;
        if directory.metadata()?.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "stable app root is not owned by the current user",
            ));
        }
        directory.set_permissions(std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn parse_channel(value: Option<&OsStr>) -> io::Result<String> {
    let Some(value) = value else {
        return Ok(STABLE_CHANNEL.to_string());
    };
    let value = value
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "app channel is not UTF-8"))?;
    if value.is_empty()
        || value.len() > MAX_CHANNEL_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "app channel must be a lowercase filesystem-safe token",
        ));
    }
    Ok(value.to_string())
}

pub(crate) fn control_dir_for(root: &Path, channel: &str) -> PathBuf {
    if channel == STABLE_CHANNEL {
        root.to_path_buf()
    } else {
        root.join("channels").join(channel)
    }
}

fn ensure_isolated_control_dir(path: &Path) -> io::Result<()> {
    if path.symlink_metadata().is_ok_and(|metadata| {
        metadata.file_type().is_symlink() || !metadata.is_dir()
    }) {
        return Err(io::Error::other(
            "refusing a symlinked or non-directory app channel",
        ));
    }
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{control_dir_for, parse_channel, resolve_configured_name};
    #[cfg(unix)]
    use super::ensure_control_dir;
    use std::ffi::OsStr;
    use std::path::Path;

    #[test]
    fn canonical_dure_channel_wins_over_the_legacy_input() {
        assert_eq!(
            resolve_configured_name(
                Some(OsStr::new("dev-canonical-a1b2c3d4")),
                Some(OsStr::new("dev-legacy-decoy-a1b2c3d4")),
            )
            .unwrap()
            .as_deref(),
            Some("dev-canonical-a1b2c3d4")
        );
        assert_eq!(
            resolve_configured_name(None, Some(OsStr::new("dev-legacy-a1b2c3d4")))
                .unwrap()
                .as_deref(),
            Some("dev-legacy-a1b2c3d4")
        );
        assert!(resolve_configured_name(
            Some(OsStr::new("../invalid")),
            Some(OsStr::new("dev-legacy-a1b2c3d4")),
        )
        .is_err());
    }

    #[test]
    fn stable_channel_uses_the_canonical_control_directory() {
        assert_eq!(
            control_dir_for(Path::new("/Users/test"), "stable"),
            Path::new("/Users/test"),
        );
        assert_eq!(parse_channel(None).unwrap(), "stable");
    }

    #[test]
    fn development_channels_are_namespaced_below_the_control_root() {
        assert_eq!(
            control_dir_for(Path::new("/Users/test/.dure"), "dev-feature-a1b2c3d4"),
            Path::new("/Users/test/.dure/channels/dev-feature-a1b2c3d4"),
        );
        assert_eq!(
            parse_channel(Some(OsStr::new("dev-feature-a1b2c3d4"))).unwrap(),
            "dev-feature-a1b2c3d4",
        );
    }

    #[cfg(unix)]
    #[test]
    fn every_channel_makes_the_shared_channels_root_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "hebbian-app-channel-owner-only-{}",
            std::process::id()
        ));
        let channel = root.join("channels").join("dev-owner-only-a1b2c3d4");
        ensure_control_dir(&channel, "dev-owner-only-a1b2c3d4").unwrap();
        assert_eq!(
            std::fs::metadata(root.join("channels"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&channel).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let stable_root = root.with_extension("stable");
        ensure_control_dir(&stable_root, "stable").unwrap();
        assert_eq!(
            std::fs::metadata(stable_root.join("channels"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(stable_root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stable_channel_creates_an_owner_only_backend_root() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "dure-stable-private-root-{}", std::process::id()
        ));
        ensure_control_dir(&root, "stable").unwrap();
        assert_eq!(std::fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stable_channel_repairs_its_owned_root_without_changing_user_files() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "dure-stable-existing-root-{}", std::process::id()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        let document = root.join("retained-user-data");
        std::fs::write(&document, b"keep this exact content").unwrap();
        std::fs::set_permissions(&document, std::fs::Permissions::from_mode(0o640)).unwrap();

        ensure_control_dir(&root, "stable").unwrap();

        assert_eq!(std::fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::read(&document).unwrap(), b"keep this exact content");
        assert_eq!(std::fs::metadata(&document).unwrap().permissions().mode() & 0o777, 0o640);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stable_channel_rejects_a_file_without_replacing_it() {
        let root = std::env::temp_dir().join(format!(
            "dure-stable-file-root-{}", std::process::id()
        ));
        std::fs::write(&root, b"not a directory").unwrap();
        assert!(ensure_control_dir(&root, "stable").is_err());
        assert_eq!(std::fs::read(&root).unwrap(), b"not a directory");
        std::fs::remove_file(root).unwrap();
    }

    #[test]
    fn invalid_channel_names_fail_before_path_construction() {
        for value in ["", "../stable", "Dev-main", "dev/main", "dev_main"] {
            assert!(parse_channel(Some(OsStr::new(value))).is_err(), "{value}");
        }
        assert!(parse_channel(Some(OsStr::new(&"x".repeat(65)))).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn stable_channel_keeps_legacy_directory_symlink_compatibility() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        use std::time::{SystemTime, UNIX_EPOCH};

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hebbian-app-channel-{}-{suffix}",
            std::process::id()
        ));
        let target = root.join("control-target");
        let link = root.join("control-link");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o750)).unwrap();
        symlink(&target, &link).unwrap();

        ensure_control_dir(&link, "stable").unwrap();

        assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o750);
        assert_eq!(std::fs::read_link(&link).unwrap(), target);
        std::fs::remove_dir_all(root).unwrap();
    }
}
