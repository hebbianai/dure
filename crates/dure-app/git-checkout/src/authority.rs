//! One Git-ref compare-and-swap authority for app-owned checkout use.

use super::{
    GitCheckoutInstanceError, GitCheckoutPhysicalRemovalError, ValidatedGitCheckoutInstance,
    path_string, remove_git_checkout_instance_at_classified, reobserve_git_checkout_instance_at,
};
use dure_app_protocol::{
    GIT_CHECKOUT_SCHEMA_VERSION_V1, GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
    GitCheckoutCreationReservationV1, GitCheckoutInstanceV1, GitCheckoutRemovalOutcomeV1,
    GitCheckoutRemovalPermitV1, GitCheckoutRemovalPolicyV1, GitCheckoutRemovalReceiptV1,
    GitCheckoutUseActionV1, GitCheckoutUseClaimV1, GitCheckoutUseOutcomeV1, GitCheckoutUsePhaseV1,
    GitCheckoutUsePhysicalRemovalRequestV1, GitCheckoutUseReceiptV1, GitCheckoutUseRequestV1,
    GitCheckoutUseRevisionV1, MAX_GIT_CHECKOUT_USE_ACTIVE_CLAIMS_V1,
    MAX_GIT_CHECKOUT_USE_REVISION_V1, OperationIdV1,
};
use serde::Serialize;
use std::fs;
use std::path::Path;

#[cfg(test)]
use super::capture_git_checkout_instance_at;

mod directory_use;
use directory_use::DirectoryUseGuard;
pub use directory_use::{
    read_working_directory_claims, release_working_directory, retain_working_directory,
};

mod application;
pub use application::apply_git_checkout_use;
use application::apply_loaded_request;
#[cfg(unix)]
use application::apply_loaded_request_using;
#[cfg(unix)]
mod creation;
#[cfg(unix)]
pub use creation::{
    AdmittedGitCheckoutCreation, GitCheckoutCreationOperation, prepare_git_checkout_creation,
};
mod git_ref;
mod reducer;
mod registration;
mod removal;
mod state;
use git_ref::*;
use reducer::*;
pub use registration::{
    capture_git_checkout_registration, claim_git_checkout_registration, read_git_checkout_claims,
    release_git_checkout_registration,
};
pub(crate) use removal::remove_git_checkout_instance_admitted;
pub use removal::{AdmittedGitCheckoutRemoval, GitCheckoutRemovalOperation};
#[cfg(test)]
use removal::{legacy_operation_id, remove_git_checkout_instance_admitted_using};
use state::*;

const REF_PREFIX: &str = "refs/dure/checkout-use/v1/";
const RECORD_HEADER: &str = "dure-checkout-use-v1";
const MAX_RECORD_BYTES: usize = 256 * 1024;
const MAX_CLAIMS: usize = MAX_GIT_CHECKOUT_USE_ACTIVE_CLAIMS_V1;
const MAX_CAS_ATTEMPTS: usize = 16;

