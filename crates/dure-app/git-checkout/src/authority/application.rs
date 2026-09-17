use super::*;

pub fn apply_git_checkout_use(
    request: &GitCheckoutUseRequestV1,
) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
    let request = prepare_request(request)?;
    let loaded = read_state(&request.authority)?;
    apply_loaded_request(request, loaded)
}

pub(super) fn apply_loaded_request(
    request: PreparedRequest,
    loaded: Option<LoadedState>,
) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
    apply_loaded_request_using(request, loaded, compare_and_swap)
}

pub(super) fn apply_loaded_request_using(
    request: PreparedRequest,
    loaded: Option<LoadedState>,
    commit: impl Fn(&Authority, Option<&str>, &State) -> Result<bool, GitCheckoutUseError>,
) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
    let removal = request
        .directory_removal()
        .map(|(instance, begin)| (instance.clone(), begin));
    let Some((instance, begin)) = removal else {
        return apply_unfenced(request, loaded, commit);
    };
    let authority = request.authority.clone();
    let mut directory = DirectoryUseGuard::open()?;
    if begin {
        directory.begin_removal(&instance)?;
    }
    let result = apply_unfenced(request, loaded, commit);
    // The response may replay an older revision. Only current Git state can
    // clear a fence, never a stale abort or an unobserved failed CAS.
    reconcile_directory_removal(&mut directory, &authority, &instance)?;
    result
}

pub(super) fn reconcile_directory_removal(
    directory: &mut DirectoryUseGuard,
    authority: &Authority,
    instance: &GitCheckoutInstanceV1,
) -> Result<(), GitCheckoutUseError> {
    if !read_state(authority)?.is_some_and(|loaded| loaded.state.phase() == Phase::Removing) {
        directory.finish_removal(instance)?;
    }
    Ok(())
}

fn apply_unfenced(
    request: PreparedRequest,
    mut loaded: Option<LoadedState>,
    commit: impl Fn(&Authority, Option<&str>, &State) -> Result<bool, GitCheckoutUseError>,
) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
    for attempt in 0..MAX_CAS_ATTEMPTS {
        if attempt > 0 {
            loaded = read_state(&request.authority)?;
        }
        let plan = reduce_request(loaded.as_ref().map(|loaded| &loaded.state), &request)?;
        if plan.validate_absent_target {
            ensure_creation_target_absent(&request.authority)?;
        }
        if let Some(instance) = &plan.validate_instance {
            ensure_exact_instance(&request.authority, instance)?;
        }
        let Some(state) = plan.state else {
            return Ok(plan.receipt);
        };
        let expected = loaded.as_ref().map(|loaded| loaded.oid.as_str());
        if commit(&request.authority, expected, &state)? {
            return Ok(plan.receipt);
        }
    }
    Err(GitCheckoutUseError::new(
        "checkout_use_cas_exhausted",
        "checkout-use compare-and-swap retries were exhausted",
    ))
}
