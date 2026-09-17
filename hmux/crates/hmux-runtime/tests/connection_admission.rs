#![cfg(unix)]

use hmux_client::{
    ClientError, ConnectionOptions, ControllerEvent, ControllerReceiptState, HMUX_SESSION_NAME_ENV,
    HostErrorCode, LocalAttachRole, LocalSession, LocalSessionCatalog, LocalSessionController,
    RetryDirective, SESSION_RETIREMENT_CAPABILITY, StandaloneCreateRequest,
    StandaloneSessionCreator,
};
use hmux_host::local_protocol::{ErrorCode, FrameBody, FrameCodec, FrameLimits, RetryPosture};
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

const MAX_PENDING_CONNECTIONS: usize = 16;
const MAX_HOST_QUEUED_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BURST_WORKERS: usize = 32;
const MAX_BURST_HOST_CPU_MILLIS: u64 = 1_000;
const RESOURCE_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
#[test]
#[ignore = "launched as the deterministic provider process by the admission tests"]
fn connection_admission_fixture_provider() {
    if !matches!(
        std::env::var(HMUX_SESSION_NAME_ENV).as_deref(),
        Ok("admission-primary" | "admission-sibling" | "active-admission")
    ) {
        return;
    }
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    let mut buffer = [0_u8; 1024];
    loop {
        let read = input.read(&mut buffer).unwrap();
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read]).unwrap();
        output.flush().unwrap();
    }
}

struct RuntimeFixture {
    session: LocalSession,
    catalog: LocalSessionCatalog,
    discovery_root: PathBuf,
}

impl RuntimeFixture {
    fn create(root: &Path, name: &str) -> (Self, hmux_client::CreatedStandaloneSession) {
        let discovery_root = root.join(name);
        let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .with_discovery_root(&discovery_root);
        let request = StandaloneCreateRequest::new(
            std::env::current_dir().unwrap().canonicalize().unwrap(),
            Some(name.to_string()),
            vec![
                std::env::current_exe()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                "--ignored".into(),
                "--exact".into(),
                "connection_admission_fixture_provider".into(),
                "--nocapture".into(),
            ],
            24,
            80,
        )
        .unwrap();
        let created = creator.create(request).unwrap();
        let session = created.session().clone();
        let catalog = LocalSessionCatalog::new(&discovery_root);
        (
            Self {
                session,
                catalog,
                discovery_root,
            },
            created,
        )
    }
}

impl Drop for RuntimeFixture {
    fn drop(&mut self) {
        let _ = self
            .session
            .terminate_standalone(&self.catalog, Duration::from_secs(3));
    }
}

#[derive(Clone, Copy, Debug)]
struct ProcessMetrics {
    threads: usize,
    rss_kib: u64,
    cpu_millis: u64,
}

#[derive(Debug)]
struct BurstMeasurement {
    elapsed: Duration,
    p95: Duration,
    peak_metrics: ProcessMetrics,
    host_cpu_millis: u64,
}

