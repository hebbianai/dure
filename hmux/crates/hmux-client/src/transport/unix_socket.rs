//! The local Unix socket dialer.
//!
//! This is where "local" stops being an assumption and becomes a value.
//!
//! Today the client never asks the kernel who is listening on the address it
//! dials. It trusts the address transitively, because the manifest that
//! carried it was read under `path_security` — but that proves who *wrote* the
//! address, not who is *serving* it now. Running the kernel credential check on
//! the connected socket closes that gap, and hands back the witness that
//! colocation-dependent operations will require by argument.

use super::AttachedTransport;
use crate::error::ClientError;
use hmux_local_platform::local_peer_identity::verify_pathname_socket_same_user;
use hmux_local_platform::peer_attestation::SessionScope;
use hmux_local_platform::transport::fd::{
    FdFrameReader, SocketInterrupt, UnixSocketFrameWriter, wait_until_writable,
};
use socket2::{Domain, SockAddr, Socket, Type};
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

const CONNECT_OPERATION: &str = "connect to Hmux Host";

fn connect_error(source: io::Error) -> ClientError {
    match source.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => {
            ClientError::EndpointUnavailable { source }
        }
        _ => ClientError::Io {
            operation: CONNECT_OPERATION,
            source,
        },
    }
}

fn deadline_exceeded(phase: &'static str) -> ClientError {
    ClientError::Transport {
        code: "hmux_attach_deadline_exceeded",
        message: format!("Hmux attach deadline elapsed during {phase}"),
    }
}

fn connect_before(address: &Path, deadline: Option<Instant>) -> Result<UnixStream, ClientError> {
    let Some(deadline) = deadline else {
        return UnixStream::connect(address).map_err(connect_error);
    };
    if Instant::now() >= deadline {
        return Err(deadline_exceeded("connect"));
    }
    let socket =
        Socket::new(Domain::UNIX, Type::STREAM, None).map_err(|source| ClientError::Io {
            operation: CONNECT_OPERATION,
            source,
        })?;
    socket
        .set_nonblocking(true)
        .map_err(|source| ClientError::Io {
            operation: CONNECT_OPERATION,
            source,
        })?;
    let address = SockAddr::unix(address).map_err(|source| ClientError::Io {
        operation: CONNECT_OPERATION,
        source,
    })?;
    match socket.connect(&address) {
        Ok(()) => {}
        Err(source) => {
            let raw = source.raw_os_error();
            let pending = source.kind() == io::ErrorKind::WouldBlock
                || raw == Some(libc::EINPROGRESS)
                || raw == Some(libc::EALREADY);
            if !pending && raw != Some(libc::EISCONN) {
                return Err(connect_error(source));
            }
            if pending
                && !wait_until_writable(socket.as_raw_fd(), deadline).map_err(|source| {
                    ClientError::Io {
                        operation: CONNECT_OPERATION,
                        source,
                    }
                })?
            {
                return Err(deadline_exceeded("connect"));
            }
        }
    }
    if let Some(source) = socket.take_error().map_err(|source| ClientError::Io {
        operation: CONNECT_OPERATION,
        source,
    })? {
        return Err(connect_error(source));
    }
    socket
        .set_nonblocking(false)
        .map_err(|source| ClientError::Io {
            operation: CONNECT_OPERATION,
            source,
        })?;
    let descriptor: OwnedFd = socket.into();
    Ok(UnixStream::from(descriptor))
}

/// Connects to a Host's socket and proves what the connection establishes.
pub struct UnixSocketDialer;

impl UnixSocketDialer {
    /// Dials `address` and verifies the peer before returning anything usable.
    ///
    /// The dialer takes a **path and connects itself** rather than accepting a
    /// caller-supplied stream. That is deliberate: the colocation witness is
    /// unforgeable only while nothing hands this code a `socketpair`, whose
    /// endpoints satisfy every same-user check while proving nothing. Owning
    /// the connect step means a caller cannot substitute one, so defeating the
    /// seal would take a deliberate new dialer rather than an accident.
    pub fn open(address: &Path, scope: SessionScope) -> Result<AttachedTransport, ClientError> {
        Self::open_before(address, scope, None)
    }

