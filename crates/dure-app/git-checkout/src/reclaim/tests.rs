use super::*;
use crate::tests::git;
use crate::{
    capture_git_checkout_registration, claim_git_checkout_registration,
    prepare_git_checkout_creation, release_git_checkout_registration,
};
use std::fs;
use std::process::Command;
use tempfile::TempDir;

struct Repository {
    _temporary: TempDir,
    root: PathBuf,
}

fn operation(value: &str) -> OperationIdV1 {
    OperationIdV1::new(value).unwrap()
}

impl Repository {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap().join("repository");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Reclaim Test"]);
        git(&root, &["config", "user.email", "reclaim@example.invalid"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        fs::write(root.join("tracked.txt"), "base\n").unwrap();
        git(&root, &["add", "tracked.txt"]);
        git(&root, &["commit", "-m", "base"]);
        fs::create_dir(root.join(".worktrees")).unwrap();
        Self {
            _temporary: temporary,
            root,
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.join(".worktrees").join(name)
    }

    /// A checkout the authority created whose Run still holds its claim.
    fn running_checkout(&self, name: &str) -> PathBuf {
        let target = self.path(name);
        let creation = prepare_git_checkout_creation(
            &self.root,
            &target,
            &operation(&format!("spawn-{name}")),
            &["HEAD"],
        )
        .unwrap()
        .expect("a fresh path admits creation")
        .admit()
        .unwrap();
        git(
            &self.root,
            &[
                "worktree",
                "add",
                "-b",
                name,
                target.to_str().unwrap(),
                "HEAD",
            ],
        );
        creation.activate().unwrap();
        target
    }

    /// A checkout the authority created whose Run released it on finishing.
    fn finished_checkout(&self, name: &str) -> PathBuf {
        let target = self.running_checkout(name);
        release_git_checkout_registration(
            &capture_git_checkout_registration(&target).unwrap().unwrap(),
            &operation(&format!("spawn-{name}")),
            &operation(&format!("release-{name}")),
        )
        .unwrap();
        target
    }

    fn scan(&self) -> Vec<(String, Option<GitCheckoutReclaimHold>)> {
        scan_reclaimable_checkouts(&self.root)
            .unwrap()
            .checkouts
            .into_iter()
            .map(|checkout| {
                let name = Path::new(&checkout.instance.canonical_path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                (name, checkout.hold)
            })
            .collect()
    }

    fn offered(&self, name: &str) -> GitCheckoutReclaimCandidate {
        scan_reclaimable_checkouts(&self.root)
            .unwrap()
            .checkouts
            .into_iter()
            .find(|checkout| checkout.instance.canonical_path.ends_with(name))
            .expect("the checkout is listed")
    }

    fn has_branch(&self, name: &str) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{name}"),
            ])
            .output()
            .unwrap()
            .status
            .success()
    }
}

#[test]
fn only_finished_clean_checkouts_the_product_created_are_offered() {
    let repository = Repository::new();
    repository.finished_checkout("clean");
    let dirty = repository.finished_checkout("dirty");
    fs::write(dirty.join("notes.txt"), "unsaved\n").unwrap();
    let locked = repository.finished_checkout("locked");
    git(
        &repository.root,
        &["worktree", "lock", locked.to_str().unwrap()],
    );
    repository.running_checkout("running");
    let detached = repository.finished_checkout("detached");
    git(&detached, &["switch", "--detach"]);
    let orphaned = repository.finished_checkout("orphaned");
    git(&orphaned, &["switch", "--detach"]);
    fs::write(orphaned.join("tracked.txt"), "only here\n").unwrap();
    git(&orphaned, &["commit", "-am", "only here"]);
    // Made outside the product, and one the product only ever adopted.
    let foreign = repository.path("foreign");
    git(
        &repository.root,
        &[
            "worktree",
            "add",
            "-b",
            "foreign",
            foreign.to_str().unwrap(),
        ],
    );
    let adopted = repository.path("adopted");
    git(
        &repository.root,
        &[
            "worktree",
            "add",
            "-b",
            "adopted",
            adopted.to_str().unwrap(),
        ],
    );
    let adoption = operation("adopted-session");
    let registration = claim_git_checkout_registration(&adopted, &adoption, None)
        .unwrap()
        .unwrap();
    release_git_checkout_registration(&registration, &adoption, &operation("adopted-release"))
        .unwrap();

    let mut scanned = repository.scan();
    scanned.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(
        scanned,
        vec![
            ("clean".into(), None),
            ("detached".into(), None),
            ("dirty".into(), Some(GitCheckoutReclaimHold::Dirty)),
            ("locked".into(), Some(GitCheckoutReclaimHold::Locked)),
            (
                "orphaned".into(),
                Some(GitCheckoutReclaimHold::DetachedUnreachable)
            ),
            ("running".into(), Some(GitCheckoutReclaimHold::InUse)),
        ]
    );
    let clean = repository.offered("clean");
    assert_eq!(clean.branch.as_deref(), Some("clean"));
    assert!(clean.size_bytes.is_some_and(|bytes| bytes > 0));
    assert_eq!(repository.offered("dirty").size_bytes, None);
    assert_eq!(repository.offered("detached").branch, None);
    // Looking never marks a foreign checkout as the product's.
    let common = PathBuf::from(git(&repository.root, &["rev-parse", "--git-common-dir"]));
    let common = if common.is_absolute() {
        common
    } else {
        repository.root.join(common)
    };
    assert!(
        !common
            .join("worktrees/foreign")
            .join(crate::INSTANCE_TOKEN_FILE)
            .exists()
    );
}