const PATH_DOMAIN: &[u8] = b"dure-checkout-use-path-v1";
const INSTANCE_DOMAIN: &[u8] = b"dure-checkout-use-instance-v1";
const REQUEST_DOMAIN: &[u8] = b"dure-checkout-use-request-v1";
const RESERVATION_DOMAIN: &[u8] = b"dure-checkout-use-reservation-v1";
const PERMIT_DOMAIN: &[u8] = b"dure-checkout-use-permit-v1";
const CHECKOUT_USE_ERROR_CODES: &[&str] = &[
    "checkout_use_request_invalid",
    "checkout_use_state_invalid",
    "checkout_use_revision_exhausted",
    "checkout_use_git_failed",
    "checkout_use_record_too_large",
    "checkout_use_capacity_exceeded",
    "checkout_use_operation_conflict",
    "checkout_use_phase_conflict",
    "checkout_use_instance_conflict",
    "checkout_use_claim_missing",
    "checkout_use_in_use",
    "checkout_use_creation_reconcile_required",
    "checkout_use_removal_reconcile_required",
    "checkout_use_cas_exhausted",
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutUseError {
    pub code: &'static str,
    pub message: String,
}

impl GitCheckoutUseError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        debug_assert!(
            CHECKOUT_USE_ERROR_CODES.contains(&code),
            "checkout-use error code must be frozen in the shared contract"
        );
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for GitCheckoutUseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for GitCheckoutUseError {}

fn request_error(message: impl Into<String>) -> GitCheckoutUseError {
    GitCheckoutUseError::new("checkout_use_request_invalid", message)
}

fn state_error(message: impl Into<String>) -> GitCheckoutUseError {
    GitCheckoutUseError::new("checkout_use_state_invalid", message)
}

fn revision(value: u64) -> Result<GitCheckoutUseRevisionV1, GitCheckoutUseError> {
    GitCheckoutUseRevisionV1::new(value).ok_or_else(|| {
        GitCheckoutUseError::new(
            "checkout_use_revision_exhausted",
            "checkout-use revision exceeded the shared exact decimal bound",
        )
    })
}

fn next_revision(value: u64) -> Result<u64, GitCheckoutUseError> {
    value
        .checked_add(1)
        .filter(|revision| *revision <= MAX_GIT_CHECKOUT_USE_REVISION_V1)
        .ok_or_else(|| {
            GitCheckoutUseError::new(
                "checkout_use_revision_exhausted",
                "checkout-use revision exceeded the shared exact decimal bound",
            )
        })
}

#[derive(Clone, Copy)]
enum InstanceErrorContext {
    Request,
    ExactIdentity,
    Git,
}

fn instance_error(
    cause: GitCheckoutInstanceError,
    context: InstanceErrorContext,
) -> GitCheckoutUseError {
    let code = match context {
        InstanceErrorContext::Request => "checkout_use_request_invalid",
        InstanceErrorContext::Git => "checkout_use_git_failed",
        InstanceErrorContext::ExactIdentity => match cause.code {
            "worktree_foreign_repository"
            | "worktree_identity_changed"
            | "worktree_not_linked"
            | "worktree_not_registered"
            | "worktree_path_not_distinct"
            | "worktree_path_not_exact"
            | "worktree_path_unavailable"
            | "worktree_token_invalid"
            | "worktree_token_unavailable" => "checkout_use_instance_conflict",
            _ => "checkout_use_git_failed",
        },
    };
    GitCheckoutUseError::new(code, cause.message)
}

fn ensure_exact_instance(
    authority: &Authority,
    expected: &GitCheckoutInstanceV1,
) -> Result<(), GitCheckoutUseError> {
    let current = reobserve_git_checkout_instance_at(
        &authority.repository,
        Path::new(&expected.canonical_path),
    )
    .map_err(|cause| instance_error(cause, InstanceErrorContext::ExactIdentity))?;
    if current != *expected {
        return Err(instance_conflict());
    }
    Ok(())
}

fn ensure_creation_target_absent(authority: &Authority) -> Result<(), GitCheckoutUseError> {
    match fs::symlink_metadata(&authority.canonical_path) {
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => {
            return Err(GitCheckoutUseError::new(
                "checkout_use_creation_reconcile_required",
                "reserved checkout target materialized before creation abort",
            ));
        }
        Err(cause) => {
            return Err(GitCheckoutUseError::new(
                "checkout_use_creation_reconcile_required",
                format!("reserved checkout target could not be inspected: {cause}"),
            ));
        }
    }
    let target = Path::new(&authority.canonical_path);
    let registered = super::registered_worktree_paths(&authority.repository)
        .map_err(|cause| instance_error(cause, InstanceErrorContext::Git))?
        .into_iter()
        .any(|path| dunce::simplified(&path) == dunce::simplified(target));
    if registered {
        return Err(GitCheckoutUseError::new(
            "checkout_use_creation_reconcile_required",
            "reserved checkout target is registered and must be reconciled",
        ));
    }
    Ok(())
}

fn physical_request_digest(
    authority: &Authority,
    instance_digest: &str,
    request: &GitCheckoutUsePhysicalRemovalRequestV1,
) -> Result<String, GitCheckoutUseError> {
    let mut fields = vec![
        "physical_remove".to_string(),
        authority.path_digest.clone(),
        instance_digest.to_string(),
        request.permit_token.clone(),
    ];
    if request.policy == GitCheckoutRemovalPolicyV1::DiscardChanges {
        fields.push(request.policy.as_str().to_string());
    }
    fields.push(request.operation_id.as_str().to_string());
    let fields = fields.iter().map(String::as_str).collect::<Vec<_>>();
    digest_fields(&authority.repository, REQUEST_DOMAIN, &fields)
}

fn permit_matches_state(state: &State, instance_digest: &str, permit_token: &str) -> bool {
    state.instance_digest() == Some(instance_digest)
        && state
            .permit()
            .is_some_and(|slot| slot.token == permit_token)
}

fn permit_allows_policy(
    authority: &Authority,
    state: &State,
    instance_digest: &str,
    instance: &GitCheckoutInstanceV1,
    policy: GitCheckoutRemovalPolicyV1,
) -> Result<bool, GitCheckoutUseError> {
    let permit = permit_from_state(authority, state, instance)?;
    let retiring_claim_ids = permit
        .retiring_claims
        .iter()
        .map(|claim| claim.claim_id.clone())
        .collect::<Vec<_>>();
    Ok(permit.request_digest
        == permit_request_digest(
            authority,
            &permit.operation_id,
            instance_digest,
            &retiring_claim_ids,
            policy,
        )?)
}

fn removed_receipt(
    authority: &Authority,
    state: &State,
    instance: &GitCheckoutInstanceV1,
) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
    let terminal = state
        .terminal()
        .ok_or_else(|| state_error("removed checkout-use state lost its receipt"))?;
    let permit = permit_from_state(authority, state, instance)?;
    use_receipt(
        terminal.operation_id,
        terminal.request_digest,
        terminal.revision,
        GitCheckoutUsePhaseV1::Removed,
        GitCheckoutUseOutcomeV1::Removed {
            permit,
            removal: physical_receipt(instance, terminal.kind)?,
        },
    )
}

