//! Physical creation admission owned by the existing checkout-use authority.

use super::*;
use fs2::FileExt;
use hebbian_bounded_process::{UnixBoundCommandFailure, UnixDirectoryAnchor};
use std::fs::{DirBuilder, File, OpenOptions};
use std::os::fd::AsFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::PathBuf;
use std::time::{Duration, Instant};

struct ExecutionLease {
    directory: File,
    path: PathBuf,
}

impl ExecutionLease {
    fn acquire(authority: &Authority) -> Result<Self, GitCheckoutUseError> {
        let path = authority
            .git_common_dir
            .join("dure-checkout-execution-v1")
            .join(&authority.path_digest);
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&path)
            .map_err(execution_error)?;
        Self::lock(Self::open(&path)?, path)
    }

    fn open(path: &Path) -> Result<File, GitCheckoutUseError> {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(path)
            .map_err(execution_error)
    }

    fn lock(directory: File, path: PathBuf) -> Result<Self, GitCheckoutUseError> {
        let deadline = Instant::now() + super::super::git_process::GIT_TIMEOUT;
        loop {
            match FileExt::try_lock_exclusive(&directory) {
                Ok(()) => break,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(reconciliation_required(
                            "original Git execution still owns its lease",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => return Err(execution_error(error)),
            }
        }
        Ok(Self { directory, path })
    }

    fn quiesce(self) -> Result<Self, GitCheckoutUseError> {
        // A second open description must acquire the same inode after the
        // parent's original handle closes. A duplicated handle would keep the
        // old lock, proving nothing about surviving Git children.
        let directory = Self::open(&self.path)?;
        let original = self.directory.metadata().map_err(execution_error)?;
        let reopened = directory.metadata().map_err(execution_error)?;
        if (original.dev(), original.ino()) != (reopened.dev(), reopened.ino()) {
            return Err(reconciliation_required(
                "creation execution lease was replaced",
            ));
        }
        let path = self.path.clone();
        drop(self);
        Self::lock(directory, path)
    }

    fn anchor(&self) -> Result<UnixDirectoryAnchor<'_>, UnixBoundCommandFailure> {
        UnixDirectoryAnchor::new(self.directory.as_fd(), &self.path)
    }

    fn apply(
        &self,
        request: PreparedRequest,
        loaded: Option<LoadedState>,
    ) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
        let anchor = self.anchor().map_err(|cause| {
            reconciliation_required(&format!("creation execution anchor: {cause:?}"))
        })?;
        apply_loaded_request_using(request, loaded, |authority, expected, state| {
            compare_and_swap_using(authority, expected, state, |args| {
                super::super::git_process::capture_bound_git_output(
                    &authority.repository,
                    args,
                    std::slice::from_ref(&anchor),
                )
                .map_err(|cause| instance_error(cause, InstanceErrorContext::Git))
            })
        })
    }
}

fn execution_error(error: std::io::Error) -> GitCheckoutUseError {
    GitCheckoutUseError::new(
        "checkout_use_git_failed",
        format!("checkout execution lease: {error}"),
    )
}

fn reconciliation_required(message: &str) -> GitCheckoutUseError {
    GitCheckoutUseError::new("checkout_use_creation_reconcile_required", message)
}

/// Holds one still-admitted creation and its actual Git execution lifetime.
/// Dropping this object closes the parent's descriptor; it never explicitly
/// unlocks a description still inherited by an original Git process.
pub struct AdmittedGitCheckoutCreation {
    request: PreparedRequest,
    lease: ExecutionLease,
    reservation: GitCheckoutCreationReservationV1,
    activation_id: OperationIdV1,
    start_request: PreparedRequest,
}

/// Retains execution ownership during read-only preflight, without publishing
/// a reservation. Only `admit` grants physical creation authority.
pub struct GitCheckoutCreationOperation {
    request: PreparedRequest,
    lease: ExecutionLease,
    binding: String,
}