#[test]
fn reclaiming_removes_only_what_is_still_safe_and_keeps_branches() {
    let repository = Repository::new();
    let clean = repository.finished_checkout("clean");
    let edited = repository.finished_checkout("edited");
    let resumed = repository.finished_checkout("resumed");
    let offered_clean = repository.offered("clean");
    let offered_edited = repository.offered("edited");
    let offered_resumed = repository.offered("resumed");
    assert!(offered_edited.hold.is_none() && offered_resumed.hold.is_none());

    let outcome = reclaim_checkout(&repository.root, &offered_clean.instance);
    assert_eq!(
        outcome,
        GitCheckoutReclaimOutcome::Removed {
            freed_bytes: offered_clean.size_bytes.unwrap()
        }
    );
    assert!(!clean.exists());
    assert!(repository.has_branch("clean"), "the branch is kept");

    // Changed after it was offered: every check runs again.
    fs::write(edited.join("tracked.txt"), "edited\n").unwrap();
    assert_eq!(
        reclaim_checkout(&repository.root, &offered_edited.instance),
        GitCheckoutReclaimOutcome::Kept {
            hold: GitCheckoutReclaimHold::Dirty
        }
    );
    assert!(edited.exists());

    let session = operation("resumed-session");
    claim_git_checkout_registration(&resumed, &session, None)
        .unwrap()
        .unwrap();
    assert_eq!(
        reclaim_checkout(&repository.root, &offered_resumed.instance),
        GitCheckoutReclaimOutcome::Kept {
            hold: GitCheckoutReclaimHold::InUse
        }
    );
    assert!(resumed.exists());

    // Gone already: nothing is removed twice.
    assert!(matches!(
        reclaim_checkout(&repository.root, &offered_clean.instance),
        GitCheckoutReclaimOutcome::Failed { code, .. } if code == "worktree_identity_changed"
    ));
}

/// The desktop parses exactly these shapes (src/lib/scm/worktrees/worktreeReclaim.ts).
#[test]
fn outcomes_and_holds_keep_their_wire_names() {
    let json = |value: &GitCheckoutReclaimOutcome| serde_json::to_value(value).unwrap();
    assert_eq!(
        json(&GitCheckoutReclaimOutcome::Removed { freed_bytes: 7 }),
        serde_json::json!({ "outcome": "removed", "freedBytes": 7 })
    );
    assert_eq!(
        json(&GitCheckoutReclaimOutcome::Kept {
            hold: GitCheckoutReclaimHold::DetachedUnreachable
        }),
        serde_json::json!({ "outcome": "kept", "hold": "detached_unreachable" })
    );
    assert_eq!(
        json(&GitCheckoutReclaimOutcome::Failed {
            code: "worktree_git_failed".into(),
            message: "git failed".into()
        }),
        serde_json::json!({
            "outcome": "failed",
            "code": "worktree_git_failed",
            "message": "git failed"
        })
    );
    let repository = Repository::new();
    repository.finished_checkout("wire");
    let scan = serde_json::to_value(scan_reclaimable_checkouts(&repository.root).unwrap()).unwrap();
    let checkout = &scan["checkouts"][0];
    assert!(scan["repositoryPath"].is_string());
    assert_eq!(checkout["branch"], "wire");
    assert_eq!(checkout["hold"], serde_json::Value::Null);
    assert!(checkout["sizeBytes"].is_u64());
    assert!(checkout["instance"]["instanceToken"].is_string());
}
