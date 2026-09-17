//! Durable directory retention when an exact Git checkout is unavailable.
//!
//! These records retain only a path, never confer Git mutation authority, and
//! survive client exit. The existing session lifecycle releases its own claim.
//! All checkout removal ports fence these claims before destructive admission.

use super::*;
use fs2::FileExt;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;

const MAX_STATE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DirectoryUses {
    claims: BTreeMap<String, PathBuf>,
    removing: BTreeMap<String, GitCheckoutInstanceV1>,
}

pub(super) struct DirectoryUseGuard {
    _lock: File,
    root: PathBuf,
    state: DirectoryUses,
}

impl DirectoryUseGuard {
    pub(super) fn open() -> Result<Self, GitCheckoutUseError> {
        // All app channels and runtime namespaces for this OS user share this
        // authority. DURE_HOME and discovery-root overrides must not split it.
        let root = dirs::home_dir()
            .ok_or_else(|| state_error("directory retention home is unavailable"))?
            .join(".dure/state/checkout-directory-use-v1");
        Self::at(root)
    }

    fn at(root: PathBuf) -> Result<Self, GitCheckoutUseError> {
        fs::create_dir_all(&root).map_err(storage_error)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let lock = options.open(root.join("lock")).map_err(storage_error)?;
        lock.lock_exclusive().map_err(storage_error)?;
        let state: DirectoryUses = match File::open(root.join("state.json")) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(MAX_STATE_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(storage_error)?;
                if bytes.len() as u64 > MAX_STATE_BYTES {
                    return Err(state_error("directory retention state exceeds its bound"));
                }
                serde_json::from_slice(&bytes).map_err(storage_error)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => DirectoryUses::default(),
            Err(error) => return Err(storage_error(error)),
        };
        for (id, path) in &state.claims {
            OperationIdV1::new(id.clone()).map_err(storage_error)?;
            TrustedLocator::parse_path(path, "retained working directory")?;
        }
        for (path, instance) in &state.removing {
            if path != &instance.canonical_path {
                return Err(state_error("directory removal fence changed its path"));
            }
            ValidatedGitCheckoutInstance::parse(instance).map_err(storage_error)?;
        }
        Ok(Self {
            _lock: lock,
            root,
            state,
        })
    }

    fn save(&self) -> Result<(), GitCheckoutUseError> {
        let bytes = serde_json::to_vec(&self.state).map_err(storage_error)?;
        if bytes.len() as u64 > MAX_STATE_BYTES {
            return Err(state_error("directory retention state exceeds its bound"));
        }
        let mut random = [0; 16];
        getrandom::fill(&mut random).map_err(storage_error)?;
        let name: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let temporary = self.root.join(format!("state-{name}.tmp"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(storage_error)?;
        let result = (|| {
            file.write_all(&bytes).map_err(storage_error)?;
            file.sync_all().map_err(storage_error)?;
            fs::rename(&temporary, self.root.join("state.json")).map_err(storage_error)?;
            #[cfg(unix)]
            File::open(&self.root)
                .and_then(|directory| directory.sync_all())
                .map_err(storage_error)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }

    fn claim(&mut self, cwd: &Path, id: &OperationIdV1) -> Result<(), GitCheckoutUseError> {
        // Revalidate after taking the same lock as removal. An admission that
        // raced successful physical deletion must not acknowledge a stale cwd.
        let cwd = canonical_directory(cwd)?;
        if self.state.removing.keys().any(|path| cwd.starts_with(path)) {
            return Err(phase_conflict("working directory is being removed"));
        }
        if let Some(saved) = self.state.claims.get(id.as_str()) {
            return if saved == &cwd {
                Ok(())
            } else {
                Err(state_error("directory retention identity changed"))
            };
        }
        self.state.claims.insert(id.as_str().to_owned(), cwd);
        self.save()
    }

    pub(super) fn begin_removal(
        &mut self,
        instance: &GitCheckoutInstanceV1,
    ) -> Result<(), GitCheckoutUseError> {
        if self
            .state
            .claims
            .values()
            .any(|cwd| cwd.starts_with(&instance.canonical_path))
        {
            return Err(GitCheckoutUseError::new(
                "checkout_use_in_use",
                "a session retains a directory in this checkout",
            ));
        }
        match self.state.removing.get(&instance.canonical_path) {
            Some(existing) if existing == instance => return Ok(()),
            Some(_) => {
                return Err(phase_conflict(
                    "another checkout instance retains this removal fence",
                ));
            }
            None => {}
        }
        self.state
            .removing
            .insert(instance.canonical_path.clone(), instance.clone());
        // Write before Git CAS. An interruption leaves conservative exclusion;
        // replay/abort reconciles it with the existing exact Git authority.
        self.save()
    }

    pub(super) fn finish_removal(
        &mut self,
        instance: &GitCheckoutInstanceV1,
    ) -> Result<(), GitCheckoutUseError> {
        if self.state.removing.get(&instance.canonical_path) == Some(instance) {
            self.state.removing.remove(&instance.canonical_path);
            self.save()?;
        }
        Ok(())
    }
}

fn storage_error(error: impl std::fmt::Display) -> GitCheckoutUseError {
    state_error(format!("directory retention state unavailable: {error}"))
}

fn canonical_directory(path: &Path) -> Result<PathBuf, GitCheckoutUseError> {
    if !path.is_absolute() {
        return Err(request_error("working directory must be absolute"));
    }
    let canonical = dunce::canonicalize(path).map_err(storage_error)?;
    if !canonical.is_dir() {
        return Err(request_error("working directory must be a directory"));
    }
    Ok(canonical)
}

/// Retain an existing directory independently of optional Git metadata. The
/// claim ID is the product's immutable resource identity across owner transfer.
pub fn retain_working_directory(
    cwd: &Path,
    id: &OperationIdV1,
) -> Result<(), GitCheckoutInstanceError> {
    DirectoryUseGuard::open()
        .and_then(|mut guard| guard.claim(cwd, id))
        .map_err(use_error_as_instance)
}

/// Snapshot the retained directory users inside a canonical checkout. This is
/// input for existing lifecycle recovery, never permission to stop or remove.
pub fn read_working_directory_claims(
    checkout: &Path,
) -> Result<Vec<OperationIdV1>, GitCheckoutInstanceError> {
    (|| {
        let guard = DirectoryUseGuard::open()?;
        guard
            .state
            .claims
            .iter()
            .filter(|(_, cwd)| cwd.starts_with(checkout))
            .map(|(id, _)| OperationIdV1::new(id.clone()).map_err(storage_error))
            .collect::<Result<Vec<_>, GitCheckoutUseError>>()
    })()
    .map_err(use_error_as_instance)
}

/// Called only after the lifecycle has durably closed launch admission and
/// retired the runtime. Missing claims are idempotent legacy/response-loss cases.
pub fn release_working_directory(id: &OperationIdV1) -> Result<(), GitCheckoutInstanceError> {
    (|| {
        let mut guard = DirectoryUseGuard::open()?;
        if guard.state.claims.remove(id.as_str()).is_some() {
            guard.save()?;
        }
        Ok(())
    })()
    .map_err(use_error_as_instance)
}

#[cfg(test)]
mod tests;
