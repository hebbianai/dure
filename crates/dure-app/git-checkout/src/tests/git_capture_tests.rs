use super::*;
use std::time::{Duration, Instant};

#[test]
fn git_capture_enforces_deadline_before_alias_finishes() {
    let fixture = fixture();
    // Git itself launches this finite fixture; the test never replaces PATH or
    // waits on a permanently hung old implementation.
    let result = git_output_with_timeout(
        &fixture.repository,
        &[
            "-c",
            "alias.dure-deadline-fixture=!sleep 4; printf finished",
            "dure-deadline-fixture",
        ],
        Duration::from_secs(1),
    );
    assert!(
        result
            .as_ref()
            .is_err_and(|cause| cause.code == "worktree_git_failed"
                && cause.message.contains("process_exit")),
        "Git capture must return its deadline failure: {result:?}"
    );
}

#[test]
fn git_capture_preserves_stderr_on_nonzero_exit() {
    let fixture = fixture();
    let cause = git_output(
        &fixture.repository,
        &[
            "-c",
            "alias.dure-error-fixture=!printf 'fixture diagnostic cafe' >&2; exit 23",
            "dure-error-fixture",
        ],
    )
    .unwrap_err();
    assert_eq!(cause.code, "worktree_git_failed");
    assert!(
        cause.message.contains("fixture diagnostic cafe"),
        "{cause:?}"
    );
}

#[test]
fn git_capture_rejects_overflow_before_the_command_deadline() {
    let fixture = fixture();
    let observations = ["", " >&2"].map(|redirect| {
        // Each finite Git-owned fixture exceeds exactly one stream, then stays
        // alive beyond the execution deadline without writing anything else.
        let alias = format!(
            "alias.dure-overflow-fixture=!head -c {} /dev/zero{redirect}; sleep 6",
            MAX_GIT_OUTPUT_BYTES + 1
        );
        let started = Instant::now();
        let result = git_output_with_timeout(
            &fixture.repository,
            &["-c", &alias, "dure-overflow-fixture"],
            Duration::from_secs(2),
        );
        (redirect, result, started.elapsed())
    });
    for (redirect, result, elapsed) in &observations {
        assert!(
            result
                .as_ref()
                .is_err_and(|cause| cause.code == "worktree_git_output_too_large"),
            "overflow must not become a deadline failure: {observations:?}"
        );
        assert!(
            *elapsed < Duration::from_millis(1500),
            "overflow {redirect:?} waited for the child deadline: {elapsed:?}"
        );
        eprintln!("Git overflow {redirect:?} rejected after {elapsed:?}");
    }
}

#[test]
fn capture_and_removal_preserve_git_failure_families_and_the_checkout() {
    let fixture = fixture();
    let instance = capture(&fixture.repository, &fixture.linked).unwrap();
    let config = fixture.repository.join(".git/config");
    let original_config = std::fs::read_to_string(&config).unwrap();
    std::fs::write(
        &config,
        format!("{original_config}\n[core]\nrepositoryformatversion = invalid\n"),
    )
    .unwrap();

    let capture_failure = capture(&fixture.repository, &fixture.linked).unwrap_err();
    assert_eq!(capture_failure.code, "worktree_git_failed");
    assert!(
        capture_failure
            .message
            .contains("core.repositoryformatversion")
    );
    let physical_failure =
        remove_git_checkout_instance_at(&fixture.repository, &instance).unwrap_err();
    assert_eq!(physical_failure.code, "worktree_git_failed");
    let admitted_failure = remove(&fixture.repository, &instance).unwrap_err();
    assert_eq!(admitted_failure.code, "checkout_use_git_failed");
    assert_eq!(
        admitted_failure.removal_failure_disposition(),
        GitCheckoutRemovalFailureDisposition::Retryable
    );
    assert!(fixture.linked.join(".git").is_file());
    assert_eq!(
        std::fs::read(fixture.linked.join("tracked.txt")).unwrap(),
        b"base\n"
    );

    std::fs::write(&config, original_config).unwrap();
    assert_eq!(
        capture(&fixture.repository, &fixture.linked).unwrap(),
        instance
    );
    assert_eq!(
        remove(&fixture.repository, &instance).unwrap().outcome,
        GitCheckoutRemovalOutcomeV1::Removed
    );
}
