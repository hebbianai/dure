//! Owner-only local files shared by discovery and durable runtime state.
//!
//! Callers own transaction locks, file sync before replacement, and directory
//! sync after publication. These operations do not publish session transitions.

mod error;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

pub use error::{SecurityViolation, StorageError};
#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

pub use platform::{
    create_directory, open_existing_file, open_existing_lock_file, open_lock_file, open_new_file,
    replace_file, sync_directory, validate_directory,
};
#[cfg(windows)]
pub use windows::{WindowsFileFacts, directory_identity, file_facts};

use std::fs::{self, File};
use std::path::Path;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PrivateFileIdentity {
    pub volume: u64,
    pub object: u64,
}

/// File identity and metadata from one validated path observation. Callers
/// still own transaction locks and revalidate identity before mutating files.
#[derive(Debug)]
pub struct PrivateFileMetadata {
    pub identity: PrivateFileIdentity,
    pub metadata: fs::Metadata,
}

pub fn file_metadata(path: &Path) -> Result<PrivateFileMetadata, StorageError> {
    platform::private_file_metadata(path)
}

pub fn file_identity(path: &Path) -> Result<PrivateFileIdentity, StorageError> {
    let (volume, object) = platform::private_file_identity(path)?;
    Ok(PrivateFileIdentity { volume, object })
}

pub fn open_file_identity(path: &Path, file: &File) -> Result<PrivateFileIdentity, StorageError> {
    let (volume, object) = platform::open_private_file_identity(path, file)?;
    Ok(PrivateFileIdentity { volume, object })
}

pub fn path_entry_exists(path: &Path) -> Result<bool, StorageError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(StorageError::io("inspect path entry", path, error)),
    }
}

/// Creates `path` and every missing ancestor as a private directory, from the
/// top down, and validates whatever already existed at the end.
///
/// A freshly provisioned server has none of the state tree yet — not the
/// discovery root, not its parent, not `~/.dure` above that — and the first
/// launch there must not fail on whichever ancestor happens to be missing.
/// Each created level goes through [`create_directory`] so every one
/// of them carries the private mode, not only the leaf.
pub fn create_directory_all(path: &Path) -> Result<(), StorageError> {
    let mut missing = Vec::new();
    let mut candidate = Some(path);
    while let Some(current) = candidate {
        if current.as_os_str().is_empty() || path_entry_exists(current)? {
            break;
        }
        missing.push(current);
        candidate = current.parent();
    }
    for current in missing.into_iter().rev() {
        create_directory(current)?;
    }
    validate_directory(path)
}

#[cfg(test)]
mod tests;
