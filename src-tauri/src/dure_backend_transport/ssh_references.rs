use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{Read as _, Write as _};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use tempfile::TempDir;

use super::{
    valid_profile_id, DureBackendTransportError, FileIdentity, ProfileAuth, ProfileTrust,
    SshReferences, MAX_CATALOG_BYTES,
};

#[cfg(test)]
mod tests;

pub(super) const CATALOG_FILE: &str = "backend-ssh-references.json";
const MAX_REFERENCES: usize = 64;
const MAX_MATERIAL_BYTES: u64 = 1024 * 1024;
const PINNED_MATERIAL_PARENT: &str = "/tmp";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    schema_version: u16,
    kind: String,
    references: Vec<Entry>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    reference: String,
    kind: Kind,
    path: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Kind {
    IdentityFile,
    KnownHostsFile,
}

pub(super) struct Compatibility {
    pub profile_id: Option<String>,
    pub known_hosts_file: Option<PathBuf>,
    pub identity_file: Option<PathBuf>,
}

pub(super) struct PinnedSshReferences {
    _owner: TempDir,
    known_hosts_file: PathBuf,
    identity_file: Option<PathBuf>,
}

impl PinnedSshReferences {
    pub(super) fn known_hosts_file(&self) -> &Path {
        &self.known_hosts_file
    }

    pub(super) fn identity_file(&self) -> Option<&Path> {
        self.identity_file.as_deref()
    }
}

pub(super) fn unavailable() -> DureBackendTransportError {
    DureBackendTransportError::new(
        "backend_transport_reference_unavailable",
        "the backend SSH reference is unavailable",
    )
}

fn same_snapshot(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn current_user_owns(uid: u32) -> bool {
    uid == unsafe { libc::geteuid() }
}

fn owner_only_regular(metadata: &std::fs::Metadata, maximum: u64) -> bool {
    metadata.is_file()
        && current_user_owns(metadata.uid())
        && metadata.mode() & 0o077 == 0
        && metadata.len() > 0
        && metadata.len() <= maximum
}

fn owner_only_directory(metadata: &std::fs::Metadata) -> bool {
    metadata.is_dir()
        && current_user_owns(metadata.uid())
        && metadata.mode() & 0o777 == 0o700
}

fn valid_path(path: &Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|value| value.len() <= 1024 && !value.chars().any(char::is_control))
}

fn material_identity(path: PathBuf) -> Result<FileIdentity, DureBackendTransportError> {
    material_identity_with_hook(path, || {})
}

pub(super) fn material_identity_with_hook(
    path: PathBuf,
    after_open: impl FnOnce(),
) -> Result<FileIdentity, DureBackendTransportError> {
    if !valid_path(&path) {
        return Err(unavailable());
    }
    let path_before = std::fs::symlink_metadata(&path).map_err(|_| unavailable())?;
    if !owner_only_regular(&path_before, MAX_MATERIAL_BYTES) {
        return Err(unavailable());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|_| unavailable())?;
    let before = file.metadata().map_err(|_| unavailable())?;
    if !owner_only_regular(&before, MAX_MATERIAL_BYTES)
        || !same_snapshot(&path_before, &before)
    {
        return Err(unavailable());
    }
    after_open();
    let mut source = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(MAX_MATERIAL_BYTES + 1)
        .read_to_end(&mut source)
        .map_err(|_| unavailable())?;
    let after = file.metadata().map_err(|_| unavailable())?;
    let path_after = std::fs::symlink_metadata(&path).map_err(|_| unavailable())?;
    if source.len() as u64 != before.len()
        || !owner_only_regular(&after, MAX_MATERIAL_BYTES)
        || !owner_only_regular(&path_after, MAX_MATERIAL_BYTES)
        || !same_snapshot(&before, &after)
        || !same_snapshot(&after, &path_after)
    {
        return Err(unavailable());
    }
    Ok(FileIdentity {
        path,
        digest: Sha256::digest(&source).into(),
        device: after.dev(),
        inode: after.ino(),
        size: after.len(),
        modified_seconds: after.mtime(),
        modified_nanoseconds: after.mtime_nsec(),
        changed_seconds: after.ctime(),
        changed_nanoseconds: after.ctime_nsec(),
    })
}

