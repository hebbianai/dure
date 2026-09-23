//! Shared session values and bounded wire encoding for Hosts and clients.
//!
//! This crate describes runtime facts; it does not create processes, discover
//! sessions on disk, authorize operations, or own terminal state. Those decisions
//! stay with the Host and its local OS adapters.

pub mod browser_console;
pub mod browser_dialog;
pub mod browser_interception;
pub mod browser_keyboard;
pub mod browser_network;
pub mod browser_network_capture;
pub mod browser_pointer;
pub mod browser_recording;
pub mod browser_resource;
pub mod browser_tracing;
pub mod browser_workspace;
pub mod discovery;
pub mod exit;
pub mod transport;

mod frame_codec;
mod handshake;
#[doc(hidden)]
pub mod json_bytes;
pub(crate) mod json_u64;
mod session_identity;
mod terminal_default_colors;
mod terminal_frames;
mod validation;
mod wire_frame;

pub use frame_codec::{DecodedFrame, FrameCodec, FrameCodecError};
pub use handshake::{AttachMode, AuthorizationPosture, Hello, HelloAck, LifecycleState};
pub use session_identity::{
    FenceField, FenceMismatch, ProcessProof, ProtocolVersion, ReconnectCursor, RuntimeContext,
    SessionFence, VersionRange,
};
pub use terminal_default_colors::{InvalidRgbColor, TerminalDefaultColors};
pub use terminal_frames::{
    AGENT_STATE_REPORT_MAX_WORKING_TTL_MS, AgentIdentityProjection, AgentIdentitySource,
    AgentProvider, AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
    AgentRuntimeStateProjection, AgentRuntimeStateSource, AgentStateReport,
    AgentStateReportCausality, AgentStateReportObservationFence, AgentStateReportOutcome,
    AgentStateReportReceipt, ControlReceipt, ControlReceiptState, ControlRelease, ControlRequest,
    Detach, ErrorCode, ErrorFrame, ExecutionLocation, ExecutionLocationProjection,
    ExecutionLocationSource, Exit, Input, InputReceipt, InputReceiptState,
    ManagedAuthorizationGrantReceipt, ManagedAuthorizationGrantRequest, ManagedProviderStop,
    ManagedProviderStopConversationFence, ManagedProviderStopQuiescenceFence,
    ManagedProviderStopReceipt, ManagedProviderStopReceiptState, OperationReceiptReason,
    OutputDelta, ProviderConversationIdentityProjection, ProviderConversationIdentityReport,
    ProviderConversationIdentitySource, RecoveredPresentation, ReplayGap, Resize, ResizeReceipt,
    ResizeReceiptState, RetryPosture, ScreenSnapshot, ScreenSnapshotEncoding,
    ScreenSnapshotProfile, ScreenSnapshotRequest, SessionRetirementAction,
    SessionRetirementReceipt, SessionRetirementReceiptReason, SessionRetirementReceiptState,
    SessionRetirementRequest, StandaloneTerminate, StandaloneTerminateReceipt,
    StandaloneTerminateReceiptState, WorkingDirectoryProjection, WorkingDirectorySource,
};
pub use validation::{DEFAULT_MAX_FRAME_BYTES, FrameLimits, FrameValidationError};
pub use wire_frame::{FrameBody, FrameKind, WireFrame};

