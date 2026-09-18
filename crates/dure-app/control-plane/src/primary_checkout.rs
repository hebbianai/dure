//! Session-start guidance for agents whose working directory is a Git
//! repository's primary checkout. `dure-app` owns the query arguments, the
//! classification and the text; this module runs the query where the agent
//! runs, within the caller's budget.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

/// Bounds the Git query so a slow repository cannot consume a caller's
/// report or startup budget.
pub(crate) const PRIMARY_CHECKOUT_QUERY_TIMEOUT: Duration = Duration::from_millis(500);

/// Guidance for a session working inside a primary checkout, or `None` for a
/// linked worktree, a directory outside Git or a failed query.
pub(crate) async fn primary_checkout_session_context(
    cwd: &Path,
    budget: Duration,
) -> Option<String> {
    if budget.is_zero() {
        return None;
    }
    let output = tokio::time::timeout(
        budget,
        tokio::process::Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(dure_app::PRIMARY_CHECKOUT_REV_PARSE_ARGUMENTS_V1)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    dure_app::primary_checkout_session_context_v1(std::str::from_utf8(&output.stdout).ok()?)
}
