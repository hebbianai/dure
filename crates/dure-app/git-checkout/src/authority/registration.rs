use super::*;
use crate::GitCheckoutRegistrationV1;

pub(super) fn active_claim<'a>(
    state: &'a State,
    operation_id: &OperationIdV1,
) -> Result<&'a Claim, GitCheckoutUseError> {
    let claim = state
        .claims
        .get(operation_id.as_str())
        .ok_or_else(|| state_error("replayed claim lost its authority-owned row"))?;
    if state.phase() != Phase::Active || !claim.is_active() {
        return Err(phase_conflict(
            "a retired checkout claim is not launch authority",
        ));
    }
    Ok(claim)
}

/// Resolve the checkout containing a working directory without treating a Git
/// command failure as proof that the directory is outside a repository.
fn linked_checkout(
    working_directory: &Path,
) -> Result<Option<(std::path::PathBuf, std::path::PathBuf)>, GitCheckoutInstanceError> {
    for directory in working_directory.ancestors() {
        let git_directory = directory.join(".git");
        let metadata = match fs::symlink_metadata(&git_directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(GitCheckoutInstanceError::new(
                    "worktree_path_unavailable",
                    format!("could not inspect checkout location: {error}"),
                ));
            }
        };
        if metadata.is_dir() {
            // A primary .git directory with no common-directory indirection has
            // no linked-checkout membership to retain. Starting a process here
            // must not depend on Git understanding its repository format.
            match fs::symlink_metadata(git_directory.join("commondir")) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Ok(_) => {}
                Err(error) => {
                    return Err(GitCheckoutInstanceError::new(
                        "worktree_path_unavailable",
                        format!("could not inspect checkout common directory: {error}"),
                    ));
                }
            }
        }
        let location = super::super::locate_checkout(directory)?;
        let checkout = std::path::PathBuf::from(&location.canonical_path);
        let git_dir = super::super::canonical_git_path(
            &checkout,
            &["rev-parse", "--path-format=absolute", "--absolute-git-dir"],
            "checkout Git directory",
        )?;
        if git_dir == Path::new(&location.git_common_dir) {
            return Ok(None);
        }
        let repository = super::super::registered_worktree_paths(&checkout)?
            .into_iter()
            .next()
            .ok_or_else(|| {
                GitCheckoutInstanceError::new(
                    "worktree_not_registered",
                    "linked checkout has no registered repository root",
                )
            })?;
        return Ok(Some((repository, checkout)));
    }
    Ok(None)
}

fn registration_directory(
    working_directory: &Path,
) -> Result<TrustedLocator, GitCheckoutInstanceError> {
    let working_directory = TrustedLocator::parse_path(working_directory, "working directory")
        .map_err(use_error_as_instance)?;
    let canonical = match dunce::canonicalize(working_directory.as_path()) {
        Ok(canonical) => canonical,
        // A retained registration can outlive its directory. Preserve exact
        // lifecycle replay so a removed claim is refused by its Git authority.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            working_directory.as_path().to_path_buf()
        }
        Err(error) => {
            return Err(GitCheckoutInstanceError::new(
                "worktree_path_unavailable",
                format!("could not resolve working directory: {error}"),
            ));
        }
    };
    TrustedLocator::parse_path(&canonical, "working directory").map_err(use_error_as_instance)
}

/// Freeze a working directory's linked checkout without admitting a user of it.
/// Product lifecycles can persist this selection before their first claim. The
/// existing instance token may be materialized; no membership claim is created.
pub fn capture_git_checkout_registration(
    working_directory: &Path,
) -> Result<Option<GitCheckoutRegistrationV1>, GitCheckoutInstanceError> {
    let working_directory = registration_directory(working_directory)?;
    capture_registration(working_directory.as_path())
}

fn capture_registration(
    working_directory: &Path,
) -> Result<Option<GitCheckoutRegistrationV1>, GitCheckoutInstanceError> {
    let Some((repository, checkout)) = linked_checkout(working_directory)? else {
        return Ok(None);
    };
    Ok(Some(GitCheckoutRegistrationV1 {
        instance: super::super::capture_git_checkout_instance_at(&repository, &checkout)?,
        repository_path: path_string(&repository, "repository path")?,
    }))
}

