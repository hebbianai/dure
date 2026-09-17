use super::*;
use crate::local_protocol::{ProcessProof, SessionFence};
use sha2::{Digest, Sha256};

impl DiscoveryRoot {
    /// Recover an exact create's archived generation after losing its response.
    /// The existing logical path bounds the lookup; names and unrelated
    /// sessions do not participate, and duplicate generations are not guessed.
    pub fn find_retired_creation(
        &self,
        workspace_id: &str,
        session_id: &str,
        create_key: &str,
    ) -> Result<Option<super::super::DiscoveredSession>, DiscoveryError> {
        let lookup = SessionLookupKey::new(workspace_id, session_id)?;
        let path = self.session_base_path(&lookup);
        if !private_storage::path_entry_exists(&path)? {
            return Ok(None);
        }
        super::super::session_lookup::validate_lookup_ancestors(self.path(), &path)?;
        let mut found = None;
        let mut ambiguous = false;
        find_retired_exited_matching(
            &path,
            &self.limits,
            |manifest| {
                let lifetime = &manifest.common().lifetime;
                if lifetime.workspace_id != workspace_id || lifetime.session_id != session_id {
                    return Err(DiscoveryError::ManifestKeyMismatch);
                }
                Ok(())
            },
            |exited| {
                if exited.common.claim_linkage.kickoff_action_id.as_deref() == Some(create_key) {
                    if found.as_ref().is_some_and(|previous| previous != exited) {
                        ambiguous = true;
                    } else {
                        found = Some(exited.clone());
                    }
                }
                false
            },
        )?;
        if ambiguous {
            return Err(DiscoveryError::GenerationMismatch);
        }
        found
            .map(|exited| {
                let lifetime = &exited.common.lifetime;
                let key = DiscoveryKey::new(
                    &lifetime.workspace_id,
                    &lifetime.session_id,
                    &lifetime.runner_instance,
                    lifetime.channel_epoch,
                )?;
                Ok(super::super::DiscoveredSession {
                    key,
                    manifest: DiscoveryManifest::Exited(exited),
                    discovery_path: path,
                })
            })
            .transpose()
    }
}

fn find_retired_exited_matching(
    session_path: &Path,
    limits: &ManifestLimits,
    validate: impl Fn(&DiscoveryManifest) -> Result<(), DiscoveryError>,
    mut matches: impl FnMut(&ExitedManifest) -> bool,
) -> Result<Option<ExitedManifest>, DiscoveryError> {
    let retired_path = session_path.join(RETIRED_DIRECTORY_NAME);
    if !private_storage::path_entry_exists(&retired_path)? {
        return Ok(None);
    }
    private_storage::validate_directory(&retired_path)?;
    let entries = fs::read_dir(&retired_path)
        .map_err(|error| DiscoveryError::io("read retired manifests", &retired_path, error))?;
    let mut valid_entries = 0_usize;
    let mut scanned_entries = 0_usize;
    let mut first_error = None;
    for entry in entries {
        scanned_entries = scanned_entries.saturating_add(1);
        if scanned_entries > limits.max_retired_manifest_scan_entries {
            return Err(DiscoveryError::LookupScanLimitExceeded {
                maximum: limits.max_retired_manifest_scan_entries,
            });
        }
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(error) => {
                first_error.get_or_insert_with(|| {
                    DiscoveryError::io("read retired manifest entry", &retired_path, error)
                });
                continue;
            }
        };
        if is_internal_retirement_temp(&path) {
            continue;
        }
        let manifest = match read_manifest_at(&path, limits) {
            Ok(manifest) => manifest,
            Err(error) => {
                first_error.get_or_insert(error);
                continue;
            }
        };
        if let Err(error) = validate(&manifest) {
            first_error.get_or_insert(error);
            continue;
        }
        let DiscoveryManifest::Exited(exited) = manifest else {
            first_error.get_or_insert(DiscoveryError::InvalidManifestTransition {
                from: lifecycle_name(&manifest),
                to: "retired",
            });
            continue;
        };
        valid_entries += 1;
        if matches(&exited) {
            return Ok(Some(exited));
        }
    }
    if valid_entries > limits.max_retired_manifest_entries {
        return Err(DiscoveryError::LookupLimitExceeded {
            maximum: limits.max_retired_manifest_entries,
        });
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(None)
}

impl SessionDiscovery {
    pub fn retire_exited_current(
        &self,
        lock: &LifetimeLock,
        expected: &ManifestGeneration,
    ) -> Result<bool, DiscoveryError> {
        self.retire_exited_current_with_parent_sync(lock, expected, private_storage::sync_directory)
    }

