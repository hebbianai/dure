#![cfg(unix)]

use hmux_client::{
    LocalProcessGenerationStatus, LocalSessionCatalog, ManagedCreateRequest, ManagedSessionCreator,
    ManagedSessionStopper, ManagedStopOutcome, ManagedStopRequest, PermissionMode,
    SessionDescriptor, SessionLifecycle, probe_local_process_generation,
};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

const CONCURRENT_BROKERS: usize = 12;
const FIXTURE_DISCOVERY_ROOT_ENV: &str = "HMUX_TEST_BROKER_FD_DISCOVERY_ROOT";

#[test]
fn concurrent_managed_hosts_do_not_retain_foreign_broker_pipes() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let mut fixture = Command::new(std::env::current_exe().unwrap())
        .arg("--ignored")
        .arg("--exact")
        .arg("concurrent_managed_hosts_do_not_retain_foreign_broker_pipes_fixture")
        .arg("--nocapture")
        .env(FIXTURE_DISCOVERY_ROOT_ENV, &discovery_root)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = fixture.try_wait().unwrap() {
            if status.success() {
                return;
            }
            cleanup_managed_hosts(&discovery_root);
            panic!("concurrent broker fixture failed with {status}");
        }
        if Instant::now() >= deadline {
            fixture.kill().unwrap();
            fixture.wait().unwrap();
            cleanup_managed_hosts(&discovery_root);
            panic!("concurrent broker fixture did not finish within 30 seconds");
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[test]
#[ignore = "run in an isolated process so a descriptor regression has bounded cleanup"]
fn concurrent_managed_hosts_do_not_retain_foreign_broker_pipes_fixture() {
    let discovery_root = std::env::var_os(FIXTURE_DISCOVERY_ROOT_ENV)
        .map(std::path::PathBuf::from)
        .expect("broker FD fixture requires its isolated discovery root");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
    let barrier = Arc::new(Barrier::new(CONCURRENT_BROKERS + 1));
    let pipes = (0..CONCURRENT_BROKERS)
        .map(|_| inheritable_broker_pipe().unwrap())
        .collect::<Vec<_>>();

    let workers = (0..CONCURRENT_BROKERS)
        .map(|index| {
            let barrier = Arc::clone(&barrier);
            let discovery_root = discovery_root.clone();
            let cwd = cwd.clone();
            thread::spawn(move || {
                barrier.wait();
                let request = ManagedCreateRequest::new(
                    format!("foreign-pipe-create-{index}"),
                    format!("foreign-pipe-session-{index}"),
                    format!("foreign-pipe-workspace-{index}"),
                    "test-provider",
                    PermissionMode::Default,
                    &cwd,
                    vec!["/bin/sleep".into(), "120".into()],
                    24,
                    80,
                )
                .unwrap();
                ManagedSessionCreator::new(runtime)
                    .with_discovery_root(discovery_root)
                    .create(request)
                    .map(|created| created.session().descriptor().clone())
            })
        })
        .collect::<Vec<_>>();

    barrier.wait();
    let descriptors = workers
        .into_iter()
        .map(|worker| worker.join().unwrap().unwrap())
        .collect::<Vec<_>>();
    for descriptor in &descriptors {
        assert_eq!(descriptor.lifecycle, SessionLifecycle::Ready);
        assert_eq!(
            probe_local_process_generation(&descriptor.host_process).unwrap(),
            LocalProcessGenerationStatus::Live
        );
    }

    let (readers, writers): (Vec<_>, Vec<_>) = pipes.into_iter().unzip();
    drop(writers);
    let foreign_writers_closed_while_hosts_live =
        all_pipe_writers_closed(&readers, Duration::from_secs(1)).unwrap();

    for (index, descriptor) in descriptors.iter().enumerate() {
        let receipt = ManagedSessionStopper::new(runtime, &cwd)
            .with_discovery_root(&discovery_root)
            .stop(exact_stop_request(index, descriptor))
            .unwrap();
        assert_eq!(receipt.outcome(), ManagedStopOutcome::Stopped);
    }
    assert!(
        all_pipe_writers_closed(&readers, Duration::from_secs(5)).unwrap(),
        "exact cleanup must release every foreign broker pipe"
    );
    assert!(
        foreign_writers_closed_while_hosts_live,
        "a Ready Host retained a foreign broker pipe and would block its stderr reader"
    );
}

fn cleanup_managed_hosts(discovery_root: &Path) {
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
    let catalog = LocalSessionCatalog::new(discovery_root);
    for (index, descriptor) in catalog.list().unwrap_or_default().iter().enumerate() {
        if descriptor.lifecycle == SessionLifecycle::Ready {
            let _ = ManagedSessionStopper::new(runtime, &cwd)
                .with_discovery_root(discovery_root)
                .stop(exact_stop_request(index, descriptor));
        }
    }
}

fn inheritable_broker_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut descriptors = [-1, -1];
    // SAFETY: descriptors points to storage for the two descriptors returned by pipe.
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a successful pipe call returned both owned descriptors.
    let reader = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    // SAFETY: a successful pipe call returned both owned descriptors.
    let writer = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    set_close_on_exec(reader.as_raw_fd(), true)?;
    set_close_on_exec(writer.as_raw_fd(), false)?;
    Ok((reader, writer))
}

fn set_close_on_exec(descriptor: libc::c_int, enabled: bool) -> io::Result<()> {
    // SAFETY: descriptor remains owned by the caller for both fcntl operations.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    let flags = if enabled {
        flags | libc::FD_CLOEXEC
    } else {
        flags & !libc::FD_CLOEXEC
    };
    // SAFETY: descriptor remains owned by the caller and flags came from F_GETFD.
    if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn all_pipe_writers_closed(readers: &[OwnedFd], timeout: Duration) -> io::Result<bool> {
    let mut descriptors = readers
        .iter()
        .map(|reader| libc::pollfd {
            fd: reader.as_raw_fd(),
            events: libc::POLLHUP,
            revents: 0,
        })
        .collect::<Vec<_>>();
    let deadline = Instant::now() + timeout;
    loop {
        for descriptor in &mut descriptors {
            descriptor.revents = 0;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let timeout_ms = i32::try_from(remaining.as_millis()).unwrap_or(i32::MAX);
        // SAFETY: descriptors is writable for its full length during poll.
        let ready =
            unsafe { libc::poll(descriptors.as_mut_ptr(), descriptors.len() as _, timeout_ms) };
        if ready == -1 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if descriptors
            .iter()
            .all(|descriptor| descriptor.revents & libc::POLLHUP != 0)
        {
            return Ok(true);
        }
        if ready == 0 || Instant::now() >= deadline {
            return Ok(false);
        }
    }
}

fn exact_stop_request(index: usize, descriptor: &SessionDescriptor) -> ManagedStopRequest {
    ManagedStopRequest::new(
        format!("foreign-pipe-stop-{index}"),
        &descriptor.session_id,
        &descriptor.workspace_id,
    )
    .and_then(|request| {
        request.with_expected_fence(
            &descriptor.runner_principal,
            &descriptor.runner_instance,
            descriptor.channel_epoch.parse().unwrap(),
            &descriptor.host_instance_id,
            &descriptor.terminal_epoch,
        )
    })
    .unwrap()
}
