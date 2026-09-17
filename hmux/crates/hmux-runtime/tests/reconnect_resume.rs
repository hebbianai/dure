#![cfg(unix)]

//! Reattach against the real Host binary, over a real Unix socket, with a real
//! PTY behind it.
//!
//! The unit tests on either side script their peer. These do not: they run the
//! shipped `hmux-runtime`, so the capability negotiation, the frame ordering and
//! the retention window are the Host's own rather than a fixture's. That matters
//! because the failure this feature exists to prevent — a client that believes
//! it resumed while the Host sent a snapshot, or the reverse — is precisely a
//! disagreement between the two sides, and no test that writes both halves can
//! observe it.

use hmux_client::{
    AttachReplay, ClientError, ConnectionOptions, LocalAttachRole, LocalConnection, LocalSession,
    LocalSessionCatalog, StandaloneCreateRequest, StandaloneSessionCreator,
};
use hmux_host::local_protocol::{FrameBody, Input, ReconnectCursor};
use std::time::{Duration, Instant};

/// How long a drained read waits for a frame that is already on its way.
const DRAIN_QUIET: Duration = Duration::from_millis(200);

/// A live session whose provider echoes what a writer types, so a test produces
/// output on demand rather than racing a timer.
struct Fixture {
    _state: tempfile::TempDir,
    catalog: LocalSessionCatalog,
    session: LocalSession,
}

impl Fixture {
    fn start(provider_script: &str) -> Self {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .with_discovery_root(&discovery_root);
        let request = StandaloneCreateRequest::new(
            std::env::current_dir().unwrap().canonicalize().unwrap(),
            Some("reconnect-resume".into()),
            vec!["/bin/sh".into(), "-c".into(), provider_script.into()],
            24,
            80,
        )
        .unwrap();
        let created = creator.create(request).unwrap();
        let session = created.session().clone();
        Self {
            _state: state,
            catalog: LocalSessionCatalog::new(discovery_root),
            session,
        }
    }

    /// A provider that echoes each line back with an `echo:` marker.
    fn echoing() -> Self {
        Self::start("while IFS= read -r line; do printf 'echo:%s\\n' \"$line\"; done")
    }

    fn attach(&self, cursor: Option<ReconnectCursor>) -> LocalConnection {
        self.session
            .connect_with_options(
                ConnectionOptions::new(LocalAttachRole::SharedWriter, None)
                    .with_reconnect_cursor(cursor),
            )
            .unwrap()
    }

    fn terminate(self) {
        let _ = self
            .session
            .terminate_standalone(&self.catalog, Duration::from_secs(3));
    }
}

/// Reads everything already queued for this connection and stops at the first
/// quiet period, so a test can say "what did this client have when it dropped".
///
/// The position it leaves behind is read back from
/// [`LocalConnection::reconnect_cursor`], which is the API a real caller uses —
/// so a bug in that derivation fails these tests rather than hiding behind test
/// bookkeeping.
fn drain(connection: &mut LocalConnection) -> Vec<u8> {
    let mut bytes = Vec::new();
    connection.set_read_timeout(Some(DRAIN_QUIET)).unwrap();
    while let Ok(body) = connection.read_body() {
        match body {
            FrameBody::OutputDelta(delta) => bytes.extend_from_slice(&delta.bytes),
            FrameBody::Exit(exit) => panic!("provider exited during drain: {}", exit.reason),
            _ => {}
        }
    }
    bytes
}

