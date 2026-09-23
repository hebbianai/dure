use super::*;
use hmux_session_protocol::transport::memory::MemoryEndpoint;
use hmux_session_protocol::transport::{FrameOutcome, PayloadOutcome, TransportError};
use hmux_session_protocol::{
    AuthorizationPosture, Exit, LifecycleState, OutputDelta, ProcessProof, ReconnectCursor,
    ReplayGap, RuntimeContext,
};
#[cfg(unix)]
use tempfile::TempDir;

mod colocation;
mod exited_attach;
use colocation::colocated_for;

fn fence() -> SessionFence {
    SessionFence {
        workspace_id: "workspace".into(),
        session_id: "session".into(),
        runner_principal: "runner".into(),
        runner_instance: "runner-1".into(),
        channel_epoch: 1,
        host_instance_id: "host-1".into(),
        terminal_epoch: "terminal-1".into(),
    }
}

fn hello_ack(capabilities: &[&str]) -> HelloAck {
    HelloAck {
        selected_version: PROTOCOL_V1,
        selected_capabilities: capabilities
            .iter()
            .map(|capability| (*capability).to_string())
            .collect(),
        actual_fence: fence(),
        host_build_version: "test".into(),
        lifecycle: LifecycleState::Observing,
        host_process: ProcessProof {
            process_id: 10,
            start_marker: "host-start".into(),
        },
        provider_process: None,
        earliest_retained_output_seq: 1,
        current_output_seq: 1,
        controller_generation: 1,
        authorization_posture: AuthorizationPosture::StandaloneLocalOwner,
    }
}

#[test]
fn local_attach_rejects_manifest_process_proof_splicing() {
    let ack = hello_ack(&["screen_snapshot", "live_output"]);
    let expected = ManifestProcessProofs {
        host: ack.host_process.clone(),
        provider: ack.provider_process.clone(),
    };
    validate_manifest_process_proofs(&expected, &ack).unwrap();

    let spliced = ManifestProcessProofs {
        host: ProcessProof {
            process_id: ack.host_process.process_id,
            start_marker: "qa-owned-but-not-this-host".into(),
        },
        provider: ack.provider_process.clone(),
    };
    assert_eq!(
        validate_manifest_process_proofs(&spliced, &ack)
            .unwrap_err()
            .code(),
        "hmux_manifest_process_mismatch"
    );
}

#[test]
fn local_attach_accepts_only_the_committed_provider_exit_before_manifest_publication() {
    let provider_process = ProcessProof {
        process_id: 11,
        start_marker: "provider-start".into(),
    };
    let mut ack = hello_ack(&["screen_snapshot", "live_output"]);
    ack.provider_process = Some(provider_process.clone());
    let expected = ManifestProcessProofs {
        host: ack.host_process.clone(),
        provider: Some(provider_process),
    };

    ack.provider_process = None;
    assert_eq!(
        validate_manifest_process_proofs(&expected, &ack)
            .unwrap_err()
            .code(),
        "hmux_manifest_process_mismatch"
    );

    ack.lifecycle = LifecycleState::Exited;
    validate_manifest_process_proofs(&expected, &ack).unwrap();

    ack.host_process.start_marker = "replacement-host".into();
    assert_eq!(
        validate_manifest_process_proofs(&expected, &ack)
            .unwrap_err()
            .code(),
        "hmux_manifest_process_mismatch"
    );
}

#[test]
fn shared_writer_requests_explicit_shared_capability() {
    let capabilities = requested_capabilities(LocalAttachRole::SharedWriter, &[], false);
    assert!(capabilities.iter().any(|value| value == "terminal_input"));
    assert!(
        capabilities
            .iter()
            .any(|value| value == SHARED_TERMINAL_INPUT_CAPABILITY)
    );
}

#[cfg(all(unix, feature = "local-runtime"))]
#[test]
fn attach_handshake_times_out_when_a_peer_stalls_after_the_length_prefix() {
    use hmux_local_platform::transport::fd::{FdFrameReader, UnixSocketFrameWriter};
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::time::Instant;

    #[derive(Debug)]
    struct NoopInterrupt;
    impl TransportInterrupt for NoopInterrupt {
        fn interrupt(&self) {}
    }

    let (client, mut host) = UnixStream::pair().unwrap();
    let reader = FdFrameReader::new(client.try_clone().unwrap());
    let writer = UnixSocketFrameWriter::new(client);
    let encoded = codec()
        .encode(&WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body: FrameBody::HelloAck(hello_ack(&["screen_snapshot", "live_output"])),
        })
        .unwrap();
    host.write_all(&encoded[..4]).unwrap();
    host.flush().unwrap();

    let started = Instant::now();
    let error = LocalConnection::attach_over_transport(
        AttachedTransport::relayed(Box::new(reader), Box::new(writer), Arc::new(NoopInterrupt)),
        fence(),
        "attach-secret".to_string(),
        ConnectionOptions::new(LocalAttachRole::Observer, None)
            .with_handshake_completion_timeout(Duration::from_millis(500))
            .with_handshake_deadline(Instant::now() + Duration::from_millis(50)),
    )
    .unwrap_err();

    assert_eq!(error.code(), "hmux_stream_desynchronized");
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[cfg(all(unix, feature = "local-runtime"))]
#[test]
fn attach_handshake_deadline_bounds_a_peer_that_sends_no_first_byte() {
    use hmux_local_platform::transport::fd::{FdFrameReader, UnixSocketFrameWriter};
    use std::os::unix::net::UnixStream;

    #[derive(Debug)]
    struct NoopInterrupt;
    impl TransportInterrupt for NoopInterrupt {
        fn interrupt(&self) {}
    }

    let (client, _silent_host) = UnixStream::pair().unwrap();
    let reader = FdFrameReader::new(client.try_clone().unwrap());
    let writer = UnixSocketFrameWriter::new(client);
    let started = Instant::now();
    let error = LocalConnection::attach_over_transport(
        AttachedTransport::relayed(Box::new(reader), Box::new(writer), Arc::new(NoopInterrupt)),
        fence(),
        "attach-secret".to_string(),
        ConnectionOptions::new(LocalAttachRole::Observer, None)
            .with_handshake_deadline(Instant::now() + Duration::from_millis(50)),
    )
    .unwrap_err();

    assert_eq!(error.code(), "hmux_io_failed");
    assert!(matches!(
        error,
        ClientError::Io {
            operation: "hello_ack",
            ..
        }
    ));
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[cfg(all(unix, feature = "local-runtime"))]
#[test]
fn hello_ack_and_snapshot_share_one_absolute_handshake_deadline() {
    use hmux_local_platform::transport::fd::{FdFrameReader, UnixSocketFrameWriter};
    use std::io::Write;
    use std::os::unix::net::UnixStream;

    #[derive(Debug)]
    struct NoopInterrupt;
    impl TransportInterrupt for NoopInterrupt {
        fn interrupt(&self) {}
    }

    let (client, mut host) = UnixStream::pair().unwrap();
    let reader = FdFrameReader::new(client.try_clone().unwrap());
    let writer = UnixSocketFrameWriter::new(client);
    let host_thread = std::thread::spawn(move || {
        FrameCodec::new(FrameLimits::default())
            .read_from(&mut host)
            .unwrap();
        std::thread::sleep(Duration::from_millis(60));
        let encoded = codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(hello_ack(&["screen_snapshot", "live_output"])),
            })
            .unwrap();
        host.write_all(&encoded).unwrap();
        host.flush().unwrap();
        std::thread::sleep(Duration::from_millis(600));
    });

    let started = Instant::now();
    let error = LocalConnection::attach_over_transport(
        AttachedTransport::relayed(Box::new(reader), Box::new(writer), Arc::new(NoopInterrupt)),
        fence(),
        "attach-secret".to_string(),
        ConnectionOptions::new(LocalAttachRole::Observer, None)
            .with_handshake_completion_timeout(Duration::from_millis(500))
            .with_handshake_deadline(Instant::now() + Duration::from_millis(500)),
    )
    .unwrap_err();
    let elapsed = started.elapsed();
    host_thread.join().unwrap();

    assert_eq!(error.code(), "hmux_io_failed");
    assert!(matches!(
        error,
        ClientError::Io {
            operation: "screen_snapshot",
            ..
        }
    ));
    assert!(elapsed >= Duration::from_millis(60));
    assert!(elapsed < Duration::from_millis(800));
}

#[cfg(all(unix, feature = "local-runtime"))]
#[test]
fn absolute_read_deadline_survives_reducer_discarded_frame_floods() {
    use hmux_local_platform::transport::fd::{FdFrameReader, UnixSocketFrameWriter};
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    #[derive(Debug)]
    struct NoopInterrupt;
    impl TransportInterrupt for NoopInterrupt {
        fn interrupt(&self) {}
    }

    let (client, mut host) = UnixStream::pair().unwrap();
    let reader = FdFrameReader::new(client.try_clone().unwrap());
    let writer = UnixSocketFrameWriter::new(client);
    let host_thread = std::thread::spawn(move || {
        let _hello = codec().read_for_dispatch(&mut host).unwrap();
        for frame in handshake_script(hello_ack(&["screen_snapshot", "live_output"]), 1) {
            host.write_all(&codec().encode(&frame).unwrap()).unwrap();
        }
        let advance = frame(3, replayed_delta(2, b"advance"));
        host.write_all(&codec().encode(&advance).unwrap()).unwrap();
        host.flush().unwrap();
        for frame_id in 4..24 {
            std::thread::sleep(Duration::from_millis(20));
            let stale = WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id,
                body: FrameBody::ScreenSnapshot(screen_snapshot(1)),
            };
            if host.write_all(&codec().encode(&stale).unwrap()).is_err() {
                break;
            }
            let _ = host.flush();
        }
        let _ = host.read(&mut [0_u8; 1]);
    });

    let mut connection = LocalConnection::attach_over_transport(
        AttachedTransport::relayed(Box::new(reader), Box::new(writer), Arc::new(NoopInterrupt)),
        fence(),
        "attach-secret".to_string(),
        ConnectionOptions::new(LocalAttachRole::Observer, None),
    )
    .unwrap();
    assert!(matches!(
        connection.read_body().unwrap(),
        FrameBody::OutputDelta(_)
    ));
    let started = Instant::now();
    let error = connection
        .read_body_before(started + Duration::from_millis(90))
        .unwrap_err();
    let elapsed = started.elapsed();
    drop(connection);
    host_thread.join().unwrap();

    assert!(matches!(
        error.code(),
        "hmux_read_deadline_exceeded" | "hmux_io_failed"
    ));
    assert!(elapsed < Duration::from_millis(200));
}

#[test]
fn handshake_requires_the_complete_fence_and_role_capabilities() {
    let expected_fence = fence();
    let mut ack = hello_ack(&["screen_snapshot", "live_output"]);
    let attestation = PeerAttestation::Simulated;

    validate_hello_ack(
        &expected_fence,
        required_capabilities(LocalAttachRole::Observer),
        &ack,
        &attestation,
    )
    .unwrap();

    ack.selected_capabilities.pop();
    assert!(matches!(
        validate_hello_ack(
            &expected_fence,
            required_capabilities(LocalAttachRole::Observer),
            &ack,
            &attestation
        ),
        Err(ClientError::MissingCapability {
            capability: "live_output"
        })
    ));

    ack.selected_capabilities.push("live_output".into());
    ack.actual_fence.host_instance_id = "other-host".into();
    assert!(matches!(
        validate_hello_ack(
            &expected_fence,
            required_capabilities(LocalAttachRole::Observer),
            &ack,
            &attestation
        ),
        Err(ClientError::FenceMismatch(_))
    ));
}

fn ack_with_posture(capabilities: &[&str], posture: AuthorizationPosture) -> HelloAck {
    HelloAck {
        authorization_posture: posture,
        ..hello_ack(capabilities)
    }
}

/// Every grant that rests on the same-user premise, in both session
/// classes. Managed sessions are here because the posture-name gate this
/// replaced never fired for them: the Host computes the shared-writer grant
/// without consulting the session class, so a `DaemonAuthorizedObserver`
/// receives PTY writes on the same premise a `StandaloneLocalOwner` does.
fn premised_grants() -> Vec<(&'static str, LocalAttachRole, HelloAck)> {
    vec![
        (
            "standalone shared writer",
            LocalAttachRole::SharedWriter,
            ack_with_posture(
                &[
                    "screen_snapshot",
                    "live_output",
                    "terminal_input",
                    "terminal_resize",
                    SHARED_TERMINAL_INPUT_CAPABILITY,
                ],
                AuthorizationPosture::StandaloneLocalOwner,
            ),
        ),
        (
            "standalone termination",
            LocalAttachRole::Observer,
            ack_with_posture(
                &[
                    "screen_snapshot",
                    "live_output",
                    STANDALONE_TERMINATION_CAPABILITY,
                ],
                AuthorizationPosture::StandaloneLocalOwner,
            ),
        ),
        (
            "standalone agent state report",
            LocalAttachRole::Observer,
            ack_with_posture(
                &[
                    "screen_snapshot",
                    "live_output",
                    AGENT_STATE_REPORT_CAPABILITY,
                ],
                AuthorizationPosture::StandaloneLocalOwner,
            ),
        ),
        (
            "managed shared writer",
            LocalAttachRole::SharedWriter,
            ack_with_posture(
                &[
                    "screen_snapshot",
                    "live_output",
                    "terminal_input",
                    "terminal_resize",
                    SHARED_TERMINAL_INPUT_CAPABILITY,
                ],
                AuthorizationPosture::DaemonAuthorizedObserver,
            ),
        ),
        (
            "managed agent state report",
            LocalAttachRole::Observer,
            ack_with_posture(
                &[
                    "screen_snapshot",
                    "live_output",
                    AGENT_STATE_REPORT_CAPABILITY,
                ],
                AuthorizationPosture::DaemonAuthorizedObserver,
            ),
        ),
    ]
}

/// Both attestations that establish no colocation, and `Relayed` is the one
/// that matters: it is what the shipped SSH exec dialer produces, so this is
/// the gate firing against a transport that actually exists rather than
/// against a test fixture. Covering only `Simulated` would leave the shipped
/// case asserted by nothing but the shape of the `match` in `witness_for` —
/// and that `match` is one `_` arm away from silently answering differently.
///
/// The gate is deliberately blind to `AttachMode` here. Controller authority
/// is premised on a gateway-minted grant and arbitrated by a single-holder,
/// generation-fenced lease, so it is not in this list; these three are
/// premised on colocation and nothing arbitrates them, so they are withheld
/// from a relayed attach whatever role asked for them.
#[test]
fn same_user_authority_is_refused_when_the_transport_proves_no_colocation() {
    for attestation in [PeerAttestation::Relayed, PeerAttestation::Simulated] {
        for (label, role, ack) in premised_grants() {
            let error =
                validate_hello_ack(&fence(), required_capabilities(role), &ack, &attestation)
                    .expect_err(&format!("{label} must not be accepted off {attestation:?}"));

            assert_eq!(
                error.code(),
                "hmux_uncolocated_authority",
                "{label} over {attestation:?}"
            );
        }
    }
}

#[test]
fn same_user_authority_is_accepted_over_a_kernel_verified_socket() {
    let (_socket_directory, attestation) = colocated_for("session");

    for (label, role, ack) in premised_grants() {
        validate_hello_ack(&fence(), required_capabilities(role), &ack, &attestation)
            .unwrap_or_else(|error| panic!("{label} must still attach locally: {error}"));
    }
}

/// The gate is on the grant, not on the posture: a read-only attach
/// authorizes nothing that colocation was the premise for, so it must
/// survive a transport that proves none. Refusing it would foreclose the
/// observer-only remote access this whole migration delivers first.
#[test]
fn a_read_only_attach_needs_no_colocation_in_either_session_class() {
    for posture in [
        AuthorizationPosture::StandaloneLocalOwner,
        AuthorizationPosture::DaemonAuthorizedObserver,
    ] {
        let ack = ack_with_posture(&["screen_snapshot", "live_output"], posture);

        // Over the relay attestation the SSH dialer really produces, not
        // only over the test-only one, because a read-only remote observer
        // is the first capability this migration delivers and a gate that
        // quietly refused it would have foreclosed the whole point.
        validate_hello_ack(
            &fence(),
            required_capabilities(LocalAttachRole::Observer),
            &ack,
            &PeerAttestation::Relayed,
        )
        .unwrap();
    }
}

/// Colocation alone is not the question — colocation *with this session*
/// is. A witness from a neighbouring session proves the peer shares this
/// kernel while saying nothing about who is serving this one.
#[test]
fn a_witness_for_another_session_does_not_carry_the_premise() {
    let (_socket_directory, attestation) = colocated_for("another-session");
    let (label, role, ack) = premised_grants().remove(0);

    let error = validate_hello_ack(&fence(), required_capabilities(role), &ack, &attestation)
        .expect_err(&format!("{label} must not ride another session's witness"));

    assert_eq!(error.code(), "hmux_uncolocated_authority");
}

/// Splits one in-memory duplex into the reader, writer and interrupt halves
/// an [`AttachedTransport`] is assembled from.
///
/// A shim, not a transport: `MemoryEndpoint` is a single full-duplex value
/// and the seam takes three separately owned halves. Reads never block on a
/// memory pipe -- an empty one reports a first-byte stall immediately -- so
/// holding the lock across a read cannot deadlock the writer.
#[derive(Clone)]
struct SharedEndpoint(Arc<Mutex<MemoryEndpoint>>);

impl SharedEndpoint {
    fn new(endpoint: MemoryEndpoint) -> Self {
        Self(Arc::new(Mutex::new(endpoint)))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, MemoryEndpoint> {
        self.0.lock().expect("memory endpoint lock")
    }
}

impl FrameReader for SharedEndpoint {
    fn wait_readable(&mut self, timeout: Option<Duration>) -> Result<(), TransportError> {
        self.lock().wait_readable(timeout)
    }

    fn read_payload(&mut self, codec: &FrameCodec) -> Result<PayloadOutcome, TransportError> {
        self.lock().read_payload(codec)
    }

    fn try_read_complete_payload(
        &mut self,
        codec: &FrameCodec,
    ) -> Result<PayloadOutcome, TransportError> {
        self.lock().try_read_complete_payload(codec)
    }

    fn read_frame(&mut self, codec: &FrameCodec) -> Result<FrameOutcome, TransportError> {
        self.lock().read_frame(codec)
    }

    fn set_completion_timeout(&mut self, timeout: Option<Duration>) {
        self.lock().set_completion_timeout(timeout);
    }
}

#[cfg(feature = "terminal-state-stream")]
struct InterruptOnBufferedProbe(SharedEndpoint);

#[cfg(feature = "terminal-state-stream")]
impl FrameReader for InterruptOnBufferedProbe {
    fn wait_readable(&mut self, timeout: Option<Duration>) -> Result<(), TransportError> {
        self.0.wait_readable(timeout)
    }

    fn try_read_complete_payload(
        &mut self,
        _codec: &FrameCodec,
    ) -> Result<PayloadOutcome, TransportError> {
        Err(TransportError::Interrupted)
    }

    fn read_payload(&mut self, codec: &FrameCodec) -> Result<PayloadOutcome, TransportError> {
        self.0.read_payload(codec)
    }

    fn set_completion_timeout(&mut self, timeout: Option<Duration>) {
        self.0.set_completion_timeout(timeout);
    }
}

#[cfg(feature = "terminal-state-stream")]
struct CountingBufferedProbe {
    endpoint: SharedEndpoint,
    probes: Arc<std::sync::atomic::AtomicUsize>,
}

#[cfg(feature = "terminal-state-stream")]
impl FrameReader for CountingBufferedProbe {
    fn wait_readable(&mut self, timeout: Option<Duration>) -> Result<(), TransportError> {
        self.endpoint.wait_readable(timeout)
    }

