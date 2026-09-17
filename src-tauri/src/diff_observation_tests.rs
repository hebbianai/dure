use super::{agent_diff_stat, run_git};
use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

thread_local! {
    static INDEX_COPIES: Cell<(u64, u64)> = const { Cell::new((0, 0)) };
}

pub(super) fn record_index_copy(bytes: u64) {
    INDEX_COPIES.with(|counter| {
        let (copies, total) = counter.get();
        counter.set((copies + 1, total + bytes));
    });
}

fn fixture(linked: bool) -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let repository = root.path().join("repository");
    std::fs::create_dir(&repository).unwrap();
    let path = repository.to_str().unwrap();
    run_git(path, &["init", "-qb", "main"]).unwrap();
    run_git(path, &["config", "user.name", "Diff observation fixture"]).unwrap();
    run_git(path, &["config", "user.email", "diff@example.invalid"]).unwrap();
    run_git(path, &["config", "commit.gpgSign", "false"]).unwrap();
    run_git(
        path,
        &[
            "config",
            "core.hooksPath",
            root.path().join("no-hooks").to_str().unwrap(),
        ],
    )
    .unwrap();
    for name in ["clean.txt", "dirty.txt", "staged.txt", "rename.txt"] {
        std::fs::write(repository.join(name), "one\ntwo\n").unwrap();
    }
    run_git(path, &["add", "."]).unwrap();
    run_git(path, &["commit", "-qm", "base"]).unwrap();
    let worktree = if linked {
        let worktree = root.path().join("linked");
        run_git(
            path,
            &[
                "worktree",
                "add",
                "-qb",
                "feature",
                worktree.to_str().unwrap(),
            ],
        )
        .unwrap();
        worktree
    } else {
        run_git(path, &["checkout", "-qb", "feature"]).unwrap();
        repository
    };
    (root, worktree)
}

fn index_path(worktree: &Path) -> PathBuf {
    PathBuf::from(
        run_git(
            worktree.to_str().unwrap(),
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )
        .unwrap()
        .trim(),
    )
}

fn repeated_tracked_observation(linked: bool) {
    let (_root, worktree) = fixture(linked);
    let path = worktree.to_str().unwrap();
    std::fs::write(worktree.join("dirty.txt"), "one\ntwo\ncommitted\n").unwrap();
    run_git(path, &["commit", "-qam", "feature change"]).unwrap();
    std::fs::write(worktree.join("dirty.txt"), "one\ntwo\ncommitted\nworking\n").unwrap();
    std::fs::write(worktree.join("staged.txt"), "one\ntwo\nstaged\n").unwrap();
    run_git(path, &["add", "staged.txt"]).unwrap();
    run_git(path, &["mv", "rename.txt", "renamed.txt"]).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(worktree.join("clean.txt"))
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(60))
        .unwrap();
    let index = index_path(&worktree);
    let bytes = std::fs::read(&index).unwrap();
    let modified = std::fs::metadata(&index).unwrap().modified().unwrap();
    INDEX_COPIES.with(|counter| counter.set((0, 0)));
    let started = Instant::now();
    for _ in 0..20 {
        let stat = agent_diff_stat(path, Some("main")).unwrap();
        assert_eq!((stat.ahead, stat.behind), (1, 0));
        assert_eq!(stat.committed_files.len(), 1);
        assert_eq!(stat.committed_files[0].added, Some(1));
        assert_eq!(
            stat.worktree_files.len(),
            3,
            "stat-only changes must not become diff rows"
        );
        let dirty = stat
            .worktree_files
            .iter()
            .find(|file| file.path == "dirty.txt")
            .unwrap();
        assert_eq!(dirty.added, Some(1));
        assert!(stat
            .worktree_files
            .iter()
            .any(|file| file.path == "staged.txt"));
        assert!(stat.worktree_files.iter().any(
            |file| file.path == "renamed.txt" && file.old_path.as_deref() == Some("rename.txt")
        ));
    }
    let copies = INDEX_COPIES.with(Cell::get);
    eprintln!(
        "20 tracked observations linked={linked}: copies={}, copied_bytes={}, elapsed_ms={}",
        copies.0,
        copies.1,
        started.elapsed().as_millis()
    );
    assert_eq!(std::fs::read(&index).unwrap(), bytes);
    assert_eq!(
        std::fs::metadata(&index).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(
        copies,
        (0, 0),
        "tracked-only observations must not materialize temporary indexes"
    );
}

