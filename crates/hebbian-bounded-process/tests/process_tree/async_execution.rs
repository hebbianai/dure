use super::*;
use hebbian_bounded_process::run_async;
use std::future::{Future, pending};
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

struct TestDelay(Instant);

impl Future for TestDelay {
    type Output = ();

    fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<()> {
        if Instant::now() >= self.0 {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }
}

fn delay(duration: Duration) -> TestDelay {
    TestDelay(Instant::now() + duration)
}

// This executor polls its timer deliberately; the production caller supplies
// its runtime's wake-aware timer. The future must also be movable across workers.
fn drive<F: Future + Send>(future: F) -> F::Output {
    let deadline = Instant::now() + PROCESS_TIMEOUT;
    let mut future = Box::pin(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(output) = future.as_mut().poll(&mut context) {
            return output;
        }
        assert!(Instant::now() < deadline, "async command did not settle");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn async_capture_preserves_duplex_io() {
    let input = vec![b'i'; 128 * 1024];
    let mut command = fixture();
    command
        .args(["exchange", "4096"])
        .input(input.as_slice())
        .capture_stderr(true);
    let output = drive(run_async(&command, PROCESS_TIMEOUT, 256 * 1024, delay)).unwrap();
    assert!(output.status.success());
    assert_eq!(output.stderr, vec![b'e'; 4096]);
    assert_eq!(output.stdout[..4096], vec![b'o'; 4096]);
    assert_eq!(output.stdout[4096..], input);
    assert!(!output.exceeded_limit);
}

#[test]
fn async_output_limit_uses_the_same_exit_precedence() {
    let mut command = fixture();
    command.args(["write-then-hold", "11"]);
    assert_eq!(
        drive(run_async(&command, Duration::from_millis(250), 10, delay)).unwrap_err(),
        CommandFailure::Timeout(TimeoutStage::ProcessExit)
    );
    command.on_output_limit(OutputLimitAction::TerminateProcessTree);
    assert_eq!(
        drive(run_async(&command, PROCESS_TIMEOUT, 10, delay)).unwrap_err(),
        CommandFailure::OutputLimit
    );
}

#[test]
fn dropping_pending_async_execution_terminates_the_owned_tree() {
    let temp = tempfile::tempdir().unwrap();
    let pid_file = temp.path().join("async-descendant");
    let mut command = fixture();
    command
        .arg("spawn-descendant")
        .arg(&pid_file)
        .args(["hold", "inherit"])
        .capture_stderr(true);
    let mut execution = Box::pin(run_async(&command, PROCESS_TIMEOUT, 16, |_| {
        pending::<()>()
    }));
    let mut context = Context::from_waker(Waker::noop());
    assert!(execution.as_mut().poll(&mut context).is_pending());
    let deadline = Instant::now() + Duration::from_secs(2);
    let descendant = loop {
        if let Some(pid) = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|text| text.parse::<u32>().ok())
            .filter(|pid| *pid > 0)
        {
            break pid;
        }
        assert!(
            Instant::now() < deadline,
            "fixture did not publish its child"
        );
        std::thread::sleep(Duration::from_millis(1));
    };
    let leader = read_pid(&pid_file.with_extension("leader"));
    assert!(process_exists(leader));
    assert!(process_exists(descendant));
    drop(execution);
    wait_until_process_is_gone(leader);
    wait_until_process_is_gone(descendant);
}

#[test]
fn unpolled_async_execution_never_launches_a_child() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("should-not-exist");
    let mut command = fixture();
    command.arg("write-relative").arg(&marker);
    drop(run_async(&command, PROCESS_TIMEOUT, 16, delay));
    assert!(!marker.exists());
}

#[cfg(unix)]
#[test]
fn cancelling_bound_async_execution_retires_the_inheriting_process_tree() {
    use hebbian_bounded_process::run_unix_bound_command_async;
    use std::os::fd::AsFd;

    let temp = tempfile::tempdir().unwrap();
    let directory = std::fs::File::open(temp.path()).unwrap();
    let anchors = [UnixDirectoryAnchor::new(directory.as_fd(), temp.path()).unwrap()];
    let pid_file = temp.path().join("bound-descendant");
    let mut command = fixture();
    command
        .arg("spawn-descendant")
        .arg(&pid_file)
        .args(["hold", "inherit"]);
    let mut execution = Box::pin(run_unix_bound_command_async(
        &command,
        &anchors,
        Some(0),
        PROCESS_TIMEOUT,
        16,
        |_| pending::<()>(),
    ));
    let mut context = Context::from_waker(Waker::noop());
    assert!(execution.as_mut().poll(&mut context).is_pending());
    let deadline = Instant::now() + Duration::from_secs(2);
    let descendant = loop {
        if let Some(pid) = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|text| text.parse::<u32>().ok())
            .filter(|pid| *pid > 0)
        {
            break pid;
        }
        assert!(
            Instant::now() < deadline,
            "bound fixture did not publish its child"
        );
        std::thread::sleep(Duration::from_millis(1));
    };
    let leader = read_pid(&pid_file.with_extension("leader"));
    assert!(process_exists(leader));
    assert!(process_exists(descendant));
    drop(execution);
    wait_until_process_is_gone(leader);
    wait_until_process_is_gone(descendant);
}