enum PhysicalStart {
    Execute,
    Reconcile,
    Terminal(Box<GitCheckoutUseReceiptV1>),
}

fn start_physical_removal(
    authority: &Authority,
    instance_digest: &str,
    request: &GitCheckoutUsePhysicalRemovalRequestV1,
    request_digest: &str,
) -> Result<PhysicalStart, GitCheckoutUseError> {
    for _ in 0..MAX_CAS_ATTEMPTS {
        let loaded = read_state(authority)?
            .ok_or_else(|| phase_conflict("checkout removal has no authoritative permit"))?;
        let state = &loaded.state;
        if state.phase() == Phase::Removed
            && permit_matches_state(state, instance_digest, &request.permit_token)
        {
            let terminal = state
                .terminal()
                .ok_or_else(|| state_error("removed checkout-use state lost its receipt"))?;
            if terminal.operation_id != request.operation_id.as_str()
                || terminal.request_digest != request_digest
            {
                return Err(phase_conflict(
                    "only the exact terminal physical removal request can replay",
                ));
            }
            return Ok(PhysicalStart::Terminal(Box::new(removed_receipt(
                authority,
                state,
                &request.instance,
            )?)));
        }
        if let Some(operation) = find_lifecycle_operation(state, request.operation_id.as_str()) {
            if operation.kind != "physical" || operation.request_digest != request_digest {
                return Err(GitCheckoutUseError::new(
                    "checkout_use_operation_conflict",
                    "physical removal operation id was replayed with a changed payload",
                ));
            }
            if state.phase() == Phase::Removing
                && state.physical().is_some_and(|physical| {
                    physical.operation_id == request.operation_id.as_str()
                        && physical.request_digest == request_digest
                })
                && permit_matches_state(state, instance_digest, &request.permit_token)
            {
                return Ok(PhysicalStart::Reconcile);
            }
            return Err(state_error(
                "physical removal replay disagrees with checkout-use state",
            ));
        }
        if state.phase() != Phase::Removing
            || state.physical().is_some()
            || !permit_matches_state(state, instance_digest, &request.permit_token)
        {
            return Err(phase_conflict(
                "physical removal did not consume the exact live permit",
            ));
        }
        if !permit_allows_policy(
            authority,
            state,
            instance_digest,
            &request.instance,
            request.policy,
        )? {
            return Err(GitCheckoutUseError::new(
                "checkout_use_operation_conflict",
                "physical removal policy disagrees with its exact permit",
            ));
        }
        let new_revision = next_revision(state.revision)?;
        let mut next = state.clone();
        next.revision = new_revision;
        let Lifecycle::Removing {
            instance_digest,
            creation,
            permit,
            progress: RemovalProgress::Permitted,
        } = &next.lifecycle
        else {
            unreachable!("live removal without physical marker is permitted lifecycle");
        };
        next.lifecycle = Lifecycle::Removing {
            instance_digest: instance_digest.clone(),
            creation: creation.clone(),
            permit: permit.clone(),
            progress: RemovalProgress::Executing(OperationMarker {
                operation_id: request.operation_id.as_str().to_string(),
                request_digest: request_digest.to_string(),
                revision: new_revision,
            }),
        };
        if compare_and_swap(authority, Some(&loaded.oid), &next)? {
            return Ok(PhysicalStart::Execute);
        }
    }
    Err(GitCheckoutUseError::new(
        "checkout_use_cas_exhausted",
        "physical-removal marker compare-and-swap retries were exhausted",
    ))
}

