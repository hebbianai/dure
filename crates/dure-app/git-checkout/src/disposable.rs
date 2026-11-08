//! Whether removing a finished automated checkout could lose anything.

use std::path::Path;

use super::GitCheckoutInstanceError;
use super::git_process::{GIT_TIMEOUT, capture_git_output, checkout_is_clean_for_plain_remove};

const ORIGIN_REFS: &str = "refs/remotes/origin/";

/// True only when removing this linked checkout cannot lose work: it is still
/// on `branch`, has no uncommitted or untracked changes, and every commit on it
/// is already on the repository's default branch. Anything that cannot be
/// established, including which branch is the default, means it is kept.
pub fn git_checkout_is_disposable(
    checkout: &Path,
    branch: &str,
) -> Result<bool, GitCheckoutInstanceError> {
    // Another branch or a detached HEAD means someone moved this checkout on.
    let expected = format!("refs/heads/{branch}");
    if query(checkout, &["symbolic-ref", "--quiet", "HEAD"])?.as_deref() != Some(expected.as_str())
    {
        return Ok(false);
    }
    for tip in default_branch_tips(checkout)? {
        let merged = query(checkout, &["merge-base", "--is-ancestor", "HEAD", &tip])?;
        if merged.is_some() {
            return checkout_is_clean_for_plain_remove(checkout);
        }
    }
    Ok(false)
}

/// The refs that hold the default branch: its remote and local copies when
/// `origin` records one, otherwise a single conventional local branch.
fn default_branch_tips(checkout: &Path) -> Result<Vec<String>, GitCheckoutInstanceError> {
    let origin_head = query(
        checkout,
        &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    )?;
    if let Some(origin_head) = origin_head {
        let Some(name) = origin_head.strip_prefix(ORIGIN_REFS) else {
            return Ok(Vec::new());
        };
        return existing_refs(
            checkout,
            &[format!("{ORIGIN_REFS}{name}"), format!("refs/heads/{name}")],
        );
    }
    let conventional = existing_refs(
        checkout,
        &["refs/heads/main".into(), "refs/heads/master".into()],
    )?;
    Ok(if conventional.len() == 1 {
        conventional
    } else {
        Vec::new()
    })
}

fn existing_refs(
    checkout: &Path,
    references: &[String],
) -> Result<Vec<String>, GitCheckoutInstanceError> {
    let mut existing = Vec::with_capacity(references.len());
    for reference in references {
        let commit = format!("{reference}^{{commit}}");
        if query(checkout, &["rev-parse", "--verify", "--quiet", &commit])?.is_some() {
            existing.push(reference.clone());
        }
    }
    Ok(existing)
}

/// Exit status 1 is Git's answer "no"; any other failure must not read as one.
fn query(checkout: &Path, args: &[&str]) -> Result<Option<String>, GitCheckoutInstanceError> {
    let output = capture_git_output(checkout, args, None, GIT_TIMEOUT)?;
    match output.status.code() {
        Some(0) => Ok(Some(
            String::from_utf8_lossy(&output.stdout)
                .trim_end_matches(['\r', '\n'])
                .to_owned(),
        )),
        Some(1) => Ok(None),
        _ => Err(GitCheckoutInstanceError::new(
            "worktree_git_failed",
            format!("git {} failed", args.join(" ")),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::git;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const BRANCH: &str = "automation-fixture";

    struct Repository {
        _temporary: TempDir,
        root: PathBuf,
        checkout: PathBuf,
    }

    impl Repository {
        fn new(default_branch: &str) -> Self {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().join("repository");
            std::fs::create_dir(&root).unwrap();
            git(&root, &["init", "-b", default_branch]);
            git(&root, &["config", "user.name", "Disposable Test"]);
            git(
                &root,
                &["config", "user.email", "disposable@example.invalid"],
            );
            git(&root, &["config", "commit.gpgsign", "false"]);
            std::fs::write(root.join("tracked.txt"), "base\n").unwrap();
            git(&root, &["add", "tracked.txt"]);
            git(&root, &["commit", "-m", "base"]);
            let checkout = temporary.path().join("linked");
            git(
                &root,
                &[
                    "worktree",
                    "add",
                    "-b",
                    BRANCH,
                    checkout.to_str().unwrap(),
                    "HEAD",
                ],
            );
            Self {
                _temporary: temporary,
                root,
                checkout,
            }
        }

        fn disposable(&self) -> bool {
            git_checkout_is_disposable(&self.checkout, BRANCH).unwrap()
        }

        fn commit_in_checkout(&self) -> String {
            std::fs::write(self.checkout.join("work.txt"), "work\n").unwrap();
            git(&self.checkout, &["add", "work.txt"]);
            git(&self.checkout, &["commit", "-m", "work"]);
            git(&self.checkout, &["rev-parse", "HEAD"])
        }
    }

    #[test]
    fn an_untouched_checkout_is_disposable() {
        assert!(Repository::new("main").disposable());
    }

    #[test]
    fn uncommitted_or_untracked_changes_keep_the_checkout() {
        let repository = Repository::new("main");
        std::fs::write(repository.checkout.join("new.txt"), "new\n").unwrap();
        assert!(!repository.disposable(), "an untracked file");
        std::fs::remove_file(repository.checkout.join("new.txt")).unwrap();
        std::fs::write(repository.checkout.join("tracked.txt"), "edit\n").unwrap();
        assert!(!repository.disposable(), "a modified tracked file");
    }

    #[test]
    fn a_commit_keeps_the_checkout_until_the_default_branch_has_it() {
        let repository = Repository::new("main");
        repository.commit_in_checkout();
        assert!(!repository.disposable(), "the commit is only on its branch");
        git(&repository.root, &["merge", "--ff-only", BRANCH]);
        assert!(repository.disposable(), "the default branch now has it");
    }

    #[test]
    fn leaving_the_branch_keeps_the_checkout() {
        let repository = Repository::new("main");
        git(&repository.checkout, &["switch", "-c", "someone-else"]);
        assert!(!repository.disposable(), "another branch");
        git(&repository.checkout, &["switch", "--detach"]);
        assert!(!repository.disposable(), "a detached HEAD");
    }

    #[test]
    fn an_unknown_default_branch_keeps_the_checkout() {
        assert!(
            !Repository::new("trunk").disposable(),
            "no recorded or conventional default"
        );
        let ambiguous = Repository::new("main");
        git(&ambiguous.root, &["branch", "master"]);
        assert!(!ambiguous.disposable(), "main and master both exist");
    }

    #[test]
    fn the_default_branch_recorded_by_origin_is_authoritative() {
        let repository = Repository::new("trunk");
        let commit = repository.commit_in_checkout();
        git(
            &repository.root,
            &["update-ref", "refs/remotes/origin/trunk", "HEAD"],
        );
        git(
            &repository.root,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/trunk",
            ],
        );
        assert!(
            !repository.disposable(),
            "origin's default lacks the commit"
        );
        git(
            &repository.root,
            &["update-ref", "refs/remotes/origin/trunk", &commit],
        );
        assert!(repository.disposable(), "origin's default has the commit");
    }
}