    fn try_read_complete_payload(
        &mut self,
        codec: &FrameCodec,
    ) -> Result<PayloadOutcome, TransportError> {
        self.probes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.endpoint.try_read_complete_payload(codec)
    }

    fn read_payload(&mut self, codec: &FrameCodec) -> Result<PayloadOutcome, TransportError> {
        self.endpoint.read_payload(codec)
    }

    fn set_completion_timeout(&mut self, timeout: Option<Duration>) {
        self.endpoint.set_completion_timeout(timeout);
    }
}

impl FrameWriter for SharedEndpoint {
    fn write_frame(&mut self, encoded: &[u8]) -> Result<(), TransportError> {
        self.lock().write_frame(encoded)
    }

    fn write_frame_before(
        &mut self,
        encoded: &[u8],
        deadline: Option<Instant>,
    ) -> Result<(), TransportError> {
        self.lock().write_frame_before(encoded, deadline)
    }

    fn close_write(&mut self) -> Result<(), TransportError> {
        self.lock().close_write()
    }
}

struct LegacyFrameWriter(SharedEndpoint);

impl FrameWriter for LegacyFrameWriter {
    fn write_frame(&mut self, encoded: &[u8]) -> Result<(), TransportError> {
        self.0.write_frame(encoded)
    }

    fn close_write(&mut self) -> Result<(), TransportError> {
        self.0.close_write()
    }
}

#[cfg(feature = "terminal-state-stream")]
struct DeadlineRecordingWriter {
    endpoint: SharedEndpoint,
    deadlines: Arc<Mutex<Vec<Option<Instant>>>>,
}

#[cfg(feature = "terminal-state-stream")]
impl FrameWriter for DeadlineRecordingWriter {
    fn write_frame(&mut self, encoded: &[u8]) -> Result<(), TransportError> {
        self.write_frame_before(encoded, None)
    }

    fn write_frame_before(
        &mut self,
        encoded: &[u8],
        deadline: Option<Instant>,
    ) -> Result<(), TransportError> {
        self.deadlines
            .lock()
            .expect("deadline recording lock")
            .push(deadline);
        self.endpoint.write_frame_before(encoded, deadline)
    }

    fn close_write(&mut self) -> Result<(), TransportError> {
        self.endpoint.close_write()
    }
}

impl TransportInterrupt for SharedEndpoint {
    fn interrupt(&self) {
        // Nothing to wake: a memory read never blocks.
    }
}

#[cfg(feature = "terminal-state-stream")]
struct PeerNotifiedReader {
    endpoint: SharedEndpoint,
    readable: std::sync::mpsc::Receiver<()>,
}

#[cfg(feature = "terminal-state-stream")]
impl FrameReader for PeerNotifiedReader {
    fn wait_readable(&mut self, timeout: Option<Duration>) -> Result<(), TransportError> {
        match self.endpoint.wait_readable(timeout) {
            Ok(()) => return Ok(()),
            Err(TransportError::FirstByteTimeout) => {}
            Err(error) => return Err(error),
        }
        let notified = match timeout {
            Some(timeout) => self.readable.recv_timeout(timeout).is_ok(),
            None => self.readable.recv().is_ok(),
        };
        if !notified {
            return Err(TransportError::FirstByteTimeout);
        }
        self.endpoint.wait_readable(timeout)
    }

    fn read_payload(&mut self, codec: &FrameCodec) -> Result<PayloadOutcome, TransportError> {
        self.endpoint.read_payload(codec)
    }

    fn try_read_complete_payload(
        &mut self,
        codec: &FrameCodec,
    ) -> Result<PayloadOutcome, TransportError> {
        self.endpoint.try_read_complete_payload(codec)
    }

    fn set_completion_timeout(&mut self, timeout: Option<Duration>) {
        self.endpoint.set_completion_timeout(timeout);
    }
}

#[cfg(feature = "terminal-state-stream")]
struct PeerNotifyingEndpoint {
    endpoint: MemoryEndpoint,
    readable: std::sync::mpsc::Sender<()>,
}

#[cfg(feature = "terminal-state-stream")]
impl FrameReader for PeerNotifyingEndpoint {
    fn wait_readable(&mut self, timeout: Option<Duration>) -> Result<(), TransportError> {
        self.endpoint.wait_readable(timeout)
    }

    fn read_payload(&mut self, codec: &FrameCodec) -> Result<PayloadOutcome, TransportError> {
        self.endpoint.read_payload(codec)
    }

    fn try_read_complete_payload(
        &mut self,
        codec: &FrameCodec,
    ) -> Result<PayloadOutcome, TransportError> {
        self.endpoint.try_read_complete_payload(codec)
    }

    fn set_completion_timeout(&mut self, timeout: Option<Duration>) {
        self.endpoint.set_completion_timeout(timeout);
    }
}

#[cfg(feature = "terminal-state-stream")]
impl FrameWriter for PeerNotifyingEndpoint {
    fn write_frame(&mut self, encoded: &[u8]) -> Result<(), TransportError> {
        self.endpoint.write_frame(encoded)?;
        let _ = self.readable.send(());
        Ok(())
    }

    fn write_frame_before(
        &mut self,
        encoded: &[u8],
        deadline: Option<Instant>,
    ) -> Result<(), TransportError> {
        self.endpoint.write_frame_before(encoded, deadline)?;
        let _ = self.readable.send(());
        Ok(())
    }

    fn close_write(&mut self) -> Result<(), TransportError> {
        self.endpoint.close_write()?;
        let _ = self.readable.send(());
        Ok(())
    }
}

fn codec() -> FrameCodec {
    FrameCodec::new(FrameLimits::default())
}

fn screen_snapshot(sequence_through: u64) -> ScreenSnapshot {
    ScreenSnapshot {
        fence: fence(),
        sequence_through,
        rows: 24,
        columns: 80,
        encoding: hmux_session_protocol::ScreenSnapshotEncoding::AnsiRedrawV1,
        controller_input_pending: None,
        semantic_idle_ms: None,
        repaint_bytes: b"repaint".to_vec(),
        alternate_screen: false,
        cursor_visible: true,
        truncated: false,
        working_directory: None,
        execution_location: None,
        agent_identity: None,
        agent_runtime_state: None,
        provider_conversation_identity: None,
        actual_profile: None,
        in_reply_to_request_id: None,
        recovered_presentation: None,
    }
}

fn handshake_script(ack: HelloAck, sequence_through: u64) -> Vec<WireFrame> {
    vec![
        WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body: FrameBody::HelloAck(ack),
        },
        WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 2,
            body: FrameBody::ScreenSnapshot(screen_snapshot(sequence_through)),
        },
    ]
}

/// A caller-supplied relayed transport with the Host's side of the
/// handshake already queued, plus the peer end so a test can read what the
/// client actually put on the wire.
fn relayed_transport(script: &[WireFrame]) -> (AttachedTransport, MemoryEndpoint) {
    let (client, mut host) = MemoryEndpoint::pair();
    for frame in script {
        let encoded = codec().encode(frame).unwrap();
        host.write_frame(&encoded).unwrap();
    }
    let shared = SharedEndpoint::new(client);
    (
        AttachedTransport::relayed(
            Box::new(shared.clone()),
            Box::new(shared.clone()),
            Arc::new(shared),
        ),
        host,
    )
}

#[cfg(feature = "terminal-state-stream")]
fn write_opaque_payload(endpoint: &mut impl FrameWriter, payload: &[u8]) {
    let mut encoded = Vec::with_capacity(4 + payload.len());
    encoded.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    encoded.extend_from_slice(payload);
    endpoint.write_frame(&encoded).unwrap();
}

#[cfg(feature = "terminal-state-stream")]
fn viewport_seed_record() -> terminal_state_protocol::TerminalStateRecord {
    use terminal_state_protocol::{
        BufferId, CellStyle, Grapheme, InputModes, MouseEncoding, MouseTrackingMode,
        RowTermination, TerminalCell, TerminalColorOverrides, TerminalRow, TerminalStateRecord,
        TerminalTables, UnderlineKind, UnicodeWidthProfile, ViewportAnchorStatus, ViewportFrame,
        terminal_state_record,
    };

    TerminalStateRecord {
        schema_minor: 4,
        terminal_epoch: fence().terminal_epoch,
        through_output_seq: 1,
        state_revision: 1,
        body: Some(terminal_state_record::Body::ViewportFrame(ViewportFrame {
            projection_revision: 1,
            damage_base_projection_revision: 0,
            canonical_columns: 1,
            viewport_rows: 1,
            active_buffer: BufferId::Normal as i32,
            rows: vec![TerminalRow {
                row_id: 1,
                continues_from_previous: false,
                cells: vec![TerminalCell {
                    grapheme_index: 0,
                    style_index: 0,
                }],
                termination: RowTermination::HardBreak as i32,
                logical_line_id: 1,
                logical_cell_offset: 0,
                logical_cell_span: 1,
            }],
            tables: Some(TerminalTables {
                graphemes: vec![Grapheme {
                    text: "x".into(),
                    display_width: 1,
                }],
                styles: vec![CellStyle {
                    underline: UnderlineKind::None as i32,
                    ..CellStyle::default()
                }],
                hyperlinks: Vec::new(),
            }),
            cursor: None,
            input_modes: Some(InputModes {
                mouse_tracking: MouseTrackingMode::None as i32,
                mouse_encoding: MouseEncoding::Default as i32,
                ..InputModes::default()
            }),
            color_overrides: Some(TerminalColorOverrides::default()),
            unicode_width: Some(UnicodeWidthProfile {
                unicode_version: "test".into(),
                ambiguous_width: 1,
                emoji_width: 2,
            }),
            through_event_id: 0,
            title: "surface".into(),
            working_directory_uri: String::new(),
            follow_tail: true,
            has_more_before: false,
            has_more_after: false,
            changed_row_indices: Vec::new(),
            applied_intent_seq: 1,
            anchor_status: ViewportAnchorStatus::FollowTail as i32,
            rows_from_tail: Some(0),
            input_output_timing: None,
        })),
    }
}

#[cfg(feature = "terminal-state-stream")]
fn multipart_viewport_replacement() -> terminal_state_protocol::TerminalStateRecord {
    use terminal_state_protocol::terminal_state_record;

    let mut replacement = viewport_seed_record();
    replacement.through_output_seq = 2;
    replacement.state_revision = 2;
    let Some(terminal_state_record::Body::ViewportFrame(frame)) = replacement.body.as_mut() else {
        unreachable!()
    };
    frame.projection_revision = 2;
    frame.applied_intent_seq = 2;
    frame.title = "multipart-installed".into();
    replacement
}

#[cfg(feature = "terminal-state-stream")]
fn viewport_record_at(revision: u64, title: &str) -> terminal_state_protocol::TerminalStateRecord {
    use terminal_state_protocol::terminal_state_record;

    let mut record = viewport_seed_record();
    record.through_output_seq = revision;
    record.state_revision = revision;
    let Some(terminal_state_record::Body::ViewportFrame(frame)) = record.body.as_mut() else {
        unreachable!()
    };
    frame.projection_revision = revision;
    frame.applied_intent_seq = revision;
    frame.title = title.into();
    record
}

#[cfg(feature = "terminal-state-stream")]
fn padded_viewport_record_at(
    revision: u64,
    grapheme_entries: usize,
) -> terminal_state_protocol::TerminalStateRecord {
    use terminal_state_protocol::{Grapheme, terminal_state_record};

    let mut record = viewport_record_at(revision, &format!("revision-{revision}"));
    let Some(terminal_state_record::Body::ViewportFrame(frame)) = record.body.as_mut() else {
        unreachable!()
    };
    frame
        .tables
        .as_mut()
        .expect("viewport fixture has tables")
        .graphemes = (0..grapheme_entries)
        .map(|_| Grapheme {
            text: "x".repeat(1024),
            display_width: 1,
        })
        .collect();
    record
}

#[cfg(feature = "terminal-state-stream")]
fn framed_payload(payload: &[u8]) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(4 + payload.len());
    encoded.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    encoded.extend_from_slice(payload);
    encoded
}

#[cfg(feature = "terminal-state-stream")]
fn viewport_frame_parts(
    replacement: &terminal_state_protocol::TerminalStateRecord,
    batch_id: &[u8],
) -> Vec<Vec<u8>> {
    use terminal_state_protocol::{
        ViewportFrameBatch, encode_viewport_frame_parts, terminal_state_record,
    };

    let Some(terminal_state_record::Body::ViewportFrame(frame)) = replacement.body.as_ref() else {
        panic!("multipart fixture must contain a viewport frame");
    };
    encode_viewport_frame_parts(ViewportFrameBatch {
        record_id_start: 30,
        schema_minor: 5,
        terminal_epoch: &replacement.terminal_epoch,
        through_output_seq: replacement.through_output_seq,
        state_revision: replacement.state_revision,
        batch_id,
        frame,
        max_chunk_bytes: 64,
    })
    .unwrap()
}

#[cfg(feature = "terminal-state-stream")]
fn viewport_frame_parts_at(
    replacement: &terminal_state_protocol::TerminalStateRecord,
    batch_id: &[u8],
    record_id_start: u64,
    max_chunk_bytes: usize,
) -> Vec<Vec<u8>> {
    use terminal_state_protocol::{
        ViewportFrameBatch, encode_viewport_frame_parts, terminal_state_record,
    };

    let Some(terminal_state_record::Body::ViewportFrame(frame)) = replacement.body.as_ref() else {
        panic!("multipart fixture must contain a viewport frame");
    };
    encode_viewport_frame_parts(ViewportFrameBatch {
        record_id_start,
        schema_minor: 5,
        terminal_epoch: &replacement.terminal_epoch,
        through_output_seq: replacement.through_output_seq,
        state_revision: replacement.state_revision,
        batch_id,
        frame,
        max_chunk_bytes,
    })
    .unwrap()
}

#[cfg(feature = "terminal-state-stream")]
fn terminal_surface_with_live_payloads(payloads: &[Vec<u8>]) -> crate::TerminalSurfaceAttachment {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY, TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use terminal_state_protocol::encode_record;

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
        TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );
    for payload in payloads {
        write_opaque_payload(&mut host, payload);
    }
    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    crate::TerminalSurfaceAttachment::from_connection(connection).unwrap()
}

#[cfg(feature = "terminal-state-stream")]
fn terminal_surface_with_live_host() -> (crate::TerminalSurfaceAttachment, MemoryEndpoint) {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY, TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use terminal_state_protocol::encode_record;

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
        TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );
    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    (
        crate::TerminalSurfaceAttachment::from_connection(connection).unwrap(),
        host,
    )
}

#[cfg(feature = "terminal-state-stream")]
fn terminal_surface_with_counted_buffered_probes() -> (
    crate::TerminalSurfaceAttachment,
    MemoryEndpoint,
    Arc<std::sync::atomic::AtomicUsize>,
) {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY, TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use hmux_session_protocol::AGENT_RUNTIME_STATE_CAPABILITY;
    use terminal_state_protocol::encode_record;

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        AGENT_RUNTIME_STATE_CAPABILITY,
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
        TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );
    let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let shared = SharedEndpoint::new(client);
    let transport = AttachedTransport::relayed(
        Box::new(CountingBufferedProbe {
            endpoint: shared.clone(),
            probes: Arc::clone(&probes),
        }),
        Box::new(shared.clone()),
        Arc::new(shared),
    );
    let connection = LocalConnection::attach_over_transport(
        transport,
        fence(),
        "attach-secret".into(),
        crate::TerminalSurfaceAttachment::connection_options(
            crate::TerminalSurfaceAccess::ReadOnly,
            None,
        ),
    )
    .unwrap();
    (
        crate::TerminalSurfaceAttachment::from_connection(connection).unwrap(),
        host,
        probes,
    )
}

#[cfg(feature = "terminal-state-stream")]
fn terminal_surface_connection(
    client: MemoryEndpoint,
    access: crate::TerminalSurfaceAccess,
) -> LocalConnection {
    let shared = SharedEndpoint::new(client);
    let transport = AttachedTransport::relayed(
        Box::new(shared.clone()),
        Box::new(shared.clone()),
        Arc::new(shared),
    );
    LocalConnection::attach_over_transport(
        transport,
        fence(),
        "attach-secret".to_string(),
        crate::TerminalSurfaceAttachment::connection_options(access, None),
    )
    .unwrap()
}

