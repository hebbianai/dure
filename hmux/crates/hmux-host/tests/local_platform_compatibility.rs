#![cfg(unix)]

use hmux_host::local_protocol::{
    Detach, FrameBody, FrameCodec, FrameLimits, PROTOCOL_V1, WireFrame,
};
use hmux_local_platform::peer_attestation::{AttestationError, PeerAttestation, SessionScope};
use hmux_session_protocol::transport::{FrameReader, FrameWriter};
use std::os::unix::net::{UnixListener, UnixStream};

#[test]
fn host_credentials_bind_to_the_canonical_scope_without_widening_authority() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("compatibility.sock");
    let listener = UnixListener::bind(path.clone()).unwrap();
    let client = UnixStream::connect(path).unwrap();
    let (_server, _) = listener.accept().unwrap();
    let credential =
        hmux_host::local_peer_identity::verify_pathname_socket_same_user(&client).unwrap();
    let scope = SessionScope::new("workspace", "session", "host-1");
    let attestation: hmux_host::peer_attestation::PeerAttestation =
        PeerAttestation::ColocatedSameUser(credential.bind_to_session(scope.clone()));

    assert!(attestation.witness_for(&scope).is_ok());
    assert!(matches!(
        attestation.witness_for(&SessionScope::new("workspace", "session", "host-2")),
        Err(AttestationError::ScopeMismatch { .. })
    ));
    assert!(matches!(
        PeerAttestation::Relayed.witness_for(&scope),
        Err(AttestationError::NotColocated)
    ));
}

#[test]
fn host_carrier_aliases_exchange_ordered_frames_with_the_canonical_reader() {
    let (left, right) = UnixStream::pair().unwrap();
    let mut writer = hmux_host::local_transport::fd::FdFrameWriter::new(left);
    let mut reader: hmux_host::local_transport::fd::FdFrameReader<UnixStream> =
        hmux_local_platform::transport::fd::FdFrameReader::new(right);
    let codec = FrameCodec::new(FrameLimits::default());
    for id in 1..=2 {
        let frame = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: id,
            body: FrameBody::Detach(Detach {
                reason: Some(format!("frame-{id}")),
            }),
        };
        writer.write_frame(&codec.encode(&frame).unwrap()).unwrap();
        let received = reader.read_frame(&codec).unwrap().unwrap();
        assert_eq!(received.frame(), &frame);
    }
    drop(writer);
    assert!(reader.read_frame(&codec).unwrap().is_none());
}
