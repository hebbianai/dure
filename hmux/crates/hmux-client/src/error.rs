use hmux_host::local_discovery::{DiscoveryError, StaleDiscoveryReason};
use hmux_session_protocol::{FenceMismatch, FrameCodecError, OperationReceiptReason};
use serde::Serialize;
use std::fmt;
use std::io;
#[cfg(feature = "local-runtime")]
use std::path::PathBuf;

mod relay;
pub(crate) use relay::host_refused;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostErrorCode {
    IdentityMismatch,
    UnsupportedProtocolVersion,
    UnsupportedCapability,
    AuthorizationDenied,
    DegradedAuthorizationUnavailable,
    ControllerConflict,
    StaleControllerGeneration,
    ReplayGap,
    SessionExited,
    PtyLost,
    StaleDiscovery,
    ResourceLimit,
    InvalidTerminalDimensions,
    PlatformResizeFailed,
    TransportClosed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryDirective {
    Never,
    Reconnect,
    RetryAfterResync,
}

/// The one spelling of "the transport ended". `code()` and `retry_directive()`
/// both key off it, so the wire code and its retry posture cannot drift apart.
pub(crate) const TRANSPORT_CLOSED_CODE: &str = "hmux_transport_closed";

#[derive(Debug)]
pub enum ClientError {
    Discovery(DiscoveryError),
    Io {
        operation: &'static str,
        source: io::Error,
    },
    /// Discovery named a local endpoint, but no Host was accepting connections
    /// there by the time the client dialed it. The caller must refresh
    /// lifecycle authority before attempting a bounded replacement attach.
    EndpointUnavailable {
        source: io::Error,
    },
    Protocol(FrameCodecError),
    #[cfg(feature = "terminal-state-stream")]
    TerminalStateProtocol(terminal_state_protocol::ProtocolError),
    FenceMismatch(FenceMismatch),
    HomeDirectoryUnavailable,
    InvalidDiscoveryRoot,
    TooManyDiscoveryRoots {
        maximum: usize,
    },
    AmbiguousDiscoveryGeneration {
        session_id: String,
        workspace_id: String,
    },
    ReadOnlyDiscoveryRoot {
        session_id: String,
        workspace_id: String,
    },
    InvalidAuthorizationProofReference,
    PlatformTransportUnsupported,
    UnsupportedEndpoint {
        kind: &'static str,
    },
    MissingCapability {
        capability: &'static str,
    },
    ProtocolVersionMismatch,
    HostRefused {
        code: HostErrorCode,
        message: String,
        retry: RetryDirective,
    },
    /// A relay's bounded client failure; its original code and retry remain authoritative.
    RelayedFailure {
        code: String,
        message: String,
        retry: RetryDirective,
    },
    /// The exact Host generation refused managed provider termination before
    /// accepting any destructive effect. This remains distinct from transport
    /// failures so a runtime broker can terminalize its journaled intent.
    ManagedStopRefused {
        reason: Option<OperationReceiptReason>,
        message: String,
    },
    /// A structured attach received HelloAck, then the transport ended before
    /// the Host supplied its first complete terminal viewport. Reconnecting is
    /// safe because no viewport state or input authority was installed.
    #[cfg(feature = "terminal-state-stream")]
    TerminalViewportAttachTransportClosed,
    UnexpectedFrame {
        expected: &'static str,
        actual: String,
    },
    InconsistentStream {
        reason: &'static str,
    },
    SessionNotFound {
        session_id: String,
        workspace_id: Option<String>,
    },
    AmbiguousSession {
        session_id: String,
        workspaces: Vec<String>,
    },
    AmbiguousTarget {
        identifier: String,
        candidates: Vec<String>,
    },
    Transport {
        code: &'static str,
        message: String,
    },
    /// A bounded transport write was refused before any byte was admitted.
    /// Callers may retry the semantic operation without duplicating input.
    WriteNotStarted {
        message: String,
    },
    /// The byte stream is no longer frame-aligned, so nothing further can be
    /// trusted on it. Distinct from a plain I/O failure because the connection
    /// must be abandoned rather than retried: a half-consumed length prefix
    /// makes the next read interpret payload as a length.
    StreamDesynchronized {
        reason: &'static str,
    },
    /// Something answered, but it was not the Hmux protocol.
    ///
    /// Deliberately carries a byte count and a fixed classification rather
    /// than the bytes. The payload here is unauthenticated, pre-handshake and
    /// remote-controlled, and this error is routinely logged and surfaced —
    /// echoing it back would put attacker-chosen content into diagnostics.
    NotAnHmuxStream {
        observed_bytes: usize,
        classification: StreamClassification,
    },
}

/// What a non-Hmux stream looked like, in fixed terms that reveal nothing the
/// peer chose.
///
/// The common cases are worth naming because they have completely different
/// fixes: an SSH banner means the relay command never ran, and shell noise
/// means a login rc file wrote to stdout and corrupted the stream.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StreamClassification {
    /// An SSH protocol banner — the remote command was never reached.
    SshBanner,
    /// Text before the first frame, typically a login shell's rc output.
    ShellNoise,
    /// Bytes that decode as neither.
    Unrecognized,
}

