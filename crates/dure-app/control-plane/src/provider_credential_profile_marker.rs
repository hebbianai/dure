use std::ffi::{CStr, CString};
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use dure_app::{
    PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1, ProviderCredentialProfileDirectoryNameV1,
    ProviderCredentialProfileV1, ProviderIdV1,
};
use sha2::{Digest, Sha256};

use super::ProviderCredentialProfileErrorV1;

pub(super) const PROFILE_GENERATION_FILE_NAME: &CStr = c".dure-profile-generation-v1";
const MAX_PROFILE_GENERATION_FILE_BYTES: u64 = 192;

pub(super) struct ProfileDirectoryObservation {
    pub(super) canonical_path: PathBuf,
    directory: File,
    pub(super) device: u64,
    pub(super) inode: u64,
}

pub(super) fn observe_profile_directory(
    home: &Path,
    profile_directory_name: &ProviderCredentialProfileDirectoryNameV1,
    error: ProviderCredentialProfileErrorV1,
) -> Result<ProfileDirectoryObservation, ProviderCredentialProfileErrorV1> {
    let accounts = home.join("accounts");
    let accounts_metadata = fs::symlink_metadata(&accounts).map_err(|_| error)?;
    if !owner_directory(&accounts_metadata) {
        return Err(error);
    }
    let canonical_accounts = accounts.canonicalize().map_err(|_| error)?;
    let profile = accounts.join(profile_directory_name.as_str());
    let before = fs::symlink_metadata(&profile).map_err(|_| error)?;
    if !owner_directory(&before) {
        return Err(error);
    }
    let canonical_path = profile.canonicalize().map_err(|_| error)?;
    if canonical_path.parent() != Some(canonical_accounts.as_path()) {
        return Err(error);
    }
    let after = fs::symlink_metadata(&canonical_path).map_err(|_| error)?;
    if !owner_directory(&after) || before.dev() != after.dev() || before.ino() != after.ino() {
        return Err(error);
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&canonical_path)
        .map_err(|_| error)?;
    let opened = directory.metadata().map_err(|_| error)?;
    if !owner_directory(&opened) || opened.dev() != after.dev() || opened.ino() != after.ino() {
        return Err(error);
    }
    Ok(ProfileDirectoryObservation {
        canonical_path,
        directory,
        device: after.dev(),
        inode: after.ino(),
    })
}

pub(super) fn reobserve_same_profile_directory(
    home: &Path,
    profile_directory_name: &ProviderCredentialProfileDirectoryNameV1,
    before: &ProfileDirectoryObservation,
    error: ProviderCredentialProfileErrorV1,
) -> Result<ProfileDirectoryObservation, ProviderCredentialProfileErrorV1> {
    let after = observe_profile_directory(home, profile_directory_name, error)?;
    if before.canonical_path != after.canonical_path
        || before.device != after.device
        || before.inode != after.inode
    {
        return Err(error);
    }
    Ok(after)
}

pub(super) fn read_profile_generation(
    observation: &ProfileDirectoryObservation,
    provider_id: &ProviderIdV1,
    reference_id: &str,
    error: ProviderCredentialProfileErrorV1,
) -> Result<Option<String>, ProviderCredentialProfileErrorV1> {
    let mut file = match open_profile_generation_file(&observation.directory) {
        Ok(file) => file,
        Err(file_error) if file_error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error),
    };
    let metadata = file.metadata().map_err(|_| error)?;
    if !owner_file(&metadata) || metadata.len() > MAX_PROFILE_GENERATION_FILE_BYTES {
        return Err(error);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_PROFILE_GENERATION_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error)?;
    if bytes.len() as u64 > MAX_PROFILE_GENERATION_FILE_BYTES {
        return Err(error);
    }
    let content = std::str::from_utf8(&bytes).map_err(|_| error)?;
    let generation = content.strip_suffix('\n').ok_or(error)?;
    let profile = ProviderCredentialProfileV1 {
        schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
        provider_id: provider_id.clone(),
        reference_id: reference_id.into(),
        credential_generation: generation.into(),
    };
    profile.validate().map_err(|_| error)?;
    Ok(Some(profile.credential_generation))
}

