use super::*;
#[cfg(unix)]
use std::time::{Duration, Instant};

#[test]
fn clean_preflight_distinguishes_clean_tracked_and_untracked_changes() {
    let fixture = fixture();
    assert!(checkout_is_clean_for_plain_remove(&fixture.linked).unwrap());
    let untracked = fixture.linked.join("untracked.txt");
    std::fs::write(&untracked, "keep this file\n").unwrap();
    assert!(!checkout_is_clean_for_plain_remove(&fixture.linked).unwrap());
    std::fs::remove_file(untracked).unwrap();
    std::fs::write(fixture.linked.join("tracked.txt"), "changed\n").unwrap();
    assert!(!checkout_is_clean_for_plain_remove(&fixture.linked).unwrap());
}

#[test]
fn clean_preflight_rejects_a_non_repository_without_removing_files() {
    let temporary = tempfile::tempdir().unwrap();
    let file = temporary.path().join("keep.txt");
    std::fs::write(&file, "keep\n").unwrap();
    let failure = checkout_is_clean_for_plain_remove(temporary.path()).unwrap_err();
    assert_eq!(failure.code, "worktree_git_failed");
    assert_eq!(std::fs::read_to_string(file).unwrap(), "keep\n");
}

#[cfg(unix)]
#[test]
fn clean_preflight_deadline_stops_git_and_its_fsmonitor_child() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = fixture();
    let hook = fixture._temporary.path().join("stall-fsmonitor.sh");
    // The fixture eventually exits even under the old blocking implementation.
    // All recorded PIDs belong to this Git invocation in a disposable repository.
    std::fs::write(
        &hook,
        "#!/bin/sh\nsleep 6 &\nchild=$!\nprintf '%s\\n' \"$PPID\" \"$$\" \"$child\" > ../status-pids\nwait \"$child\"\nprintf 'fixture-token\\0/\\0'\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    git(
        &fixture.repository,
        &["config", "core.fsmonitor", hook.to_str().unwrap()],
    );
    git(
        &fixture.repository,
        &["config", "core.fsmonitorHookVersion", "2"],
    );

    let result = checkout_is_clean_with_timeout(&fixture.linked, Duration::from_secs(2));
    let pids = std::fs::read_to_string(fixture._temporary.path().join("status-pids"))
        .expect("the real Git fsmonitor hook must have started");
    assert!(
        result
            .as_ref()
            .is_err_and(|cause| cause.code == "worktree_git_failed"
                && cause.message.contains("process_exit")),
        "the status preflight must return its deadline failure, not wait for the hook: {result:?}"
    );
    for pid in pids.lines().map(|pid| pid.parse::<i32>().unwrap()) {
        // Observe only the fixture's recorded processes; the bounded runner owns cleanup.
        // Unix reaping may follow the kill asynchronously. This observation window
        // ends well before the fixture's natural six-second sleep could finish.
        let deadline = Instant::now() + Duration::from_secs(1);
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(
                Instant::now() < deadline,
                "fixture process {pid} survived cleanup"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        eprintln!("status preflight fixture process {pid} is absent after deadline cleanup");
    }
    assert_eq!(
        std::fs::read_to_string(fixture.linked.join("tracked.txt")).unwrap(),
        "base\n"
    );
}
