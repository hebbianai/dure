#![cfg(unix)]

use hmux_client::{
    ConnectionOptions, LocalAttachRole, LocalConnection, LocalProcessGenerationStatus,
    LocalSession, LocalSessionCatalog, SessionProbeStatus, StandaloneCreateRequest,
    StandaloneSessionCreator, probe_local_process_generation, probe_local_session_exact,
};
use hmux_host::local_protocol::{
    FrameBody, STANDALONE_TERMINATION_CAPABILITY, StandaloneTerminate,
};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

const INPUT_BYTES: usize = 64 * 1024;
const OUTPUT_BYTES: usize = 256 * 1024;

struct Fixture {
    session: LocalSession,
    catalog: LocalSessionCatalog,
    termination: LocalConnection,
    state: tempfile::TempDir,
}

impl Fixture {
    fn create(provider: &str) -> Self {
        let mut state = tempfile::tempdir().unwrap();
        let guardian = std::env::var_os("DURE_HMUX_TEST_STATE_ROOT")
            .expect("run this fixture through scripts/run-hmux-tests.mjs");
        assert!(state.path().starts_with(guardian));
        // Preserve manifests until the outer guardian has observed and retired
        // every exact process generation, including a failed stop on RED.
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
            Some("duplex-backpressure".into()),
            vec![
                std::env::current_exe()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                "--ignored".into(),
                "--exact".into(),
                provider.into(),
                "--nocapture".into(),
            ],
            24,
            80,
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

    fn request_stop(&self) {
        self.termination
            .writer()
            .send(FrameBody::StandaloneTerminate(StandaloneTerminate {
                request_id: "duplex-fixture-cleanup".into(),
            }))
            .unwrap();
    }

    fn stop(&self) -> bool {
        self.request_stop();
        self.wait_stopped()
    }

    fn wait_stopped(&self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(8);
        for process in [
            &self.session.descriptor().provider_process,
            &self.session.descriptor().host_process,
        ] {
            while matches!(
                probe_local_process_generation(process).unwrap(),
                LocalProcessGenerationStatus::Live
            ) {
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        true
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Exact standalone termination owns cleanup even on the RED path. The
        // outer Hmux test guardian independently verifies the isolated root.
        let _ = self
            .termination
            .writer()
            .send(FrameBody::StandaloneTerminate(StandaloneTerminate {
                request_id: "duplex-fixture-drop".into(),
            }));
    }
}

fn wait_for_marker(path: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while !path.exists() {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

#[test]
fn duplex_backpressure_preserves_output_and_observer_liveness() {
    let fixture = Fixture::create("duplex_provider");
    assert!(wait_for_marker(
        &fixture.state.path().join("ready"),
        Duration::from_secs(3)
    ));
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    let session = fixture.session.clone();
    let writer = std::thread::spawn(move || {
        let outcome = session.send_input(vec![b'x'; INPUT_BYTES]);
        let _ = done_tx.send(outcome);
    });
    let completed = wait_for_marker(
        &fixture.state.path().join("complete"),
        Duration::from_secs(5),
    );
    let health = probe_local_session_exact(&fixture.catalog, fixture.session.descriptor());
    let written = done_rx.recv_timeout(Duration::from_millis(500)).ok();
    eprintln!(
        "duplex evidence: provider_completed={completed}, probe={health:?}, input={written:?}"
    );
    // Cleanup precedes assertions so a demonstrated deadlock leaves no Host,
    // provider, blocked writer, or discovery registration behind.
    let stopped = fixture.stop();
    if written.is_none() {
        let _ = done_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    }
    writer.join().unwrap();
    assert!(
        completed,
        "PTY output drainage stopped behind backpressured input"
    );
    assert_eq!(health, SessionProbeStatus::Healthy);
    assert!(written.is_some_and(|outcome| outcome.is_ok()));
    assert!(stopped, "isolated fixture did not stop");
}

#[test]
#[ignore = "provider process launched only by the isolated duplex fixture"]
fn duplex_provider() {
    prepare_provider();
    let mut input = std::io::stdin().lock();
    let mut first = [0];
    input.read_exact(&mut first).unwrap();
    // Fill stdout before draining stdin: a full-duplex PTY must continue
    // reading provider output while a large input remains partly unwritten.
    let chunk = [b'.'; 4096];
    let mut output = std::io::stdout().lock();
    for _ in 0..OUTPUT_BYTES / chunk.len() {
        output.write_all(&chunk).unwrap();
    }
    output.flush().unwrap();
    let mut remainder = vec![0; INPUT_BYTES - 1];
    input.read_exact(&mut remainder).unwrap();
    assert_eq!(first, [b'x']);
    assert!(remainder.iter().all(|byte| *byte == b'x'));
    fs::write("complete", b"exact duplex transfer").unwrap();
    // Remain alive for same-generation observation and explicit Host cleanup.
    let _ = input.read_exact(&mut first);
}

fn prepare_provider() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(15));
        std::process::exit(124);
    });
    // SAFETY: initialized termios storage and the provider's own live stdin
    // descriptor are used only in this separate fixture process.
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
    fs::write("ready", b"raw").unwrap();
}

#[test]
fn backpressured_input_does_not_block_exact_observation_or_termination() {
    let fixture = Fixture::create("non_reading_provider");
    assert!(wait_for_marker(
        &fixture.state.path().join("ready"),
        Duration::from_secs(3)
    ));
    let session = fixture.session.clone();
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    let writer = std::thread::spawn(move || {
        let _ = done_tx.send(session.send_input(vec![b'x'; INPUT_BYTES]));
    });
    assert!(wait_for_marker(
        &fixture.state.path().join("blocked"),
        Duration::from_secs(3)
    ));
    let health = probe_local_session_exact(&fixture.catalog, fixture.session.descriptor());
    let started = Instant::now();
    fixture.request_stop();
    let input = done_rx.recv_timeout(Duration::from_secs(2));
    let elapsed = started.elapsed();
    // Input cancellation must not wait for the separate process-census and
    // subscriber-drain cleanup phases of complete Host departure.
    let stopped = fixture.wait_stopped();
    writer.join().unwrap();
    assert_eq!(health, SessionProbeStatus::Healthy);
    assert!(
        stopped,
        "exact termination must cancel a backpressured frame"
    );
    let input = input.expect("termination did not unblock the input worker within two seconds");
    eprintln!("backpressured input cancelled after {elapsed:?}");
    assert!(!input.is_ok_and(
        |receipt| receipt.state == hmux_host::local_protocol::InputReceiptState::WrittenToPty
    ));
}

#[test]
#[ignore = "provider process launched only by the isolated blocked-input fixture"]
fn non_reading_provider() {
    prepare_provider();
    let mut first = [0];
    std::io::stdin().read_exact(&mut first).unwrap();
    assert_eq!(first, [b'x']);
    fs::write("blocked", b"input peer stopped reading").unwrap();
    loop {
        std::thread::park();
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_reply_backpressure_preserves_output_and_observer_liveness() {
    let fixture = Fixture::create("reply_provider");
    assert!(wait_for_marker(
        &fixture.state.path().join("ready"),
        Duration::from_secs(3)
    ));
    fixture.session.send_input(b"x".to_vec()).unwrap();
    let completed = wait_for_marker(
        &fixture.state.path().join("complete"),
        Duration::from_secs(5),
    );
    let health = probe_local_session_exact(&fixture.catalog, fixture.session.descriptor());
    eprintln!("reply evidence: provider_completed={completed}, probe={health:?}");
    let stopped = fixture.stop();
    assert!(
        completed,
        "terminal replies blocked subsequent PTY output drainage"
    );
    assert_eq!(health, SessionProbeStatus::Healthy);
    assert!(stopped, "isolated fixture did not stop");
}

#[test]
#[ignore = "provider process launched only by the isolated terminal-reply fixture"]
fn reply_provider() {
    prepare_provider();
    let mut input = std::io::stdin().lock();
    let mut first = [0];
    input.read_exact(&mut first).unwrap();
    const QUERIES: usize = 16 * 1024;
    let mut output = std::io::stdout().lock();
    output.write_all(&b"\x1b[5n".repeat(QUERIES)).unwrap();
    output.flush().unwrap();
    let expected = b"\x1b[0n".repeat(QUERIES);
    let mut replies = vec![0; expected.len()];
    input.read_exact(&mut replies).unwrap();
    assert_eq!(replies, expected);
    fs::write("complete", b"exact terminal replies").unwrap();
    let _ = input.read_exact(&mut first);
}