fn matches_identity(metadata: &std::fs::Metadata, identity: &FileIdentity) -> bool {
    metadata.dev() == identity.device
        && metadata.ino() == identity.inode
        && metadata.len() == identity.size
        && metadata.mtime() == identity.modified_seconds
        && metadata.mtime_nsec() == identity.modified_nanoseconds
        && metadata.ctime() == identity.changed_seconds
        && metadata.ctime_nsec() == identity.changed_nanoseconds
}

fn same_open_material(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && ((left.ctime() == right.ctime() && left.ctime_nsec() == right.ctime_nsec())
            || right.nlink() < left.nlink())
}

fn read_exact_material(
    identity: &FileIdentity,
    after_open: &impl Fn(&Path),
) -> Result<Vec<u8>, DureBackendTransportError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&identity.path)
        .map_err(|_| unavailable())?;
    let before = file.metadata().map_err(|_| unavailable())?;
    if !owner_only_regular(&before, MAX_MATERIAL_BYTES)
        || !matches_identity(&before, identity)
    {
        return Err(unavailable());
    }
    after_open(&identity.path);
    let mut source = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(MAX_MATERIAL_BYTES + 1)
        .read_to_end(&mut source)
        .map_err(|_| unavailable())?;
    let after = file.metadata().map_err(|_| unavailable())?;
    if source.len() as u64 != before.len()
        || !owner_only_regular(&after, MAX_MATERIAL_BYTES)
        || !same_open_material(&before, &after)
        || <[u8; 32]>::from(Sha256::digest(&source)) != identity.digest
    {
        return Err(unavailable());
    }
    Ok(source)
}

fn write_snapshot(
    root: &Path,
    name: &str,
    source: &[u8],
) -> Result<PathBuf, DureBackendTransportError> {
    let path = root.join(name);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|_| unavailable())?;
    file.write_all(source).map_err(|_| unavailable())?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|_| unavailable())?;
    let metadata = file.metadata().map_err(|_| unavailable())?;
    if !owner_only_regular(&metadata, MAX_MATERIAL_BYTES)
        || metadata.len() != source.len() as u64
        || metadata.mode() & 0o777 != 0o600
    {
        return Err(unavailable());
    }
    Ok(path)
}

pub(super) fn pin_with_hook(
    references: &SshReferences,
    after_open: impl Fn(&Path),
) -> Result<PinnedSshReferences, DureBackendTransportError> {
    let known_hosts_source = read_exact_material(&references.known_hosts_file, &after_open)?;
    let identity_source = references
        .identity_file
        .as_ref()
        .map(|identity| read_exact_material(identity, &after_open))
        .transpose()?;
    let owner = tempfile::Builder::new()
        .prefix("dure-ssh-material-")
        .tempdir_in(PINNED_MATERIAL_PARENT)
        .map_err(|_| unavailable())?;
    std::fs::set_permissions(owner.path(), std::fs::Permissions::from_mode(0o700))
        .map_err(|_| unavailable())?;
    let owner_metadata = std::fs::symlink_metadata(owner.path()).map_err(|_| unavailable())?;
    if !owner_only_directory(&owner_metadata) {
        return Err(unavailable());
    }
    let known_hosts_file = write_snapshot(owner.path(), "known_hosts", &known_hosts_source)?;
    let identity_file = identity_source
        .as_deref()
        .map(|source| write_snapshot(owner.path(), "identity", source))
        .transpose()?;
    Ok(PinnedSshReferences {
        _owner: owner,
        known_hosts_file,
        identity_file,
    })
}

fn valid_reference(reference: &str, prefix: &str) -> bool {
    reference.strip_prefix(prefix).is_some_and(valid_profile_id)
}

