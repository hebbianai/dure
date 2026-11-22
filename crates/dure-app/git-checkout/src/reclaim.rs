//! Offer finished checkouts back to the disk.
//!
//! Only a linked worktree this crate's checkout authority created is a
//! candidate. It is offered when removing it with plain `git worktree remove`
//! cannot lose anything: no claim or retained working directory holds it, Git
//! has not locked it, it has no uncommitted or untracked changes, and its HEAD
//! is on a branch or reachable from a branch, tag or remote ref. Removal keeps
//! every branch and commit, so the checkout can be created again.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use dure_app_protocol::OperationIdV1;
use serde::Serialize;

use super::authority::{ReclaimMembership, reclaim_membership};
use super::git_process::{GIT_TIMEOUT, capture_git_output, checkout_is_clean_for_plain_remove};
use super::{
    GitCheckoutInstanceError, GitCheckoutInstanceV1, GitCheckoutRegistrationV1,
    GitCheckoutRemovalOperation, GitCheckoutRemovalPolicyV1, GitCheckoutRemovalRequestV1,
    git_output, observe_repository, path_string, reobserve_git_checkout_instance_at,
};

/// Each check runs Git and the size walk reads every file, so a project with
/// hundreds of checkouts is classified a few at a time.
const SCAN_WORKERS: usize = 4;

