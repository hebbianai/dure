use super::DiscoveryMaintenanceLock;
use super::discovery_key::SessionIdLookupKey;
use super::private_storage;
use super::{
    DiscoveryError, DiscoveryKey, DiscoveryManifest, ExitedManifest, ManifestGeneration,
    ManifestLimits, ReadyManifest, SessionLookupKey, StartingManifest,
};
#[cfg(feature = "local-runtime")]
use super::{
    PRESENTATION_CHECKPOINT_MAX_BYTES, PresentationCheckpoint, PresentationCheckpointHandoff,
    PresentationCheckpointSource,
};
use fs2::FileExt;
#[cfg(feature = "local-runtime")]
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(feature = "ghostty-core-proof")]
use super::ColdHistoryStorage;
#[cfg(feature = "ghostty-core-proof")]
use crate::terminal_replay::{TerminalReplay, TerminalReplayLimits};

mod creation_admission;
mod retired_manifest_store;
use super::registration_capacity::{self, DiscoveryRegistrationCapacity};

const MANIFEST_FILE_NAME: &str = "manifest.json";
#[cfg(feature = "local-runtime")]
const PRESENTATION_CHECKPOINT_FILE_NAME: &str = "presentation.json";
#[cfg(feature = "local-runtime")]
pub(super) const PRESENTATION_HANDOFF_FILE_PREFIX: &str = "presentation-handoff-";
#[cfg(feature = "local-runtime")]
const PRESENTATION_HANDOFF_MAX_BYTES: usize = PRESENTATION_CHECKPOINT_MAX_BYTES;
const LIFETIME_LOCK_FILE_NAME: &str = "lifetime.lock";
const RETIRED_DIRECTORY_NAME: &str = "retired";
const MAX_TEMP_FILE_ATTEMPTS: usize = 64;
const MAX_CURRENT_MANIFEST_OPEN_ATTEMPTS: usize = 3;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[cfg(feature = "local-runtime")]
trait PresentationCheckpointIo {
    fn write_all(
        &mut self,
        file: &mut File,
        bytes: &[u8],
        path: &Path,
    ) -> Result<(), DiscoveryError>;
    fn sync_file(&mut self, file: &File, path: &Path) -> Result<(), DiscoveryError>;
    fn atomic_replace(&mut self, source: &Path, target: &Path) -> Result<(), DiscoveryError>;
    fn sync_directory(&mut self, path: &Path) -> Result<(), DiscoveryError>;

    fn cleanup_temporary_on_failure(&self) -> bool {
        true
    }
}

#[cfg(feature = "local-runtime")]
struct SystemPresentationCheckpointIo;

#[cfg(feature = "local-runtime")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PresentationCheckpointWritePhase {
    Validation,
    Serialization,
    Write,
    FileSync,
    AtomicReplace,
    DirectorySync,
}

#[cfg(feature = "local-runtime")]
#[derive(Debug)]
pub struct PresentationCheckpointWriteError {
    phase: PresentationCheckpointWritePhase,
    source: DiscoveryError,
}

#[cfg(feature = "local-runtime")]
impl PresentationCheckpointWriteError {
    fn new(phase: PresentationCheckpointWritePhase, source: DiscoveryError) -> Self {
        Self { phase, source }
    }

    #[must_use]
    pub fn phase(&self) -> PresentationCheckpointWritePhase {
        self.phase
    }

    #[must_use]
    pub fn discovery_error(&self) -> &DiscoveryError {
        &self.source
    }

    #[must_use]
    pub fn into_discovery_error(self) -> DiscoveryError {
        self.source
    }
}

#[cfg(feature = "local-runtime")]
impl std::fmt::Display for PresentationCheckpointWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "presentation checkpoint {:?} phase failed: {}",
            self.phase, self.source
        )
    }
}

#[cfg(feature = "local-runtime")]
impl std::error::Error for PresentationCheckpointWriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

#[cfg(feature = "local-runtime")]
impl PresentationCheckpointIo for SystemPresentationCheckpointIo {
    fn write_all(
        &mut self,
        file: &mut File,
        bytes: &[u8],
        path: &Path,
    ) -> Result<(), DiscoveryError> {
        file.write_all(bytes).map_err(|error| {
            DiscoveryError::io("write temporary presentation checkpoint", path, error)
        })
    }

    fn sync_file(&mut self, file: &File, path: &Path) -> Result<(), DiscoveryError> {
        file.sync_all().map_err(|error| {
            DiscoveryError::io("sync temporary presentation checkpoint", path, error)
        })
    }

    fn atomic_replace(&mut self, source: &Path, target: &Path) -> Result<(), DiscoveryError> {
        private_storage::replace_file(source, target)
    }

    fn sync_directory(&mut self, path: &Path) -> Result<(), DiscoveryError> {
        private_storage::sync_directory(path)
    }
}

#[derive(Debug)]
pub struct DiscoveryRoot {
    path: PathBuf,
    limits: ManifestLimits,
}

impl DiscoveryRoot {
    pub fn create(path: impl Into<PathBuf>) -> Result<Self, DiscoveryError> {
        Self::create_with_limits(path, ManifestLimits::default())
    }

    pub fn create_with_limits(
        path: impl Into<PathBuf>,
        limits: ManifestLimits,
    ) -> Result<Self, DiscoveryError> {
        let path = path.into();
        private_storage::create_directory_all(&path)?;
        Ok(Self { path, limits })
    }

