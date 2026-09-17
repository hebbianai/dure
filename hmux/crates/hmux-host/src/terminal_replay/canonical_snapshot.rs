use super::terminal_core::TerminalCore;
use super::{TerminalReplay, TerminalReplayError};
use crate::local_protocol::{
    AgentIdentityProjection, AgentRuntimeStateProjection, ExecutionLocationProjection,
    ProviderConversationIdentityProjection, RecoveredPresentation, ScreenSnapshot,
    ScreenSnapshotEncoding, ScreenSnapshotProfile, SessionFence, WorkingDirectoryProjection,
};

/// Borrowed semantic facts from one Host-owned terminal epoch. Inspecting them
/// does not capture or copy the terminal's presentation or retained history.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalProjections<'a> {
    pub working_directory: Option<&'a WorkingDirectoryProjection>,
    pub execution_location: Option<&'a ExecutionLocationProjection>,
    pub agent_identity: Option<&'a AgentIdentityProjection>,
    pub agent_runtime_state: Option<&'a AgentRuntimeStateProjection>,
    pub controller_input_pending: Option<bool>,
    pub semantic_idle_ms: Option<u64>,
    pub provider_conversation_identity: Option<&'a ProviderConversationIdentityProjection>,
}

impl<'a> TerminalProjections<'a> {
    pub(crate) fn from_snapshot(snapshot: &'a ScreenSnapshot) -> Self {
        Self {
            working_directory: snapshot.working_directory.as_ref(),
            execution_location: snapshot.execution_location.as_ref(),
            agent_identity: snapshot.agent_identity.as_ref(),
            agent_runtime_state: snapshot.agent_runtime_state.as_ref(),
            controller_input_pending: snapshot.controller_input_pending,
            semantic_idle_ms: snapshot.semantic_idle_ms,
            provider_conversation_identity: snapshot.provider_conversation_identity.as_deref(),
        }
    }
}

impl TerminalReplay {
    pub(crate) fn projections(&self) -> TerminalProjections<'_> {
        TerminalProjections {
            working_directory: self.working_directory.as_ref(),
            execution_location: self.execution_location.as_ref(),
            agent_identity: self.agent_identity.as_ref(),
            agent_runtime_state: self.agent_runtime_state.as_ref(),
            controller_input_pending: Some(self.has_pending_controller_input()),
            semantic_idle_ms: self.semantic_idle_ms_at(std::time::Instant::now()),
            provider_conversation_identity: self.provider_conversation_identity.as_ref(),
        }
    }

    pub fn snapshot(
        &self,
        profile: ScreenSnapshotProfile,
    ) -> Result<ScreenSnapshot, TerminalReplayError> {
        capture(
            self.terminal.as_ref(),
            &self.fence,
            self.output_seq,
            self.limits.max_snapshot_bytes,
            profile,
            self.projections(),
            self.recovered_presentation.as_ref(),
        )
    }
}

fn capture(
    terminal: &dyn TerminalCore,
    fence: &SessionFence,
    sequence_through: u64,
    max_snapshot_bytes: usize,
    profile: ScreenSnapshotProfile,
    projections: TerminalProjections<'_>,
    recovered_presentation: Option<&RecoveredPresentation>,
) -> Result<ScreenSnapshot, TerminalReplayError> {
    let (rows, columns) = terminal.size();
    let repaint = terminal.repaint(profile, max_snapshot_bytes)?;
    Ok(ScreenSnapshot {
        fence: fence.clone(),
        sequence_through,
        rows,
        columns,
        encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
        repaint_bytes: repaint.bytes,
        alternate_screen: terminal.alternate_screen(),
        cursor_visible: terminal.cursor_visible(),
        truncated: repaint.truncated,
        working_directory: projections.working_directory.cloned(),
        execution_location: projections.execution_location.cloned(),
        agent_identity: projections.agent_identity.cloned(),
        agent_runtime_state: projections.agent_runtime_state.cloned(),
        controller_input_pending: projections.controller_input_pending,
        semantic_idle_ms: projections.semantic_idle_ms,
        provider_conversation_identity: projections
            .provider_conversation_identity
            .cloned()
            .map(Box::new),
        recovered_presentation: recovered_presentation.cloned().map(Box::new),
        actual_profile: repaint.actual_profile,
        in_reply_to_request_id: None,
    })
}
