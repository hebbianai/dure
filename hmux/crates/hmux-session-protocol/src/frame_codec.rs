use super::{FrameLimits, FrameValidationError, WireFrame};
use std::fmt;
use std::io::{self, Read, Write};

const LENGTH_PREFIX_BYTES: usize = 4;

#[derive(Clone, Debug)]
pub struct FrameCodec {
    limits: FrameLimits,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DecodedFrame {
    Valid(WireFrame),
    Invalid {
        frame: WireFrame,
        violation: FrameValidationError,
    },
}

impl DecodedFrame {
    #[must_use]
    pub fn frame(&self) -> &WireFrame {
        match self {
            Self::Valid(frame) | Self::Invalid { frame, .. } => frame,
        }
    }

    pub fn into_valid(self) -> Result<WireFrame, FrameCodecError> {
        match self {
            Self::Valid(frame) => Ok(frame),
            Self::Invalid { violation, .. } => Err(FrameCodecError::Validation(violation)),
        }
    }
}

impl FrameCodec {
    #[must_use]
    pub fn new(limits: FrameLimits) -> Self {
        Self { limits }
    }

    #[must_use]
    pub fn limits(&self) -> &FrameLimits {
        &self.limits
    }

    pub fn encode(&self, frame: &WireFrame) -> Result<Vec<u8>, FrameCodecError> {
        frame.validate(&self.limits)?;
        let payload = serde_json::to_vec(frame).map_err(FrameCodecError::Serialization)?;
        self.ensure_payload_length(payload.len())?;
        let length = u32::try_from(payload.len()).map_err(|_| FrameCodecError::FrameTooLarge {
            actual: payload.len(),
            maximum: self.limits.max_frame_bytes,
        })?;
        let mut encoded = Vec::with_capacity(LENGTH_PREFIX_BYTES + payload.len());
        encoded.extend_from_slice(&length.to_be_bytes());
        encoded.extend_from_slice(&payload);
        Ok(encoded)
    }

    pub fn decode(&self, encoded: &[u8]) -> Result<WireFrame, FrameCodecError> {
        self.decode_for_dispatch(encoded)?.into_valid()
    }

    /// Decodes a globally bounded frame while preserving semantic refusal
    /// context. A Host dispatch loop uses this path so an oversized Input or
    /// invalid Resize with a valid request id can still produce the required
    /// request-correlated receipt. Callers must never execute an `Invalid`
    /// frame.
    pub fn decode_for_dispatch(&self, encoded: &[u8]) -> Result<DecodedFrame, FrameCodecError> {
        if encoded.len() < LENGTH_PREFIX_BYTES {
            return Err(FrameCodecError::TruncatedLengthPrefix);
        }
        let declared = u32::from_be_bytes(
            encoded[..LENGTH_PREFIX_BYTES]
                .try_into()
                .expect("the prefix slice has exactly four bytes after the length check"),
        );
        let declared = usize::try_from(declared).expect("u32 always fits usize on supported hosts");
        self.ensure_payload_length(declared)?;
        let actual = encoded.len() - LENGTH_PREFIX_BYTES;
        if actual < declared {
            return Err(FrameCodecError::TruncatedPayload { declared, actual });
        }
        if actual > declared {
            return Err(FrameCodecError::TrailingBytes { declared, actual });
        }
        self.decode_payload_for_dispatch(&encoded[LENGTH_PREFIX_BYTES..])
    }

    pub fn read_from<R: Read>(&self, reader: &mut R) -> Result<WireFrame, FrameCodecError> {
        self.read_for_dispatch(reader)?.into_valid()
    }

    /// Stream equivalent of `decode_for_dispatch`.
    pub fn read_for_dispatch<R: Read>(
        &self,
        reader: &mut R,
    ) -> Result<DecodedFrame, FrameCodecError> {
        let payload = self.read_payload(reader)?;
        self.decode_payload_for_dispatch(&payload)
    }