#[test]
fn stalled_handshakes_bound_reconnect_bursts_without_harming_live_sessions() {
    let state = tempfile::tempdir().unwrap();
    let (primary, mut created) = RuntimeFixture::create(state.path(), "admission-primary");
    let controller = created.connect_controller().unwrap();
    let address = primary.session.descriptor().endpoint.address.clone();
    let host_pid = primary.session.descriptor().host_process.process_id;
    let baseline = process_metrics(host_pid).expect("Host process metrics must be observable");
    let baseline_resources = wait_for_resource_snapshot(&primary, |snapshot| {
        snapshot["activeConnections"].as_u64() == Some(1)
            && snapshot["connectionWorkers"].as_u64() == Some(1)
    });
    let baseline_workers = baseline_resources["connectionWorkers"].as_u64().unwrap();
    thread::sleep(Duration::from_millis(250));
    let idle = process_metrics(host_pid).expect("idle Host process metrics must be observable");
    eprintln!(
        "Hmux idle accept: interval=250ms Host CPU delta={}ms threads={} RSS={}KiB",
        idle.cpu_millis.saturating_sub(baseline.cpu_millis),
        idle.threads,
        idle.rss_kib,
    );
    let mut cumulative_rejections = 0_u64;
    let stalled = fill_pending_capacity(&primary, &address);
    let expected_saturated_workers = baseline_workers + MAX_PENDING_CONNECTIONS as u64;
    let saturated_resources = wait_for_resource_snapshot(&primary, |snapshot| {
        snapshot["peakPendingConnections"].as_u64() == Some(MAX_PENDING_CONNECTIONS as u64)
            && snapshot["peakConnectionWorkers"].as_u64() == Some(expected_saturated_workers)
    });
    let saturated_peak_workers = saturated_resources["peakConnectionWorkers"]
        .as_u64()
        .unwrap();

    for attempts in [1, 10, 100, 1_000] {
        let measurement = measure_rejection_burst(&address, host_pid, baseline, attempts);
        cumulative_rejections += attempts as u64;
        let resources = wait_for_resource_snapshot(&primary, |snapshot| {
            snapshot
                .get("rejectedPendingConnections")
                .and_then(Value::as_u64)
                .is_some_and(|count| count >= cumulative_rejections)
        });

        eprintln!(
            "Hmux connection admission {attempts}x: elapsed={:?} p95={:?} Host CPU={}ms processThreads={}/{} connectionWorkers={}/{} RSS={}KiB/{}KiB queued={} peakQueued={}",
            measurement.elapsed,
            measurement.p95,
            measurement.host_cpu_millis,
            measurement.peak_metrics.threads,
            baseline.threads,
            resources["connectionWorkers"],
            resources["peakConnectionWorkers"],
            measurement.peak_metrics.rss_kib,
            baseline.rss_kib,
            resources["queuedBytes"],
            resources["peakQueuedBytes"],
        );
        assert!(measurement.p95 < Duration::from_secs(2));
        assert!(measurement.host_cpu_millis <= MAX_BURST_HOST_CPU_MILLIS);
        assert_eq!(
            resources["connectionWorkers"].as_u64(),
            Some(expected_saturated_workers)
        );
        assert_eq!(
            resources["peakConnectionWorkers"].as_u64(),
            Some(saturated_peak_workers)
        );
        assert_eq!(
            resources["peakPendingConnections"].as_u64(),
            Some(MAX_PENDING_CONNECTIONS as u64)
        );
        assert!(measurement.peak_metrics.rss_kib <= baseline.rss_kib + 64 * 1024);
        assert!(resources["queuedBytes"].as_u64().unwrap_or_default() <= MAX_HOST_QUEUED_BYTES);
        assert!(resources["peakQueuedBytes"].as_u64().unwrap_or_default() <= MAX_HOST_QUEUED_BYTES);
    }
    let _controller = assert_controller_input_survives(controller);

    let (sibling, _created) = RuntimeFixture::create(state.path(), "admission-sibling");
    sibling
        .session
        .read_screen(None)
        .expect("a saturated Host must not block a sibling session Host");
    drop(stalled);
}

