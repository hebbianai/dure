use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use dure_app::{ClientIdV1, ClientInstanceIdV1, ClientViewNamespaceV1, TenantIdV1, UserIdV1};
use fs2::FileExt as _;
use serde::{Deserialize, Serialize};

const IDENTITY_FILE: &str = "client-view-identity.json";
const IDENTITY_SCHEMA_VERSION: u16 = 1;
const MAX_IDENTITY_BYTES: u64 = 4 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DureClientViewLocalIdentity {
    schema_version: u16,
    namespace: ClientViewNamespaceV1,
    client_instance_id: ClientInstanceIdV1,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredIdentity {
    schema_version: u16,
    client_id: ClientIdV1,
    client_instance_id: ClientInstanceIdV1,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DureClientViewIdentityError {
    code: &'static str,
    message: String,
}

impl DureClientViewIdentityError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for DureClientViewIdentityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for DureClientViewIdentityError {}

fn io_error(error: std::io::Error) -> DureClientViewIdentityError {
    DureClientViewIdentityError::new(
        "client_view_identity_unavailable",
        format!("the local Dure client identity is unavailable: {error}"),
    )
}

fn validate_file(file: &File) -> Result<std::fs::Metadata, DureClientViewIdentityError> {
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_IDENTITY_BYTES {
        return Err(DureClientViewIdentityError::new(
            "client_view_identity_unsafe",
            "the local Dure client identity is not a bounded regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.nlink() != 1
        {
            return Err(DureClientViewIdentityError::new(
                "client_view_identity_unsafe",
                "the local Dure client identity is not owner-only",
            ));
        }
    }
    Ok(metadata)
}

fn open_identity(path: &Path) -> Result<File, DureClientViewIdentityError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    options.open(path).map_err(io_error)
}

fn open_identity_lock(path: &Path) -> Result<File, DureClientViewIdentityError> {
    let lock_path = path.with_extension("lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    let file = options.open(lock_path).map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() {
        return Err(DureClientViewIdentityError::new(
            "client_view_identity_unsafe",
            "the local Dure client identity lock is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.nlink() != 1
        {
            return Err(DureClientViewIdentityError::new(
                "client_view_identity_unsafe",
                "the local Dure client identity lock is not owner-only",
            ));
        }
    }
    Ok(file)
}

fn same_file(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        before.dev() == after.dev()
            && before.ino() == after.ino()
            && before.len() == after.len()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        before.len() == after.len() && before.modified().ok() == after.modified().ok()
    }
}

fn read_identity(path: &Path) -> Result<StoredIdentity, DureClientViewIdentityError> {
    let mut file = open_identity(path)?;
    let before = validate_file(&file)?;
    let mut source = Vec::with_capacity(before.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_IDENTITY_BYTES + 1)
        .read_to_end(&mut source)
        .map_err(io_error)?;
    let after = validate_file(&file)?;
    let path_metadata = path.symlink_metadata().map_err(io_error)?;
    if source.len() as u64 != before.len()
        || !same_file(&before, &after)
        || !same_file(&after, &path_metadata)
    {
        return Err(DureClientViewIdentityError::new(
            "client_view_identity_changed",
            "the local Dure client identity changed while it was read",
        ));
    }
    let identity: StoredIdentity = serde_json::from_slice(&source).map_err(|error| {
        DureClientViewIdentityError::new(
            "client_view_identity_invalid",
            format!("the local Dure client identity is invalid: {error}"),
        )
    })?;
    if identity.schema_version != IDENTITY_SCHEMA_VERSION {
        return Err(DureClientViewIdentityError::new(
            "client_view_identity_invalid",
            "the local Dure client identity schema is unsupported",
        ));
    }
    Ok(identity)
}

fn fresh_identity() -> Result<StoredIdentity, DureClientViewIdentityError> {
    let client_id = ClientIdV1::new(format!(
        "client-{}",
        crate::server::gen_token().map_err(io_error)?
    ))
    .map_err(|error| {
        DureClientViewIdentityError::new("client_view_identity_invalid", error.to_string())
    })?;
    let client_instance_id = ClientInstanceIdV1::new(format!(
        "instance-{}",
        crate::server::gen_token().map_err(io_error)?
    ))
    .map_err(|error| {
        DureClientViewIdentityError::new("client_view_identity_invalid", error.to_string())
    })?;
    Ok(StoredIdentity {
        schema_version: IDENTITY_SCHEMA_VERSION,
        client_id,
        client_instance_id,
    })
}

fn create_identity(
    path: &Path,
    identity: &StoredIdentity,
) -> Result<bool, DureClientViewIdentityError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_CLOEXEC);
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(io_error(error)),
    };
    let mut encoded = serde_json::to_vec(identity).map_err(|error| {
        DureClientViewIdentityError::new("client_view_identity_invalid", error.to_string())
    })?;
    encoded.push(b'\n');
    file.write_all(&encoded).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    validate_file(&file)?;
    Ok(true)
}

fn load_or_create_identity(path: &Path) -> Result<StoredIdentity, DureClientViewIdentityError> {
    let lock = open_identity_lock(path)?;
    lock.lock_exclusive().map_err(io_error)?;
    match read_identity(path) {
        Ok(identity) => return Ok(identity),
        Err(error) if error.code != "client_view_identity_unavailable" => return Err(error),
        Err(_) => {}
    }
    let identity = fresh_identity()?;
    if create_identity(path, &identity)? {
        return Ok(identity);
    }
    read_identity(path)
}

#[tauri::command]
pub fn dure_client_view_local_identity(
) -> Result<DureClientViewLocalIdentity, DureClientViewIdentityError> {
    let channel = crate::app_channel::current().map_err(io_error)?;
    let stored = load_or_create_identity(&channel.control_dir.join(IDENTITY_FILE))?;
    Ok(DureClientViewLocalIdentity {
        schema_version: IDENTITY_SCHEMA_VERSION,
        // These are logical personal-backend namespace labels, not an
        // authorization decision. A shared remote listener must bind tenant
        // and user identity at its authenticated server boundary.
        namespace: ClientViewNamespaceV1 {
            tenant_id: TenantIdV1::new("personal").expect("static tenant id is valid"),
            user_id: UserIdV1::new("owner").expect("static user id is valid"),
            client_id: stored.client_id,
        },
        client_instance_id: stored.client_instance_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn identity_is_owner_only_and_stable_across_reopen() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(IDENTITY_FILE);
        let first = load_or_create_identity(&path).unwrap();
        let second = load_or_create_identity(&path).unwrap();
        assert_eq!(first, second);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn concurrent_initialization_adopts_the_single_created_identity() {
        let root = tempfile::tempdir().unwrap();
        let path = Arc::new(root.path().join(IDENTITY_FILE));
        let barrier = Arc::new(Barrier::new(5));
        let mut threads = Vec::new();
        for _ in 0..4 {
            let path = path.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                load_or_create_identity(&path).unwrap()
            }));
        }
        barrier.wait();
        let identities = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert!(identities.iter().all(|identity| identity == &identities[0]));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_and_group_readable_identity_fail_closed() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target.json");
        let identity = fresh_identity().unwrap();
        assert!(create_identity(&target, &identity).unwrap());
        let link = root.path().join("link.json");
        symlink(&target, &link).unwrap();
        assert_eq!(
            load_or_create_identity(&link).unwrap_err().code,
            "client_view_identity_unavailable"
        );

        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(
            load_or_create_identity(&target).unwrap_err().code,
            "client_view_identity_unsafe"
        );
    }

    #[test]
    fn malformed_identity_is_preserved_and_rejected() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(IDENTITY_FILE);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path).unwrap().write_all(b"{}\n").unwrap();
        assert_eq!(
            load_or_create_identity(&path).unwrap_err().code,
            "client_view_identity_invalid"
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"{}\n");
    }
}
