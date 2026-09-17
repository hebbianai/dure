#![cfg(unix)]

//! What does a frame actually cost to finish, once its first byte has arrived?
//!
//! `hmux-client`'s `FRAME_COMPLETION_TIMEOUT` bounds exactly that, and firing it
//! poisons the connection — so the constant has to sit above every legitimate
//! completion, and every millisecond above that is a millisecond a stalled phone
//! spends looking alive. It shipped as an admitted guess
//! (`hmux-transport-attestation.md`: "It is a guess and should be replaced by a
//! measurement").
//!
//! This is that measurement. It drives the real `hmux-runtime` binary over a real
//! Unix socket and times the completion window of the largest frames the protocol
//! can produce: `max_snapshot_bytes` (700 KiB) of scrollback repaint, which JSON
//! and base64 expand toward the 1 MiB `max_frame_bytes` ceiling. The timing wrapper
//! sits exactly where the production one does — `wait_readable` first, then a timed
//! `read_payload` — so what it reports is the same interval the constant governs.
//!
//! Why not `pnpm test:hmux-scrollback`, which the design note names? That harness
//! drives the desktop app under a machine-global exclusive-OS-focus lock and skips
//! unless a human explicitly opts in and the desktop has been idle. It cannot run
//! unattended, and stealing focus from whoever is at the keyboard is not a
//! measurement technique. What it adds over this test is the render-side consumer:
//! a webview that stalls stops draining the socket, the Host's write blocks
//! mid-frame, and the client sees a long completion. So `slow_consumer` below
//! models that directly, by making the client's own reads slow while the same
//! 700 KiB frames are in flight.

use hmux_client::transport::{
    AttachedTransport, FrameCodec, FrameReader, FrameWriter, PayloadOutcome, TransportError,
    TransportInterrupt,
};
use hmux_client::{
    ClientError, ConnectionOptions, LocalAttachRole, LocalConnection, LocalSessionCatalog,
    StandaloneCreateRequest, StandaloneSessionCreator,
};
use hmux_host::local_discovery::{DiscoveryManifest, DiscoveryRoot};
use hmux_host::local_protocol::{
    FrameBody, FrameLimits, ScreenSnapshotProfile, ScreenSnapshotRequest, SessionFence,
};
use hmux_local_platform::transport::fd::{FdFrameReader, FdFrameWriter, SocketInterrupt};
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Rows of history the provider emits before going idle, and how wide the
/// terminal is. Both are pushed past what the Host will keep: scrollback holds
/// 4096 rows, so a wide terminal filled to that depth overruns
/// `max_snapshot_bytes` and every `Full` snapshot is a maximum-size frame rather
/// than whatever happens to be on screen.
const HISTORY_ROWS: usize = 4200;
const HISTORY_COLUMNS: u16 = 400;

/// How many maximum-size frames each measurement samples.
const SAMPLES: usize = 24;

/// Times its own `read_payload`, which is precisely the window
/// `FRAME_COMPLETION_TIMEOUT` bounds: the caller has already returned from
/// `wait_readable`, so the first byte is there and everything measured here is
/// the frame finishing.
struct TimedReader {
    inner: FdFrameReader<UnixStream>,
    samples: Arc<Mutex<Vec<(Duration, usize)>>>,
    /// Sleep injected between the first byte and the rest of the read, modelling
    /// a consumer that stopped draining the socket mid-frame.
    stall: Duration,
}

impl FrameReader for TimedReader {
    fn wait_readable(&mut self, timeout: Option<Duration>) -> Result<(), TransportError> {
        self.inner.wait_readable(timeout)
    }

    fn read_payload(&mut self, codec: &FrameCodec) -> Result<PayloadOutcome, TransportError> {
        let started = Instant::now();
        if !self.stall.is_zero() {
            std::thread::sleep(self.stall);
        }
        let outcome = self.inner.read_payload(codec)?;
        let elapsed = started.elapsed();
        if let Some(payload) = &outcome {
            if codec
                .decode_payload_for_dispatch(payload)
                .is_ok_and(|decoded| matches!(decoded.frame().body, FrameBody::ScreenSnapshot(_)))
            {
                // Account for the shared length prefix after `elapsed` is
                // sampled so inspection cannot contaminate the measurement.
                self.samples
                    .lock()
                    .unwrap()
                    .push((elapsed, payload.len().saturating_add(4)));
            }
        }
        Ok(outcome)
    }

    fn set_completion_timeout(&mut self, timeout: Option<Duration>) {
        self.inner.set_completion_timeout(timeout);
    }
}

struct Measurement {
    samples: Vec<(Duration, usize)>,
}

