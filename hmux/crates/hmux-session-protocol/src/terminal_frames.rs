use super::{ReconnectCursor, SessionFence, VersionRange};
use crate::discovery::SessionRetirementPolicy;
use serde::{Deserialize, Serialize};
use std::fmt;

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenSnapshotEncoding {
    AnsiRedrawV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkingDirectorySource {
    LaunchFallback,
    /// Decode-only compatibility for projections published by older Hosts.
    /// Current Hosts never derive runtime state from terminal presentation.
    Osc7,
    ProcessInspection,
}

/// 프로세스 샘플러가 알아본 에이전트 CLI. 직렬화 문자열은 앱 `src/types.ts`의
/// Provider id와 같아야 한다 — 그대로 UI 로고·라벨로 이어지기 때문이다.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentProvider {
    Claude,
    Codex,
    Kimi,
    Gemini,
    Cursor,
    Copilot,
    Opencode,
    Amp,
    Goose,
    Droid,
    Auggie,
    Grok,
    Hermes,
    #[serde(rename = "qwen-code")]
    QwenCode,
    Cline,
    Continue,
    Charm,
    Codebuff,
    Kilocode,
    Kiro,
    #[serde(rename = "rovo-dev")]
    RovoDev,
    #[serde(rename = "mistral-vibe")]
    MistralVibe,
    Antigravity,
    Openclaude,
    Pi,
    #[serde(rename = "oh-my-pi")]
    OhMyPi,
    #[serde(rename = "command-code")]
    CommandCode,
}