pub const PROTOCOL_V1: ProtocolVersion = ProtocolVersion { major: 1, minor: 0 };
/// Negotiates fenced working-directory projections. Current Hosts publish the
/// launch fallback and later process-inspected cwd in snapshots, including a
/// same-output-sequence live metadata refresh. The output-delta field and
/// `Osc7` source are decode-only compatibility for older Hosts. Clients ignore
/// every optional shape unless this capability was selected during Hello.
pub const WORKING_DIRECTORY_PROJECTION_CAPABILITY: &str = "working_directory_projection_v1";
/// Negotiates discrete `working_directory` semantic frames on structured
/// viewport attachments, so a process-inspected cwd change reaches the client
/// between output deltas. Separate from
/// [`WORKING_DIRECTORY_PROJECTION_CAPABILITY`] because older clients offer
/// that one while hard-failing on an unknown frame kind.
pub const WORKING_DIRECTORY_FRAME_CAPABILITY: &str = "working_directory_frame_v1";
/// Negotiates the Host-owned execution locus of the foreground terminal
/// process. This stays separate from cwd: an interactive SSH client keeps a
/// local process cwd while commands execute on another host.
pub const EXECUTION_LOCATION_PROJECTION_CAPABILITY: &str = "execution_location_projection_v1";
/// Negotiates fenced agent identity on snapshots and output deltas. A present
/// projection with a null agent explicitly represents an ordinary shell.
pub const AGENT_IDENTITY_PROJECTION_CAPABILITY: &str = "agent_identity_projection_v1";
/// Negotiates a fenced, revisioned semantic agent state projection. The Host
/// owns the current state while clients independently decide notification and
/// presentation policy.
pub const AGENT_RUNTIME_STATE_CAPABILITY: &str = "agent_runtime_state_v1";
/// Rolling-compatibility lane for the original fresh-only prompt record. New
/// peers keep requesting it so they can reattach to a live older Host; an
/// existing-conversation target never uses this capability.
pub const LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY: &str = "initial_agent_prompt_v1";
/// Admits one provider-targeted body-plus-submit input only at the Host's
/// serialized PTY boundary. Targets select either exact provider-event
/// authority or an explicit fresh-session process-observed bootstrap.
pub const AGENT_PROMPT_CAPABILITY: &str = "agent_prompt_v1";
/// Extends the targeted agent-prompt lane with the explicit
/// `process_observed_fresh_agent` target. It is negotiated separately so a
/// newer client never sends that additive protobuf arm to an older Host that
/// only understands `agent_prompt_v1`.
pub const PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY: &str = "process_observed_agent_prompt_v1";

/// The one prompt wire lane selected for a managed observer attachment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentPromptCapabilitySelection {
    Targeted,
    LegacyFresh,
}

impl AgentPromptCapabilitySelection {
    #[must_use]
    pub const fn capability(self) -> &'static str {
        match self {
            Self::Targeted => AGENT_PROMPT_CAPABILITY,
            Self::LegacyFresh => LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
        }
    }
}

/// Selects one prompt lane with targeted semantics taking precedence over the
/// rolling fresh-only fallback. Keeping this policy here prevents Unix and
/// Windows Hosts from drifting during a live upgrade.
pub fn select_managed_agent_prompt_capability(
    requested_mode: AttachMode,
    managed: bool,
    supported: &[String],
    requested: &[String],
) -> Option<AgentPromptCapabilitySelection> {
    if requested_mode != AttachMode::Observer || !managed {
        return None;
    }
    let shared = |capability: &str| {
        supported.iter().any(|value| value == capability)
            && requested.iter().any(|value| value == capability)
    };
    if shared(AGENT_PROMPT_CAPABILITY) {
        Some(AgentPromptCapabilitySelection::Targeted)
    } else if shared(LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY) {
        Some(AgentPromptCapabilitySelection::LegacyFresh)
    } else {
        None
    }
}
/// Guarantees that a live attachment's requested snapshot is serialized on
/// the same outbound FIFO as its output deltas.
pub const ORDERED_SNAPSHOT_REFRESH_CAPABILITY: &str = "ordered_snapshot_refresh_v1";
/// Opts a same-user standalone observer connection into serialized shared
/// input and latest-writer resize policy without consuming the managed
/// controller lease. `terminal_input` remains required alongside this marker.
pub const SHARED_TERMINAL_INPUT_CAPABILITY: &str = "shared_terminal_input";
/// Allows a same-user, fully fenced client to ask a standalone Host to stop
/// the provider through the Host-owned child handle. Managed Hosts never
/// advertise this capability.
pub const STANDALONE_TERMINATION_CAPABILITY: &str = "standalone_termination_v1";
/// Lets the opaque launch owner abandon an exact standalone generation only
/// while no ordinary attachment has ever committed. The Host rechecks that
/// monotonic attachment fence under its termination/attach transition locks,
/// so a client that reached HelloAck even briefly permanently turns this into
/// a preserve-only operation.
pub const UNPRESENTED_CREATION_ABANDON_CAPABILITY: &str = "unpresented_creation_abandon_v1";
/// Allows the orchestration adapter for a fully fenced managed Host to request
/// provider stop without borrowing the interactive controller lease. The
/// adapter supplies the current managed authorization proof during Hello.
pub const MANAGED_PROVIDER_STOP_CAPABILITY: &str = "managed_provider_stop_v1";
/// Extends managed provider stop with one Host-atomic compare-and-stop fence.
/// A selected request succeeds only while the exact typed runtime projection
/// remains running, waiting, and free of blocking attention.
pub const MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY: &str = "managed_provider_quiescent_stop_v1";
/// Strengthens quiescent stop with semantic idle evidence: an expired working
/// report or process existence cannot authorize termination. Old Hosts may
/// support the atomic fence above without this stronger idle guarantee.
pub const MANAGED_PROVIDER_SEMANTIC_QUIESCENT_STOP_CAPABILITY: &str =
    "managed_provider_semantic_quiescent_stop_v1";
