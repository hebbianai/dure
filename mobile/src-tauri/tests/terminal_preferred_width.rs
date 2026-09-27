//! Exercise the shared SSH/Hub relay join with the real attach handshake.
//! The Host's canonical viewport fixtures avoid a second protocol encoder.

use dure_mobile_lib::catalog::RemoteSession;
use dure_mobile_lib::relay::{open_relayed_terminal_surface, RelayTerminalAttachment};
use hmux_client::transport::{
    AttachedTransport, FrameCodec, FrameReader, FrameWriter, TransportInterrupt,
};
use hmux_client::TerminalSurfaceAccess;
use hmux_host::local_protocol::{
    AttachMode, AuthorizationPosture, FrameBody, FrameLimits, Hello, HelloAck, LifecycleState,
    ProcessProof, WireFrame, PROTOCOL_V1,
};
use hmux_host::local_transport::memory::MemoryEndpoint;
use std::sync::Arc;
use std::time::Duration;

const PREFERRED_WIDTH: &str = "terminal_preferred_width_v1";

#[derive(Debug)]
struct NoopInterrupt;

impl TransportInterrupt for NoopInterrupt {
    fn interrupt(&self) {}
}

fn attach(
    access: TerminalSurfaceAccess,
    select_preferred_width: bool,
) -> (RelayTerminalAttachment, Hello) {
    let session: RemoteSession = serde_json::from_value(serde_json::json!({
        "session_id": "fixture-session",
        "workspace_id": "fixture-workspace",
        "provider_id": "fixture",
        "runner_principal": "fixture-owner",
        "runner_instance": "fixture-runner",
        "channel_epoch": "1",
        "host_instance_id": "fixture-host",
        "terminal_epoch": "epoch-viewport-parts"
    }))
    .unwrap();
    let mut selected_capabilities = vec![
        "terminal_state_binary_v1".to_string(),
        "terminal_viewport_projection_v1".to_string(),
        "terminal_viewport_multipart_v1".to_string(),
    ];
    if access == TerminalSurfaceAccess::Writer {
        selected_capabilities.push("terminal_input_intent_v1".into());
    }
    if select_preferred_width {
        selected_capabilities.push(PREFERRED_WIDTH.into());
    }

    let codec = FrameCodec::new(FrameLimits::default());
    let (client_reader, mut host_writer) = MemoryEndpoint::pair();
    let (client_writer, mut host_reader) = MemoryEndpoint::pair();
    host_writer
        .write_frame(
            &codec
                .encode(&WireFrame {
                    protocol_version: PROTOCOL_V1,
                    frame_id: 1,
                    body: FrameBody::HelloAck(HelloAck {
                        selected_version: PROTOCOL_V1,
                        selected_capabilities,
                        actual_fence: session.fence().unwrap(),
                        host_build_version: "fixture".into(),
                        lifecycle: LifecycleState::Observing,
                        host_process: ProcessProof {
                            process_id: 10,
                            start_marker: "fixture-start".into(),
                        },
                        provider_process: None,
                        earliest_retained_output_seq: 1,
                        current_output_seq: 43,
                        controller_generation: 1,
                        authorization_posture: AuthorizationPosture::StandaloneLocalOwner,
                    }),
                })
                .unwrap(),
        )
        .unwrap();
    for payload in [
        include_bytes!("../../../hmux/crates/terminal-state-protocol/fixtures/terminal-viewport-frame-part-0-v1.bin").as_slice(),
        include_bytes!("../../../hmux/crates/terminal-state-protocol/fixtures/terminal-viewport-frame-part-1-v1.bin").as_slice(),
    ] {
        let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(payload);
        host_writer.write_frame(&frame).unwrap();
    }

    let interrupt: Arc<dyn TransportInterrupt> = Arc::new(NoopInterrupt);
    let transport = AttachedTransport::relayed(
        Box::new(client_reader),
        Box::new(client_writer),
        Arc::clone(&interrupt),
    );
    let attachment = open_relayed_terminal_surface(transport, interrupt, &session, access).unwrap();
    assert_eq!(
        attachment.surface.current_frame().viewport().title,
        "fixture title"
    );
    let frame = host_reader.read_frame(&codec).unwrap().unwrap();
    let FrameBody::Hello(hello) = &frame.frame().body else {
        panic!("mobile relay did not send Hello");
    };
    assert_eq!(hello.requested_mode, AttachMode::Observer);
    for capability in [
        "agent_identity_projection_v1",
        "provider_conversation_identity_v1",
        "provider_conversation_continuation_v1",
        "working_directory_frame_v1",
        "terminal_viewport_wheel_v1",
        "terminal_viewport_multipart_v1",
    ] {
        assert!(
            hello
                .requested_capabilities
                .iter()
                .any(|value| value == capability),
            "mobile relay lost the existing optional request {capability}"
        );
    }
    (attachment, hello.clone())
}

#[test]
fn writer_requests_preferred_width_and_records_host_selection() {
    let (attachment, hello) = attach(TerminalSurfaceAccess::Writer, true);
    assert!(hello
        .requested_capabilities
        .iter()
        .any(|value| value == PREFERRED_WIDTH));
    assert!(attachment
        .surface
        .selected_capabilities()
        .iter()
        .any(|value| value == PREFERRED_WIDTH));
}

#[test]
fn writer_attaches_when_an_older_host_omits_preferred_width() {
    let (attachment, hello) = attach(TerminalSurfaceAccess::Writer, false);
    assert!(hello
        .requested_capabilities
        .iter()
        .any(|value| value == PREFERRED_WIDTH));
    assert!(!attachment
        .surface
        .selected_capabilities()
        .iter()
        .any(|value| value == PREFERRED_WIDTH));
}

#[test]
fn read_only_does_not_request_preferred_width_or_gain_resize_authority() {
    let (mut attachment, hello) = attach(TerminalSurfaceAccess::ReadOnly, false);
    for capability in [PREFERRED_WIDTH, "terminal_input_intent_v1"] {
        assert!(!hello
            .requested_capabilities
            .iter()
            .any(|value| value == capability));
        assert!(!attachment
            .surface
            .selected_capabilities()
            .iter()
            .any(|value| value == capability));
    }
    let error = attachment
        .surface
        .send_resize_confirmed(120, 40, Duration::from_secs(1))
        .err()
        .expect("read-only attachment must not send a resize");
    assert_eq!(error.code(), "hmux_capability_missing");
}
