//! Where this phone keeps its device configuration.
//!
//! On iOS the configuration directory — paired computers, SSH servers and
//! their keys, remembered layouts, the alert-action mirror — lives in the App
//! Group container the app shares with its notification service extension.
//! The extension runs when an alert arrives and no app does: it reads the
//! paired computer the alert names from here to ask it who and what the
//! alert is about (`alert_content`).
//!
//! # Why the whole directory moves
//!
//! Not a copy of the paired-computer store beside the original. A device
//! reset renames this one directory as one snapshot change
//! (`device_reset`); a second copy of a device token would outlive that
//! reset, and two copies drift the first time one write lands and the other
//! does not.

use std::path::{Path, PathBuf};

/// The App Group the app and its notification service extension share. Both
/// targets' entitlements name the same group.
pub const APP_GROUP: &str = "group.dev.hebbian.ide.mobile";

/// The configuration directory to use, given the app's own (`own`) and the
/// shared one (`shared`, absent without the group entitlement).
///
/// The first time the group is there, `own` is renamed into it: one
/// filesystem operation, so a configuration is never half moved. If that
/// rename fails, `own` stays where it was and is used; the extension then
/// finds nothing and alerts keep their generic text.
pub fn adopt(own: PathBuf, shared: Option<PathBuf>) -> PathBuf {
    let Some(shared) = shared else {
        return own;
    };
    // Moved before: whatever is left at `own` is not this device's state.
    if shared.exists() || !own.exists() {
        return shared;
    }
    match move_into(&own, &shared) {
        Ok(()) => shared,
        Err(error) => {
            eprintln!("Keeping the device configuration in the app's own folder: {error}");
            own
        }
    }
}

fn move_into(own: &Path, shared: &Path) -> std::io::Result<()> {
    if let Some(parent) = shared.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(own, shared)
}

/// The shared configuration directory, `config` in the group container,
/// where that container exists.
#[cfg(target_os = "ios")]
pub fn shared_root() -> Option<PathBuf> {
    use objc2_foundation::{NSFileManager, NSString};
    let container = NSFileManager::defaultManager()
        .containerURLForSecurityApplicationGroupIdentifier(&NSString::from_str(APP_GROUP))?;
    Some(PathBuf::from(container.path()?.to_string()).join("config"))
}

/// The app's configuration directory for `own`, the folder the platform
/// gives the app. Decided once per launch, so the move runs before any store
/// is read and every caller sees the same directory.
#[cfg(target_os = "ios")]
pub fn config_root(own: PathBuf) -> PathBuf {
    static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| adopt(own, shared_root())).clone()
}

/// Other platforms have no extension to share with.
#[cfg(not(target_os = "ios"))]
pub fn config_root(own: PathBuf) -> PathBuf {
    own
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn seeded(root: &Path) {
        fs::create_dir_all(root.join("identities")).unwrap();
        fs::write(root.join("hubs.json"), b"paired computers").unwrap();
        fs::write(root.join("identities/server.attach.key"), b"private key").unwrap();
    }

    #[test]
    fn the_configuration_moves_into_the_group_once_and_whole() {
        let directory = tempfile::tempdir().unwrap();
        let own = directory.path().join("app/dev.hebbian.ide.mobile");
        let shared = directory.path().join("group/config");
        seeded(&own);

        assert_eq!(adopt(own.clone(), Some(shared.clone())), shared);
        assert!(!own.exists());
        assert_eq!(
            fs::read(shared.join("hubs.json")).unwrap(),
            b"paired computers"
        );
        assert_eq!(
            fs::read(shared.join("identities/server.attach.key")).unwrap(),
            b"private key"
        );

        // Moved before: a folder left at the old place is not adopted again.
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join("hubs.json"), b"stale").unwrap();
        assert_eq!(adopt(own.clone(), Some(shared.clone())), shared);
        assert_eq!(
            fs::read(shared.join("hubs.json")).unwrap(),
            b"paired computers"
        );
    }

    #[test]
    fn a_fresh_install_starts_in_the_group_and_no_group_keeps_the_own_folder() {
        let directory = tempfile::tempdir().unwrap();
        let own = directory.path().join("app/dev.hebbian.ide.mobile");
        let shared = directory.path().join("group/config");
        assert_eq!(adopt(own.clone(), Some(shared.clone())), shared);

        seeded(&own);
        assert_eq!(adopt(own.clone(), None), own);
        assert!(own.join("hubs.json").exists());
    }

    #[test]
    fn a_move_that_fails_keeps_the_configuration_where_it_was() {
        let directory = tempfile::tempdir().unwrap();
        let own = directory.path().join("app/dev.hebbian.ide.mobile");
        seeded(&own);
        // The group's parent is a file, so the directory cannot be made there.
        let blocked = directory.path().join("group");
        fs::write(&blocked, b"not a directory").unwrap();

        assert_eq!(adopt(own.clone(), Some(blocked.join("config"))), own);
        assert_eq!(
            fs::read(own.join("hubs.json")).unwrap(),
            b"paired computers"
        );
    }
}
