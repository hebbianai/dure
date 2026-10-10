//! A durable claim prevents reopening storage after an unconfirmed process exit.
//! A claim is never PID/liveness evidence and never authorizes adopting a browser.
use super::*;
use dure_app::BrowserProfileIdV1;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

mod evidence;
mod recovery;
mod retirement;
#[cfg(test)]
pub(crate) use recovery::RecoveryState;
pub(crate) use recovery::{recover_storage, recovery_status};
pub(crate) use retirement::retire_storage;

fn storage_unavailable(_: impl std::fmt::Debug) -> BrowserEngineError {
    BrowserEngineError::before("browser_profile_storage_unavailable")
}

fn storage_root(directory: &Path, id: &BrowserProfileIdV1) -> Result<PathBuf, BrowserEngineError> {
    use sha2::{Digest, Sha256};
    let root = crate::ensure_owner_subdirectory(directory, "browser-profiles")
        .map_err(storage_unavailable)?;
    crate::ensure_owner_subdirectory(
        &root,
        &format!("{:x}", Sha256::digest(id.as_str().as_bytes())),
    )
    .map_err(storage_unavailable)
}

pub(super) struct ProfileClaim {
    file: File,
    path: PathBuf,
    pub(super) profile: PathBuf,
    pub(super) id: BrowserProfileIdV1,
    instance: BrowserInstanceId,
    started: bool,
    released: bool,
}

impl ProfileClaim {
    pub(super) fn acquire(
        directory: &Path,
        id: &BrowserProfileIdV1,
        instance: &BrowserInstanceId,
    ) -> Result<Self, BrowserEngineError> {
        let boot = hmux_client::local_boot_identity().map_err(evidence::unconfirmed)?;
        let owner = hmux_client::exact_local_process_generation(std::process::id())
            .map_err(evidence::unconfirmed)?;
        let root = storage_root(directory, id)?;
        let path = root.join("native-claim.json");
        // Publish the complete immutable record atomically. A backend crash
        // cannot leave an empty claim that no future recovery can interpret.
        let mut staged = tempfile::NamedTempFile::new_in(&root).map_err(storage_unavailable)?;
        staged.write_all(json!({"schemaVersion":2,"profileId":id,"instanceId":instance,"owner":owner,"boot":boot}).to_string().as_bytes()).map_err(storage_unavailable)?;
        staged.as_file().sync_all().map_err(storage_unavailable)?;
        evidence::lock(staged.as_file())?;
        let file = staged.persist_noclobber(&path).map_err(|failure| {
            BrowserEngineError::before(
                if failure.error.kind() == std::io::ErrorKind::AlreadyExists {
                    "browser_profile_exit_unconfirmed"
                } else {
                    "browser_profile_storage_unavailable"
                },
            )
        })?;
        let claim = Self {
            file,
            path,
            profile: root.join("profile"),
            id: id.clone(),
            instance: instance.clone(),
            started: false,
            released: false,
        };
        File::open(&root)
            .and_then(|file| file.sync_all())
            .map_err(storage_unavailable)?;
        evidence::clear_records(&root)?;
        let profile =
            crate::ensure_owner_subdirectory(&root, "profile").map_err(storage_unavailable)?;
        let default =
            crate::ensure_owner_subdirectory(&profile, "Default").map_err(storage_unavailable)?;
        let downloads = crate::ensure_owner_subdirectory(&root, "fallback-downloads")
            .map_err(storage_unavailable)?;
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

    /// Publish intent before spawn: a lost child publication cannot be
    /// mistaken for a launch that never crossed the process boundary.
    pub(super) fn prepare_launch(&mut self) -> Result<(), BrowserEngineError> {
        evidence::publish(
            &self.path.with_file_name(evidence::LAUNCH),
            &evidence::Launch {
                instance_id: self.instance.clone(),
                process: None,
            },
        )?;
        self.started = true;
        Ok(())
    }

    pub(super) fn record_writer(&self, child: &Child) -> Result<(), BrowserEngineError> {
        let process = hmux_client::exact_local_process_generation(child.id())
            .map_err(evidence::unconfirmed)?;
        // SAFETY: the spawned child must own the session installed by pre_exec.
        if unsafe { libc::getsid(child.id() as libc::pid_t) } != child.id() as libc::pid_t {
            return Err(evidence::unconfirmed("browser session ownership changed"));
        }
        evidence::publish(
            &self.path.with_file_name(evidence::LAUNCH),
            &evidence::Launch {
                instance_id: self.instance.clone(),
                process: Some(process),
            },
        )
    }

    pub(super) fn confirm_writer_retirement(&self) -> Result<(), BrowserEngineError> {
        if self.released {
            return Ok(());
        }
        match evidence::writers_retired(self.path.parent().expect("claim parent"), &self.instance) {
            Ok(true) => Ok(()),
            _result => {
                #[cfg(test)]
                eprintln!("PROFILE_WRITERS_RETIRED: {_result:?}");
                Err(BrowserEngineError::after(
                    "browser_profile_exit_unconfirmed",
                ))
            }
        }
    }

    pub(super) fn release_after_exit(&mut self) -> Result<(), BrowserEngineError> {
        if self.released {
            return Ok(());
        }
        evidence::same_file(&self.file, &self.path)
            .map_err(|_| BrowserEngineError::after("browser_profile_retirement_unconfirmed"))?;
        evidence::clear_records(self.path.parent().expect("claim parent"))?;
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
