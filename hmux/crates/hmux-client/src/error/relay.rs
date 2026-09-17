use super::{ClientError, HostErrorCode, RetryDirective};
use hmux_session_protocol::{ErrorCode, ErrorFrame, RetryPosture};

#[cfg(test)]
mod tests;

impl ClientError {
    /// Projects one client-boundary failure without assigning another retry policy.
    #[must_use]
    pub fn to_error_frame(&self) -> ErrorFrame {
        let (code, origin_code, message) = match self {
            Self::HostRefused { code, message, .. } => ((*code).into(), None, message.clone()),
            _ => (
                ErrorCode::TransportClosed,
                Some(self.code().to_owned()),
                self.to_string(),
            ),
        };
        ErrorFrame {
            code,
            origin_code,
            message,
            retry: self.retry_directive().into(),
            required_capability: None,
            supported_versions: None,
            in_reply_to_request_id: None,
        }
    }
}

pub(crate) fn host_refused(error: ErrorFrame) -> ClientError {
    let retry = match error.retry {
        RetryPosture::Never => RetryDirective::Never,
        RetryPosture::Reconnect => RetryDirective::Reconnect,
        RetryPosture::RetryAfterResync => RetryDirective::RetryAfterResync,
    };
    if let Some(code) = error.origin_code {
        return ClientError::RelayedFailure {
            code,
            message: error.message,
            retry,
        };
    }
    ClientError::HostRefused {
        code: match error.code {
            hmux_session_protocol::ErrorCode::IdentityMismatch => HostErrorCode::IdentityMismatch,
            hmux_session_protocol::ErrorCode::UnsupportedProtocolVersion => {
                HostErrorCode::UnsupportedProtocolVersion
            }
            hmux_session_protocol::ErrorCode::UnsupportedCapability => {
                HostErrorCode::UnsupportedCapability
            }
            hmux_session_protocol::ErrorCode::AuthorizationDenied => {
                HostErrorCode::AuthorizationDenied
            }
            hmux_session_protocol::ErrorCode::DegradedAuthorizationUnavailable => {
                HostErrorCode::DegradedAuthorizationUnavailable
            }
            hmux_session_protocol::ErrorCode::ControllerConflict => {
                HostErrorCode::ControllerConflict
            }
            hmux_session_protocol::ErrorCode::StaleControllerGeneration => {
                HostErrorCode::StaleControllerGeneration
            }
            hmux_session_protocol::ErrorCode::ReplayGap => HostErrorCode::ReplayGap,
            hmux_session_protocol::ErrorCode::SessionExited => HostErrorCode::SessionExited,
            hmux_session_protocol::ErrorCode::PtyLost => HostErrorCode::PtyLost,
            hmux_session_protocol::ErrorCode::StaleDiscovery => HostErrorCode::StaleDiscovery,
            hmux_session_protocol::ErrorCode::ResourceLimit => HostErrorCode::ResourceLimit,
            hmux_session_protocol::ErrorCode::InvalidTerminalDimensions => {
                HostErrorCode::InvalidTerminalDimensions
            }
            hmux_session_protocol::ErrorCode::PlatformResizeFailed => {
                HostErrorCode::PlatformResizeFailed
            }
            hmux_session_protocol::ErrorCode::TransportClosed => HostErrorCode::TransportClosed,
        },
        message: error.message,
        retry,
    }
}

impl From<HostErrorCode> for ErrorCode {
    fn from(code: HostErrorCode) -> Self {
        match code {
            HostErrorCode::IdentityMismatch => ErrorCode::IdentityMismatch,
            HostErrorCode::UnsupportedProtocolVersion => ErrorCode::UnsupportedProtocolVersion,
            HostErrorCode::UnsupportedCapability => ErrorCode::UnsupportedCapability,
            HostErrorCode::AuthorizationDenied => ErrorCode::AuthorizationDenied,
            HostErrorCode::DegradedAuthorizationUnavailable => {
                ErrorCode::DegradedAuthorizationUnavailable
            }
            HostErrorCode::ControllerConflict => ErrorCode::ControllerConflict,
            HostErrorCode::StaleControllerGeneration => ErrorCode::StaleControllerGeneration,
            HostErrorCode::ReplayGap => ErrorCode::ReplayGap,
            HostErrorCode::SessionExited => ErrorCode::SessionExited,
            HostErrorCode::PtyLost => ErrorCode::PtyLost,
            HostErrorCode::StaleDiscovery => ErrorCode::StaleDiscovery,
            HostErrorCode::ResourceLimit => ErrorCode::ResourceLimit,
            HostErrorCode::InvalidTerminalDimensions => ErrorCode::InvalidTerminalDimensions,
            HostErrorCode::PlatformResizeFailed => ErrorCode::PlatformResizeFailed,
            HostErrorCode::TransportClosed => ErrorCode::TransportClosed,
        }
    }
}

impl From<RetryDirective> for RetryPosture {
    fn from(retry: RetryDirective) -> Self {
        match retry {
            RetryDirective::Never => RetryPosture::Never,
            RetryDirective::Reconnect => RetryPosture::Reconnect,
            RetryDirective::RetryAfterResync => RetryPosture::RetryAfterResync,
        }
    }
}