fn parse_catalog(source: &[u8]) -> Result<BTreeMap<String, Entry>, DureBackendTransportError> {
    let catalog: Catalog = serde_json::from_slice(source).map_err(|_| unavailable())?;
    if catalog.schema_version != 1
        || catalog.kind != "dure.backend_ssh_references"
        || catalog.references.len() > MAX_REFERENCES
    {
        return Err(unavailable());
    }
    let mut references = BTreeMap::new();
    for entry in catalog.references {
        let valid_kind = match entry.kind {
            Kind::IdentityFile => valid_reference(&entry.reference, "credential-profile:"),
            Kind::KnownHostsFile => {
                valid_reference(&entry.reference, "known-hosts-profile:")
            }
        };
        if !valid_kind
            || !valid_path(&entry.path)
            || references.insert(entry.reference.clone(), entry).is_some()
        {
            return Err(unavailable());
        }
    }
    Ok(references)
}

fn read_catalog(path: &Path) -> Result<Option<Vec<u8>>, DureBackendTransportError> {
    read_catalog_with_hook(path, || {})
}

pub(super) fn read_catalog_with_hook(
    path: &Path,
    after_open: impl FnOnce(),
) -> Result<Option<Vec<u8>>, DureBackendTransportError> {
    let path_before = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(unavailable()),
    };
    if !owner_only_regular(&path_before, MAX_CATALOG_BYTES) {
        return Err(unavailable());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| unavailable())?;
    let before = file.metadata().map_err(|_| unavailable())?;
    if !owner_only_regular(&before, MAX_CATALOG_BYTES)
        || !same_snapshot(&path_before, &before)
    {
        return Err(unavailable());
    }
    after_open();
    let mut source = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(MAX_CATALOG_BYTES + 1)
        .read_to_end(&mut source)
        .map_err(|_| unavailable())?;
    let after = file.metadata().map_err(|_| unavailable())?;
    let path_after = std::fs::symlink_metadata(path).map_err(|_| unavailable())?;
    if source.len() as u64 != before.len()
        || !owner_only_regular(&after, MAX_CATALOG_BYTES)
        || !owner_only_regular(&path_after, MAX_CATALOG_BYTES)
        || !same_snapshot(&before, &after)
        || !same_snapshot(&after, &path_after)
    {
        return Err(unavailable());
    }
    Ok(Some(source))
}

fn reference_path(
    references: &BTreeMap<String, Entry>,
    reference: &str,
    expected_kind: Kind,
) -> Result<PathBuf, DureBackendTransportError> {
    references
        .get(reference)
        .filter(|entry| entry.kind == expected_kind)
        .map(|entry| entry.path.clone())
        .ok_or_else(unavailable)
}

fn from_catalog(
    root: &Path,
    auth: &ProfileAuth,
    trust: &ProfileTrust,
) -> Result<Option<SshReferences>, DureBackendTransportError> {
    let Some(source) = read_catalog(&root.join(CATALOG_FILE))? else {
        return Ok(None);
    };
    let references = parse_catalog(&source)?;
    let ProfileTrust::KnownHosts { reference } = trust else {
        return Err(unavailable());
    };
    let known_hosts_file = material_identity(reference_path(
        &references,
        reference,
        Kind::KnownHostsFile,
    )?)?;
    let identity_file = match auth {
        ProfileAuth::IdentityFile { reference } => Some(material_identity(reference_path(
            &references,
            reference,
            Kind::IdentityFile,
        )?)?),
        ProfileAuth::SshAgent => None,
        ProfileAuth::Peer => return Err(unavailable()),
    };
    Ok(Some(SshReferences {
        known_hosts_file,
        identity_file,
    }))
}

pub(super) fn resolve(
    root: &Path,
    selected_profile_id: &str,
    auth: &ProfileAuth,
    trust: &ProfileTrust,
    compatibility: Compatibility,
) -> Result<SshReferences, DureBackendTransportError> {
    if let Some(references) = from_catalog(root, auth, trust)? {
        return Ok(references);
    }
    if compatibility.profile_id.as_deref() != Some(selected_profile_id) {
        return Err(unavailable());
    }
    let known_hosts_file = material_identity(
        compatibility
            .known_hosts_file
            .ok_or_else(unavailable)?,
    )?;
    let identity_file = match auth {
        ProfileAuth::IdentityFile { .. } => Some(material_identity(
            compatibility.identity_file.ok_or_else(unavailable)?,
        )?),
        ProfileAuth::SshAgent => None,
        ProfileAuth::Peer => return Err(unavailable()),
    };
    Ok(SshReferences {
        known_hosts_file,
        identity_file,
    })
}
