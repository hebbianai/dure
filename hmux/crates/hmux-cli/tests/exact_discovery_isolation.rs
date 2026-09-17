#![cfg(unix)]

use hmux_client::{
    ExactDiscoveryWorker, ExactSessionProbeResult, LocalSessionCatalog, SessionSelector,
    inspect_local_sessions_exact_isolated,
};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};
use tempfile::TempDir;

fn hmux_executable() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_hmux"))
}

#[test]
fn stalled_exact_discovery_is_process_wide_bounded_and_reclaimable() {
    let fixture = TempDir::new().unwrap();
    let pid_directory = fixture.path().join("worker-pids");
    fs::create_dir(&pid_directory).unwrap();
    let worker_script = fixture.path().join("stalled-worker");
    fs::write(
        &worker_script,
        format!(
            "#!/bin/sh\nset -eu\n: >{}/\"$$\"\nexec /bin/sleep 60\n",
            shell_quote(&pid_directory)
        ),
    )
    .unwrap();
    fs::set_permissions(&worker_script, fs::Permissions::from_mode(0o700)).unwrap();

    let calls = 16;
    let start = Arc::new(Barrier::new(calls + 1));
    let catalog = Arc::new(LocalSessionCatalog::new(
        fixture.path().join("missing-discovery"),
    ));
    let mut callers = Vec::new();
    for index in 0..calls {
        let start = Arc::clone(&start);
        let catalog = Arc::clone(&catalog);
        let worker = ExactDiscoveryWorker::new(worker_script.clone());
        callers.push(std::thread::spawn(move || {
            start.wait();
            inspect_local_sessions_exact_isolated(
                &catalog,
                &worker,
                vec![SessionSelector::new(
                    format!("stalled-{index}"),
                    Some("workspace".into()),
                )],
                1,
                Duration::from_secs(5),
            )
            .unwrap()
        }));
    }
    start.wait();

    // The all-target gate runs this binary beside other Rust test binaries, so
    // process startup can take longer than a sub-second functional deadline on
    // a loaded self-hosted runner. Keep the observation window below the
    // lookup deadline while leaving enough room for all eight helpers to exec.
    let observation_deadline = Instant::now() + Duration::from_secs(4);
    let mut observed_maximum = 0;
    while Instant::now() < observation_deadline {
        observed_maximum = observed_maximum.max(recorded_processes(&pid_directory));
        assert!(
            observed_maximum <= 8,
            "overlapping batches exceeded the process-wide lookup cap"
        );
        if observed_maximum == 8 {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        observed_maximum, 8,
        "fixture did not occupy every lookup slot"
    );

    for caller in callers {
        let results = caller.join().unwrap();
        assert!(matches!(
            results.as_slice(),
            [ExactSessionProbeResult::Unprobed(_)]
        ));
    }
    let healthy_worker = ExactDiscoveryWorker::new(hmux_executable());
    let healthy_started = Instant::now();
    let results = inspect_local_sessions_exact_isolated(
        &catalog,
        &healthy_worker,
        vec![SessionSelector::new(
            "healthy-missing",
            Some("workspace".into()),
        )],
        1,
        Duration::from_secs(1),
    )
    .unwrap();
    assert!(matches!(
        results.as_slice(),
        [ExactSessionProbeResult::NotFound(_)]
    ));
    assert!(
        healthy_started.elapsed() < Duration::from_secs(1),
        "a healthy exact lookup was starved after stalled workers"
    );
}

fn recorded_processes(directory: &Path) -> usize {
    fs::read_dir(directory)
        .unwrap()
        .filter_map(Result::ok)
        .count()
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}