impl fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RelayedFailure { message, .. } => formatter.write_str(message),
            Self::Discovery(error) => error.fmt(formatter),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
            Self::EndpointUnavailable { source } => {
                write!(formatter, "connect to Hmux Host failed: {source}")
            }
            Self::Protocol(error) => error.fmt(formatter),
            #[cfg(feature = "terminal-state-stream")]
            Self::TerminalStateProtocol(error) => error.fmt(formatter),
            Self::FenceMismatch(error) => error.fmt(formatter),
            Self::HomeDirectoryUnavailable => {
                write!(formatter, "HOME is unavailable; pass --discovery-root")
            }
            Self::InvalidDiscoveryRoot => write!(
                formatter,
                "HMUX_DISCOVERY_ROOT must name a non-empty filesystem path"
            ),
            Self::TooManyDiscoveryRoots { maximum } => write!(
                formatter,
                "Hmux read-only discovery migration exceeds its {maximum} root bound"
            ),
            Self::AmbiguousDiscoveryGeneration {
                session_id,
                workspace_id,
            } => write!(
                formatter,
                "Hmux session {session_id:?} in workspace {workspace_id:?} has competing discovery generations"
            ),
            Self::ReadOnlyDiscoveryRoot {
                session_id,
                workspace_id,
            } => write!(
                formatter,
                "Hmux session {session_id:?} in workspace {workspace_id:?} was discovered through a read-only migration root"
            ),
            Self::InvalidAuthorizationProofReference => {
                write!(formatter, "authorization proof reference must not be empty")
            }
            Self::PlatformTransportUnsupported => {
                write!(
                    formatter,
                    "this platform has no Hmux local transport adapter"
                )
            }
            Self::UnsupportedEndpoint { kind } => {
                write!(formatter, "Hmux endpoint kind {kind} is unsupported")
            }
            Self::MissingCapability { capability } => {
                write!(
                    formatter,
                    "Hmux Host did not negotiate required capability {capability}"
                )
            }
            Self::ProtocolVersionMismatch => {
                write!(
                    formatter,
                    "Hmux Host selected an unsupported protocol version"
                )
            }
            Self::HostRefused { code, message, .. } => {
                write!(formatter, "Hmux Host refused attach ({code:?}): {message}")
            }
            Self::ManagedStopRefused { reason, message } => {
                write!(
                    formatter,
                    "Hmux Host refused managed provider stop ({reason:?}): {message}"
                )
            }
            #[cfg(feature = "terminal-state-stream")]
            Self::TerminalViewportAttachTransportClosed => write!(
                formatter,
                "Hmux Host sent closed transport while client expected terminal_viewport_frame"
            ),
            Self::UnexpectedFrame { expected, actual } => write!(
                formatter,
                "Hmux Host sent {actual} while client expected {expected}"
            ),
            Self::InconsistentStream { reason } => {
                write!(formatter, "Hmux Host sent an inconsistent stream: {reason}")
            }
            Self::SessionNotFound {
                session_id,
                workspace_id,
            } => {
                write!(formatter, "Hmux session {session_id:?} was not found")?;
                if let Some(workspace_id) = workspace_id {
                    write!(formatter, " in workspace {workspace_id:?}")?;
                }
                Ok(())
            }
            Self::AmbiguousSession {
                session_id,
                workspaces,
            } => write!(
                formatter,
                "Hmux session {session_id:?} exists in multiple workspaces: {}",
                workspaces.join(", ")
            ),
            Self::AmbiguousTarget {
                identifier,
                candidates,
            } => write!(
                formatter,
                "Hmux target {identifier:?} matches multiple sessions: {}",
                candidates.join(", ")
            ),
            Self::Transport { message, .. } => formatter.write_str(message),
            Self::WriteNotStarted { message } => formatter.write_str(message),
            Self::StreamDesynchronized { reason } => write!(
                formatter,
                "the Hmux stream is no longer frame-aligned ({reason}); reattach to continue"
            ),
            Self::NotAnHmuxStream {
                observed_bytes,
                classification,
            } => write!(
                formatter,
                "the transport returned {observed_bytes} bytes that are not Hmux frames ({classification:?})"
            ),
        }
    }
}