fn rollback_refused_physical_removal(
    authority: &Authority,
    instance_digest: &str,
    permit_token: &str,
    physical_operation_id: &OperationIdV1,
    physical_digest: &str,
) -> Result<(), GitCheckoutUseError> {
    let abort_operation_id = OperationIdV1::new(format!("physical-abort-{physical_digest}"))
        .map_err(|_| state_error("derived physical-abort operation id is invalid"))?;
    let abort_digest = digest_fields(
        &authority.repository,
        REQUEST_DOMAIN,
        &[
            "physical_failure_abort",
            &authority.path_digest,
            instance_digest,
            permit_token,
            physical_operation_id.as_str(),
            physical_digest,
        ],
    )?;
    for _ in 0..MAX_CAS_ATTEMPTS {
        let loaded = read_state(authority)?.ok_or_else(|| {
            state_error("checkout-use state disappeared during physical rollback")
        })?;
        let state = &loaded.state;
        if state.phase() == Phase::Active
            && state
                .last_abort()
                .is_some_and(|slot| slot.token == permit_token)
        {
            return Ok(());
        }
        if state.phase() != Phase::Removing
            || !permit_matches_state(state, instance_digest, permit_token)
            || !state.physical().is_some_and(|physical| {
                physical.operation_id == physical_operation_id.as_str()
                    && physical.request_digest == physical_digest
            })
        {
            return Err(state_error(
                "checkout-use state changed during refused physical removal",
            ));
        }
        let new_revision = next_revision(state.revision)?;
        let mut next = state.clone();
        next.revision = new_revision;
        let abort = Slot {
            token: permit_token.to_string(),
            operation_id: abort_operation_id.as_str().to_string(),
            request_digest: abort_digest.clone(),
            revision: new_revision,
        };
        let Lifecycle::Removing {
            instance_digest,
            creation,
            permit,
            progress: RemovalProgress::Executing(_),
        } = &next.lifecycle
        else {
            unreachable!("matched physical removal is executing lifecycle");
        };
        next.lifecycle = Lifecycle::Active {
            instance_digest: instance_digest.clone(),
            creation: creation.clone(),
            removal: ActiveRemoval::Aborted {
                permit: permit.clone(),
                abort,
            },
        };
        compact_released_claims(&mut next);
        if compare_and_swap(authority, Some(&loaded.oid), &next)? {
            return Ok(());
        }
    }
    Err(GitCheckoutUseError::new(
        "checkout_use_cas_exhausted",
        "physical-removal rollback compare-and-swap retries were exhausted",
    ))
}

