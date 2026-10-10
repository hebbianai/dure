use super::*;
use crate::tests::git;

fn repository() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-q"]);
    git(root.path(), &["config", "user.name", "Fixture"]);
    git(
        root.path(),
        &["config", "user.email", "fixture@example.test"],
    );
    git(root.path(), &["config", "commit.gpgsign", "false"]);
    git(
        root.path(),
        &[
            "config",
            "core.hooksPath",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        ],
    );
    git(root.path(), &["commit", "--allow-empty", "-m", "fixture"]);
    root
}

#[test]
fn generated_worktree_is_not_staged_by_git_add_all() {
    let root = repository();
    let directory = root.path().join(".worktrees");
    std::fs::create_dir(&directory).unwrap();
    let worktree = directory.join("automation-fixture");
    git(
        root.path(),
        &[
            "worktree",
            "add",
            "-b",
            "automation-fixture",
            worktree.to_str().unwrap(),
        ],
    );
    // Reproduce the report before applying the shared exclusion.
    git(root.path(), &["add", "-A"]);
    assert!(git(root.path(), &["ls-files", "--stage"]).contains("160000"));
    git(root.path(), &["reset", "--quiet"]);
    std::fs::write(root.path().join("user.txt"), "keep me").unwrap();
    exclude_worktree_directory(root.path(), &directory).unwrap();
    git(root.path(), &["add", "-A"]);
    assert_eq!(
        git(root.path(), &["diff", "--cached", "--name-only"]),
        "user.txt"
    );
    assert!(git(root.path(), &["ls-files", "--stage"]).contains("100644"));
}

#[test]
fn appends_once_preserves_user_rules_and_escapes_git_patterns() {
    let root = repository();
    let exclude = root.path().join(".git/info/exclude");
    std::fs::write(&exclude, b"# user rule\nprivate").unwrap();
    let directory = root.path().join("work [x]* ");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("child"), "private").unwrap();
    exclude_worktree_directory(root.path(), &directory).unwrap();
    let first = std::fs::read(&exclude).unwrap();
    exclude_worktree_directory(root.path(), &directory).unwrap();
    assert_eq!(std::fs::read(&exclude).unwrap(), first);
    assert!(first.starts_with(b"# user rule\nprivate\n"));
    git(root.path(), &["check-ignore", "--", "work [x]* /child"]);
    assert!(!root.path().join(".gitignore").exists());
}

#[test]
fn linked_checkout_uses_git_resolved_common_exclude() {
    let root = repository();
    let outside = tempfile::tempdir().unwrap();
    let linked = outside.path().join("linked");
    git(
        root.path(),
        &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
    );
    let directory = linked.join(".worktrees");
    std::fs::create_dir(&directory).unwrap();
    exclude_worktree_directory(&linked, &directory).unwrap();
    assert!(
        std::fs::read_to_string(root.path().join(".git/info/exclude"))
            .unwrap()
            .contains("/.worktrees/")
    );
    std::fs::write(directory.join("child"), "private").unwrap();
    git(&linked, &["check-ignore", "--", ".worktrees/child"]);
}

#[test]
fn outside_worktree_does_not_change_local_excludes() {
    let root = repository();
    let outside = tempfile::tempdir().unwrap();
    let exclude = root.path().join(".git/info/exclude");
    let before = std::fs::read(&exclude).unwrap();
    exclude_worktree_directory(root.path(), &outside.path().join("new-worktree")).unwrap();
    assert_eq!(std::fs::read(exclude).unwrap(), before);
}

#[test]
fn does_not_unstage_previously_tracked_paths() {
    let root = repository();
    let directory = root.path().join(".worktrees");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("user.txt"), "keep").unwrap();
    git(root.path(), &["add", "-A"]);
    let before = git(root.path(), &["ls-files", "--stage"]);
    exclude_worktree_directory(root.path(), &directory).unwrap();
    assert_eq!(git(root.path(), &["ls-files", "--stage"]), before);
}