    /// Reads one length-prefixed payload without deciding what it holds.
    ///
    /// Split out of `read_for_dispatch` for the one caller that must answer two
    /// document shapes on the same stream. `hmux mobile-gateway` reads the first
    /// document of a relayed session before it knows whether the peer is opening
    /// an attach (a `WireFrame` carrying `Hello`) or asking for the session
    /// catalog (a gateway request document, which is deliberately *not* a
    /// `WireFrame` — see `mobile_gateway::list_stdio`).
    ///
    /// Why it lives here rather than as four lines in that caller: the cap check
    /// runs before the payload allocation, and which step failed is the whole
    /// input to the relay's aligned-versus-desynchronized ruling
    /// (`classify_relay_read`). A second hand-written prefix reader would be a
    /// second place for both to drift.
    pub fn read_payload<R: Read>(&self, reader: &mut R) -> Result<Vec<u8>, FrameCodecError> {
        let mut prefix = [0_u8; LENGTH_PREFIX_BYTES];
        reader
            .read_exact(&mut prefix)
            .map_err(FrameCodecError::Io)?;
        let declared = usize::try_from(u32::from_be_bytes(prefix))
            .expect("u32 always fits usize on supported hosts");
        // The cap is checked before allocating based on peer-controlled data.
        self.ensure_payload_length(declared)?;
        let mut payload = vec![0_u8; declared];
        reader
            .read_exact(&mut payload)
            .map_err(FrameCodecError::Io)?;
        Ok(payload)
    }

    pub fn write_to<W: Write>(
        &self,
        writer: &mut W,
        frame: &WireFrame,
    ) -> Result<(), FrameCodecError> {
        writer
            .write_all(&self.encode(frame)?)
            .map_err(FrameCodecError::Io)
    }

    /// Decodes a payload `read_payload` already took off the wire.
    ///
    /// Public for the same caller and the same reason: once the gateway has
    /// classified the first document as a frame rather than a request, it must
    /// finish decoding it through this codec's rules, not its own.
    pub fn decode_payload_for_dispatch(
        &self,
        payload: &[u8],
    ) -> Result<DecodedFrame, FrameCodecError> {
        let frame =
            serde_json::from_slice::<WireFrame>(payload).map_err(FrameCodecError::Serialization)?;
        Ok(match frame.validate(&self.limits) {
            Ok(()) => DecodedFrame::Valid(frame),
            Err(violation) => DecodedFrame::Invalid { frame, violation },
        })
    }

    fn ensure_payload_length(&self, length: usize) -> Result<(), FrameCodecError> {
        if length == 0 {
            return Err(FrameCodecError::EmptyFrame);
        }
        if length > self.limits.max_frame_bytes {
            return Err(FrameCodecError::FrameTooLarge {
                actual: length,
                maximum: self.limits.max_frame_bytes,
            });
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum FrameCodecError {
    Io(io::Error),
    Serialization(serde_json::Error),
    Validation(FrameValidationError),
    EmptyFrame,
    FrameTooLarge { actual: usize, maximum: usize },
    TruncatedLengthPrefix,
    TruncatedPayload { declared: usize, actual: usize },
    TrailingBytes { declared: usize, actual: usize },
}

impl fmt::Display for FrameCodecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "frame I/O failed: {error}"),
            Self::Serialization(error) => write!(formatter, "frame serialization failed: {error}"),
            Self::Validation(error) => write!(formatter, "frame validation failed: {error}"),
            Self::EmptyFrame => write!(formatter, "frame payload must not be empty"),
            Self::FrameTooLarge { actual, maximum } => {
                write!(formatter, "frame length {actual} exceeds maximum {maximum}")
            }
            Self::TruncatedLengthPrefix => write!(formatter, "frame length prefix is truncated"),
            Self::TruncatedPayload { declared, actual } => write!(
                formatter,
                "frame declares {declared} payload bytes but contains {actual}"
            ),
            Self::TrailingBytes { declared, actual } => write!(
                formatter,
                "frame declares {declared} payload bytes but contains {actual}"
            ),
        }
    }
}

impl std::error::Error for FrameCodecError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Serialization(error) => Some(error),
            Self::Validation(error) => Some(error),
            _ => None,
        }
    }
}