#[cfg(all(unix, feature = "local-runtime", feature = "terminal-state-stream"))]
#[test]
fn detach_handle_releases_a_blocked_surface_only_after_host_cleanup_close() {
    use hmux_local_platform::transport::fd::{FdFrameReader, FdFrameWriter, UnixSocketFrameWriter};
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };
    use std::os::unix::net::UnixStream;
    use std::sync::mpsc;
    use terminal_state_protocol::encode_record;

    #[derive(Debug)]
    struct NoopInterrupt;
    impl TransportInterrupt for NoopInterrupt {
        fn interrupt(&self) {}
    }

    let (client, host) = UnixStream::pair().unwrap();
    let (detach_seen_tx, detach_seen_rx) = mpsc::channel();
    let (cleanup_release_tx, cleanup_release_rx) = mpsc::channel();
    let host_thread = std::thread::spawn(move || {
        let mut reader = FdFrameReader::new(host.try_clone().unwrap());
        let mut writer = FdFrameWriter::new(host);
        let mut ack = hello_ack(&[
            TERMINAL_STATE_BINARY_CAPABILITY,
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        ]);
        ack.current_output_seq = 1;
        writer
            .write_frame(
                &codec()
                    .encode(&WireFrame {
                        protocol_version: PROTOCOL_V1,
                        frame_id: 1,
                        body: FrameBody::HelloAck(ack),
                    })
                    .unwrap(),
            )
            .unwrap();
        let seed = encode_record(2, &viewport_seed_record()).unwrap();
        let mut encoded_seed = Vec::with_capacity(4 + seed.len());
        encoded_seed.extend_from_slice(&(seed.len() as u32).to_be_bytes());
        encoded_seed.extend_from_slice(&seed);
        writer.write_frame(&encoded_seed).unwrap();

        loop {
            let frame = reader
                .read_frame(&codec())
                .unwrap()
                .expect("client should send Hello and Detach frames");
            if matches!(frame.frame().body, FrameBody::Detach(_)) {
                break;
            }
        }
        detach_seen_tx.send(()).unwrap();
        cleanup_release_rx.recv().unwrap();
        // Dropping both Host halves models the server close that occurs only
        // after ClientRegistration::cleanup removes the surface proposal.
    });
    let reader = FdFrameReader::new(client.try_clone().unwrap());
    let writer = UnixSocketFrameWriter::new(client);
    let connection = LocalConnection::attach_over_transport(
        AttachedTransport::relayed(Box::new(reader), Box::new(writer), Arc::new(NoopInterrupt)),
        fence(),
        "attach-secret".to_string(),
        crate::TerminalSurfaceAttachment::connection_options(
            crate::TerminalSurfaceAccess::ReadOnly,
            None,
        ),
    )
    .unwrap();
    let mut surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let departure = surface.detach_handle();
    let (read_started_tx, read_started_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    std::thread::spawn(move || {
        read_started_tx.send(()).unwrap();
        let read_error = surface
            .read_delivery_record()
            .expect_err("Host cleanup close should retire the blocked downstream read");
        result_tx
            .send((
                read_error.code().to_string(),
                surface.detach_confirmed(Duration::from_secs(1)),
            ))
            .unwrap();
    });

    read_started_rx
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert!(departure.begin_detach().unwrap());
    detach_seen_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(result_rx.recv_timeout(Duration::from_millis(50)).is_err());
    cleanup_release_tx.send(()).unwrap();
    let (read_error, detach_result) = result_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("blocked read should finish after Host cleanup close");
    assert_eq!(read_error, "hmux_transport_closed");
    detach_result.expect("clean Host close should confirm detach");
    host_thread.join().unwrap();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_hydrates_host_identity_from_the_structured_attach_seed() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };
    use hmux_session_protocol::{
        PROVIDER_CONVERSATION_IDENTITY_CAPABILITY, ProviderConversationIdentityProjection,
        ProviderConversationIdentitySource,
    };
    use terminal_state_protocol::encode_record;

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 2,
                body: FrameBody::ProviderConversationIdentity(
                    ProviderConversationIdentityProjection {
                        fence: fence(),
                        revision: 7,
                        observed_through_output_seq: 1,
                        provider_id: "codex".into(),
                        conversation_id: "conversation-opaque".into(),
                        source: ProviderConversationIdentitySource::ProviderEvent,
                    },
                ),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(3, &viewport_seed_record()).unwrap(),
    );

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    let surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let identity = surface
        .initial_provider_conversation_identity()
        .expect("Host identity must arrive in the same attach transaction");
    assert_eq!(identity.session_id, "session");
    assert_eq!(identity.workspace_id, "workspace");
    assert_eq!(identity.host_instance_id, "host-1");
    assert_eq!(identity.terminal_epoch, "terminal-1");
    assert_eq!(identity.revision, "7");
    assert_eq!(identity.observed_through_output_seq, "1");
    assert_eq!(identity.provider_id, "codex");
    assert_eq!(identity.conversation_id, "conversation-opaque");
    assert_eq!(
        identity.source,
        crate::ProviderConversationIdentitySource::ProviderEvent
    );
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_carries_agent_and_shell_identity_on_one_host() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };
    use hmux_session_protocol::{
        AGENT_IDENTITY_PROJECTION_CAPABILITY, AgentIdentityProjection, AgentIdentitySource,
        AgentProvider,
    };
    use terminal_state_protocol::encode_record;

    let identity = |observed_through_output_seq, agent| AgentIdentityProjection {
        terminal_epoch: "terminal-1".into(),
        observed_through_output_seq,
        agent,
        source: AgentIdentitySource::ProcessInspection,
    };
    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
        AGENT_IDENTITY_PROJECTION_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 2,
                body: FrameBody::AgentIdentity(identity(1, Some(AgentProvider::Codex))),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(3, &viewport_seed_record()).unwrap(),
    );
    let live_viewport = encode_record(4, &multipart_viewport_replacement()).unwrap();
    write_opaque_payload(&mut host, &live_viewport);
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 5,
                body: FrameBody::AgentIdentity(identity(2, None)),
            })
            .unwrap(),
    )
    .unwrap();

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    let mut surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let initial = surface
        .initial_agent_identity()
        .expect("agent identity must be installed with the viewport seed");
    assert_eq!(initial.agent, Some(crate::AgentProvider::Codex));
    assert_eq!(initial.observed_through_output_seq, "1");

    let crate::ConnectionRecord::TerminalState(delivered_viewport) =
        surface.read_delivery_record().unwrap()
    else {
        panic!("the live viewport must advance before the matching identity");
    };
    assert_eq!(delivered_viewport, live_viewport);
    let crate::ConnectionRecord::Control(body) = surface.read_delivery_record().unwrap() else {
        panic!("shell identity must remain a typed control record");
    };
    let FrameBody::AgentIdentity(shell) = *body else {
        panic!("the shell transition lost its agent identity projection");
    };
    assert_eq!(shell.agent, None);
    assert_eq!(shell.observed_through_output_seq, 2);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_carries_initial_and_live_runtime_state_with_one_revision_fence() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };
    use hmux_session_protocol::{
        AGENT_RUNTIME_STATE_CAPABILITY, AgentRuntimeActivity, AgentRuntimeAttention,
        AgentRuntimeLifecycle, AgentRuntimeStateProjection, AgentRuntimeStateSource,
    };
    use terminal_state_protocol::encode_record;

    let runtime_state = |revision| AgentRuntimeStateProjection {
        terminal_epoch: "terminal-1".into(),
        revision,
        observed_through_output_seq: if revision == 7 { 1 } else { 2 },
        lifecycle: AgentRuntimeLifecycle::Running,
        activity: if revision == 7 {
            AgentRuntimeActivity::Working
        } else {
            AgentRuntimeActivity::Waiting
        },
        attention: AgentRuntimeAttention::None,
        attention_id: None,
        source: AgentRuntimeStateSource::ProviderEvent,
        turn_completed_count: revision - 7,
    };
    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
        AGENT_RUNTIME_STATE_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 2,
                body: FrameBody::AgentRuntimeState(runtime_state(7)),
            })
            .unwrap(),
    )
    .unwrap();
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 3,
                body: FrameBody::AgentRuntimeState(runtime_state(8)),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(4, &multipart_viewport_replacement()).unwrap(),
    );
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 5,
                body: FrameBody::AgentRuntimeState(runtime_state(9)),
            })
            .unwrap(),
    )
    .unwrap();

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    let mut surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let initial = surface
        .initial_agent_runtime_state()
        .expect("typed Host runtime state must be in the attach transaction");
    assert_eq!(initial.terminal_epoch, "terminal-1");
    assert_eq!(initial.revision, "8");
    assert_eq!(initial.observed_through_output_seq, "2");
    assert_eq!(initial.activity, crate::AgentRuntimeActivity::Waiting);
    assert_eq!(
        initial.source,
        crate::AgentRuntimeStateSource::ProviderEvent
    );

    let crate::ConnectionRecord::Control(body) = surface.read_delivery_record().unwrap() else {
        panic!("the live runtime state must remain a typed control record");
    };
    let FrameBody::AgentRuntimeState(live) = *body else {
        panic!("the live structured control record lost runtime state");
    };
    assert_eq!(live.revision, 9);
    assert_eq!(live.activity, AgentRuntimeActivity::Waiting);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_advances_output_before_delivering_runtime_state_at_that_viewport() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };
    use hmux_session_protocol::{
        AGENT_RUNTIME_STATE_CAPABILITY, AgentRuntimeActivity, AgentRuntimeAttention,
        AgentRuntimeLifecycle, AgentRuntimeStateProjection, AgentRuntimeStateSource,
    };
    use terminal_state_protocol::encode_record;

    let runtime_state = |revision, observed_through_output_seq| AgentRuntimeStateProjection {
        terminal_epoch: "terminal-1".into(),
        revision,
        observed_through_output_seq,
        lifecycle: AgentRuntimeLifecycle::Running,
        activity: AgentRuntimeActivity::Working,
        attention: AgentRuntimeAttention::None,
        attention_id: None,
        source: AgentRuntimeStateSource::ProviderEvent,
        turn_completed_count: 0,
    };
    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        AGENT_RUNTIME_STATE_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 2,
                body: FrameBody::AgentRuntimeState(runtime_state(7, 1)),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(3, &viewport_seed_record()).unwrap(),
    );
    let live_viewport = encode_record(4, &multipart_viewport_replacement()).unwrap();
    write_opaque_payload(&mut host, &live_viewport);
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 5,
                body: FrameBody::AgentRuntimeState(runtime_state(8, 2)),
            })
            .unwrap(),
    )
    .unwrap();

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    let mut surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let crate::ConnectionRecord::TerminalState(delivered_viewport) =
        surface.read_delivery_record().unwrap()
    else {
        panic!("the complete viewport must be delivered before its semantic state");
    };
    assert_eq!(delivered_viewport, live_viewport);

    let crate::ConnectionRecord::Control(body) = surface.read_delivery_record().unwrap() else {
        panic!("runtime state at the installed viewport high-water must stay live");
    };
    let FrameBody::AgentRuntimeState(runtime) = *body else {
        panic!("the typed runtime projection was replaced");
    };
    assert_eq!(runtime.revision, 8);
    assert_eq!(runtime.observed_through_output_seq, 2);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_stages_latest_semantics_until_async_viewport_catches_up() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };
    use hmux_session_protocol::{
        AGENT_RUNTIME_STATE_CAPABILITY, AgentRuntimeActivity, AgentRuntimeAttention,
        AgentRuntimeLifecycle, AgentRuntimeStateProjection, AgentRuntimeStateSource,
        PROVIDER_CONVERSATION_IDENTITY_CAPABILITY, ProviderConversationIdentityProjection,
        ProviderConversationIdentitySource,
    };
    use terminal_state_protocol::encode_record;

    let runtime_state = |revision, observed_through_output_seq| AgentRuntimeStateProjection {
        terminal_epoch: "terminal-1".into(),
        revision,
        observed_through_output_seq,
        lifecycle: AgentRuntimeLifecycle::Running,
        activity: if revision == 7 {
            AgentRuntimeActivity::Working
        } else {
            AgentRuntimeActivity::Waiting
        },
        attention: AgentRuntimeAttention::None,
        attention_id: None,
        source: AgentRuntimeStateSource::ProviderEvent,
        turn_completed_count: revision - 7,
    };
    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
        AGENT_RUNTIME_STATE_CAPABILITY,
        PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 2,
                body: FrameBody::AgentRuntimeState(runtime_state(7, 1)),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(3, &viewport_seed_record()).unwrap(),
    );

    // A typed Host report can win publish_order while the asynchronous
    // viewport worker is still encoding the frame that includes its output
    // observation. Keep only the newest runtime revision and the one immutable
    // identity until that complete frame is installed.
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 4,
                body: FrameBody::AgentRuntimeState(runtime_state(8, 2)),
            })
            .unwrap(),
    )
    .unwrap();
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 5,
                body: FrameBody::ProviderConversationIdentity(
                    ProviderConversationIdentityProjection {
                        fence: fence(),
                        revision: 1,
                        observed_through_output_seq: 2,
                        provider_id: "codex".into(),
                        conversation_id: "conversation-opaque".into(),
                        source: ProviderConversationIdentitySource::ProviderEvent,
                    },
                ),
            })
            .unwrap(),
    )
    .unwrap();
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 6,
                body: FrameBody::AgentRuntimeState(runtime_state(9, 2)),
            })
            .unwrap(),
    )
    .unwrap();
    let live_viewport_parts =
        viewport_frame_parts(&multipart_viewport_replacement(), b"semantic-catchup-batch");
    assert_eq!(live_viewport_parts.len(), 2);
    for part in &live_viewport_parts {
        write_opaque_payload(&mut host, part);
    }

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    let mut surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    for expected in &live_viewport_parts {
        let crate::ConnectionRecord::TerminalState(delivered_viewport) =
            surface.read_delivery_record().unwrap()
        else {
            panic!("all parts of the matching complete viewport must be released first");
        };
        assert_eq!(&delivered_viewport, expected);
    }

    let crate::ConnectionRecord::Control(identity) = surface.read_delivery_record().unwrap() else {
        panic!("the staged identity must remain typed");
    };
    let FrameBody::ProviderConversationIdentity(identity) = *identity else {
        panic!("the latest surviving FIFO control must be the immutable identity");
    };
    assert_eq!(identity.observed_through_output_seq, 2);
    assert_eq!(identity.conversation_id, "conversation-opaque");

    let crate::ConnectionRecord::Control(runtime) = surface.read_delivery_record().unwrap() else {
        panic!("the staged runtime state must remain typed");
    };
    let FrameBody::AgentRuntimeState(runtime) = *runtime else {
        panic!("the latest runtime control was replaced");
    };
    assert_eq!(runtime.revision, 9);
    assert_eq!(runtime.observed_through_output_seq, 2);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn viewport_attach_does_not_require_legacy_snapshot_or_output_capabilities() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };
    use terminal_state_protocol::encode_record;

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    let surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    assert_eq!(surface.current_frame().text(), "x\n");

    let hello = host.read_frame(&codec()).unwrap().unwrap();
    let FrameBody::Hello(hello) = &hello.frame().body else {
        panic!("surface attach did not send Hello");
    };
    assert!(
        !hello
            .requested_capabilities
            .iter()
            .any(|capability| capability == "screen_snapshot" || capability == "live_output"),
        "a viewport attach must not ask the Host for the retired raw snapshot/output path"
    );
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn semantic_input_builder_always_selects_a_viewport_projection() {
    use hmux_runtime_contract::{
        TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_MULTIPART_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };

    let options =
        ConnectionOptions::new(LocalAttachRole::Observer, None).with_terminal_input_intents();
    let profile = attach_capability_profile(&options);

    for required in [
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_INPUT_INTENT_CAPABILITY,
    ] {
        assert!(
            profile
                .requested
                .iter()
                .any(|capability| capability == required),
            "semantic input must request the complete viewport profile: missing {required}"
        );
        assert!(
            profile.required.contains(&required),
            "semantic input must require the complete viewport profile: missing {required}"
        );
    }
    for additive in [
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
        TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
    ] {
        assert!(
            !profile
                .requested
                .iter()
                .any(|capability| capability == additive),
            "semantic input must not imply the independent {additive} permission"
        );
        assert!(!profile.required.contains(&additive));
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn an_unsolicited_prompt_selection_never_mints_a_writer_capability() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };
    use hmux_session_protocol::AGENT_PROMPT_CAPABILITY;
    use terminal_state_protocol::encode_record;

    let (client, mut host) = MemoryEndpoint::pair();
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(hello_ack(&[
                    TERMINAL_STATE_BINARY_CAPABILITY,
                    TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                    AGENT_PROMPT_CAPABILITY,
                ])),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    assert!(connection.supports(AGENT_PROMPT_CAPABILITY));
    assert!(connection.terminal_input_writer_capability().is_none());
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn an_agent_prompt_attach_requires_one_selected_prompt_lane() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };
    use terminal_state_protocol::encode_record;

    let (client, mut host) = MemoryEndpoint::pair();
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(hello_ack(&[
                    TERMINAL_STATE_BINARY_CAPABILITY,
                    TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                ])),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );
    let shared = SharedEndpoint::new(client);
    let transport = AttachedTransport::relayed(
        Box::new(shared.clone()),
        Box::new(shared.clone()),
        Arc::new(shared),
    );

    let error = LocalConnection::attach_over_transport(
        transport,
        fence(),
        "attach-secret".to_string(),
        crate::TerminalSurfaceAttachment::agent_prompt_connection_options(Some(
            "managed-grant".to_string(),
        )),
    )
    .expect_err("an agent-prompt attach must fail before returning without either wire lane");
    assert!(matches!(
        error,
        ClientError::MissingCapability {
            capability: hmux_session_protocol::AGENT_PROMPT_CAPABILITY,
        }
    ));
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn default_color_builder_is_always_a_semantic_writer() {
    use hmux_runtime_contract::{
        TERMINAL_DEFAULT_COLORS_CAPABILITY, TERMINAL_INPUT_INTENT_CAPABILITY,
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };

    let options =
        ConnectionOptions::new(LocalAttachRole::Observer, None).with_terminal_default_colors();
    let profile = attach_capability_profile(&options);

    for required in [
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_INPUT_INTENT_CAPABILITY,
    ] {
        assert!(profile.required.contains(&required));
    }
    assert!(
        profile
            .requested
            .iter()
            .any(|capability| capability == TERMINAL_DEFAULT_COLORS_CAPABILITY)
    );
    assert!(
        !profile
            .required
            .contains(&TERMINAL_DEFAULT_COLORS_CAPABILITY)
    );
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn viewport_stream_refuses_a_legacy_snapshot_record_after_attach() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };
    use terminal_state_protocol::{decode_record, encode_record};

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );

    let fixture =
        include_bytes!("../../../terminal-state-protocol/fixtures/terminal-state-current-v1.bin");
    let mut snapshot = decode_record(fixture).unwrap().record;
    snapshot.terminal_epoch = fence().terminal_epoch;
    snapshot.through_output_seq = 2;
    snapshot.state_revision = 2;
    write_opaque_payload(&mut host, &encode_record(3, &snapshot).unwrap());

    let mut connection =
        terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    let error = connection
        .read_record()
        .expect_err("the removed snapshot stream must not re-enter through live delivery");
    assert_eq!(error.code(), "hmux_inconsistent_stream");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn projection_only_surface_has_no_semantic_input_path() {
    let mut surface = terminal_surface_with_live_payloads(&[]);

    let result = surface.send_text_confirmed("blocked".into(), Duration::from_millis(10));
    let Err(error) = result else {
        panic!("projection-only attach must not mint a PTY writer");
    };

    assert!(matches!(
        error,
        ClientError::MissingCapability {
            capability: hmux_runtime_contract::TERMINAL_INPUT_INTENT_CAPABILITY,
        }
    ));
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn semantic_terminal_writer_is_relay_safe_without_controller_or_shared_input() {
    use hmux_runtime_contract::{
        TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY, TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use terminal_state_protocol::encode_record;

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
        TERMINAL_INPUT_INTENT_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );
    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::Writer);
    let surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    assert_eq!(surface.current_frame().text(), "x\n");

    let hello = host.read_frame(&codec()).unwrap().unwrap();
    let FrameBody::Hello(hello) = &hello.frame().body else {
        panic!("surface attach did not send Hello");
    };
    assert_eq!(hello.requested_mode, AttachMode::Observer);
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|value| value == TERMINAL_INPUT_INTENT_CAPABILITY)
    );
    assert!(
        !hello
            .requested_capabilities
            .iter()
            .any(|value| value == SHARED_TERMINAL_INPUT_CAPABILITY)
    );
    assert!(
        !hello
            .requested_capabilities
            .iter()
            .any(|value| value == "terminal_input")
    );
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_installs_one_frame_only_after_the_complete_multipart_batch() {
    let replacement = multipart_viewport_replacement();
    let parts = viewport_frame_parts(&replacement, b"complete-batch");
    assert_eq!(parts.len(), 2);
    let mut surface = terminal_surface_with_live_payloads(&parts);
    assert_eq!(surface.current_frame().viewport().projection_revision, 1);

    let crate::TerminalSurfaceEvent::Frame(installed) = surface.read_event().unwrap() else {
        panic!("the complete multipart batch did not produce one viewport frame");
    };
    assert_eq!(installed.viewport().projection_revision, 2);
    assert_eq!(installed.viewport().title, "multipart-installed");
    assert_eq!(surface.current_frame().viewport().projection_revision, 2);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_collapses_already_buffered_replaceable_viewports_to_latest() {
    use terminal_state_protocol::{decode_record, encode_record, terminal_state_record};

    let payloads = (2..=4)
        .map(|revision| {
            let mut record = viewport_seed_record();
            record.through_output_seq = revision;
            record.state_revision = revision;
            let Some(terminal_state_record::Body::ViewportFrame(frame)) = record.body.as_mut()
            else {
                unreachable!()
            };
            frame.projection_revision = revision;
            frame.applied_intent_seq = revision;
            frame.title = format!("revision-{revision}");
            encode_record(revision, &record).unwrap()
        })
        .collect::<Vec<_>>();
    let mut surface = terminal_surface_with_live_payloads(&payloads);

    let ConnectionRecord::TerminalState(latest) = surface.read_delivery_record().unwrap() else {
        panic!("buffered viewport delivery produced a control record");
    };
    let latest = decode_record(&latest).unwrap();
    let Some(terminal_state_record::Body::ViewportFrame(latest)) = latest.record.body else {
        panic!("buffered viewport delivery produced a non-viewport record");
    };

    assert_eq!(latest.projection_revision, 4);
    assert_eq!(latest.title, "revision-4");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_keeps_a_candidate_before_nonreplaceables_without_a_replacement() {
    use terminal_state_protocol::{
        InputReceipt, InputWrittenToPty, TerminalStateRecord, decode_record, encode_record,
        input_receipt, terminal_state_record,
    };

    let viewport = encode_record(2, &viewport_record_at(2, "candidate")).unwrap();
    let receipt = encode_record(
        3,
        &TerminalStateRecord {
            schema_minor: 4,
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: 2,
            state_revision: 2,
            body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
                in_reply_to_record_id: 9,
                outcome: Some(input_receipt::Outcome::WrittenToPty(
                    InputWrittenToPty::default(),
                )),
            })),
        },
    )
    .unwrap();
    let mut surface = terminal_surface_with_live_payloads(&[viewport, receipt]);

    let ConnectionRecord::TerminalState(first) = surface.read_delivery_record().unwrap() else {
        panic!("candidate viewport became a control record");
    };
    assert!(matches!(
        decode_record(&first).unwrap().record.body,
        Some(terminal_state_record::Body::ViewportFrame(_))
    ));
    let ConnectionRecord::TerminalState(second) = surface.read_delivery_record().unwrap() else {
        panic!("input receipt became a control record");
    };
    assert!(matches!(
        decode_record(&second).unwrap().record.body,
        Some(terminal_state_record::Body::InputReceipt(_))
    ));
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_replaces_viewports_across_fifo_receipts_and_events() {
    use terminal_state_protocol::{
        BellEvent, InputReceipt, InputWrittenToPty, TerminalEvent, TerminalStateRecord,
        decode_record, encode_record, input_receipt, terminal_event, terminal_state_record,
    };

    let viewport_two = encode_record(2, &viewport_record_at(2, "obsolete")).unwrap();
    let receipt = encode_record(
        3,
        &TerminalStateRecord {
            schema_minor: 4,
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: 2,
            state_revision: 2,
            body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
                in_reply_to_record_id: 9,
                outcome: Some(input_receipt::Outcome::WrittenToPty(
                    InputWrittenToPty::default(),
                )),
            })),
        },
    )
    .unwrap();
    let event = encode_record(
        4,
        &TerminalStateRecord {
            schema_minor: 4,
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: 2,
            state_revision: 2,
            body: Some(terminal_state_record::Body::Event(TerminalEvent {
                event_id: 7,
                event: Some(terminal_event::Event::Bell(BellEvent {})),
            })),
        },
    )
    .unwrap();
    let viewport_three = encode_record(5, &viewport_record_at(3, "latest")).unwrap();
    let mut surface =
        terminal_surface_with_live_payloads(&[viewport_two, receipt, event, viewport_three]);

    let bodies = (0..3)
        .map(|_| {
            let ConnectionRecord::TerminalState(record) = surface.read_delivery_record().unwrap()
            else {
                panic!("terminal FIFO record became a control record");
            };
            decode_record(&record).unwrap().record.body
        })
        .collect::<Vec<_>>();
    assert!(matches!(
        bodies[0],
        Some(terminal_state_record::Body::InputReceipt(_))
    ));
    assert!(matches!(
        bodies[1],
        Some(terminal_state_record::Body::Event(_))
    ));
    let Some(terminal_state_record::Body::ViewportFrame(latest)) = &bodies[2] else {
        panic!("the latest viewport did not follow preserved nonreplaceables");
    };
    assert_eq!(latest.projection_revision, 3);
    assert_eq!(latest.title, "latest");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_never_replaces_a_viewport_across_exit() {
    use terminal_state_protocol::{decode_record, encode_record, terminal_state_record};

    let (mut surface, mut host) = terminal_surface_with_live_host();
    write_opaque_payload(
        &mut host,
        &encode_record(3, &viewport_record_at(2, "before-exit")).unwrap(),
    );
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 4,
                body: FrameBody::Exit(Exit {
                    final_output_seq: 2,
                    exit_code: Some(0),
                    platform_status: None,
                    reason: "test exit".into(),
                }),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(5, &viewport_record_at(3, "after-exit")).unwrap(),
    );

    let ConnectionRecord::TerminalState(before_exit) = surface.read_delivery_record().unwrap()
    else {
        panic!("the viewport before Exit was replaced");
    };
    let decoded = decode_record(&before_exit).unwrap();
    let Some(terminal_state_record::Body::ViewportFrame(before_exit)) = decoded.record.body else {
        panic!("the record before Exit was not a viewport");
    };
    assert_eq!(before_exit.title, "before-exit");
    let ConnectionRecord::Control(exit) = surface.read_delivery_record().unwrap() else {
        panic!("Exit did not remain the lifecycle boundary");
    };
    assert!(matches!(exit.as_ref(), FrameBody::Exit(_)));
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_releases_exact_multipart_records_only_as_a_complete_batch() {
    let replacement = multipart_viewport_replacement();
    let parts = viewport_frame_parts(&replacement, b"delivery-batch");
    let mut surface = terminal_surface_with_live_payloads(&parts);

    for expected in &parts {
        let ConnectionRecord::TerminalState(actual) = surface.read_delivery_record().unwrap()
        else {
            panic!("multipart delivery produced a control record");
        };
        assert_eq!(&actual, expected);
    }
    assert_eq!(surface.current_frame().viewport().projection_revision, 2);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_replaces_only_whole_buffered_multipart_batches() {
    let obsolete = viewport_record_at(2, "obsolete-multipart");
    let latest = viewport_record_at(3, "latest-multipart");
    let obsolete_parts = viewport_frame_parts(&obsolete, b"obsolete-batch");
    let latest_parts = viewport_frame_parts(&latest, b"latest-batch");
    let payloads = obsolete_parts
        .iter()
        .chain(&latest_parts)
        .cloned()
        .collect::<Vec<_>>();
    let mut surface = terminal_surface_with_live_payloads(&payloads);

    for expected in &latest_parts {
        let ConnectionRecord::TerminalState(actual) = surface.read_delivery_record().unwrap()
        else {
            panic!("multipart delivery produced a control record");
        };
        assert_eq!(&actual, expected);
    }
    assert_eq!(surface.current_frame().viewport().projection_revision, 3);
    assert_eq!(surface.current_frame().viewport().title, "latest-multipart");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_finishes_a_started_multipart_batch_before_replacement() {
    let emitted = viewport_frame_parts(
        &viewport_record_at(2, "already-started"),
        b"already-started-batch",
    );
    let later = viewport_frame_parts(&viewport_record_at(3, "later"), b"later-batch");
    assert_eq!(emitted.len(), 2);
    assert_eq!(later.len(), 2);
    let (mut surface, mut host) = terminal_surface_with_live_host();
    for part in &emitted {
        write_opaque_payload(&mut host, part);
    }

    let ConnectionRecord::TerminalState(first) = surface.read_delivery_record().unwrap() else {
        panic!("started multipart delivery produced a control record");
    };
    assert_eq!(first, emitted[0]);
    for part in &later {
        write_opaque_payload(&mut host, part);
    }

    let ConnectionRecord::TerminalState(second) = surface.read_delivery_record().unwrap() else {
        panic!("started multipart delivery produced a control record");
    };
    assert_eq!(second, emitted[1]);
    for expected in later {
        let ConnectionRecord::TerminalState(actual) = surface.read_delivery_record().unwrap()
        else {
            panic!("later multipart delivery produced a control record");
        };
        assert_eq!(actual, expected);
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_buffered_probe_never_waits_for_or_consumes_a_partial_next_payload() {
    use std::io::Write;
    use terminal_state_protocol::{decode_record, encode_record, terminal_state_record};

    let (mut surface, mut host) = terminal_surface_with_live_host();
    let candidate = encode_record(3, &viewport_record_at(2, "complete-current")).unwrap();
    let next = encode_record(4, &viewport_record_at(3, "partial-next")).unwrap();
    host.write_all(&framed_payload(&candidate)).unwrap();
    let next_framed = framed_payload(&next);
    let cut = 4 + next.len() / 2;
    host.write_all(&next_framed[..cut]).unwrap();

    let ConnectionRecord::TerminalState(current) = surface.read_delivery_record().unwrap() else {
        panic!("the complete current viewport became a control record");
    };
    let current = decode_record(&current).unwrap();
    let Some(terminal_state_record::Body::ViewportFrame(current)) = current.record.body else {
        panic!("the complete current record was not a viewport");
    };
    assert_eq!(current.title, "complete-current");

    host.write_all(&next_framed[cut..]).unwrap();
    let ConnectionRecord::TerminalState(next) = surface.read_delivery_record().unwrap() else {
        panic!("the completed next viewport became a control record");
    };
    let next = decode_record(&next).unwrap();
    let Some(terminal_state_record::Body::ViewportFrame(next)) = next.record.body else {
        panic!("the completed next record was not a viewport");
    };
    assert_eq!(next.title, "partial-next");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_defers_eof_until_after_the_complete_candidate() {
    use terminal_state_protocol::{decode_record, encode_record, terminal_state_record};

    let (mut surface, mut host) = terminal_surface_with_live_host();
    write_opaque_payload(
        &mut host,
        &encode_record(3, &viewport_record_at(2, "before-eof")).unwrap(),
    );
    host.close_write().unwrap();

    let ConnectionRecord::TerminalState(candidate) = surface.read_delivery_record().unwrap() else {
        panic!("the complete candidate became a control record");
    };
    let candidate = decode_record(&candidate).unwrap();
    let Some(terminal_state_record::Body::ViewportFrame(candidate)) = candidate.record.body else {
        panic!("the candidate before EOF was not a viewport");
    };
    assert_eq!(candidate.title, "before-eof");
    assert_eq!(
        surface.read_delivery_record().unwrap_err().code(),
        "hmux_transport_closed"
    );
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_defers_an_invalid_partial_multipart_after_the_candidate() {
    use terminal_state_protocol::{
        BellEvent, TerminalEvent, TerminalStateRecord, encode_record, terminal_event,
        terminal_state_record,
    };

    let candidate = encode_record(3, &viewport_record_at(2, "complete-before-invalid")).unwrap();
    let parts = viewport_frame_parts(&viewport_record_at(3, "never-completes"), b"partial-batch");
    let event = encode_record(
        40,
        &TerminalStateRecord {
            schema_minor: 4,
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: 3,
            state_revision: 3,
            body: Some(terminal_state_record::Body::Event(TerminalEvent {
                event_id: 11,
                event: Some(terminal_event::Event::Bell(BellEvent {})),
            })),
        },
    )
    .unwrap();
    let mut surface =
        terminal_surface_with_live_payloads(&[candidate.clone(), parts[0].clone(), event]);

    let ConnectionRecord::TerminalState(delivered) = surface.read_delivery_record().unwrap() else {
        panic!("the complete candidate became a control record");
    };
    assert_eq!(delivered, candidate);
    assert_eq!(
        surface.read_delivery_record().unwrap_err().code(),
        "terminal_viewport_frame_parts_invalid"
    );
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_lookahead_has_a_deterministic_record_cap() {
    use terminal_state_protocol::{decode_record, encode_record, terminal_state_record};

    let payloads = (2..=67)
        .map(|revision| {
            encode_record(
                revision,
                &viewport_record_at(revision, &format!("revision-{revision}")),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let mut surface = terminal_surface_with_live_payloads(&payloads);

    let revisions = (0..2)
        .map(|_| {
            let ConnectionRecord::TerminalState(record) = surface.read_delivery_record().unwrap()
            else {
                panic!("buffered viewport became a control record");
            };
            let decoded = decode_record(&record).unwrap();
            let Some(terminal_state_record::Body::ViewportFrame(frame)) = decoded.record.body
            else {
                panic!("buffered record was not a viewport");
            };
            frame.projection_revision
        })
        .collect::<Vec<_>>();
    assert_eq!(revisions, [66, 67]);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_bounds_actual_direct_payload_bytes_consumed_per_pull() {
    use hmux_session_protocol::DEFAULT_MAX_FRAME_BYTES;
    use terminal_state_protocol::{
        MAX_VIEWPORT_FRAME_BYTES, decode_record, encode_record, terminal_state_record,
    };

    let payloads = (2..=9)
        .map(|revision| encode_record(revision, &padded_viewport_record_at(revision, 850)).unwrap())
        .collect::<Vec<_>>();
    assert!(payloads.iter().all(|payload| {
        payload.len() > DEFAULT_MAX_FRAME_BYTES / 2 && payload.len() <= DEFAULT_MAX_FRAME_BYTES
    }));
    let mut consumed = 0;
    let mut expected_revision = 2;
    for (revision, payload) in (3..=9).zip(&payloads[1..]) {
        if consumed > MAX_VIEWPORT_FRAME_BYTES {
            break;
        }
        consumed += payload.len();
        expected_revision = revision;
    }
    assert!(consumed <= MAX_VIEWPORT_FRAME_BYTES + DEFAULT_MAX_FRAME_BYTES);
    assert!(expected_revision < 9, "fixture must exceed one pull budget");
    let mut surface = terminal_surface_with_live_payloads(&payloads);

    let ConnectionRecord::TerminalState(record) = surface.read_delivery_record().unwrap() else {
        panic!("large buffered viewport became a control record");
    };
    let decoded = decode_record(&record).unwrap();
    let Some(terminal_state_record::Body::ViewportFrame(frame)) = decoded.record.body else {
        panic!("large buffered record was not a viewport");
    };
    assert_eq!(frame.projection_revision, expected_revision);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_replaces_a_near_limit_multipart_candidate_before_emission() {
    use hmux_session_protocol::DEFAULT_MAX_FRAME_BYTES;
    use terminal_state_protocol::MAX_VIEWPORT_FRAME_BYTES;

    let obsolete = padded_viewport_record_at(2, 4064);
    let latest = padded_viewport_record_at(3, 4064);
    let obsolete_parts = viewport_frame_parts_at(&obsolete, b"near-limit-old", 100, 256 * 1024);
    let latest_parts = viewport_frame_parts_at(&latest, b"near-limit-new", 200, 256 * 1024);
    let obsolete_bytes = obsolete_parts.iter().map(Vec::len).sum::<usize>();
    assert!(
        obsolete_bytes > MAX_VIEWPORT_FRAME_BYTES,
        "fixture raw multipart batch ({obsolete_bytes}) must exceed the retained-byte threshold"
    );
    let latest_bytes = latest_parts.iter().map(Vec::len).sum::<usize>();
    assert!(
        latest_bytes <= MAX_VIEWPORT_FRAME_BYTES + DEFAULT_MAX_FRAME_BYTES,
        "new multipart batch must fit one incremental lookahead byte budget"
    );
    assert!(latest_parts.len() < 64);
    let payloads = obsolete_parts
        .iter()
        .chain(&latest_parts)
        .cloned()
        .collect::<Vec<_>>();
    let mut surface = terminal_surface_with_live_payloads(&payloads);

    for (part_index, expected) in latest_parts.iter().enumerate() {
        let ConnectionRecord::TerminalState(actual) = surface.read_delivery_record().unwrap()
        else {
            panic!("near-limit multipart delivery became a control record");
        };
        assert_eq!(actual.len(), expected.len());
        assert!(
            &actual == expected,
            "near-limit multipart part {part_index} was not the latest batch"
        );
        let expected_remaining = latest_parts[part_index + 1..]
            .iter()
            .map(Vec::len)
            .sum::<usize>();
        assert_eq!(
            surface.buffered_delivery_usage_for_test(),
            if expected_remaining == 0 {
                (0, 0)
            } else {
                (1, expected_remaining)
            },
            "only the remaining latest multipart records may stay staged"
        );
    }
    assert_eq!(surface.current_frame().viewport().projection_revision, 3);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_counts_hidden_future_controls_against_the_pull_cap() {
    use hmux_session_protocol::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
        AgentRuntimeStateProjection, AgentRuntimeStateSource,
    };
    use terminal_state_protocol::{decode_record, encode_record, terminal_state_record};

    let (mut surface, mut host, probes) = terminal_surface_with_counted_buffered_probes();
    write_opaque_payload(
        &mut host,
        &encode_record(3, &viewport_record_at(2, "bounded-current")).unwrap(),
    );
    for revision in 1..=70 {
        host.write_frame(
            &codec()
                .encode(&WireFrame {
                    protocol_version: PROTOCOL_V1,
                    frame_id: 10 + revision,
                    body: FrameBody::AgentRuntimeState(AgentRuntimeStateProjection {
                        terminal_epoch: fence().terminal_epoch,
                        revision,
                        observed_through_output_seq: 3,
                        lifecycle: AgentRuntimeLifecycle::Running,
                        activity: AgentRuntimeActivity::Working,
                        attention: AgentRuntimeAttention::None,
                        attention_id: None,
                        source: AgentRuntimeStateSource::ProviderEvent,
                        turn_completed_count: 0,
                    }),
                })
                .unwrap(),
        )
        .unwrap();
    }
    write_opaque_payload(
        &mut host,
        &encode_record(100, &viewport_record_at(3, "beyond-cap")).unwrap(),
    );

    let ConnectionRecord::TerminalState(record) = surface.read_delivery_record().unwrap() else {
        panic!("bounded current viewport became a control record");
    };
    let decoded = decode_record(&record).unwrap();
    let Some(terminal_state_record::Body::ViewportFrame(frame)) = decoded.record.body else {
        panic!("bounded current record was not a viewport");
    };
    assert_eq!(
        probes.load(std::sync::atomic::Ordering::SeqCst),
        64,
        "hidden semantic controls must consume one bounded lookahead step each"
    );
    assert_eq!(frame.projection_revision, 2);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_resumes_bounded_lookahead_only_from_a_front_viewport() {
    use terminal_state_protocol::{
        InputReceipt, InputWrittenToPty, TerminalStateRecord, decode_record, encode_record,
        input_receipt, terminal_state_record,
    };

    fn write_viewport(host: &mut MemoryEndpoint, next_record_id: &mut u64, revision: u64) -> usize {
        let encoded = encode_record(
            *next_record_id,
            &viewport_record_at(revision, &format!("revision-{revision}")),
        )
        .unwrap();
        *next_record_id += 1;
        write_opaque_payload(host, &encoded);
        encoded.len()
    }

    fn write_receipt(host: &mut MemoryEndpoint, next_record_id: &mut u64, revision: u64) {
        let encoded = encode_record(
            *next_record_id,
            &TerminalStateRecord {
                schema_minor: 4,
                terminal_epoch: fence().terminal_epoch,
                through_output_seq: revision,
                state_revision: revision,
                body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
                    in_reply_to_record_id: *next_record_id,
                    outcome: Some(input_receipt::Outcome::WrittenToPty(
                        InputWrittenToPty::default(),
                    )),
                })),
            },
        )
        .unwrap();
        *next_record_id += 1;
        write_opaque_payload(host, &encoded);
    }

    let (mut surface, mut host) = terminal_surface_with_live_host();
    let mut next_record_id = 3;

    write_viewport(&mut host, &mut next_record_id, 2);
    write_receipt(&mut host, &mut next_record_id, 2);
    let mut latest_bytes = write_viewport(&mut host, &mut next_record_id, 3);

    for revision in 3..=34 {
        let ConnectionRecord::TerminalState(record) = surface.read_delivery_record().unwrap()
        else {
            panic!("interleaved receipt became a control record");
        };
        assert!(matches!(
            decode_record(&record).unwrap().record.body,
            Some(terminal_state_record::Body::InputReceipt(_))
        ));
        assert_eq!(
            surface.buffered_delivery_usage_for_test(),
            (1, latest_bytes),
            "only the un-emitted latest viewport may remain staged"
        );
        if revision < 34 {
            write_receipt(&mut host, &mut next_record_id, revision);
            latest_bytes = write_viewport(&mut host, &mut next_record_id, revision + 1);
        }
    }

    let ConnectionRecord::TerminalState(record) = surface.read_delivery_record().unwrap() else {
        panic!("latest viewport became a control record");
    };
    let decoded = decode_record(&record).unwrap();
    let Some(terminal_state_record::Body::ViewportFrame(frame)) = decoded.record.body else {
        panic!("the final buffered record was not a viewport");
    };
    assert_eq!(frame.projection_revision, 34);
    assert_eq!(surface.buffered_delivery_usage_for_test(), (0, 0));
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_never_builds_lookahead_behind_a_front_nonreplaceable() {
    use terminal_state_protocol::{
        InputReceipt, InputWrittenToPty, TerminalStateRecord, decode_record, encode_record,
        input_receipt, terminal_state_record,
    };

    let receipt = |record_id, revision| {
        encode_record(
            record_id,
            &TerminalStateRecord {
                schema_minor: 4,
                terminal_epoch: fence().terminal_epoch,
                through_output_seq: revision,
                state_revision: revision,
                body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
                    in_reply_to_record_id: record_id,
                    outcome: Some(input_receipt::Outcome::WrittenToPty(
                        InputWrittenToPty::default(),
                    )),
                })),
            },
        )
        .unwrap()
    };
    let payloads = [
        receipt(3, 1),
        encode_record(4, &viewport_record_at(2, "obsolete")).unwrap(),
        receipt(5, 2),
        encode_record(6, &viewport_record_at(3, "latest")).unwrap(),
    ];
    let mut surface = terminal_surface_with_live_payloads(&payloads);

    let ConnectionRecord::TerminalState(first) = surface.read_delivery_record().unwrap() else {
        panic!("front receipt became a control record");
    };
    assert!(matches!(
        decode_record(&first).unwrap().record.body,
        Some(terminal_state_record::Body::InputReceipt(_))
    ));
    assert_eq!(
        surface.buffered_delivery_usage_for_test(),
        (0, 0),
        "lookahead must not accumulate behind a front nonreplaceable"
    );

    let ConnectionRecord::TerminalState(second) = surface.read_delivery_record().unwrap() else {
        panic!("interleaved receipt became a control record");
    };
    assert!(matches!(
        decode_record(&second).unwrap().record.body,
        Some(terminal_state_record::Body::InputReceipt(_))
    ));
    let ConnectionRecord::TerminalState(latest) = surface.read_delivery_record().unwrap() else {
        panic!("latest viewport became a control record");
    };
    let decoded = decode_record(&latest).unwrap();
    let Some(terminal_state_record::Body::ViewportFrame(frame)) = decoded.record.body else {
        panic!("the final record was not a viewport");
    };
    assert_eq!(frame.projection_revision, 3);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_delivery_interrupt_wins_over_a_buffered_candidate() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };
    use terminal_state_protocol::encode_record;

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );
    let shared = SharedEndpoint::new(client);
    let transport = AttachedTransport::relayed(
        Box::new(InterruptOnBufferedProbe(shared.clone())),
        Box::new(shared.clone()),
        Arc::new(shared),
    );
    let connection = LocalConnection::attach_over_transport(
        transport,
        fence(),
        "attach-secret".into(),
        crate::TerminalSurfaceAttachment::connection_options(
            crate::TerminalSurfaceAccess::ReadOnly,
            None,
        ),
    )
    .unwrap();
    let mut surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(3, &viewport_record_at(2, "must-not-win")).unwrap(),
    );

    assert_eq!(
        surface.read_delivery_record().unwrap_err().code(),
        "hmux_transport_interrupted"
    );
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_does_not_mix_binary_and_high_level_readers() {
    let replacement =
        terminal_state_protocol::encode_record(30, &multipart_viewport_replacement()).unwrap();
    let mut surface = terminal_surface_with_live_payloads(&[replacement]);

    let ConnectionRecord::TerminalState(_) = surface.read_delivery_record().unwrap() else {
        panic!("binary delivery produced a control record");
    };
    let error = surface
        .read_event()
        .expect_err("a second reader mode must not consume the connection");
    assert_eq!(error.code(), "hmux_terminal_surface_delivery_mode_changed");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_accepts_a_complete_multipart_frame_as_its_attach_seed() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY, TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };

    let replacement = multipart_viewport_replacement();
    let parts = viewport_frame_parts(&replacement, b"attach-seed");
    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
        TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
    ]);
    ack.current_output_seq = 2;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    for part in parts {
        write_opaque_payload(&mut host, &part);
    }

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    let surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    assert_eq!(surface.current_frame().viewport().projection_revision, 2);
    assert_eq!(
        surface.current_frame().viewport().title,
        "multipart-installed"
    );
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_rejects_missing_or_mixed_parts_without_installing_a_prefix() {
    use terminal_state_protocol::{
        BellEvent, TerminalEvent, TerminalStateRecord, encode_record, terminal_event,
        terminal_state_record,
    };

    let replacement = multipart_viewport_replacement();
    let first_batch = viewport_frame_parts(&replacement, b"batch-a");
    let second_batch = viewport_frame_parts(&replacement, b"batch-b");
    let event = encode_record(
        32,
        &TerminalStateRecord {
            schema_minor: 4,
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: 2,
            state_revision: 2,
            body: Some(terminal_state_record::Body::Event(TerminalEvent {
                event_id: 1,
                event: Some(terminal_event::Event::Bell(BellEvent {})),
            })),
        },
    )
    .unwrap();
    let cases = [
        vec![first_batch[0].clone(), event],
        vec![first_batch[0].clone(), second_batch[1].clone()],
    ];

    for payloads in cases {
        let mut surface = terminal_surface_with_live_payloads(&payloads);
        let error = surface
            .read_event()
            .expect_err("an incomplete or mixed multipart batch must fail closed");
        assert_eq!(error.code(), "terminal_viewport_frame_parts_invalid");
        assert_eq!(surface.current_frame().viewport().projection_revision, 1);
        assert_eq!(surface.current_frame().viewport().title, "surface");
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn terminal_surface_binary_delivery_never_releases_an_interrupted_part_prefix() {
    use terminal_state_protocol::{
        BellEvent, TerminalEvent, TerminalStateRecord, encode_record, terminal_event,
        terminal_state_record,
    };

    let replacement = multipart_viewport_replacement();
    let parts = viewport_frame_parts(&replacement, b"interrupted-delivery");
    let event = encode_record(
        32,
        &TerminalStateRecord {
            schema_minor: 4,
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: 2,
            state_revision: 2,
            body: Some(terminal_state_record::Body::Event(TerminalEvent {
                event_id: 1,
                event: Some(terminal_event::Event::Bell(BellEvent {})),
            })),
        },
    )
    .unwrap();
    let mut surface = terminal_surface_with_live_payloads(&[parts[0].clone(), event]);

    let error = surface
        .read_delivery_record()
        .expect_err("an interrupted multipart prefix must not reach the binary consumer");
    assert_eq!(error.code(), "terminal_viewport_frame_parts_invalid");
    assert_eq!(surface.current_frame().viewport().projection_revision, 1);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn transport_loss_after_possible_semantic_input_is_outcome_unknown_and_not_retried() {
    use hmux_runtime_contract::{
        TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY, TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use hmux_session_protocol::transport::FrameReader;
    use std::thread;
    use terminal_state_protocol::{encode_record, input_intent, terminal_state_record};

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
        TERMINAL_INPUT_INTENT_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::Writer);
    let mut surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let host_task = thread::spawn(move || {
        let hello = host.read_frame(&codec()).unwrap().unwrap();
        assert!(matches!(hello.frame().body, FrameBody::Hello(_)));
        let encoded = host.read_payload(&codec()).unwrap().unwrap();
        let decoded = terminal_state_protocol::decode_record(&encoded).unwrap();
        let Some(terminal_state_record::Body::InputIntent(intent)) = decoded.record.body else {
            panic!("surface did not send semantic input");
        };
        let Some(input_intent::Intent::Text(text)) = intent.intent else {
            panic!("surface did not send semantic text");
        };
        assert_eq!(decoded.metadata.record_id, 1);
        assert_eq!(text.utf8, "안녕".as_bytes());
        host.close_write().unwrap();
        1_usize
    });

    let error = match surface.send_text_confirmed("안녕".into(), Duration::from_secs(1)) {
        Ok(_) => panic!("transport loss must not report a known input outcome"),
        Err(error) => error,
    };
    assert_eq!(error.code(), "hmux_terminal_input_outcome_unknown");
    assert_eq!(host_task.join().unwrap(), 1);
}

#[cfg(feature = "terminal-state-stream")]
fn agent_prompt_surface() -> (crate::TerminalSurfaceAttachment, PeerNotifyingEndpoint) {
    use hmux_session_protocol::{
        AGENT_PROMPT_CAPABILITY, PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
    };

    agent_prompt_surface_with_capabilities([
        AGENT_PROMPT_CAPABILITY,
        PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
    ])
}

#[cfg(feature = "terminal-state-stream")]
fn agent_prompt_surface_with_capabilities(
    prompt_capabilities: impl IntoIterator<Item = &'static str>,
) -> (crate::TerminalSurfaceAttachment, PeerNotifyingEndpoint) {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    };
    use hmux_session_protocol::{AGENT_PROMPT_CAPABILITY, LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY};
    use terminal_state_protocol::encode_record;

    let prompt_capabilities = prompt_capabilities.into_iter().collect::<Vec<_>>();
    let legacy_only = prompt_capabilities.contains(&LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY)
        && !prompt_capabilities.contains(&AGENT_PROMPT_CAPABILITY);
    let (client, mut host) = MemoryEndpoint::pair();
    let mut capabilities = vec![
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    ];
    capabilities.extend(prompt_capabilities);
    let mut ack = hello_ack(&capabilities);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );

    let shared = SharedEndpoint::new(client);
    let (readable, readable_wait) = std::sync::mpsc::channel();
    let transport = AttachedTransport::relayed(
        Box::new(PeerNotifiedReader {
            endpoint: shared.clone(),
            readable: readable_wait,
        }),
        Box::new(shared.clone()),
        Arc::new(shared),
    );
    let mut options = crate::TerminalSurfaceAttachment::agent_prompt_connection_options(Some(
        "managed-grant".to_string(),
    ));
    if legacy_only {
        options = options.with_legacy_agent_prompt_fallback();
    }
    let connection = LocalConnection::attach_over_transport(
        transport,
        fence(),
        "attach-secret".to_string(),
        options,
    )
    .unwrap();
    (
        crate::TerminalSurfaceAttachment::from_connection(connection).unwrap(),
        PeerNotifyingEndpoint {
            endpoint: host,
            readable,
        },
    )
}

#[cfg(feature = "terminal-state-stream")]
fn read_agent_prompt_payload(host: &mut PeerNotifyingEndpoint) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if let Some(payload) = host.try_read_complete_payload(&codec()).unwrap() {
            return payload;
        }
        assert!(
            Instant::now() < deadline,
            "agent prompt surface did not send its input envelope"
        );
        std::thread::yield_now();
    }
}

#[cfg(feature = "terminal-state-stream")]
fn write_agent_prompt_written_receipt(
    host: &mut PeerNotifyingEndpoint,
    record_id: u64,
    in_reply_to_record_id: u64,
    output_sequence: u64,
    state_revision: u64,
    agent_runtime_revision: Option<u64>,
) {
    use terminal_state_protocol::{
        InputReceipt, InputWrittenToPty, TerminalStateRecord, encode_record, input_receipt,
        terminal_state_record,
    };

    write_opaque_payload(
        host,
        &encode_record(
            record_id,
            &TerminalStateRecord {
                schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
                terminal_epoch: fence().terminal_epoch,
                through_output_seq: output_sequence,
                state_revision,
                body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
                    in_reply_to_record_id,
                    outcome: Some(input_receipt::Outcome::WrittenToPty(InputWrittenToPty {
                        input_baseline_output_sequence: Some(output_sequence),
                        agent_runtime_revision,
                    })),
                })),
            },
        )
        .unwrap(),
    );
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn fresh_agent_prompt_uses_full_protocol_admission_budget_in_one_record() {
    use hmux_runtime_contract::TERMINAL_INPUT_INTENT_CAPABILITY;
    use hmux_session_protocol::AGENT_PROMPT_CAPABILITY;
    use hmux_session_protocol::transport::FrameReader;
    use std::thread;
    use terminal_state_protocol::{agent_prompt_input_intent, input_intent, terminal_state_record};

    let (mut surface, mut host) = agent_prompt_surface();
    let host_task = thread::spawn(move || {
        let hello = host.read_frame(&codec()).unwrap().unwrap();
        let FrameBody::Hello(hello) = &hello.frame().body else {
            panic!("agent prompt surface did not begin with Hello");
        };
        for capability in [
            AGENT_PROMPT_CAPABILITY,
            hmux_session_protocol::PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
            hmux_session_protocol::LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
            hmux_session_protocol::AGENT_IDENTITY_PROJECTION_CAPABILITY,
            hmux_session_protocol::PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
            hmux_session_protocol::WORKING_DIRECTORY_FRAME_CAPABILITY,
        ] {
            assert!(
                hello
                    .requested_capabilities
                    .iter()
                    .any(|requested| requested == capability),
                "agent prompt profile omitted {capability}"
            );
        }
        assert!(
            !hello
                .requested_capabilities
                .iter()
                .any(|requested| requested == TERMINAL_INPUT_INTENT_CAPABILITY),
            "targeted prompt profile must not request generic terminal input"
        );
        assert!(hello.requested_capabilities.iter().any(|requested| {
            requested == hmux_session_protocol::MANAGED_AUTHORIZATION_GRANT_CAPABILITY
        }));
        let encoded = read_agent_prompt_payload(&mut host);
        let decoded = terminal_state_protocol::decode_record(&encoded).unwrap();
        assert_eq!(decoded.metadata.record_id, 1);
        let Some(terminal_state_record::Body::InputIntent(intent)) = decoded.record.body else {
            panic!("fresh prompt did not send an input intent");
        };
        let Some(input_intent::Intent::AgentPrompt(prompt)) = intent.intent else {
            panic!("fresh prompt was split into ordinary terminal input");
        };
        assert_eq!(prompt.utf8, "status".as_bytes());
        assert_eq!(prompt.admission_wait_ms, 10_000);
        let Some(agent_prompt_input_intent::Target::FreshAgent(_)) = prompt.target else {
            panic!("fresh prompt did not name a fresh-agent target");
        };
        write_agent_prompt_written_receipt(&mut host, 101, 1, 7, 2, Some(2));
        assert!(host.try_read_complete_payload(&codec()).unwrap().is_none());
    });

    let receipt = surface
        .send_fresh_agent_prompt_confirmed("status".into(), Duration::from_secs(30))
        .unwrap();
    assert_eq!(receipt.input().in_reply_to_record_id, 1);
    assert_eq!(receipt.input_baseline_output_sequence(), 7);
    assert_eq!(receipt.admitted_agent_runtime_revision(), Some(2));
    host_task.join().unwrap();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn process_observed_fresh_agent_prompt_uses_an_explicit_target() {
    use hmux_session_protocol::transport::FrameReader;
    use std::thread;
    use terminal_state_protocol::{agent_prompt_input_intent, input_intent, terminal_state_record};

    let (mut surface, mut host) = agent_prompt_surface();
    let host_task = thread::spawn(move || {
        let hello = host.read_frame(&codec()).unwrap().unwrap();
        assert!(matches!(hello.frame().body, FrameBody::Hello(_)));
        let encoded = read_agent_prompt_payload(&mut host);
        let decoded = terminal_state_protocol::decode_record(&encoded).unwrap();
        assert!(matches!(
            required_input_capability(&decoded.record),
            Ok(InputCapabilityRequirement::ProcessObservedAgentPrompt)
        ));
        let Some(terminal_state_record::Body::InputIntent(intent)) = decoded.record.body else {
            panic!("process-observed prompt did not send an input intent");
        };
        let Some(input_intent::Intent::AgentPrompt(prompt)) = intent.intent else {
            panic!("process-observed prompt used ordinary terminal input");
        };
        assert_eq!(prompt.utf8, b"status");
        assert_eq!(prompt.admission_wait_ms, 10_000);
        assert!(matches!(
            prompt.target,
            Some(agent_prompt_input_intent::Target::ProcessObservedFreshAgent(_))
        ));
        write_agent_prompt_written_receipt(
            &mut host,
            102,
            decoded.metadata.record_id,
            9,
            4,
            Some(4),
        );
        assert!(host.try_read_complete_payload(&codec()).unwrap().is_none());
    });

    let receipt = surface
        .send_process_observed_fresh_agent_prompt_confirmed(
            "status".into(),
            Duration::from_secs(30),
        )
        .unwrap();
    assert_eq!(receipt.input_baseline_output_sequence(), 9);
    assert_eq!(receipt.admitted_agent_runtime_revision(), Some(4));
    host_task.join().unwrap();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn process_observed_prompt_uses_the_fresh_target_on_an_older_targeted_host() {
    use hmux_session_protocol::AGENT_PROMPT_CAPABILITY;
    use hmux_session_protocol::transport::FrameReader;
    use std::thread;
    use terminal_state_protocol::{agent_prompt_input_intent, input_intent, terminal_state_record};

    let (mut surface, mut host) = agent_prompt_surface_with_capabilities([AGENT_PROMPT_CAPABILITY]);
    let host_task = thread::spawn(move || {
        let hello = host.read_frame(&codec()).unwrap().unwrap();
        assert!(matches!(hello.frame().body, FrameBody::Hello(_)));
        let encoded = read_agent_prompt_payload(&mut host);
        let decoded = terminal_state_protocol::decode_record(&encoded).unwrap();
        let Some(terminal_state_record::Body::InputIntent(intent)) = decoded.record.body else {
            panic!("compatible process-observed prompt did not send an input intent");
        };
        let Some(input_intent::Intent::AgentPrompt(prompt)) = intent.intent else {
            panic!("compatible process-observed prompt used ordinary terminal input");
        };
        assert!(matches!(
            prompt.target,
            Some(agent_prompt_input_intent::Target::FreshAgent(_))
        ));
        write_agent_prompt_written_receipt(
            &mut host,
            103,
            decoded.metadata.record_id,
            10,
            5,
            Some(5),
        );
    });

    let receipt = surface
        .send_process_observed_fresh_agent_prompt_confirmed(
            "status".into(),
            Duration::from_secs(30),
        )
        .unwrap();
    assert_eq!(receipt.input_baseline_output_sequence(), 10);
    assert_eq!(receipt.admitted_agent_runtime_revision(), Some(5));
    host_task.join().unwrap();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn fresh_agent_prompt_falls_back_to_the_legacy_live_host_capability() {
    use hmux_runtime_contract::TERMINAL_INPUT_INTENT_CAPABILITY;
    use hmux_session_protocol::LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY;
    use hmux_session_protocol::transport::FrameReader;
    use std::thread;
    use terminal_state_protocol::{
        InputReceipt, InputWrittenToPty, TerminalStateRecord, agent_prompt_input_intent,
        encode_record, input_intent, input_receipt, terminal_state_record,
    };

    let (mut surface, mut host) = agent_prompt_surface_with_capabilities([
        TERMINAL_INPUT_INTENT_CAPABILITY,
        LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
    ]);
    let host_task = thread::spawn(move || {
        let hello = host.read_frame(&codec()).unwrap().unwrap();
        let FrameBody::Hello(hello) = &hello.frame().body else {
            panic!("legacy prompt surface did not begin with Hello");
        };
        assert!(
            hello
                .requested_capabilities
                .iter()
                .any(|requested| requested == TERMINAL_INPUT_INTENT_CAPABILITY),
            "legacy-only Host attach must request its generic input dependency"
        );
        let encoded = read_agent_prompt_payload(&mut host);
        let decoded = terminal_state_protocol::decode_record(&encoded).unwrap();
        let Some(terminal_state_record::Body::InputIntent(intent)) = decoded.record.body else {
            panic!("legacy fresh prompt did not send an input intent");
        };
        let Some(input_intent::Intent::AgentPrompt(prompt)) = intent.intent else {
            panic!("legacy fresh prompt was split into ordinary input");
        };
        assert!(matches!(
            prompt.target,
            Some(agent_prompt_input_intent::Target::FreshAgent(_))
        ));
        write_opaque_payload(
            &mut host,
            &encode_record(
                102,
                &TerminalStateRecord {
                    schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
                    terminal_epoch: fence().terminal_epoch,
                    through_output_seq: 8,
                    state_revision: 3,
                    body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
                        in_reply_to_record_id: 1,
                        outcome: Some(input_receipt::Outcome::WrittenToPty(InputWrittenToPty {
                            input_baseline_output_sequence: Some(8),
                            agent_runtime_revision: None,
                        })),
                    })),
                },
            )
            .unwrap(),
        );
    });

    let receipt = surface
        .send_fresh_agent_prompt_confirmed("status".into(), Duration::from_secs(1))
        .unwrap();
    assert_eq!(receipt.admitted_agent_runtime_revision(), None);
    let error = surface
        .send_command_input_confirmed("ordinary".into(), true, Duration::from_secs(1))
        .expect_err("the legacy transport dependency must not expose ordinary input");
    assert_eq!(error.code(), "hmux_capability_missing");
    assert_eq!(error.delivery_state(), "not_written");
    host_task.join().unwrap();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn targeted_agent_prompts_never_fall_back_to_the_legacy_capability() {
    use hmux_session_protocol::LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY;
    use hmux_session_protocol::transport::FrameReader;

    let (mut surface, mut host) =
        agent_prompt_surface_with_capabilities([LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY]);
    let expected = crate::ProviderConversationIdentitySeed::new("codex", "conversation-1").unwrap();
    let error = surface
        .send_existing_idle_agent_prompt_confirmed(
            "continue".into(),
            &expected,
            Duration::from_secs(1),
        )
        .expect_err("existing conversation requires the targeted capability");
    assert_eq!(error.code(), "hmux_capability_missing");
    assert_eq!(error.delivery_state(), "not_written");

    let error = surface
        .send_process_observed_fresh_agent_prompt_confirmed("start".into(), Duration::from_secs(1))
        .expect_err("process-observed fresh prompts require the targeted capability");
    assert_eq!(error.code(), "hmux_capability_missing");
    assert_eq!(error.delivery_state(), "not_written");

    assert!(matches!(
        host.read_frame(&codec()).unwrap().unwrap().frame().body,
        FrameBody::Hello(_)
    ));
    assert!(host.try_read_complete_payload(&codec()).unwrap().is_none());
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn existing_conversation_agent_prompt_carries_exact_identity_without_waiting() {
    use hmux_session_protocol::transport::FrameReader;
    use std::thread;
    use terminal_state_protocol::{
        InputReceipt, InputWrittenToPty, TerminalStateRecord, agent_prompt_input_intent,
        encode_record, input_intent, input_receipt, terminal_state_record,
    };

    let (mut surface, mut host) = agent_prompt_surface();
    let host_task = thread::spawn(move || {
        let hello = host.read_frame(&codec()).unwrap().unwrap();
        assert!(matches!(hello.frame().body, FrameBody::Hello(_)));
        let encoded = read_agent_prompt_payload(&mut host);
        let decoded = terminal_state_protocol::decode_record(&encoded).unwrap();
        let Some(terminal_state_record::Body::InputIntent(intent)) = decoded.record.body else {
            panic!("existing-conversation prompt did not send an input intent");
        };
        let Some(input_intent::Intent::AgentPrompt(prompt)) = intent.intent else {
            panic!("existing-conversation prompt used ordinary terminal input");
        };
        assert_eq!(prompt.utf8, b"continue");
        assert_eq!(prompt.admission_wait_ms, 0);
        let Some(agent_prompt_input_intent::Target::ExistingConversation(target)) = prompt.target
        else {
            panic!("existing-conversation prompt did not carry its exact target");
        };
        assert_eq!(target.expected_provider_id, "codex");
        assert_eq!(target.expected_conversation_id, "conversation-1");
        write_opaque_payload(
            &mut host,
            &encode_record(
                101,
                &TerminalStateRecord {
                    schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
                    terminal_epoch: fence().terminal_epoch,
                    through_output_seq: 8,
                    state_revision: 3,
                    body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
                        in_reply_to_record_id: decoded.metadata.record_id,
                        outcome: Some(input_receipt::Outcome::WrittenToPty(InputWrittenToPty {
                            input_baseline_output_sequence: Some(8),
                            agent_runtime_revision: Some(3),
                        })),
                    })),
                },
            )
            .unwrap(),
        );
    });

    let expected = crate::ProviderConversationIdentitySeed::new("codex", "conversation-1")
        .expect("fixture identity is valid");
    let receipt = surface
        .send_existing_idle_agent_prompt_confirmed(
            "continue".into(),
            &expected,
            Duration::from_secs(1),
        )
        .unwrap();
    assert_eq!(receipt.input_baseline_output_sequence(), 8);
    assert_eq!(receipt.admitted_agent_runtime_revision(), Some(3));
    host_task.join().unwrap();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn agent_prompt_only_attachment_rejects_ordinary_input_locally() {
    use hmux_session_protocol::transport::FrameReader;

    let (mut surface, mut host) = agent_prompt_surface();
    let error = surface
        .send_command_input_confirmed("ordinary input".into(), true, Duration::from_secs(1))
        .expect_err("a scoped prompt handle must not expose generic terminal writes");
    assert_eq!(error.code(), "hmux_capability_missing");
    assert_eq!(error.delivery_state(), "not_written");

    let hello = host.read_frame(&codec()).unwrap().unwrap();
    assert!(matches!(hello.frame().body, FrameBody::Hello(_)));
    assert!(host.try_read_complete_payload(&codec()).unwrap().is_none());
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn agent_prompt_only_attachment_rejects_raw_ordinary_input_before_wire() {
    use hmux_session_protocol::transport::FrameReader;
    use terminal_state_protocol::{
        InputIntent, TerminalStateRecord, TextInputIntent, encode_record_for_minor, input_intent,
        terminal_state_record,
    };

    let (surface, mut host) = agent_prompt_surface();
    let encoded = encode_record_for_minor(
        TERMINAL_STATE_BASE_PROTOCOL_MINOR,
        7,
        &TerminalStateRecord {
            schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: 1,
            state_revision: 1,
            body: Some(terminal_state_record::Body::InputIntent(InputIntent {
                intent: Some(input_intent::Intent::Text(TextInputIntent {
                    utf8: b"ordinary raw input".to_vec(),
                })),
            })),
        },
    )
    .unwrap();
    let error = surface
        .upstream_handles()
        .send_envelope(&encoded)
        .expect_err("a raw envelope must retain the attachment's semantic capability split");
    assert_eq!(error.code(), "hmux_capability_missing");

    let hello = host.read_frame(&codec()).unwrap().unwrap();
    assert!(matches!(hello.frame().body, FrameBody::Hello(_)));
    assert!(host.try_read_complete_payload(&codec()).unwrap().is_none());
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn fresh_agent_prompt_runtime_change_refusal_is_provably_not_written() {
    use hmux_session_protocol::transport::FrameReader;
    use std::thread;
    use terminal_state_protocol::{
        InputReceipt, InputRefusalReason, InputRefused, TerminalStateRecord, encode_record,
        input_receipt, terminal_state_record,
    };

    let (mut surface, mut host) = agent_prompt_surface();
    let host_task = thread::spawn(move || {
        let hello = host.read_frame(&codec()).unwrap().unwrap();
        assert!(matches!(hello.frame().body, FrameBody::Hello(_)));
        let _input = read_agent_prompt_payload(&mut host);
        write_opaque_payload(
            &mut host,
            &encode_record(
                101,
                &TerminalStateRecord {
                    schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
                    terminal_epoch: fence().terminal_epoch,
                    through_output_seq: 1,
                    state_revision: 2,
                    body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
                        in_reply_to_record_id: 1,
                        outcome: Some(input_receipt::Outcome::Refused(InputRefused {
                            reason: InputRefusalReason::AgentRuntimeChanged as i32,
                            detail: None,
                        })),
                    })),
                },
            )
            .unwrap(),
        );
    });

    let error = surface
        .send_fresh_agent_prompt_confirmed("status".into(), Duration::from_secs(1))
        .expect_err("a changed runtime must receive a final refusal");
    assert_eq!(error.code(), "hmux_agent_prompt_runtime_changed");
    assert_eq!(error.delivery_state(), "not_written");
    host_task.join().unwrap();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn fresh_agent_prompt_transport_loss_after_send_is_outcome_unknown() {
    use hmux_session_protocol::transport::FrameReader;
    use std::thread;

    let (mut surface, mut host) = agent_prompt_surface();
    let host_task = thread::spawn(move || {
        let hello = host.read_frame(&codec()).unwrap().unwrap();
        assert!(matches!(hello.frame().body, FrameBody::Hello(_)));
        let _input = read_agent_prompt_payload(&mut host);
        host.close_write().unwrap();
    });

    let error = surface
        .send_fresh_agent_prompt_confirmed("status".into(), Duration::from_secs(1))
        .expect_err("transport loss after send cannot prove the PTY outcome");
    assert_eq!(error.code(), "hmux_terminal_input_outcome_unknown");
    assert_eq!(error.delivery_state(), "unknown");
    host_task.join().unwrap();
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn command_input_keeps_paste_submit_enter_only_and_draft_as_semantic_intents() {
    use hmux_runtime_contract::{
        TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY, TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use hmux_session_protocol::transport::FrameReader;
    use terminal_state_protocol::{
        InputReceipt, InputWrittenToPty, encode_record, input_intent, input_receipt,
        terminal_state_record,
    };

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
        TERMINAL_INPUT_INTENT_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );
    for expected_record_id in 1..=4 {
        write_opaque_payload(
            &mut host,
            &encode_record(
                100 + expected_record_id,
                &TerminalStateRecord {
                    schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
                    terminal_epoch: fence().terminal_epoch,
                    through_output_seq: expected_record_id,
                    state_revision: expected_record_id,
                    body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
                        in_reply_to_record_id: expected_record_id,
                        outcome: Some(input_receipt::Outcome::WrittenToPty(InputWrittenToPty {
                            input_baseline_output_sequence: Some(expected_record_id),
                            agent_runtime_revision: None,
                        })),
                    })),
                },
            )
            .unwrap(),
        );
    }

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::Writer);
    let mut surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();

    let command = surface
        .send_command_input_confirmed("status".into(), true, Duration::from_secs(1))
        .unwrap();
    assert_eq!(command.text().unwrap().in_reply_to_record_id, 1);
    assert_eq!(command.submit().unwrap().in_reply_to_record_id, 2);

    let enter_only = surface
        .send_command_input_confirmed(String::new(), true, Duration::from_secs(1))
        .unwrap();
    assert!(enter_only.text().is_none());
    assert_eq!(enter_only.submit().unwrap().in_reply_to_record_id, 3);

    let draft = surface
        .send_command_input_confirmed("first\nsecond".into(), false, Duration::from_secs(1))
        .unwrap();
    assert_eq!(draft.text().unwrap().in_reply_to_record_id, 4);
    assert!(draft.submit().is_none());

    let hello = host.read_frame(&codec()).unwrap().unwrap();
    assert!(matches!(hello.frame().body, FrameBody::Hello(_)));
    for expected_record_id in 1..=4 {
        let encoded = host.read_payload(&codec()).unwrap().unwrap();
        let decoded = terminal_state_protocol::decode_record(&encoded).unwrap();
        assert_eq!(decoded.metadata.record_id, expected_record_id);
        let Some(terminal_state_record::Body::InputIntent(intent)) = decoded.record.body else {
            panic!("command input did not remain semantic");
        };
        match (expected_record_id, intent.intent) {
            (1, Some(input_intent::Intent::Paste(text))) => assert_eq!(text.utf8, b"status"),
            (2 | 3, Some(input_intent::Intent::Key(key))) => {
                assert_eq!((key.key.as_str(), key.code.as_str()), ("Enter", "Enter"));
            }
            (4, Some(input_intent::Intent::Paste(text))) => {
                assert_eq!(text.utf8, b"first\nsecond")
            }
            _ => panic!("unexpected command input intent"),
        }
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn command_input_uses_one_absolute_deadline_for_text_and_submit_writes() {
    use hmux_runtime_contract::{
        TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY, TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use terminal_state_protocol::{
        InputReceipt, InputWrittenToPty, TerminalStateRecord, encode_record, input_receipt,
        terminal_state_record,
    };

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
        TERMINAL_INPUT_INTENT_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );
    for record_id in 1..=2 {
        write_opaque_payload(
            &mut host,
            &encode_record(
                100 + record_id,
                &TerminalStateRecord {
                    schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
                    terminal_epoch: fence().terminal_epoch,
                    through_output_seq: 1,
                    state_revision: record_id,
                    body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
                        in_reply_to_record_id: record_id,
                        outcome: Some(input_receipt::Outcome::WrittenToPty(
                            InputWrittenToPty::default(),
                        )),
                    })),
                },
            )
            .unwrap(),
        );
    }

    let shared = SharedEndpoint::new(client);
    let deadlines = Arc::new(Mutex::new(Vec::new()));
    let transport = AttachedTransport::relayed(
        Box::new(shared.clone()),
        Box::new(DeadlineRecordingWriter {
            endpoint: shared.clone(),
            deadlines: Arc::clone(&deadlines),
        }),
        Arc::new(shared),
    );
    let connection = LocalConnection::attach_over_transport(
        transport,
        fence(),
        "attach-secret".to_string(),
        crate::TerminalSurfaceAttachment::connection_options(
            crate::TerminalSurfaceAccess::Writer,
            None,
        ),
    )
    .unwrap();
    let mut surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();

    surface
        .send_command_input_confirmed("status".into(), true, Duration::from_secs(1))
        .unwrap();

    let semantic_deadlines = deadlines
        .lock()
        .expect("deadline recording lock")
        .iter()
        .copied()
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(semantic_deadlines.len(), 2);
    assert_eq!(semantic_deadlines[0], semantic_deadlines[1]);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn command_input_preserves_body_delivery_when_submit_outcome_is_unknown() {
    use hmux_runtime_contract::{
        TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY, TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use hmux_session_protocol::transport::FrameReader;
    use std::thread;
    use terminal_state_protocol::{
        InputReceipt, InputWrittenToPty, TerminalStateRecord, encode_record, input_intent,
        input_receipt, terminal_state_record,
    };

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
        TERMINAL_INPUT_INTENT_CAPABILITY,
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );
    write_opaque_payload(
        &mut host,
        &encode_record(
            100,
            &TerminalStateRecord {
                schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
                terminal_epoch: fence().terminal_epoch,
                through_output_seq: 1,
                state_revision: 1,
                body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
                    in_reply_to_record_id: 1,
                    outcome: Some(input_receipt::Outcome::WrittenToPty(
                        InputWrittenToPty::default(),
                    )),
                })),
            },
        )
        .unwrap(),
    );

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::Writer);
    let mut surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let host_task = thread::spawn(move || {
        let hello = host.read_frame(&codec()).unwrap().unwrap();
        assert!(matches!(hello.frame().body, FrameBody::Hello(_)));
        let text = host.read_payload(&codec()).unwrap().unwrap();
        let decoded = terminal_state_protocol::decode_record(&text).unwrap();
        assert_eq!(decoded.metadata.record_id, 1);
        let Some(terminal_state_record::Body::InputIntent(intent)) = decoded.record.body else {
            panic!("command body was not semantic input");
        };
        assert!(matches!(
            intent.intent,
            Some(input_intent::Intent::Paste(_))
        ));

        let submit_deadline = Instant::now() + Duration::from_secs(1);
        let submit = loop {
            match host.read_payload(&codec()) {
                Ok(Some(payload)) => break payload,
                Ok(None) | Err(_) if Instant::now() < submit_deadline => {
                    thread::sleep(Duration::from_millis(1));
                }
                result => panic!("semantic submit did not reach the Host: {result:?}"),
            }
        };
        let decoded = terminal_state_protocol::decode_record(&submit).unwrap();
        assert_eq!(decoded.metadata.record_id, 2);
        let Some(terminal_state_record::Body::InputIntent(intent)) = decoded.record.body else {
            panic!("command submit was not semantic input");
        };
        assert!(matches!(intent.intent, Some(input_intent::Intent::Key(_))));
        host.close_write().unwrap();
    });

    let error = surface
        .send_command_input_confirmed("status".into(), true, Duration::from_secs(1))
        .expect_err("submit transport loss must not erase the written body fact");
    assert_eq!(error.code(), "hmux_terminal_input_outcome_unknown");
    assert!(error.body_delivered());
    assert_eq!(error.delivery_state(), "body_written_submit_unknown");
    host_task.join().unwrap();
}