#[test]
fn active_observers_cannot_consume_the_priority_reserve() {
    let state = tempfile::tempdir().unwrap();
    let (fixture, mut created) = RuntimeFixture::create(state.path(), "active-admission");
    let controller = created.connect_controller().unwrap();
    let ordinary = (0..56)
        .map(|_| {
            fixture
                .session
                .connect(LocalAttachRole::Observer, None)
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_resource_limit(fixture.session.connect(LocalAttachRole::Observer, None));

    let priority = (0..7)
        .map(|_| {
            fixture
                .session
                .connect_with_options(
                    ConnectionOptions::new(LocalAttachRole::Observer, None)
                        .with_optional_capabilities(&[SESSION_RETIREMENT_CAPABILITY]),
                )
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_resource_limit(
        fixture.session.connect_with_options(
            ConnectionOptions::new(LocalAttachRole::Observer, None)
                .with_optional_capabilities(&[SESSION_RETIREMENT_CAPABILITY]),
        ),
    );

    let controller = assert_controller_input_survives(controller);
    drop(priority);
    drop(ordinary);
    drop(controller);
}

fn assert_resource_limit<T>(result: Result<T, ClientError>) {
    assert!(matches!(
        result,
        Err(ClientError::HostRefused {
            code: HostErrorCode::ResourceLimit,
            retry: RetryDirective::Reconnect,
            ..
        })
    ));
}

fn fill_pending_capacity(fixture: &RuntimeFixture, address: &str) -> Vec<UnixStream> {
    let mut stalled = Vec::with_capacity(MAX_PENDING_CONNECTIONS);
    for expected_pending in 1..=MAX_PENDING_CONNECTIONS {
        let mut stream = UnixStream::connect(address).unwrap();
        // Cross the Host's first-byte readiness boundary, then stop inside the
        // length prefix. A completely silent socket shares the Host's
        // three-second hello deadline with this fixture's diagnostic wait;
        // under full-gate load all sixteen could expire just before the
        // snapshot was observed, turning a reached peak into current=0.
        // This is the stalled *handshake* the test is meant to hold, and
        // dropping the streams below still releases every pending permit.
        stream.write_all(&[0]).unwrap();
        stalled.push(stream);
        // Admit one exact slot at a time instead of depending on the OS listen
        // backlog and sixteen diagnostic writes being scheduled as one burst.
        wait_for_resource_snapshot(fixture, |snapshot| {
            snapshot["pendingConnections"].as_u64() == Some(expected_pending as u64)
        });
    }
    stalled
}

fn measure_rejection_burst(
    address: &str,
    host_pid: u32,
    baseline: ProcessMetrics,
    attempts: usize,
) -> BurstMeasurement {
    let started_metrics = process_metrics(host_pid).unwrap_or(baseline);
    let next = Arc::new(AtomicUsize::new(0));
    let latencies = Arc::new(Mutex::new(Vec::with_capacity(attempts)));
    let sampling = Arc::new(AtomicBool::new(true));
    let peak = Arc::new(Mutex::new(baseline));
    let sample_flag = Arc::clone(&sampling);
    let sample_peak = Arc::clone(&peak);
    let sampler = thread::spawn(move || {
        while sample_flag.load(Ordering::Acquire) {
            if let Some(current) = process_metrics(host_pid) {
                let mut observed = sample_peak.lock().unwrap();
                observed.threads = observed.threads.max(current.threads);
                observed.rss_kib = observed.rss_kib.max(current.rss_kib);
                observed.cpu_millis = observed.cpu_millis.max(current.cpu_millis);
            }
            thread::sleep(Duration::from_millis(10));
        }
    });
    let started = Instant::now();
    let workers = attempts.min(MAX_BURST_WORKERS);
    let handles = (0..workers)
        .map(|_| {
            let address = address.to_string();
            let next = Arc::clone(&next);
            let latencies = Arc::clone(&latencies);
            thread::spawn(move || {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    if index >= attempts {
                        break;
                    }
                    let attempt_started = Instant::now();
                    assert_typed_resource_limit(&address);
                    latencies.lock().unwrap().push(attempt_started.elapsed());
                }
            })
        })
        .collect::<Vec<_>>();
    for handle in handles {
        handle.join().unwrap();
    }
    let elapsed = started.elapsed();
    if let Some(current) = process_metrics(host_pid) {
        let mut observed = peak.lock().unwrap();
        observed.threads = observed.threads.max(current.threads);
        observed.rss_kib = observed.rss_kib.max(current.rss_kib);
        observed.cpu_millis = observed.cpu_millis.max(current.cpu_millis);
    }
    sampling.store(false, Ordering::Release);
    sampler.join().unwrap();
    let mut latencies = Arc::try_unwrap(latencies).unwrap().into_inner().unwrap();
    latencies.sort_unstable();
    assert_eq!(latencies.len(), attempts);
    let p95_index = attempts.saturating_mul(95).div_ceil(100).saturating_sub(1);
    let p95 = latencies[p95_index];
    let peak_metrics = *peak.lock().unwrap();
    BurstMeasurement {
        elapsed,
        p95,
        peak_metrics,
        host_cpu_millis: peak_metrics
            .cpu_millis
            .saturating_sub(started_metrics.cpu_millis),
    }
}

fn assert_typed_resource_limit(address: &str) {
    let mut stream = UnixStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let frame = FrameCodec::new(FrameLimits::default())
        .read_from(&mut stream)
        .unwrap();
    let FrameBody::Error(error) = frame.body else {
        panic!("overloaded Host did not return a typed error");
    };
    assert_eq!(error.code, ErrorCode::ResourceLimit);
    assert_eq!(error.retry, RetryPosture::Reconnect);
}

fn assert_controller_input_survives(
    mut controller: LocalSessionController,
) -> LocalSessionController {
    let request_id = controller
        .mutation_handle()
        .send_input(b"admission-still-live\n".to_vec())
        .unwrap();
    let interrupt = controller.interrupt_handle().unwrap();
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    let reader = thread::spawn(move || {
        loop {
            match controller.read_event() {
                Ok(Some(ControllerEvent::InputReceipt(receipt)))
                    if receipt.request_id == request_id
                        && receipt.state == ControllerReceiptState::WrittenToPty =>
                {
                    let _ = result_tx.send(Ok(controller));
                    break;
                }
                Ok(Some(_)) => {}
                Ok(None) => {
                    let _ = result_tx.send(Err("controller disconnected"));
                    break;
                }
                Err(_) => {
                    let _ = result_tx.send(Err("controller read failed"));
                    break;
                }
            }
        }
    });
    match result_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(returned)) => {
            reader.join().unwrap();
            returned
        }
        outcome => {
            interrupt.interrupt();
            let _ = reader.join();
            panic!("existing controller input failed under overload: {outcome:?}");
        }
    }
}

fn wait_for_resource_snapshot(
    fixture: &RuntimeFixture,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = Instant::now() + RESOURCE_SNAPSHOT_TIMEOUT;
    let mut latest = None;
    loop {
        if let Some(snapshot) = latest_resource_snapshot(fixture) {
            if predicate(&snapshot) {
                return snapshot;
            }
            latest = Some(snapshot);
        }
        assert!(
            Instant::now() < deadline,
            "Host resource diagnostics did not reach the expected state; latest={latest:?}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn latest_resource_snapshot(fixture: &RuntimeFixture) -> Option<Value> {
    let path = fixture
        .discovery_root
        .join(".diagnostics/runtime-v1/runtime.jsonl");
    let raw = fs::read_to_string(path).ok()?;
    raw.lines().rev().find_map(|line| {
        let value = serde_json::from_str::<Value>(line).ok()?;
        (value["session"]["sessionId"].as_str()
            == Some(fixture.session.descriptor().session_id.as_str())
            && value.get("pendingConnections").is_some())
        .then_some(value)
    })
}

fn process_metrics(process_id: u32) -> Option<ProcessMetrics> {
    let metrics = Command::new("ps")
        .args(["-o", "rss=", "-o", "time=", "-p", &process_id.to_string()])
        .output()
        .ok()?;
    let output = String::from_utf8(metrics.stdout).ok()?;
    let mut fields = output.split_whitespace();
    let rss_kib = fields.next()?.parse::<u64>().ok()?;
    let cpu_millis = parse_cpu_time_millis(fields.next()?)?;
    let threads = process_thread_count(process_id)?;
    Some(ProcessMetrics {
        threads,
        rss_kib,
        cpu_millis,
    })
}

fn parse_cpu_time_millis(value: &str) -> Option<u64> {
    let (days, clock) = match value.split_once('-') {
        Some((days, clock)) => (days.parse::<u64>().ok()?, clock),
        None => (0, value),
    };
    let fields = clock.split(':').collect::<Vec<_>>();
    let (hours, minutes, seconds) = match fields.as_slice() {
        [minutes, seconds] => (0, minutes.parse::<u64>().ok()?, *seconds),
        [hours, minutes, seconds] => (
            hours.parse::<u64>().ok()?,
            minutes.parse::<u64>().ok()?,
            *seconds,
        ),
        _ => return None,
    };
    let (whole_seconds, fractional) = seconds.split_once('.').unwrap_or((seconds, ""));
    let whole_seconds = whole_seconds.parse::<u64>().ok()?;
    let mut millis = fractional.chars().take(3).collect::<String>();
    while millis.len() < 3 {
        millis.push('0');
    }
    let millis = if millis.is_empty() {
        0
    } else {
        millis.parse::<u64>().ok()?
    };
    Some(
        days.saturating_mul(24)
            .saturating_add(hours)
            .saturating_mul(60)
            .saturating_add(minutes)
            .saturating_mul(60)
            .saturating_add(whole_seconds)
            .saturating_mul(1_000)
            .saturating_add(millis),
    )
}

#[test]
fn parses_cross_platform_process_cpu_times() {
    assert_eq!(parse_cpu_time_millis("0:00.03"), Some(30));
    assert_eq!(parse_cpu_time_millis("01:02:03"), Some(3_723_000));
    assert_eq!(parse_cpu_time_millis("2-01:02:03.004"), Some(176_523_004));
}

#[cfg(target_os = "macos")]
fn process_thread_count(process_id: u32) -> Option<usize> {
    let output = Command::new("ps")
        .args(["-M", "-p", &process_id.to_string()])
        .output()
        .ok()?;
    let lines = String::from_utf8(output.stdout).ok()?.lines().count();
    lines.checked_sub(1)
}

#[cfg(target_os = "linux")]
fn process_thread_count(process_id: u32) -> Option<usize> {
    fs::read_dir(format!("/proc/{process_id}/task"))
        .ok()
        .map(Iterator::count)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_thread_count(_process_id: u32) -> Option<usize> {
    None
}