fn terminalize_physical_removal(
    authority: &Authority,
    instance_digest: &str,
    request: &GitCheckoutUsePhysicalRemovalRequestV1,
    request_digest: &str,
    removal: &GitCheckoutRemovalReceiptV1,
) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
    for _ in 0..MAX_CAS_ATTEMPTS {
        let loaded = read_state(authority)?
            .ok_or_else(|| state_error("checkout-use state disappeared after physical removal"))?;
        let state = &loaded.state;
        if state.phase() == Phase::Removed
            && permit_matches_state(state, instance_digest, &request.permit_token)
        {
            return removed_receipt(authority, state, &request.instance);
        }
        if state.phase() != Phase::Removing
            || !permit_matches_state(state, instance_digest, &request.permit_token)
            || !state.physical().is_some_and(|physical| {
                physical.operation_id == request.operation_id.as_str()
                    && physical.request_digest == request_digest
            })
        {
            return Err(state_error(
                "checkout-use state changed after physical removal",
            ));
        }
        let new_revision = next_revision(state.revision)?;
        let mut next = state.clone();
        next.revision = new_revision;
        let outcome = match removal.outcome {
            GitCheckoutRemovalOutcomeV1::Removed => PhysicalOutcome::Removed,
            GitCheckoutRemovalOutcomeV1::AlreadyAbsent => PhysicalOutcome::AlreadyAbsent,
        };
        let Lifecycle::Removing {
            instance_digest,
            creation,
            permit,
            progress: RemovalProgress::Executing(physical),
        } = &next.lifecycle
        else {
            unreachable!("matched physical removal is executing lifecycle");
        };
        next.lifecycle =
            Lifecycle::Removed(RemovedState::Physical(Box::new(PhysicalRemovedState {
                instance_digest: instance_digest.clone(),
                creation: creation.clone(),
                permit: permit.clone(),
                physical: physical.clone(),
                outcome,
            })));
        compact_released_claims(&mut next);
        let permit = permit_from_state(authority, state, &request.instance)?;
        if compare_and_swap(authority, Some(&loaded.oid), &next)? {
            return use_receipt(
                request.operation_id.as_str(),
                request_digest,
                new_revision,
                GitCheckoutUsePhaseV1::Removed,
                GitCheckoutUseOutcomeV1::Removed {
                    permit,
                    removal: removal.clone(),
                },
            );
        }
    }
    Err(GitCheckoutUseError::new(
        "checkout_use_cas_exhausted",
        "terminal removal compare-and-swap retries were exhausted",
    ))
}

fn reconcile_in_flight_physical_removal(
    authority: &Authority,
    instance_digest: &str,
    request: &GitCheckoutUsePhysicalRemovalRequestV1,
    request_digest: &str,
) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
    match super::target_is_absent(&request.instance) {
        Ok(true) => terminalize_physical_removal(
            authority,
            instance_digest,
            request,
            request_digest,
            &GitCheckoutRemovalReceiptV1 {
                schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
                outcome: GitCheckoutRemovalOutcomeV1::AlreadyAbsent,
                instance: request.instance.clone(),
            },
        ),
        Ok(false) => Err(GitCheckoutUseError::new(
            "checkout_use_removal_reconcile_required",
            "physical removal already started and the exact checkout still exists",
        )),
        Err(cause) => Err(GitCheckoutUseError::new(
            "checkout_use_removal_reconcile_required",
            format!(
                "physical removal already started and exact absence is ambiguous: {}",
                cause.message
            ),
        )),
    }
}

