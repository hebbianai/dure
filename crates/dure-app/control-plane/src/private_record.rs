//! Bounded owner-only records shared by descriptors and backend policy.
use crate::{ControlPlaneError, now_ms};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub(crate) fn read(path: &Path) -> Result<Option<Vec<u8>>, ControlPlaneError> {
    read_bounded(path, 16 * 1024)
}

pub(crate) fn read_bounded(
    path: &Path,
    maximum_bytes: u64,
) -> Result<Option<Vec<u8>>, ControlPlaneError> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(ControlPlaneError::Invalid(
                "private record must be an owner-only regular file",
            ));
        }
    }
    if metadata.len() > maximum_bytes {
        return Err(ControlPlaneError::Invalid("private record is too large"));
    }
    let mut source = Vec::with_capacity(metadata.len() as usize);
    let mut bounded = std::io::Read::take(&mut file, maximum_bytes.saturating_add(1));
    std::io::Read::read_to_end(&mut bounded, &mut source)?;
    let after = file.metadata()?;
    if source.len() as u64 != metadata.len()
        || after.len() != metadata.len()
        || after.modified()? != metadata.modified()?
    {
        return Err(ControlPlaneError::Invalid(
            "private record changed while it was read",
        ));
    }
    Ok(Some(source))
}

pub(crate) fn write<T: Serialize>(path: &Path, value: &T) -> Result<(), ControlPlaneError> {
    let temporary = path.with_extension(format!("tmp-{}-{}", std::process::id(), now_ms()?));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let result = (|| {
        let source = serde_json::to_vec(value)
            .map_err(|error| ControlPlaneError::Message(error.to_string()))?;
        file.write_all(&source)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        File::open(
            path.parent()
                .ok_or(ControlPlaneError::Invalid("invalid private record path"))?,
        )?
        .sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