impl ClientError {
    #[must_use]
    pub fn code(&self) -> &str {
        match self {
            Self::RelayedFailure { code, .. } => code,
            Self::Discovery(DiscoveryError::RegistrationCapacityExceeded { .. }) => {
                "hmux_discovery_registration_capacity_exceeded"
            }
            Self::Discovery(_) => "hmux_discovery_failed",
            Self::Io { .. } => "hmux_io_failed",
            Self::EndpointUnavailable { .. } => "hmux_endpoint_unavailable",
            Self::Protocol(_) => "hmux_protocol_failed",
            #[cfg(feature = "terminal-state-stream")]
            Self::TerminalStateProtocol(_) => "hmux_terminal_state_protocol_failed",
            Self::FenceMismatch(_) => "hmux_identity_mismatch",
            Self::HomeDirectoryUnavailable => "hmux_home_unavailable",
            Self::InvalidDiscoveryRoot => "hmux_discovery_root_invalid",
            Self::TooManyDiscoveryRoots { .. } => "hmux_discovery_root_limit",
            Self::AmbiguousDiscoveryGeneration { .. } => "hmux_discovery_generation_ambiguous",
            Self::ReadOnlyDiscoveryRoot { .. } => "hmux_discovery_read_only",
            Self::InvalidAuthorizationProofReference => "hmux_authorization_reference_invalid",
            Self::PlatformTransportUnsupported => "hmux_platform_unsupported",
            Self::UnsupportedEndpoint { .. } => "hmux_endpoint_unsupported",
            Self::MissingCapability { .. } => "hmux_capability_missing",
            Self::ProtocolVersionMismatch => "hmux_protocol_version_unsupported",
            Self::HostRefused { code, .. } => match code {
                HostErrorCode::IdentityMismatch => "hmux_identity_mismatch",
                HostErrorCode::UnsupportedProtocolVersion => "hmux_protocol_version_unsupported",
                HostErrorCode::UnsupportedCapability => "hmux_capability_unsupported",
                HostErrorCode::AuthorizationDenied => "hmux_authorization_denied",
                HostErrorCode::DegradedAuthorizationUnavailable => "hmux_authorization_unavailable",
                HostErrorCode::ControllerConflict => "hmux_controller_conflict",
                HostErrorCode::StaleControllerGeneration => "hmux_controller_stale",
                HostErrorCode::ReplayGap => "hmux_replay_gap",
                HostErrorCode::SessionExited => "hmux_session_exited",
                HostErrorCode::PtyLost => "hmux_pty_lost",
                HostErrorCode::StaleDiscovery => "hmux_discovery_stale",
                HostErrorCode::ResourceLimit => "hmux_resource_limit",
                HostErrorCode::InvalidTerminalDimensions => "hmux_resize_invalid",
                HostErrorCode::PlatformResizeFailed => "hmux_resize_failed",
                HostErrorCode::TransportClosed => TRANSPORT_CLOSED_CODE,
            },
            Self::ManagedStopRefused { .. } => "hmux_managed_stop_refused",
            #[cfg(feature = "terminal-state-stream")]
            Self::TerminalViewportAttachTransportClosed => TRANSPORT_CLOSED_CODE,
            Self::UnexpectedFrame { .. } => "hmux_unexpected_frame",
            Self::InconsistentStream { .. } => "hmux_inconsistent_stream",
            Self::SessionNotFound { .. } => "hmux_session_not_found",
            Self::AmbiguousSession { .. } | Self::AmbiguousTarget { .. } => {
                "hmux_session_ambiguous"
            }
            Self::Transport { code, .. } => code,
            Self::WriteNotStarted { .. } => "hmux_transport_write_not_started",
            Self::StreamDesynchronized { .. } => "hmux_stream_desynchronized",
            Self::NotAnHmuxStream { .. } => "hmux_not_an_hmux_stream",
        }
    }

    /// True when discovery refused because the caller's expected manifest
    /// generation no longer matches the current one — a replacement Host took
    /// over the identity. Adapters branch on this to report "moved on" instead
    /// of a generic failure without depending on `hmux-host` types.
    #[must_use]
    pub fn is_generation_mismatch(&self) -> bool {
        matches!(self, Self::Discovery(DiscoveryError::GenerationMismatch))
    }