fn remove_git_checkout_with_permit_using(
    request: &GitCheckoutUsePhysicalRemovalRequestV1,
    physical_remove: impl FnOnce(
        &Path,
        &ValidatedGitCheckoutInstance,
        GitCheckoutRemovalPolicyV1,
    )
        -> Result<GitCheckoutRemovalReceiptV1, GitCheckoutPhysicalRemovalError>,
) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
    if request.schema_version != GIT_CHECKOUT_USE_SCHEMA_VERSION_V1 {
        return Err(request_error(
            "physical removal request schema is unsupported",
        ));
    }
    let repository = TrustedLocator::parse(&request.repository_path, "repository path")?;
    let instance = ValidatedGitCheckoutInstance::parse(&request.instance)
        .map_err(|cause| instance_error(cause, InstanceErrorContext::Request))?;
    let (authority, instance_digest) = Authority::for_validated_instance(&repository, &instance)?;
    if !authority.valid_oid(&request.permit_token) {
        return Err(request_error("checkout removal permit token is invalid"));
    }
    let request_digest = physical_request_digest(&authority, &instance_digest, request)?;
    DirectoryUseGuard::open()?.begin_removal(&request.instance)?;
    let result = remove_git_checkout_with_directory_fenced(
        request,
        physical_remove,
        &authority,
        &instance,
        &instance_digest,
        &request_digest,
    );
    application::reconcile_directory_removal(
        &mut DirectoryUseGuard::open()?,
        &authority,
        &request.instance,
    )?;
    result
}

fn remove_git_checkout_with_directory_fenced(
    request: &GitCheckoutUsePhysicalRemovalRequestV1,
    physical_remove: impl FnOnce(
        &Path,
        &ValidatedGitCheckoutInstance,
        GitCheckoutRemovalPolicyV1,
    )
        -> Result<GitCheckoutRemovalReceiptV1, GitCheckoutPhysicalRemovalError>,
    authority: &Authority,
    instance: &ValidatedGitCheckoutInstance,
    instance_digest: &str,
    request_digest: &str,
) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
    match start_physical_removal(authority, instance_digest, request, request_digest)? {
        PhysicalStart::Terminal(receipt) => return Ok(*receipt),
        PhysicalStart::Reconcile => {
            return reconcile_in_flight_physical_removal(
                authority,
                instance_digest,
                request,
                request_digest,
            );
        }
        PhysicalStart::Execute => {}
    }
    let removal = match physical_remove(&authority.repository, instance, request.policy) {
        Ok(removal) => removal,
        Err(GitCheckoutPhysicalRemovalError::RefusedBeforeInvocation(cause)) => {
            rollback_refused_physical_removal(
                authority,
                instance_digest,
                &request.permit_token,
                &request.operation_id,
                request_digest,
            )?;
            return Err(instance_error(cause, InstanceErrorContext::ExactIdentity));
        }
        Err(GitCheckoutPhysicalRemovalError::Attempted(cause)) => {
            return match super::target_is_absent(&request.instance) {
                Ok(true) => terminalize_physical_removal(
                    authority,
                    instance_digest,
                    request,
                    request_digest,
                    &GitCheckoutRemovalReceiptV1 {
                        schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
                        outcome: GitCheckoutRemovalOutcomeV1::AlreadyAbsent,
                        instance: request.instance.clone(),
                    },
                ),
                Ok(false) => Err(GitCheckoutUseError::new(
                    "checkout_use_removal_reconcile_required",
                    format!(
                        "physical Git removal was attempted but did not prove exact absence: {}",
                        cause.message
                    ),
                )),
                Err(observation) => Err(GitCheckoutUseError::new(
                    "checkout_use_removal_reconcile_required",
                    format!(
                        "physical Git removal was attempted and exact target state is ambiguous: {}; removal failure: {}",
                        observation.message, cause.message
                    ),
                )),
            };
        }
    };
    terminalize_physical_removal(
        authority,
        instance_digest,
        request,
        request_digest,
        &removal,
    )
}

pub fn remove_git_checkout_with_permit(
    request: &GitCheckoutUsePhysicalRemovalRequestV1,
) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
    remove_git_checkout_with_permit_using(request, remove_git_checkout_instance_at_classified)
}

fn use_error_as_instance(cause: GitCheckoutUseError) -> GitCheckoutInstanceError {
    let code = match cause.code {
        "checkout_use_instance_conflict" => "worktree_identity_changed",
        code => code,
    };
    GitCheckoutInstanceError::new(code, cause.message)
}

#[cfg(test)]
#[path = "authority_tests.rs"]
mod tests;
