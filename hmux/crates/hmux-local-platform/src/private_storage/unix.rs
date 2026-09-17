use super::{PrivateFileIdentity, PrivateFileMetadata, SecurityViolation, StorageError};
use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::Path;

const DIRECTORY_MODE: u32 = 0o700;
const FILE_MODE: u32 = 0o600;

pub fn create_directory(path: &Path) -> Result<(), StorageError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => validate_metadata(path, &metadata, ExpectedKind::Directory, DIRECTORY_MODE),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match DirBuilder::new().mode(DIRECTORY_MODE).create(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(StorageError::io("create private directory", path, error));
                }
            }
            let metadata = fs::symlink_metadata(path)
                .map_err(|error| StorageError::io("inspect private directory", path, error))?;
            validate_metadata(path, &metadata, ExpectedKind::Directory, DIRECTORY_MODE)
        }
        Err(error) => Err(StorageError::io("inspect private directory", path, error)),
    }
}

pub fn validate_directory(path: &Path) -> Result<(), StorageError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| StorageError::io("inspect private directory", path, error))?;
    validate_metadata(path, &metadata, ExpectedKind::Directory, DIRECTORY_MODE)
}

pub fn open_new_file(path: &Path) -> Result<File, StorageError> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(FILE_MODE)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| StorageError::io("create private file", path, error))?;
    validate_open_file(path, &file, None)?;
    Ok(file)
}

pub fn open_lock_file(path: &Path) -> Result<File, StorageError> {
    if !super::path_entry_exists(path)? {
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(FILE_MODE)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
        {
            Ok(file) => {
                validate_open_file(path, &file, None)?;
                return Ok(file);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(StorageError::io("create lifetime lock", path, error)),
        }
    }
    let lstat = secure_file_metadata(path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| StorageError::io("open lifetime lock", path, error))?;
    validate_open_file(path, &file, Some(&lstat))?;
    Ok(file)
}

pub fn open_existing_file(path: &Path) -> Result<File, StorageError> {
    let lstat = secure_file_metadata(path)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| StorageError::io("open private file", path, error))?;
    validate_open_file(path, &file, Some(&lstat))?;
    Ok(file)
}

pub fn open_existing_lock_file(path: &Path) -> Result<File, StorageError> {
    let lstat = secure_file_metadata(path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| StorageError::io("open private lock", path, error))?;
    validate_open_file(path, &file, Some(&lstat))?;
    Ok(file)
}

pub fn private_file_identity(path: &Path) -> Result<(u64, u64), StorageError> {
    let identity = private_file_metadata(path)?.identity;
    Ok((identity.volume, identity.object))
}

pub fn private_file_metadata(path: &Path) -> Result<PrivateFileMetadata, StorageError> {
    let metadata = secure_file_metadata(path)?;
    Ok(PrivateFileMetadata {
        identity: PrivateFileIdentity {
            volume: metadata.dev(),
            object: metadata.ino(),
        },
        metadata,
    })
}

pub fn open_private_file_identity(path: &Path, file: &File) -> Result<(u64, u64), StorageError> {
    let lstat = secure_file_metadata(path)?;
    validate_open_file(path, file, Some(&lstat))?;
    let metadata = file
        .metadata()
        .map_err(|error| StorageError::io("inspect opened private file", path, error))?;
    Ok((metadata.dev(), metadata.ino()))
}

pub fn replace_file(source: &Path, target: &Path) -> Result<(), StorageError> {
    if super::path_entry_exists(target)? {
        secure_file_metadata(target)?;
    }
    fs::rename(source, target)
        .map_err(|error| StorageError::io("atomically replace manifest", target, error))?;
    secure_file_metadata(target)?;
    Ok(())
}

pub fn sync_directory(path: &Path) -> Result<(), StorageError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| StorageError::io("sync discovery directory", path, error))
}

fn secure_file_metadata(path: &Path) -> Result<Metadata, StorageError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| StorageError::io("inspect private file", path, error))?;
    validate_metadata(path, &metadata, ExpectedKind::File, FILE_MODE)?;
    Ok(metadata)
}

fn validate_open_file(
    path: &Path,
    file: &File,
    lstat: Option<&Metadata>,
) -> Result<(), StorageError> {
    let metadata = file
        .metadata()
        .map_err(|error| StorageError::io("inspect opened private file", path, error))?;
    validate_metadata(path, &metadata, ExpectedKind::File, FILE_MODE)?;
    if let Some(lstat) = lstat {
        if lstat.dev() != metadata.dev() || lstat.ino() != metadata.ino() {
            return Err(StorageError::security(
                path,
                SecurityViolation::ReplacedDuringOpen,
            ));
        }
    }
    Ok(())
}

fn validate_metadata(
    path: &Path,
    metadata: &Metadata,
    expected_kind: ExpectedKind,
    expected_mode: u32,
) -> Result<(), StorageError> {
    if metadata.file_type().is_symlink() {
        return Err(StorageError::security(path, SecurityViolation::Symlink));
    }
    match expected_kind {
        ExpectedKind::Directory if !metadata.is_dir() => {
            return Err(StorageError::security(
                path,
                SecurityViolation::ExpectedDirectory,
            ));
        }
        ExpectedKind::File if !metadata.is_file() => {
            return Err(StorageError::security(
                path,
                SecurityViolation::ExpectedRegularFile,
            ));
        }
        _ => {}
    }
    // SAFETY: geteuid has no arguments and does not dereference memory.
    let expected_owner = unsafe { libc::geteuid() };
    if metadata.uid() != expected_owner {
        return Err(StorageError::security(
            path,
            SecurityViolation::WrongOwner {
                expected: expected_owner,
                actual: metadata.uid(),
            },
        ));
    }
    let actual_mode = metadata.mode() & 0o777;
    if actual_mode != expected_mode {
        return Err(StorageError::security(
            path,
            SecurityViolation::WrongMode {
                expected: expected_mode,
                actual: actual_mode,
            },
        ));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ExpectedKind {
    Directory,
    File,
}