/// Returns `None` for resolution only, never permission to recreate a checkout.
/// This performs bounded blocking Git/lock I/O; async adapters run admission
/// off their event loop and keep the returned owner through physical execution.
pub fn prepare_git_checkout_creation(
    repository: &Path,
    target: &Path,
    registration_id: &OperationIdV1,
    frozen_inputs: &[&str],
) -> Result<Option<GitCheckoutCreationOperation>, GitCheckoutUseError> {
    let request = prepare_request(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: path_string(repository, "creation repository")
            .map_err(|error| instance_error(error, InstanceErrorContext::Request))?,
        operation_id: registration_id.clone(),
        action: GitCheckoutUseActionV1::ReserveCreation {
            checkout_path: path_string(target, "creation target")
                .map_err(|error| instance_error(error, InstanceErrorContext::Request))?,
            owner_id: registration_id.clone(),
        },
    })?;
    let lease = ExecutionLease::acquire(&request.authority)?;
    let mut loaded = read_state(&request.authority)?;
    // A preserved checkout removed out of band leaves an active generation
    // whose claims are all released. Nothing owns that path any more, so
    // retire the generation as already absent and admit a fresh creation.
    if loaded.as_ref().is_some_and(|loaded| {
        loaded.state.phase() == Phase::Active
            && !loaded.state.claims.values().any(Claim::is_active)
            && matches!(
                fs::symlink_metadata(&request.authority.canonical_path),
                Err(ref cause) if cause.kind() == std::io::ErrorKind::NotFound
            )
    }) {
        let revision = loaded.as_ref().map_or(0, |loaded| loaded.state.revision);
        let retirement = request.retire_absent(
            OperationIdV1::new(format!(
                "{}-retire-absent-r{revision}",
                registration_id.as_str()
            ))
            .map_err(|_| state_error("derived absent retirement operation id is invalid"))?,
        )?;
        // A concurrent creator may retire first, the old owner may claim
        // again, or the path may reappear; the fresh state below decides.
        match apply_loaded_request(retirement, loaded) {
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.code,
                    "checkout_use_phase_conflict"
                        | "checkout_use_in_use"
                        | "checkout_use_creation_reconcile_required"
                ) => {}
            Err(error) => return Err(error),
        }
        loaded = read_state(&request.authority)?;
    }
    if let Some(loaded) = &loaded {
        match loaded.state.phase() {
            Phase::Active | Phase::Removing => return Ok(None),
            Phase::Removed if loaded.state.claims.contains_key(registration_id.as_str()) => {
                return Err(phase_conflict(
                    "a retired creation cannot create another checkout",
                ));
            }
            _ => {}
        }
    }
    if loaded
        .as_ref()
        .is_none_or(|loaded| loaded.state.phase() == Phase::Removed)
        && fs::symlink_metadata(&request.authority.canonical_path).is_ok()
    {
        return Ok(None);
    }
    let metadata = lease.directory.metadata().map_err(execution_error)?;
    let device = metadata.dev().to_string();
    let inode = metadata.ino().to_string();
    let mut fields = vec![
        registration_id.as_str(),
        &request.authority.path_digest,
        &device,
        &inode,
    ];
    fields.extend_from_slice(frozen_inputs);
    let binding = digest_fields(
        &request.authority.repository,
        b"dure-checkout-creation-execution-v1",
        &fields,
    )?;
    Ok(Some(GitCheckoutCreationOperation {
        request,
        lease,
        binding,
    }))
}

impl GitCheckoutCreationOperation {
    /// Reject preflight without minting a reservation. An interrupted earlier
    /// attempt may already own one; retire only that same operation if absent.
    pub fn abort(self) -> Result<(), GitCheckoutUseError> {
        let Some(loaded) = read_state(&self.request.authority)? else {
            return Ok(());
        };
        let reservation = match &loaded.state.lifecycle {
            Lifecycle::Creating(
                CreatingState::Reserved(reservation) | CreatingState::Started { reservation, .. },
            ) => reservation,
            _ => return Ok(()),
        };
        if !self
            .request
            .matches_operation(&reservation.operation_id, &reservation.request_digest)
        {
            return Ok(());
        }
        if loaded.state.creation_start().is_some() {
            return self.admit()?.abort_if_absent();
        }
        let abort_id = OperationIdV1::new(format!("checkout-create-reject-{}", self.binding))
            .map_err(|_| state_error("derived creation rejection identity is invalid"))?;
        let request = self.request.creation_abort(abort_id, &reservation.token)?;
        self.lease.apply(request, Some(loaded))?;
        Ok(())
    }

