use dure_git_checkout::{GitCheckoutCaptureRequestV1, GitCheckoutRemovalRequestV1};
pub use dure_git_checkout::{
    GitCheckoutInstanceError, GitCheckoutInstanceV1, GitCheckoutPathObservationV1,
    GitCheckoutReclaimOutcome, GitCheckoutReclaimScan, GitCheckoutRemovalPolicyV1,
    GitCheckoutRemovalReceiptV1,
};

/// One confirmation removes at most this many checkouts.
const MAX_RECLAIM_BATCH: usize = 1024;

#[tauri::command(async)]
pub fn locate_git_checkout_paths(
    paths: Vec<String>,
) -> Result<Vec<Option<GitCheckoutPathObservationV1>>, GitCheckoutInstanceError> {
    dure_git_checkout::locate_checkouts(&paths)
}

#[tauri::command(async)]
pub fn capture_git_checkout_instance(
    repo: String,
    worktree_path: String,
) -> Result<GitCheckoutInstanceV1, GitCheckoutInstanceError> {
    dure_git_checkout::capture_git_checkout_instance(&GitCheckoutCaptureRequestV1 {
        repository_path: repo,
        checkout_path: worktree_path,
    })
}

#[tauri::command]
pub async fn remove_git_checkout_instance<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    repo: String,
    instance: GitCheckoutInstanceV1,
    policy: GitCheckoutRemovalPolicyV1,
) -> Result<GitCheckoutRemovalReceiptV1, GitCheckoutInstanceError> {
    crate::session_checkout::reconcile_checkout(
        app,
        dure_app::GitCheckoutRegistrationV1 {
            repository_path: repo.clone(),
            instance: instance.clone(),
        },
    )
    .await
    .map_err(|error| match error {
        dure_session_runtime::SessionCheckoutError::Checkout(error) => error,
        error => GitCheckoutInstanceError {
            code: "worktree_remove_failed",
            message: error.to_string(),
        },
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        dure_git_checkout::remove_git_checkout_instance(&GitCheckoutRemovalRequestV1 {
            repository_path: repo,
            instance,
            policy,
        })
    })
    .await
    .map_err(|error| GitCheckoutInstanceError {
        code: "worktree_remove_failed",
        message: error.to_string(),
    })?
}

/// The linked worktrees the product created for one local project, each with
/// whether it may be removed and why not. Read-only.
#[tauri::command(async)]
pub fn scan_reclaimable_worktrees(
    repo: String,
) -> Result<GitCheckoutReclaimScan, GitCheckoutInstanceError> {
    dure_git_checkout::scan_reclaimable_checkouts(std::path::Path::new(&repo))
}

/// Remove the offered checkouts one by one, each re-checked first. Outcomes
/// come back in request order; one refusal never stops the rest.
#[tauri::command(async)]
pub fn reclaim_worktrees(
    repo: String,
    instances: Vec<GitCheckoutInstanceV1>,
) -> Result<Vec<GitCheckoutReclaimOutcome>, GitCheckoutInstanceError> {
    if instances.len() > MAX_RECLAIM_BATCH {
        return Err(GitCheckoutInstanceError {
            code: "worktree_request_invalid",
            message: "too many checkouts in one reclaim request".to_owned(),
        });
    }
    let repository = std::path::Path::new(&repo);
    Ok(instances
        .iter()
        .map(|instance| dure_git_checkout::reclaim_checkout(repository, instance))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkout_location_requests_are_bounded_absolute_batches() {
        assert_eq!(
            locate_git_checkout_paths(vec![]).unwrap_err().code,
            "worktree_request_invalid"
        );
        assert_eq!(
            locate_git_checkout_paths(vec!["relative".to_string()])
                .unwrap_err()
                .code,
            "worktree_request_invalid"
        );
        assert_eq!(
            locate_git_checkout_paths(vec!["/tmp".to_string(); 257])
                .unwrap_err()
                .code,
            "worktree_request_invalid"
        );
    }
}
