//! Compatibility with the existing discovery error contract.
//!
//! All filesystem checks and effects belong to the shared local platform.

use super::DiscoveryError;
use hmux_local_platform::private_storage as storage;
use std::fs::File;
use std::path::Path;
pub use storage::PrivateFileIdentity;

pub fn create_directory(path: &Path) -> Result<(), DiscoveryError> {
    storage::create_directory(path).map_err(DiscoveryError::from)
}

pub fn validate_directory(path: &Path) -> Result<(), DiscoveryError> {
    storage::validate_directory(path).map_err(DiscoveryError::from)
}

pub fn open_new_file(path: &Path) -> Result<File, DiscoveryError> {
    storage::open_new_file(path).map_err(DiscoveryError::from)
}

pub fn open_lock_file(path: &Path) -> Result<File, DiscoveryError> {
    storage::open_lock_file(path).map_err(DiscoveryError::from)
}

pub fn open_existing_file(path: &Path) -> Result<File, DiscoveryError> {
    storage::open_existing_file(path).map_err(DiscoveryError::from)
}

pub fn open_existing_lock_file(path: &Path) -> Result<File, DiscoveryError> {
    storage::open_existing_lock_file(path).map_err(DiscoveryError::from)
}

pub fn replace_file(source: &Path, target: &Path) -> Result<(), DiscoveryError> {
    storage::replace_file(source, target).map_err(DiscoveryError::from)
}

pub fn sync_directory(path: &Path) -> Result<(), DiscoveryError> {
    storage::sync_directory(path).map_err(DiscoveryError::from)
}

pub fn file_identity(path: &Path) -> Result<PrivateFileIdentity, DiscoveryError> {
    storage::file_identity(path).map_err(DiscoveryError::from)
}

pub fn open_file_identity(path: &Path, file: &File) -> Result<PrivateFileIdentity, DiscoveryError> {
    storage::open_file_identity(path, file).map_err(DiscoveryError::from)
}

pub(super) fn create_directory_all(path: &Path) -> Result<(), DiscoveryError> {
    storage::create_directory_all(path).map_err(DiscoveryError::from)
}

pub(super) fn path_entry_exists(path: &Path) -> Result<bool, DiscoveryError> {
    storage::path_entry_exists(path).map_err(DiscoveryError::from)
}

#[cfg(windows)]
pub(super) fn directory_identity(path: &Path) -> Result<(u64, u64), DiscoveryError> {
    storage::directory_identity(path).map_err(DiscoveryError::from)
}

#[cfg(windows)]
pub(super) fn file_facts(path: &Path) -> Result<storage::WindowsFileFacts, DiscoveryError> {
    storage::file_facts(path).map_err(DiscoveryError::from)
}

pub(super) fn is_atomic_replacement_open_error(error: &DiscoveryError) -> bool {
    if matches!(
        error,
        DiscoveryError::Security {
            violation: super::SecurityViolation::ReplacedDuringOpen,
            ..
        }
    ) {
        return true;
    }

    #[cfg(windows)]
    {
        matches!(error, DiscoveryError::Io { source, .. }
            if source.raw_os_error() == Some(i32::try_from(windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION).expect("Win32 error fits i32")))
    }
    #[cfg(not(windows))]
    {
        false
    }
}
