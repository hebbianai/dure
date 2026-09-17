use super::{ProcessProof, ReconnectCursor, ScreenSnapshotProfile, SessionFence, VersionRange};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachMode {
    Observer,
    Controller,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleState {
    Connecting,
    Syncing,
    Observing,
    Controlling,
    Reconnecting,
    Detached,
    Exited,
    LegacyUnhosted,
    PtyLost,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorizationPosture {
    DaemonAuthorized,
    // A live-session read-only Observer that the daemon sanctioned through a
    // non-exclusive observer authority (not the single reattach slot). It is
    // reported distinctly from DaemonAuthorized so a HelloAck reader can tell a
    // read-only observer apart from a control-capable reattach even though neither
    // posture, on its own, grants any capability (control is gated on Controller
    // mode and controller ownership, not on posture).
    DaemonAuthorizedObserver,
    LocalLaunchOwner,
    LocalInspectionOwner,
    DegradedLocalOwner,
    // A standalone (tmux-like) local session that carries no daemon authority,
    // WorkNode, or claim. It is granted only when the Host's in-memory session
    // class is Standalone and the connecting peer is the same OS user on the same
    // host (already proven by the Unix-socket peer credential before
    // authorization runs). Like every other posture it confers no capability on
    // its own; control stays gated on Controller mode plus controller ownership.
    // This is distinct from DegradedLocalOwner, which stays reserved for a
    // never-granted degraded-managed meaning and must not be reused here.
    StandaloneLocalOwner,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct Hello {
    pub supported_versions: VersionRange,
    pub requested_capabilities: Vec<String>,
    pub expected_fence: SessionFence,
    pub requested_mode: AttachMode,
    pub reconnect_cursor: Option<ReconnectCursor>,
    pub capability_token: String,
    pub authorization_proof_reference: Option<String>,
    /// Requested profile for the initial attach snapshot; `None` means `Full`.
    /// Honored only when `screen_snapshot_profile_v1` is selected — hosts that
    /// predate profiles ignore the field and send the full snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_snapshot_profile: Option<ScreenSnapshotProfile>,
}

impl fmt::Debug for Hello {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Why: WireFrame derives Debug and is likely to appear in transport
        // diagnostics. Attach authority must never become log material, even
        // while the surrounding identity and negotiation fields remain useful.
        let authorization_proof_reference = self
            .authorization_proof_reference
            .as_ref()
            .map(|_| "<redacted>");
        formatter
            .debug_struct("Hello")
            .field("supported_versions", &self.supported_versions)
            .field("requested_capabilities", &self.requested_capabilities)
            .field("expected_fence", &self.expected_fence)
            .field("requested_mode", &self.requested_mode)
            .field("reconnect_cursor", &self.reconnect_cursor)
            .field("initial_snapshot_profile", &self.initial_snapshot_profile)
            .field("capability_token", &"<redacted>")
            .field(
                "authorization_proof_reference",
                &authorization_proof_reference,
            )
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HelloAck {
    pub selected_version: super::ProtocolVersion,
    pub selected_capabilities: Vec<String>,
    pub actual_fence: SessionFence,
    pub host_build_version: String,
    pub lifecycle: LifecycleState,
    pub host_process: ProcessProof,
    pub provider_process: Option<ProcessProof>,
    #[serde(with = "super::json_u64")]
    pub earliest_retained_output_seq: u64,
    #[serde(with = "super::json_u64")]
    pub current_output_seq: u64,
    #[serde(with = "super::json_u64")]
    pub controller_generation: u64,
    pub authorization_posture: AuthorizationPosture,
}
