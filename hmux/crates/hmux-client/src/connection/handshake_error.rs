use crate::ClientError;
use crate::error::StreamClassification;
use hmux_session_protocol::FrameCodecError;
use hmux_session_protocol::transport::TransportError;

/// Classify unauthenticated handshake failures without echoing remote bytes.
/// Keep timeout retry posture and mid-frame desynchronization semantics intact.
pub(super) fn classify_handshake_failure(
    error: TransportError,
    expected: &'static str,
) -> ClientError {
    match error {
        TransportError::Codec(
            FrameCodecError::Serialization(_) | FrameCodecError::FrameTooLarge { .. },
        ) => ClientError::NotAnHmuxStream {
            observed_bytes: 0,
            classification: StreamClassification::Unrecognized,
        },
        TransportError::Codec(FrameCodecError::TruncatedLengthPrefix) => {
            ClientError::NotAnHmuxStream {
                observed_bytes: 0,
                classification: StreamClassification::ShellNoise,
            }
        }
        other => match ClientError::from(other) {
            ClientError::Io { source, .. } if source.kind() == std::io::ErrorKind::TimedOut => {
                ClientError::Io {
                    operation: expected,
                    source,
                }
            }
            error => error,
        },
    }
}