/// Why a checkout the product created is kept.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCheckoutReclaimHold {
    /// A session, agent or removal still holds it.
    InUse,
    /// `git worktree lock` protects it.
    Locked,
    /// It has uncommitted or untracked changes.
    Dirty,
    /// Its detached HEAD is on no branch, tag or remote ref.
    DetachedUnreachable,
    /// Git could not answer one of the checks.
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutReclaimCandidate {
    pub instance: GitCheckoutInstanceV1,
    /// The checked-out branch, without `refs/heads/`; `None` when detached.
    pub branch: Option<String>,
    /// `None` when it may be removed.
    pub hold: Option<GitCheckoutReclaimHold>,
    /// Bytes on disk, measured only for a checkout that may be removed.
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutReclaimScan {
    pub repository_path: String,
    pub checkouts: Vec<GitCheckoutReclaimCandidate>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum GitCheckoutReclaimOutcome {
    #[serde(rename_all = "camelCase")]
    Removed {
        freed_bytes: u64,
    },
    /// It changed since it was offered and is kept for this reason.
    Kept {
        hold: GitCheckoutReclaimHold,
    },
    Failed {
        code: String,
        message: String,
    },
}

/// One `git worktree list --porcelain` record.
#[derive(Debug, Default)]
struct ListedWorktree {
    path: PathBuf,
    head: Option<String>,
    branch: Option<String>,
    locked: bool,
    prunable: bool,
    bare: bool,
}

fn listed_worktrees(repository: &Path) -> Result<Vec<ListedWorktree>, GitCheckoutInstanceError> {
    let output = git_output(repository, &["worktree", "list", "--porcelain", "-z"])?;
    let mut worktrees = Vec::new();
    let mut current: Option<ListedWorktree> = None;
    for field in output.split(|byte| *byte == 0) {
        if field.is_empty() {
            worktrees.extend(current.take());
            continue;
        }
        let field = std::str::from_utf8(field).map_err(|_| {
            GitCheckoutInstanceError::new(
                "worktree_non_utf8_identity",
                "git worktree list returned a non-UTF-8 record",
            )
        })?;
        if let Some(path) = field.strip_prefix("worktree ") {
            worktrees.extend(current.replace(ListedWorktree {
                path: PathBuf::from(path),
                ..ListedWorktree::default()
            }));
            continue;
        }
        let Some(worktree) = current.as_mut() else {
            continue;
        };
        let (key, value) = field.split_once(' ').unwrap_or((field, ""));
        match key {
            "HEAD" => worktree.head = Some(value.to_owned()),
            "branch" => worktree.branch = Some(value.to_owned()),
            "locked" => worktree.locked = true,
            "prunable" => worktree.prunable = true,
            "bare" => worktree.bare = true,
            _ => {}
        }
    }
    worktrees.extend(current);
    Ok(worktrees)
}

/// Every linked worktree of `repository` the product created, each with
/// whether it may be removed and why not. Read-only: nothing is claimed,
/// reserved or marked, and a checkout without the product's instance token is
/// never given one.
pub fn scan_reclaimable_checkouts(
    repository: &Path,
) -> Result<GitCheckoutReclaimScan, GitCheckoutInstanceError> {
    let root = observe_repository(repository)?.checkout_root;
    // Git lists the main worktree first; it is never a candidate.
    let listed: Vec<_> = listed_worktrees(&root)?
        .into_iter()
        .skip(1)
        .filter(|worktree| !worktree.prunable && !worktree.bare)
        .collect();
    let next = AtomicUsize::new(0);
    let mut classified: Vec<(usize, GitCheckoutReclaimCandidate)> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..SCAN_WORKERS.min(listed.len()))
            .map(|_| {
                scope.spawn(|| {
                    let mut found = Vec::new();
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(worktree) = listed.get(index) else {
                            break found;
                        };
                        if let Some(candidate) = classify(&root, worktree) {
                            found.push((index, candidate));
                        }
                    }
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap_or_default())
            .collect()
    });
    classified.sort_by_key(|(index, _)| *index);
    Ok(GitCheckoutReclaimScan {
        repository_path: path_string(&root, "repository checkout root")?,
        checkouts: classified
            .into_iter()
            .map(|(_, candidate)| candidate)
            .collect(),
    })
}

/// `None` unless the checkout authority proves it created this exact checkout.
fn classify(repository: &Path, worktree: &ListedWorktree) -> Option<GitCheckoutReclaimCandidate> {
    // Only an existing token: observing must never mark a checkout as ours.
    let instance = reobserve_git_checkout_instance_at(repository, &worktree.path).ok()?;
    let registration = GitCheckoutRegistrationV1 {
        repository_path: path_string(repository, "repository path").ok()?,
        instance,
    };
    let membership = reclaim_membership(&registration).ok()?;
    if membership == ReclaimMembership::NotCreated {
        return None;
    }
    let checkout = PathBuf::from(&registration.instance.canonical_path);
    let hold = first_hold(repository, &checkout, worktree, membership)
        .unwrap_or(Some(GitCheckoutReclaimHold::Unavailable));
    Some(GitCheckoutReclaimCandidate {
        size_bytes: hold.is_none().then(|| disk_usage(&checkout)),
        branch: worktree.branch.as_deref().map(|branch| {
            branch
                .strip_prefix("refs/heads/")
                .unwrap_or(branch)
                .to_owned()
        }),
        hold,
        instance: registration.instance,
    })
}

/// The first reason to keep it, cheapest check first.
fn first_hold(
    repository: &Path,
    checkout: &Path,
    worktree: &ListedWorktree,
    membership: ReclaimMembership,
) -> Result<Option<GitCheckoutReclaimHold>, GitCheckoutInstanceError> {
    if membership == ReclaimMembership::Held {
        return Ok(Some(GitCheckoutReclaimHold::InUse));
    }
    if worktree.locked {
        return Ok(Some(GitCheckoutReclaimHold::Locked));
    }
    if !checkout_is_clean_for_plain_remove(checkout)? {
        return Ok(Some(GitCheckoutReclaimHold::Dirty));
    }
    if worktree.branch.is_none() && !head_is_reachable(repository, worktree.head.as_deref())? {
        return Ok(Some(GitCheckoutReclaimHold::DetachedUnreachable));
    }
    Ok(None)
}

/// Whether a branch, tag or remote ref keeps `head` after its checkout goes.
fn head_is_reachable(
    repository: &Path,
    head: Option<&str>,
) -> Result<bool, GitCheckoutInstanceError> {
    let Some(head) = head.filter(|head| head.bytes().all(|byte| byte.is_ascii_hexdigit())) else {
        return Ok(false);
    };
    let output = capture_git_output(
        repository,
        &[
            "for-each-ref",
            "--count=1",
            "--format=%(refname)",
            "--contains",
            head,
            "refs/heads",
            "refs/tags",
            "refs/remotes",
        ],
        None,
        GIT_TIMEOUT,
    )?;
    if !output.status.success() {
        return Err(GitCheckoutInstanceError::new(
            "worktree_git_failed",
            "git for-each-ref --contains failed",
        ));
    }
    Ok(!output.stdout.is_empty())
}

/// Bytes removal frees, ignored build output included. Symbolic links are
/// counted, never followed. A file with other hard links (a package store's
/// shared copy) stays on disk, so it is left out, and an entry that cannot be
/// read counts as nothing: the total never overstates what removal frees.
fn disk_usage(root: &Path) -> u64 {
    let mut total = 0;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            total += allocated_bytes(&metadata);
            if metadata.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    total
}

#[cfg(unix)]
fn allocated_bytes(metadata: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    if metadata.is_file() && metadata.nlink() > 1 {
        return 0;
    }
    metadata.blocks() * 512
}

#[cfg(not(unix))]
fn allocated_bytes(metadata: &std::fs::Metadata) -> u64 {
    metadata.len()
}

/// Remove one offered checkout if it is still exactly what was offered and
/// still safe: every check runs again, and the authority's removal admission
/// fences claims once more before plain `git worktree remove`.
pub fn reclaim_checkout(
    repository: &Path,
    instance: &GitCheckoutInstanceV1,
) -> GitCheckoutReclaimOutcome {
    reclaim(repository, instance).unwrap_or_else(|error| {
        if error.code == "checkout_use_in_use" {
            return GitCheckoutReclaimOutcome::Kept {
                hold: GitCheckoutReclaimHold::InUse,
            };
        }
        GitCheckoutReclaimOutcome::Failed {
            code: error.code.to_owned(),
            message: error.message,
        }
    })
}

fn reclaim(
    repository: &Path,
    instance: &GitCheckoutInstanceV1,
) -> Result<GitCheckoutReclaimOutcome, GitCheckoutInstanceError> {
    let changed = || {
        GitCheckoutInstanceError::new(
            "worktree_identity_changed",
            "the checkout changed since it was offered",
        )
    };
    let root = observe_repository(repository)?.checkout_root;
    let worktree = listed_worktrees(&root)?
        .into_iter()
        .skip(1)
        .find(|worktree| {
            dunce::canonicalize(&worktree.path)
                .is_ok_and(|path| path == Path::new(&instance.canonical_path))
        })
        .ok_or_else(changed)?;
    let candidate = classify(&root, &worktree).ok_or_else(changed)?;
    if candidate.instance != *instance {
        return Err(changed());
    }
    if let Some(hold) = candidate.hold {
        return Ok(GitCheckoutReclaimOutcome::Kept { hold });
    }
    let request = GitCheckoutRemovalRequestV1 {
        repository_path: path_string(&root, "repository checkout root")?,
        instance: instance.clone(),
        policy: GitCheckoutRemovalPolicyV1::RequireClean,
    };
    let operation_id = OperationIdV1::new(format!("checkout-reclaim-{}", instance.instance_token))
        .map_err(|_| GitCheckoutInstanceError::new("worktree_request_invalid", "invalid token"))?;
    let removal = || GitCheckoutRemovalOperation::new(&request, &operation_id);
    removal()?.admit()?.remove().inspect_err(|_| {
        // Leave it usable: a held permit would refuse the next session there.
        let _ = removal().and_then(GitCheckoutRemovalOperation::abort);
    })?;
    Ok(GitCheckoutReclaimOutcome::Removed {
        freed_bytes: candidate.size_bytes.unwrap_or(0),
    })
}

#[cfg(all(test, unix))]
#[path = "reclaim/tests.rs"]
mod tests;