    fn retire_exited_current_with_parent_sync(
        &self,
        lock: &LifetimeLock,
        expected: &ManifestGeneration,
        mut sync_parent: impl FnMut(&Path) -> Result<(), DiscoveryError>,
    ) -> Result<bool, DiscoveryError> {
        self.ensure_lock(lock)?;
        let Some(current) = self.try_read_manifest()? else {
            let Some(retired) = self.find_retired_exited_generation(expected)? else {
                // Why: absence means the retirement never happened only while
                // no archived generation exists. Once a tombstone is retained,
                // a non-matching retry is stale authority and must fail closed
                // instead of reporting an idempotent no-op.
                return if self.has_retired_exited()? {
                    Err(DiscoveryError::GenerationMismatch)
                } else {
                    Ok(false)
                };
            };
            if DiscoveryManifest::Exited(retired).generation() != *expected {
                return Err(DiscoveryError::GenerationMismatch);
            }
            return Ok(true);
        };
        let DiscoveryManifest::Exited(exited) = current else {
            return Err(DiscoveryError::InvalidManifestTransition {
                from: lifecycle_name(&current),
                to: "retired",
            });
        };
        if DiscoveryManifest::Exited(exited.clone()).generation() != *expected {
            return Err(DiscoveryError::GenerationMismatch);
        }

        // Why: an exited Host is still the only durable owner of the PTY exit
        // evidence. Archive the complete validated record before removing the
        // active discovery pointer, so a same-session successor can start
        // without erasing the predecessor tombstone or creating a parallel
        // Host generation.
        self.write_retired_exited(&exited, &mut sync_parent)?;
        let path = self.manifest_path();
        fs::remove_file(&path)
            .map_err(|error| DiscoveryError::io("remove retired manifest", &path, error))?;
        private_storage::sync_directory(&self.path)?;
        Ok(true)
    }

    #[cfg(test)]
    pub(super) fn retire_exited_current_with_parent_sync_for_test(
        &self,
        lock: &LifetimeLock,
        expected: &ManifestGeneration,
        sync_parent: impl FnMut(&Path) -> Result<(), DiscoveryError>,
    ) -> Result<bool, DiscoveryError> {
        self.retire_exited_current_with_parent_sync(lock, expected, sync_parent)
    }

    pub fn restore_retired_exited(
        &self,
        lock: &LifetimeLock,
        expected: &ManifestGeneration,
    ) -> Result<ExitedManifest, DiscoveryError> {
        self.ensure_lock(lock)?;
        let Some(retired) = self.find_retired_exited_generation(expected)? else {
            return Err(DiscoveryError::GenerationMismatch);
        };
        if DiscoveryManifest::Exited(retired.clone()).generation() != *expected {
            return Err(DiscoveryError::GenerationMismatch);
        }
        match self.try_read_manifest()? {
            Some(DiscoveryManifest::Exited(current)) if current == retired => return Ok(retired),
            Some(_) => return Err(DiscoveryError::ManifestConflict),
            None => {}
        }
        // Why: rollback can occur after the successor Starting record was
        // removed but before any provider PTY exists. Rehydrate only an exact,
        // already-durable retired tombstone, retaining the archive so a crash
        // between this write and a retry leaves authoritative Exited evidence.
        self.write_manifest(&DiscoveryManifest::Exited(retired.clone()))?;
        Ok(retired)
    }

    pub fn find_retired_exited(
        &self,
        host_instance_id: &str,
    ) -> Result<Option<ExitedManifest>, DiscoveryError> {
        self.find_retired_exited_matching(|exited| {
            exited.common.host_instance_id == host_instance_id
        })
    }

    /// Read terminal evidence using the complete session fence, including the
    /// terminal epoch. One retained Host may have archived several epochs.
    pub fn find_retired_exited_fenced(
        &self,
        expected: &SessionFence,
    ) -> Result<Option<ExitedManifest>, DiscoveryError> {
        self.find_retired_exited_matching(|exited| exited.tombstone.fence == *expected)
    }

    fn find_retired_exited_matching(
        &self,
        matches: impl FnMut(&ExitedManifest) -> bool,
    ) -> Result<Option<ExitedManifest>, DiscoveryError> {
        find_retired_exited_matching(
            &self.path,
            &self.limits,
            |manifest| self.validate_for_key(manifest),
            matches,
        )
    }