#[cfg(feature = "terminal-state-stream")]
fn assert_new_terminal_surface_uses_base_minor_for_attach_input_and_resize(
    selected_capabilities: &[&str],
) {
    use hmux_session_protocol::transport::FrameReader;
    use terminal_state_protocol::{
        InputReceipt, InputWrittenToPty, ResizeAppliedToTerminal, ResizeReceipt,
        TerminalStateRecord, encode_record, input_intent, input_receipt, resize_receipt,
        terminal_state_record,
    };

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(selected_capabilities);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    let mut legacy_seed = viewport_seed_record();
    legacy_seed.schema_minor = 4;
    write_opaque_payload(&mut host, &encode_record(2, &legacy_seed).unwrap());
    write_opaque_payload(
        &mut host,
        &encode_record(
            51,
            &TerminalStateRecord {
                schema_minor: 4,
                terminal_epoch: fence().terminal_epoch,
                through_output_seq: 1,
                state_revision: 1,
                body: Some(terminal_state_record::Body::InputReceipt(InputReceipt {
                    in_reply_to_record_id: 1,
                    outcome: Some(input_receipt::Outcome::WrittenToPty(
                        InputWrittenToPty::default(),
                    )),
                })),
            },
        )
        .unwrap(),
    );
    write_opaque_payload(
        &mut host,
        &encode_record(
            52,
            &TerminalStateRecord {
                schema_minor: 4,
                terminal_epoch: fence().terminal_epoch,
                through_output_seq: 1,
                state_revision: 1,
                body: Some(terminal_state_record::Body::ResizeReceipt(ResizeReceipt {
                    in_reply_to_record_id: 2,
                    outcome: Some(resize_receipt::Outcome::AppliedToTerminal(
                        ResizeAppliedToTerminal {
                            columns: 132,
                            rows: 43,
                        },
                    )),
                })),
            },
        )
        .unwrap(),
    );

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::Writer);
    let mut surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let input = surface
        .send_text_confirmed("hello".into(), Duration::from_secs(1))
        .unwrap();
    assert!(matches!(
        input.outcome,
        Some(input_receipt::Outcome::WrittenToPty(_))
    ));
    let resize = surface
        .send_resize_confirmed(132, 43, Duration::from_secs(1))
        .unwrap();
    let Some(resize_receipt::Outcome::AppliedToTerminal(applied)) = resize.outcome else {
        panic!("resize did not return the applied geometry");
    };
    assert_eq!((applied.columns, applied.rows), (132, 43));

    let hello = host.read_frame(&codec()).unwrap().unwrap();
    let FrameBody::Hello(hello) = &hello.frame().body else {
        panic!("surface did not send Hello");
    };
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|value| value == "terminal_viewport_multipart_v1"),
        "a new client must offer multipart as an additive capability",
    );
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|value| value == "terminal_viewport_wheel_v1"),
        "a structured surface must request Host-routed wheel as its own capability",
    );
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|value| value == "provider_conversation_identity_v1"),
        "a structured surface must request the Host-owned conversation identity projection",
    );
    let input =
        terminal_state_protocol::decode_record(&host.read_payload(&codec()).unwrap().unwrap())
            .unwrap();
    assert_eq!(input.metadata.protocol_minor, 4);
    assert_eq!(input.record.schema_minor, 4);
    assert_eq!(input.metadata.record_id, 1);
    let Some(terminal_state_record::Body::InputIntent(intent)) = input.record.body else {
        panic!("surface did not send semantic input");
    };
    assert!(matches!(intent.intent, Some(input_intent::Intent::Text(_))));
    let resize =
        terminal_state_protocol::decode_record(&host.read_payload(&codec()).unwrap().unwrap())
            .unwrap();
    assert_eq!(resize.metadata.protocol_minor, 4);
    assert_eq!(resize.record.schema_minor, 4);
    assert_eq!(resize.metadata.record_id, 2);
    let Some(terminal_state_record::Body::InputIntent(intent)) = resize.record.body else {
        panic!("surface did not send semantic resize");
    };
    let Some(input_intent::Intent::Resize(request)) = intent.intent else {
        panic!("surface did not send semantic resize");
    };
    assert_eq!((request.columns, request.rows), (132, 43));
    assert_eq!(request.geometry_generation, 2);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn new_terminal_surface_falls_back_to_a_pre_multipart_hosts_minor() {
    assert_new_terminal_surface_uses_base_minor_for_attach_input_and_resize(&[
        "screen_snapshot",
        "live_output",
        "terminal_state_binary_v1",
        "terminal_viewport_projection_v1",
        "terminal_viewport_wheel_v1",
        "terminal_input_intent_v1",
    ]);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn typed_input_writer_cannot_forward_a_viewport_envelope() {
    use terminal_state_protocol::{
        ScrollRows, TerminalStateRecord, ViewportIntent, encode_record, terminal_state_record,
        viewport_intent,
    };

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        "terminal_state_binary_v1",
        "terminal_viewport_projection_v1",
        "terminal_input_intent_v1",
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );
    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::Writer);
    let encoded = encode_record(
        7,
        &TerminalStateRecord {
            schema_minor: 4,
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: 1,
            state_revision: 1,
            body: Some(terminal_state_record::Body::ViewportIntent(
                ViewportIntent {
                    observed_projection_revision: 1,
                    intent_seq: 2,
                    intent: Some(viewport_intent::Intent::ScrollRows(ScrollRows { rows: -1 })),
                },
            )),
        },
    )
    .unwrap();

    let error = connection
        .terminal_input_writer_capability()
        .unwrap()
        .send_input_envelope(&encoded)
        .expect_err("the PTY writer handle must not grant viewport authority");
    assert_eq!(error.code(), "hmux_terminal_input_record_required");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn ordinary_input_writer_rejects_raw_agent_prompt_before_wire() {
    use hmux_session_protocol::transport::FrameReader;
    use terminal_state_protocol::{
        AgentPromptInputIntent, FreshAgentPromptTarget, InputIntent, TerminalStateRecord,
        agent_prompt_input_intent, encode_record_for_minor, input_intent, terminal_state_record,
    };

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        "terminal_state_binary_v1",
        "terminal_viewport_projection_v1",
        "terminal_input_intent_v1",
    ]);
    ack.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &terminal_state_protocol::encode_record(2, &viewport_seed_record()).unwrap(),
    );
    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::Writer);
    let encoded = encode_record_for_minor(
        TERMINAL_STATE_BASE_PROTOCOL_MINOR,
        7,
        &TerminalStateRecord {
            schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: 1,
            state_revision: 1,
            body: Some(terminal_state_record::Body::InputIntent(InputIntent {
                intent: Some(input_intent::Intent::AgentPrompt(AgentPromptInputIntent {
                    utf8: b"must not write".to_vec(),
                    admission_wait_ms: 0,
                    target: Some(agent_prompt_input_intent::Target::FreshAgent(
                        FreshAgentPromptTarget {},
                    )),
                })),
            })),
        },
    )
    .unwrap();

    let error = connection
        .terminal_input_writer_capability()
        .unwrap()
        .send_input_envelope(&encoded)
        .expect_err("ordinary-input authority must not forward a raw agent prompt");
    assert_eq!(error.code(), "hmux_capability_missing");

    let hello = host.read_frame(&codec()).unwrap().unwrap();
    assert!(matches!(hello.frame().body, FrameBody::Hello(_)));
    assert!(host.try_read_complete_payload(&codec()).unwrap().is_none());
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn multipart_host_keeps_existing_input_and_resize_records_on_base_minor() {
    assert_new_terminal_surface_uses_base_minor_for_attach_input_and_resize(&[
        "screen_snapshot",
        "live_output",
        "terminal_state_binary_v1",
        "terminal_viewport_projection_v1",
        "terminal_viewport_wheel_v1",
        "terminal_input_intent_v1",
        "terminal_viewport_multipart_v1",
    ]);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn viewport_attach_preserves_typed_capability_failure_before_its_seed() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use hmux_session_protocol::{ErrorCode, ErrorFrame, RetryPosture};

    let (client, mut host) = MemoryEndpoint::pair();
    let ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    ]);
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 2,
                body: FrameBody::Error(ErrorFrame {
                    origin_code: None,
                    code: ErrorCode::UnsupportedCapability,
                    message: "complete viewport requires multipart support".into(),
                    retry: RetryPosture::Never,
                    required_capability: Some("terminal_viewport_multipart_v1".into()),
                    supported_versions: None,
                    in_reply_to_request_id: None,
                }),
            })
            .unwrap(),
    )
    .unwrap();

    let shared = SharedEndpoint::new(client);
    let error = LocalConnection::attach_over_transport(
        AttachedTransport::relayed(
            Box::new(shared.clone()),
            Box::new(shared.clone()),
            Arc::new(shared),
        ),
        fence(),
        "attach-secret".to_string(),
        crate::TerminalSurfaceAttachment::connection_options(
            crate::TerminalSurfaceAccess::ReadOnly,
            None,
        ),
    )
    .expect_err("an unsupported oversized viewport must fail the attachment");
    assert_eq!(error.code(), "hmux_capability_unsupported");
    assert_eq!(error.retry_directive(), crate::RetryDirective::Never);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn viewport_attach_classifies_transport_close_before_its_seed_as_reconnectable() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };

    let (client, mut host) = MemoryEndpoint::pair();
    let ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    ]);
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    host.close_write().unwrap();

    let shared = SharedEndpoint::new(client);
    let error = LocalConnection::attach_over_transport(
        AttachedTransport::relayed(
            Box::new(shared.clone()),
            Box::new(shared.clone()),
            Arc::new(shared),
        ),
        fence(),
        "attach-secret".to_string(),
        crate::TerminalSurfaceAttachment::connection_options(
            crate::TerminalSurfaceAccess::ReadOnly,
            None,
        ),
    )
    .expect_err("a legacy Host may close after HelloAck but before its viewport seed");

    assert_eq!(error.code(), "hmux_transport_closed");
    assert_eq!(error.retry_directive(), crate::RetryDirective::Reconnect);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn viewport_attach_classifies_exit_before_seed_as_session_exit() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };

    let (client, mut host) = MemoryEndpoint::pair();
    let mut ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    ]);
    ack.lifecycle = LifecycleState::Exited;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(ack),
            })
            .unwrap(),
    )
    .unwrap();
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 2,
                body: FrameBody::Exit(Exit {
                    final_output_seq: 1,
                    exit_code: Some(0),
                    platform_status: None,
                    reason: "provider exited before viewport seed".into(),
                }),
            })
            .unwrap(),
    )
    .unwrap();

    let shared = SharedEndpoint::new(client);
    let error = LocalConnection::attach_over_transport(
        AttachedTransport::relayed(
            Box::new(shared.clone()),
            Box::new(shared.clone()),
            Arc::new(shared),
        ),
        fence(),
        "attach-secret".to_string(),
        crate::TerminalSurfaceAttachment::connection_options(
            crate::TerminalSurfaceAccess::ReadOnly,
            None,
        ),
    )
    .expect_err("an exited Host cannot establish a surface without a seed");
    assert_eq!(error.code(), "hmux_session_exited");
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn read_only_surface_scroll_is_connection_local_and_acknowledged_by_a_complete_frame() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use hmux_session_protocol::transport::FrameReader;
    use terminal_state_protocol::{
        ViewportAnchorStatus, encode_record, terminal_state_record, viewport_intent,
    };

    let (client, mut host) = MemoryEndpoint::pair();
    let mut hello = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    ]);
    hello.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(hello),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );
    let mut acknowledged = viewport_seed_record();
    let Some(terminal_state_record::Body::ViewportFrame(frame)) = acknowledged.body.as_mut() else {
        unreachable!()
    };
    frame.projection_revision = 2;
    frame.applied_intent_seq = 2;
    frame.anchor_status = ViewportAnchorStatus::ClampedTail as i32;
    write_opaque_payload(&mut host, &encode_record(3, &acknowledged).unwrap());

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    let mut surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let frame = surface
        .scroll_rows_confirmed(1, Duration::from_secs(1))
        .unwrap();
    assert_eq!(frame.viewport().projection_revision, 2);
    assert_eq!(frame.viewport().applied_intent_seq, 2);

    let hello = host.read_frame(&codec()).unwrap().unwrap();
    let FrameBody::Hello(hello) = &hello.frame().body else {
        panic!("surface attach did not send Hello");
    };
    assert!(
        !hello
            .requested_capabilities
            .iter()
            .any(|value| value == "terminal_input_intent_v1")
    );
    let intent =
        terminal_state_protocol::decode_record(&host.read_payload(&codec()).unwrap().unwrap())
            .unwrap();
    assert_eq!(intent.metadata.protocol_minor, 4);
    assert_eq!(intent.record.schema_minor, 4);
    let Some(terminal_state_record::Body::ViewportIntent(intent)) = intent.record.body else {
        panic!("surface did not send a viewport intent");
    };
    assert_eq!(intent.observed_projection_revision, 1);
    assert_eq!(intent.intent_seq, 2);
    let Some(viewport_intent::Intent::ScrollRows(scroll)) = intent.intent else {
        panic!("surface did not send a row scroll");
    };
    assert_eq!(scroll.rows, 1);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn projection_attach_without_wheel_capability_keeps_base_row_scroll_usable() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use hmux_session_protocol::transport::FrameReader;
    use terminal_state_protocol::{
        ViewportAnchorStatus, encode_record, terminal_state_record, viewport_intent,
    };

    let (client, mut host) = MemoryEndpoint::pair();
    let mut hello = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    ]);
    hello.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(hello),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );
    let mut acknowledged = viewport_seed_record();
    let Some(terminal_state_record::Body::ViewportFrame(frame)) = acknowledged.body.as_mut() else {
        unreachable!()
    };
    frame.projection_revision = 2;
    frame.applied_intent_seq = 2;
    frame.anchor_status = ViewportAnchorStatus::ClampedTail as i32;
    write_opaque_payload(&mut host, &encode_record(3, &acknowledged).unwrap());

    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    assert!(!connection.supports(TERMINAL_VIEWPORT_WHEEL_CAPABILITY));
    let mut surface = crate::TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let frame = surface
        .scroll_rows_confirmed(1, Duration::from_secs(1))
        .unwrap();
    assert_eq!(frame.viewport().projection_revision, 2);
    assert_eq!(frame.viewport().applied_intent_seq, 2);

    let hello = host.read_frame(&codec()).unwrap().unwrap();
    let FrameBody::Hello(hello) = &hello.frame().body else {
        panic!("surface attach did not send Hello");
    };
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|value| value == TERMINAL_VIEWPORT_WHEEL_CAPABILITY)
    );
    let intent =
        terminal_state_protocol::decode_record(&host.read_payload(&codec()).unwrap().unwrap())
            .unwrap();
    assert_eq!(intent.metadata.protocol_minor, 4);
    assert_eq!(intent.record.schema_minor, 4);
    let Some(terminal_state_record::Body::ViewportIntent(intent)) = intent.record.body else {
        panic!("surface did not send a viewport intent");
    };
    let Some(viewport_intent::Intent::ScrollRows(scroll)) = intent.intent else {
        panic!("surface did not retain base row scroll");
    };
    assert_eq!(scroll.rows, 1);
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn selected_wheel_capability_forwards_the_exact_additive_envelope() {
    use hmux_runtime_contract::{
        TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use hmux_session_protocol::transport::FrameReader;
    use terminal_state_protocol::{
        PointerInputIntent, PointerKind, TerminalStateRecord, ViewportIntent, encode_record,
        encode_record_for_minor, terminal_state_record, viewport_intent,
    };

    let (client, mut host) = MemoryEndpoint::pair();
    let mut hello = hello_ack(&[
        "screen_snapshot",
        "live_output",
        TERMINAL_STATE_BINARY_CAPABILITY,
        TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    ]);
    hello.current_output_seq = 1;
    host.write_frame(
        &codec()
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::HelloAck(hello),
            })
            .unwrap(),
    )
    .unwrap();
    write_opaque_payload(
        &mut host,
        &encode_record(2, &viewport_seed_record()).unwrap(),
    );
    let connection = terminal_surface_connection(client, crate::TerminalSurfaceAccess::ReadOnly);
    let wheel = TerminalStateRecord {
        schema_minor: 5,
        terminal_epoch: fence().terminal_epoch,
        through_output_seq: 1,
        state_revision: 1,
        body: Some(terminal_state_record::Body::ViewportIntent(
            ViewportIntent {
                observed_projection_revision: 1,
                intent_seq: 2,
                intent: Some(viewport_intent::Intent::Wheel(PointerInputIntent {
                    kind: PointerKind::Wheel as i32,
                    column: 1,
                    row: 1,
                    wheel_delta_y: -3,
                    pixel_x: 15,
                    pixel_y: 25,
                    surface_width: 100,
                    surface_height: 100,
                    cell_width: 10,
                    cell_height: 20,
                    ..PointerInputIntent::default()
                })),
            },
        )),
    };

    assert!(connection.terminal_input_writer_capability().is_none());
    let encoded = encode_record_for_minor(5, 7, &wheel).unwrap();
    connection
        .terminal_upstream_handles()
        .send_envelope(&encoded)
        .unwrap();

    let hello = host.read_frame(&codec()).unwrap().unwrap();
    assert!(matches!(hello.frame().body, FrameBody::Hello(_)));
    let forwarded =
        terminal_state_protocol::decode_record(&host.read_payload(&codec()).unwrap().unwrap())
            .unwrap();
    assert_eq!(forwarded.metadata.protocol_minor, 5);
    assert_eq!(forwarded.record.schema_minor, 5);
    assert_eq!(forwarded.metadata.record_id, 7);
    let Some(terminal_state_record::Body::ViewportIntent(intent)) = forwarded.record.body else {
        panic!("selected wheel envelope lost its viewport intent");
    };
    assert!(matches!(
        intent.intent,
        Some(viewport_intent::Intent::Wheel(_))
    ));
}

