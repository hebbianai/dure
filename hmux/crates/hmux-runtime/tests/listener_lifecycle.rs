#![cfg(all(
    unix,
    feature = "terminal-state-stream",
    debug_assertions,
    target_pointer_width = "64"
))]

use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::path::Path;
use std::time::{Duration, Instant};

use hmux_client::{
    LocalProcessGenerationStatus, LocalSession, ManagedCreateRequest, ManagedSessionCreator,
    ManagedSessionStopper, ManagedStopRequest, PermissionMode, TerminalSurfaceAccess,
    TerminalSurfaceAttachment, probe_local_process_generation,
};

const WAIT: Duration = Duration::from_secs(5);

fn wait_for_file(path: &Path) -> String {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Ok(text) = fs::read_to_string(path) {
            return text;
        }
        assert!(
            Instant::now() < deadline,
            "missing fixture receipt {path:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn attach(session: &LocalSession) -> TerminalSurfaceAttachment {
    TerminalSurfaceAttachment::from_connection(
        session
            .connect_with_options(TerminalSurfaceAttachment::connection_options(
                TerminalSurfaceAccess::Writer,
                None,
            ))
            .expect("the original Host listener must accept the next connection"),
    )
    .unwrap()
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[test]
fn failed_connection_worker_keeps_the_managed_shell_listener_usable() {
    assert_listener_recovers(
        "HMUX_RUNTIME_TEST_CONNECTION_WORKER_FAILURE",
        "connection_worker_unavailable",
    );
}

#[test]
fn failed_accept_keeps_the_managed_shell_listener_usable() {
    assert_listener_recovers("HMUX_RUNTIME_TEST_ACCEPT_FAILURE", "listener_accept_failed");
}

fn assert_listener_recovers(fault_environment: &str, failure_code: &str) {
    // Keep assertion failures for the owning process guardian. A refused
    // transport stop below is recorded explicitly, never ignored by Drop.
    let root = tempfile::tempdir().unwrap().keep();
    let discovery = root.join("discovery");
    let fault = root.join("worker-fault");
    let observed = fault.with_extension("observed");
    let runtime_log = root.join("host.log");
    let wrapper = root.join("runtime");
    let home = root.join("home");
    fs::create_dir(&home).unwrap();
    let socket_root = root.join("s");
    fs::create_dir(&socket_root).unwrap();
    let environment = [
        ("HOME", home.as_path()),
        ("DURE_HOME", home.as_path()),
        ("ZDOTDIR", home.as_path()),
        ("HMUX_RUNTIME_ROOT", socket_root.as_path()),
        ("HMUX_RUNTIME_LOG", runtime_log.as_path()),
        (fault_environment, fault.as_path()),
    ]
    .into_iter()
    .map(|(key, value)| format!("export {key}={}\n", shell_quote(&value.to_string_lossy())))
    .collect::<String>();
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\n{environment}exec {} \"$@\"\n",
            shell_quote(env!("CARGO_BIN_EXE_hmux-runtime")),
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let created = ManagedSessionCreator::new(&wrapper)
        .with_discovery_root(&discovery)
        .create(
            ManagedCreateRequest::new(
                "listener-worker-create",
                "listener-worker-shell",
                "listener-worker-workspace",
                "local-shell",
                PermissionMode::Default,
                &home,
                vec!["/bin/sh".into(), "-i".into()],
                24,
                100,
            )
            .unwrap(),
        )
        .unwrap();
    let session = created.session();
    let source = session.descriptor().clone();
    eprintln!(
        "listener fixture root={root:?} session={} host={:?} provider={:?} endpoint={}",
        source.session_id, source.host_process, source.provider_process, source.endpoint.address,
    );
    let scenario = catch_unwind(AssertUnwindSafe(|| {
        let first = root.join("first");
        let mut surface = attach(session);
        surface
            .send_command_input_confirmed(
                format!(
                    "printf FIRST_OK > {}",
                    shell_quote(&first.to_string_lossy())
                ),
                true,
                WAIT,
            )
            .unwrap();
        assert_eq!(wait_for_file(&first), "FIRST_OK");
        surface.detach_confirmed(WAIT).unwrap();

        let accept_fault = fault_environment == "HMUX_RUNTIME_TEST_ACCEPT_FAILURE";
        let failures = if accept_fault { 3 } else { 1 };
        fs::write(&fault, failures.to_string()).unwrap();
        let fault_started = Instant::now();
        for remaining in (1..=failures).rev() {
            let mut rejected = UnixStream::connect(&source.endpoint.address).unwrap();
            rejected.set_read_timeout(Some(WAIT)).unwrap();
            let mut byte = [0];
            assert_eq!(rejected.read(&mut byte).unwrap(), 0);
            if accept_fault {
                assert!(
                    wait_for_file(&observed).starts_with(&format!("{remaining}: ")),
                    "each refused connection must exercise accept failure, not handshake expiry"
                );
            }
        }
        if accept_fault {
            assert!(fault_started.elapsed() >= Duration::from_millis(150));
        }
        let error = wait_for_file(&observed);
        assert!(!error.is_empty());
        eprintln!("{fault_environment}: {error}");
        assert_eq!(
            probe_local_process_generation(&source.host_process).unwrap(),
            LocalProcessGenerationStatus::Live,
        );
        assert_eq!(
            probe_local_process_generation(&source.provider_process).unwrap(),
            LocalProcessGenerationStatus::Live,
        );

        // A new connection to the same immutable generation must work. No
        // retry of the refused connection, replacement, or endpoint rebind.
        let second = root.join("second");
        let mut surface = attach(session);
        surface
            .send_command_input_confirmed(
                format!(
                    "printf '%s_OK\\n' SECOND | tee {}",
                    shell_quote(&second.to_string_lossy()),
                ),
                true,
                WAIT,
            )
            .unwrap();
        assert_eq!(wait_for_file(&second), "SECOND_OK\n");
        let output_deadline = Instant::now() + WAIT;
        while !surface.current_frame().text().contains("SECOND_OK") {
            surface
                .read_event_before(output_deadline)
                .unwrap_or_else(|error| {
                    panic!(
                        "{error}; actual viewport: {:?}",
                        surface.current_frame().text()
                    )
                });
        }
        eprintln!("rendered marker: {:?}", surface.current_frame().text());
        surface.detach_confirmed(WAIT).unwrap();
        assert!(session.descriptor().same_generation(&source));
        let diagnostics =
            fs::read_to_string(discovery.join(".diagnostics/runtime-v1/runtime.jsonl")).unwrap();
        let rejection = diagnostics
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .find(|record| record["failureCode"] == failure_code)
            .expect("failed admission must retain its diagnostic");
        if accept_fault {
            assert_eq!(rejection["event"], "listener_degraded");
            assert_eq!(rejection["osError"], libc::EMFILE);
            for event in ["listener_degraded", "listener_recovered"] {
                assert_eq!(
                    diagnostics
                        .lines()
                        .filter(|line| {
                            serde_json::from_str::<serde_json::Value>(line).unwrap()["event"]
                                == event
                        })
                        .count(),
                    1,
                    "one diagnostic per failure episode, not per retry"
                );
            }
        } else {
            assert_eq!(rejection["event"], "connection_rejected");
        }
        assert_eq!(rejection["pendingConnections"], 0);
        assert_eq!(rejection["connectionWorkers"], 0);
        eprintln!("failed handoff released its admission guards: {rejection}");
        eprintln!(
            "same managed Host/provider executed FIRST_OK and SECOND_OK across admission failure"
        );
    }));

    let request = ManagedStopRequest::new(
        "listener-worker-stop",
        &source.session_id,
        &source.workspace_id,
    )
    .unwrap()
    .with_expected_fence(
        &source.runner_principal,
        &source.runner_instance,
        source.channel_epoch.parse().unwrap(),
        &source.host_instance_id,
        &source.terminal_epoch,
    )
    .unwrap();
    let cleanup = ManagedSessionStopper::new(&wrapper, &home)
        .with_discovery_root(&discovery)
        .stop(request);
    eprintln!("exact managed cleanup: {cleanup:?}");
    if let Err(failure) = scenario {
        resume_unwind(failure);
    }
    cleanup.expect("exact managed cleanup must complete after the scenario");
    let deadline = Instant::now() + WAIT;
    for process in [&source.host_process, &source.provider_process] {
        loop {
            if probe_local_process_generation(process).unwrap()
                == LocalProcessGenerationStatus::Absent
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "owned process remained: {process:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    eprintln!("exact Host and provider generations absent after cleanup");
}