/// The caller's durable registration operation is also its exact claim identity.
pub fn claim_git_checkout_registration(
    working_directory: &Path,
    registration_id: &OperationIdV1,
    expected: Option<&GitCheckoutRegistrationV1>,
) -> Result<Option<GitCheckoutRegistrationV1>, GitCheckoutInstanceError> {
    let working_directory = registration_directory(working_directory)?;
    let registration = match expected {
        Some(registration) => {
            if !working_directory
                .as_path()
                .starts_with(&registration.instance.canonical_path)
            {
                return Err(GitCheckoutInstanceError::new(
                    "worktree_identity_changed",
                    "working directory is outside the frozen checkout registration",
                ));
            }
            registration.clone()
        }
        None => {
            let Some(registration) = capture_registration(working_directory.as_path())? else {
                return Ok(None);
            };
            registration
        }
    };
    let request = prepare_request(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: registration.repository_path.clone(),
        operation_id: registration_id.clone(),
        action: GitCheckoutUseActionV1::Claim {
            instance: registration.instance.clone(),
            owner_id: registration_id.clone(),
        },
    })
    .map_err(use_error_as_instance)?;
    let loaded = read_state(&request.authority).map_err(use_error_as_instance)?;
    let request = request
        .for_registration(loaded.as_ref().map(|loaded| &loaded.state))
        .map_err(use_error_as_instance)?;
    apply_loaded_request(request, loaded).map_err(use_error_as_instance)?;
    Ok(Some(registration))
}

fn current_registration_state(
    registration: &GitCheckoutRegistrationV1,
) -> Result<Option<(Authority, LoadedState)>, GitCheckoutInstanceError> {
    let repository = TrustedLocator::parse(&registration.repository_path, "repository path")
        .map_err(use_error_as_instance)?;
    let instance = ValidatedGitCheckoutInstance::parse(&registration.instance)?;
    let (authority, instance_digest) =
        Authority::for_validated_instance(&repository, &instance).map_err(use_error_as_instance)?;
    let Some(loaded) = read_state(&authority).map_err(use_error_as_instance)? else {
        return Ok(None);
    };
    if loaded.state.phase() == Phase::Removed
        || loaded.state.instance_digest() != Some(&instance_digest)
    {
        return Ok(None);
    }
    Ok(Some((authority, loaded)))
}

/// Observe exact current membership without reserving removal or mutating Git.
/// A subsequent removal still needs its own authoritative admission.
pub fn read_git_checkout_claims(
    registration: &GitCheckoutRegistrationV1,
) -> Result<Vec<GitCheckoutUseClaimV1>, GitCheckoutInstanceError> {
    let Some((_, loaded)) = current_registration_state(registration)? else {
        return Ok(Vec::new());
    };
    active_claims(&loaded.state).map_err(use_error_as_instance)
}

/// Retire only this registration. Legacy registrations and an already retired
/// claim require no write; a same-path successor belongs to its own registration.
pub fn release_git_checkout_registration(
    registration: &GitCheckoutRegistrationV1,
    registration_id: &OperationIdV1,
    operation_id: &OperationIdV1,
) -> Result<(), GitCheckoutInstanceError> {
    let Some((authority, loaded)) = current_registration_state(registration)? else {
        return Ok(());
    };
    let Some(claim) = loaded.state.claims.get(registration_id.as_str()) else {
        return Ok(());
    };
    if !claim.is_active() {
        return Ok(());
    }
    apply_git_checkout_use(&GitCheckoutUseRequestV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        repository_path: path_string(&authority.repository, "repository path")?,
        operation_id: operation_id.clone(),
        action: GitCheckoutUseActionV1::Release {
            instance: registration.instance.clone(),
            claim_id: registration_id.clone(),
        },
    })
    .map_err(use_error_as_instance)?;
    Ok(())
}