    pub fn find_retired_exited_generation(
        &self,
        expected: &ManifestGeneration,
    ) -> Result<Option<ExitedManifest>, DiscoveryError> {
        // Why: one retained Host has one host instance id across A, B, and C.
        // A host-id-only lookup can therefore return A while a C handoff needs
        // B, making a valid multi-replacement retirement look like corruption.
        // Match the complete generation so historical tombstones stay immutable
        // without blocking the current exact successor transition.
        let retired_path = self.path.join(RETIRED_DIRECTORY_NAME);
        if !private_storage::path_entry_exists(&retired_path)? {
            return Ok(None);
        }
        private_storage::validate_directory(&retired_path)?;
        let Some(file_name) = retired_generation_file_name(expected) else {
            // Starting generations have no terminal epoch and therefore cannot
            // name an archived Exited tombstone.
            return Ok(None);
        };
        let path = retired_path.join(file_name);
        if !private_storage::path_entry_exists(&path)? {
            return Ok(None);
        }
        let manifest = read_manifest_at(&path, &self.limits)?;
        self.validate_for_key(&manifest)?;
        let DiscoveryManifest::Exited(exited) = manifest else {
            return Err(DiscoveryError::InvalidManifestTransition {
                from: lifecycle_name(&manifest),
                to: "retired",
            });
        };
        if DiscoveryManifest::Exited(exited.clone()).generation() != *expected {
            return Err(DiscoveryError::GenerationMismatch);
        }
        Ok(Some(exited))
    }

    pub(crate) fn has_retired_exited(&self) -> Result<bool, DiscoveryError> {
        Ok(self.find_retired_exited_matching(|_| true)?.is_some())
    }

