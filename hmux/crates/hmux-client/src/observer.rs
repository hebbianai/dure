use crate::connection::{ConnectionInterrupt, LocalConnection, LocalWriter};
use crate::error::host_refused;
use crate::{ClientError, ProtocolVersion, SessionDescriptor};
use hmux_session_protocol::{
    AGENT_IDENTITY_PROJECTION_CAPABILITY, AGENT_RUNTIME_STATE_CAPABILITY, AgentIdentityProjection,
    AgentIdentitySource as HostAgentIdentitySource, AgentProvider as HostAgentProvider,
    AgentRuntimeActivity as HostAgentRuntimeActivity,
    AgentRuntimeAttention as HostAgentRuntimeAttention,
    AgentRuntimeLifecycle as HostAgentRuntimeLifecycle, AgentRuntimeStateProjection,
    AgentRuntimeStateSource as HostAgentRuntimeStateSource,
    EXECUTION_LOCATION_PROJECTION_CAPABILITY, ExecutionLocation as HostExecutionLocation,
    ExecutionLocationProjection, ExecutionLocationSource as HostExecutionLocationSource, FrameBody,
    LifecycleState, OutputDelta, PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
    ProviderConversationIdentityProjection,
    ProviderConversationIdentitySource as HostProviderConversationIdentitySource, ReplayGap,
    ScreenSnapshot, ScreenSnapshotProfile, ScreenSnapshotRequest, SessionFence,
    WORKING_DIRECTORY_PROJECTION_CAPABILITY, WorkingDirectoryProjection,
    WorkingDirectorySource as HostWorkingDirectorySource,
};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

mod local;

#[derive(Clone, Eq, PartialEq)]
pub struct AuthorizationProofReference(String);

impl AuthorizationProofReference {
    pub fn new(value: impl Into<String>) -> Result<Self, ClientError> {
        let value = value.into();
        if value.is_empty() {
            return Err(ClientError::InvalidAuthorizationProofReference);
        }
        Ok(Self(value))
    }

    pub(crate) fn into_inner(self) -> String {
        self.0
    }
}

impl fmt::Debug for AuthorizationProofReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AuthorizationProofReference(<redacted>)")
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ObserverAttachOptions {
    authorization_proof_reference: Option<AuthorizationProofReference>,
    initial_snapshot_profile: Option<ScreenSnapshotProfile>,
    handshake_timeout: Option<Duration>,
    handshake_completion_timeout: Option<Duration>,
    handshake_deadline: Option<std::time::Instant>,
}

impl ObserverAttachOptions {
    #[must_use]
    pub fn with_authorization_proof_reference(
        mut self,
        reference: AuthorizationProofReference,
    ) -> Self {
        self.authorization_proof_reference = Some(reference);
        self
    }

    /// Requests this capture profile for the initial attach snapshot. Only
    /// honored when the host negotiates `screen_snapshot_profile_v1`; older
    /// hosts ignore it and send the full snapshot.
    #[must_use]
    pub fn with_initial_snapshot_profile(mut self, profile: ScreenSnapshotProfile) -> Self {
        self.initial_snapshot_profile = Some(profile);
        self
    }

    /// Bounds the complete observer handshake. This is intentionally separate
    /// from steady-state read timeouts so one-shot probes can carry a smaller
    /// budget without changing a connected observer's stream semantics.
    #[must_use]
    pub fn with_handshake_timeout(mut self, timeout: Duration) -> Self {
        self.handshake_timeout = Some(timeout);
        self
    }

    #[must_use]
    pub fn with_handshake_completion_timeout(mut self, timeout: Duration) -> Self {
        self.handshake_completion_timeout = Some(timeout);
        self
    }

