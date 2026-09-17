//! Locked journal I/O and monotonic authority publication.

use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum JournalLockMode {
    Shared,
    Exclusive,
}

/// Capability passed to authority code only while this process holds the
/// permission journal's machine-wide exclusive lock.
pub(super) struct ExclusiveJournalAccess<'a> {
    pub(super) directory: &'a Path,
    pub(super) _lock: &'a File,
}

impl ExclusiveJournalAccess<'_> {
    pub(super) fn directory(&self) -> &Path {
        self.directory
    }
}

#[derive(Debug)]
pub(super) struct LockedJournal {
    pub(super) _lock: File,
    lock_mode: JournalLockMode,
    directory: PathBuf,
    secret: [u8; SECRET_BYTES],
    pub(super) bytes: Vec<u8>,
}

impl LockedJournal {
    pub(super) fn open(directory: &Path) -> StoreResult<Self> {
        Self::open_with_mode(directory, JournalLockMode::Exclusive)
    }

    pub(super) fn open_shared(directory: &Path) -> StoreResult<Self> {
        Self::open_with_mode(directory, JournalLockMode::Shared)
    }

    fn open_with_mode(directory: &Path, lock_mode: JournalLockMode) -> StoreResult<Self> {
        validate_owned_directory(directory)?;
        let lock_path = directory.join(LOCK_FILE);
        let mut lock = open_owned_file(&lock_path, true)?;
        let lock_result = match lock_mode {
            JournalLockMode::Shared => FileExt::lock_shared(&lock),
            JournalLockMode::Exclusive => FileExt::lock_exclusive(&lock),
        };
        lock_result.map_err(|error| {
            PluginPermissionStoreError::new(
                "plugin_permission_store_lock_failed",
                format!("lock {}: {error}", lock_path.display()),
            )
        })?;
        validate_owned_directory(directory)?;
        let secret = read_secret(directory)?;
        verify_secret_commitment(&lock_path, &mut lock, &secret)?;
        if lock_mode == JournalLockMode::Shared && compaction::recovery_required(directory)? {
            drop(lock);
            return Self::open_with_mode(directory, JournalLockMode::Exclusive);
        }
        if lock_mode == JournalLockMode::Exclusive {
            let access = ExclusiveJournalAccess {
                directory,
                _lock: &lock,
            };
            compaction::recover_compaction(&access, JOURNAL_FILE, MAX_JOURNAL_BYTES, &secret)?;
        }
        let authority = compaction::validate_authority_anchor(&lock, &secret)?;
        let bytes = read_journal(directory)?;
        validate_current_authority(authority, &bytes)?;
        if authority.is_none() && lock_mode == JournalLockMode::Shared {
            drop(lock);
            return Self::open_with_mode(directory, JournalLockMode::Exclusive);
        }
        let mut journal = Self {
            _lock: lock,
            lock_mode,
            directory: directory.to_path_buf(),
            secret,
            bytes,
        };
        if authority.is_none() {
            // Opening a legacy store is the migration boundary. Publish the
            // baseline while the exclusive lock still protects the validated
            // bytes, so even a read-only upgraded process immediately fences
            // schema-1 writers and detects later canonical-only rollback.
            journal.ensure_authority_anchor()?;
        }
        Ok(journal)
    }

    pub(super) fn workspace_identity(
        &self,
        workspace_root: &Path,
    ) -> StoreResult<(PathBuf, String)> {
        let canonical = canonical_workspace_root(workspace_root)?;
        let identity = workspace_hmac(&self.secret, &canonical)?;
        Ok((canonical, identity))
    }

    pub(super) fn replace_bytes(&mut self, bytes: Vec<u8>) -> StoreResult<()> {
        if self.lock_mode != JournalLockMode::Exclusive {
            return Err(PluginPermissionStoreError::new(
                "plugin_permission_store_lock_failed",
                "permission journal replacement requires an exclusive lock",
            ));
        }
        let source = LoadedPermissionJournal::read_bytes(&self.bytes)?;
        let target = LoadedPermissionJournal::read_bytes(&bytes)?;
        if target.format != source.format
            || target.event_count
                != source
                    .event_count
                    .checked_add(1)
                    .ok_or_else(|| too_large("permission journal event count overflow"))?
            || !bytes.starts_with(&self.bytes)
        {
            return Err(invalid_journal(
                "permission journal event append is not an exact one-event extension",
            ));
        }
        let access = ExclusiveJournalAccess {
            directory: &self.directory,
            _lock: &self._lock,
        };
        compaction::publish_authoritative_replacement(
            &access,
            JOURNAL_FILE,
            compaction::JournalAuthorityReplacement {
                source: compaction::JournalAuthoritySnapshot {
                    bytes: &self.bytes,
                    state: journal_authority_state(&source)?,
                },
                target: compaction::JournalAuthoritySnapshot {
                    bytes: &bytes,
                    state: journal_authority_state(&target)?,
                },
                mutation_kind: compaction::JournalMutationKind::EventAppend,
            },
            MAX_JOURNAL_BYTES,
            &self.secret,
        )?;
        self.bytes = bytes;
        Ok(())
    }

