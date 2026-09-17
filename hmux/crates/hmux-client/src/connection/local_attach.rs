use super::{
    AttachContext, ConnectionOptions, LocalAttachRole, LocalConnection, complete_attach,
    endpoint_kind_name, manifest_attach_context, session_scope,
};
use crate::ClientError;
use hmux_host::local_discovery::{DiscoveryManifest, LocalEndpointKind};
use std::io::ErrorKind;

pub(super) fn connect_manifest(
    manifest: &DiscoveryManifest,
    mut options: ConnectionOptions,
) -> Result<LocalConnection, ClientError> {
    let AttachContext {
        endpoint,
        capability_token,
        expected_fence,
        expected_processes,
        exited,
    } = manifest_attach_context(manifest)?;
    #[cfg(unix)]
    let expected_endpoint_kind = LocalEndpointKind::UnixSocket;
    #[cfg(windows)]
    let expected_endpoint_kind = LocalEndpointKind::WindowsNamedPipe;
    if endpoint.kind != expected_endpoint_kind {
        return Err(ClientError::UnsupportedEndpoint {
            kind: endpoint_kind_name(endpoint.kind),
        });
    }
    if exited && options.role != LocalAttachRole::Observer {
        return Err(ClientError::transport(
            "hmux_session_exited",
            "An exited Hmux session can only be inspected",
        ));
    }

    // The dialer owns the connect step and returns the peer evidence with the
    // stream. The old path also armed SO_SNDTIMEO here and never cleared it,
    // so a 3s handshake budget silently governed every write for the life of
    // the connection -- and a write that times out mid-frame leaves a partial
    // length prefix on the wire, which desynchronizes it permanently.
    options.begin_handshake();
    options.enforce_handshake_write_deadline = true;
    let scope = session_scope(&expected_fence);
    let transport = crate::transport::dial_local_endpoint(
        std::path::Path::new(&endpoint.address),
        scope,
        options.handshake_deadline,
    )
    .map_err(|error| preserve_exit(exited, error))?;

    complete_attach(
        transport,
        expected_fence,
        capability_token,
        Some(expected_processes),
        options,
    )
    .map_err(|error| preserve_exit(exited, error))
}

// An Exited manifest still permits final-screen inspection while its Host
// lingers. Losing that transport during dial or handshake cannot revive the
// session. Only closed transport evidence is projected through the tombstone;
// permission, identity, protocol and timeout failures retain their own causes.
fn preserve_exit(exited: bool, error: ClientError) -> ClientError {
    if !exited {
        return error;
    }
    let closed = match &error {
        ClientError::EndpointUnavailable { .. } => true,
        ClientError::Io { source, .. } => matches!(
            source.kind(),
            ErrorKind::BrokenPipe | ErrorKind::ConnectionReset | ErrorKind::UnexpectedEof
        ),
        ClientError::UnexpectedFrame { actual, .. } => actual == "closed transport",
        _ => error.code() == crate::error::TRANSPORT_CLOSED_CODE,
    };
    if closed {
        ClientError::transport(
            "hmux_session_exited",
            "The exited Hmux session can no longer provide a terminal attachment",
        )
    } else {
        error
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_broken_transport_requires_an_authoritative_exit() {
        for kind in [
            ErrorKind::BrokenPipe,
            ErrorKind::ConnectionReset,
            ErrorKind::UnexpectedEof,
        ] {
            let error = || ClientError::Io {
                operation: "write Hmux frame",
                source: std::io::Error::new(kind, "closed fixture"),
            };
            assert_eq!(preserve_exit(true, error()).code(), "hmux_session_exited");
            assert_eq!(
                preserve_exit(false, error()).to_string(),
                error().to_string()
            );
        }
    }

    #[test]
    fn a_tombstone_does_not_mask_other_failures() {
        for kind in [
            ErrorKind::PermissionDenied,
            ErrorKind::TimedOut,
            ErrorKind::InvalidData,
        ] {
            let error = ClientError::Io {
                operation: "attach",
                source: std::io::Error::new(kind, "original fixture cause"),
            };
            let original = error.to_string();
            let projected = preserve_exit(true, error);
            assert_eq!(projected.code(), "hmux_io_failed");
            assert_eq!(projected.to_string(), original);
        }
        let error = ClientError::transport("hmux_peer_identity_refused", "original peer refusal");
        assert_eq!(
            preserve_exit(true, error).code(),
            "hmux_peer_identity_refused"
        );
    }
}
