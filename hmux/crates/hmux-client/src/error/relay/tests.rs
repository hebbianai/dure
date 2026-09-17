use super::*;
use hmux_session_protocol::{
    FrameBody, FrameCodec, FrameCodecError, FrameLimits, PROTOCOL_V1, WireFrame,
};
use std::io;

fn wire(error: &ClientError) -> WireFrame {
    WireFrame {
        protocol_version: PROTOCOL_V1,
        frame_id: 1,
        body: FrameBody::Error(error.to_error_frame()),
    }
}

#[test]
fn client_failures_keep_their_identity_and_retry_across_two_relays() {
    let failures = [
        ClientError::InconsistentStream {
            reason: "unexpected terminal epoch",
        },
        ClientError::StreamDesynchronized {
            reason: "truncated record",
        },
        ClientError::Protocol(FrameCodecError::EmptyFrame),
        ClientError::Io {
            operation: "read local frame",
            source: io::Error::new(io::ErrorKind::BrokenPipe, "fixture peer closed"),
        },
        ClientError::EndpointUnavailable {
            source: io::Error::new(io::ErrorKind::ConnectionRefused, "fixture endpoint gone"),
        },
        ClientError::UnexpectedFrame {
            expected: "viewport",
            actual: "hello".into(),
        },
        ClientError::Transport {
            code: "hmux_terminal_surface_delivery_missing",
            message: "no delivery record".into(),
        },
    ];
    let codec = FrameCodec::new(FrameLimits::default());
    for original in failures {
        let expected_code = original.code().to_owned();
        let expected_retry = original.retry_directive();
        let expected_message = original.to_string();
        let mut current = original;
        for _ in 0..2 {
            let bytes = codec.encode(&wire(&current)).unwrap();
            let FrameBody::Error(frame) = codec.decode(&bytes).unwrap().body else {
                panic!("relay did not preserve the Error frame");
            };
            assert_eq!(frame.origin_code.as_deref(), Some(expected_code.as_str()));
            current = host_refused(frame);
            assert_eq!(current.code(), expected_code);
            assert_eq!(current.retry_directive(), expected_retry);
            assert_eq!(current.to_string(), expected_message);
        }
    }
}

#[cfg(feature = "terminal-state-stream")]
#[test]
fn binary_protocol_failure_keeps_its_code() {
    let source = ClientError::TerminalStateProtocol(
        terminal_state_protocol::decode_record(b"invalid binary record")
            .err()
            .expect("invalid binary record must be refused"),
    );
    let received = host_refused(source.to_error_frame());
    assert_eq!(received.code(), "hmux_terminal_state_protocol_failed");
    assert_eq!(received.retry_directive(), source.retry_directive());
}

#[test]
fn host_refusals_keep_the_existing_wire_family_without_an_origin_override() {
    for code in [
        HostErrorCode::IdentityMismatch,
        HostErrorCode::UnsupportedProtocolVersion,
        HostErrorCode::UnsupportedCapability,
        HostErrorCode::AuthorizationDenied,
        HostErrorCode::DegradedAuthorizationUnavailable,
        HostErrorCode::ControllerConflict,
        HostErrorCode::StaleControllerGeneration,
        HostErrorCode::ReplayGap,
        HostErrorCode::SessionExited,
        HostErrorCode::PtyLost,
        HostErrorCode::StaleDiscovery,
        HostErrorCode::ResourceLimit,
        HostErrorCode::InvalidTerminalDimensions,
        HostErrorCode::PlatformResizeFailed,
        HostErrorCode::TransportClosed,
    ] {
        for retry in [
            RetryDirective::Never,
            RetryDirective::Reconnect,
            RetryDirective::RetryAfterResync,
        ] {
            let source = ClientError::HostRefused {
                code,
                retry,
                message: "Host reason".into(),
            };
            let frame = source.to_error_frame();
            assert!(frame.origin_code.is_none());
            let received = host_refused(frame);
            assert_eq!(received.code(), source.code());
            assert_eq!(received.retry_directive(), retry);
            assert_eq!(received.to_string(), source.to_string());
        }
    }
}

#[test]
fn old_error_readers_can_ignore_the_additive_origin_code() {
    // Freeze the pre-origin Error payload independently of the current struct.
    #[derive(serde::Deserialize)]
    struct LegacyError {
        code: ErrorCode,
        message: String,
        retry: RetryPosture,
        required_capability: Option<String>,
        supported_versions: Option<hmux_session_protocol::VersionRange>,
        in_reply_to_request_id: Option<String>,
    }
    let source = ClientError::EndpointUnavailable {
        source: io::Error::new(io::ErrorKind::ConnectionRefused, "fixture endpoint gone"),
    };
    let json = serde_json::to_value(source.to_error_frame()).unwrap();
    let legacy: LegacyError = serde_json::from_value(json).unwrap();
    assert_eq!(legacy.code, ErrorCode::TransportClosed);
    assert_eq!(legacy.message, source.to_string());
    assert_eq!(legacy.retry, RetryPosture::RetryAfterResync);
    assert!(legacy.required_capability.is_none());
    assert!(legacy.supported_versions.is_none());
    assert!(legacy.in_reply_to_request_id.is_none());
}

#[test]
fn origin_code_is_bounded_at_the_wire_boundary() {
    let codec = FrameCodec::new(FrameLimits::default());
    for code in [
        String::new(),
        "x".repeat(codec.limits().max_identifier_bytes + 1),
    ] {
        let source = ClientError::RelayedFailure {
            code,
            message: "fixture failure".into(),
            retry: RetryDirective::Never,
        };
        assert!(codec.encode(&wire(&source)).is_err());
    }
}
