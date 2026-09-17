use super::discovery_state_gc::MAINTENANCE_LOCK_FILE_NAME;
use super::manifest_store::LifetimeLock;
use super::{DiscoveryError, private_storage};
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

const DIRECTORY_NAME: &str = ".terminal-history-v2";
const LEASE_FILE_NAME: &str = "lease.lock";
const ROOT_FILE_NAME: &str = "root.pb";
const MAX_TEMP_FILE_ATTEMPTS: usize = 64;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Private runtime-scoped byte storage for one stable terminal history.
///
/// A session handle starts unbound. The Host binds it to the stable
/// history-namespace/store identity from its selected checkpoint, then holds
/// an exclusive lease for that identity. Rehosts therefore adopt the same
/// archive without putting paths or bytes in a client-owned request.
#[derive(Clone, Debug)]
pub(crate) struct ColdHistoryStorage {
    root_path: PathBuf,
    lifetime_lock: Option<Arc<LifetimeLock>>,
    binding: Option<Arc<ColdHistoryStorageBinding>>,
}

#[derive(Debug)]
struct ColdHistoryStorageBinding {
    directory: PathBuf,
    lease: Option<File>,
    _lifetime_lock: Option<Arc<LifetimeLock>>,
    _maintenance_lock: Option<File>,
}

impl Drop for ColdHistoryStorageBinding {
    fn drop(&mut self) {
        if let Some(lease) = &self.lease {
            let _ = FileExt::unlock(lease);
        }
    }
}

impl ColdHistoryStorage {
    pub(super) fn open(
        root_path: PathBuf,
        lifetime_lock: Arc<LifetimeLock>,
    ) -> Result<Self, DiscoveryError> {
        private_storage::validate_directory(&root_path)?;
        Ok(Self {
            root_path,
            lifetime_lock: Some(lifetime_lock),
            binding: None,
        })
    }

    pub(crate) fn bind(
        mut self,
        history_namespace: &str,
        store_id: &str,
    ) -> Result<Self, DiscoveryError> {
        if self.binding.is_some() || history_namespace.is_empty() || store_id.is_empty() {
            return Err(DiscoveryError::LockScopeMismatch);
        }
        let lifetime_lock = self
            .lifetime_lock
            .take()
            .ok_or(DiscoveryError::LockScopeMismatch)?;
        self.bind_inner(history_namespace, store_id, Some(lifetime_lock), false)
    }

    pub(crate) fn open_adoption(root_path: PathBuf) -> Result<Self, DiscoveryError> {
        private_storage::validate_directory(&root_path)?;
        Ok(Self {
            root_path,
            lifetime_lock: None,
            binding: None,
        })
    }

    pub(crate) fn bind_adoption(
        self,
        history_namespace: &str,
        store_id: &str,
    ) -> Result<Self, DiscoveryError> {
        if self.lifetime_lock.is_some() {
            return Err(DiscoveryError::LockScopeMismatch);
        }
        self.bind_inner(history_namespace, store_id, None, true)
    }

    fn bind_inner(
        mut self,
        history_namespace: &str,
        store_id: &str,
        lifetime_lock: Option<Arc<LifetimeLock>>,
        retain_maintenance: bool,
    ) -> Result<Self, DiscoveryError> {
        if self.binding.is_some() || history_namespace.is_empty() || store_id.is_empty() {
            return Err(DiscoveryError::LockScopeMismatch);
        }
        // GC holds this lock exclusively while it performs its reference
        // census and archive quarantine. A new Host holds it shared only until
        // its exact archive lease is acquired, closing the rename/recreate
        // race without pinning discovery GC for the Host lifetime.
        let maintenance_path = self.root_path.join(MAINTENANCE_LOCK_FILE_NAME);
        let maintenance = private_storage::open_lock_file(&maintenance_path)?;
        FileExt::lock_shared(&maintenance).map_err(|error| {
            DiscoveryError::io(
                "acquire cold history registration lock",
                &maintenance_path,
                error,
            )
        })?;
        let history_root = self.root_path.join(DIRECTORY_NAME);
        private_storage::create_directory(&history_root)?;
        private_storage::sync_directory(&self.root_path)?;
        let directory = history_root.join(history_directory_name(history_namespace, store_id));
        private_storage::create_directory(&directory)?;
        private_storage::sync_directory(&history_root)?;
        let lease_path = directory.join(LEASE_FILE_NAME);
        let lease = private_storage::open_lock_file(&lease_path)?;
        match FileExt::try_lock_exclusive(&lease) {
            Ok(()) => {}
            Err(error) if super::file_lock::is_contended(&error) => {
                return Err(DiscoveryError::AlreadyLocked { path: lease_path });
            }
            Err(error) => {
                return Err(DiscoveryError::io(
                    "acquire cold history lease",
                    &lease_path,
                    error,
                ));
            }
        }
        let maintenance_lock = if retain_maintenance {
            Some(maintenance)
        } else {
            let _ = FileExt::unlock(&maintenance);
            None
        };
        self.binding = Some(Arc::new(ColdHistoryStorageBinding {
            directory,
            lease: Some(lease),
            _lifetime_lock: lifetime_lock,
            _maintenance_lock: maintenance_lock,
        }));
        Ok(self)
    }