fn relayed_transport_with_legacy_writer(
    script: &[WireFrame],
) -> (AttachedTransport, MemoryEndpoint) {
    let (client, mut host) = MemoryEndpoint::pair();
    for frame in script {
        let encoded = codec().encode(frame).unwrap();
        host.write_frame(&encoded).unwrap();
    }
    let shared = SharedEndpoint::new(client);
    (
        AttachedTransport::relayed(
            Box::new(shared.clone()),
            Box::new(LegacyFrameWriter(shared.clone())),
            Arc::new(shared),
        ),
        host,
    )
}

/// The seam runs the real handshake, so it inherits the real gate.
///
/// A relayed attach is the reason the gate exists: `AttachMode` says nothing
/// about colocation, so a Host that grants `shared_terminal_input` to a
/// phone must be refused by the client rather than obeyed. Every grant in
/// `premised_grants` goes through the public entry point here, over a
/// transport that proves nothing -- the shape a relay has by construction.
#[test]
fn a_relayed_transport_is_refused_authority_premised_on_colocation() {
    for (label, role, ack) in premised_grants() {
        let (transport, _host) = relayed_transport(&handshake_script(ack, 1));
        assert!(
            !transport.attestation().is_colocated(),
            "{label}: a caller-supplied transport must never claim colocation"
        );

        let error = LocalConnection::attach_over_transport(
            transport,
            fence(),
            "attach-secret".to_string(),
            ConnectionOptions::new(role, None),
        )
        .err()
        .unwrap_or_else(|| panic!("{label} must not be accepted over a relayed transport"));

        assert_eq!(error.code(), "hmux_uncolocated_authority", "{label}");
    }
}

