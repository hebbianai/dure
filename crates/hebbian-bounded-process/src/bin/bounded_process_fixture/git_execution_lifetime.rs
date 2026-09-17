use hebbian_bounded_process::{
    CommandSpec, UnixDirectoryAnchor, run_unix_bound_command, run_unix_bound_command_async,
};
use std::fs::{self, File};
use std::future::Future;
use std::io;
use std::os::fd::{AsFd, AsRawFd};
use std::path::PathBuf;
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

const ROOT_ENV: &str = "DURE_GIT_LIFETIME_FIXTURE_ROOT";

pub(super) fn run(mut arguments: impl Iterator<Item = String>) {
    let mode = arguments.next().expect("lease inheritance mode");
    let root = PathBuf::from(arguments.next().expect("isolated repository root"));
    let lease_path = fs::canonicalize(root.join("execution-lease")).unwrap();
    let lease = File::open(&lease_path).unwrap();
    // SAFETY: the File owns this descriptor throughout the syscall.
    assert_eq!(
        unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0,
        "fixture lease acquisition failed: {}",
        io::Error::last_os_error()
    );
    let mut command = CommandSpec::new("git");
    command
        .arg("-C")
        .arg(root.join("repository"))
        .args(["worktree", "add", "--quiet", "--detach"])
        .arg(root.join("checkout"))
        .arg("HEAD")
        .clear_env()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env(ROOT_ENV, &root)
        .env(
            "DURE_GIT_LIFETIME_FIXTURE_EXE",
            std::env::current_exe().unwrap(),
        )
        .capture_stderr(true);
    let anchor = UnixDirectoryAnchor::new(lease.as_fd(), &lease_path).unwrap();
    let anchors = match mode.as_str() {
        "parent-only" => &[][..],
        "inherited" | "async-inherited" => std::slice::from_ref(&anchor),
        _ => panic!("unknown lease inheritance mode"),
    };
    let output = if mode == "async-inherited" {
        let execution = run_unix_bound_command_async(
            &command,
            anchors,
            None,
            Duration::from_secs(25),
            64 * 1024,
            |duration| {
                let deadline = Instant::now() + duration;
                std::future::poll_fn(move |_| {
                    if Instant::now() >= deadline {
                        Poll::Ready(())
                    } else {
                        Poll::Pending
                    }
                })
            },
        );
        let mut execution = std::pin::pin!(execution);
        let mut context = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(output) = execution.as_mut().poll(&mut context) {
                break output.unwrap();
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    } else {
        run_unix_bound_command(&command, anchors, None, Duration::from_secs(25), 64 * 1024).unwrap()
    };
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

pub(super) fn post_checkout() {
    let root = PathBuf::from(std::env::var_os(ROOT_ENV).expect("isolated hook root"));
    fs::write(root.join("hook-ready"), b"ready").unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !root.join("release").exists() {
        assert!(Instant::now() < deadline, "fixture hook was never released");
        std::thread::sleep(Duration::from_millis(5));
    }
    fs::write(root.join("checkout/late-write"), b"original Git hook").unwrap();
    fs::write(root.join("hook-finished"), b"finished").unwrap();
}