    /// Opens one immutable checkpoint-selected archive prefix while its
    /// source Host still owns the writer lease. Chunks and published roots are
    /// atomic/immutable; this handle deliberately has no write authority.
    pub(crate) fn inspect(
        root_path: PathBuf,
        history_namespace: &str,
        store_id: &str,
    ) -> Result<Self, DiscoveryError> {
        if history_namespace.is_empty() || store_id.is_empty() {
            return Err(DiscoveryError::LockScopeMismatch);
        }
        private_storage::validate_directory(&root_path)?;
        let history_root = root_path.join(DIRECTORY_NAME);
        private_storage::validate_directory(&history_root)?;
        let directory = history_root.join(history_directory_name(history_namespace, store_id));
        private_storage::validate_directory(&directory)?;
        let lease_path = directory.join(LEASE_FILE_NAME);
        let _ = private_storage::open_existing_file(&lease_path)?;
        Ok(Self {
            root_path,
            lifetime_lock: None,
            binding: Some(Arc::new(ColdHistoryStorageBinding {
                directory,
                lease: None,
                _lifetime_lock: None,
                _maintenance_lock: None,
            })),
        })
    }

    pub(crate) fn read_root(&self, maximum: usize) -> Result<Option<Vec<u8>>, DiscoveryError> {
        self.read_optional(&self.directory()?.join(ROOT_FILE_NAME), maximum)
    }

    pub(crate) fn read_chunk(
        &self,
        transfer_id: u64,
        maximum: usize,
    ) -> Result<Option<Vec<u8>>, DiscoveryError> {
        self.read_optional(&self.chunk_path(transfer_id)?, maximum)
    }

    pub(crate) fn write_chunk(&self, transfer_id: u64, bytes: &[u8]) -> Result<(), DiscoveryError> {
        self.ensure_writer()?;
        self.write_atomic(&self.chunk_path(transfer_id)?, ".chunk.tmp", bytes)
    }

    pub(crate) fn publish_root(&self, bytes: &[u8]) -> Result<(), DiscoveryError> {
        self.ensure_writer()?;
        self.write_atomic(&self.directory()?.join(ROOT_FILE_NAME), ".root.tmp", bytes)
    }

    fn ensure_writer(&self) -> Result<(), DiscoveryError> {
        if self
            .binding
            .as_ref()
            .is_some_and(|binding| binding.lease.is_some())
        {
            Ok(())
        } else {
            Err(DiscoveryError::LockScopeMismatch)
        }
    }

    fn directory(&self) -> Result<&Path, DiscoveryError> {
        self.binding
            .as_ref()
            .map(|binding| binding.directory.as_path())
            .ok_or(DiscoveryError::LockScopeMismatch)
    }

    fn chunk_path(&self, transfer_id: u64) -> Result<PathBuf, DiscoveryError> {
        Ok(self
            .directory()?
            .join(format!("chunk-{transfer_id:020}.bin")))
    }

    fn read_optional(
        &self,
        path: &Path,
        maximum: usize,
    ) -> Result<Option<Vec<u8>>, DiscoveryError> {
        if !private_storage::path_entry_exists(path)? {
            return Ok(None);
        }
        let mut file = private_storage::open_existing_file(path)?;
        let length = file
            .metadata()
            .map_err(|error| DiscoveryError::io("inspect cold history file", path, error))?
            .len();
        if length > maximum as u64 {
            return Err(DiscoveryError::io(
                "bound cold history file",
                path,
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "cold history file exceeds its bound",
                ),
            ));
        }
        let mut bytes = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
        Read::by_ref(&mut file)
            .take(maximum.saturating_add(1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| DiscoveryError::io("read cold history file", path, error))?;
        if bytes.len() > maximum {
            return Err(DiscoveryError::io(
                "bound cold history file",
                path,
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "cold history file exceeds its bound",
                ),
            ));
        }
        Ok(Some(bytes))
    }

    fn write_atomic(
        &self,
        target: &Path,
        temporary_prefix: &str,
        bytes: &[u8],
    ) -> Result<(), DiscoveryError> {
        let (temporary, mut file) = self.create_temporary(temporary_prefix)?;
        let result = (|| {
            file.write_all(bytes).map_err(|error| {
                DiscoveryError::io("write cold history temporary file", &temporary, error)
            })?;
            file.sync_all().map_err(|error| {
                DiscoveryError::io("sync cold history temporary file", &temporary, error)
            })?;
            drop(file);
            private_storage::replace_file(&temporary, target)?;
            private_storage::sync_directory(self.directory()?)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn create_temporary(&self, prefix: &str) -> Result<(PathBuf, File), DiscoveryError> {
        for _ in 0..MAX_TEMP_FILE_ATTEMPTS {
            let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = self
                .directory()?
                .join(format!("{prefix}-{}-{sequence}", std::process::id()));
            match private_storage::open_new_file(&path) {
                Ok(file) => return Ok((path, file)),
                Err(DiscoveryError::Io { source, .. })
                    if source.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        Err(DiscoveryError::TemporaryFileCollisionLimit {
            attempts: MAX_TEMP_FILE_ATTEMPTS,
        })
    }
}

pub(super) fn history_directory_name(history_namespace: &str, store_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"hmux-terminal-history-storage-v1");
    hasher.update((history_namespace.len() as u64).to_le_bytes());
    hasher.update(history_namespace.as_bytes());
    hasher.update((store_id.len() as u64).to_le_bytes());
    hasher.update(store_id.as_bytes());
    format!("h_{:x}", hasher.finalize())
}