    pub(crate) fn open_before(
        address: &Path,
        scope: SessionScope,
        deadline: Option<Instant>,
    ) -> Result<AttachedTransport, ClientError> {
        let stream = connect_before(address, deadline)?;
        let credential =
            verify_pathname_socket_same_user(&stream).map_err(|source| ClientError::Transport {
                code: "hmux_peer_identity_refused",
                message: source.to_string(),
            })?;

        let writer_half = stream.try_clone().map_err(|source| ClientError::Io {
            operation: "clone Hmux writer stream",
            source,
        })?;
        let interrupt_half = stream.try_clone().map_err(|source| ClientError::Io {
            operation: "clone Hmux connection interrupt handle",
            source,
        })?;

        Ok(AttachedTransport::colocated(
            Box::new(FdFrameReader::new(stream)),
            Box::new(UnixSocketFrameWriter::new(writer_half)),
            // A socket needs no wake pipe: `shutdown` already wakes every
            // thread blocked on any duplicate, which is two fewer descriptors
            // and one fewer pollfd on every read of every local attach.
            Arc::new(SocketInterrupt::new(interrupt_half)),
            credential.bind_to_session(scope),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_session_protocol::transport::{FrameWriter, TransportError};
    use std::io::Write;
    use std::os::unix::net::UnixListener;
    use std::time::Duration;

    fn scope() -> SessionScope {
        SessionScope::new("workspace-1", "session-1", "host-1")
    }

    #[test]
    fn a_dialed_socket_yields_a_colocation_witness_for_its_session() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("host.sock");
        let _listener = UnixListener::bind(&path).unwrap();

        let transport = UnixSocketDialer::open(&path, scope()).unwrap();

        assert!(transport.attestation.witness_for(&scope()).is_ok());
    }

    /// The witness must not answer for a session it was not taken against,
    /// even on a perfectly good local socket.
    #[test]
    fn the_witness_does_not_answer_for_another_session() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("host.sock");
        let _listener = UnixListener::bind(&path).unwrap();

        let transport = UnixSocketDialer::open(&path, scope()).unwrap();
        let other = SessionScope::new("workspace-1", "session-2", "host-1");

        assert!(transport.attestation.witness_for(&other).is_err());
    }

    /// The compatibility contract this whole split exists to preserve.
    ///
    /// `hmux-cli`'s interactive attach polls with a short budget and treats a
    /// timeout as "no frame yet, keep polling" (`is_read_timeout`, which
    /// matches `ClientError::Io` with an `ErrorKind::TimedOut` source). If a
    /// first-byte timeout stopped mapping to exactly that, the CLI would treat
    /// an ordinary quiet moment as a fatal error.
    #[test]
    fn a_first_byte_timeout_still_looks_like_a_read_timeout_to_the_cli() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("host.sock");
        let _listener = UnixListener::bind(&path).unwrap();

        let mut transport = UnixSocketDialer::open(&path, scope()).unwrap();
        let error = transport
            .reader
            .wait_readable(Some(Duration::from_millis(20)))
            .unwrap_err();
        assert!(matches!(error, TransportError::FirstByteTimeout));

        let client_error = ClientError::from(error);
        match &client_error {
            ClientError::Io { operation, source } => {
                assert_eq!(*operation, "wait for Hmux frame");
                assert_eq!(source.kind(), std::io::ErrorKind::TimedOut);
            }
            other => panic!("expected a timed-out Io error, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_socket_requires_lifecycle_resync() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("absent.sock");

        let error = UnixSocketDialer::open(&path, scope()).unwrap_err();

        assert!(matches!(&error, ClientError::EndpointUnavailable { .. }));
        assert_eq!(error.code(), "hmux_endpoint_unavailable");
        assert_eq!(
            error.retry_directive(),
            crate::RetryDirective::RetryAfterResync,
            "a vanished endpoint must let the caller refresh lifecycle authority before retrying",
        );
    }

    #[test]
    fn an_elapsed_deadline_refuses_the_dial_before_connecting() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("host.sock");
        let _listener = UnixListener::bind(&path).unwrap();

        let error =
            UnixSocketDialer::open_before(&path, scope(), Some(Instant::now())).unwrap_err();

        assert!(matches!(
            error,
            ClientError::Transport {
                code: "hmux_attach_deadline_exceeded",
                ..
            }
        ));
    }

    #[test]
    fn a_blocked_hello_write_stops_at_its_absolute_deadline() {
        let (mut stream, _peer) = UnixStream::pair().unwrap();
        socket2::SockRef::from(&stream)
            .set_send_buffer_size(4_096)
            .unwrap();
        stream.set_nonblocking(true).unwrap();
        let fill = [0_u8; 16 * 1_024];
        loop {
            match stream.write(&fill) {
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("failed to fill the socket send buffer: {error}"),
            }
        }
        stream.set_nonblocking(false).unwrap();

        let mut writer = UnixSocketFrameWriter::new(stream);
        let started = Instant::now();
        let error = writer
            .write_frame_before(b"hello", Some(started + Duration::from_millis(50)))
            .unwrap_err();

        assert!(
            matches!(&error, TransportError::WriteNotStarted),
            "unexpected error: {error:?}"
        );
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "deadline write exceeded its scheduling tolerance: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn the_transport_round_trips_frames() {
        use hmux_session_protocol::{
            Detach, FrameBody, FrameCodec, FrameLimits, PROTOCOL_V1, WireFrame,
        };

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("host.sock");
        let listener = UnixListener::bind(&path).unwrap();

        let mut transport = UnixSocketDialer::open(&path, scope()).unwrap();
        let (mut accepted, _) = listener.accept().unwrap();

        let codec = FrameCodec::new(FrameLimits::default());
        let encoded = codec
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body: FrameBody::Detach(Detach {
                    reason: Some("hello".into()),
                }),
            })
            .unwrap();
        accepted.write_all(&encoded).unwrap();
        accepted.flush().unwrap();

        let decoded = transport.reader.read_frame(&codec).unwrap().unwrap();
        match &decoded.frame().body {
            FrameBody::Detach(detach) => assert_eq!(detach.reason.as_deref(), Some("hello")),
            other => panic!("unexpected body {other:?}"),
        }
    }
}