    pub fn open(path: impl Into<PathBuf>) -> Result<Self, DiscoveryError> {
        Self::open_with_limits(path, ManifestLimits::default())
    }

    pub fn open_with_limits(
        path: impl Into<PathBuf>,
        limits: ManifestLimits,
    ) -> Result<Self, DiscoveryError> {
        let path = path.into();
        private_storage::validate_directory(&path)?;
        Ok(Self { path, limits })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn session(&self, key: DiscoveryKey) -> Result<SessionDiscovery, DiscoveryError> {
        // Hold the shared maintenance lease across the pre-manifest window as
        // before, while a separate creator-only lease serializes the capacity
        // count and first directory publication. GC cannot win the path race,
        // and unrelated creators do not overshoot the catalog bound.
        let creation_maintenance = self.acquire_maintenance_shared()?;
        let _registration = self.acquire_registration_exclusive()?;
        let relative = key.relative_path();
        let session_path = self.path.join(&relative);
        let session_existed = private_storage::path_entry_exists(&session_path)?;
        let capacity = registration_capacity::inspect(self)?;
        if !session_existed && capacity.remaining == 0 {
            return Err(DiscoveryError::RegistrationCapacityExceeded {
                used: capacity.used,
                maximum: capacity.maximum,
                remaining: capacity.remaining,
            });
        }
        let mut path = self.path.clone();
        let mut created_paths = Vec::new();
        for component in relative.components() {
            path.push(component);
            let existed = match private_storage::path_entry_exists(&path) {
                Ok(existed) => existed,
                Err(error) => {
                    rollback_created_paths(&created_paths, &session_path);
                    return Err(error);
                }
            };
            if let Err(error) = private_storage::create_directory(&path) {
                rollback_created_paths(&created_paths, &session_path);
                return Err(error);
            }
            if !existed {
                created_paths.push(path.clone());
            }
        }
        let reservation =
            (!session_existed).then(|| RegistrationReservation::new(session_path, created_paths));
        Ok(SessionDiscovery {
            key,
            path,
            root_path: self.path.clone(),
            limits: self.limits.clone(),
            creation_admission: Some(Arc::new(Mutex::new(Some(CreationAdmission {
                reservation,
                maintenance: Some(creation_maintenance),
            })))),
        })
    }

    pub fn open_session(&self, key: DiscoveryKey) -> Result<SessionDiscovery, DiscoveryError> {
        let relative = key.relative_path();
        let mut path = self.path.clone();
        private_storage::validate_directory(&path)?;
        for component in relative.components() {
            path.push(component);
            private_storage::validate_directory(&path)?;
        }
        Ok(SessionDiscovery {
            key,
            path,
            root_path: self.path.clone(),
            limits: self.limits.clone(),
            creation_admission: None,
        })
    }

    pub fn open_session_if_present(
        &self,
        key: DiscoveryKey,
    ) -> Result<Option<SessionDiscovery>, DiscoveryError> {
        let base = self.path.join(key.relative_path());
        if !private_storage::path_entry_exists(&base)? {
            return Ok(None);
        }
        self.open_session(key).map(Some)
    }

    #[must_use]
    pub fn session_base_path(&self, key: &SessionLookupKey) -> PathBuf {
        self.path.join(key.relative_path())
    }

    pub fn find_manifest_by_session(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<super::DiscoveredSession, DiscoveryError> {
        let key = SessionLookupKey::new(workspace_id, session_id)?;
        super::session_lookup::find_unique(self, &key)
    }

    /// Resolve the complete current lifecycle record, including `Starting`,
    /// through the same bounded path and manifest validation as ordinary
    /// discovery. Runtime recovery uses this only after it already owns the
    /// exact logical create identity; attach and catalog APIs continue to
    /// project `Starting` as not ready.
    pub fn find_current_manifest_by_session(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<super::DiscoveredSession, DiscoveryError> {
        let key = SessionLookupKey::new(workspace_id, session_id)?;
        super::session_lookup::find_unique_current(self, &key)
    }

    /// Resolve every discoverable current generation with one exact opaque
    /// session id while opening only its deterministic path in each workspace.
    pub fn list_sessions_by_id(
        &self,
        session_id: &str,
    ) -> Result<Vec<super::DiscoveredSession>, DiscoveryError> {
        let key = SessionIdLookupKey::new(session_id)?;
        super::session_lookup::list_sessions_by_id(self, &key)
    }

    /// Read-only census of every discoverable session under this root. Used by
    /// the daemon-free standalone `ls` verb; see `session_lookup::list_sessions`
    /// for the private_storage and tolerance guarantees.
    pub fn list_sessions(&self) -> Result<Vec<super::DiscoveredSession>, DiscoveryError> {
        super::session_lookup::list_sessions(self)
    }

    /// Return one complete catalog with a separate hard result bound.
    pub fn list_sessions_bounded(
        &self,
        maximum: usize,
    ) -> Result<Vec<super::DiscoveredSession>, DiscoveryError> {
        super::session_lookup::list_sessions_bounded(self, maximum)
    }

    /// Scan the complete catalog while a caller retains only its bounded
    /// projection. This is the streaming counterpart to
    /// [`Self::list_sessions_bounded`].
    pub fn visit_sessions(
        &self,
        observe: impl FnMut(super::DiscoveredSession),
    ) -> Result<(), DiscoveryError> {
        super::session_lookup::visit_sessions(self, observe)
    }

    /// Return only exact human-facing name matches without materializing the
    /// complete catalog.
    pub fn list_sessions_named(
        &self,
        name: &str,
    ) -> Result<Vec<super::DiscoveredSession>, DiscoveryError> {
        super::session_lookup::list_sessions_named(self, name)
    }

    /// Report the serialized logical-session registration budget.
    pub fn registration_capacity(&self) -> Result<DiscoveryRegistrationCapacity, DiscoveryError> {
        let _maintenance = self.acquire_maintenance_shared()?;
        registration_capacity::inspect(self)
    }

    /// Bounded exited-only census for explicit retirement tooling.
    pub fn list_exited_sessions(
        &self,
        maximum: usize,
    ) -> Result<super::ExitedSessionCensus, DiscoveryError> {
        self.list_exited_sessions_after(maximum, None)
    }

    /// Bounded exited-only census strictly after one deterministic identity.
    pub fn list_exited_sessions_after(
        &self,
        maximum: usize,
        after: Option<&DiscoveryKey>,
    ) -> Result<super::ExitedSessionCensus, DiscoveryError> {
        super::session_lookup::list_exited_sessions(self, maximum, after)
    }

    pub(super) fn limits(&self) -> &ManifestLimits {
        &self.limits
    }
}

#[derive(Clone, Debug)]
pub struct SessionDiscovery {
    key: DiscoveryKey,
    path: PathBuf,
    root_path: PathBuf,
    limits: ManifestLimits,
    creation_admission: Option<Arc<Mutex<Option<CreationAdmission>>>>,
}

impl SessionDiscovery {
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub fn manifest_path(&self) -> PathBuf {
        self.path.join(MANIFEST_FILE_NAME)
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub(crate) fn cold_history_storage(
        &self,
        lock: Arc<LifetimeLock>,
    ) -> Result<ColdHistoryStorage, DiscoveryError> {
        self.ensure_lock(&lock)?;
        ColdHistoryStorage::open(self.root_path.clone(), lock)
    }

    #[cfg(feature = "local-runtime")]
    pub fn write_presentation_checkpoint(
        &self,
        lock: &LifetimeLock,
        checkpoint: &PresentationCheckpoint,
    ) -> Result<(), DiscoveryError> {
        self.write_presentation_checkpoint_detailed(lock, checkpoint)
            .map_err(PresentationCheckpointWriteError::into_discovery_error)
    }

    #[cfg(feature = "local-runtime")]
    pub fn write_presentation_checkpoint_detailed(
        &self,
        lock: &LifetimeLock,
        checkpoint: &PresentationCheckpoint,
    ) -> Result<(), PresentationCheckpointWriteError> {
        self.write_presentation_checkpoint_with_io(
            lock,
            checkpoint,
            &mut SystemPresentationCheckpointIo,
        )
    }

    #[cfg(feature = "local-runtime")]
    fn write_presentation_checkpoint_with_io(
        &self,
        lock: &LifetimeLock,
        checkpoint: &PresentationCheckpoint,
        checkpoint_io: &mut dyn PresentationCheckpointIo,
    ) -> Result<(), PresentationCheckpointWriteError> {
        self.ensure_lock(lock).map_err(|error| {
            PresentationCheckpointWriteError::new(
                PresentationCheckpointWritePhase::Validation,
                error,
            )
        })?;
        checkpoint.validate().map_err(|error| {
            PresentationCheckpointWriteError::new(
                PresentationCheckpointWritePhase::Validation,
                error,
            )
        })?;
        let source_key = checkpoint.source().discovery_key().map_err(|error| {
            PresentationCheckpointWriteError::new(
                PresentationCheckpointWritePhase::Validation,
                error,
            )
        })?;
        if source_key != self.key {
            return Err(PresentationCheckpointWriteError::new(
                PresentationCheckpointWritePhase::Validation,
                DiscoveryError::PresentationCheckpointInvalid {
                    reason: "source discovery key",
                },
            ));
        }
        let DiscoveryManifest::Ready(ready) = self.read_manifest().map_err(|error| {
            PresentationCheckpointWriteError::new(
                PresentationCheckpointWritePhase::Validation,
                error,
            )
        })?
        else {
            return Err(PresentationCheckpointWriteError::new(
                PresentationCheckpointWritePhase::Validation,
                DiscoveryError::PresentationCheckpointInvalid {
                    reason: "source lifecycle",
                },
            ));
        };
        if PresentationCheckpointSource::from_ready(&ready) != *checkpoint.source() {
            return Err(PresentationCheckpointWriteError::new(
                PresentationCheckpointWritePhase::Validation,
                DiscoveryError::PresentationCheckpointInvalid {
                    reason: "source fence",
                },
            ));
        }
        let bytes = serde_json::to_vec(checkpoint)
            .map_err(DiscoveryError::Serialization)
            .map_err(|error| {
                PresentationCheckpointWriteError::new(
                    PresentationCheckpointWritePhase::Serialization,
                    error,
                )
            })?;
        if bytes.len() > PRESENTATION_CHECKPOINT_MAX_BYTES {
            return Err(PresentationCheckpointWriteError::new(
                PresentationCheckpointWritePhase::Serialization,
                DiscoveryError::PresentationCheckpointTooLarge {
                    actual: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
                    maximum: PRESENTATION_CHECKPOINT_MAX_BYTES,
                },
            ));
        }
        let (temp_path, mut file) =
            self.create_temporary_file(".presentation.tmp")
                .map_err(|error| {
                    PresentationCheckpointWriteError::new(
                        PresentationCheckpointWritePhase::Write,
                        error,
                    )
                })?;
        let checkpoint_path = self.path.join(PRESENTATION_CHECKPOINT_FILE_NAME);
        let write_result = (|| {
            checkpoint_io
                .write_all(&mut file, &bytes, &temp_path)
                .map_err(|error| {
                    PresentationCheckpointWriteError::new(
                        PresentationCheckpointWritePhase::Write,
                        error,
                    )
                })?;
            checkpoint_io
                .sync_file(&file, &temp_path)
                .map_err(|error| {
                    PresentationCheckpointWriteError::new(
                        PresentationCheckpointWritePhase::FileSync,
                        error,
                    )
                })?;
            drop(file);
            checkpoint_io
                .atomic_replace(&temp_path, &checkpoint_path)
                .map_err(|error| {
                    PresentationCheckpointWriteError::new(
                        PresentationCheckpointWritePhase::AtomicReplace,
                        error,
                    )
                })?;
            checkpoint_io.sync_directory(&self.path).map_err(|error| {
                PresentationCheckpointWriteError::new(
                    PresentationCheckpointWritePhase::DirectorySync,
                    error,
                )
            })
        })();
        if write_result.is_err() && checkpoint_io.cleanup_temporary_on_failure() {
            let _ = fs::remove_file(&temp_path);
        }
        write_result
    }

    #[cfg(feature = "local-runtime")]
    pub fn read_presentation_checkpoint(
        &self,
        source: &PresentationCheckpointSource,
    ) -> Result<Option<PresentationCheckpoint>, DiscoveryError> {
        source.validate()?;
        if source.discovery_key()? != self.key {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "source discovery key",
            });
        }
        let path = self.path.join(PRESENTATION_CHECKPOINT_FILE_NAME);
        if !private_storage::path_entry_exists(&path)? {
            return Ok(None);
        }
        let mut file = private_storage::open_existing_file(&path)?;
        let length = file
            .metadata()
            .map_err(|error| DiscoveryError::io("inspect presentation checkpoint", &path, error))?
            .len();
        if length > PRESENTATION_CHECKPOINT_MAX_BYTES as u64 {
            return Err(DiscoveryError::PresentationCheckpointTooLarge {
                actual: length,
                maximum: PRESENTATION_CHECKPOINT_MAX_BYTES,
            });
        }
        let mut bytes = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
        Read::by_ref(&mut file)
            .take((PRESENTATION_CHECKPOINT_MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| DiscoveryError::io("read presentation checkpoint", &path, error))?;
        if bytes.len() > PRESENTATION_CHECKPOINT_MAX_BYTES {
            return Err(DiscoveryError::PresentationCheckpointTooLarge {
                actual: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
                maximum: PRESENTATION_CHECKPOINT_MAX_BYTES,
            });
        }
        let checkpoint: PresentationCheckpoint =
            serde_json::from_slice(&bytes).map_err(DiscoveryError::Serialization)?;
        checkpoint.validate()?;
        if checkpoint.source() != source {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "source fence",
            });
        }
        Ok(Some(checkpoint))
    }

    /// Persist an immutable, exact presentation input while the source
    /// generation is still Ready. The managed-rehost source lock serializes
    /// callers; the Host lifetime lock remains owned by the live source.
    #[cfg(feature = "local-runtime")]
    pub fn write_presentation_handoff(
        &self,
        source: &PresentationCheckpointSource,
        checkpoint: &PresentationCheckpoint,
    ) -> Result<PresentationCheckpointHandoff, DiscoveryError> {
        source.validate()?;
        checkpoint.validate()?;
        if source.discovery_key()? != self.key || checkpoint.source() != source {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "presentation handoff identity",
            });
        }
        let DiscoveryManifest::Ready(ready) = self.read_manifest()? else {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "presentation handoff source lifecycle",
            });
        };
        if PresentationCheckpointSource::from_ready(&ready) != *source {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "presentation handoff source fence",
            });
        }
        let bytes = serde_json::to_vec(checkpoint).map_err(DiscoveryError::Serialization)?;
        if bytes.len() > PRESENTATION_CHECKPOINT_MAX_BYTES {
            return Err(DiscoveryError::PresentationCheckpointTooLarge {
                actual: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
                maximum: PRESENTATION_CHECKPOINT_MAX_BYTES,
            });
        }
        let checkpoint_digest = Sha256::digest(&bytes);
        let source_identity = presentation_handoff_source_identity(source)?;
        let handoff = PresentationCheckpointHandoff::new(
            format!("{source_identity}-{:x}", checkpoint_digest),
            checkpoint_digest.into(),
        );
        let target = self.path.join(format!(
            "{PRESENTATION_HANDOFF_FILE_PREFIX}{}.json",
            handoff.file_id()
        ));
        if private_storage::path_entry_exists(&target)? {
            let existing = self.read_presentation_handoff(source, &handoff)?;
            if existing == *checkpoint {
                return Ok(handoff);
            }
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "presentation handoff collision",
            });
        }
        let (temporary, mut file) = self.create_temporary_file(".presentation-handoff.tmp")?;
        let result = (|| {
            file.write_all(&bytes).map_err(|error| {
                DiscoveryError::io("write presentation handoff", &temporary, error)
            })?;
            file.sync_all().map_err(|error| {
                DiscoveryError::io("sync presentation handoff", &temporary, error)
            })?;
            drop(file);
            private_storage::replace_file(&temporary, &target)?;
            private_storage::sync_directory(&self.path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map(|()| handoff)
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub fn write_rehost_presentation_handoff(
        &self,
        source: &PresentationCheckpointSource,
        checkpoint: &PresentationCheckpoint,
        target_store_id: &str,
        limits: &TerminalReplayLimits,
    ) -> Result<PresentationCheckpointHandoff, DiscoveryError> {
        let terminal_checkpoint = checkpoint.terminal_checkpoint();
        let adoption = TerminalReplay::adopt_durable_checkpoint(
            &self.root_path,
            &terminal_checkpoint,
            target_store_id,
            limits,
        )
        .map_err(|_| DiscoveryError::PresentationCheckpointInvalid {
            reason: "cold history adoption",
        })?;
        let adopted_checkpoint = checkpoint.clone().with_cold_history(
            adoption
                .as_ref()
                .map(|adoption| adoption.checkpoint().clone()),
        )?;
        // The adoption handle retains both the target archive lease and the
        // shared GC-maintenance lock through immutable handoff publication.
        // The target Host may acquire the exclusive archive only after this
        // durable reference is visible.
        let handoff = self.write_presentation_handoff(source, &adopted_checkpoint)?;
        drop(adoption);
        Ok(handoff)
    }

    #[cfg(feature = "local-runtime")]
    pub fn read_presentation_handoff(
        &self,
        source: &PresentationCheckpointSource,
        handoff: &PresentationCheckpointHandoff,
    ) -> Result<PresentationCheckpoint, DiscoveryError> {
        source.validate()?;
        handoff.validate()?;
        if source.discovery_key()? != self.key {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "presentation handoff discovery key",
            });
        }
        let expected_source_identity = presentation_handoff_source_identity(source)?;
        if handoff
            .file_id()
            .split_once('-')
            .is_none_or(|(source_identity, _)| source_identity != expected_source_identity)
        {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "presentation handoff source identity",
            });
        }
        let path = self.path.join(format!(
            "{PRESENTATION_HANDOFF_FILE_PREFIX}{}.json",
            handoff.file_id()
        ));
        let mut file = private_storage::open_existing_file(&path)?;
        let length = file
            .metadata()
            .map_err(|error| DiscoveryError::io("inspect presentation handoff", &path, error))?
            .len();
        if length > PRESENTATION_HANDOFF_MAX_BYTES as u64 {
            return Err(DiscoveryError::PresentationCheckpointTooLarge {
                actual: length,
                maximum: PRESENTATION_HANDOFF_MAX_BYTES,
            });
        }
        let mut bytes = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
        Read::by_ref(&mut file)
            .take(PRESENTATION_HANDOFF_MAX_BYTES.saturating_add(1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| DiscoveryError::io("read presentation handoff", &path, error))?;
        if bytes.len() > PRESENTATION_HANDOFF_MAX_BYTES
            || <[u8; 32]>::from(Sha256::digest(&bytes)) != handoff.checkpoint_digest()
        {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "presentation handoff digest",
            });
        }
        let checkpoint: PresentationCheckpoint =
            serde_json::from_slice(&bytes).map_err(DiscoveryError::Serialization)?;
        checkpoint.validate()?;
        if checkpoint.source() != source {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "presentation handoff source fence",
            });
        }
        Ok(checkpoint)
    }

    /// Retires one exact immutable handoff after a successor generation was
    /// itself exactly stopped. Removing the durable reference lets ordinary
    /// reference-aware cold GC reclaim an abandoned target archive; it never
    /// mutates the still-live source checkpoint or archive.
    #[cfg(feature = "local-runtime")]
    pub fn remove_presentation_handoff(
        &self,
        source: &PresentationCheckpointSource,
        handoff: &PresentationCheckpointHandoff,
    ) -> Result<(), DiscoveryError> {
        source.validate()?;
        handoff.validate()?;
        if source.discovery_key()? != self.key {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "presentation handoff discovery key",
            });
        }
        let expected_source_identity = presentation_handoff_source_identity(source)?;
        if handoff
            .file_id()
            .split_once('-')
            .is_none_or(|(source_identity, _)| source_identity != expected_source_identity)
        {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "presentation handoff source identity",
            });
        }
        let DiscoveryManifest::Ready(ready) = self.read_manifest()? else {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "presentation handoff source lifecycle",
            });
        };
        if PresentationCheckpointSource::from_ready(&ready) != *source {
            return Err(DiscoveryError::PresentationCheckpointInvalid {
                reason: "presentation handoff source fence",
            });
        }
        let path = self.path.join(format!(
            "{PRESENTATION_HANDOFF_FILE_PREFIX}{}.json",
            handoff.file_id()
        ));
        if !private_storage::path_entry_exists(&path)? {
            return Ok(());
        }
        // Verify both the owner-only file and its content digest immediately
        // before deletion. A changed path is corruption, never cleanup input.
        let _ = self.read_presentation_handoff(source, handoff)?;
        fs::remove_file(&path)
            .map_err(|error| DiscoveryError::io("remove presentation handoff", &path, error))?;
        private_storage::sync_directory(&self.path)
    }

    pub fn acquire_lifetime_lock(&self) -> Result<LifetimeLock, DiscoveryError> {
        let root = DiscoveryRoot {
            path: self.root_path.clone(),
            limits: self.limits.clone(),
        };
        let mut creation_admission = match &self.creation_admission {
            Some(admission) => admission
                .lock()
                .map_err(|_| DiscoveryError::LockScopeMismatch)?
                .take(),
            None => None,
        };
        let maintenance = if creation_admission.is_none() {
            Some(root.acquire_maintenance_shared()?)
        } else {
            None
        };
        let path = self.path.join(LIFETIME_LOCK_FILE_NAME);
        let file = match private_storage::open_lock_file(&path) {
            Ok(file) => file,
            Err(error) => {
                drop(creation_admission);
                return Err(error);
            }
        };
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => {
                drop(maintenance);
                if let Some(admission) = creation_admission.as_mut() {
                    admission.release_maintenance();
                }
                Ok(LifetimeLock {
                    file,
                    session_path: self.path.clone(),
                    key: self.key.clone(),
                    creation_admission: Mutex::new(creation_admission),
                })
            }
            Err(error) if super::file_lock::is_contended(&error) => {
                drop(creation_admission);
                Err(DiscoveryError::AlreadyLocked { path })
            }
            Err(error) => {
                drop(creation_admission);
                Err(DiscoveryError::io("acquire lifetime lock", &path, error))
            }
        }
    }

    pub fn rebind_retired_lifetime_lock(
        &self,
        lock: &mut LifetimeLock,
        predecessor: &ManifestGeneration,
    ) -> Result<(), DiscoveryError> {
        if lock.session_path != self.path {
            return Err(DiscoveryError::LockScopeMismatch);
        }
        let Some(retired) = self.find_retired_exited_generation(predecessor)? else {
            return Err(DiscoveryError::GenerationMismatch);
        };
        if DiscoveryManifest::Exited(retired).generation() != *predecessor {
            return Err(DiscoveryError::GenerationMismatch);
        }
        // Why: runner instance and channel epoch fence provider generations,
        // while the OS lifetime lock fences the one retained Host for the
        // logical workspace/session path. Rebinding only after the exact
        // predecessor tombstone is durably retired lets that same Host publish
        // its successor without releasing the lock and admitting a duplicate
        // provider in the handoff gap.
        lock.key = self.key.clone();
        Ok(())
    }

    pub fn publish_exited(
        &self,
        lock: &LifetimeLock,
        manifest: ExitedManifest,
    ) -> Result<(), DiscoveryError> {
        self.ensure_lock(lock)?;
        let candidate = DiscoveryManifest::Exited(manifest);
        self.validate_for_key(&candidate)?;
        match self.try_read_manifest()? {
            Some(DiscoveryManifest::Starting(current))
                if current.common == candidate.common().clone() => {}
            Some(DiscoveryManifest::Ready(current))
                if current.common == candidate.common().clone() => {}
            Some(DiscoveryManifest::Exited(current))
                if DiscoveryManifest::Exited(current.clone()) == candidate =>
            {
                return Ok(());
            }
            Some(_) => return Err(DiscoveryError::ManifestConflict),
            None => {
                return Err(DiscoveryError::InvalidManifestTransition {
                    from: "missing",
                    to: "exited",
                });
            }
        }
        self.write_manifest(&candidate)
    }

    pub fn publish_ready(
        &self,
        lock: &LifetimeLock,
        manifest: ReadyManifest,
    ) -> Result<(), DiscoveryError> {
        self.ensure_lock(lock)?;
        let candidate = DiscoveryManifest::Ready(manifest);
        self.validate_for_key(&candidate)?;
        match self.try_read_manifest()? {
            Some(DiscoveryManifest::Starting(current))
                if current.common == candidate.common().clone() => {}
            Some(DiscoveryManifest::Ready(current))
                if DiscoveryManifest::Ready(current.clone()) == candidate =>
            {
                return Ok(());
            }
            Some(DiscoveryManifest::Exited(current))
                if exited_to_ready_replacement_matches(&current, candidate_ready(&candidate)) => {}
            Some(_) => return Err(DiscoveryError::ManifestConflict),
            None => {
                return Err(DiscoveryError::InvalidManifestTransition {
                    from: "missing",
                    to: "ready",
                });
            }
        }
        self.write_manifest(&candidate)
    }

    /// Atomically replace only the additive standalone retirement contract of
    /// the current ready generation.
    ///
    /// The lifetime lock and exact ready-generation comparison make this a
    /// Host-owned update rather than a same-user edit of discovery JSON.
    pub fn update_ready_retirement_policy(
        &self,
        lock: &LifetimeLock,
        expected: &ManifestGeneration,
        policy: Option<super::SessionRetirementPolicy>,
    ) -> Result<ReadyManifest, DiscoveryError> {
        self.ensure_lock(lock)?;
        if policy.is_some_and(|policy| !policy.is_valid()) {
            return Err(DiscoveryError::ManifestConflict);
        }
        let Some(DiscoveryManifest::Ready(mut ready)) = self.try_read_manifest()? else {
            return Err(DiscoveryError::InvalidManifestTransition {
                from: "non-ready",
                to: "ready",
            });
        };
        if ready.common.session_class.is_managed() {
            return Err(DiscoveryError::ManifestConflict);
        }
        if ready.common.host_process != expected.host_process
            || ready.common.host_instance_id != expected.host_instance_id
            || Some(ready.terminal_epoch.as_str()) != expected.terminal_epoch.as_deref()
        {
            return Err(DiscoveryError::GenerationMismatch);
        }
        ready.common.retirement_policy = policy;
        let candidate = DiscoveryManifest::Ready(ready.clone());
        self.validate_for_key(&candidate)?;
        self.write_manifest(&candidate)?;
        Ok(ready)
    }

    pub fn read_manifest(&self) -> Result<DiscoveryManifest, DiscoveryError> {
        self.try_read_manifest()?.ok_or_else(|| {
            DiscoveryError::io(
                "read discovery manifest",
                &self.manifest_path(),
                io::Error::new(io::ErrorKind::NotFound, "manifest does not exist"),
            )
        })
    }

    pub fn read_manifest_if_present(&self) -> Result<Option<DiscoveryManifest>, DiscoveryError> {
        self.try_read_manifest()
    }

    pub fn has_current_manifest(&self) -> Result<bool, DiscoveryError> {
        self.try_read_manifest().map(|manifest| manifest.is_some())
    }

    pub fn cleanup_current(
        &self,
        lock: &LifetimeLock,
        expected: &ManifestGeneration,
    ) -> Result<bool, DiscoveryError> {
        self.ensure_lock(lock)?;
        let Some(current) = self.try_read_manifest()? else {
            return Ok(false);
        };
        let actual = current.generation();
        if actual != *expected {
            return Err(DiscoveryError::GenerationMismatch);
        }
        let path = self.manifest_path();
        // Reading above opens with O_NOFOLLOW and verifies inode identity. The
        // lifetime lock prevents another cooperative host from replacing the
        // record between exact-generation verification and cleanup.
        fs::remove_file(&path)
            .map_err(|error| DiscoveryError::io("remove current manifest", &path, error))?;
        private_storage::sync_directory(&self.path)?;
        Ok(true)
    }

    fn try_read_manifest(&self) -> Result<Option<DiscoveryManifest>, DiscoveryError> {
        let path = self.manifest_path();
        if !private_storage::path_entry_exists(&path)? {
            return Ok(None);
        }
        let manifest = read_current_manifest_at(&path, &self.limits)?;
        self.validate_for_key(&manifest)?;
        Ok(Some(manifest))
    }

    fn write_manifest(&self, manifest: &DiscoveryManifest) -> Result<(), DiscoveryError> {
        let bytes = serde_json::to_vec(manifest).map_err(DiscoveryError::Serialization)?;
        if bytes.len() > self.limits.max_manifest_bytes {
            return Err(DiscoveryError::ManifestTooLarge {
                actual: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
                maximum: self.limits.max_manifest_bytes,
            });
        }
        let (temp_path, mut file) = self.create_temporary_manifest()?;
        let write_result = (|| {
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|error| {
                    DiscoveryError::io("write temporary manifest", &temp_path, error)
                })?;
            drop(file);
            private_storage::replace_file(&temp_path, &self.manifest_path())?;
            private_storage::sync_directory(&self.path)
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        write_result
    }

    fn create_temporary_manifest(&self) -> Result<(PathBuf, File), DiscoveryError> {
        self.create_temporary_file(".manifest.tmp")
    }

    fn create_temporary_file(&self, prefix: &str) -> Result<(PathBuf, File), DiscoveryError> {
        for _ in 0..MAX_TEMP_FILE_ATTEMPTS {
            let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = self
                .path
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

    fn validate_for_key(&self, manifest: &DiscoveryManifest) -> Result<(), DiscoveryError> {
        manifest.validate(&self.limits)?;
        let lifetime = &manifest.common().lifetime;
        if lifetime.workspace_id != self.key.workspace_id()
            || lifetime.session_id != self.key.session_id()
        {
            return Err(DiscoveryError::ManifestKeyMismatch);
        }
        Ok(())
    }

    fn ensure_lock(&self, lock: &LifetimeLock) -> Result<(), DiscoveryError> {
        if lock.session_path != self.path || lock.key != self.key {
            return Err(DiscoveryError::LockScopeMismatch);
        }
        Ok(())
    }
}

#[cfg(feature = "local-runtime")]
fn presentation_handoff_source_identity(
    source: &PresentationCheckpointSource,
) -> Result<String, DiscoveryError> {
    let mut identity = Sha256::new();
    identity.update(b"hmux-presentation-handoff-v1");
    for component in [
        source.workspace_id(),
        source.session_id(),
        source.runner_principal(),
        source.runner_instance(),
        source.host_instance_id(),
        source.terminal_epoch(),
    ] {
        identity.update(
            u64::try_from(component.len())
                .map_err(|_| DiscoveryError::PresentationCheckpointInvalid {
                    reason: "presentation handoff source identity",
                })?
                .to_le_bytes(),
        );
        identity.update(component.as_bytes());
    }
    identity.update(source.channel_epoch().to_le_bytes());
    Ok(format!("{:x}", identity.finalize()))
}

fn candidate_ready(candidate: &DiscoveryManifest) -> &ReadyManifest {
    let DiscoveryManifest::Ready(ready) = candidate else {
        unreachable!("publish_ready always constructs a Ready candidate")
    };
    ready
}

fn exited_to_ready_replacement_matches(exited: &ExitedManifest, ready: &ReadyManifest) -> bool {
    let mut normalized_successor = ready.common.clone();
    normalized_successor.lifetime.runner_instance = exited.common.lifetime.runner_instance.clone();
    normalized_successor.lifetime.channel_epoch = exited.common.lifetime.channel_epoch;
    normalized_successor == exited.common
        && ready.common.lifetime.channel_epoch > exited.common.lifetime.channel_epoch
        && ready.common.lifetime.runner_instance != exited.common.lifetime.runner_instance
        && ready.terminal_epoch != exited.tombstone.fence.terminal_epoch
}

pub(super) fn read_manifest_at(
    path: &Path,
    limits: &ManifestLimits,
) -> Result<DiscoveryManifest, DiscoveryError> {
    let file = private_storage::open_existing_file(path)?;
    read_manifest_file(path, limits, file)
}

pub(super) fn read_current_manifest_at(
    path: &Path,
    limits: &ManifestLimits,
) -> Result<DiscoveryManifest, DiscoveryError> {
    let file = retry_current_manifest_open(|| private_storage::open_existing_file(path))?;
    read_manifest_file(path, limits, file)
}

fn read_manifest_file(
    path: &Path,
    limits: &ManifestLimits,
    mut file: File,
) -> Result<DiscoveryManifest, DiscoveryError> {
    let length = file
        .metadata()
        .map_err(|error| DiscoveryError::io("inspect manifest length", path, error))?
        .len();
    if length > limits.max_manifest_bytes as u64 {
        return Err(DiscoveryError::ManifestTooLarge {
            actual: length,
            maximum: limits.max_manifest_bytes,
        });
    }
    let mut bytes = Vec::with_capacity(usize::try_from(length).unwrap_or(0));
    file.read_to_end(&mut bytes)
        .map_err(|error| DiscoveryError::io("read manifest", path, error))?;
    let manifest = serde_json::from_slice::<DiscoveryManifest>(&bytes)
        .map_err(DiscoveryError::Serialization)?;
    manifest.validate(limits)?;
    Ok(manifest)
}

fn retry_current_manifest_open<T>(
    mut open: impl FnMut() -> Result<T, DiscoveryError>,
) -> Result<T, DiscoveryError> {
    // Atomic publication can replace the entry while a reader opens it. Unix
    // observes an identity change; ReplaceFileW briefly exposes its documented
    // exclusive replacement handle. Retry only those platform-owned races.
    for attempt in 1..=MAX_CURRENT_MANIFEST_OPEN_ATTEMPTS {
        let result = open();
        let replacement_race = result
            .as_ref()
            .is_err_and(private_storage::is_atomic_replacement_open_error);
        if !replacement_race || attempt == MAX_CURRENT_MANIFEST_OPEN_ATTEMPTS {
            return result;
        }
        std::thread::yield_now();
    }
    unreachable!("manifest open attempt range is non-empty")
}

#[derive(Debug)]
pub struct LifetimeLock {
    file: File,
    session_path: PathBuf,
    key: DiscoveryKey,
    creation_admission: Mutex<Option<CreationAdmission>>,
}

impl Drop for LifetimeLock {
    fn drop(&mut self) {
        let creation_admission = self
            .creation_admission
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        drop(creation_admission);
        let _ = FileExt::unlock(&self.file);
    }
}

impl LifetimeLock {
    fn commit_creation_admission(&self) {
        let mut admission = self
            .creation_admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(mut admission) = admission.take() {
            admission.commit();
        }
    }

    fn rollback_creation_admission(&self) {
        let mut admission = self
            .creation_admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(mut admission) = admission.take() {
            admission.rollback();
        }
    }
}

#[derive(Debug)]
struct CreationAdmission {
    reservation: Option<RegistrationReservation>,
    maintenance: Option<DiscoveryMaintenanceLock>,
}

impl CreationAdmission {
    fn release_maintenance(&mut self) {
        self.maintenance.take();
    }

    fn commit(&mut self) {
        self.reservation.take();
    }

    fn rollback(&mut self) {
        if let Some(reservation) = self.reservation.take() {
            reservation.rollback();
        }
    }
}

#[derive(Debug)]
struct RegistrationReservation {
    session_path: PathBuf,
    created_paths: Vec<PathBuf>,
}

impl RegistrationReservation {
    fn new(session_path: PathBuf, created_paths: Vec<PathBuf>) -> Self {
        Self {
            session_path,
            created_paths,
        }
    }

    fn rollback(self) {
        rollback_created_paths(&self.created_paths, &self.session_path);
    }
}

fn rollback_created_paths(created_paths: &[PathBuf], session_path: &Path) {
    let _ = fs::remove_file(session_path.join(LIFETIME_LOCK_FILE_NAME));
    for path in created_paths.iter().rev() {
        if fs::remove_dir(path).is_ok() {
            if let Some(parent) = path.parent() {
                let _ = private_storage::sync_directory(parent);
            }
        }
    }
}

#[cfg(test)]
#[path = "manifest_store_tests.rs"]
mod tests;