    #[must_use]
    pub fn with_handshake_deadline(mut self, deadline: std::time::Instant) -> Self {
        self.handshake_deadline = Some(deadline);
        self
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkingDirectorySource {
    LaunchFallback,
    /// An observation published by an older Host. Current Hosts do not infer
    /// working-directory state from terminal presentation bytes.
    Osc7,
    ProcessInspection,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WorkingDirectoryDescriptor {
    pub terminal_epoch: String,
    pub observed_through_output_seq: String,
    pub path: String,
    pub source: WorkingDirectorySource,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecutionLocation {
    Local,
    Ssh { target: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionLocationSource {
    ProcessInspection,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ExecutionLocationDescriptor {
    pub terminal_epoch: String,
    pub observed_through_output_seq: String,
    pub location: ExecutionLocation,
    pub source: ExecutionLocationSource,
}

/// 관찰자가 앱에 넘기는 에이전트 CLI. `as_str`은 앱 `src/types.ts`의 Provider id와
/// 같은 문자열이며, 그 값이 그대로 UI의 로고·라벨로 이어진다.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
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
    pub fn as_str(self) -> &'static str {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentIdentitySource {
    ProcessInspection,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct AgentIdentityDescriptor {
    pub terminal_epoch: String,
    pub observed_through_output_seq: String,
    pub agent: Option<AgentProvider>,
    pub source: AgentIdentitySource,
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
    ProcessLifecycle,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentRuntimeStateDescriptor {
    pub terminal_epoch: String,
    pub revision: String,
    pub observed_through_output_seq: String,
    pub lifecycle: AgentRuntimeLifecycle,
    pub activity: AgentRuntimeActivity,
    pub attention: AgentRuntimeAttention,
    pub attention_id: Option<String>,
    pub source: AgentRuntimeStateSource,
    pub turn_completed_count: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderConversationIdentitySource {
    LaunchRequest,
    ProviderEvent,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ProviderConversationIdentityDescriptor {
    pub session_id: String,
    pub workspace_id: String,
    pub runner_principal: String,
    pub runner_instance: String,
    pub channel_epoch: String,
    pub host_instance_id: String,
    pub terminal_epoch: String,
    pub revision: String,
    pub observed_through_output_seq: String,
    pub provider_id: String,
    pub conversation_id: String,
    pub source: ProviderConversationIdentitySource,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RecoveredPresentationDescriptor {
    pub source_session_id: String,
    pub source_host_instance_id: String,
    pub source_terminal_epoch: String,
    pub source_sequence_through: String,
    pub captured_unix_ms: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ScreenSnapshotDescriptor {
    pub terminal_epoch: String,
    pub sequence_through: String,
    pub rows: u16,
    pub columns: u16,
    pub repaint_bytes: Vec<u8>,
    pub alternate_screen: bool,
    pub cursor_visible: bool,
    pub truncated: bool,
    pub working_directory: Option<WorkingDirectoryDescriptor>,
    pub execution_location: Option<ExecutionLocationDescriptor>,
    pub agent_identity: Option<AgentIdentityDescriptor>,
    pub agent_runtime_state: Option<AgentRuntimeStateDescriptor>,
    pub controller_input_pending: Option<bool>,
    pub semantic_idle_ms: Option<String>,
    pub provider_conversation_identity: Option<Box<ProviderConversationIdentityDescriptor>>,
    pub recovered_presentation: Option<Box<RecoveredPresentationDescriptor>>,
    /// "viewport_only" when retained scrollback was intentionally omitted by
    /// the requested profile; the client may pull a full snapshot to hydrate.
    pub actual_profile: Option<ScreenSnapshotProfileDescriptor>,
    pub in_reply_to_request_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenSnapshotProfileDescriptor {
    Full,
    ViewportOnly,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct OutputDeltaDescriptor {
    pub terminal_epoch: String,
    pub output_seq: String,
    pub bytes: Vec<u8>,
    pub rows: Option<u16>,
    pub columns: Option<u16>,
    pub working_directory: Option<WorkingDirectoryDescriptor>,
    pub execution_location: Option<ExecutionLocationDescriptor>,
    pub agent_identity: Option<AgentIdentityDescriptor>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ReplayGapDescriptor {
    pub terminal_epoch: String,
    pub requested_after_output_seq: String,
    pub earliest_retained_output_seq: String,
    pub current_output_seq: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ObserverExit {
    pub final_output_seq: String,
    pub exit_code: Option<i32>,
    pub platform_status: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ObserverLifecycle {
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ObserverNegotiation {
    pub protocol_version: ProtocolVersion,
    pub selected_capabilities: Vec<String>,
    pub lifecycle: ObserverLifecycle,
    pub working_directory_projection: bool,
    pub execution_location_projection: bool,
    pub agent_identity_projection: bool,
    pub agent_runtime_state_projection: bool,
    pub provider_conversation_identity_projection: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ObserverAttachment {
    pub session: SessionDescriptor,
    pub negotiation: ObserverNegotiation,
    pub initial_snapshot: ScreenSnapshotDescriptor,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachedObserverAttachment {
    pub host_build_version: String,
    pub negotiation: ObserverNegotiation,
    pub initial_snapshot: ScreenSnapshotDescriptor,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum ObserverEvent {
    Output(OutputDeltaDescriptor),
    Snapshot(ScreenSnapshotDescriptor),
    AgentRuntimeState(AgentRuntimeStateDescriptor),
    ProviderConversationIdentity(ProviderConversationIdentityDescriptor),
    ReplayGap(ReplayGapDescriptor),
    Exit(ObserverExit),
}

pub struct LocalSessionObserver {
    attachment: ObserverAttachment,
    attached: AttachedSessionObserver,
}

pub struct AttachedSessionObserver {
    attachment: AttachedObserverAttachment,
    connection: LocalConnection,
    mutations: ObserverMutationHandle,
    working_directory_projection: bool,
    execution_location_projection: bool,
    agent_identity_projection: bool,
    agent_runtime_state_projection: bool,
    provider_conversation_identity_projection: bool,
}

#[derive(Clone)]
pub struct ObserverMutationHandle {
    writer: LocalWriter,
    fence: SessionFence,
    request_sequence: Arc<AtomicU64>,
}

impl ObserverMutationHandle {
    pub fn request_snapshot(&self) -> Result<String, ClientError> {
        self.send_snapshot_request(None, None)
    }

    pub fn request_snapshot_with_profile(
        &self,
        profile: ScreenSnapshotProfile,
    ) -> Result<String, ClientError> {
        self.send_snapshot_request(Some(profile), None)
    }

    /// Sends a snapshot request with a caller-known correlation id.
    ///
    /// The id remains client-scoped protocol metadata; accepting it here lets
    /// an adapter know the expected reply before another IPC route can deliver
    /// the response. Frame validation still enforces the protocol bounds.
    pub fn request_snapshot_with_request_id(
        &self,
        request_id: String,
    ) -> Result<String, ClientError> {
        self.send_snapshot_request(None, Some(request_id))
    }

    pub fn request_snapshot_with_profile_and_request_id(
        &self,
        profile: ScreenSnapshotProfile,
        request_id: String,
    ) -> Result<String, ClientError> {
        self.send_snapshot_request(Some(profile), Some(request_id))
    }

    fn send_snapshot_request(
        &self,
        profile: Option<ScreenSnapshotProfile>,
        request_id: Option<String>,
    ) -> Result<String, ClientError> {
        let request_id = request_id.unwrap_or_else(|| {
            format!(
                "observer_snapshot_{}_{}",
                std::process::id(),
                self.request_sequence.fetch_add(1, Ordering::Relaxed)
            )
        });
        self.writer
            .send(FrameBody::ScreenSnapshotRequest(ScreenSnapshotRequest {
                request_id: request_id.clone(),
                expected_fence: self.fence.clone(),
                profile,
            }))?;
        Ok(request_id)
    }
}

pub struct ObserverInterrupt {
    inner: ConnectionInterrupt,
}

impl fmt::Debug for ObserverInterrupt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ObserverInterrupt")
            .finish_non_exhaustive()
    }
}

impl ObserverInterrupt {
    pub fn interrupt(&self) {
        self.inner.interrupt();
    }
}

impl fmt::Debug for LocalSessionObserver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalSessionObserver")
            .field("session_id", &self.attachment.session.session_id)
            .field("workspace_id", &self.attachment.session.workspace_id)
            .field("attached", &self.attached)
            .finish()
    }
}

impl fmt::Debug for AttachedSessionObserver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AttachedSessionObserver")
            .field(
                "terminal_epoch",
                &self.connection.hello_ack().actual_fence.terminal_epoch,
            )
            .field("last_output_seq", &self.connection.last_output_seq())
            .field(
                "working_directory_projection",
                &self.working_directory_projection,
            )
            .field("agent_identity_projection", &self.agent_identity_projection)
            .field(
                "agent_runtime_state_projection",
                &self.agent_runtime_state_projection,
            )
            .field(
                "provider_conversation_identity_projection",
                &self.provider_conversation_identity_projection,
            )
            .finish_non_exhaustive()
    }
}

pub(crate) fn project_session_at_snapshot(
    session: &SessionDescriptor,
    snapshot: &ScreenSnapshotDescriptor,
) -> SessionDescriptor {
    // A Ready descriptor carries the launch high-water. Replace only that
    // mutable fact with the exact snapshot fence that owns the projections.
    let mut observed = session.clone();
    observed.output_seq.clone_from(&snapshot.sequence_through);
    observed
}

impl AttachedSessionObserver {
    /// Builds the high-level observer reducer over an already attached
    /// transport. Remote relays use this constructor so observer panes remain
    /// real Host attachments without acquiring the sole controller lease.
    pub fn from_connection(connection: LocalConnection) -> Result<Self, ClientError> {
        let ack = connection.hello_ack();
        let working_directory_projection =
            connection.supports(WORKING_DIRECTORY_PROJECTION_CAPABILITY);
        let execution_location_projection =
            connection.supports(EXECUTION_LOCATION_PROJECTION_CAPABILITY);
        let agent_identity_projection = connection.supports(AGENT_IDENTITY_PROJECTION_CAPABILITY);
        let agent_runtime_state_projection = connection.supports(AGENT_RUNTIME_STATE_CAPABILITY);
        let provider_conversation_identity_projection =
            connection.supports(PROVIDER_CONVERSATION_IDENTITY_CAPABILITY);
        let initial_snapshot = project_snapshot(
            connection.require_initial_snapshot()?.clone(),
            working_directory_projection,
            execution_location_projection,
            agent_identity_projection,
            agent_runtime_state_projection,
            provider_conversation_identity_projection,
        )?;
        let negotiation = ObserverNegotiation {
            protocol_version: ProtocolVersion {
                major: ack.selected_version.major,
                minor: ack.selected_version.minor,
            },
            selected_capabilities: ack.selected_capabilities.clone(),
            lifecycle: project_lifecycle(ack.lifecycle),
            working_directory_projection,
            execution_location_projection,
            agent_identity_projection,
            agent_runtime_state_projection,
            provider_conversation_identity_projection,
        };
        let mutations = ObserverMutationHandle {
            writer: connection.writer(),
            fence: ack.actual_fence.clone(),
            request_sequence: Arc::new(AtomicU64::new(1)),
        };

        Ok(Self {
            attachment: AttachedObserverAttachment {
                host_build_version: ack.host_build_version.clone(),
                negotiation,
                initial_snapshot,
            },
            connection,
            mutations,
            working_directory_projection,
            execution_location_projection,
            agent_identity_projection,
            agent_runtime_state_projection,
            provider_conversation_identity_projection,
        })
    }

    #[must_use]
    pub fn attachment(&self) -> &AttachedObserverAttachment {
        &self.attachment
    }

    pub fn read_event(&mut self) -> Result<Option<ObserverEvent>, ClientError> {
        self.connection
            .read_body_optional()?
            .map(|body| self.project_event(body))
            .transpose()
    }

    #[must_use]
    pub fn mutation_handle(&self) -> ObserverMutationHandle {
        self.mutations.clone()
    }

    pub fn detach(mut self) -> Result<(), ClientError> {
        self.connection.detach("observer_detach")
    }

    pub fn interrupt_handle(&self) -> Result<ObserverInterrupt, ClientError> {
        self.connection
            .interrupt_handle()
            .map(|inner| ObserverInterrupt { inner })
    }

    fn project_event(&self, body: FrameBody) -> Result<ObserverEvent, ClientError> {
        match body {
            FrameBody::OutputDelta(delta) => Ok(ObserverEvent::Output(project_output(
                delta,
                self.working_directory_projection,
                self.execution_location_projection,
                self.agent_identity_projection,
            ))),
            FrameBody::ScreenSnapshot(snapshot) => Ok(ObserverEvent::Snapshot(project_snapshot(
                snapshot,
                self.working_directory_projection,
                self.execution_location_projection,
                self.agent_identity_projection,
                self.agent_runtime_state_projection,
                self.provider_conversation_identity_projection,
            )?)),
            FrameBody::AgentRuntimeState(state) if self.agent_runtime_state_projection => Ok(
                ObserverEvent::AgentRuntimeState(project_agent_runtime_state(state)?),
            ),
            FrameBody::ProviderConversationIdentity(identity)
                if self.provider_conversation_identity_projection =>
            {
                Ok(ObserverEvent::ProviderConversationIdentity(
                    project_provider_conversation_identity(identity),
                ))
            }
            FrameBody::ReplayGap(gap) => Ok(ObserverEvent::ReplayGap(project_replay_gap(gap))),
            FrameBody::Exit(exit) => Ok(ObserverEvent::Exit(ObserverExit {
                final_output_seq: exit.final_output_seq.to_string(),
                exit_code: exit.exit_code,
                platform_status: exit.platform_status,
                reason: exit.reason,
            })),
            FrameBody::Error(error) => Err(host_refused(error)),
            other => Err(ClientError::UnexpectedFrame {
                expected: "observer update",
                actual: frame_kind_name(&other),
            }),
        }
    }
}

pub(crate) fn project_snapshot(
    snapshot: ScreenSnapshot,
    working_directory_projection: bool,
    execution_location_projection: bool,
    agent_identity_projection: bool,
    agent_runtime_state_projection: bool,
    provider_conversation_identity_projection: bool,
) -> Result<ScreenSnapshotDescriptor, ClientError> {
    let terminal_epoch = snapshot.fence.terminal_epoch.clone();
    Ok(ScreenSnapshotDescriptor {
        terminal_epoch,
        sequence_through: snapshot.sequence_through.to_string(),
        rows: snapshot.rows,
        columns: snapshot.columns,
        repaint_bytes: snapshot.repaint_bytes,
        alternate_screen: snapshot.alternate_screen,
        cursor_visible: snapshot.cursor_visible,
        truncated: snapshot.truncated,
        working_directory: project_working_directory(
            snapshot.working_directory,
            working_directory_projection,
        ),
        execution_location: project_execution_location(
            snapshot.execution_location,
            execution_location_projection,
        ),
        agent_identity: project_optional_agent_identity(
            snapshot.agent_identity,
            agent_identity_projection,
        ),
        agent_runtime_state: agent_runtime_state_projection
            .then_some(snapshot.agent_runtime_state)
            .flatten()
            .map(project_agent_runtime_state)
            .transpose()?,
        controller_input_pending: snapshot.controller_input_pending,
        semantic_idle_ms: agent_runtime_state_projection
            .then_some(snapshot.semantic_idle_ms)
            .flatten()
            .map(|age| age.to_string()),
        provider_conversation_identity: provider_conversation_identity_projection
            .then_some(snapshot.provider_conversation_identity)
            .flatten()
            .map(|projection| Box::new(project_provider_conversation_identity(*projection))),
        recovered_presentation: snapshot.recovered_presentation.map(|recovered| {
            Box::new(RecoveredPresentationDescriptor {
                source_session_id: recovered.source_fence.session_id,
                source_host_instance_id: recovered.source_fence.host_instance_id,
                source_terminal_epoch: recovered.source_fence.terminal_epoch,
                source_sequence_through: recovered.sequence_through.to_string(),
                captured_unix_ms: recovered.captured_unix_ms.to_string(),
                truncated: recovered.truncated,
            })
        }),
        actual_profile: snapshot.actual_profile.map(|profile| match profile {
            ScreenSnapshotProfile::Full => ScreenSnapshotProfileDescriptor::Full,
            ScreenSnapshotProfile::ViewportOnly => ScreenSnapshotProfileDescriptor::ViewportOnly,
        }),
        in_reply_to_request_id: snapshot.in_reply_to_request_id,
    })
}

/// Projects one already-validated Host wire identity into the stable client DTO.
pub fn project_provider_conversation_identity(
    projection: ProviderConversationIdentityProjection,
) -> ProviderConversationIdentityDescriptor {
    ProviderConversationIdentityDescriptor {
        session_id: projection.fence.session_id,
        workspace_id: projection.fence.workspace_id,
        runner_principal: projection.fence.runner_principal,
        runner_instance: projection.fence.runner_instance,
        channel_epoch: projection.fence.channel_epoch.to_string(),
        host_instance_id: projection.fence.host_instance_id,
        terminal_epoch: projection.fence.terminal_epoch,
        revision: projection.revision.to_string(),
        observed_through_output_seq: projection.observed_through_output_seq.to_string(),
        provider_id: projection.provider_id,
        conversation_id: projection.conversation_id,
        source: match projection.source {
            HostProviderConversationIdentitySource::LaunchRequest => {
                ProviderConversationIdentitySource::LaunchRequest
            }
            HostProviderConversationIdentitySource::ProviderEvent => {
                ProviderConversationIdentitySource::ProviderEvent
            }
        },
    }
}

pub fn project_agent_runtime_state(
    projection: AgentRuntimeStateProjection,
) -> Result<AgentRuntimeStateDescriptor, ClientError> {
    let source = match projection.source {
        HostAgentRuntimeStateSource::ProviderEvent => AgentRuntimeStateSource::ProviderEvent,
        HostAgentRuntimeStateSource::OrchestrationEvent => {
            AgentRuntimeStateSource::OrchestrationEvent
        }
        HostAgentRuntimeStateSource::ControllerInput => AgentRuntimeStateSource::ControllerInput,
        HostAgentRuntimeStateSource::TerminalInference => {
            return Err(ClientError::transport(
                "hmux_agent_runtime_source_unsupported",
                "terminal-inferred agent runtime state is unsupported",
            ));
        }
        HostAgentRuntimeStateSource::ProcessLifecycle => AgentRuntimeStateSource::ProcessLifecycle,
    };
    Ok(AgentRuntimeStateDescriptor {
        terminal_epoch: projection.terminal_epoch,
        revision: projection.revision.to_string(),
        observed_through_output_seq: projection.observed_through_output_seq.to_string(),
        lifecycle: match projection.lifecycle {
            HostAgentRuntimeLifecycle::Starting => AgentRuntimeLifecycle::Starting,
            HostAgentRuntimeLifecycle::Running => AgentRuntimeLifecycle::Running,
            HostAgentRuntimeLifecycle::Exited => AgentRuntimeLifecycle::Exited,
        },
        activity: match projection.activity {
            HostAgentRuntimeActivity::Working => AgentRuntimeActivity::Working,
            HostAgentRuntimeActivity::Waiting => AgentRuntimeActivity::Waiting,
        },
        attention: match projection.attention {
            HostAgentRuntimeAttention::None => AgentRuntimeAttention::None,
            HostAgentRuntimeAttention::InputRequired => AgentRuntimeAttention::InputRequired,
            HostAgentRuntimeAttention::ApprovalRequired => AgentRuntimeAttention::ApprovalRequired,
            HostAgentRuntimeAttention::Error => AgentRuntimeAttention::Error,
        },
        attention_id: projection.attention_id,
        source,
        turn_completed_count: projection.turn_completed_count.to_string(),
    })
}

pub(crate) fn project_output(
    delta: OutputDelta,
    working_directory_projection: bool,
    execution_location_projection: bool,
    agent_identity_projection: bool,
) -> OutputDeltaDescriptor {
    OutputDeltaDescriptor {
        terminal_epoch: delta.terminal_epoch,
        output_seq: delta.output_seq.to_string(),
        bytes: delta.bytes,
        rows: delta.rows,
        columns: delta.columns,
        working_directory: project_working_directory(
            delta.working_directory,
            working_directory_projection,
        ),
        execution_location: project_execution_location(
            delta.execution_location,
            execution_location_projection,
        ),
        agent_identity: project_optional_agent_identity(
            delta.agent_identity,
            agent_identity_projection,
        ),
    }
}

fn project_optional_agent_identity(
    projection: Option<AgentIdentityProjection>,
    negotiated: bool,
) -> Option<AgentIdentityDescriptor> {
    negotiated
        .then_some(projection)
        .flatten()
        .map(project_agent_identity)
}

pub fn project_agent_identity(projection: AgentIdentityProjection) -> AgentIdentityDescriptor {
    AgentIdentityDescriptor {
        terminal_epoch: projection.terminal_epoch,
        observed_through_output_seq: projection.observed_through_output_seq.to_string(),
        agent: projection.agent.map(map_provider),
        source: match projection.source {
            HostAgentIdentitySource::ProcessInspection => AgentIdentitySource::ProcessInspection,
        },
    }
}

/// 프로토콜 프로바이더 → 관찰자 프로바이더. 새 에이전트를 추가하면 컴파일러가
/// 이 match에서 막아 준다.
fn map_provider(provider: HostAgentProvider) -> AgentProvider {
    match provider {
        HostAgentProvider::Claude => AgentProvider::Claude,
        HostAgentProvider::Codex => AgentProvider::Codex,
        HostAgentProvider::Kimi => AgentProvider::Kimi,
        HostAgentProvider::Gemini => AgentProvider::Gemini,
        HostAgentProvider::Cursor => AgentProvider::Cursor,
        HostAgentProvider::Copilot => AgentProvider::Copilot,
        HostAgentProvider::Opencode => AgentProvider::Opencode,
        HostAgentProvider::Amp => AgentProvider::Amp,
        HostAgentProvider::Goose => AgentProvider::Goose,
        HostAgentProvider::Droid => AgentProvider::Droid,
        HostAgentProvider::Auggie => AgentProvider::Auggie,
        HostAgentProvider::Grok => AgentProvider::Grok,
        HostAgentProvider::Hermes => AgentProvider::Hermes,
        HostAgentProvider::QwenCode => AgentProvider::QwenCode,
        HostAgentProvider::Cline => AgentProvider::Cline,
        HostAgentProvider::Continue => AgentProvider::Continue,
        HostAgentProvider::Charm => AgentProvider::Charm,
        HostAgentProvider::Codebuff => AgentProvider::Codebuff,
        HostAgentProvider::Kilocode => AgentProvider::Kilocode,
        HostAgentProvider::Kiro => AgentProvider::Kiro,
        HostAgentProvider::RovoDev => AgentProvider::RovoDev,
        HostAgentProvider::MistralVibe => AgentProvider::MistralVibe,
        HostAgentProvider::Antigravity => AgentProvider::Antigravity,
        HostAgentProvider::Openclaude => AgentProvider::Openclaude,
        HostAgentProvider::Pi => AgentProvider::Pi,
        HostAgentProvider::OhMyPi => AgentProvider::OhMyPi,
        HostAgentProvider::CommandCode => AgentProvider::CommandCode,
    }
}

pub(crate) fn project_replay_gap(gap: ReplayGap) -> ReplayGapDescriptor {
    ReplayGapDescriptor {
        terminal_epoch: gap.cursor.terminal_epoch,
        requested_after_output_seq: gap.cursor.after_output_seq.to_string(),
        earliest_retained_output_seq: gap.earliest_retained_output_seq.to_string(),
        current_output_seq: gap.current_output_seq.to_string(),
    }
}

fn project_working_directory(
    projection: Option<WorkingDirectoryProjection>,
    negotiated: bool,
) -> Option<WorkingDirectoryDescriptor> {
    negotiated
        .then_some(projection)
        .flatten()
        .map(project_working_directory_projection)
}

pub fn project_working_directory_projection(
    projection: WorkingDirectoryProjection,
) -> WorkingDirectoryDescriptor {
    WorkingDirectoryDescriptor {
        terminal_epoch: projection.terminal_epoch,
        observed_through_output_seq: projection.observed_through_output_seq.to_string(),
        path: projection.path,
        source: match projection.source {
            HostWorkingDirectorySource::LaunchFallback => WorkingDirectorySource::LaunchFallback,
            HostWorkingDirectorySource::Osc7 => WorkingDirectorySource::Osc7,
            HostWorkingDirectorySource::ProcessInspection => {
                WorkingDirectorySource::ProcessInspection
            }
        },
    }
}

fn project_execution_location(
    projection: Option<ExecutionLocationProjection>,
    negotiated: bool,
) -> Option<ExecutionLocationDescriptor> {
    negotiated
        .then_some(projection)
        .flatten()
        .map(|projection| ExecutionLocationDescriptor {
            terminal_epoch: projection.terminal_epoch,
            observed_through_output_seq: projection.observed_through_output_seq.to_string(),
            location: match projection.location {
                HostExecutionLocation::Local => ExecutionLocation::Local,
                HostExecutionLocation::Ssh { target } => ExecutionLocation::Ssh { target },
            },
            source: match projection.source {
                HostExecutionLocationSource::ProcessInspection => {
                    ExecutionLocationSource::ProcessInspection
                }
            },
        })
}

pub(crate) fn frame_kind_name(body: &FrameBody) -> String {
    format!("{:?}", body.kind()).to_lowercase()
}

pub(crate) fn project_lifecycle(lifecycle: LifecycleState) -> ObserverLifecycle {
    match lifecycle {
        LifecycleState::Connecting => ObserverLifecycle::Connecting,
        LifecycleState::Syncing => ObserverLifecycle::Syncing,
        LifecycleState::Observing => ObserverLifecycle::Observing,
        LifecycleState::Controlling => ObserverLifecycle::Controlling,
        LifecycleState::Reconnecting => ObserverLifecycle::Reconnecting,
        LifecycleState::Detached => ObserverLifecycle::Detached,
        LifecycleState::Exited => ObserverLifecycle::Exited,
        LifecycleState::LegacyUnhosted => ObserverLifecycle::LegacyUnhosted,
        LifecycleState::PtyLost => ObserverLifecycle::PtyLost,
    }
}

// Every test below stands up a real Host on a real Unix socket and attaches
// to it, so they exercise the local dialer rather than merely needing Unix.
// Without one there is nothing to dial.
#[cfg(all(test, unix, feature = "local-runtime"))]
mod tests {
    use super::*;
    use crate::{LocalSessionCatalog, SessionSelector};
    use hmux_host::local_discovery::{
        ClaimLinkage, DiscoveryKey, DiscoveryRoot, HostLifetimeIdentity, LocalEndpoint,
        LocalEndpointKind, ManifestCommon, ReadyManifest, SessionClass, StartingManifest,
    };
    use hmux_session_protocol::{
        AGENT_IDENTITY_PROJECTION_CAPABILITY, AgentIdentityProjection,
        AgentIdentitySource as HostAgentIdentitySource, AgentProvider as HostAgentProvider,
        AuthorizationPosture, FrameCodec, FrameLimits, Hello, HelloAck, OutputDelta, PROTOCOL_V1,
        ProcessProof, RuntimeContext, ScreenSnapshotEncoding, SessionFence, VersionRange,
        WireFrame, WorkingDirectorySource as HostWorkingDirectorySource,
    };
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;
    use std::thread;
    use tempfile::TempDir;

    const SCREEN_SNAPSHOT_CAPABILITY: &str = "screen_snapshot";
    const LIVE_OUTPUT_CAPABILITY: &str = "live_output";

    struct Fixture {
        _temp: TempDir,
        catalog: LocalSessionCatalog,
        socket_path: std::path::PathBuf,
        fence: SessionFence,
    }

    fn fixture(capabilities: &[&str]) -> Fixture {
        let temp = TempDir::new().unwrap();
        let discovery_path = temp.path().join("discovery");
        let socket_path = temp.path().join("host.sock");
        let root = DiscoveryRoot::create(&discovery_path).unwrap();
        let key = DiscoveryKey::new("workspace-1", "session-1", "runner-1", 4).unwrap();
        let session = root.session(key).unwrap();
        let common = ManifestCommon {
            launch_program: None,
            schema_version: 1,
            host_build_version: "host-build".into(),
            supported_protocol: VersionRange {
                minimum: PROTOCOL_V1,
                maximum: PROTOCOL_V1,
            },
            capabilities: capabilities
                .iter()
                .map(|capability| (*capability).to_string())
                .collect(),
            lifetime: HostLifetimeIdentity {
                workspace_id: "workspace-1".into(),
                session_id: "session-1".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 4,
            },
            host_instance_id: "host-1".into(),
            provider_id: "fixture".into(),
            runtime_context: RuntimeContext::default(),
            claim_linkage: ClaimLinkage {
                claim_id: None,
                kickoff_action_id: None,
            },
            host_process: ProcessProof {
                process_id: 100,
                start_marker: "host-start".into(),
            },
            created_unix_ms: 1,
            session_class: SessionClass::Standalone,
            session_name: Some("fixture".into()),
            retirement_policy: None,
        };
        let lock = session.acquire_lifetime_lock().unwrap();
        session
            .publish_starting(
                &lock,
                StartingManifest {
                    common: common.clone(),
                    starting_unix_ms: 2,
                },
            )
            .unwrap();
        session
            .publish_ready(
                &lock,
                ReadyManifest {
                    common: common.clone(),
                    provider_process: ProcessProof {
                        process_id: 101,
                        start_marker: "provider-start".into(),
                    },
                    terminal_epoch: "terminal-1".into(),
                    ready_output_seq: 1,
                    endpoint: LocalEndpoint {
                        kind: LocalEndpointKind::UnixSocket,
                        address: socket_path.to_string_lossy().into_owned(),
                    },
                    capability_token: "secret-token".into(),
                    ready_unix_ms: 3,
                },
            )
            .unwrap();
        let fence = SessionFence {
            workspace_id: common.lifetime.workspace_id,
            session_id: common.lifetime.session_id,
            runner_principal: common.lifetime.runner_principal,
            runner_instance: common.lifetime.runner_instance,
            channel_epoch: common.lifetime.channel_epoch,
            host_instance_id: common.host_instance_id,
            terminal_epoch: "terminal-1".into(),
        };
        Fixture {
            _temp: temp,
            catalog: LocalSessionCatalog::new(discovery_path),
            socket_path,
            fence,
        }
    }

    fn snapshot(
        fence: SessionFence,
        sequence_through: u64,
        cwd: Option<WorkingDirectoryProjection>,
    ) -> ScreenSnapshot {
        ScreenSnapshot {
            fence,
            sequence_through,
            rows: 24,
            columns: 80,
            encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
            controller_input_pending: None,
            semantic_idle_ms: None,
            repaint_bytes: b"screen".to_vec(),
            alternate_screen: false,
            cursor_visible: true,
            truncated: false,
            working_directory: cwd,
            execution_location: None,
            agent_identity: None,
            agent_runtime_state: None,
            provider_conversation_identity: None,
            recovered_presentation: None,
            actual_profile: None,
            in_reply_to_request_id: None,
        }
    }

    #[test]
    fn execution_location_projection_requires_capability_negotiation() {
        let projection = ExecutionLocationProjection {
            terminal_epoch: "terminal-1".into(),
            observed_through_output_seq: 7,
            location: HostExecutionLocation::Ssh {
                target: "rts@211.181.122.124".into(),
            },
            source: HostExecutionLocationSource::ProcessInspection,
        };

        assert_eq!(
            project_execution_location(Some(projection.clone()), false),
            None
        );
        assert_eq!(
            project_execution_location(Some(projection), true),
            Some(ExecutionLocationDescriptor {
                terminal_epoch: "terminal-1".into(),
                observed_through_output_seq: "7".into(),
                location: ExecutionLocation::Ssh {
                    target: "rts@211.181.122.124".into(),
                },
                source: ExecutionLocationSource::ProcessInspection,
            })
        );
    }

    fn serve(
        socket_path: std::path::PathBuf,
        fence: SessionFence,
        selected_capabilities: Vec<String>,
        snapshots_and_updates: Vec<FrameBody>,
    ) -> mpsc::Receiver<Hello> {
        let listener = UnixListener::bind(socket_path).unwrap();
        let (hello_sender, hello_receiver) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let codec = FrameCodec::new(FrameLimits::default());
            let FrameBody::Hello(hello) = codec.read_from(&mut stream).unwrap().body else {
                panic!("client must begin with Hello");
            };
            hello_sender.send(hello).unwrap();
            codec
                .write_to(
                    &mut stream,
                    &WireFrame {
                        protocol_version: PROTOCOL_V1,
                        frame_id: 1,
                        body: FrameBody::HelloAck(HelloAck {
                            selected_version: PROTOCOL_V1,
                            selected_capabilities,
                            actual_fence: fence,
                            host_build_version: "host-build".into(),
                            lifecycle: LifecycleState::Observing,
                            host_process: ProcessProof {
                                process_id: 100,
                                start_marker: "host-start".into(),
                            },
                            provider_process: Some(ProcessProof {
                                process_id: 101,
                                start_marker: "provider-start".into(),
                            }),
                            earliest_retained_output_seq: 1,
                            current_output_seq: 1,
                            controller_generation: 0,
                            authorization_posture: AuthorizationPosture::StandaloneLocalOwner,
                        }),
                    },
                )
                .unwrap();
            for (offset, body) in snapshots_and_updates.into_iter().enumerate() {
                codec
                    .write_to(
                        &mut stream,
                        &WireFrame {
                            protocol_version: PROTOCOL_V1,
                            frame_id: u64::try_from(offset).unwrap() + 2,
                            body,
                        },
                    )
                    .unwrap();
            }
            let _ = codec.read_from(&mut stream);
        });
        hello_receiver
    }

    fn serve_snapshot_refresh(
        socket_path: std::path::PathBuf,
        fence: SessionFence,
    ) -> mpsc::Receiver<ScreenSnapshotRequest> {
        let listener = UnixListener::bind(socket_path).unwrap();
        let (request_sender, request_receiver) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let codec = FrameCodec::new(FrameLimits::default());
            let FrameBody::Hello(_) = codec.read_from(&mut stream).unwrap().body else {
                panic!("client must begin with Hello");
            };
            codec
                .write_to(
                    &mut stream,
                    &WireFrame {
                        protocol_version: PROTOCOL_V1,
                        frame_id: 1,
                        body: FrameBody::HelloAck(HelloAck {
                            selected_version: PROTOCOL_V1,
                            selected_capabilities: vec![
                                SCREEN_SNAPSHOT_CAPABILITY.to_string(),
                                LIVE_OUTPUT_CAPABILITY.to_string(),
                            ],
                            actual_fence: fence.clone(),
                            host_build_version: "host-build".into(),
                            lifecycle: LifecycleState::Observing,
                            host_process: ProcessProof {
                                process_id: 100,
                                start_marker: "host-start".into(),
                            },
                            provider_process: Some(ProcessProof {
                                process_id: 101,
                                start_marker: "provider-start".into(),
                            }),
                            earliest_retained_output_seq: 1,
                            current_output_seq: 1,
                            controller_generation: 0,
                            authorization_posture: AuthorizationPosture::StandaloneLocalOwner,
                        }),
                    },
                )
                .unwrap();
            codec
                .write_to(
                    &mut stream,
                    &WireFrame {
                        protocol_version: PROTOCOL_V1,
                        frame_id: 2,
                        body: FrameBody::ScreenSnapshot(snapshot(fence.clone(), 1, None)),
                    },
                )
                .unwrap();

            let FrameBody::ScreenSnapshotRequest(request) =
                codec.read_from(&mut stream).unwrap().body
            else {
                panic!("observer must request a snapshot on its existing attachment");
            };
            let response_request_id = request.request_id.clone();
            request_sender.send(request).unwrap();
            let mut refreshed = snapshot(fence.clone(), 3, None);
            refreshed.repaint_bytes = b"fresh-screen".to_vec();
            refreshed.in_reply_to_request_id = Some(response_request_id);
            codec
                .write_to(
                    &mut stream,
                    &WireFrame {
                        protocol_version: PROTOCOL_V1,
                        frame_id: 3,
                        body: FrameBody::ScreenSnapshot(refreshed),
                    },
                )
                .unwrap();
            for output_seq in 2..=4 {
                codec
                    .write_to(
                        &mut stream,
                        &WireFrame {
                            protocol_version: PROTOCOL_V1,
                            frame_id: output_seq + 2,
                            body: FrameBody::OutputDelta(OutputDelta {
                                terminal_epoch: fence.terminal_epoch.clone(),
                                output_seq,
                                bytes: format!("delta-{output_seq}").into_bytes(),
                                rows: None,
                                columns: None,
                                working_directory: None,
                                execution_location: None,
                                agent_identity: None,
                            }),
                        },
                    )
                    .unwrap();
            }
            let _ = codec.read_from(&mut stream);
        });
        request_receiver
    }

    #[test]
    fn observer_requests_a_fenced_snapshot_on_its_existing_attachment() {
        let capabilities = vec![SCREEN_SNAPSHOT_CAPABILITY, LIVE_OUTPUT_CAPABILITY];
        let fixture = fixture(&capabilities);
        let requests = serve_snapshot_refresh(fixture.socket_path.clone(), fixture.fence.clone());
        let mut observer = LocalSessionObserver::connect(
            &fixture.catalog,
            &SessionSelector::new("session-1", Some("workspace-1".into())),
            ObserverAttachOptions::default(),
        )
        .unwrap();

        let expected_request_id = "frontend_snapshot_7".to_string();
        let request_id = observer
            .mutation_handle()
            .request_snapshot_with_profile_and_request_id(
                ScreenSnapshotProfile::ViewportOnly,
                expected_request_id.clone(),
            )
            .expect("snapshot request");
        let request = requests.recv().unwrap();
        assert_eq!(request_id, expected_request_id);
        assert_eq!(request.request_id, request_id);
        assert_eq!(request.expected_fence, fixture.fence);
        assert_eq!(request.profile, Some(ScreenSnapshotProfile::ViewportOnly));

        let ObserverEvent::Snapshot(snapshot) = observer.read_event().unwrap().unwrap() else {
            panic!("expected refreshed observer snapshot");
        };
        assert_eq!(snapshot.repaint_bytes, b"fresh-screen");
        assert_eq!(snapshot.sequence_through, "3");
        assert_eq!(
            snapshot.in_reply_to_request_id.as_deref(),
            Some("frontend_snapshot_7")
        );
        let ObserverEvent::Output(output) = observer.read_event().unwrap().unwrap() else {
            panic!("expected the first post-snapshot output");
        };
        assert_eq!(output.output_seq, "4");
        assert_eq!(output.bytes, b"delta-4");
        observer.detach().unwrap();
    }

    #[test]
    fn observer_keeps_manifest_token_internal_and_projects_fenced_cwd() {
        let capabilities = vec![
            SCREEN_SNAPSHOT_CAPABILITY,
            LIVE_OUTPUT_CAPABILITY,
            WORKING_DIRECTORY_PROJECTION_CAPABILITY,
            AGENT_IDENTITY_PROJECTION_CAPABILITY,
        ];
        let fixture = fixture(&capabilities);
        let cwd = WorkingDirectoryProjection {
            terminal_epoch: fixture.fence.terminal_epoch.clone(),
            observed_through_output_seq: 1,
            path: "/workspace/project".into(),
            source: HostWorkingDirectorySource::Osc7,
        };
        let mut initial = snapshot(fixture.fence.clone(), 1, Some(cwd));
        initial.agent_identity = Some(AgentIdentityProjection {
            terminal_epoch: fixture.fence.terminal_epoch.clone(),
            observed_through_output_seq: 1,
            agent: Some(HostAgentProvider::Codex),
            source: HostAgentIdentitySource::ProcessInspection,
        });
        let hello = serve(
            fixture.socket_path.clone(),
            fixture.fence.clone(),
            capabilities.iter().map(ToString::to_string).collect(),
            vec![FrameBody::ScreenSnapshot(initial)],
        );

        let observer = LocalSessionObserver::connect(
            &fixture.catalog,
            &SessionSelector::new("session-1", Some("workspace-1".into())),
            ObserverAttachOptions::default(),
        )
        .unwrap();

        assert_eq!(hello.recv().unwrap().capability_token, "secret-token");
        assert_eq!(
            observer
                .attachment()
                .initial_snapshot
                .working_directory
                .as_ref()
                .unwrap()
                .path,
            "/workspace/project"
        );
        assert_eq!(
            observer
                .attachment()
                .initial_snapshot
                .agent_identity
                .as_ref()
                .unwrap()
                .agent,
            Some(AgentProvider::Codex)
        );
        assert!(!format!("{observer:?}").contains("secret-token"));
        observer.detach().unwrap();
    }

    #[test]
    fn observer_attachment_uses_the_exact_snapshot_output_sequence() {
        let capabilities = vec![
            SCREEN_SNAPSHOT_CAPABILITY,
            LIVE_OUTPUT_CAPABILITY,
            AGENT_RUNTIME_STATE_CAPABILITY,
        ];
        let fixture = fixture(&capabilities);
        let mut initial = snapshot(fixture.fence.clone(), 9, None);
        initial.agent_runtime_state = Some(AgentRuntimeStateProjection {
            terminal_epoch: fixture.fence.terminal_epoch.clone(),
            revision: 3,
            observed_through_output_seq: 8,
            lifecycle: HostAgentRuntimeLifecycle::Running,
            activity: HostAgentRuntimeActivity::Waiting,
            attention: HostAgentRuntimeAttention::None,
            attention_id: None,
            source: HostAgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: 1,
        });
        let hello = serve(
            fixture.socket_path.clone(),
            fixture.fence.clone(),
            capabilities.iter().map(ToString::to_string).collect(),
            vec![FrameBody::ScreenSnapshot(initial)],
        );

        let observer = LocalSessionObserver::connect(
            &fixture.catalog,
            &SessionSelector::new("session-1", Some("workspace-1".into())),
            ObserverAttachOptions::default(),
        )
        .unwrap();

        assert_eq!(hello.recv().unwrap().expected_fence, fixture.fence);
        assert_eq!(observer.attachment().initial_snapshot.sequence_through, "9");
        assert_eq!(observer.attachment().session.output_seq, "9");
        assert_eq!(
            observer
                .attachment()
                .initial_snapshot
                .agent_runtime_state
                .as_ref()
                .unwrap()
                .observed_through_output_seq,
            "8"
        );
        observer.detach().unwrap();
    }

    #[test]
    fn observer_rejects_terminal_inferred_agent_runtime_state() {
        let capabilities = vec![
            SCREEN_SNAPSHOT_CAPABILITY,
            LIVE_OUTPUT_CAPABILITY,
            AGENT_RUNTIME_STATE_CAPABILITY,
        ];
        let fixture = fixture(&capabilities);
        let mut initial = snapshot(fixture.fence.clone(), 9, None);
        initial.agent_runtime_state = Some(AgentRuntimeStateProjection {
            terminal_epoch: fixture.fence.terminal_epoch.clone(),
            revision: 3,
            observed_through_output_seq: 8,
            lifecycle: HostAgentRuntimeLifecycle::Running,
            activity: HostAgentRuntimeActivity::Waiting,
            attention: HostAgentRuntimeAttention::InputRequired,
            attention_id: Some("inferred-input".into()),
            source: HostAgentRuntimeStateSource::TerminalInference,
            turn_completed_count: 0,
        });
        let _hello = serve(
            fixture.socket_path.clone(),
            fixture.fence.clone(),
            capabilities.iter().map(ToString::to_string).collect(),
            vec![FrameBody::ScreenSnapshot(initial)],
        );

        let result = LocalSessionObserver::connect(
            &fixture.catalog,
            &SessionSelector::new("session-1", Some("workspace-1".into())),
            ObserverAttachOptions::default(),
        );
        let Err(error) = result else {
            panic!("terminal-inferred semantic state must not enter the product client");
        };

        assert_eq!(error.code(), "hmux_agent_runtime_source_unsupported");
    }

    #[test]
    fn unnegotiated_cwd_is_discarded_for_old_hosts() {
        let capabilities = vec![SCREEN_SNAPSHOT_CAPABILITY, LIVE_OUTPUT_CAPABILITY];
        let fixture = fixture(&capabilities);
        let cwd = WorkingDirectoryProjection {
            terminal_epoch: fixture.fence.terminal_epoch.clone(),
            observed_through_output_seq: 1,
            path: "/must/not/be/trusted".into(),
            source: HostWorkingDirectorySource::Osc7,
        };
        let _hello = serve(
            fixture.socket_path.clone(),
            fixture.fence.clone(),
            capabilities.iter().map(ToString::to_string).collect(),
            vec![FrameBody::ScreenSnapshot(snapshot(
                fixture.fence.clone(),
                1,
                Some(cwd),
            ))],
        );

        let observer = LocalSessionObserver::connect(
            &fixture.catalog,
            &SessionSelector::new("session-1", Some("workspace-1".into())),
            ObserverAttachOptions::default(),
        )
        .unwrap();

        assert!(
            !observer
                .attachment()
                .negotiation
                .working_directory_projection
        );
        assert!(
            observer
                .attachment()
                .initial_snapshot
                .working_directory
                .is_none()
        );
        observer.detach().unwrap();
    }

    #[test]
    fn observer_rejects_noncontiguous_output() {
        let capabilities = vec![SCREEN_SNAPSHOT_CAPABILITY, LIVE_OUTPUT_CAPABILITY];
        let fixture = fixture(&capabilities);
        let _hello = serve(
            fixture.socket_path.clone(),
            fixture.fence.clone(),
            capabilities.iter().map(ToString::to_string).collect(),
            vec![
                FrameBody::ScreenSnapshot(snapshot(fixture.fence.clone(), 1, None)),
                FrameBody::OutputDelta(OutputDelta {
                    terminal_epoch: fixture.fence.terminal_epoch.clone(),
                    output_seq: 3,
                    bytes: b"gap".to_vec(),
                    rows: None,
                    columns: None,
                    working_directory: None,
                    execution_location: None,
                    agent_identity: None,
                }),
            ],
        );
        let mut observer = LocalSessionObserver::connect(
            &fixture.catalog,
            &SessionSelector::new("session-1", Some("workspace-1".into())),
            ObserverAttachOptions::default(),
        )
        .unwrap();

        assert!(matches!(
            observer.read_event(),
            Err(ClientError::InconsistentStream {
                reason: "output delta is not contiguous"
            })
        ));
    }

    /// A Host that announces a frame and then never finishes it.
    ///
    /// This is the shape a relay makes ordinary: the length prefix crosses the
    /// link, then the connection stalls with the payload still in flight.
    fn serve_then_stall_mid_frame(
        socket_path: std::path::PathBuf,
        fence: SessionFence,
        selected_capabilities: Vec<String>,
    ) -> thread::JoinHandle<()> {
        let listener = UnixListener::bind(socket_path).unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let codec = FrameCodec::new(FrameLimits::default());
            let FrameBody::Hello(_) = codec.read_from(&mut stream).unwrap().body else {
                panic!("client must begin with Hello");
            };
            codec
                .write_to(
                    &mut stream,
                    &WireFrame {
                        protocol_version: PROTOCOL_V1,
                        frame_id: 1,
                        body: FrameBody::HelloAck(HelloAck {
                            selected_version: PROTOCOL_V1,
                            selected_capabilities,
                            actual_fence: fence.clone(),
                            host_build_version: "host-build".into(),
                            lifecycle: LifecycleState::Observing,
                            host_process: ProcessProof {
                                process_id: 100,
                                start_marker: "host-start".into(),
                            },
                            provider_process: Some(ProcessProof {
                                process_id: 101,
                                start_marker: "provider-start".into(),
                            }),
                            earliest_retained_output_seq: 1,
                            current_output_seq: 1,
                            controller_generation: 0,
                            authorization_posture: AuthorizationPosture::StandaloneLocalOwner,
                        }),
                    },
                )
                .unwrap();
            codec
                .write_to(
                    &mut stream,
                    &WireFrame {
                        protocol_version: PROTOCOL_V1,
                        frame_id: 2,
                        body: FrameBody::ScreenSnapshot(snapshot(fence, 1, None)),
                    },
                )
                .unwrap();
            // Announce a frame, then never send its payload.
            use std::io::Write;
            stream.write_all(&4096_u32.to_be_bytes()).unwrap();
            stream.flush().unwrap();
            thread::sleep(std::time::Duration::from_secs(30));
        })
    }

    /// Evidence for the completion deadline.
    ///
    /// Before it was armed, `set_read_timeout` bounded only the wait for a
    /// frame to *begin*; once the length prefix landed the payload read had no
    /// bound at all, so this call was held hostage by the peer. The assertion
    /// that matters is therefore the **elapsed time**, not the error kind: a
    /// stalled peer that eventually dies produces the same error by way of
    /// truncation, just thirty seconds later. Without the deadline this test
    /// takes as long as the host sleeps; with it, a fifth of a second.
    ///
    /// The stream cannot be reused afterwards, and saying so is the point. The
    /// four consumed prefix bytes cannot be pushed back, so a retry would read
    /// payload as the next frame's length.
    #[test]
    fn a_frame_that_never_completes_poisons_the_stream_instead_of_hanging() {
        let capabilities = vec![SCREEN_SNAPSHOT_CAPABILITY, LIVE_OUTPUT_CAPABILITY];
        let fixture = fixture(&capabilities);
        let _host = serve_then_stall_mid_frame(
            fixture.socket_path.clone(),
            fixture.fence.clone(),
            capabilities.iter().map(ToString::to_string).collect(),
        );
        let mut observer = LocalSessionObserver::connect(
            &fixture.catalog,
            &SessionSelector::new("session-1", Some("workspace-1".into())),
            ObserverAttachOptions::default(),
        )
        .unwrap();
        observer
            .attached
            .connection
            .set_completion_timeout(Some(std::time::Duration::from_millis(200)));

        let started = std::time::Instant::now();
        let error = observer.read_event().unwrap_err();
        let elapsed = started.elapsed();

        assert!(
            matches!(error, ClientError::StreamDesynchronized { .. }),
            "expected the stream to be reported misaligned, got {error:?}"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "the deadline did not fire: the read took {elapsed:?}, which means it \
             waited for the peer to die rather than bounding the frame"
        );

        let again = observer.read_event().unwrap_err();
        assert!(
            matches!(again, ClientError::StreamDesynchronized { .. }),
            "a poisoned stream must stay refused, got {again:?}"
        );
    }

    #[test]
    fn interrupt_handle_wakes_a_blocked_observer_without_partial_frame_polling() {
        let capabilities = vec![SCREEN_SNAPSHOT_CAPABILITY, LIVE_OUTPUT_CAPABILITY];
        let fixture = fixture(&capabilities);
        let _hello = serve(
            fixture.socket_path.clone(),
            fixture.fence.clone(),
            capabilities.iter().map(ToString::to_string).collect(),
            vec![FrameBody::ScreenSnapshot(snapshot(
                fixture.fence.clone(),
                1,
                None,
            ))],
        );
        let mut observer = LocalSessionObserver::connect(
            &fixture.catalog,
            &SessionSelector::new("session-1", Some("workspace-1".into())),
            ObserverAttachOptions::default(),
        )
        .unwrap();
        let interrupt = observer.interrupt_handle().unwrap();

        interrupt.interrupt();

        assert_eq!(observer.read_event().unwrap(), None);
    }
}