    pub(crate) fn is_manifest_process_mismatch(&self) -> bool {
        matches!(
            self,
            Self::Transport {
                code: "hmux_manifest_process_mismatch",
                ..
            }
        )
    }

    /// True when a manifest lifecycle transition was refused (for example
    /// retiring a session that is no longer exited).
    #[must_use]
    pub fn is_invalid_manifest_transition(&self) -> bool {
        matches!(
            self,
            Self::Discovery(DiscoveryError::InvalidManifestTransition { .. })
        )
    }

    /// True only when discovery proves that no current manifest exists for the
    /// requested logical session. Corrupt, insecure, or merely unavailable
    /// discovery remains an error and must not be treated as process exit.
    #[must_use]
    pub fn is_session_absent(&self) -> bool {
        matches!(
            self,
            Self::SessionNotFound { .. }
                | Self::Discovery(DiscoveryError::SessionNotFound)
                | Self::Discovery(DiscoveryError::StaleDiscovery {
                    reason: StaleDiscoveryReason::MissingManifest,
                    ..
                })
        )
    }

    /// The retry posture owned by the protocol/client boundary. Adapters must
    /// project this value instead of reconstructing it from display text.
    #[must_use]
    pub fn retry_directive(&self) -> RetryDirective {
        match self {
            Self::HostRefused { retry, .. } | Self::RelayedFailure { retry, .. } => *retry,
            Self::EndpointUnavailable { .. } => RetryDirective::RetryAfterResync,
            #[cfg(feature = "terminal-state-stream")]
            Self::TerminalViewportAttachTransportClosed => RetryDirective::Reconnect,
            // A peer that ended the stream cleanly left it frame-aligned, so a
            // fresh attach is safe — the same reading the variant above already
            // applies to the attach seed. Without this arm the posture said
            // `Never` while every consumer treated the code as an ordinary
            // close, which is what forced adapters to re-derive the decision
            // from the code string this method exists to replace.
            Self::Transport {
                code: TRANSPORT_CLOSED_CODE,
                ..
            } => RetryDirective::Reconnect,
            _ => RetryDirective::Never,
        }
    }

    /// True only for broker refusals that prove a deterministic standalone
    /// recovery cannot ever own its requested target identity. Callers may
    /// persist these as terminal outcomes; ordinary launch and transport
    /// failures remain retryable.
    #[must_use]
    pub fn is_standalone_recovery_terminal_refusal(&self) -> bool {
        matches!(
            self.code(),
            "hmux_standalone_recovery_target_exited"
                | "hmux_standalone_recovery_identity_conflict"
                | "hmux_standalone_recovery_name_conflict"
                | "hmux_standalone_recipe_conflict"
        )
    }

    /// True only when the Host/client boundary proved that managed stop was
    /// refused before provider termination. Missing a required negotiated
    /// capability is equally pre-effect and therefore definitive.
    #[must_use]
    pub fn is_definitive_managed_stop_refusal(&self) -> bool {
        matches!(
            self,
            Self::ManagedStopRefused { .. } | Self::MissingCapability { .. }
        )
    }

    #[cfg(feature = "local-runtime")]
    pub(crate) fn managed_stop_refused(
        reason: Option<OperationReceiptReason>,
        message: impl Into<String>,
    ) -> Self {
        Self::ManagedStopRefused {
            reason,
            message: message.into(),
        }
    }

    pub(crate) fn transport(code: &'static str, message: impl Into<String>) -> Self {
        Self::Transport {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn write_not_started(message: impl Into<String>) -> Self {
        Self::WriteNotStarted {
            message: message.into(),
        }
    }

    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn is_write_not_started(&self) -> bool {
        matches!(
            self,
            Self::WriteNotStarted { .. } | Self::MissingCapability { .. }
        )
    }
}

impl std::error::Error for ClientError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Discovery(error) => Some(error),
            Self::Io { source, .. } => Some(source),
            Self::EndpointUnavailable { source } => Some(source),
            Self::Protocol(error) => Some(error),
            #[cfg(feature = "terminal-state-stream")]
            Self::TerminalStateProtocol(error) => Some(error),
            Self::FenceMismatch(error) => Some(error),
            _ => None,
        }
    }
}

impl From<DiscoveryError> for ClientError {
    fn from(error: DiscoveryError) -> Self {
        Self::Discovery(error)
    }
}