    fn write_retired_exited(
        &self,
        exited: &ExitedManifest,
        sync_parent: &mut impl FnMut(&Path) -> Result<(), DiscoveryError>,
    ) -> Result<(), DiscoveryError> {
        let retired_path = self.path.join(RETIRED_DIRECTORY_NAME);
        private_storage::create_directory(&retired_path)?;
        // The archived tombstone's directory entry must itself be durable
        // before the current manifest can be removed. Syncing only the child
        // directory does not persist a newly created `retired/` name.
        sync_parent(&self.path)?;
        let target = retired_path.join(retired_exited_file_name(exited));
        if private_storage::path_entry_exists(&target)? {
            let existing = read_manifest_at(&target, &self.limits)?;
            return if existing == DiscoveryManifest::Exited(exited.clone()) {
                // Why: this can be a retry after rename succeeded but the
                // original process crashed before syncing the directory. The
                // target's contents prove identity, but only a directory sync
                // makes that name durable before the caller removes the active
                // manifest.
                private_storage::sync_directory(&retired_path)?;
                Ok(())
            } else {
                Err(DiscoveryError::ManifestConflict)
            };
        }
        let manifest = DiscoveryManifest::Exited(exited.clone());
        let bytes = serde_json::to_vec(&manifest).map_err(DiscoveryError::Serialization)?;
        if bytes.len() > self.limits.max_manifest_bytes {
            return Err(DiscoveryError::ManifestTooLarge {
                actual: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
                maximum: self.limits.max_manifest_bytes,
            });
        }
        self.admit_new_retired_history(&retired_path, bytes.len())?;
        let (temp, mut file) = self.create_retirement_temp(&retired_path, &TEMP_FILE_SEQUENCE)?;
        let result = (|| {
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|error| DiscoveryError::io("write retired manifest", &temp, error))?;
            drop(file);
            private_storage::replace_file(&temp, &target)?;
            private_storage::sync_directory(&retired_path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }

    fn admit_new_retired_history(
        &self,
        retired_path: &Path,
        candidate_bytes: usize,
    ) -> Result<(), DiscoveryError> {
        let mut paths = Vec::new();
        let entries = fs::read_dir(retired_path).map_err(|error| {
            DiscoveryError::io("read retired history for admission", retired_path, error)
        })?;
        for entry in entries {
            let actual = paths.len().saturating_add(1);
            if actual > self.limits.max_retired_manifest_scan_entries {
                return Err(DiscoveryError::RetiredHistoryScanCapacityExceeded {
                    actual,
                    maximum: self.limits.max_retired_manifest_scan_entries,
                });
            }
            paths.push(
                entry
                    .map_err(|error| {
                        DiscoveryError::io("read retired history entry", retired_path, error)
                    })?
                    .path(),
            );
        }
        let projected_raw_entries = paths.len().saturating_add(1);
        if projected_raw_entries > self.limits.max_retired_manifest_scan_entries {
            return Err(DiscoveryError::RetiredHistoryScanCapacityExceeded {
                actual: projected_raw_entries,
                maximum: self.limits.max_retired_manifest_scan_entries,
            });
        }

        // `read_dir` order is unspecified. Sort before inspection so admission
        // observes the same bounded usage on every filesystem and run.
        paths.sort();
        let mut records = 0_usize;
        let mut bytes = 0_u64;
        for path in paths {
            let file = private_storage::open_existing_file(&path)?;
            let entry_bytes = file
                .metadata()
                .map_err(|error| DiscoveryError::io("inspect retired history entry", &path, error))?
                .len();
            bytes = bytes.checked_add(entry_bytes).ok_or(
                DiscoveryError::RetiredHistoryByteCapacityExceeded {
                    actual: u64::MAX,
                    maximum: self.limits.max_retired_manifest_bytes,
                },
            )?;
            if is_internal_retirement_temp(&path) {
                continue;
            }
            // Admission never deletes or trusts historical contents. Count
            // every owner-only non-temporary file conservatively, including
            // malformed legacy debris, so corruption cannot bypass the hard
            // bound or prevent an unrelated exact tombstone from being
            // archived while capacity remains.
            drop(file);
            records = records.saturating_add(1);
        }

        let projected_records = records.saturating_add(1);
        if projected_records > self.limits.max_retired_manifest_entries {
            return Err(DiscoveryError::RetiredHistoryRecordCapacityExceeded {
                actual: projected_records,
                maximum: self.limits.max_retired_manifest_entries,
            });
        }
        let candidate_bytes = u64::try_from(candidate_bytes).map_err(|_| {
            DiscoveryError::RetiredHistoryByteCapacityExceeded {
                actual: u64::MAX,
                maximum: self.limits.max_retired_manifest_bytes,
            }
        })?;
        let projected_bytes = bytes.checked_add(candidate_bytes).ok_or(
            DiscoveryError::RetiredHistoryByteCapacityExceeded {
                actual: u64::MAX,
                maximum: self.limits.max_retired_manifest_bytes,
            },
        )?;
        if projected_bytes > self.limits.max_retired_manifest_bytes {
            return Err(DiscoveryError::RetiredHistoryByteCapacityExceeded {
                actual: projected_bytes,
                maximum: self.limits.max_retired_manifest_bytes,
            });
        }
        Ok(())
    }

    // pub(super) so the manifest_store::tests sibling module can exercise the
    // temp-collision retry path directly. Without this the whole hmux-host lib
    // test target fails to compile (E0624), which is why crate tests were red on
    // main before the standalone-class work touched this crate.
    pub(super) fn create_retirement_temp(
        &self,
        retired_path: &Path,
        sequence: &AtomicU64,
    ) -> Result<(PathBuf, File), DiscoveryError> {
        // Why: a crash can leave the no-follow temporary name behind, and a
        // later process may reuse both the PID and the initial sequence value.
        // Treat that safe AlreadyExists refusal as a bounded collision, not a
        // permanent inability to retire this Host generation.
        for _ in 0..MAX_TEMP_FILE_ATTEMPTS {
            let sequence = sequence.fetch_add(1, Ordering::Relaxed);
            let path = retired_path.join(format!(".retired.tmp-{}-{sequence}", std::process::id()));
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

fn retired_exited_file_name(exited: &ExitedManifest) -> String {
    encode_retired_generation_file_name(
        &exited.common.host_instance_id,
        &exited.common.host_process,
        &exited.tombstone.fence.terminal_epoch,
    )
}

fn retired_generation_file_name(generation: &ManifestGeneration) -> Option<String> {
    Some(encode_retired_generation_file_name(
        &generation.host_instance_id,
        &generation.host_process,
        generation.terminal_epoch.as_deref()?,
    ))
}

fn encode_retired_generation_file_name(
    host_instance_id: &str,
    host_process: &ProcessProof,
    terminal_epoch: &str,
) -> String {
    let mut digest = Sha256::new();
    digest_generation_field(&mut digest, host_instance_id.as_bytes());
    digest_generation_field(&mut digest, &host_process.process_id.to_be_bytes());
    digest_generation_field(&mut digest, host_process.start_marker.as_bytes());
    digest_generation_field(&mut digest, terminal_epoch.as_bytes());
    let digest = digest.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2 + 7);
    encoded.push_str("g_");
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded.push_str(".json");
    encoded
}

fn digest_generation_field(digest: &mut Sha256, value: &[u8]) {
    digest.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    digest.update(value);
}

fn is_internal_retirement_temp(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".retired.tmp-"))
}

fn lifecycle_name(manifest: &DiscoveryManifest) -> &'static str {
    match manifest {
        DiscoveryManifest::Starting(_) => "starting",
        DiscoveryManifest::Ready(_) => "ready",
        DiscoveryManifest::Exited(_) => "exited",
    }
}
