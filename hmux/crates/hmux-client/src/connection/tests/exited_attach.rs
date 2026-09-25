use super::*;
use hmux_host::local_discovery::{
    ClaimLinkage, ExitedManifest, HostLifetimeIdentity, LocalEndpoint, ManifestCommon, SessionClass,
};
use hmux_host::provider_epoch::{ExitTombstone, ProviderExitKind};

fn exited_manifest(endpoint_address: String) -> DiscoveryManifest {
    let provider_process = ProcessProof {
        process_id: 11,
        start_marker: "provider-start".into(),
    };
    DiscoveryManifest::Exited(ExitedManifest {
        common: ManifestCommon {
            launch_program: None,
            schema_version: 1,
            host_build_version: "test".into(),
            supported_protocol: VersionRange {
                minimum: PROTOCOL_V1,
                maximum: PROTOCOL_V1,
            },
            capabilities: vec!["screen_snapshot".into()],
            lifetime: HostLifetimeIdentity {
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 1,
            },
            host_instance_id: "host-1".into(),
            provider_id: "fixture".into(),
            runtime_context: RuntimeContext::default(),
            claim_linkage: ClaimLinkage {
                claim_id: None,
                kickoff_action_id: None,
            },
            host_process: ProcessProof {
                process_id: 10,
                start_marker: "host-start".into(),
            },
            created_unix_ms: 1,
            session_class: SessionClass::Managed,
            session_name: None,
            retirement_policy: None,
        },
        tombstone: Box::new(ExitTombstone {
            provider_conversation_identity: None,
            fence: fence(),
            provider_process,
            exit: Exit {
                final_output_seq: 1,
                exit_code: Some(0),
                platform_status: None,
                reason: "provider_exit".into(),
            },
            exit_kind: ProviderExitKind::Normal,
            created_unix_ms: 2,
            failure: None,
        }),
        endpoint: LocalEndpoint {
            kind: LocalEndpointKind::UnixSocket,
            address: endpoint_address,
        },
        capability_token: "attach-secret".into(),
        exited_unix_ms: 2,
    })
}

#[test]
fn exited_attach_binds_the_live_host_without_reviving_the_tombstone_provider() {
    let manifest = exited_manifest("host.sock".into());
    let context = manifest_attach_context(&manifest).unwrap();
    assert_eq!(context.expected_processes.host.process_id, 10);
    assert_eq!(context.expected_processes.provider, None);
}

// An exited manifest keeps its endpoint so a lingering Host can still serve
// the final screen. Once that Host is gone (socket unlinked on shutdown), the
// session fact is "exited" — surfacing the dial failure as a transport fault
// sent panes into a retry posture no resync could ever satisfy.
#[cfg(unix)]
#[test]
fn exited_manifest_with_a_gone_endpoint_reports_session_exited_not_transport() {
    let root = TempDir::new().unwrap();
    let absent = root.path().join("absent-host.sock");
    let manifest = exited_manifest(absent.to_string_lossy().into_owned());
    let error = connect_manifest(
        &manifest,
        ConnectionOptions::new(LocalAttachRole::Observer, None),
    )
    .expect_err("attach cannot succeed without a live endpoint");
    assert_eq!(error.code(), "hmux_session_exited");
    assert_eq!(error.retry_directive(), crate::RetryDirective::Never);
}

#[cfg(unix)]
fn attach_to_closing_peer(exited: bool, incompatible: bool) -> ClientError {
    use hmux_host::local_discovery::ReadyManifest;
    use hmux_local_platform::transport::fd::{FdFrameReader, UnixSocketFrameWriter};
    use std::os::unix::net::UnixListener;

    let root = TempDir::new().unwrap();
    let endpoint = root.path().join("host.sock");
    let listener = UnixListener::bind(&endpoint).unwrap();
    let manifest = exited_manifest(endpoint.to_string_lossy().into_owned());
    let manifest = if exited {
        manifest
    } else {
        let DiscoveryManifest::Exited(value) = manifest else {
            unreachable!()
        };
        DiscoveryManifest::Ready(ReadyManifest {
            common: value.common,
            provider_process: value.tombstone.provider_process,
            terminal_epoch: value.tombstone.fence.terminal_epoch,
            ready_output_seq: 1,
            endpoint: value.endpoint,
            capability_token: value.capability_token,
            ready_unix_ms: 1,
        })
    };
    let peer = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = FdFrameReader::new(stream.try_clone().unwrap());
        assert!(reader.read_frame(&codec()).unwrap().is_some());
        if incompatible {
            let mut writer = UnixSocketFrameWriter::new(stream);
            let mut ack = hello_ack(&[]);
            ack.selected_version = hmux_session_protocol::ProtocolVersion {
                major: 99,
                minor: 0,
            };
            let bytes = codec()
                .encode(&WireFrame {
                    protocol_version: ack.selected_version,
                    frame_id: 1,
                    body: FrameBody::HelloAck(ack),
                })
                .unwrap();
            writer.write_frame(&bytes).unwrap();
        }
    });
    let error = connect_manifest(
        &manifest,
        ConnectionOptions::new(LocalAttachRole::Observer, None),
    )
    .expect_err("the peer does not complete a compatible attach");
    peer.join().unwrap();
    error
}

#[cfg(unix)]
#[test]
fn exited_manifest_preserves_exit_when_the_peer_closes_during_handshake() {
    let error = attach_to_closing_peer(true, false);
    assert_eq!(error.code(), "hmux_session_exited");
    assert_eq!(error.retry_directive(), crate::RetryDirective::Never);
}

#[cfg(unix)]
#[test]
fn a_live_manifest_does_not_infer_exit_from_a_closed_handshake() {
    let error = attach_to_closing_peer(false, false);
    assert_ne!(error.code(), "hmux_session_exited");
}

#[cfg(unix)]
#[test]
fn an_exited_manifest_does_not_hide_protocol_incompatibility() {
    let error = attach_to_closing_peer(true, true);
    assert_eq!(error.code(), "hmux_protocol_version_unsupported");
}
