//! Native Windows named-pipe dialer.
//!
//! Opening the exact manifest address and verifying the process that owns the
//! connected server end stay coupled here. Only after SID, integrity, and
//! elevation match is that same carrier labelled colocated for one session.

use super::AttachedTransport;
use crate::error::ClientError;
use hmux_local_platform::local_peer_identity::verify_named_pipe_server_same_user;
use hmux_local_platform::peer_attestation::SessionScope;
use hmux_local_platform::transport::windows_named_pipe::WindowsNamedPipeTransport;
use hmux_session_protocol::transport::TransportError;
use std::path::Path;
use std::time::Instant;

pub struct WindowsNamedPipeDialer;

impl WindowsNamedPipeDialer {
    pub fn open(address: &Path, scope: SessionScope) -> Result<AttachedTransport, ClientError> {
        Self::open_before(address, scope, None)
    }

    pub(crate) fn open_before(
        address: &Path,
        scope: SessionScope,
        deadline: Option<Instant>,
    ) -> Result<AttachedTransport, ClientError> {
        let transport =
            WindowsNamedPipeTransport::connect_before(address, deadline).map_err(connect_error)?;
        let credential =
            verify_named_pipe_server_same_user(transport.raw_handle()).map_err(|source| {
                ClientError::Transport {
                    code: "hmux_peer_identity_refused",
                    message: source.to_string(),
                }
            })?;
        let (reader, writer, interrupt) = transport.into_parts();
        Ok(AttachedTransport::colocated(
            Box::new(reader),
            Box::new(writer),
            interrupt,
            credential.bind_to_session(scope),
        ))
    }
}

fn connect_error(error: TransportError) -> ClientError {
    if matches!(error, TransportError::FirstByteTimeout) {
        ClientError::Transport {
            code: "hmux_attach_deadline_exceeded",
            message: "Hmux attach deadline elapsed while connecting to the Windows named pipe"
                .into(),
        }
    } else {
        ClientError::from(error)
    }
}
