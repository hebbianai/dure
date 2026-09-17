use super::*;
use std::time::{Duration, Instant};

fn process_is_live(pid: i32) -> bool {
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH),
        "process observation must distinguish absence from an observation error"
    );
    false
}

async fn wait_for_exit(pid: i32, duration: Duration) -> bool {
    let deadline = Instant::now() + duration;
    while process_is_live(pid) {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    true
}

#[tokio::test]
async fn cancelling_git_execution_retires_its_owned_descendant() {
    let root = repository().await;
    let pid_file = root.path().join("cancel-descendant-pid");
    let repository_path = root.path().to_path_buf();
    let output_path = pid_file.clone();
    let execution = tokio::spawn(async move {
        // The finite fixture records its child before waiting. Even the old
        // leader-only cancellation implementation cannot leave an endless child.
        git_output(
            &repository_path,
            [
                "-c",
                "alias.dure-cancel-fixture=!f() { sleep 6 & child=$!; printf '%s' \"$child\" > \"$1\"; wait; }; f",
                "dure-cancel-fixture",
                output_path.to_str().unwrap(),
            ],
            None,
        )
        .await
    });
    let pid = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|contents| contents.parse::<i32>().ok())
                .filter(|pid| *pid > 0)
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Git must publish its live descendant before cancellation");
    assert!(process_is_live(pid));
    let cancelled_at = Instant::now();
    execution.abort();
    assert!(execution.await.is_err_and(|failure| failure.is_cancelled()));
    let retired_by_cancellation = wait_for_exit(pid, Duration::from_secs(1)).await;
    let observed_after = cancelled_at.elapsed();

    // Preserve the failing observation, then allow the finite old fixture to
    // retire naturally. This never signals a PID or touches a user checkout.
    assert!(wait_for_exit(pid, Duration::from_secs(7)).await);
    assert!(
        retired_by_cancellation,
        "Git descendant {pid} remained live {observed_after:?} after its owning future was cancelled"
    );
}