impl AgentProvider {
    #[must_use]
    pub fn from_id(id: &str) -> Option<Self> {
        [
            Self::Claude,
            Self::Codex,
            Self::Kimi,
            Self::Gemini,
            Self::Cursor,
            Self::Copilot,
            Self::Opencode,
            Self::Amp,
            Self::Goose,
            Self::Droid,
            Self::Auggie,
            Self::Grok,
            Self::Hermes,
            Self::QwenCode,
            Self::Cline,
            Self::Continue,
            Self::Charm,
            Self::Codebuff,
            Self::Kilocode,
            Self::Kiro,
            Self::RovoDev,
            Self::MistralVibe,
            Self::Antigravity,
            Self::Openclaude,
            Self::Pi,
            Self::OhMyPi,
            Self::CommandCode,
        ]
        .into_iter()
        .find(|provider| provider.as_str() == id)
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Kimi => "kimi",
            Self::Gemini => "gemini",
            Self::Cursor => "cursor",
            Self::Copilot => "copilot",
            Self::Opencode => "opencode",
            Self::Amp => "amp",
            Self::Goose => "goose",
            Self::Droid => "droid",
            Self::Auggie => "auggie",
            Self::Grok => "grok",
            Self::Hermes => "hermes",
            Self::QwenCode => "qwen-code",
            Self::Cline => "cline",
            Self::Continue => "continue",
            Self::Charm => "charm",
            Self::Codebuff => "codebuff",
            Self::Kilocode => "kilocode",
            Self::Kiro => "kiro",
            Self::RovoDev => "rovo-dev",
            Self::MistralVibe => "mistral-vibe",
            Self::Antigravity => "antigravity",
            Self::Openclaude => "openclaude",
            Self::Pi => "pi",
            Self::OhMyPi => "oh-my-pi",
            Self::CommandCode => "command-code",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentIdentitySource {
    ProcessInspection,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeLifecycle {
    Starting,
    Running,
    Exited,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeActivity {
    Working,
    Waiting,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeAttention {
    None,
    InputRequired,
    ApprovalRequired,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeStateSource {
    ProviderEvent,
    OrchestrationEvent,
    ControllerInput,
    /// Rolling decode compatibility for projections emitted by old Hosts.
    /// Current Hosts never derive agent semantics from terminal output.
    TerminalInference,
    ProcessLifecycle,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderConversationIdentitySource {
    LaunchRequest,
    ProviderEvent,
}

/// Exact Host-owned projection of an opaque provider conversation identifier.
/// The complete session fence prevents a delayed predecessor event from being
/// applied to a successor Host, while `revision` orders semantic changes inside
/// one terminal epoch.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderConversationIdentityProjection {
    pub fence: SessionFence,
    #[serde(with = "super::json_u64")]
    pub revision: u64,
    #[serde(with = "super::json_u64")]
    pub observed_through_output_seq: u64,
    pub provider_id: String,
    pub conversation_id: String,
    pub source: ProviderConversationIdentitySource,
}

impl fmt::Debug for ProviderConversationIdentityProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderConversationIdentityProjection")
            .field("fence", &self.fence)
            .field("revision", &self.revision)
            .field(
                "observed_through_output_seq",
                &self.observed_through_output_seq,
            )
            .field("provider_id", &self.provider_id)
            .field("conversation_id_len", &self.conversation_id.len())
            .field("source", &self.source)
            .finish()
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentRuntimeStateProjection {
    pub terminal_epoch: String,
    #[serde(with = "super::json_u64")]
    pub revision: u64,
    #[serde(with = "super::json_u64")]
    pub observed_through_output_seq: u64,
    pub lifecycle: AgentRuntimeLifecycle,
    pub activity: AgentRuntimeActivity,
    pub attention: AgentRuntimeAttention,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_id: Option<String>,
    pub source: AgentRuntimeStateSource,
    // Additive turn-completion counter. Completed turns are counted rather
    // than modeled as an activity value so a completion that leaves the
    // (lifecycle, activity, attention) triple unchanged still produces an
    // observable projection change. Zero is omitted on the wire and absent
    // frames deserialize to zero, so older peers stay compatible.
    #[serde(default, with = "super::json_u64", skip_serializing_if = "u64_is_zero")]
    pub turn_completed_count: u64,
}

fn u64_is_zero(value: &u64) -> bool {
    *value == 0
}

impl AgentRuntimeStateProjection {
    /// Semantic quiescence is shared by observation and Host stop admission.
    #[must_use]
    pub fn is_semantically_quiescent(&self) -> bool {
        self.lifecycle == AgentRuntimeLifecycle::Running
            && self.activity == AgentRuntimeActivity::Waiting
            && self.attention == AgentRuntimeAttention::None
            && self.attention_id.is_none()
            && matches!(
                self.source,
                AgentRuntimeStateSource::ProviderEvent
                    | AgentRuntimeStateSource::OrchestrationEvent
            )
    }
}

impl fmt::Debug for AgentRuntimeStateProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentRuntimeStateProjection")
            .field("terminal_epoch", &self.terminal_epoch)
            .field("revision", &self.revision)
            .field(
                "observed_through_output_seq",
                &self.observed_through_output_seq,
            )
            .field("lifecycle", &self.lifecycle)
            .field("activity", &self.activity)
            .field("attention", &self.attention)
            .field("has_attention_id", &self.attention_id.is_some())
            .field("source", &self.source)
            .field("turn_completed_count", &self.turn_completed_count)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentIdentityProjection {
    pub terminal_epoch: String,
    #[serde(with = "super::json_u64")]
    pub observed_through_output_seq: u64,
    pub agent: Option<AgentProvider>,
    pub source: AgentIdentitySource,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkingDirectoryProjection {
    pub terminal_epoch: String,
    #[serde(with = "super::json_u64")]
    pub observed_through_output_seq: u64,
    pub path: String,
    pub source: WorkingDirectorySource,
}

impl fmt::Debug for WorkingDirectoryProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Paths can disclose repository names and user home layouts. Protocol
        // diagnostics retain ordering and provenance without logging the path.
        formatter
            .debug_struct("WorkingDirectoryProjection")
            .field("terminal_epoch", &self.terminal_epoch)
            .field(
                "observed_through_output_seq",
                &self.observed_through_output_seq,
            )
            .field("path_len", &self.path.len())
            .field("source", &self.source)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecutionLocation {
    Local,
    Ssh { target: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionLocationSource {
    ProcessInspection,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionLocationProjection {
    pub terminal_epoch: String,
    #[serde(with = "super::json_u64")]
    pub observed_through_output_seq: u64,
    pub location: ExecutionLocation,
    pub source: ExecutionLocationSource,
}

impl fmt::Debug for ExecutionLocationProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (kind, target_len) = match &self.location {
            ExecutionLocation::Local => ("local", None),
            ExecutionLocation::Ssh { target } => ("ssh", Some(target.len())),
        };
        formatter
            .debug_struct("ExecutionLocationProjection")
            .field("terminal_epoch", &self.terminal_epoch)
            .field(
                "observed_through_output_seq",
                &self.observed_through_output_seq,
            )
            .field("kind", &kind)
            .field("target_len", &target_len)
            .field("source", &self.source)
            .finish()
    }
}

/// How much retained history a canonical snapshot reconstructs. `ViewportOnly`
/// paints just the visible grid so a cold attach can present immediately; the
/// client follows up with a `Full` one-shot request when it wants scrollback.
/// Only honored on connections that selected `screen_snapshot_profile_v1`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenSnapshotProfile {
    Full,
    ViewportOnly,
}

/// Durable presentation inherited from one exact predecessor fence. These
/// bytes seed the successor's terminal parser before output sequence 1; they
/// are never represented as successor output deltas.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RecoveredPresentation {
    pub source_fence: SessionFence,
    #[serde(with = "super::json_u64")]
    pub sequence_through: u64,
    #[serde(with = "super::json_u64")]
    pub captured_unix_ms: u64,
    pub truncated: bool,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScreenSnapshot {
    pub fence: SessionFence,
    #[serde(with = "super::json_u64")]
    pub sequence_through: u64,
    pub rows: u16,
    pub columns: u16,
    pub encoding: ScreenSnapshotEncoding,
    #[serde(with = "super::json_bytes")]
    pub repaint_bytes: Vec<u8>,
    pub alternate_screen: bool,
    pub cursor_visible: bool,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<WorkingDirectoryProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_location: Option<ExecutionLocationProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_identity: Option<AgentIdentityProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_runtime_state: Option<AgentRuntimeStateProjection>,
    /// Host input protection at this snapshot, not a promise of future stop
    /// admission. Older Hosts omit the fact; absence must remain unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller_input_pending: Option<bool>,
    /// Host-monotonic age of the current semantic idle revision at this exact
    /// snapshot. Missing is unknown, never zero or predecessor activity.
    #[serde(
        default,
        with = "super::json_u64::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub semantic_idle_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_conversation_identity: Option<Box<ProviderConversationIdentityProjection>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovered_presentation: Option<Box<RecoveredPresentation>>,
    /// `Some(ViewportOnly)` means retained scrollback was intentionally
    /// omitted by the requested profile — the client may pull a `Full`
    /// snapshot to hydrate it. Absent when nothing was omitted (or the host
    /// predates profiles), so a same-sequence `Full` reply is distinguishable
    /// from a metadata-only repeat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_profile: Option<ScreenSnapshotProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_reply_to_request_id: Option<String>,
}

impl fmt::Debug for ScreenSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Why: repaint bytes can contain terminal secrets. Transport diagnostics
        // need ordering and shape facts, never the user's terminal contents.
        formatter
            .debug_struct("ScreenSnapshot")
            .field("fence", &self.fence)
            .field("sequence_through", &self.sequence_through)
            .field("rows", &self.rows)
            .field("columns", &self.columns)
            .field("encoding", &self.encoding)
            .field("repaint_bytes_len", &self.repaint_bytes.len())
            .field("alternate_screen", &self.alternate_screen)
            .field("cursor_visible", &self.cursor_visible)
            .field("truncated", &self.truncated)
            .field("working_directory", &self.working_directory)
            .field("execution_location", &self.execution_location)
            .field("agent_identity", &self.agent_identity)
            .field("agent_runtime_state", &self.agent_runtime_state)
            .field("controller_input_pending", &self.controller_input_pending)
            .field("semantic_idle_ms", &self.semantic_idle_ms)
            .field(
                "provider_conversation_identity",
                &self.provider_conversation_identity,
            )
            .field("recovered_presentation", &self.recovered_presentation)
            .field("actual_profile", &self.actual_profile)
            .field("in_reply_to_request_id", &self.in_reply_to_request_id)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ScreenSnapshotRequest {
    pub request_id: String,
    pub expected_fence: SessionFence,
    /// Requested capture profile; `None` means `Full` (legacy behavior).
    /// Ignored unless the connection selected `screen_snapshot_profile_v1`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<ScreenSnapshotProfile>,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct OutputDelta {
    pub terminal_epoch: String,
    #[serde(with = "super::json_u64")]
    pub output_seq: u64,
    #[serde(with = "super::json_bytes")]
    pub bytes: Vec<u8>,
    /// Canonical Host grid adopted before these bytes are parsed. Present only
    /// on the first output delta after a real geometry change; older clients
    /// safely ignore the additive fields and attach snapshots remain the
    /// authority for a fresh presentation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<WorkingDirectoryProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_location: Option<ExecutionLocationProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_identity: Option<AgentIdentityProjection>,
}

impl fmt::Debug for OutputDelta {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Why: provider output is user evidence and can carry credentials. Keep
        // only the terminal fence, sequence, and byte count in diagnostics.
        formatter
            .debug_struct("OutputDelta")
            .field("terminal_epoch", &self.terminal_epoch)
            .field("output_seq", &self.output_seq)
            .field("bytes_len", &self.bytes.len())
            .field("rows", &self.rows)
            .field("columns", &self.columns)
            .field("working_directory", &self.working_directory)
            .field("execution_location", &self.execution_location)
            .field("agent_identity", &self.agent_identity)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReplayGap {
    pub cursor: ReconnectCursor,
    #[serde(with = "super::json_u64")]
    pub earliest_retained_output_seq: u64,
    #[serde(with = "super::json_u64")]
    pub current_output_seq: u64,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct Input {
    pub request_id: String,
    #[serde(with = "super::json_u64")]
    pub controller_generation: u64,
    #[serde(with = "super::json_bytes")]
    pub bytes: Vec<u8>,
}

impl fmt::Debug for Input {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Why: input may be sensitive stdin or a credential pasted into the
        // terminal. Request correlation is useful, but raw bytes must not log.
        formatter
            .debug_struct("Input")
            .field("request_id", &self.request_id)
            .field("controller_generation", &self.controller_generation)
            .field("bytes_len", &self.bytes.len())
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InputReceiptState {
    Accepted,
    WrittenToPty,
    Refused,
    Revoked,
    Failed,
    Released,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationReceiptReason {
    ControllerConflict,
    StaleControllerGeneration,
    AuthorizationDenied,
    InputTooLarge,
    ResourceLimit,
    PtyWriteFailed,
    HostExiting,
    InvalidTerminalDimensions,
    PlatformResizeFailed,
    AgentRuntimeChanged,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct InputReceipt {
    pub request_id: String,
    #[serde(with = "super::json_u64")]
    pub controller_generation: u64,
    pub state: InputReceiptState,
    pub reason: Option<OperationReceiptReason>,
    // Why: `reason` is a bounded enum, so an underlying PTY-write failure that
    // is really a write timeout, an unobservable prompt commit, or a channel
    // loss all collapse to PtyWriteFailed and the real cause is discarded,
    // leaving managed send_instruction failures undiagnosable (WorkNode
    // hmux-managed-input-pty-write-reason-and-wake). This optional detail
    // carries the bounded underlying failure-class token (snake_case only,
    // never prose) so the exact reason survives to the client and the daemon.
    // Additive and backward-compatible: absent frames deserialize to None and
    // the field is omitted when empty, so older peers are unaffected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Resize {
    pub request_id: String,
    #[serde(with = "super::json_u64")]
    pub controller_generation: u64,
    pub rows: u16,
    pub columns: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResizeReceiptState {
    Accepted,
    AppliedToTerminal,
    Refused,
    Revoked,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResizeReceipt {
    pub request_id: String,
    #[serde(with = "super::json_u64")]
    pub controller_generation: u64,
    pub rows: Option<u16>,
    pub columns: Option<u16>,
    pub state: ResizeReceiptState,
    pub reason: Option<OperationReceiptReason>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StandaloneTerminate {
    pub request_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StandaloneTerminateReceiptState {
    Accepted,
    Refused,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StandaloneTerminateReceipt {
    pub request_id: String,
    pub state: StandaloneTerminateReceiptState,
    pub reason: Option<OperationReceiptReason>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagedProviderStopQuiescenceFence {
    pub terminal_epoch: String,
    #[serde(with = "super::json_u64")]
    pub runtime_revision: u64,
    #[serde(with = "super::json_u64")]
    pub observed_through_output_seq: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagedProviderStopConversationFence {
    pub provider_id: String,
    pub conversation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagedProviderStop {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_quiescence: Option<ManagedProviderStopQuiescenceFence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_conversation: Option<ManagedProviderStopConversationFence>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedProviderStopReceiptState {
    Accepted,
    Refused,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagedProviderStopReceipt {
    pub request_id: String,
    pub state: ManagedProviderStopReceiptState,
    pub reason: Option<OperationReceiptReason>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagedAuthorizationGrantRequest {
    pub request_id: String,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagedAuthorizationGrantReceipt {
    pub request_id: String,
    pub authorization_proof_reference: String,
}

impl fmt::Debug for ManagedAuthorizationGrantReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ManagedAuthorizationGrantReceipt")
            .field("request_id", &self.request_id)
            .field("authorization_proof_reference", &"<redacted>")
            .finish()
    }
}

/// Validation bound for the Host-owned working deadline requested by a typed
/// provider report. Deadline expiry is independent of PTY output and cannot
/// establish task completion on semantic-quiescent-stop Hosts.
pub const AGENT_STATE_REPORT_MAX_WORKING_TTL_MS: u64 = 86_400_000;

/// One externally observed, provider-neutral agent state report. The reporter
/// never names a provider or client surface: activity, attention, and the
/// completion fact are the entire semantic vocabulary. Lifecycle is
/// deliberately absent — reports can corroborate a running provider but never
/// resurrect or exit one.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentStateReport {
    pub request_id: String,
    /// Report only `conversation_identity` and preserve the Host-owned agent
    /// runtime projection. Capability-gated so older Hosts never receive this
    /// additive field.
    #[serde(default, skip_serializing_if = "is_false")]
    pub identity_only: bool,
    pub activity: AgentRuntimeActivity,
    pub attention: AgentRuntimeAttention,
    pub turn_completed: bool,
    /// Stable source-issued identity for this completed turn. It is scoped
    /// by the connection's exact terminal epoch and never interpreted by the
    /// Host; it only makes delivery retry/reload idempotent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_completion_id: Option<String>,
    /// Source-captured order and work identity, scoped to this terminal epoch.
    /// The Host rejects obsolete reports before folding identity or activity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causality: Option<AgentStateReportCausality>,
    /// Lease hint for a `working` observation (default 30 seconds). Legacy
    /// Hosts publish `waiting` at expiry; Hosts advertising semantic quiescent
    /// stop retain confirmed work until a typed update or process exit.
    #[serde(
        default,
        with = "super::json_u64::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub working_ttl_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_identity: Option<ProviderConversationIdentityReport>,
    /// Exact Host-atomic snapshot boundary inspected by the reporter. The
    /// Host drops the report as a `no_op` if output or runtime state advanced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_observation: Option<AgentStateReportObservationFence>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentStateReportCausality {
    #[serde(with = "super::json_u64")]
    pub sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentStateReportObservationFence {
    pub terminal_epoch: String,
    #[serde(with = "super::json_u64")]
    pub runtime_revision: u64,
    #[serde(with = "super::json_u64")]
    pub output_sequence: u64,
}

/// Provider-neutral report payload. Both values are bounded opaque
/// identifiers; the Host supplies the authoritative session fence, revision,
/// output sequence, and source.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderConversationIdentityReport {
    pub provider_id: String,
    pub conversation_id: String,
    /// Exact predecessor verified by the provider adapter; never an arbitrary replacement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_fence: Option<SessionFence>,
}

impl fmt::Debug for ProviderConversationIdentityReport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderConversationIdentityReport")
            .field("provider_id", &self.provider_id)
            .field("conversation_id_len", &self.conversation_id.len())
            .field("expected_fence", &self.expected_fence)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStateReportOutcome {
    Applied,
    DroppedExited,
    NoOp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentStateReportReceipt {
    pub request_id: String,
    pub outcome: AgentStateReportOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_conversation_identity: Option<Box<ProviderConversationIdentityProjection>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlRequest {
    pub request_id: String,
    #[serde(with = "super::json_u64")]
    pub expected_controller_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlRelease {
    pub request_id: String,
    #[serde(with = "super::json_u64")]
    pub controller_generation: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlReceiptState {
    Granted,
    Released,
    Refused,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ControlReceipt {
    pub request_id: String,
    #[serde(with = "super::json_u64")]
    pub previous_controller_generation: u64,
    #[serde(with = "super::json_u64")]
    pub controller_generation: u64,
    pub state: ControlReceiptState,
    pub reason: Option<OperationReceiptReason>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Detach {
    pub reason: Option<String>,
}

/// A capability-gated, fully fenced request to change or exercise one
/// standalone session's Host-owned retirement contract.
///
/// This is deliberately not an extension of [`Detach`]. EOF, socket loss,
/// process teardown, and every legacy Detach reason remain preserve-only.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SessionRetirementRequest {
    pub request_id: String,
    pub expected_fence: SessionFence,
    pub action: SessionRetirementAction,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionRetirementAction {
    GracefulClientDeparture,
    /// Compensates a create that became externally discoverable but never
    /// reached a presentation. Authorization is carried only by the redacted
    /// Hello proof; the Host additionally requires an unchanged zero attach
    /// generation before it may retire anything.
    AbandonUnpresentedCreationV1,
    Configure {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        policy: Option<SessionRetirementPolicy>,
    },
    Sweep {
        apply: bool,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRetirementReceiptState {
    PolicyUpdated,
    RetirementArmed,
    Eligible,
    SessionPreserved,
    Refused,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRetirementReceiptReason {
    PolicyNotConfigured,
    OtherClientsAttached,
    ProviderBusy,
    ProviderIdentityChanged,
    ProcessObservationUnavailable,
    PersistenceUnavailable,
    SessionExited,
    GenerationChanged,
    HostExiting,
    ManagedSession,
    UnsupportedAction,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SessionRetirementReceipt {
    pub request_id: String,
    pub state: SessionRetirementReceiptState,
    pub reason: Option<SessionRetirementReceiptReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<SessionRetirementPolicy>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Exit {
    #[serde(with = "super::json_u64")]
    pub final_output_seq: u64,
    pub exit_code: Option<i32>,
    pub platform_status: Option<String>,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryPosture {
    Never,
    Reconnect,
    RetryAfterResync,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ErrorFrame {
    pub code: ErrorCode,
    /// Original client-boundary failure when a relay has no Host refusal to forward.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_code: Option<String>,
    pub message: String,
    pub retry: RetryPosture,
    pub required_capability: Option<String>,
    pub supported_versions: Option<VersionRange>,
    pub in_reply_to_request_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::AgentProvider;

    #[test]
    fn agent_provider_ids_parse_at_the_process_boundary() {
        assert_eq!(AgentProvider::from_id("codex"), Some(AgentProvider::Codex));
        assert_eq!(
            AgentProvider::from_id("qwen-code"),
            Some(AgentProvider::QwenCode)
        );
        assert_eq!(AgentProvider::from_id("CoDeX"), None);
        assert_eq!(AgentProvider::from_id("unknown"), None);
    }
}