/// Proves the seam is the handshake and not a shortcut around it.
///
/// Asserting the attach merely succeeded would prove nothing -- a stub that
/// fabricated a `LocalConnection` would pass that. So this reads the bytes
/// the client put on the wire and checks they are a real `Hello` carrying
/// the attach secret, the negotiated fence and the role's capabilities, and
/// checks that the `HelloAck` and the initial snapshot were both consumed
/// from the reply.
#[test]
fn a_relayed_transport_speaks_the_whole_attach_handshake() {
    let ack = hello_ack(&["screen_snapshot", "live_output"]);
    let (transport, mut host) = relayed_transport(&handshake_script(ack, 4));

    let connection = LocalConnection::attach_over_transport(
        transport,
        fence(),
        "attach-secret".to_string(),
        ConnectionOptions::new(LocalAttachRole::Observer, None),
    )
    .unwrap();

    assert_eq!(
        connection
            .require_initial_snapshot()
            .unwrap()
            .sequence_through,
        4
    );
    assert_eq!(connection.last_output_seq(), 4);
    assert!(connection.supports("live_output"));
    assert!(!connection.attestation().is_colocated());

    let decoded = host.read_frame(&codec()).unwrap().unwrap();
    match &decoded.frame().body {
        FrameBody::Hello(hello) => {
            assert_eq!(hello.capability_token, "attach-secret");
            assert_eq!(hello.expected_fence, fence());
            assert_eq!(hello.requested_mode, AttachMode::Observer);
            assert_eq!(
                hello.requested_capabilities,
                requested_capabilities(LocalAttachRole::Observer, &[], false)
            );
        }
        other => panic!("the seam did not send a Hello, it sent {other:?}"),
    }
}

