#![cfg(all(unix, feature = "terminal-state-stream"))]

//! Opt-in, content-free cost evidence for the production exact-probe path.
//! The same isolated Host is sampled before and after deterministic history;
//! its geometry and provider state remain the same. Only a phase marker changes.

use hmux_client::{
    ConnectionOptions, LocalAttachRole, LocalConnection, LocalProcessGenerationStatus,
    LocalSession, LocalSessionCatalog, SessionProbeStatus, SessionSelector,
    StandaloneCreateRequest, StandaloneSessionCreator, TerminalSurfaceAccess,
    TerminalSurfaceAttachment, probe_local_process_generation, probe_local_session_exact,
};
use hmux_host::local_protocol::{
    FrameBody, ORDERED_SNAPSHOT_REFRESH_CAPABILITY, SCREEN_SNAPSHOT_PROFILE_CAPABILITY,
    STANDALONE_TERMINATION_CAPABILITY, ScreenSnapshotProfile, ScreenSnapshotRequest,
    StandaloneTerminate,
};
use serde_json::json;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HISTORY_ROWS: usize = 16_384;
const COLUMNS: u16 = 160;
const ROWS: u16 = 32;
const SAMPLES: usize = 24;
const INITIAL_READY: &str = "observation-fixture-ready-0";
const HISTORY_READY: &str = "observation-fixture-ready-1";

#[derive(Clone, Copy)]
enum AttachPath {
    ExactProbe,
    Surface,
}

struct Fixture {
    session: LocalSession,
    catalog: LocalSessionCatalog,
    termination: LocalConnection,
    state: tempfile::TempDir,
}

impl Fixture {
    fn create() -> Self {
        let mut state = tempfile::tempdir().unwrap();
        let guardian = std::env::var_os("DURE_HMUX_TEST_STATE_ROOT")
            .expect("run through scripts/run-hmux-tests.mjs");
        assert!(state.path().starts_with(guardian));
        // The guardian retains cleanup authority after either RED or GREEN.
        state.disable_cleanup(true);
        let home = state.path().join("home");
        fs::create_dir(&home).unwrap();
        let runtime = state.path().join("runtime");
        let quote =
            |value: &Path| format!("'{}'", value.display().to_string().replace('\'', "'\\''"));
        fs::write(
            &runtime,
            format!(
                "#!/bin/sh\nexport HOME={}\nexec {} \"$@\"\n",
                quote(&home),
                quote(Path::new(env!("CARGO_BIN_EXE_hmux-runtime"))),
            ),
        )
        .unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
        let root = state.path().join("discovery");
        let request = StandaloneCreateRequest::new(
            state.path().canonicalize().unwrap(),
            Some("observation-attach-cost".into()),
            vec![
                std::env::current_exe()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                "--ignored".into(),
                "--exact".into(),
                "history_provider".into(),
                "--nocapture".into(),
            ],
            ROWS,
            COLUMNS,
        )
        .unwrap();
        let created = StandaloneSessionCreator::new(runtime)
            .with_discovery_root(&root)
            .create(request)
            .unwrap();
        let termination = created
            .session()
            .connect_with_options(
                ConnectionOptions::new(LocalAttachRole::Observer, None)
                    .with_optional_capabilities(&[STANDALONE_TERMINATION_CAPABILITY]),
            )
            .unwrap();
        Self {
            session: created.session().clone(),
            catalog: LocalSessionCatalog::new(root),
            termination,
            state,
        }
    }

    fn surface(&self) -> TerminalSurfaceAttachment {
        let descriptor = self.session.descriptor();
        let session = self
            .catalog
            .open(&SessionSelector::new(
                descriptor.session_id.clone(),
                Some(descriptor.workspace_id.clone()),
            ))
            .unwrap();
        let connection = session
            .connect_with_options(TerminalSurfaceAttachment::connection_options(
                TerminalSurfaceAccess::ReadOnly,
                None,
            ))
            .unwrap();
        let surface = TerminalSurfaceAttachment::from_connection(connection).unwrap();
        let viewport = surface.current_frame().viewport();
        assert_eq!(
            (viewport.viewport_rows, viewport.canonical_columns),
            (u32::from(ROWS), u32::from(COLUMNS))
        );
        surface
    }

