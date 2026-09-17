use hmux_client::TerminalSurfaceAccess;
use serde::Deserialize;

/// Parses the UI's requested terminal authority once at the IPC boundary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RequestedTerminalSurfaceAccess {
    ReadOnly,
    Writer,
}

impl From<RequestedTerminalSurfaceAccess> for TerminalSurfaceAccess {
    fn from(access: RequestedTerminalSurfaceAccess) -> Self {
        match access {
            RequestedTerminalSurfaceAccess::ReadOnly => Self::ReadOnly,
            RequestedTerminalSurfaceAccess::Writer => Self::Writer,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exact_surface_authority_at_the_ipc_boundary() {
        let read_only: RequestedTerminalSurfaceAccess =
            serde_json::from_str("\"read_only\"").expect("read-only access must parse");
        let writer: RequestedTerminalSurfaceAccess =
            serde_json::from_str("\"writer\"").expect("writer access must parse");

        assert_eq!(
            TerminalSurfaceAccess::from(read_only),
            TerminalSurfaceAccess::ReadOnly
        );
        assert_eq!(
            TerminalSurfaceAccess::from(writer),
            TerminalSurfaceAccess::Writer
        );
        assert!(
            serde_json::from_str::<RequestedTerminalSurfaceAccess>("\"observer\"").is_err()
        );
    }
}
