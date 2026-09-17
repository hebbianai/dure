//! A durable claim prevents reopening storage after an unconfirmed process exit.
//! A claim is never PID/liveness evidence and never authorizes adopting a browser.
use super::*;
use dure_app::BrowserProfileIdV1;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

mod retirement;
pub(crate) use retirement::retire_storage;

fn storage_root(directory: &Path, id: &BrowserProfileIdV1) -> Result<PathBuf, BrowserEngineError> {
    use sha2::{Digest, Sha256};
    let error = |_| BrowserEngineError::before("browser_profile_storage_unavailable");
    let root = crate::ensure_owner_subdirectory(directory, "browser-profiles").map_err(error)?;
    crate::ensure_owner_subdirectory(
        &root,
        &format!("{:x}", Sha256::digest(id.as_str().as_bytes())),
    )
    .map_err(error)
}

pub(super) struct ProfileClaim {
    file: File,
    path: PathBuf,
    pub(super) profile: PathBuf,
    pub(super) id: BrowserProfileIdV1,
    started: bool,
    released: bool,
}

impl ProfileClaim {
    pub(super) fn acquire(
        directory: &Path,
        id: &BrowserProfileIdV1,
        instance: &BrowserInstanceId,
    ) -> Result<Self, BrowserEngineError> {
        let error = |_| BrowserEngineError::before("browser_profile_storage_unavailable");
        let root = storage_root(directory, id)?;
        let path = root.join("native-claim.json");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|error| {
                BrowserEngineError::before(if error.kind() == std::io::ErrorKind::AlreadyExists {
                    "browser_profile_exit_unconfirmed"
                } else {
                    "browser_profile_storage_unavailable"
                })
            })?;
        let mut claim = Self {
            file,
            path,
            profile: root.join("profile"),
            id: id.clone(),
            started: false,
            released: false,
        };
        let initialized = (|| {
            claim.file.write_all(
                json!({"schemaVersion":1,"profileId":id,"instanceId":instance})
                    .to_string()
                    .as_bytes(),
            )?;
            claim.file.sync_all()?;
            File::open(&root)?.sync_all()?;
            Ok::<_, std::io::Error>(())
        })();
        initialized
            .map_err(|_| BrowserEngineError::before("browser_profile_storage_unavailable"))?;
        let profile = crate::ensure_owner_subdirectory(&root, "profile").map_err(error)?;
        let default = crate::ensure_owner_subdirectory(&profile, "Default").map_err(error)?;
        let downloads =
            crate::ensure_owner_subdirectory(&root, "fallback-downloads").map_err(error)?;
        let preferences = default.join("Preferences");
        // Existing Chromium preferences are its own persisted state. Initialize
        // only once; never replace cookies, settings or the whole Preferences file.
        let mut staged = tempfile::NamedTempFile::new_in(&default)
            .map_err(|_| BrowserEngineError::before("browser_profile_storage_unavailable"))?;
        staged
            .write_all(
                json!({"download":{"default_directory":downloads,"prompt_for_download":false}})
                    .to_string()
                    .as_bytes(),
            )
            .and_then(|_| staged.as_file().sync_all())
            .map_err(|_| BrowserEngineError::before("browser_profile_storage_unavailable"))?;
        match staged.persist_noclobber(&preferences) {
            Ok(_) => {}
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                crate::assert_owner_regular_file(&preferences).map_err(|_| {
                    BrowserEngineError::before("browser_profile_storage_unavailable")
                })?;
            }
            Err(_) => {
                return Err(BrowserEngineError::before(
                    "browser_profile_storage_unavailable",
                ));
            }
        }
        Ok(claim)
    }

    pub(super) fn started(&mut self) {
        self.started = true;
    }

    pub(super) fn release_after_exit(&mut self) -> Result<(), BrowserEngineError> {
        if self.released {
            return Ok(());
        }
        let result = (|| {
            let owned = self.file.metadata()?;
            let current = fs::symlink_metadata(&self.path)?;
            if owned.dev() != current.dev() || owned.ino() != current.ino() || !current.is_file() {
                return Err(std::io::Error::other("profile claim changed"));
            }
            fs::remove_file(&self.path)?;
            File::open(self.path.parent().expect("profile claim parent"))?.sync_all()?;
            Ok::<_, std::io::Error>(())
        })();
        result.map_err(|_| BrowserEngineError::after("browser_profile_retirement_unconfirmed"))?;
        self.released = true;
        Ok(())
    }
}

impl Drop for ProfileClaim {
    fn drop(&mut self) {
        if !self.started {
            let _ = self.release_after_exit();
        }
    }
}