    fn wait_ready(&self, marker: &str, visible_marker: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !self.state.path().join(marker).exists() {
            assert!(
                Instant::now() < deadline,
                "provider did not finish {marker}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        // The provider file only proves its write. Read the Host viewport to
        // establish that PTY ingestion reached the final ready marker too.
        loop {
            let surface = self.surface();
            let text = surface.current_frame().text().to_owned();
            surface.detach_confirmed(Duration::from_secs(3)).unwrap();
            if text.contains(visible_marker) {
                return text;
            }
            assert!(Instant::now() < deadline, "Host did not ingest {marker}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn verify_full_hydration(&self) {
        let mut connection = self
            .session
            .connect_with_options(
                ConnectionOptions::new(LocalAttachRole::Observer, None)
                    .with_optional_capabilities(&[
                        SCREEN_SNAPSHOT_PROFILE_CAPABILITY,
                        ORDERED_SNAPSHOT_REFRESH_CAPABILITY,
                    ])
                    .with_initial_snapshot_profile(Some(ScreenSnapshotProfile::ViewportOnly)),
            )
            .unwrap();
        connection
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let viewport = connection.require_initial_snapshot().unwrap().clone();
        assert_eq!(
            viewport.actual_profile,
            Some(ScreenSnapshotProfile::ViewportOnly)
        );
        assert!(String::from_utf8_lossy(&viewport.repaint_bytes).contains(HISTORY_READY));
        let mut previous_full = None;
        for index in 0..2 {
            let request_id = format!("hydrate-{index}");
            connection
                .writer()
                .send(FrameBody::ScreenSnapshotRequest(ScreenSnapshotRequest {
                    request_id: request_id.clone(),
                    expected_fence: viewport.fence.clone(),
                    profile: Some(ScreenSnapshotProfile::Full),
                }))
                .unwrap();
            let full = loop {
                if let FrameBody::ScreenSnapshot(snapshot) = connection.read_body().unwrap() {
                    assert_eq!(
                        snapshot.in_reply_to_request_id.as_deref(),
                        Some(request_id.as_str())
                    );
                    break snapshot;
                }
            };
            assert_eq!(full.fence, viewport.fence);
            assert_eq!(full.sequence_through, viewport.sequence_through);
            assert_eq!(full.working_directory, viewport.working_directory);
            assert_eq!(full.actual_profile, None);
            assert!(full.repaint_bytes.len() > viewport.repaint_bytes.len() * 10);
            if let Some(previous) = previous_full.as_ref() {
                assert_eq!(&full.repaint_bytes, previous);
            }
            println!(
                "observation-profile-bytes: viewport={} full={} request={index}",
                viewport.repaint_bytes.len(),
                full.repaint_bytes.len()
            );
            previous_full = Some(full.repaint_bytes);
        }
        connection.detach("observation-profile-complete").unwrap();
    }

    fn process_resources(&self) -> (f64, f64, u64, u64) {
        let process = &self.session.descriptor().host_process;
        let assert_live = || {
            assert_eq!(
                probe_local_process_generation(process).unwrap(),
                LocalProcessGenerationStatus::Live,
            );
        };
        assert_live();
        // ps reports CPU seconds, avoiding raw Mach ticks being mislabeled as
        // nanoseconds. Two reads per series stay outside per-probe timings.
        let output = Command::new("/bin/ps")
            .args([
                "-p",
                &format!("{},{}", process.process_id, std::process::id()),
                "-o",
                "pid=,time=,rss=",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_live();
        let output = String::from_utf8(output.stdout).unwrap();
        let resources = |pid: u32| {
            output
                .lines()
                .find_map(|line| {
                    let mut fields = line.split_whitespace();
                    let found = fields.next()?.parse::<u32>().unwrap();
                    let value = fields.next()?;
                    let rss_kib = fields.next()?.parse::<u64>().unwrap();
                    (found == pid).then(|| {
                        (
                            value.split(':').fold(0.0, |seconds, part| {
                                seconds * 60.0 + part.parse::<f64>().unwrap()
                            }),
                            rss_kib,
                        )
                    })
                })
                .expect("exact generation must appear in the CPU sample")
        };
        let host = resources(process.process_id);
        let observer = resources(std::process::id());
        (host.0, observer.0, host.1, observer.1)
    }

    fn measure(&self, path: AttachPath, detailed: bool) -> serde_json::Value {
        let cpu_before = self.process_resources();
        let mut samples = Vec::with_capacity(if detailed { SAMPLES } else { 0 });
        let mut healthy = 0;
        let started = Instant::now();
        for _ in 0..SAMPLES {
            let sample_start = detailed.then(Instant::now);
            let succeeded = match path {
                AttachPath::ExactProbe => {
                    probe_local_session_exact(&self.catalog, self.session.descriptor())
                        == SessionProbeStatus::Healthy
                }
                AttachPath::Surface => self
                    .surface()
                    .detach_confirmed(Duration::from_secs(3))
                    .is_ok(),
            };
            if succeeded {
                healthy += 1;
            }
            if let Some(sample_start) = sample_start {
                samples.push(sample_start.elapsed().as_secs_f64() * 1_000.0);
            }
        }
        let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
        let cpu_after = self.process_resources();
        samples.sort_by(f64::total_cmp);
        json!({
            "samples": SAMPLES,
            "healthy": healthy,
            "detailedTiming": detailed,
            "wallMs": elapsed_ms,
            "hostCpuSeconds": cpu_after.0 - cpu_before.0,
            "observerCpuSeconds": cpu_after.1 - cpu_before.1,
            "cpuResolutionSeconds": 0.01,
            "hostRssBeforeKiB": cpu_before.2,
            "hostRssAfterKiB": cpu_after.2,
            "observerRssBeforeKiB": cpu_before.3,
            "observerRssAfterKiB": cpu_after.3,
            "rssObservation": "series endpoints, not peak allocation or physical footprint",
            "medianMs": samples.get(samples.len() / 2),
            "p95Ms": samples.get((samples.len() * 95).div_ceil(100).saturating_sub(1)),
            "maxMs": samples.last(),
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self
            .termination
            .writer()
            .send(FrameBody::StandaloneTerminate(StandaloneTerminate {
                request_id: "observation-fixture-cleanup".into(),
            }));
    }
}

#[test]
#[ignore = "bounded native performance experiment; no live sessions or windows"]
fn exact_probe_cost_does_not_reconstruct_full_history() {
    let fixture = Fixture::create();
    let initial_viewport = fixture.wait_ready("initial-ready", INITIAL_READY);
    let short_off = fixture.measure(AttachPath::ExactProbe, false);
    let short_on = fixture.measure(AttachPath::ExactProbe, true);
    let surface_short_off = fixture.measure(AttachPath::Surface, false);
    let surface_short_on = fixture.measure(AttachPath::Surface, true);

    fixture.session.send_input(b"h".to_vec()).unwrap();
    let retained_viewport = fixture.wait_ready("history-ready", HISTORY_READY);
    // Compare the same active grid independently of retained history.
    assert!(
        retained_viewport.replace(HISTORY_READY, INITIAL_READY) == initial_viewport,
        "the visible grid must remain equal apart from its phase marker"
    );
    let surface_long_on = fixture.measure(AttachPath::Surface, true);
    let surface_long_off = fixture.measure(AttachPath::Surface, false);
    let long_on = fixture.measure(AttachPath::ExactProbe, true);
    let long_off = fixture.measure(AttachPath::ExactProbe, false);
    let receipt = json!({
        "schemaVersion": 1,
        "capturedAtMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis(),
        "geometry": {"rows": ROWS, "columns": COLUMNS},
        "historyRowsEmitted": HISTORY_ROWS,
        "historyBytesEmitted": HISTORY_ROWS * (usize::from(COLUMNS) - 1 + 2),
        "viewportTextBytes": retained_viewport.len(),
        "hostPid": fixture.session.descriptor().host_process.process_id,
        "hostBuild": fixture.session.descriptor().host_build_version,
        "nativeWindows": 0,
        "userPanes": 0,
        "conditions": "same isolated Host; fixed provider; warm serial probes; no DevTools or profiler",
        "shortOff": short_off,
        "shortOn": short_on,
        "longOn": long_on,
        "longOff": long_off,
        "surfaceShortOff": surface_short_off,
        "surfaceShortOn": surface_short_on,
        "surfaceLongOn": surface_long_on,
        "surfaceLongOff": surface_long_off,
    });
    println!("observation-attach-cost: {receipt}");
    for series in [
        &short_off,
        &short_on,
        &long_on,
        &long_off,
        &surface_short_off,
        &surface_short_on,
        &surface_long_on,
        &surface_long_off,
    ] {
        assert_eq!(series["healthy"], SAMPLES, "exact probes must stay healthy");
    }
    let short_probe = short_on["medianMs"].as_f64().unwrap();
    let long_probe = long_on["medianMs"].as_f64().unwrap();
    assert!(
        long_probe <= short_probe * 4.0 + 2.0,
        "unchanged viewport acquired a history-scaled probe cost: short={short_probe:.3}ms long={long_probe:.3}ms",
    );
    let short_median = surface_short_on["medianMs"].as_f64().unwrap();
    let long_median = surface_long_on["medianMs"].as_f64().unwrap();
    assert!(
        long_median <= short_median * 2.0 + 2.0,
        "unchanged viewport acquired a history-scaled attach cost: short={short_median:.3}ms long={long_median:.3}ms",
    );
    fixture.verify_full_hydration();
}

#[test]
#[ignore = "provider child for the isolated observation fixture only"]
fn history_provider() {
    // SAFETY: this separate fixture owns its valid PTY stdin and initialized
    // termios storage. No application or user pane is involved.
    let mut attributes = unsafe { std::mem::zeroed::<libc::termios>() };
    assert_eq!(
        unsafe { libc::tcgetattr(libc::STDIN_FILENO, &mut attributes) },
        0
    );
    unsafe { libc::cfmakeraw(&mut attributes) };
    assert_eq!(
        unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &attributes) },
        0
    );
    let ready = |marker: &str| {
        let mut output = std::io::stdout().lock();
        output.write_all(b"\x1b[2J\x1b[H").unwrap();
        output.write_all(marker.as_bytes()).unwrap();
        output.flush().unwrap();
    };
    ready(INITIAL_READY);
    fs::write("initial-ready", b"ready").unwrap();
    let mut command = [0];
    std::io::stdin().read_exact(&mut command).unwrap();
    assert_eq!(command, [b'h']);
    let mut row = vec![b'x'; usize::from(COLUMNS) - 1];
    row.extend_from_slice(b"\r\n");
    let mut output = std::io::stdout().lock();
    for _ in 0..HISTORY_ROWS {
        output.write_all(&row).unwrap();
    }
    output.flush().unwrap();
    drop(output);
    ready(HISTORY_READY);
    fs::write("history-ready", b"ready").unwrap();
    let _ = std::io::stdin().read_exact(&mut command);
}