#[test]
fn tracked_observations_do_not_copy_repository_index() {
    repeated_tracked_observation(false);
}

#[test]
fn tracked_observations_do_not_copy_linked_worktree_index() {
    repeated_tracked_observation(true);
}

#[test]
fn empty_directories_do_not_require_an_index_but_nested_new_files_do() {
    let (_root, worktree) = fixture(false);
    let path = worktree.to_str().unwrap();
    std::fs::create_dir_all(worktree.join("new/deep")).unwrap();
    INDEX_COPIES.with(|counter| counter.set((0, 0)));
    assert!(agent_diff_stat(path, Some("main"))
        .unwrap()
        .files
        .is_empty());
    assert_eq!(INDEX_COPIES.with(Cell::get).0, 0);
    std::fs::write(worktree.join("new/deep/file.txt"), "nested\n").unwrap();
    let next = agent_diff_stat(path, Some("main")).unwrap();
    assert_eq!(INDEX_COPIES.with(Cell::get).0, 1);
    assert_eq!(next.worktree_files.len(), 1);
    assert_eq!(next.worktree_files[0].path, "new/deep/file.txt");
    assert_eq!(next.worktree_files[0].added, Some(1));
}

#[test]
fn untracked_binary_intent_to_add_and_ignored_files_keep_their_meaning() {
    let (_root, worktree) = fixture(true);
    let path = worktree.to_str().unwrap();
    std::fs::write(worktree.join(".gitignore"), "generated/\n").unwrap();
    run_git(path, &["add", ".gitignore"]).unwrap();
    std::fs::create_dir(worktree.join("generated")).unwrap();
    std::fs::write(worktree.join("generated/artifact"), "ignored\n").unwrap();
    std::fs::write(worktree.join("한글 new.txt"), "new\n").unwrap();
    std::fs::write(worktree.join("binary.dat"), b"\0binary\0").unwrap();
    let index = index_path(&worktree);
    let before = std::fs::read(&index).unwrap();
    INDEX_COPIES.with(|counter| counter.set((0, 0)));
    let stat = agent_diff_stat(path, Some("main")).unwrap();
    assert_eq!(INDEX_COPIES.with(Cell::get).0, 1);
    assert!(stat
        .worktree_files
        .iter()
        .any(|file| file.path == "한글 new.txt" && file.added == Some(1)));
    assert!(stat
        .worktree_files
        .iter()
        .any(|file| file.path == "binary.dat" && file.added.is_none()));
    assert!(!stat
        .files
        .iter()
        .any(|file| file.path.starts_with("generated/")));
    assert_eq!(std::fs::read(&index).unwrap(), before);

    // A user can stage intent-to-add between observations. The next read sees
    // it through the real index without requiring another private index.
    run_git(
        path,
        &["add", "--intent-to-add", "--", "한글 new.txt", "binary.dat"],
    )
    .unwrap();
    let staged = std::fs::read(&index).unwrap();
    INDEX_COPIES.with(|counter| counter.set((0, 0)));
    let next = agent_diff_stat(path, Some("main")).unwrap();
    assert_eq!(INDEX_COPIES.with(Cell::get).0, 0);
    assert_eq!(next.worktree_files, stat.worktree_files);
    assert_eq!(std::fs::read(&index).unwrap(), staged);
}

#[test]
fn reviews_keep_a_private_index_and_cleanup_does_not_remove_user_staging() {
    let (_root, worktree) = fixture(false);
    let path = worktree.to_str().unwrap();
    let snapshot = super::index::DiffIndex::create(path).unwrap();
    let temporary = match &snapshot {
        super::index::DiffIndex::Snapshot(path) => path.to_path_buf(),
        super::index::DiffIndex::Worktree => panic!("review lost its private index"),
    };
    std::fs::write(worktree.join("later.txt"), "later\n").unwrap();
    // Interleave an explicit user write while the review still owns its copy.
    run_git(path, &["add", "later.txt"]).unwrap();
    let index = index_path(&worktree);
    let staged = std::fs::read(&index).unwrap();
    assert!(!snapshot
        .git(path, &["ls-files"])
        .unwrap()
        .contains("later.txt"));
    drop(snapshot);
    assert!(!temporary.exists());
    assert_eq!(std::fs::read(&index).unwrap(), staged);
    assert!(agent_diff_stat(path, Some("main"))
        .unwrap()
        .files
        .iter()
        .any(|file| file.path == "later.txt"));
}