fn is_retry_safe_readiness_timeout(error: &ClientError) -> bool {
    matches!(
        error,
        ClientError::Io {
            operation: "wait for Hmux frame",
            source,
        } if source.kind() == std::io::ErrorKind::TimedOut
    )
}

impl Measurement {
    fn max(&self) -> Duration {
        self.samples
            .iter()
            .map(|(elapsed, _)| *elapsed)
            .max()
            .unwrap_or_default()
    }

    fn median(&self) -> Duration {
        let mut sorted = self
            .samples
            .iter()
            .map(|(elapsed, _)| *elapsed)
            .collect::<Vec<_>>();
        sorted.sort_unstable();
        sorted[sorted.len() / 2]
    }

    fn largest_frame_bytes(&self) -> usize {
        self.samples
            .iter()
            .map(|(_, bytes)| *bytes)
            .max()
            .unwrap_or_default()
    }

    fn report(&self, label: &str) {
        println!(
            "{label}: n={} largest_frame={} bytes median={:?} max={:?}",
            self.samples.len(),
            self.largest_frame_bytes(),
            self.median(),
            self.max(),
        );
    }
}

fn measure(stall: Duration) -> Measurement {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let request = StandaloneCreateRequest::new(
        std::env::current_dir().unwrap().canonicalize().unwrap(),
        Some("frame-completion-budget".into()),
        vec![
            "/bin/sh".into(),
            "-c".into(),
            format!(
                "row=$(printf 'x%.0s' $(seq 1 {})); i=0; \
                 while [ $i -lt {HISTORY_ROWS} ]; do printf '%04d %s\\n' $i \"$row\"; i=$((i+1)); done; \
                 printf 'history-ready\\n'; while IFS= read -r _; do :; done",
                HISTORY_COLUMNS - 6
            ),
        ],
        24,
        HISTORY_COLUMNS,
    )
    .unwrap();
    let created = creator.create(request).unwrap();
    let session = created.session().clone();
    let catalog = LocalSessionCatalog::new(discovery_root.clone());
    let descriptor = session.descriptor().clone();

    // Wait for the provider to finish writing history, so every sampled snapshot
    // is a full one rather than a partially-filled screen.
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut readiness_timeouts = 0;
    loop {
        assert!(
            Instant::now() < deadline,
            "provider never filled scrollback after {readiness_timeouts} retry-safe attach timeouts"
        );
        match session.read_screen(None) {
            Ok(snapshot)
                if snapshot
                    .repaint_bytes
                    .windows(b"history-ready".len())
                    .any(|window| window == b"history-ready") =>
            {
                break;
            }
            Ok(_) => {}
            Err(error) if is_retry_safe_readiness_timeout(&error) => {
                // This setup poll is outside the interval the test measures.
                // A first-byte timeout consumes no frame bytes, so reconnecting
                // is safe; completion/protocol failures still fail immediately.
                readiness_timeouts += 1;
            }
            Err(error) => panic!("scrollback readiness probe failed: {error}"),
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if readiness_timeouts > 0 {
        eprintln!(
            "scrollback readiness recovered after {readiness_timeouts} retry-safe attach timeouts"
        );
    }

    let (address, token, fence) = ready_endpoint(&discovery_root, &descriptor);
    let samples = Arc::new(Mutex::new(Vec::new()));
    let mut connection =
        attach_with_timed_reader(&address, token, fence, Arc::clone(&samples), stall);

    for index in 0..SAMPLES {
        connection
            .writer()
            .send(FrameBody::ScreenSnapshotRequest(ScreenSnapshotRequest {
                request_id: format!("snapshot-{index}"),
                expected_fence: connection.hello_ack().actual_fence.clone(),
                profile: Some(ScreenSnapshotProfile::Full),
            }))
            .unwrap();
        loop {
            match connection.read_body().unwrap() {
                FrameBody::ScreenSnapshot(_) => break,
                FrameBody::Exit(exit) => panic!("provider exited mid-measurement: {}", exit.reason),
                _ => {}
            }
        }
    }
    drop(connection);
    let _ = session.terminate_standalone(&catalog, Duration::from_secs(3));

    let samples = samples.lock().unwrap().clone();
    assert!(
        samples.len() >= SAMPLES,
        "measurement collected {} samples, expected at least {SAMPLES}",
        samples.len()
    );
    assert!(
        samples
            .iter()
            .any(|(_, bytes)| *bytes > FrameLimits::default().max_snapshot_bytes / 2),
        "no sampled frame was large enough to be worth timing; largest was {} bytes",
        samples.iter().map(|(_, bytes)| *bytes).max().unwrap_or(0)
    );
    Measurement { samples }
}

fn ready_endpoint(
    discovery_root: &std::path::Path,
    descriptor: &hmux_client::SessionDescriptor,
) -> (String, String, SessionFence) {
    let root = DiscoveryRoot::open(discovery_root).unwrap();
    let found = root
        .find_manifest_by_session(&descriptor.workspace_id, &descriptor.session_id)
        .unwrap();
    let DiscoveryManifest::Ready(ready) = found.manifest else {
        panic!("measurement needs a ready Host");
    };
    let fence = SessionFence {
        workspace_id: ready.common.lifetime.workspace_id.clone(),
        session_id: ready.common.lifetime.session_id.clone(),
        runner_principal: ready.common.lifetime.runner_principal.clone(),
        runner_instance: ready.common.lifetime.runner_instance.clone(),
        channel_epoch: ready.common.lifetime.channel_epoch,
        host_instance_id: ready.common.host_instance_id.clone(),
        terminal_epoch: ready.terminal_epoch.clone(),
    };
    (
        ready.endpoint.address.clone(),
        ready.capability_token,
        fence,
    )
}

/// Attaches over a socket this test dialled itself, so the reader can be wrapped.
///
/// The transport is declared relayed rather than colocated because the seam
/// offers no other way in — the colocated constructor is crate-private on
/// purpose. Nothing measured here depends on that: the bytes still cross a real
/// Unix socket to a real Host, and only the attestation differs, which no
/// capability requested below rests on.
fn attach_with_timed_reader(
    address: &str,
    token: String,
    fence: SessionFence,
    samples: Arc<Mutex<Vec<(Duration, usize)>>>,
    stall: Duration,
) -> LocalConnection {
    let stream = UnixStream::connect(address).unwrap();
    let writer_half = stream.try_clone().unwrap();
    let interrupt_half = stream.try_clone().unwrap();
    let reader = TimedReader {
        inner: FdFrameReader::new(stream),
        samples,
        stall,
    };
    let transport = AttachedTransport::relayed(
        Box::new(reader) as Box<dyn FrameReader>,
        Box::new(FdFrameWriter::new(writer_half)) as Box<dyn FrameWriter>,
        Arc::new(SocketInterrupt::new(interrupt_half)) as Arc<dyn TransportInterrupt>,
    );
    LocalConnection::attach_over_transport(
        transport,
        fence,
        token,
        ConnectionOptions::new(LocalAttachRole::Observer, None).with_optional_capabilities(&[
            "ordered_snapshot_refresh_v1",
            "screen_snapshot_profile_v1",
        ]),
    )
    .unwrap()
}

/// The measurement itself. Prints the distribution; run with `--nocapture`.
///
/// It also asserts the headroom the constant is chosen for. The assertion is
/// deliberately loose — two orders of magnitude — because it must not become a
/// flakiness source on a loaded CI box; what it catches is a regression that
/// moves frame completion into the same order of magnitude as the deadline,
/// which is the only condition under which the deadline could fire on a healthy
/// local socket and poison a connection that was fine.
#[test]
fn maximum_size_frames_complete_far_inside_the_poisoning_deadline() {
    let quiet = measure(Duration::ZERO);
    quiet.report("local socket, prompt consumer");

    let stalled = measure(Duration::from_millis(250));
    stalled.report("local socket, consumer stalled 250ms mid-frame");

    let budget = Duration::from_secs(2);
    assert!(
        quiet.max() < budget,
        "a maximum-size frame took {:?} to complete over a local socket; \
         FRAME_COMPLETION_TIMEOUT is set on the premise that this stays in the \
         low milliseconds",
        quiet.max()
    );
    assert!(
        stalled.max() < budget + Duration::from_millis(500),
        "a stalled consumer pushed frame completion to {:?}; the deadline's \
         headroom over the stall itself is what keeps it from poisoning a \
         connection that is merely slow",
        stalled.max()
    );
}

#[test]
fn readiness_retries_only_an_unconsumed_first_byte_timeout() {
    let first_byte_timeout = ClientError::Io {
        operation: "wait for Hmux frame",
        source: std::io::Error::new(std::io::ErrorKind::TimedOut, "fixture timeout"),
    };
    let other_io = ClientError::Io {
        operation: "read Hmux frame",
        source: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "fixture closed"),
    };
    let connect_timeout = ClientError::Io {
        operation: "connect to Hmux Host",
        source: std::io::Error::new(std::io::ErrorKind::TimedOut, "fixture timeout"),
    };
    let consumed_frame = ClientError::StreamDesynchronized {
        reason: "fixture consumed bytes",
    };

    assert!(is_retry_safe_readiness_timeout(&first_byte_timeout));
    assert!(!is_retry_safe_readiness_timeout(&other_io));
    assert!(!is_retry_safe_readiness_timeout(&connect_timeout));
    assert!(!is_retry_safe_readiness_timeout(&consumed_frame));
}
