use hebbian_bounded_process::{CommandFailure, CommandSpec, OutputLimitAction, TimeoutStage, run};
#[cfg(unix)]
use hebbian_bounded_process::{
    UnixBoundCommandFailure, UnixDirectoryAnchor, run_unix_bound_command,
};
#[cfg(all(unix, feature = "provider-conformance-test-support"))]
use hebbian_bounded_process::{
    run_unix_bound_command_with_pre_exec_barrier, unix_pre_exec_barrier,
};
use std::path::Path;
use std::time::{Duration, Instant};

const PROCESS_TIMEOUT: Duration = Duration::from_secs(5);

#[path = "process_tree/async_execution.rs"]
mod async_execution;

fn fixture() -> CommandSpec {
    CommandSpec::new(env!("CARGO_BIN_EXE_bounded-process-fixture"))
}

fn read_pid(path: &Path) -> u32 {
    std::fs::read_to_string(path)
        .expect("fixture wrote descendant pid")
        .parse()
        .expect("fixture wrote a valid pid")
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    i32::try_from(pid).is_ok_and(|pid| unsafe { libc::kill(pid, 0) } == 0)
}

#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return false;
    }
    unsafe {
        CloseHandle(process);
    }
    true
}

fn wait_until_process_is_gone(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_exists(pid) {
        assert!(
            Instant::now() < deadline,
            "owned descendant {pid} survived cleanup"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn spawn_failure_is_classified() {
    let command = CommandSpec::new("hebbian-command-that-does-not-exist");

    assert_eq!(
        run(&command, Duration::from_secs(1), 16).unwrap_err(),
        CommandFailure::Spawn
    );
}

#[test]
fn output_at_the_exact_limit_is_not_oversized() {
    let mut command = fixture();
    command.args(["write", "10"]);

    let output = run(&command, PROCESS_TIMEOUT, 10).unwrap();

    assert!(output.status.success());
    assert_eq!(output.stdout, b"xxxxxxxxxx");
    assert!(!output.exceeded_limit);
}

#[cfg(unix)]
#[test]
fn large_output_drains_within_the_process_sampling_deadline() {
    let count = 2 * 1024 * 1024;
    let mut command = fixture();
    command.args(["write", &count.to_string()]);
    let output = run(&command, Duration::from_secs(1), count).unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, vec![b'x'; count]);
    assert!(!output.exceeded_limit);
}

#[test]
fn output_over_the_limit_is_bounded() {
    let mut command = fixture();
    command.args(["write", "32"]);

    let output = run(&command, PROCESS_TIMEOUT, 8).unwrap();

    assert!(output.status.success());
    assert_eq!(output.stdout, b"xxxxxxxxx");
    assert!(output.exceeded_limit);
}

#[test]
fn cleared_environment_is_not_inherited() {
    let mut command = fixture();
    command.args(["env-state", "PATH"]).clear_env();

    let output = run(&command, PROCESS_TIMEOUT, 16).unwrap();

    assert!(output.status.success());
    assert_eq!(output.stdout, b"absent");
}

#[test]
fn environment_override_is_process_local() {
    const KEY: &str = "DURE_BOUNDED_PROCESS_FIXTURE";
    let before = std::env::var_os(KEY);
    let mut command = fixture();
    command.args(["env-value", KEY]).env(KEY, "isolated");

    let output = run(&command, PROCESS_TIMEOUT, 16).unwrap();

    assert!(output.status.success());
    assert_eq!(output.stdout, b"isolated");
    assert_eq!(std::env::var_os(KEY), before);
}

#[test]
fn explicit_environment_survives_clear() {
    const KEY: &str = "DURE_BOUNDED_PROCESS_FIXTURE";
    let mut command = fixture();
    command
        .args(["env-value", KEY])
        .clear_env()
        .env(KEY, "isolated");

    let output = run(&command, PROCESS_TIMEOUT, 16).unwrap();

    assert!(output.status.success());
    assert_eq!(output.stdout, b"isolated");
}

#[test]
fn limit_plus_one_does_not_hide_process_exit_timeout() {
    let mut command = fixture();
    command.args(["write-then-hold", "11"]);

    assert_eq!(
        run(&command, Duration::from_millis(250), 10).unwrap_err(),
        CommandFailure::Timeout(TimeoutStage::ProcessExit)
    );
}

#[test]
fn strict_output_limit_terminates_the_leader_and_inherited_output_descendant() {
    for mode in ["overflow-stdout", "overflow-stderr"] {
        let temp = tempfile::tempdir().unwrap();
        let pid_file = temp.path().join("descendant-pid");
        let mut command = fixture();
        command
            .arg("spawn-descendant")
            .arg(&pid_file)
            .args([mode, "inherit"])
            .capture_stderr(true)
            .on_output_limit(OutputLimitAction::TerminateProcessTree);
        let started = Instant::now();
        assert_eq!(
            run(&command, PROCESS_TIMEOUT, 10).unwrap_err(),
            CommandFailure::OutputLimit
        );
        let leader = read_pid(&pid_file.with_extension("leader"));
        let descendant = read_pid(&pid_file);
        wait_until_process_is_gone(leader);
        wait_until_process_is_gone(descendant);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{mode} cleanup waited until the execution deadline"
        );
        eprintln!("{mode}: leader {leader} and descendant {descendant} exited after overflow");
    }
}

#[test]
fn timeout_terminates_the_owned_descendant() {
    let temp = tempfile::tempdir().unwrap();
    let pid_file = temp.path().join("descendant-pid");
    let mut command = fixture();
    command
        .arg("spawn-descendant")
        .arg(&pid_file)
        .args(["hold", "inherit"]);

    assert_eq!(
        run(&command, PROCESS_TIMEOUT, 1024).unwrap_err(),
        CommandFailure::Timeout(TimeoutStage::ProcessExit)
    );
    wait_until_process_is_gone(read_pid(&pid_file));
}

#[test]
fn leader_exit_terminates_an_inherited_output_descendant() {
    let temp = tempfile::tempdir().unwrap();
    let pid_file = temp.path().join("descendant-pid");
    let mut command = fixture();
    command
        .arg("spawn-descendant")
        .arg(&pid_file)
        .args(["exit", "inherit"]);

    let output = run(&command, PROCESS_TIMEOUT, 1024).unwrap();

    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    wait_until_process_is_gone(read_pid(&pid_file));
}

#[test]
fn successful_leader_cleans_up_a_background_output_descendant() {
    let temp = tempfile::tempdir().unwrap();
    let pid_file = temp.path().join("descendant-pid");
    let mut command = fixture();
    command
        .arg("spawn-descendant")
        .arg(&pid_file)
        .args(["exit", "null"]);

    let output = run(&command, PROCESS_TIMEOUT, 1024).unwrap();

    assert!(output.status.success());
    assert_eq!(output.stdout, b"ok");
    wait_until_process_is_gone(read_pid(&pid_file));
}

#[cfg(unix)]
fn wait_for_path(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(Instant::now() < deadline, "fixture path was not published");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
#[test]
fn pre_exec_barrier_publishes_the_exact_child_and_releases_to_exec() {
    let mut command = fixture();
    command.arg("process-id");
    let (mut controller, barrier) = unix_pre_exec_barrier().unwrap();

    std::thread::scope(|scope| {
        let running = scope.spawn(|| {
            run_unix_bound_command_with_pre_exec_barrier(
                &command,
                &[],
                None,
                barrier,
                PROCESS_TIMEOUT,
                64,
            )
        });
        let ready = controller.wait_until_ready(PROCESS_TIMEOUT).unwrap();
        controller.release().unwrap();
        let output = running.join().unwrap().unwrap();

        assert!(output.status.success());
        assert_eq!(
            std::str::from_utf8(&output.stdout)
                .unwrap()
                .parse::<u32>()
                .unwrap(),
            ready.process_id()
        );
    });
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
#[test]
fn pre_exec_barrier_swap_routes_the_provider_to_the_retained_inode() {
    use std::os::fd::AsFd;

    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("original");
    let retained = temp.path().join("retained");
    std::fs::create_dir(&original).unwrap();
    let directory = std::fs::File::open(&original).unwrap();
    let anchor = UnixDirectoryAnchor::new(directory.as_fd(), &original).unwrap();
    let mut command = fixture();
    command.args(["write-relative", "marker"]);
    let (mut controller, barrier) = unix_pre_exec_barrier().unwrap();

    std::thread::scope(|scope| {
        let running = scope.spawn(|| {
            run_unix_bound_command_with_pre_exec_barrier(
                &command,
                &[anchor],
                Some(0),
                barrier,
                PROCESS_TIMEOUT,
                16,
            )
        });
        controller.wait_until_ready(PROCESS_TIMEOUT).unwrap();
        std::fs::rename(&original, &retained).unwrap();
        std::fs::create_dir(&original).unwrap();
        controller.release().unwrap();
        assert!(running.join().unwrap().unwrap().status.success());
    });

    assert_eq!(std::fs::read(retained.join("marker")).unwrap(), b"written");
    assert!(!original.join("marker").exists());
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
#[test]
fn pre_exec_barrier_wrong_release_is_a_typed_pre_exec_failure() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("provider-executed");
    let mut command = fixture();
    command.arg("write-relative").arg(&marker);
    let (mut controller, barrier) = unix_pre_exec_barrier().unwrap();

    std::thread::scope(|scope| {
        let running = scope.spawn(|| {
            run_unix_bound_command_with_pre_exec_barrier(
                &command,
                &[],
                None,
                barrier,
                PROCESS_TIMEOUT,
                16,
            )
        });
        controller.wait_until_ready(PROCESS_TIMEOUT).unwrap();
        controller.cancel().unwrap();
        assert_eq!(
            running.join().unwrap().unwrap_err(),
            UnixBoundCommandFailure::PreExecBarrierCancelled
        );
    });
    assert!(!marker.exists());
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
#[test]
fn pre_exec_barrier_eof_is_a_typed_pre_exec_failure() {
    let mut command = fixture();
    command.arg("process-id");
    let (mut controller, barrier) = unix_pre_exec_barrier().unwrap();

    std::thread::scope(|scope| {
        let running = scope.spawn(|| {
            run_unix_bound_command_with_pre_exec_barrier(
                &command,
                &[],
                None,
                barrier,
                PROCESS_TIMEOUT,
                16,
            )
        });
        controller.wait_until_ready(PROCESS_TIMEOUT).unwrap();
        controller.disconnect().unwrap();
        assert_eq!(
            running.join().unwrap().unwrap_err(),
            UnixBoundCommandFailure::PreExecBarrierCancelled
        );
    });
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
#[test]
fn dropping_the_pre_exec_controller_cancels_the_child() {
    let mut command = fixture();
    command.arg("process-id");
    let (controller, barrier) = unix_pre_exec_barrier().unwrap();
    drop(controller);

    assert_eq!(
        run_unix_bound_command_with_pre_exec_barrier(
            &command,
            &[],
            None,
            barrier,
            PROCESS_TIMEOUT,
            16,
        )
        .unwrap_err(),
        UnixBoundCommandFailure::PreExecBarrierCancelled
    );
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
#[test]
fn pre_exec_ready_timeout_cancels_a_later_child_without_hanging() {
    let mut command = fixture();
    command.arg("process-id");
    let (mut controller, barrier) = unix_pre_exec_barrier().unwrap();

    assert_eq!(
        controller.wait_until_ready(Duration::from_millis(1)),
        Err(hebbian_bounded_process::UnixPreExecBarrierControllerFailure::ReadyTimeout)
    );
    drop(controller);
    assert_eq!(
        run_unix_bound_command_with_pre_exec_barrier(
            &command,
            &[],
            None,
            barrier,
            PROCESS_TIMEOUT,
            16,
        )
        .unwrap_err(),
        UnixBoundCommandFailure::PreExecBarrierCancelled
    );
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
#[test]
fn pre_launch_failure_closes_the_child_endpoints_and_wakes_the_controller() {
    use std::os::fd::AsFd;

    let temp = tempfile::tempdir().unwrap();
    let directory = std::fs::File::open(temp.path()).unwrap();
    let anchor = UnixDirectoryAnchor::new(directory.as_fd(), temp.path()).unwrap();
    let mut command = fixture();
    command.arg("process-id").current_dir(temp.path());
    let (mut controller, barrier) = unix_pre_exec_barrier().unwrap();

    std::thread::scope(|scope| {
        let running = scope.spawn(|| {
            run_unix_bound_command_with_pre_exec_barrier(
                &command,
                &[anchor],
                Some(0),
                barrier,
                PROCESS_TIMEOUT,
                16,
            )
        });
        assert_eq!(
            controller.wait_until_ready(PROCESS_TIMEOUT),
            Err(hebbian_bounded_process::UnixPreExecBarrierControllerFailure::ReadyRead)
        );
        assert_eq!(
            running.join().unwrap().unwrap_err(),
            UnixBoundCommandFailure::DirectoryAnchorUnavailable
        );
    });
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
#[test]
fn pre_exec_barrier_descriptors_are_cloexec_and_absent_after_exec() {
    let (mut controller, barrier) = unix_pre_exec_barrier().unwrap();
    let descriptors = controller.barrier_file_descriptors();
    for descriptor in descriptors {
        let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
        assert_ne!(flags, -1);
        assert_ne!(flags & libc::FD_CLOEXEC, 0);
    }
    let mut command = fixture();
    command.arg("assert-fds-closed");
    for descriptor in descriptors {
        command.arg(descriptor.to_string());
    }

    std::thread::scope(|scope| {
        let running = scope.spawn(|| {
            run_unix_bound_command_with_pre_exec_barrier(
                &command,
                &[],
                None,
                barrier,
                PROCESS_TIMEOUT,
                64,
            )
        });
        controller.wait_until_ready(PROCESS_TIMEOUT).unwrap();
        controller.release().unwrap();
        let output = running.join().unwrap().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"closed");
    });
}

#[cfg(unix)]
#[test]
fn bound_command_rejects_a_replaced_directory_before_provider_exec() {
    use std::os::fd::AsFd;

    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("original");
    let retained = temp.path().join("retained");
    std::fs::create_dir(&original).unwrap();
    let directory = std::fs::File::open(&original).unwrap();
    let anchor = UnixDirectoryAnchor::new(directory.as_fd(), &original).unwrap();
    let mut command = fixture();
    command.args(["write-relative", "provider-executed"]);
    std::fs::rename(&original, &retained).unwrap();
    std::fs::create_dir(&original).unwrap();

    assert_eq!(
        run_unix_bound_command(&command, &[anchor], Some(0), PROCESS_TIMEOUT, 16).unwrap_err(),
        UnixBoundCommandFailure::DirectoryAnchorChanged
    );
    assert!(!retained.join("provider-executed").exists());
    assert!(!original.join("provider-executed").exists());
}

#[cfg(unix)]
#[test]
fn fchdir_anchor_keeps_post_exec_relative_writes_on_the_original_inode() {
    use std::os::fd::{AsFd, AsRawFd};

    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("original");
    let retained = temp.path().join("retained");
    let ready = temp.path().join("ready");
    let release = temp.path().join("release");
    std::fs::create_dir(&original).unwrap();
    let directory = std::fs::File::open(&original).unwrap();
    let parent_flags = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_GETFD) };
    assert_ne!(parent_flags & libc::FD_CLOEXEC, 0);
    let anchor = UnixDirectoryAnchor::new(directory.as_fd(), &original).unwrap();
    let mut command = fixture();
    command
        .arg("write-relative-after-barrier")
        .arg(&ready)
        .arg(&release)
        .arg("marker");

    std::thread::scope(|scope| {
        let running = scope
            .spawn(|| run_unix_bound_command(&command, &[anchor], Some(0), PROCESS_TIMEOUT, 16));
        wait_for_path(&ready);
        std::fs::rename(&original, &retained).unwrap();
        std::fs::create_dir(&original).unwrap();
        std::fs::write(&release, b"release").unwrap();
        assert!(running.join().unwrap().unwrap().status.success());
    });

    assert_eq!(std::fs::read(retained.join("marker")).unwrap(), b"written");
    assert!(!original.join("marker").exists());
    let parent_flags = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_GETFD) };
    assert_ne!(parent_flags & libc::FD_CLOEXEC, 0);
}

#[cfg(target_os = "linux")]
#[test]
fn proc_fd_environment_keeps_post_exec_writes_on_the_original_inode() {
    use std::os::fd::AsFd;

    const DIRECTORY_ENV: &str = "DURE_BOUNDED_PROCESS_DIRECTORY";
    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("original");
    let retained = temp.path().join("retained");
    let ready = temp.path().join("ready");
    let release = temp.path().join("release");
    std::fs::create_dir(&original).unwrap();
    let directory = std::fs::File::open(&original).unwrap();
    let anchor = UnixDirectoryAnchor::new(directory.as_fd(), &original).unwrap();
    let descriptor_path = anchor.descriptor_path();
    let mut command = fixture();
    command
        .arg("write-below-env-after-barrier")
        .arg(DIRECTORY_ENV)
        .arg(&ready)
        .arg(&release)
        .arg("marker")
        .env(DIRECTORY_ENV, descriptor_path);

    std::thread::scope(|scope| {
        let running =
            scope.spawn(|| run_unix_bound_command(&command, &[anchor], None, PROCESS_TIMEOUT, 16));
        wait_for_path(&ready);
        std::fs::rename(&original, &retained).unwrap();
        std::fs::create_dir(&original).unwrap();
        std::fs::write(&release, b"release").unwrap();
        assert!(running.join().unwrap().unwrap().status.success());
    });

    assert_eq!(std::fs::read(retained.join("marker")).unwrap(), b"written");
    assert!(!original.join("marker").exists());
}

#[cfg(target_os = "macos")]
#[test]
fn volume_file_id_environment_keeps_post_exec_writes_on_the_original_inode() {
    use std::os::fd::AsFd;
    use std::os::unix::fs::MetadataExt;

    const DIRECTORY_ENV: &str = "DURE_BOUNDED_PROCESS_DIRECTORY";
    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("original");
    let retained = temp.path().join("retained");
    let ready = temp.path().join("ready");
    let release = temp.path().join("release");
    std::fs::create_dir(&original).unwrap();
    let directory = std::fs::File::open(&original).unwrap();
    let metadata = directory.metadata().unwrap();
    let file_id_path = format!("/.vol/{}/{}", metadata.dev(), metadata.ino());
    let anchor = UnixDirectoryAnchor::new(directory.as_fd(), &original).unwrap();
    let mut command = fixture();
    command
        .arg("write-below-env-after-barrier")
        .arg(DIRECTORY_ENV)
        .arg(&ready)
        .arg(&release)
        .arg("marker")
        .env(DIRECTORY_ENV, file_id_path);

    std::thread::scope(|scope| {
        let running =
            scope.spawn(|| run_unix_bound_command(&command, &[anchor], None, PROCESS_TIMEOUT, 16));
        wait_for_path(&ready);
        std::fs::rename(&original, &retained).unwrap();
        std::fs::create_dir(&original).unwrap();
        std::fs::write(&release, b"release").unwrap();
        assert!(running.join().unwrap().unwrap().status.success());
    });

    assert_eq!(std::fs::read(retained.join("marker")).unwrap(), b"written");
    assert!(!original.join("marker").exists());
}