#[test]
fn relative_timeout_preserves_legacy_custom_writer_compatibility() {
    let ack = hello_ack(&["screen_snapshot", "live_output"]);
    let (transport, mut host) = relayed_transport_with_legacy_writer(&handshake_script(ack, 4));

    let connection = LocalConnection::attach_over_transport(
        transport,
        fence(),
        "attach-secret".to_string(),
        ConnectionOptions::new(LocalAttachRole::Observer, None)
            .with_handshake_timeout(Duration::from_secs(1)),
    )
    .unwrap();

    assert_eq!(connection.last_output_seq(), 4);
    let decoded = host.read_frame(&codec()).unwrap().unwrap();
    assert!(matches!(decoded.frame().body, FrameBody::Hello(_)));
}

/// A mismatched `HelloAck` must be refused over a supplied transport for
/// exactly the reasons it is refused locally -- the seam reuses
/// `validate_hello_ack`, and this is what says so from the outside.
#[test]
fn a_relayed_transport_still_enforces_the_fence_and_the_role() {
    let mut ack = hello_ack(&["screen_snapshot", "live_output"]);
    ack.actual_fence.host_instance_id = "other-host".into();
    let (transport, _host) = relayed_transport(&handshake_script(ack, 1));

    assert!(matches!(
        LocalConnection::attach_over_transport(
            transport,
            fence(),
            "attach-secret".to_string(),
            ConnectionOptions::new(LocalAttachRole::Observer, None),
        ),
        Err(ClientError::FenceMismatch(_))
    ));
}