/// Publishes current semantic idle age from the live Host's monotonic clock.
/// Observer/backend restarts do not reset it; a replacement Host never inherits it.
pub const SEMANTIC_IDLE_OBSERVATION_CAPABILITY: &str = "semantic_idle_observation_v1";
/// Extends managed provider stop with an exact Host-owned conversation
/// identity compare at the same linearizable cut as termination admission.
pub const MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY: &str =
    "managed_provider_conversation_fenced_stop_v1";
/// Negotiates screen-snapshot profiles: a client may ask for a viewport-only
/// initial snapshot at Hello and pull a full (scrollback-reconstructing)
/// snapshot later via `ScreenSnapshotRequest`. Hosts honor profile fields only
/// on connections that selected this capability; unnegotiated peers always get
/// the legacy full behavior.
pub const SCREEN_SNAPSHOT_PROFILE_CAPABILITY: &str = "screen_snapshot_profile_v1";
/// Declares that snapshots may contain a presentation checkpoint inherited
/// from an exact predecessor fence without adding those bytes to the current
/// terminal epoch's output sequence.
pub const RECOVERED_PRESENTATION_CAPABILITY: &str = "recovered_presentation_v1";
/// Allows an observer connection to deliver externally observed agent state
/// reports that the Host folds as `provider_event` observations. Clients must
/// confirm this capability was selected before sending the frame — an unknown
/// frame kind closes older Host connections. Managed Hosts additionally
/// require the adapter-minted authorization proof during Hello.
pub const AGENT_STATE_REPORT_CAPABILITY: &str = "agent_state_report_v1";
/// Lets a reporter bind one state mutation to the exact Host-atomic terminal
/// output and runtime projection it inspected. A stale boundary is answered as
/// `no_op` without mutating Host truth.
pub const AGENT_STATE_REPORT_OBSERVATION_FENCE_CAPABILITY: &str =
    "agent_state_report_observation_fence_v1";
/// Lets a completion producer attach one stable, source-issued event id.
/// The Host deduplicates it within the exact terminal epoch before advancing
/// the monotonic completion counter, including across client/app reloads.
pub const AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY: &str = "agent_state_report_completion_id_v1";
pub const AGENT_STATE_REPORT_CAUSALITY_CAPABILITY: &str = "agent_state_report_causality_v1";
/// Lets a local same-user runtime broker obtain one short-lived, single-use
/// proof for a managed attach. It is never relayed or written to discovery.
pub const MANAGED_AUTHORIZATION_GRANT_CAPABILITY: &str = "managed_authorization_grant_v1";
/// Negotiates an ordered, complete-fence projection of one opaque provider
/// conversation identity. The report ingress is available only alongside
/// `agent_state_report_v1`; snapshots and update frames remain independently
/// capability-gated for older observers.
pub const PROVIDER_CONVERSATION_IDENTITY_CAPABILITY: &str = "provider_conversation_identity_v1";
/// Requires provider-event conversation reports to carry the exact complete
/// Host fence inherited by the provider. Clients with fenced evidence must
/// not downgrade to the unfenced v1 report path on older live Hosts.
pub const FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY: &str =
    "provider_conversation_identity_report_fence_v1";
