#[cfg(feature = "ghostty-core-proof")]
use super::composite_viewport_source::HotHistoryViewportSource;
#[cfg(feature = "ghostty-core-proof")]
use super::terminal_history_transfer::TerminalHistoryTransferSource;
use super::{TerminalPresentationDegradation, TerminalReplayError};
use crate::local_protocol::ScreenSnapshotProfile;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TerminalCoreCheckpointFormat {
    #[cfg(not(feature = "ghostty-core-proof"))]
    LegacyAnsiRedrawV1,
    #[cfg(feature = "ghostty-core-proof")]
    EngineNativeV1,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct TerminalCoreCheckpoint {
    pub format: TerminalCoreCheckpointFormat,
    pub engine_fingerprint: Option<String>,
    pub rows: u16,
    pub columns: u16,
    pub bytes: Vec<u8>,
}

/// Engine-neutral result of applying one serialized PTY output batch.
///
/// Terminal effects are collected synchronously by the one terminal actor.
/// The actor never writes them to the PTY while its state is locked: a Host
/// integration must move `pty_replies` to its existing ordered PTY ingress
/// after releasing the actor guard. The current production adapter deliberately
/// returns no replies until the separately reviewed packaged-engine cutover.
#[derive(Debug, Default, Eq, PartialEq)]
pub(super) struct TerminalCoreWrite {
    pub pty_replies: Vec<u8>,
    pub pty_reply_overflow: bool,
    #[cfg(feature = "ghostty-core-proof")]
    pub events: Vec<TerminalCoreEvent>,
    #[cfg(feature = "ghostty-core-proof")]
    pub event_overflow: bool,
    pub projection_changed: bool,
    pub presentation_degradation: Option<TerminalPresentationDegradation>,
}

#[cfg(feature = "ghostty-core-proof")]
#[derive(Debug, Eq, PartialEq)]
pub(super) enum TerminalCoreEvent {
    ClipboardWrite(Vec<u8>),
}

pub(super) struct SnapshotRepaint {
    pub bytes: Vec<u8>,
    pub truncated: bool,
    pub actual_profile: Option<ScreenSnapshotProfile>,
}

/// The sole Host-owned terminal emulation and projection authority.
///
/// This interface contains no vendor types and is private to the local-runtime
/// half of `hmux-host`. A client or mobile build cannot name an engine, load a
/// native library, or persist an engine-native snapshot through this boundary.
pub(super) trait TerminalCore: Send {
    fn process(&mut self, bytes: &[u8]) -> Result<TerminalCoreWrite, TerminalReplayError>;
    fn resize(&mut self, rows: u16, columns: u16)
    -> Result<TerminalCoreWrite, TerminalReplayError>;
    fn size(&self) -> (u16, u16);
    fn alternate_screen(&self) -> bool;
    fn cursor_visible(&self) -> bool;
    fn screen_contents(&self) -> String;
    fn repaint(
        &self,
        profile: ScreenSnapshotProfile,
        maximum: usize,
    ) -> Result<SnapshotRepaint, TerminalReplayError>;
    fn checkpoint(&self, maximum: usize) -> Result<TerminalCoreCheckpoint, TerminalReplayError>;
    #[cfg(feature = "ghostty-core-proof")]
    fn encode_input(
        &mut self,
        intent: &terminal_state_protocol::InputIntent,
    ) -> Result<Vec<u8>, TerminalReplayError>;
    #[cfg(feature = "ghostty-core-proof")]
    fn viewport_metadata(
        &self,
        through_event_id: u64,
    ) -> Result<terminal_state_protocol::StateSnapshot, TerminalReplayError>;
    #[cfg(feature = "ghostty-core-proof")]
    fn capture_hot_viewport_source(
        &self,
        requests: &[super::ViewportCaptureRequest],
        maximum_capture_bytes: usize,
    ) -> Result<std::sync::Arc<dyn HotHistoryViewportSource>, TerminalReplayError>;
    #[cfg(feature = "ghostty-core-proof")]
    fn history_transfer_source(&mut self) -> &mut dyn TerminalHistoryTransferSource;
    #[cfg(feature = "ghostty-core-proof")]
    fn seal_primary_screen_as_history(&mut self) -> Result<(), TerminalReplayError>;
    #[cfg(test)]
    fn application_cursor(&self) -> bool;

    #[cfg(test)]
    fn bracketed_paste(&self) -> bool;

    #[cfg(test)]
    fn cursor_position(&self) -> (u16, u16);

    #[cfg(test)]
    fn retained_physical_rows(&self) -> usize;
}