    pub fn admit(self) -> Result<AdmittedGitCheckoutCreation, GitCheckoutUseError> {
        let Self {
            request,
            lease,
            binding,
        } = self;
        let loaded = read_state(&request.authority)?;
        let previous_start = loaded
            .as_ref()
            .and_then(|loaded| match &loaded.state.lifecycle {
                Lifecycle::Creating(CreatingState::Started { start, .. }) => Some(start),
                _ => None,
            })
            .cloned();
        let receipt = lease.apply(request.clone(), loaded)?;
        let GitCheckoutUseOutcomeV1::CreationReserved { reservation } = receipt.outcome else {
            return Err(state_error(
                "creation admission did not return its reservation",
            ));
        };
        let start_id = OperationIdV1::new(format!("checkout-create-start-{binding}"))
            .map_err(|_| state_error("derived creation start identity is invalid"))?;
        let activation_id = OperationIdV1::new(format!("checkout-create-activate-{binding}"))
            .map_err(|_| state_error("derived creation activation identity is invalid"))?;
        let start_request = request.creation_start(start_id, &reservation.reservation_token)?;
        if let Some(start) = previous_start {
            if !start_request.matches_operation(&start.operation_id, &start.request_digest) {
                return Err(reconciliation_required(
                    "started creation belongs to different inputs or an unbound execution lifetime",
                ));
            }
        } else {
            let loaded = read_state(&request.authority)?;
            lease.apply(start_request.clone(), loaded)?;
        }
        Ok(AdmittedGitCheckoutCreation {
            request,
            lease,
            reservation,
            activation_id,
            start_request,
        })
    }
}

impl AdmittedGitCheckoutCreation {
    pub fn execution_anchor(&self) -> Result<UnixDirectoryAnchor<'_>, UnixBoundCommandFailure> {
        self.lease.anchor()
    }

    /// Retire a failed creator only after its original inheriting writers end.
    /// The reducer still refuses any materialized or registered checkout. No
    /// ownership ref, checkout directory or user file is removed here.
    pub fn abort_if_absent(mut self) -> Result<(), GitCheckoutUseError> {
        self.lease = self.lease.quiesce()?;
        let abort_id = OperationIdV1::new(format!(
            "checkout-create-abort-{}",
            self.start_request.operation_digest()
        ))
        .map_err(|_| state_error("derived creation abort identity is invalid"))?;
        let request = self
            .start_request
            .creation_abort(abort_id, &self.reservation.reservation_token)?;
        let loaded = read_state(&request.authority)?;
        self.lease.apply(request, loaded)?;
        Ok(())
    }

    /// Commit the original reservation's claim only after the physical writer
    /// has finished and its exact checkout instance can be captured.
    pub fn activate(mut self) -> Result<(), GitCheckoutUseError> {
        self.lease = self.lease.quiesce()?;
        let instance = super::super::capture_git_checkout_instance_at(
            &self.request.authority.repository,
            Path::new(&self.request.authority.canonical_path),
        )
        .map_err(|error| instance_error(error, InstanceErrorContext::ExactIdentity))?;
        let request = prepare_request(&GitCheckoutUseRequestV1 {
            schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
            repository_path: path_string(&self.request.authority.repository, "creation repository")
                .map_err(|error| instance_error(error, InstanceErrorContext::Request))?,
            operation_id: self.activation_id,
            action: GitCheckoutUseActionV1::ActivateCreation {
                instance,
                reservation_token: self.reservation.reservation_token,
            },
        })?;
        let loaded = read_state(&request.authority)?;
        self.lease.apply(request, loaded)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiescence_waits_for_every_handle_of_the_original_open_description() {
        let root = tempfile::tempdir().unwrap();
        let path = fs::canonicalize(root.path()).unwrap();
        let lease =
            ExecutionLease::lock(ExecutionLease::open(&path).unwrap(), path.clone()).unwrap();
        let inheritor = lease.directory.try_clone().unwrap();
        let (entered, waiting) = std::sync::mpsc::channel();
        let (finished, completion) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            entered.send(()).unwrap();
            let lease = lease.quiesce().unwrap();
            finished.send(()).unwrap();
            lease
        });
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        let early = completion.recv_timeout(Duration::from_millis(200));
        drop(inheritor);
        let recovered = worker.join().unwrap();
        assert_eq!(early, Err(std::sync::mpsc::RecvTimeoutError::Timeout));
        completion.recv_timeout(Duration::from_secs(2)).unwrap();
        let observer = ExecutionLease::open(&path).unwrap();
        assert_eq!(
            FileExt::try_lock_exclusive(&observer).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        drop(recovered);
        // Other concurrently running tests may briefly inherit CLOEXEC FDs
        // between fork and exec. Availability is eventual, not instantaneous.
        ExecutionLease::lock(observer, path).unwrap();
    }
}