/// Types `line` and waits until this connection has observed the echo.
fn drive_output(connection: &mut LocalConnection, line: &str) {
    let marker = format!("echo:{line}");
    connection
        .writer()
        .send(FrameBody::Input(Input {
            request_id: format!("input-{line}"),
            controller_generation: connection.hello_ack().controller_generation,
            bytes: format!("{line}\n").into_bytes(),
        }))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut seen = Vec::new();
    connection.set_read_timeout(None).unwrap();
    loop {
        assert!(
            Instant::now() < deadline,
            "provider never echoed {marker:?}; saw {:?}",
            String::from_utf8_lossy(&seen)
        );
        match connection.read_body().unwrap() {
            FrameBody::OutputDelta(delta) => {
                seen.extend_from_slice(&delta.bytes);
                if contains(&seen, marker.as_bytes()) {
                    return;
                }
            }
            FrameBody::Exit(exit) => panic!("provider exited early: {}", exit.reason),
            _ => {}
        }
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// The end-to-end claim: a reattach that offers a cursor gets the bytes it
/// missed and *not* the screen it already has.
///
/// Two assertions carry it. The connection reports `Resumed`, and
/// `initial_snapshot()` is `None` — against a real Host, on a session whose
/// screen is non-empty, so a snapshot was genuinely available and genuinely not
/// sent. The third assertion is the one that makes "resumed" mean something:
/// the away-time output arrives and the pre-drop output does not.
#[test]
fn a_reattach_with_a_cursor_resumes_from_the_real_host_without_a_snapshot() {
    let fixture = Fixture::echoing();

    let mut first = fixture.attach(None);
    assert!(
        matches!(first.attach_replay(), AttachReplay::Snapshot),
        "a cold attach still downloads the screen"
    );
    drive_output(&mut first, "before-drop");
    drain(&mut first);
    let cursor = first.reconnect_cursor();
    drop(first);

    // Output the dropped client never saw.
    let mut producer = fixture.attach(None);
    drive_output(&mut producer, "while-away");
    drop(producer);

    let mut resumed = fixture.attach(Some(cursor.clone()));

    match resumed.attach_replay() {
        AttachReplay::Resumed {
            after_output_seq,
            through_output_seq,
        } => {
            assert_eq!(*after_output_seq, cursor.after_output_seq);
            assert!(
                *through_output_seq > *after_output_seq,
                "the away-time output must have been replayed, not skipped"
            );
        }
        other => panic!("the Host refused to resume a cursor inside its window: {other:?}"),
    }
    assert!(
        resumed.initial_snapshot().is_none(),
        "resuming must not redownload the screen"
    );

    let replayed = drain(&mut resumed);
    assert!(
        contains(&replayed, b"echo:while-away"),
        "resume delivered no away-time output: {:?}",
        String::from_utf8_lossy(&replayed)
    );
    assert!(
        !contains(&replayed, b"echo:before-drop"),
        "resume re-sent output the client already had"
    );

    drop(resumed);
    fixture.terminate();
}

/// A cursor the Host has retired must fall back **and say so**.
///
/// The provider dumps more than `max_retained_bytes` on demand, which is the
/// only way to make the real Host retire a real cursor. The assertion that
/// matters is not that a snapshot arrived — one arrives on every cold attach —
/// but that the connection reports `SnapshotAfterGap`. A caller that cannot tell
/// the two apart presents output it never received as continuous history, which
/// the user reads as the agent having done something it did not do.
#[test]
fn a_cursor_the_host_retired_falls_back_to_a_snapshot_that_reports_the_gap() {
    // 6 MiB of printable output, past the 4 MiB delta-retention budget, emitted
    // once on the first line the provider reads and then idle.
    let fixture = Fixture::start(
        "IFS= read -r _; head -c 6291456 /dev/zero | tr '\\0' 'x'; printf '\\nflood-done\\n'; \
         while IFS= read -r line; do printf 'echo:%s\\n' \"$line\"; done",
    );

    let mut first = fixture.attach(None);
    drain(&mut first);
    let cursor = first.reconnect_cursor();
    drop(first);

    let mut producer = fixture.attach(None);
    producer
        .writer()
        .send(FrameBody::Input(Input {
            request_id: "flood".into(),
            controller_generation: producer.hello_ack().controller_generation,
            bytes: b"flood\n".to_vec(),
        }))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    producer.set_read_timeout(None).unwrap();
    loop {
        assert!(
            Instant::now() < deadline,
            "provider never finished flooding"
        );
        match producer.read_body().unwrap() {
            FrameBody::OutputDelta(delta) if contains(&delta.bytes, b"flood-done") => break,
            FrameBody::Exit(exit) => panic!("provider exited during flood: {}", exit.reason),
            _ => {}
        }
    }
    drain(&mut producer);
    let flooded_through = producer.reconnect_cursor().after_output_seq;
    drop(producer);

    let resumed = fixture.attach(Some(cursor.clone()));

    match resumed.attach_replay() {
        AttachReplay::SnapshotAfterGap(gap) => {
            assert_eq!(gap.cursor.after_output_seq, cursor.after_output_seq);
            assert!(
                gap.earliest_retained_output_seq > cursor.after_output_seq + 1,
                "a reported gap must actually name output the Host no longer holds"
            );
            assert!(gap.current_output_seq >= flooded_through);
        }
        other => panic!(
            "a retired cursor was not reported as a gap, it was reported as {other:?}; \
             the client would have presented the missing output as continuous history"
        ),
    }
    assert!(
        resumed.initial_snapshot().is_some(),
        "the fallback still has to deliver the recovery snapshot"
    );

    drop(resumed);
    fixture.terminate();
}

/// A cursor past the Host's own position must be refused at attach, not
/// resumed.
///
/// This looks like the harmless case — the Host has no later output, so
/// "resume with nothing" reads as obviously right, and an earlier version of
/// this client did exactly that. It is the dangerous one. The Host's
/// `replay_after` refuses a cursor ahead of it by construction and falls back
/// to sending a full snapshot; a client that believed it had resumed never
/// reads that snapshot, the reducer discards it as stale, and the FIRST live
/// delta fails as non-contiguous. The break lands one byte of output later, in
/// a terminal, where a gap reads as the agent having done something it did not.
///
/// So the assertion is that attaching FAILS. A test that only checked "we did
/// not crash" passed throughout the bug.
#[test]
fn a_cursor_ahead_of_the_host_is_refused_at_attach_rather_than_breaking_later() {
    let fixture = Fixture::echoing();
    let mut first = fixture.attach(None);
    drive_output(&mut first, "before-drop");
    drain(&mut first);
    let cursor = first.reconnect_cursor();
    drop(first);

    let ahead = ReconnectCursor {
        after_output_seq: cursor.after_output_seq + 1,
        ..cursor.clone()
    };
    let error = fixture
        .session
        .connect_with_options(
            ConnectionOptions::new(LocalAttachRole::SharedWriter, None)
                .with_reconnect_cursor(Some(ahead)),
        )
        .expect_err("a cursor ahead of the Host must not produce a usable attach");

    assert!(
        matches!(
            &error,
            ClientError::InconsistentStream { reason }
                if reason.contains("ahead of the Host")
        ),
        "expected the attach to be refused for a cursor ahead of the Host, got {error:?}"
    );

    // The honest cursor still works, so the refusal is about being ahead and
    // not about the session having become unattachable.
    let resumed = fixture.attach(Some(cursor));
    drop(resumed);
    fixture.terminate();
}
