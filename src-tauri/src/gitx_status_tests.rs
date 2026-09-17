use super::{run_git, status};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

fn fixture(linked: bool) -> (tempfile::TempDir, PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let repository = temporary.path().join("repository");
    std::fs::create_dir(&repository).unwrap();
    let path = repository.to_str().unwrap();
    run_git(path, &["init", "-q", "-b", "main"]).unwrap();
    run_git(path, &["config", "user.name", "Status fixture"]).unwrap();
    run_git(path, &["config", "user.email", "status@example.invalid"]).unwrap();
    run_git(path, &["config", "commit.gpgSign", "false"]).unwrap();
    run_git(
        path,
        &[
            "config",
            "core.hooksPath",
            temporary.path().join("no-hooks").to_str().unwrap(),
        ],
    )
    .unwrap();
    for name in ["clean.txt", "dirty.txt", "staged.txt"] {
        std::fs::write(repository.join(name), "before\n").unwrap();
    }
    run_git(path, &["add", "."]).unwrap();
    run_git(path, &["commit", "-qm", "fixture"]).unwrap();
    let observed = if linked {
        let worktree = temporary.path().join("linked");
        run_git(
            path,
            &[
                "worktree",
                "add",
                "-qb",
                "agent/fixture",
                worktree.to_str().unwrap(),
            ],
        )
        .unwrap();
        worktree
    } else {
        repository
    };
    (temporary, observed)
}

fn assert_read_preserves_index(worktree: &Path) {
    let path = worktree.to_str().unwrap();
    let index = PathBuf::from(
        run_git(
            path,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )
        .unwrap()
        .trim(),
    );
    std::fs::OpenOptions::new()
        .write(true)
        .open(worktree.join("clean.txt"))
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(60))
        .unwrap();
    let before = std::fs::read(&index).unwrap();
    let modified = std::fs::metadata(&index).unwrap().modified().unwrap();
    for _ in 0..3 {
        let observed = status(path);
        assert!(observed.is_repo);
        assert_eq!(
            (observed.staged, observed.unstaged, observed.untracked),
            (0, 0, 0)
        );
        assert_eq!(
            std::fs::read(&index).unwrap(),
            before,
            "a status observation rewrote the repository index"
        );
        assert_eq!(
            std::fs::metadata(&index).unwrap().modified().unwrap(),
            modified
        );
    }
}

#[test]
fn status_observation_preserves_repository_index() {
    let (_temporary, worktree) = fixture(false);
    assert_read_preserves_index(&worktree);
}

#[test]
fn status_observation_preserves_linked_worktree_index() {
    let (_temporary, worktree) = fixture(true);
    assert_read_preserves_index(&worktree);
}

#[test]
fn status_observation_keeps_dirty_and_staged_changes_visible() {
    let (_temporary, worktree) = fixture(true);
    let path = worktree.to_str().unwrap();
    std::fs::write(worktree.join("dirty.txt"), "after\n").unwrap();
    std::fs::write(worktree.join("staged.txt"), "after\n").unwrap();
    run_git(path, &["add", "staged.txt"]).unwrap();
    std::fs::write(worktree.join("new.txt"), "new\n").unwrap();
    let observed = status(path);
    assert!(observed.is_repo);
    assert_eq!(observed.branch, "agent/fixture");
    assert_eq!(
        (observed.staged, observed.unstaged, observed.untracked),
        (1, 1, 1)
    );
    assert!(!status(worktree.join("missing").to_str().unwrap()).is_repo);
}