pub(super) fn publish_profile_generation(
    observation: &ProfileDirectoryObservation,
    provider_id: &ProviderIdV1,
    reference_id: &str,
    expected_generation: &str,
    error: ProviderCredentialProfileErrorV1,
) -> Result<(), ProviderCredentialProfileErrorV1> {
    if let Some(existing) = read_profile_generation(observation, provider_id, reference_id, error)?
    {
        return if existing == expected_generation {
            Ok(())
        } else {
            Err(error)
        };
    }
    let file_name = PROFILE_GENERATION_FILE_NAME.to_str().map_err(|_| error)?;
    let temporary_name =
        CString::new(format!("{file_name}.{}.tmp", random_hex::<12>(error)?)).map_err(|_| error)?;
    let descriptor = unsafe {
        libc::openat(
            observation.directory.as_raw_fd(),
            temporary_name.as_ptr(),
            libc::O_CLOEXEC | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_WRONLY,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(error);
    }
    let mut temporary = unsafe { File::from_raw_fd(descriptor) };
    let write_result = temporary
        .write_all(format!("{expected_generation}\n").as_bytes())
        .and_then(|()| temporary.sync_all());
    drop(temporary);
    if write_result.is_err() {
        unlink_profile_entry(&observation.directory, &temporary_name);
        return Err(error);
    }
    let link_result = unsafe {
        libc::linkat(
            observation.directory.as_raw_fd(),
            temporary_name.as_ptr(),
            observation.directory.as_raw_fd(),
            PROFILE_GENERATION_FILE_NAME.as_ptr(),
            0,
        )
    };
    let link_error = (link_result < 0).then(io::Error::last_os_error);
    unlink_profile_entry(&observation.directory, &temporary_name);
    if link_error
        .as_ref()
        .is_some_and(|link_error| link_error.raw_os_error() != Some(libc::EEXIST))
    {
        return Err(error);
    }
    observation.directory.sync_all().map_err(|_| error)?;
    match read_profile_generation(observation, provider_id, reference_id, error)? {
        Some(generation) if generation == expected_generation => Ok(()),
        _ => Err(error),
    }
}

pub(super) fn new_credential_generation(
    provider_id: &ProviderIdV1,
    reference_id: &str,
) -> Result<String, ProviderCredentialProfileErrorV1> {
    let nonce = random_hex::<32>(ProviderCredentialProfileErrorV1::Unavailable)?;
    let digest = Sha256::digest(
        format!(
            "provider-credential-profile/v2\0{}\0{reference_id}\0{nonce}",
            provider_id.as_str()
        )
        .as_bytes(),
    );
    Ok(format!("credential-v2-{digest:x}"))
}

fn owner_directory(metadata: &fs::Metadata) -> bool {
    metadata.is_dir()
        && !metadata.file_type().is_symlink()
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.permissions().mode() & 0o077 == 0
}

fn owner_file(metadata: &fs::Metadata) -> bool {
    metadata.is_file()
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.permissions().mode() & 0o077 == 0
}

fn open_profile_generation_file(directory: &File) -> io::Result<File> {
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            PROFILE_GENERATION_FILE_NAME.as_ptr(),
            libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_RDONLY,
        )
    };
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }
}

fn unlink_profile_entry(directory: &File, name: &CStr) {
    unsafe {
        libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0);
    }
}

fn random_hex<const N: usize>(
    error: ProviderCredentialProfileErrorV1,
) -> Result<String, ProviderCredentialProfileErrorV1> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).map_err(|_| error)?;
    let mut encoded = String::with_capacity(N * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").map_err(|_| error)?;
    }
    Ok(encoded)
}
