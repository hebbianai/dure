//! Private, bounded records accompany the immutable native claim. Publication
//! is atomic and every record is bound to the browser instance in that claim.
use super::*;
use hmux_client::ProcessDescriptor;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::io::Read;
use std::os::fd::AsRawFd;

pub(super) const LAUNCH: &str = "native-launch.json";
pub(super) const RESTART: &str = "native-recovery.json";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NativeClaim {
    pub schema_version: u32,
    pub profile_id: BrowserProfileIdV1,
    pub instance_id: BrowserInstanceId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<ProcessDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boot: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Launch {
    pub instance_id: BrowserInstanceId,
    pub process: Option<ProcessDescriptor>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Restart {
    pub claim_digest: String,
    pub boot: String,
}

pub(super) fn unconfirmed(reason: impl std::fmt::Debug) -> BrowserEngineError {
    #[cfg(test)]
    eprintln!("PROFILE_EVIDENCE_UNCONFIRMED: {reason:?}");
    let _ = reason;
    BrowserEngineError::before("browser_profile_recovery_unconfirmed")
}

pub(super) fn lock(file: &File) -> Result<(), BrowserEngineError> {
    // An OS lock complements the durable name. It fences live owners and
    // concurrent recovery; losing it alone never proves writer retirement.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        Ok(())
    } else {
        Err(BrowserEngineError::before(
            "browser_profile_recovery_in_progress",
        ))
    }
}

pub(super) fn same_file(file: &File, path: &Path) -> Result<(), BrowserEngineError> {
    let owned = file.metadata().map_err(unconfirmed)?;
    let current = fs::symlink_metadata(path).map_err(unconfirmed)?;
    if !owned.is_file()
        || owned.uid() != unsafe { libc::geteuid() }
        || owned.mode() & 0o077 != 0
        || owned.nlink() != 1
        || !current.is_file()
        || owned.dev() != current.dev()
        || owned.ino() != current.ino()
    {
        return Err(unconfirmed("claim identity changed"));
    }
    Ok(())
}

pub(super) fn open(path: &Path) -> Result<Option<File>, BrowserEngineError> {
    match OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => {
            same_file(&file, path)?;
            Ok(Some(file))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(unconfirmed(error)),
    }
}

pub(super) fn bytes(file: &File) -> Result<Vec<u8>, BrowserEngineError> {
    let mut bytes = Vec::new();
    file.take(16385)
        .read_to_end(&mut bytes)
        .map_err(unconfirmed)?;
    if bytes.len() > 16384 {
        return Err(unconfirmed("record too large"));
    }
    Ok(bytes)
}

pub(super) fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, BrowserEngineError> {
    open(path)?
        .map(|file| serde_json::from_slice(&bytes(&file)?).map_err(unconfirmed))
        .transpose()
}

pub(super) fn publish(path: &Path, value: &impl Serialize) -> Result<(), BrowserEngineError> {
    let parent = path.parent().expect("private profile directory");
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(unconfirmed)?;
    staged
        .write_all(&serde_json::to_vec(value).map_err(unconfirmed)?)
        .map_err(unconfirmed)?;
    staged.as_file().sync_all().map_err(unconfirmed)?;
    staged.persist(path).map_err(unconfirmed)?;
    File::open(parent)
        .and_then(|root| root.sync_all())
        .map_err(unconfirmed)
}

pub(super) fn clear_records(root: &Path) -> Result<(), BrowserEngineError> {
    for name in [LAUNCH, RESTART] {
        match fs::remove_file(root.join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(unconfirmed(error)),
        }
    }
    Ok(())
}

pub(super) fn writers_retired(
    root: &Path,
    instance: &BrowserInstanceId,
) -> Result<bool, BrowserEngineError> {
    let launch: Launch = read(&root.join(LAUNCH))?.ok_or_else(|| unconfirmed("missing launch"))?;
    if launch.instance_id != *instance {
        return Err(unconfirmed("launch changed"));
    }
    let process = launch
        .process
        .ok_or_else(|| unconfirmed("launch publication incomplete"))?;
    hmux_client::local_process_session_is_stably_empty(&process).map_err(unconfirmed)
}
