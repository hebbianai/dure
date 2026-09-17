#![cfg(all(
    unix,
    feature = "terminal-state-stream",
    debug_assertions,
    target_pointer_width = "64"
))]

//! A Host that panics must leave evidence a later operator can read. Before
//! the panic hook existed, a Host's stderr was a null device unless an
//! operator had set `HMUX_RUNTIME_LOG` ahead of time, so a dying Host left
//! nothing but a poisoned-lock refusal on the next client and a vanished
//! process.

use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::path::Path;
use std::time::{Duration, Instant};

use hmux_client::{
    LocalProcessGenerationStatus, ManagedCreateRequest, ManagedSessionCreator,
    ManagedSessionStopper, ManagedStopRequest, PermissionMode, probe_local_process_generation,
};

const WAIT: Duration = Duration::from_secs(5);

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn wait_for_line(path: &Path, predicate: impl Fn(&str) -> bool) -> String {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Ok(text) = fs::read_to_string(path) {
            if let Some(line) = text.lines().find(|line| predicate(line)) {
                return line.to_string();
            }
        }
        assert!(
            Instant::now() < deadline,
            "no matching line appeared in {path:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn a_host_panic_is_recorded_as_a_runtime_diagnostic() {
    let root = tempfile::tempdir().unwrap().keep();
    let discovery = root.join("discovery");
    let fault = root.join("worker-panic");
    let wrapper = root.join("runtime");
    let home = root.join("home");
    fs::create_dir(&home).unwrap();
    let socket_root = root.join("s");
    fs::create_dir(&socket_root).unwrap();
    // No `HMUX_RUNTIME_LOG`: the diagnostic record must not depend on it.
    let environment = [
        ("HOME", home.as_path()),
        ("DURE_HOME", home.as_path()),
        ("ZDOTDIR", home.as_path()),
        ("HMUX_RUNTIME_ROOT", socket_root.as_path()),
        ("HMUX_RUNTIME_TEST_CONNECTION_WORKER_PANIC", fault.as_path()),
    ]
    .into_iter()
    .map(|(key, value)| format!("export {key}={}\n", shell_quote(&value.to_string_lossy())))
    .collect::<String>();
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\n{environment}unset HMUX_RUNTIME_LOG\nexec {} \"$@\"\n",
            shell_quote(env!("CARGO_BIN_EXE_hmux-runtime")),
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let created = ManagedSessionCreator::new(&wrapper)
        .with_discovery_root(&discovery)
        .create(
            ManagedCreateRequest::new(
                "host-panic-create",
                "host-panic-shell",
                "host-panic-workspace",
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
        "panic fixture root={root:?} session={} host={:?} endpoint={}",
        source.session_id, source.host_process, source.endpoint.address,
    );
    let scenario = catch_unwind(AssertUnwindSafe(|| {
        fs::write(&fault, b"panic one connection worker").unwrap();
        let mut rejected = UnixStream::connect(&source.endpoint.address).unwrap();
        rejected.set_read_timeout(Some(WAIT)).unwrap();
        let mut byte = [0];
        // The fixture never hands the accepted stream to the panicking
        // thread, so the accept thread drops it and the client reads EOF.
        assert!(matches!(rejected.read(&mut byte), Ok(0)));
        drop(rejected);

        let diagnostics_directory = discovery.join(".diagnostics/runtime-v1");
        let record = wait_for_line(&diagnostics_directory.join("runtime.jsonl"), |line| {
            line.contains("\"host_panic\"")
        });
        let record: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(record["event"], "host_panic");
        assert_eq!(record["session"]["sessionId"], source.session_id);
        assert_eq!(record["panicThread"], "connection-worker-panic-fixture");
        assert_eq!(
            record["panicMessage"],
            "fault-injected Host connection worker panic"
        );
        assert!(
            record["panicLocation"]
                .as_str()
                .is_some_and(|location| location.contains("connection_accept.rs:")),
            "actual record: {record}"
        );
        eprintln!("host panic diagnostic: {record}");

        // A worker panic is not a Host death: the same generation keeps
        // serving, which is exactly why the evidence must be written eagerly.
        assert_eq!(
            probe_local_process_generation(&source.host_process).unwrap(),
            LocalProcessGenerationStatus::Live,
        );
    }));

    let request =
        ManagedStopRequest::new("host-panic-stop", &source.session_id, &source.workspace_id)
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
}