    pub(super) fn ensure_authority_anchor(&mut self) -> StoreResult<()> {
        if compaction::validate_authority_anchor(&self._lock, &self.secret)?.is_some() {
            return Ok(());
        }
        let loaded = LoadedPermissionJournal::read_bytes(&self.bytes)?;
        let state = journal_authority_state(&loaded)?;
        let snapshot = compaction::JournalAuthoritySnapshot {
            bytes: &self.bytes,
            state,
        };
        let access = ExclusiveJournalAccess {
            directory: &self.directory,
            _lock: &self._lock,
        };
        compaction::publish_authoritative_replacement(
            &access,
            JOURNAL_FILE,
            compaction::JournalAuthorityReplacement {
                source: snapshot,
                target: snapshot,
                mutation_kind: compaction::JournalMutationKind::BaselineMigration,
            },
            MAX_JOURNAL_BYTES,
            &self.secret,
        )?;
        Ok(())
    }

    pub(super) fn publish_compacted_bytes(
        &mut self,
        bytes: Vec<u8>,
        generation: u64,
    ) -> StoreResult<()> {
        if self.lock_mode != JournalLockMode::Exclusive {
            return Err(PluginPermissionStoreError::new(
                "plugin_permission_store_lock_failed",
                "permission journal compaction requires an exclusive lock",
            ));
        }
        LoadedPermissionJournal::validate_compaction_transition(&self.bytes, &bytes, generation)?;
        let source = LoadedPermissionJournal::read_bytes(&self.bytes)?;
        let target = LoadedPermissionJournal::read_bytes(&bytes)?;
        {
            let access = ExclusiveJournalAccess {
                directory: &self.directory,
                _lock: &self._lock,
            };
            compaction::publish_compaction(
                &access,
                JOURNAL_FILE,
                compaction::JournalAuthoritySnapshot {
                    bytes: &self.bytes,
                    state: journal_authority_state(&source)?,
                },
                compaction::JournalAuthoritySnapshot {
                    bytes: &bytes,
                    state: journal_authority_state(&target)?,
                },
                MAX_JOURNAL_BYTES,
                &self.secret,
            )?;
        }
        self.bytes = bytes;
        Ok(())
    }

    pub(super) fn refresh(&mut self) -> StoreResult<()> {
        let bytes = read_journal(&self.directory)?;
        let authority = compaction::validate_authority_anchor(&self._lock, &self.secret)?;
        validate_current_authority(authority, &bytes)?;
        self.bytes = bytes;
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn replace_bytes_for_fixture(&mut self, bytes: Vec<u8>) -> StoreResult<()> {
        let suffix = random_suffix()?;
        let temporary = self
            .directory
            .join(format!(".{JOURNAL_FILE}.fixture-{suffix}"));
        let mut file = create_owned_file(&temporary)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| io_error("write fixture permission journal", &temporary, error))?;
        let current_path = self.directory.join(JOURNAL_FILE);
        std::fs::rename(&temporary, &current_path).map_err(|error| {
            io_error("publish fixture permission journal", &current_path, error)
        })?;
        sync_directory(&self.directory)?;
        self._lock
            .set_len(SECRET_BYTES as u64)
            .and_then(|_| self._lock.sync_all())
            .map_err(|error| {
                io_error("reset fixture permission authority", &current_path, error)
            })?;
        self.bytes = bytes;
        Ok(())
    }
}

fn journal_authority_state(
    loaded: &LoadedPermissionJournal,
) -> StoreResult<compaction::JournalAuthorityState> {
    Ok(compaction::JournalAuthorityState {
        format_generation: loaded.format.generation(),
        logical_count: u64::try_from(loaded.event_count)
            .map_err(|_| too_large("permission journal logical event count overflow"))?,
    })
}

fn validate_current_authority(
    authority: Option<compaction::JournalAuthorityIdentity>,
    bytes: &[u8],
) -> StoreResult<()> {
    let Some(authority) = authority else {
        return Ok(());
    };
    let loaded = LoadedPermissionJournal::read_bytes(bytes)?;
    if authority.state != journal_authority_state(&loaded)? || !authority.matches(bytes) {
        return Err(PluginPermissionStoreError::new(
            "plugin_permission_authority_invalid",
            "canonical permission journal does not match its monotonic authority anchor",
        ));
    }
    Ok(())
}

fn read_journal(directory: &Path) -> StoreResult<Vec<u8>> {
    let path = directory.join(JOURNAL_FILE);
    let mut file = open_owned_file(&path, false)?;
    let metadata = file
        .metadata()
        .map_err(|error| io_error("inspect permission journal", &path, error))?;
    if metadata.len() > MAX_JOURNAL_BYTES {
        return Err(too_large("permission journal requires explicit compaction"));
    }
    let capacity = usize::try_from(metadata.len()).unwrap_or(MAX_JOURNAL_BYTES as usize);
    let mut bytes = Vec::with_capacity(capacity);
    file.seek(SeekFrom::Start(0))
        .and_then(|_| {
            Read::by_ref(&mut file)
                .take(MAX_JOURNAL_BYTES + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| io_error("read permission journal", &path, error))?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err(too_large("permission journal requires explicit compaction"));
    }
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        return Err(invalid_journal(
            "permission journal has an incomplete tail; automatic repair is forbidden",
        ));
    }
    Ok(bytes)
}