impl From<FrameValidationError> for FrameCodecError {
    fn from(error: FrameValidationError) -> Self {
        Self::Validation(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ErrorCode, ErrorFrame, FrameBody, Input, OutputDelta, PROTOCOL_V1, RecoveredPresentation,
        Resize, RetryPosture, ScreenSnapshot, ScreenSnapshotEncoding, SessionFence,
    };
    use std::io::Cursor;

    fn framed_json(json: &str) -> Vec<u8> {
        let mut encoded = Vec::with_capacity(LENGTH_PREFIX_BYTES + json.len());
        encoded.extend_from_slice(&u32::try_from(json.len()).unwrap().to_be_bytes());
        encoded.extend_from_slice(json.as_bytes());
        encoded
    }

    fn input_frame(bytes: Vec<u8>) -> WireFrame {
        WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 9,
            body: FrameBody::Input(Input {
                request_id: "request-1".into(),
                controller_generation: 3,
                bytes,
            }),
        }
    }

    #[test]
    fn round_trip_preserves_binary_payload() {
        let codec = FrameCodec::new(FrameLimits::default());
        let frame = input_frame(vec![0, 1, 2, 255]);

        assert_eq!(codec.decode(&codec.encode(&frame).unwrap()).unwrap(), frame);
    }

    #[test]
    fn u64_values_use_lossless_decimal_strings_on_the_json_wire() {
        let codec = FrameCodec::new(FrameLimits::default());
        let mut frame = input_frame(vec![1]);
        frame.frame_id = 9_007_199_254_740_993;
        let encoded = codec.encode(&frame).unwrap();
        let json = std::str::from_utf8(&encoded[LENGTH_PREFIX_BYTES..]).unwrap();

        assert!(json.contains(r#""frame_id":"9007199254740993""#));
        assert_eq!(codec.decode(&encoded).unwrap(), frame);
    }

    #[test]
    fn snapshot_input_protection_preserves_unknown_and_known_false_across_replay() {
        let mut payload = serde_json::json!({
            "fence": {
                "workspace_id": "workspace", "session_id": "session",
                "runner_principal": "runner", "runner_instance": "runner-1",
                "channel_epoch": "1", "host_instance_id": "host-1",
                "terminal_epoch": "terminal-1"
            },
            "sequence_through": "9", "rows": 24, "columns": 80,
            "encoding": "ansi_redraw_v1", "repaint_bytes": "",
            "alternate_screen": false, "cursor_visible": true, "truncated": false
        });
        for pending in [None, Some(false), Some(true)] {
            if let Some(pending) = pending {
                payload["controller_input_pending"] = serde_json::json!(pending);
            }
            let snapshot: ScreenSnapshot = serde_json::from_value(payload.clone()).unwrap();
            assert_eq!(snapshot.controller_input_pending, pending);
            let replayed: ScreenSnapshot =
                serde_json::from_slice(&serde_json::to_vec(&snapshot).unwrap()).unwrap();
            assert_eq!(replayed, snapshot);
        }
        payload["controller_input_pending"] = serde_json::json!("false");
        assert!(serde_json::from_value::<ScreenSnapshot>(payload).is_err());
    }

    #[test]
    fn recovered_presentation_times_are_lossless_decimal_strings() {
        let source_fence = SessionFence {
            workspace_id: "workspace".into(),
            session_id: "source".into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 1,
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        };
        let mut successor_fence = source_fence.clone();
        successor_fence.session_id = "successor".into();
        successor_fence.runner_instance = "runner-2".into();
        successor_fence.host_instance_id = "host-2".into();
        successor_fence.terminal_epoch = "terminal-2".into();
        let frame = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body: FrameBody::ScreenSnapshot(ScreenSnapshot {
                fence: successor_fence,
                sequence_through: 1,
                rows: 24,
                columns: 80,
                encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
                controller_input_pending: None,
                semantic_idle_ms: None,
                repaint_bytes: b"screen".to_vec(),
                alternate_screen: false,
                cursor_visible: true,
                truncated: false,
                working_directory: None,
                execution_location: None,
                agent_identity: None,
                agent_runtime_state: None,
                provider_conversation_identity: None,
                recovered_presentation: Some(Box::new(RecoveredPresentation {
                    source_fence,
                    sequence_through: 9_007_199_254_740_993,
                    captured_unix_ms: 9_007_199_254_740_994,
                    truncated: false,
                })),
                actual_profile: None,
                in_reply_to_request_id: None,
            }),
        };
        let codec = FrameCodec::new(FrameLimits::default());

        let encoded = codec.encode(&frame).unwrap();
        let json = std::str::from_utf8(&encoded[LENGTH_PREFIX_BYTES..]).unwrap();

        assert!(json.contains(r#""sequence_through":"9007199254740993""#));
        assert!(json.contains(r#""captured_unix_ms":"9007199254740994""#));
        assert_eq!(codec.decode(&encoded).unwrap(), frame);
    }

    #[test]
    fn numeric_json_u64_values_are_rejected_instead_of_rounded_by_clients() {
        let encoded = framed_json(
            r#"{"protocol_version":{"major":1,"minor":0},"frame_id":9007199254740993,"body":{"kind":"input","payload":{"request_id":"request-1","controller_generation":"3","bytes":"AQ"}}}"#,
        );

        assert!(matches!(
            FrameCodec::new(FrameLimits::default()).decode(&encoded),
            Err(FrameCodecError::Serialization(_))
        ));
    }

    #[test]
    fn input_frame_has_a_stable_cross_language_json_shape() {
        let codec = FrameCodec::new(FrameLimits::default());
        let frame = input_frame(vec![0, 255]);
        let encoded = codec.encode(&frame).unwrap();
        let json = std::str::from_utf8(&encoded[LENGTH_PREFIX_BYTES..]).unwrap();

        assert_eq!(
            json,
            r#"{"protocol_version":{"major":1,"minor":0},"frame_id":"9","body":{"kind":"input","payload":{"request_id":"request-1","controller_generation":"3","bytes":"AP8"}}}"#
        );
    }

    #[test]
    fn standalone_termination_has_a_stable_capability_gated_shape() {
        use crate::StandaloneTerminate;

        let frame = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 10,
            body: FrameBody::StandaloneTerminate(StandaloneTerminate {
                request_id: "terminate-1".into(),
            }),
        };
        let encoded = FrameCodec::new(FrameLimits::default())
            .encode(&frame)
            .unwrap();
        let json = std::str::from_utf8(&encoded[LENGTH_PREFIX_BYTES..]).unwrap();

        assert_eq!(
            json,
            r#"{"protocol_version":{"major":1,"minor":0},"frame_id":"10","body":{"kind":"standalone_terminate","payload":{"request_id":"terminate-1"}}}"#
        );
    }

    #[test]
    fn managed_provider_stop_has_a_stable_capability_gated_shape() {
        use crate::ManagedProviderStop;

        let frame = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 11,
            body: FrameBody::ManagedProviderStop(ManagedProviderStop {
                request_id: "stop-1".into(),
                expected_quiescence: None,
                expected_conversation: None,
            }),
        };
        let encoded = FrameCodec::new(FrameLimits::default())
            .encode(&frame)
            .unwrap();
        let json = std::str::from_utf8(&encoded[LENGTH_PREFIX_BYTES..]).unwrap();

        assert_eq!(
            json,
            r#"{"protocol_version":{"major":1,"minor":0},"frame_id":"11","body":{"kind":"managed_provider_stop","payload":{"request_id":"stop-1"}}}"#
        );
    }

    #[test]
    fn managed_authorization_grant_has_a_stable_redacted_shape() {
        use crate::{ManagedAuthorizationGrantReceipt, ManagedAuthorizationGrantRequest};

        let codec = FrameCodec::new(FrameLimits::default());
        let request = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 12,
            body: FrameBody::ManagedAuthorizationGrantRequest(ManagedAuthorizationGrantRequest {
                request_id: "grant-1".into(),
            }),
        };
        let encoded = codec.encode(&request).unwrap();
        let json = std::str::from_utf8(&encoded[LENGTH_PREFIX_BYTES..]).unwrap();
        assert_eq!(
            json,
            r#"{"protocol_version":{"major":1,"minor":0},"frame_id":"12","body":{"kind":"managed_authorization_grant_request","payload":{"request_id":"grant-1"}}}"#
        );

        let receipt = ManagedAuthorizationGrantReceipt {
            request_id: "grant-1".into(),
            authorization_proof_reference: "secret-grant".into(),
        };
        let debug = format!("{receipt:?}");
        assert!(!debug.contains("secret-grant"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn error_frame_preserves_request_correlation_on_the_json_wire() {
        let codec = FrameCodec::new(FrameLimits::default());
        let frame = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 12,
            body: FrameBody::Error(ErrorFrame {
                origin_code: None,
                code: ErrorCode::ResourceLimit,
                message: "snapshot unavailable".into(),
                retry: RetryPosture::Reconnect,
                required_capability: None,
                supported_versions: None,
                in_reply_to_request_id: Some("snapshot-7".into()),
            }),
        };
        let encoded = codec.encode(&frame).unwrap();
        let json = std::str::from_utf8(&encoded[LENGTH_PREFIX_BYTES..]).unwrap();

        assert_eq!(
            json,
            r#"{"protocol_version":{"major":1,"minor":0},"frame_id":"12","body":{"kind":"error","payload":{"code":"resource_limit","message":"snapshot unavailable","retry":"reconnect","required_capability":null,"supported_versions":null,"in_reply_to_request_id":"snapshot-7"}}}"#
        );
    }

    #[test]
    fn declared_frame_cap_is_checked_before_payload_allocation() {
        let limits = FrameLimits {
            max_frame_bytes: 32,
            ..FrameLimits::default()
        };
        let codec = FrameCodec::new(limits);
        let mut reader = Cursor::new(33_u32.to_be_bytes());

        assert!(matches!(
            codec.read_from(&mut reader),
            Err(FrameCodecError::FrameTooLarge {
                actual: 33,
                maximum: 32,
            })
        ));
    }

    #[test]
    fn semantic_input_cap_applies_before_serialization() {
        let limits = FrameLimits {
            max_input_bytes: 3,
            ..FrameLimits::default()
        };
        let codec = FrameCodec::new(limits);

        assert!(matches!(
            codec.encode(&input_frame(vec![1, 2, 3, 4])),
            Err(FrameCodecError::Validation(FrameValidationError::TooLong {
                field: "input.bytes",
                actual: 4,
                maximum: 3,
            }))
        ));
    }

    #[test]
    fn dispatch_decode_preserves_request_id_for_semantic_refusal() {
        let permissive = FrameCodec::new(FrameLimits::default());
        let frame = input_frame(vec![1, 2, 3, 4]);
        let encoded = permissive.encode(&frame).unwrap();
        let strict = FrameCodec::new(FrameLimits {
            max_input_bytes: 3,
            ..FrameLimits::default()
        });

        let DecodedFrame::Invalid {
            frame: refused,
            violation,
        } = strict.decode_for_dispatch(&encoded).unwrap()
        else {
            panic!("oversized input must remain a correlated refusal");
        };
        assert!(matches!(
            violation,
            FrameValidationError::TooLong {
                field: "input.bytes",
                actual: 4,
                maximum: 3,
            }
        ));
        let FrameBody::Input(input) = refused.body else {
            panic!("decoded refusal must preserve the input frame");
        };
        assert_eq!(input.request_id, "request-1");
    }

    #[test]
    fn dispatch_decode_preserves_invalid_resize_for_a_refusal_receipt() {
        let wire = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 11,
            body: FrameBody::Resize(Resize {
                request_id: "resize-request".into(),
                controller_generation: 2,
                rows: 0,
                columns: 80,
            }),
        };
        let payload = serde_json::to_string(&wire).unwrap();
        let encoded = framed_json(&payload);

        let DecodedFrame::Invalid {
            frame: refused,
            violation,
        } = FrameCodec::new(FrameLimits::default())
            .decode_for_dispatch(&encoded)
            .unwrap()
        else {
            panic!("invalid resize must remain a correlated refusal");
        };
        assert_eq!(
            violation,
            FrameValidationError::OutOfRange {
                field: "terminal.rows",
            }
        );
        let FrameBody::Resize(resize) = refused.body else {
            panic!("decoded refusal must preserve the resize frame");
        };
        assert_eq!(resize.request_id, "resize-request");
    }

    #[test]
    fn hello_debug_redacts_attach_authority() {
        use crate::{AttachMode, Hello, ReconnectCursor, SessionFence, VersionRange};

        let frame = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 10,
            body: FrameBody::Hello(Hello {
                supported_versions: VersionRange {
                    minimum: PROTOCOL_V1,
                    maximum: PROTOCOL_V1,
                },
                requested_capabilities: vec![],
                expected_fence: SessionFence {
                    workspace_id: "workspace".into(),
                    session_id: "session".into(),
                    runner_principal: "runner".into(),
                    runner_instance: "runner-1".into(),
                    channel_epoch: 1,
                    host_instance_id: "host-1".into(),
                    terminal_epoch: "terminal-1".into(),
                },
                requested_mode: AttachMode::Observer,
                reconnect_cursor: Some(ReconnectCursor {
                    terminal_epoch: "terminal-1".into(),
                    after_output_seq: 0,
                }),
                capability_token: "secret-capability-token".into(),
                authorization_proof_reference: Some("secret-proof-reference".into()),
                initial_snapshot_profile: Some(crate::ScreenSnapshotProfile::ViewportOnly),
            }),
        };

        let debug = format!("{frame:?}");
        assert!(!debug.contains("secret-capability-token"));
        assert!(!debug.contains("secret-proof-reference"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn transport_debug_never_includes_terminal_byte_payloads() {
        let raw = b"secret".to_vec();
        let raw_debug = format!("{raw:?}");
        let fence = SessionFence {
            workspace_id: "workspace".into(),
            session_id: "session".into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 1,
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
        };
        let frames = [
            input_frame(raw.clone()),
            WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 13,
                body: FrameBody::OutputDelta(OutputDelta {
                    terminal_epoch: "terminal-1".into(),
                    output_seq: 1,
                    bytes: raw.clone(),
                    rows: None,
                    columns: None,
                    working_directory: None,
                    execution_location: None,
                    agent_identity: None,
                }),
            },
            WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 14,
                body: FrameBody::ScreenSnapshot(ScreenSnapshot {
                    fence,
                    sequence_through: 1,
                    rows: 24,
                    columns: 80,
                    encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
                    controller_input_pending: None,
                    semantic_idle_ms: None,
                    repaint_bytes: raw,
                    alternate_screen: false,
                    cursor_visible: true,
                    truncated: false,
                    working_directory: None,
                    execution_location: None,
                    agent_identity: None,
                    agent_runtime_state: None,
                    provider_conversation_identity: None,
                    recovered_presentation: None,
                    actual_profile: Some(crate::ScreenSnapshotProfile::ViewportOnly),
                    in_reply_to_request_id: Some("snapshot-request-1".into()),
                }),
            },
        ];

        for frame in &frames {
            let debug = format!("{frame:?}");
            assert!(!debug.contains(&raw_debug));
        }
        let invalid = DecodedFrame::Invalid {
            frame: frames[0].clone(),
            violation: FrameValidationError::TooLong {
                field: "input.bytes",
                actual: 6,
                maximum: 5,
            },
        };
        assert!(!format!("{invalid:?}").contains(&raw_debug));
    }

    #[test]
    fn trailing_bytes_are_not_silently_consumed_as_another_frame() {
        let codec = FrameCodec::new(FrameLimits::default());
        let mut encoded = codec.encode(&input_frame(vec![1])).unwrap();
        encoded.push(0);

        assert!(matches!(
            codec.decode(&encoded),
            Err(FrameCodecError::TrailingBytes { .. })
        ));
    }
}