/// The socket path still works, and still carries the authority the relayed
/// path is refused.
///
/// It runs the real dialer against a real pathname socket, so the witness is
/// kernel-minted, and then the same `complete_attach` the manifest path
/// calls -- which is the whole of `connect_manifest` after the manifest has
/// been parsed. Paired with the refusal test above, it also shows the gate
/// discriminates rather than refusing everything.
#[cfg(all(unix, feature = "local-runtime"))]
#[test]
fn a_socket_backed_dial_still_completes_the_handshake_with_its_witness() {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;

    let directory = TempDir::new().unwrap();
    let path = directory.path().join("host.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let (label, role, ack) = premised_grants().remove(0);
    let script = handshake_script(ack, 1);

    let host = std::thread::spawn(move || {
        let (mut accepted, _) = listener.accept().unwrap();
        // Read the client's Hello before replying, so the reply cannot be
        // mistaken for a Host that answered without being asked.
        let hello = codec().read_for_dispatch(&mut accepted).unwrap();
        for frame in &script {
            accepted.write_all(&codec().encode(frame).unwrap()).unwrap();
        }
        accepted.flush().unwrap();
        // Hold the socket open until the client has drained the reply.
        let _ = accepted.read(&mut [0_u8; 1]);
        hello
    });

    let scope = session_scope(&fence());
    let transport =
        crate::transport::unix_socket::UnixSocketDialer::open(&path, scope.clone()).unwrap();
    assert!(transport.attestation().witness_for(&scope).is_ok());

    let connection = complete_attach(
        transport,
        fence(),
        "attach-secret".to_string(),
        None,
        ConnectionOptions::new(role, None),
    )
    .unwrap_or_else(|error| panic!("{label} must still attach over a local socket: {error}"));

    assert!(connection.supports(SHARED_TERMINAL_INPUT_CAPABILITY));
    assert_eq!(
        connection
            .require_initial_snapshot()
            .unwrap()
            .sequence_through,
        1
    );
    drop(connection);

    match &host.join().unwrap().frame().body {
        FrameBody::Hello(hello) => assert_eq!(hello.capability_token, "attach-secret"),
        other => panic!("the dialed path did not send a Hello, it sent {other:?}"),
    }
}

#[test]
fn terminal_stream_reducer_rejects_gaps_and_stale_snapshots() {
    let mut reducer = TerminalStreamReducer::new(fence(), 1, None, None, None, None);
    assert!(matches!(
        reducer.accept(&FrameBody::OutputDelta(OutputDelta {
            terminal_epoch: "terminal-1".into(),
            output_seq: 3,
            bytes: b"gap".to_vec(),
            rows: None,
            columns: None,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
        })),
        Err(ClientError::InconsistentStream {
            reason: "output delta is not contiguous"
        })
    ));

    let mut stale_fence = fence();
    stale_fence.host_instance_id = "stale-host".into();
    assert!(matches!(
        reducer.accept(&FrameBody::ScreenSnapshot(ScreenSnapshot {
            fence: stale_fence,
            sequence_through: 1,
            rows: 24,
            columns: 80,
            encoding: hmux_session_protocol::ScreenSnapshotEncoding::AnsiRedrawV1,
            controller_input_pending: None,
            semantic_idle_ms: None,
            repaint_bytes: Vec::new(),
            alternate_screen: false,
            cursor_visible: true,
            truncated: false,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
            agent_runtime_state: None,
            provider_conversation_identity: None,
            recovered_presentation: None,
            actual_profile: None,
            in_reply_to_request_id: None,
        })),
        Err(ClientError::FenceMismatch(_))
    ));

    assert!(matches!(
        reducer.accept(&FrameBody::ReplayGap(ReplayGap {
            cursor: ReconnectCursor {
                terminal_epoch: "other-terminal".into(),
                after_output_seq: 1,
            },
            earliest_retained_output_seq: 2,
            current_output_seq: 3,
        })),
        Err(ClientError::InconsistentStream {
            reason: "replay gap terminal epoch does not match attach fence"
        })
    ));
}

#[test]
fn terminal_stream_reducer_discards_old_host_deltas_overtaken_by_a_snapshot() {
    let snapshot = |sequence_through| {
        FrameBody::ScreenSnapshot(ScreenSnapshot {
            fence: fence(),
            sequence_through,
            rows: 24,
            columns: 80,
            encoding: hmux_session_protocol::ScreenSnapshotEncoding::AnsiRedrawV1,
            controller_input_pending: None,
            semantic_idle_ms: None,
            repaint_bytes: Vec::new(),
            alternate_screen: false,
            cursor_visible: true,
            truncated: false,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
            agent_runtime_state: None,
            provider_conversation_identity: None,
            recovered_presentation: None,
            actual_profile: None,
            in_reply_to_request_id: None,
        })
    };
    let delta = |output_seq| {
        FrameBody::OutputDelta(OutputDelta {
            terminal_epoch: "terminal-1".into(),
            output_seq,
            bytes: vec![b'x'],
            rows: None,
            columns: None,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
        })
    };
    let mut reducer = TerminalStreamReducer::new(fence(), 1, None, None, None, None);

    assert!(reducer.accept(&snapshot(4)).unwrap());
    assert!(!reducer.accept(&delta(2)).unwrap());
    assert!(!reducer.accept(&delta(3)).unwrap());
    assert!(!reducer.accept(&delta(4)).unwrap());
    assert!(reducer.accept(&delta(5)).unwrap());
    assert!(matches!(
        reducer.accept(&delta(5)),
        Err(ClientError::InconsistentStream {
            reason: "output delta is not contiguous"
        })
    ));
    assert!(!reducer.accept(&snapshot(4)).unwrap());
    assert_eq!(reducer.last_output_seq, 5);
}

#[test]
fn terminal_stream_reducer_fences_agent_runtime_state_by_output_and_revision() {
    use hmux_session_protocol::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
        AgentRuntimeStateProjection, AgentRuntimeStateSource,
    };

    let state = |terminal_epoch: &str, revision: u64, output_seq: u64| {
        FrameBody::AgentRuntimeState(AgentRuntimeStateProjection {
            terminal_epoch: terminal_epoch.into(),
            revision,
            observed_through_output_seq: output_seq,
            lifecycle: AgentRuntimeLifecycle::Running,
            activity: AgentRuntimeActivity::Working,
            attention: AgentRuntimeAttention::None,
            attention_id: None,
            source: AgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: 0,
        })
    };
    let mut reducer = TerminalStreamReducer::new(fence(), 2, None, Some(3), None, None);

    assert!(matches!(
        reducer.accept(&state("terminal-1", 4, 3)),
        Err(ClientError::InconsistentStream {
            reason: "agent runtime state is ahead of observed output"
        })
    ));
    assert!(matches!(
        reducer.accept(&state("terminal-1", 3, 2)),
        Err(ClientError::InconsistentStream {
            reason: "agent runtime state revision did not advance"
        })
    ));
    assert!(matches!(
        reducer.accept(&state("terminal-stale", 4, 2)),
        Err(ClientError::InconsistentStream {
            reason: "agent runtime state terminal epoch does not match attach fence"
        })
    ));
    assert!(reducer.accept(&state("terminal-1", 4, 2)).is_ok());
}

#[test]
fn terminal_stream_reducer_fences_provider_identity_by_complete_fence_output_and_revision() {
    use hmux_session_protocol::{
        ProviderConversationIdentityProjection, ProviderConversationIdentitySource,
    };

    let identity = |projection_fence: SessionFence, revision: u64, output_seq: u64| {
        FrameBody::ProviderConversationIdentity(ProviderConversationIdentityProjection {
            fence: projection_fence,
            revision,
            observed_through_output_seq: output_seq,
            provider_id: "codex".into(),
            conversation_id: format!("conversation-{revision}"),
            source: ProviderConversationIdentitySource::ProviderEvent,
        })
    };
    let mut reducer = TerminalStreamReducer::new(
        fence(),
        2,
        None,
        None,
        Some(3),
        Some(("codex".into(), "conversation-3".into())),
    );

    assert!(matches!(
        reducer.accept(&identity(fence(), 4, 3)),
        Err(ClientError::InconsistentStream {
            reason: "provider conversation identity is ahead of observed output"
        })
    ));
    assert!(matches!(
        reducer.accept(&identity(fence(), 3, 2)),
        Err(ClientError::InconsistentStream {
            reason: "provider conversation identity revision did not advance"
        })
    ));
    let mut stale_fence = fence();
    stale_fence.host_instance_id = "stale-host".into();
    assert!(matches!(
        reducer.accept(&identity(stale_fence, 4, 2)),
        Err(ClientError::FenceMismatch(_))
    ));
    assert!(matches!(
        reducer.accept(&identity(fence(), 4, 2)),
        Err(ClientError::InconsistentStream {
            reason: "provider conversation identity changed within one Host generation"
        })
    ));
    reducer.conversation_continuations = true;
    assert!(reducer.accept(&identity(fence(), 4, 2)).unwrap());
    assert_eq!(
        reducer.last_provider_conversation_identity,
        Some(("codex".into(), "conversation-4".into()))
    );
    // Negotiated continuations still cannot reuse a revision or move backward.
    assert!(reducer.accept(&identity(fence(), 4, 2)).is_err());
    assert!(reducer.accept(&identity(fence(), 3, 2)).is_err());
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn structured_semantic_staging_keeps_fences_revisions_and_identity_fail_closed() {
    use hmux_session_protocol::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
        AgentRuntimeStateProjection, AgentRuntimeStateSource,
        ProviderConversationIdentityProjection, ProviderConversationIdentitySource,
    };
    use terminal_state_protocol::ViewportFrameProgress;

    let runtime = |terminal_epoch: &str, revision: u64, output_seq: u64| {
        FrameBody::AgentRuntimeState(AgentRuntimeStateProjection {
            terminal_epoch: terminal_epoch.into(),
            revision,
            observed_through_output_seq: output_seq,
            lifecycle: AgentRuntimeLifecycle::Running,
            activity: AgentRuntimeActivity::Working,
            attention: AgentRuntimeAttention::None,
            attention_id: None,
            source: AgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: 0,
        })
    };
    let identity = |conversation_id: &str, revision: u64, output_seq: u64| {
        FrameBody::ProviderConversationIdentity(ProviderConversationIdentityProjection {
            fence: fence(),
            revision,
            observed_through_output_seq: output_seq,
            provider_id: "codex".into(),
            conversation_id: conversation_id.into(),
            source: ProviderConversationIdentitySource::ProviderEvent,
        })
    };
    let mut reducer = TerminalStreamReducer::new(fence(), 2, None, Some(3), None, None);

    assert!(
        !reducer
            .accept_structured_control(&runtime("terminal-1", 4, 3))
            .unwrap()
    );
    assert!(matches!(
        reducer.accept_structured_control(&runtime("terminal-1", 4, 3)),
        Err(ClientError::InconsistentStream {
            reason: "agent runtime state revision did not advance"
        })
    ));
    assert!(matches!(
        reducer.accept_structured_control(&runtime("terminal-stale", 5, 4)),
        Err(ClientError::InconsistentStream {
            reason: "agent runtime state terminal epoch does not match attach fence"
        })
    ));

    reducer
        .accept_complete_terminal_viewport(&ViewportFrameProgress {
            terminal_epoch: "terminal-1".into(),
            through_output_seq: 3,
            state_revision: 2,
            projection_revision: 2,
            applied_intent_seq: 2,
        })
        .unwrap();
    let Some(FrameBody::AgentRuntimeState(state)) = reducer.take_ready_semantic_control().unwrap()
    else {
        panic!("the staged runtime state did not survive its matching viewport");
    };
    assert_eq!(state.revision, 4);

    assert!(
        !reducer
            .accept_structured_control(&identity("conversation-a", 1, 4))
            .unwrap()
    );
    assert!(matches!(
        reducer.accept_structured_control(&identity("conversation-b", 2, 4)),
        Err(ClientError::InconsistentStream {
            reason: "provider conversation identity changed within one Host generation"
        })
    ));
    reducer.conversation_continuations = true;
    assert!(!reducer
        .accept_structured_control(&identity("conversation-b", 2, 4))
        .unwrap());
    assert!(reducer
        .accept_structured_control(&identity("conversation-a", 1, 4))
        .is_err());
    reducer
        .accept_complete_terminal_viewport(&ViewportFrameProgress {
            terminal_epoch: "terminal-1".into(),
            through_output_seq: 4,
            state_revision: 3,
            projection_revision: 3,
            applied_intent_seq: 2,
        })
        .unwrap();
    let Some(FrameBody::ProviderConversationIdentity(current)) =
        reducer.take_ready_semantic_control().unwrap()
    else {
        panic!("the continuation did not survive its matching viewport");
    };
    assert_eq!(current.conversation_id, "conversation-b");
    assert_eq!(current.revision, 2);
}
// ---- reconnect resume -------------------------------------------------

fn resume_ack(current_output_seq: u64, earliest_retained_output_seq: u64) -> HelloAck {
    let mut ack = hello_ack(&[
        "screen_snapshot",
        "live_output",
        RECONNECT_RESUME_CAPABILITY,
    ]);
    ack.current_output_seq = current_output_seq;
    ack.earliest_retained_output_seq = earliest_retained_output_seq;
    ack
}

fn frame(frame_id: u64, body: FrameBody) -> WireFrame {
    WireFrame {
        protocol_version: PROTOCOL_V1,
        frame_id,
        body,
    }
}

fn replayed_delta(output_seq: u64, bytes: &[u8]) -> FrameBody {
    FrameBody::OutputDelta(OutputDelta {
        terminal_epoch: fence().terminal_epoch,
        output_seq,
        bytes: bytes.to_vec(),
        rows: None,
        columns: None,
        working_directory: None,
        execution_location: None,
        agent_identity: None,
    })
}

fn resume_options(after_output_seq: u64) -> ConnectionOptions {
    ConnectionOptions::new(LocalAttachRole::Observer, None).with_reconnect_cursor(Some(
        ReconnectCursor {
            terminal_epoch: fence().terminal_epoch,
            after_output_seq,
        },
    ))
}

/// Resumption skips what the client already has.
///
/// The script contains **no** `ScreenSnapshot` at all, so a client that
/// still demanded one would fail the attach outright rather than merely
/// download more than it needed -- which is what made this fail before the
/// change, and is why "it succeeded" is evidence here rather than a tautology.
#[test]
fn a_resumed_attach_takes_the_deltas_it_missed_and_no_snapshot() {
    let (transport, mut host) = relayed_transport(&[
        frame(1, FrameBody::HelloAck(resume_ack(7, 3))),
        frame(2, replayed_delta(5, b"five")),
        frame(3, replayed_delta(6, b"six")),
        frame(4, replayed_delta(7, b"seven")),
    ]);

    let mut connection = LocalConnection::attach_over_transport(
        transport,
        fence(),
        "attach-secret".to_string(),
        resume_options(4),
    )
    .unwrap();

    assert_eq!(
        connection.attach_replay(),
        &AttachReplay::Resumed {
            after_output_seq: 4,
            through_output_seq: 7,
        }
    );
    assert!(
        connection.initial_snapshot().is_none(),
        "a resumed attach must not carry a screen snapshot -- skipping it is the feature"
    );
    assert_eq!(connection.last_output_seq(), 7);

    // The missed bytes are still owed to the caller, in order, ahead of
    // anything live.
    let replayed = (0..3)
        .map(|_| connection.read_body().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        replayed,
        vec![
            replayed_delta(5, b"five"),
            replayed_delta(6, b"six"),
            replayed_delta(7, b"seven"),
        ]
    );

    match &host.read_frame(&codec()).unwrap().unwrap().frame().body {
        FrameBody::Hello(hello) => {
            assert_eq!(
                hello.reconnect_cursor.as_ref().map(|c| c.after_output_seq),
                Some(4),
                "the client must actually offer the cursor"
            );
            assert!(
                hello
                    .requested_capabilities
                    .iter()
                    .any(|capability| capability == RECONNECT_RESUME_CAPABILITY)
            );
        }
        other => panic!("the client did not send a Hello, it sent {other:?}"),
    }
}

/// A cursor already at the Host's current sequence resumes with no frames.
///
/// The script deliberately queues nothing after the ack. Before the change
/// the client blocked here waiting for a snapshot; the assertion that
/// matters is that the attach completes at all.
#[test]
fn an_up_to_date_cursor_resumes_without_reading_a_single_frame() {
    let (transport, _host) = relayed_transport(&[frame(1, FrameBody::HelloAck(resume_ack(9, 3)))]);

    let connection = LocalConnection::attach_over_transport(
        transport,
        fence(),
        "attach-secret".to_string(),
        resume_options(9),
    )
    .unwrap();

    assert_eq!(
        connection.attach_replay(),
        &AttachReplay::Resumed {
            after_output_seq: 9,
            through_output_seq: 9,
        }
    );
    assert!(connection.initial_snapshot().is_none());
}

/// When the retained window has moved past the cursor, the fallback fires
/// **and is distinguishable**.
///
/// A silent gap is the failure this whole path has to avoid: the user reads
/// missing output as the agent having done something it did not do. So the
/// assertion is not "a snapshot arrived" but "the client can tell this
/// snapshot from a lossless one".
#[test]
fn a_cursor_past_the_retained_window_falls_back_to_a_snapshot_that_says_so() {
    let gap = ReplayGap {
        cursor: ReconnectCursor {
            terminal_epoch: fence().terminal_epoch,
            after_output_seq: 1,
        },
        earliest_retained_output_seq: 5,
        current_output_seq: 9,
    };
    let (transport, _host) = relayed_transport(&[
        frame(1, FrameBody::HelloAck(resume_ack(9, 5))),
        frame(2, FrameBody::ReplayGap(gap.clone())),
        frame(3, FrameBody::ScreenSnapshot(screen_snapshot(9))),
    ]);

    let connection = LocalConnection::attach_over_transport(
        transport,
        fence(),
        "attach-secret".to_string(),
        resume_options(1),
    )
    .unwrap();

    assert_eq!(
        connection.attach_replay(),
        &AttachReplay::SnapshotAfterGap(gap),
        "a fallback after a lost window must not be reported as a clean snapshot"
    );
    assert_eq!(
        connection
            .initial_snapshot()
            .map(|snapshot| snapshot.sequence_through),
        Some(9),
        "the recovery snapshot still has to be delivered"
    );
    assert_eq!(connection.last_output_seq(), 9);
}

/// A Host that never selected the capability answers the old way, and the
/// client takes the old answer.
///
/// This is what makes the change additive: an offered cursor is a request,
/// and an older Host that ignores it is not a protocol violation.
#[test]
fn a_host_without_the_capability_still_answers_a_cursor_with_a_snapshot() {
    let mut ack = hello_ack(&["screen_snapshot", "live_output"]);
    ack.current_output_seq = 9;
    let (transport, _host) = relayed_transport(&[
        frame(1, FrameBody::HelloAck(ack)),
        frame(2, FrameBody::ScreenSnapshot(screen_snapshot(9))),
    ]);

    let connection = LocalConnection::attach_over_transport(
        transport,
        fence(),
        "attach-secret".to_string(),
        resume_options(4),
    )
    .unwrap();

    assert_eq!(connection.attach_replay(), &AttachReplay::Snapshot);
    assert_eq!(
        connection
            .initial_snapshot()
            .map(|snapshot| snapshot.sequence_through),
        Some(9)
    );
}

/// A hole inside the replay is corruption, not a degraded resume.
///
/// The caller is about to append these bytes to history it already has, so
/// a skipped sequence must fail the attach rather than be presented as
/// continuous output.
#[test]
fn a_noncontiguous_replay_is_refused_rather_than_appended() {
    let (transport, _host) = relayed_transport(&[
        frame(1, FrameBody::HelloAck(resume_ack(7, 3))),
        frame(2, replayed_delta(5, b"five")),
        frame(3, replayed_delta(7, b"seven")),
    ]);

    assert!(matches!(
        LocalConnection::attach_over_transport(
            transport,
            fence(),
            "attach-secret".to_string(),
            resume_options(4),
        ),
        Err(ClientError::InconsistentStream {
            reason: "replayed output delta is not contiguous"
        })
    ));
}

/// Offering no cursor must not negotiate resume at all.
#[test]
fn a_plain_attach_does_not_ask_for_the_resume_capability() {
    let capabilities = requested_capabilities(LocalAttachRole::Observer, &[], false);
    assert!(
        !capabilities
            .iter()
            .any(|capability| capability == RECONNECT_RESUME_CAPABILITY)
    );
    let with_cursor = requested_capabilities(LocalAttachRole::Observer, &[], true);
    assert!(
        with_cursor
            .iter()
            .any(|capability| capability == RECONNECT_RESUME_CAPABILITY)
    );
}