/// Lets a reviewed OS adapter establish only the provider conversation
/// identity without replaying or overwriting Host-owned runtime activity.
/// The report still uses the exact attach generation and may additionally
/// carry the complete provider-inherited fence.
pub const PROVIDER_CONVERSATION_IDENTITY_ONLY_REPORT_CAPABILITY: &str =
    "provider_conversation_identity_only_report_v1";
/// Allows a causally ordered report to advance a conversation from an exact
/// predecessor verified by the provider adapter, within the same Host fence.
pub const PROVIDER_CONVERSATION_CONTINUATION_CAPABILITY: &str =
    "provider_conversation_continuation_v1";
/// Negotiates cursor-based reattach. A client that still holds the terminal it
/// had before a drop sends `Hello.reconnect_cursor`; a Host that selected this
/// capability answers with the retained deltas after that cursor *instead of* a
/// screen snapshot, so an ordinary reconnect stops costing a
/// `max_snapshot_bytes` redownload.
///
/// The reply shape is exactly one of two, and never a mixture:
///
/// - **resume** — zero or more `OutputDelta` frames covering
///   `cursor.after_output_seq + 1 ..= HelloAck.current_output_seq`, then
///   nothing. No `ScreenSnapshot` is sent at all.
/// - **fallback** — one `ScreenSnapshot`, optionally preceded by exactly one
///   `ReplayGap`. The `ReplayGap` is present if and only if the cursor had
///   fallen out of the retained window, i.e. the stream really has a hole. A
///   snapshot with no `ReplayGap` before it is a complete, canonical screen and
///   the client lost nothing it can observe.
///
/// One invariant makes that decidable without a marker frame: **a cursor that
/// is already at `current_output_seq` always resumes**, trivially, with zero
/// frames. So a client whose cursor equals the ack's `current_output_seq` knows
/// not to read anything, and every other cursor is answered by a frame it can
/// dispatch on. Without that rule, "the Host has sent nothing yet" and "the
/// Host is about to send a snapshot" would be the same observation and the
/// client would block on a frame that never comes.
///
/// Additive on both sides. A client that sends no cursor is answered exactly as
/// before, and a Host that never selects this capability makes the client
/// ignore its own cursor and take the snapshot.
pub const RECONNECT_RESUME_CAPABILITY: &str = "reconnect_resume_v1";
/// Negotiates the Host-owned standalone session retirement contract. The only
/// departure that may arm retirement is the typed, fenced request carried by
/// this capability; legacy `Detach` and transport loss are preserve-only.
pub const SESSION_RETIREMENT_CAPABILITY: &str = "session_retirement_v1";
/// Negotiates a non-view lifecycle administration connection for retirement
/// configuration and sweep. Such a connection is still a same-user, fenced
/// observer transport, but it does not count as a session attachment and
/// therefore cannot cancel an already armed grace period merely by previewing
/// it. Graceful view departure is deliberately forbidden on this capability.
pub const SESSION_RETIREMENT_ADMIN_CAPABILITY: &str = "session_retirement_admin_v1";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_prompt_capability_prefers_targeted_and_falls_back_to_legacy() {
        let both = vec![
            AGENT_PROMPT_CAPABILITY.to_string(),
            LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY.to_string(),
        ];
        assert_eq!(
            select_managed_agent_prompt_capability(AttachMode::Observer, true, &both, &both,),
            Some(AgentPromptCapabilitySelection::Targeted)
        );
        assert_eq!(
            select_managed_agent_prompt_capability(
                AttachMode::Observer,
                true,
                &[LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY.to_string()],
                &both,
            ),
            Some(AgentPromptCapabilitySelection::LegacyFresh)
        );
        assert_eq!(
            select_managed_agent_prompt_capability(AttachMode::Controller, true, &both, &both,),
            None
        );
    }
}