impl From<FrameCodecError> for ClientError {
    fn from(error: FrameCodecError) -> Self {
        Self::Protocol(error)
    }
}

#[cfg(feature = "terminal-state-stream")]
impl From<terminal_state_protocol::ProtocolError> for ClientError {
    fn from(error: terminal_state_protocol::ProtocolError) -> Self {
        Self::TerminalStateProtocol(error)
    }
}

impl From<FenceMismatch> for ClientError {
    fn from(error: FenceMismatch) -> Self {
        Self::FenceMismatch(error)
    }
}

#[cfg(feature = "local-runtime")]
pub(crate) fn path_from_env(value: Option<std::ffi::OsString>) -> Result<PathBuf, ClientError> {
    let Some(value) = value else {
        return Err(ClientError::InvalidDiscoveryRoot);
    };
    if value.is_empty() {
        return Err(ClientError::InvalidDiscoveryRoot);
    }
    Ok(PathBuf::from(value))
}

/// Maps a transport failure onto the client's error vocabulary.
///
/// The first arm is a compatibility contract, not a formatting choice.
/// `hmux-cli`'s interactive attach polls with a short budget and treats a
/// timeout as "no frame yet, keep polling" — `is_read_timeout` matches
/// `ClientError::Io` whose source is `ErrorKind::TimedOut`. A first-byte
/// timeout consumed nothing and is safe to retry, so it must keep producing
/// exactly that shape or a quiet moment becomes a fatal error.
///
/// The mid-frame cases must **not** map there. They consumed bytes that cannot
/// be pushed back, so retrying would read payload as a length prefix.
impl From<hmux_session_protocol::transport::TransportError> for ClientError {
    fn from(error: hmux_session_protocol::transport::TransportError) -> Self {
        use hmux_session_protocol::transport::TransportError as Transport;
        match error {
            Transport::FirstByteTimeout => Self::Io {
                operation: "wait for Hmux frame",
                source: io::Error::new(
                    io::ErrorKind::TimedOut,
                    "no Hmux frame arrived before the deadline",
                ),
            },
            Transport::WriteNotStarted => {
                Self::write_not_started("the Hmux frame write was refused before admission")
            }
            Transport::CompletionTimeout => Self::StreamDesynchronized {
                reason: "frame stalled part-way through",
            },
            Transport::Truncated => Self::StreamDesynchronized {
                reason: "peer closed part-way through a frame",
            },
            Transport::Interrupted => Self::Transport {
                code: "hmux_transport_interrupted",
                message: "the Hmux transport read was interrupted".to_string(),
            },
            Transport::Io { operation, source } => Self::Io { operation, source },
            Transport::Codec(error) => Self::Protocol(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn ordinary_io_failures_do_not_inherit_endpoint_recovery() {
        let error = ClientError::Io {
            operation: "read Hmux frame",
            source: io::Error::new(io::ErrorKind::BrokenPipe, "fixture closed"),
        };

        assert_eq!(error.retry_directive(), RetryDirective::Never);
    }

    #[test]
    fn only_missing_discovery_is_classified_as_session_absence() {
        assert!(
            ClientError::SessionNotFound {
                session_id: "session".into(),
                workspace_id: Some("workspace".into()),
            }
            .is_session_absent()
        );
        assert!(
            ClientError::Discovery(DiscoveryError::StaleDiscovery {
                path: PathBuf::from("/tmp/hmux/session"),
                reason: StaleDiscoveryReason::MissingManifest,
            })
            .is_session_absent()
        );
        assert!(
            !ClientError::Discovery(DiscoveryError::StaleDiscovery {
                path: PathBuf::from("/tmp/hmux/session"),
                reason: StaleDiscoveryReason::InvalidManifest,
            })
            .is_session_absent()
        );
    }

    #[test]
    fn transient_recovery_liveness_refusals_are_not_terminal() {
        for code in [
            "hmux_standalone_recovery_target_unavailable",
            "hmux_standalone_recovery_protocol_incompatible",
        ] {
            assert!(
                !ClientError::transport(code, "transient")
                    .is_standalone_recovery_terminal_refusal(),
                "{code} must remain retryable"
            );
        }
        assert!(
            ClientError::transport("hmux_standalone_recovery_identity_conflict", "structural",)
                .is_standalone_recovery_terminal_refusal()
        );
        assert!(
            ClientError::transport("hmux_standalone_recipe_conflict", "structural",)
                .is_standalone_recovery_terminal_refusal()
        );
    }
}
