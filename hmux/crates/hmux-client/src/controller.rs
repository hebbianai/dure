use crate::connection::{ConnectionInterrupt, ConnectionOptions, LocalAttachRole, LocalConnection};
use crate::error::host_refused;
use crate::observer::{
    AgentRuntimeStateDescriptor, ObserverExit, ObserverLifecycle, OutputDeltaDescriptor,
    ProviderConversationIdentityDescriptor, ReplayGapDescriptor, ScreenSnapshotDescriptor,
    frame_kind_name, project_agent_runtime_state, project_lifecycle, project_output,
    project_provider_conversation_identity, project_replay_gap, project_session_at_snapshot,
    project_snapshot,
};
use crate::{
    AuthorizationProofReference, ClientError, LocalSession, LocalSessionCatalog, LocalWriter,
    ProtocolVersion, SessionDescriptor, SessionSelector,
};
use hmux_session_protocol::{
    AGENT_IDENTITY_PROJECTION_CAPABILITY, AGENT_RUNTIME_STATE_CAPABILITY, Detach,
    EXECUTION_LOCATION_PROJECTION_CAPABILITY, FrameBody, Input, InputReceiptState,
    MANAGED_AUTHORIZATION_GRANT_CAPABILITY, ORDERED_SNAPSHOT_REFRESH_CAPABILITY,
    OperationReceiptReason, PROVIDER_CONVERSATION_IDENTITY_CAPABILITY, Resize, ResizeReceiptState,
    ScreenSnapshotRequest, SessionFence, WORKING_DIRECTORY_PROJECTION_CAPABILITY,
};
use serde::Serialize;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static CONTROLLER_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ControllerAttachOptions {
    authorization_proof_reference: Option<AuthorizationProofReference>,
}

impl ControllerAttachOptions {
    #[must_use]
    pub fn with_authorization_proof_reference(
        mut self,
        reference: AuthorizationProofReference,
    ) -> Self {
        self.authorization_proof_reference = Some(reference);
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ControllerNegotiation {
    pub protocol_version: ProtocolVersion,
    pub selected_capabilities: Vec<String>,
    pub lifecycle: ObserverLifecycle,
    pub controller_generation: String,
    pub working_directory_projection: bool,
    pub execution_location_projection: bool,
    pub agent_identity_projection: bool,
    pub agent_runtime_state_projection: bool,
    pub provider_conversation_identity_projection: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ControllerAttachment {
    pub session: SessionDescriptor,
    pub negotiation: ControllerNegotiation,
    pub initial_snapshot: ScreenSnapshotDescriptor,
}

/// Controller state for a connection whose transport and session lookup were
/// supplied by the caller.
///
/// This is the transport-neutral half of [`LocalSessionController`]. A local
/// catalog attach adds a [`SessionDescriptor`]; an SSH relay already has its
/// remote identity from the gateway catalog and must not fabricate a local
/// endpoint or process descriptor just to reuse controller semantics.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct AttachedControllerAttachment {
    pub host_build_version: String,
    pub negotiation: ControllerNegotiation,
    pub initial_snapshot: ScreenSnapshotDescriptor,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControllerReceiptState {
    Accepted,
    WrittenToPty,
    AppliedToTerminal,
    Refused,
    Revoked,
    Failed,
    Released,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControllerReceiptReason {
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ControllerInputReceipt {
    pub request_id: String,
    pub controller_generation: String,
    pub state: ControllerReceiptState,
    pub reason: Option<ControllerReceiptReason>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ControllerResizeReceipt {
    pub request_id: String,
    pub controller_generation: String,
    pub rows: Option<u16>,
    pub columns: Option<u16>,
    pub state: ControllerReceiptState,
    pub reason: Option<ControllerReceiptReason>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum ControllerEvent {
    Output(OutputDeltaDescriptor),
    Snapshot(ScreenSnapshotDescriptor),
    AgentRuntimeState(AgentRuntimeStateDescriptor),
    ProviderConversationIdentity(ProviderConversationIdentityDescriptor),
    ReplayGap(ReplayGapDescriptor),
    InputReceipt(ControllerInputReceipt),
    ResizeReceipt(ControllerResizeReceipt),
    Exit(ObserverExit),
}

#[derive(Clone)]
pub struct ControllerMutationHandle {
    writer: LocalWriter,
    controller_generation: u64,
    fence: SessionFence,
}

impl fmt::Debug for ControllerMutationHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ControllerMutationHandle")
            .field("controller_generation", &self.controller_generation)
            .finish_non_exhaustive()
    }
}

impl ControllerMutationHandle {
    /// Binds the Host-negotiated controller generation to this connection's
    /// serialized writer. The Host remains the sole grant authority: calling
    /// this for an observer cannot manufacture write permission because every
    /// mutation is checked against the generation at Host ingress.
    #[must_use]
    pub fn from_connection(connection: &LocalConnection) -> Self {
        let ack = connection.hello_ack();
        Self {
            writer: connection.writer(),
            controller_generation: ack.controller_generation,
            fence: ack.actual_fence.clone(),
        }
    }

    pub fn send_input(&self, bytes: Vec<u8>) -> Result<String, ClientError> {
        if bytes.is_empty() {
            return Err(ClientError::transport(
                "hmux_input_empty",
                "Hmux input must not be empty",
            ));
        }
        let request_id = self.next_request_id("controller_input");
        self.writer.send(FrameBody::Input(Input {
            request_id: request_id.clone(),
            controller_generation: self.controller_generation,
            bytes,
        }))?;
        Ok(request_id)
    }

    pub fn resize(&self, rows: u16, columns: u16) -> Result<String, ClientError> {
        if rows == 0 || columns == 0 {
            return Err(ClientError::transport(
                "hmux_resize_invalid",
                "Hmux terminal dimensions must be non-zero",
            ));
        }
        let request_id = self.next_request_id("controller_resize");
        self.writer.send(FrameBody::Resize(Resize {
            request_id: request_id.clone(),
            controller_generation: self.controller_generation,
            rows,
            columns,
        }))?;
        Ok(request_id)
    }

    pub fn request_snapshot(&self) -> Result<String, ClientError> {
        let request_id = self.next_request_id("controller_snapshot");
        self.writer
            .send(FrameBody::ScreenSnapshotRequest(ScreenSnapshotRequest {
                request_id: request_id.clone(),
                expected_fence: self.fence.clone(),
                profile: None,
            }))?;
        Ok(request_id)
    }

    /// Release only this controller attachment without stopping its Host.
    pub fn detach(&self) -> Result<(), ClientError> {
        self.writer.send(FrameBody::Detach(Detach {
            reason: Some("controller_detach".into()),
        }))
    }

    fn next_request_id(&self, prefix: &str) -> String {
        next_controller_request_id(prefix)
    }
}

fn next_controller_request_id(prefix: &str) -> String {
    format!(
        "{prefix}_{}_{}",
        std::process::id(),
        CONTROLLER_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

pub struct AttachedSessionController {
    attachment: AttachedControllerAttachment,
    connection: LocalConnection,
    mutations: ControllerMutationHandle,
    working_directory_projection: bool,
    execution_location_projection: bool,
    agent_identity_projection: bool,
    agent_runtime_state_projection: bool,
    provider_conversation_identity_projection: bool,
}

pub struct LocalSessionController {
    attachment: ControllerAttachment,
    attached: AttachedSessionController,
}

pub struct ControllerInterrupt {
    inner: ConnectionInterrupt,
}

impl fmt::Debug for ControllerInterrupt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ControllerInterrupt")
            .finish_non_exhaustive()
    }
}

impl ControllerInterrupt {
    pub fn interrupt(&self) {
        self.inner.interrupt();
    }
}

impl fmt::Debug for LocalSessionController {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalSessionController")
            .field("session_id", &self.attachment.session.session_id)
            .field("workspace_id", &self.attachment.session.workspace_id)
            .field(
                "terminal_epoch",
                &self
                    .attached
                    .connection
                    .hello_ack()
                    .actual_fence
                    .terminal_epoch,
            )
            .field(
                "controller_generation",
                &self.attached.mutations.controller_generation,
            )
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for AttachedSessionController {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AttachedSessionController")
            .field(
                "terminal_epoch",
                &self.connection.hello_ack().actual_fence.terminal_epoch,
            )
            .field(
                "controller_generation",
                &self.mutations.controller_generation,
            )
            .finish_non_exhaustive()
    }
}

impl LocalSessionController {
    pub fn connect(
        catalog: &LocalSessionCatalog,
        selector: &SessionSelector,
        options: ControllerAttachOptions,
    ) -> Result<Self, ClientError> {
        let session = catalog.open(selector)?;
        Self::connect_session(
            session,
            options
                .authorization_proof_reference
                .map(authorization_proof_into_inner),
        )
    }

    /// Attach a standalone session through the same controller reducer used by
    /// broker-authorized managed and relayed controllers.
    pub fn connect_standalone(session: LocalSession) -> Result<Self, ClientError> {
        if session.descriptor().session_class != crate::SessionClass::Standalone {
            return Err(ClientError::transport(
                "hmux_session_class_mismatch",
                "standalone controller attach requires a standalone session",
            ));
        }
        Self::connect_session(session, None)
    }

    pub(crate) fn connect_session(
        session: LocalSession,
        authorization_proof_reference: Option<String>,
    ) -> Result<Self, ClientError> {
        // Managed launch-owner grants must retain their exclusive controller
        // proof. Standalone sessions prefer the Host's shared-writer contract
        // so an IDE pane can coexist with another `hmux attach` client.
        let attach_role = if authorization_proof_reference.is_some() {
            LocalAttachRole::Controller
        } else {
            session.writable_attach_role()
        };
        let connection = session.connect_with_options(
            ConnectionOptions::new(attach_role, authorization_proof_reference)
                .with_optional_capabilities(&[
                    WORKING_DIRECTORY_PROJECTION_CAPABILITY,
                    EXECUTION_LOCATION_PROJECTION_CAPABILITY,
                    AGENT_IDENTITY_PROJECTION_CAPABILITY,
                    AGENT_RUNTIME_STATE_CAPABILITY,
                    PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
                    ORDERED_SNAPSHOT_REFRESH_CAPABILITY,
                    MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
                ]),
        )?;
        let attached = AttachedSessionController::from_connection(connection)?;
        let observed_session = project_session_at_snapshot(
            session.descriptor(),
            &attached.attachment.initial_snapshot,
        );
        let attachment = ControllerAttachment {
            session: observed_session,
            negotiation: attached.attachment.negotiation.clone(),
            initial_snapshot: attached.attachment.initial_snapshot.clone(),
        };
        Ok(Self {
            attachment,
            attached,
        })
    }

    #[must_use]
    pub fn attachment(&self) -> &ControllerAttachment {
        &self.attachment
    }

    #[must_use]
    pub fn mutation_handle(&self) -> ControllerMutationHandle {
        self.attached.mutation_handle()
    }

    pub fn read_event(&mut self) -> Result<Option<ControllerEvent>, ClientError> {
        self.attached.read_event()
    }

    /// Bound the next wait for a frame to begin without changing frame
    /// completion semantics.
    pub fn set_read_timeout(&mut self, timeout: Option<Duration>) -> Result<(), ClientError> {
        self.attached.set_read_timeout(timeout)
    }

    /// Send one bounded input mutation and wait for its correlated final Host
    /// receipt. This is intended for short-lived controllers: a timeout or
    /// transport loss after the write is reported as outcome-unknown so callers
    /// cannot infer success or retry blindly.
    pub fn send_input_confirmed(
        &mut self,
        bytes: Vec<u8>,
        timeout: Duration,
    ) -> Result<ControllerInputReceipt, ClientError> {
        if bytes.is_empty() {
            return Err(ClientError::transport(
                "hmux_input_empty",
                "Hmux input must not be empty",
            ));
        }
        if timeout.is_zero() {
            return Err(ClientError::transport(
                "hmux_input_timeout_invalid",
                "Hmux input receipt timeout must be greater than zero",
            ));
        }
        let request_id = self
            .attached
            .mutations
            .send_input(bytes)
            .map_err(controller_input_outcome_unknown)?;
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(controller_input_outcome_unknown(
                    "Hmux Host did not return a final input receipt before the deadline",
                ));
            }
            self.attached
                .connection
                .set_read_timeout(Some(remaining))
                .map_err(controller_input_outcome_unknown)?;
            match self
                .read_event()
                .map_err(controller_input_outcome_unknown)?
            {
                Some(ControllerEvent::InputReceipt(receipt))
                    if receipt.request_id == request_id
                        && receipt.state != ControllerReceiptState::Accepted =>
                {
                    return Ok(receipt);
                }
                Some(ControllerEvent::Exit(_)) | None => {
                    return Err(controller_input_outcome_unknown(
                        "Hmux session ended before the final input receipt",
                    ));
                }
                Some(_) => {}
            }
        }
    }

    pub fn detach(self) -> Result<(), ClientError> {
        self.attached.detach()
    }

    pub fn interrupt_handle(&self) -> Result<ControllerInterrupt, ClientError> {
        self.attached.interrupt_handle()
    }
}

impl AttachedSessionController {
    /// Builds the high-level controller reducer over an already attached
    /// transport. The caller owns dialing and remote identity lookup; this
    /// constructor owns the single controller negotiation/event implementation.
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
        let attachment = AttachedControllerAttachment {
            host_build_version: ack.host_build_version.clone(),
            negotiation: ControllerNegotiation {
                protocol_version: ProtocolVersion {
                    major: ack.selected_version.major,
                    minor: ack.selected_version.minor,
                },
                selected_capabilities: ack.selected_capabilities.clone(),
                lifecycle: project_lifecycle(ack.lifecycle),
                controller_generation: ack.controller_generation.to_string(),
                working_directory_projection,
                execution_location_projection,
                agent_identity_projection,
                agent_runtime_state_projection,
                provider_conversation_identity_projection,
            },
            initial_snapshot: project_snapshot(
                connection.require_initial_snapshot()?.clone(),
                working_directory_projection,
                execution_location_projection,
                agent_identity_projection,
                agent_runtime_state_projection,
                provider_conversation_identity_projection,
            )?,
        };
        let mutations = ControllerMutationHandle::from_connection(&connection);
        Ok(Self {
            attachment,
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
    pub fn attachment(&self) -> &AttachedControllerAttachment {
        &self.attachment
    }

    #[must_use]
    pub fn mutation_handle(&self) -> ControllerMutationHandle {
        self.mutations.clone()
    }

    pub fn read_event(&mut self) -> Result<Option<ControllerEvent>, ClientError> {
        self.connection
            .read_body_optional()?
            .map(|body| self.project_event(body))
            .transpose()
    }

    /// Bound the next wait for a frame to begin without changing frame
    /// completion semantics.
    pub fn set_read_timeout(&mut self, timeout: Option<Duration>) -> Result<(), ClientError> {
        self.connection.set_read_timeout(timeout)
    }

    pub fn detach(mut self) -> Result<(), ClientError> {
        self.connection.detach("controller_detach")
    }

    pub fn interrupt_handle(&self) -> Result<ControllerInterrupt, ClientError> {
        self.connection
            .interrupt_handle()
            .map(|inner| ControllerInterrupt { inner })
    }

    fn project_event(&self, body: FrameBody) -> Result<ControllerEvent, ClientError> {
        match body {
            FrameBody::OutputDelta(delta) => Ok(ControllerEvent::Output(project_output(
                delta,
                self.working_directory_projection,
                self.execution_location_projection,
                self.agent_identity_projection,
            ))),
            FrameBody::ScreenSnapshot(snapshot) => Ok(ControllerEvent::Snapshot(project_snapshot(
                snapshot,
                self.working_directory_projection,
                self.execution_location_projection,
                self.agent_identity_projection,
                self.agent_runtime_state_projection,
                self.provider_conversation_identity_projection,
            )?)),
            FrameBody::AgentRuntimeState(state) if self.agent_runtime_state_projection => Ok(
                ControllerEvent::AgentRuntimeState(project_agent_runtime_state(state)?),
            ),
            FrameBody::ProviderConversationIdentity(identity)
                if self.provider_conversation_identity_projection =>
            {
                Ok(ControllerEvent::ProviderConversationIdentity(
                    project_provider_conversation_identity(identity),
                ))
            }
            FrameBody::ReplayGap(gap) => Ok(ControllerEvent::ReplayGap(project_replay_gap(gap))),
            FrameBody::InputReceipt(receipt) => {
                Ok(ControllerEvent::InputReceipt(ControllerInputReceipt {
                    request_id: receipt.request_id,
                    controller_generation: receipt.controller_generation.to_string(),
                    state: project_input_state(receipt.state),
                    reason: receipt.reason.map(project_reason),
                    detail: receipt.detail,
                }))
            }
            FrameBody::ResizeReceipt(receipt) => {
                Ok(ControllerEvent::ResizeReceipt(ControllerResizeReceipt {
                    request_id: receipt.request_id,
                    controller_generation: receipt.controller_generation.to_string(),
                    rows: receipt.rows,
                    columns: receipt.columns,
                    state: project_resize_state(receipt.state),
                    reason: receipt.reason.map(project_reason),
                }))
            }
            FrameBody::Exit(exit) => Ok(ControllerEvent::Exit(ObserverExit {
                final_output_seq: exit.final_output_seq.to_string(),
                exit_code: exit.exit_code,
                platform_status: exit.platform_status,
                reason: exit.reason,
            })),
            FrameBody::Error(error) => Err(host_refused(error)),
            other => Err(ClientError::UnexpectedFrame {
                expected: "controller update or mutation receipt",
                actual: frame_kind_name(&other),
            }),
        }
    }
}

fn authorization_proof_into_inner(reference: AuthorizationProofReference) -> String {
    // The wrapper intentionally exposes no public secret accessor. This module
    // is the only controller boundary that consumes it.
    reference.into_inner()
}

fn controller_input_outcome_unknown(error: impl fmt::Display) -> ClientError {
    ClientError::transport(
        "hmux_input_outcome_unknown",
        format!("Hmux input outcome is unknown: {error}"),
    )
}

fn project_input_state(state: InputReceiptState) -> ControllerReceiptState {
    match state {
        InputReceiptState::Accepted => ControllerReceiptState::Accepted,
        InputReceiptState::WrittenToPty => ControllerReceiptState::WrittenToPty,
        InputReceiptState::Refused => ControllerReceiptState::Refused,
        InputReceiptState::Revoked => ControllerReceiptState::Revoked,
        InputReceiptState::Failed => ControllerReceiptState::Failed,
        InputReceiptState::Released => ControllerReceiptState::Released,
    }
}

fn project_resize_state(state: ResizeReceiptState) -> ControllerReceiptState {
    match state {
        ResizeReceiptState::Accepted => ControllerReceiptState::Accepted,
        ResizeReceiptState::AppliedToTerminal => ControllerReceiptState::AppliedToTerminal,
        ResizeReceiptState::Refused => ControllerReceiptState::Refused,
        ResizeReceiptState::Revoked => ControllerReceiptState::Revoked,
        ResizeReceiptState::Failed => ControllerReceiptState::Failed,
    }
}

fn project_reason(reason: OperationReceiptReason) -> ControllerReceiptReason {
    match reason {
        OperationReceiptReason::ControllerConflict => ControllerReceiptReason::ControllerConflict,
        OperationReceiptReason::StaleControllerGeneration => {
            ControllerReceiptReason::StaleControllerGeneration
        }
        OperationReceiptReason::AuthorizationDenied => ControllerReceiptReason::AuthorizationDenied,
        OperationReceiptReason::InputTooLarge => ControllerReceiptReason::InputTooLarge,
        OperationReceiptReason::ResourceLimit => ControllerReceiptReason::ResourceLimit,
        OperationReceiptReason::PtyWriteFailed => ControllerReceiptReason::PtyWriteFailed,
        OperationReceiptReason::HostExiting => ControllerReceiptReason::HostExiting,
        OperationReceiptReason::InvalidTerminalDimensions => {
            ControllerReceiptReason::InvalidTerminalDimensions
        }
        OperationReceiptReason::PlatformResizeFailed => {
            ControllerReceiptReason::PlatformResizeFailed
        }
        OperationReceiptReason::AgentRuntimeChanged => ControllerReceiptReason::AgentRuntimeChanged,
    }
}

// Every test below stands up a real Host on a real Unix socket and attaches
// to it, so they exercise the local dialer rather than merely needing Unix.
// Without one there is nothing to dial.
#[cfg(all(test, unix, feature = "local-runtime"))]
mod tests {
    use super::*;
    use hmux_host::local_discovery::{
        ClaimLinkage, DiscoveryKey, DiscoveryRoot, HostLifetimeIdentity, LocalEndpoint,
        LocalEndpointKind, ManifestCommon, ReadyManifest, SessionClass, StartingManifest,
    };
    use hmux_session_protocol::{
        AuthorizationPosture, FrameCodec, FrameLimits, Hello, HelloAck, InputReceipt,
        LifecycleState, PROTOCOL_V1, ProcessProof, ResizeReceipt, RuntimeContext, ScreenSnapshot,
        ScreenSnapshotEncoding, SessionFence, VersionRange, WireFrame,
    };
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;
    use std::thread;
    use tempfile::TempDir;

    const CAPABILITIES: &[&str] = &[
        "screen_snapshot",
        "live_output",
        "terminal_input",
        "terminal_resize",
        hmux_session_protocol::SHARED_TERMINAL_INPUT_CAPABILITY,
        WORKING_DIRECTORY_PROJECTION_CAPABILITY,
    ];

    #[test]
    fn controller_request_ids_are_process_unique_across_connections() {
        let first = next_controller_request_id("controller_resize");
        let second = next_controller_request_id("controller_resize");

        assert_ne!(first, second);
        assert!(first.starts_with("controller_resize_"));
        assert!(second.starts_with("controller_resize_"));
    }

    struct Fixture {
        _temp: TempDir,
        catalog: LocalSessionCatalog,
        socket_path: std::path::PathBuf,
        fence: SessionFence,
    }

    fn fixture() -> Fixture {
        let temp = TempDir::new().unwrap();
        let discovery_path = temp.path().join("discovery");
        let socket_path = temp.path().join("host.sock");
        let root = DiscoveryRoot::create(&discovery_path).unwrap();
        let key = DiscoveryKey::new("workspace-1", "session-1", "standalone", 1).unwrap();
        let session = root.session(key).unwrap();
        let common = ManifestCommon {
            launch_program: None,
            schema_version: 1,
            host_build_version: "host-build".into(),
            supported_protocol: VersionRange {
                minimum: PROTOCOL_V1,
                maximum: PROTOCOL_V1,
            },
            capabilities: CAPABILITIES.iter().map(ToString::to_string).collect(),
            lifetime: HostLifetimeIdentity {
                workspace_id: "workspace-1".into(),
                session_id: "session-1".into(),
                runner_principal: "standalone".into(),
                runner_instance: "standalone".into(),
                channel_epoch: 1,
            },
            host_instance_id: "host-1".into(),
            provider_id: "shell".into(),
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
            session_name: Some("shell-1".into()),
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
        Fixture {
            _temp: temp,
            catalog: LocalSessionCatalog::new(discovery_path),
            socket_path,
            fence: SessionFence {
                workspace_id: common.lifetime.workspace_id,
                session_id: common.lifetime.session_id,
                runner_principal: common.lifetime.runner_principal,
                runner_instance: common.lifetime.runner_instance,
                channel_epoch: common.lifetime.channel_epoch,
                host_instance_id: common.host_instance_id,
                terminal_epoch: "terminal-1".into(),
            },
        }
    }

    fn serve_controller(
        socket_path: std::path::PathBuf,
        fence: SessionFence,
    ) -> mpsc::Receiver<Hello> {
        let listener = UnixListener::bind(socket_path).unwrap();
        let (hello_sender, hello_receiver) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let codec = FrameCodec::new(FrameLimits::default());
            let FrameBody::Hello(hello) = codec.read_from(&mut stream).unwrap().body else {
                panic!("controller must begin with Hello");
            };
            hello_sender.send(hello).unwrap();
            let write =
                |stream: &mut std::os::unix::net::UnixStream, frame_id: u64, body: FrameBody| {
                    codec
                        .write_to(
                            stream,
                            &WireFrame {
                                protocol_version: PROTOCOL_V1,
                                frame_id,
                                body,
                            },
                        )
                        .unwrap();
                };
            write(
                &mut stream,
                1,
                FrameBody::HelloAck(HelloAck {
                    selected_version: PROTOCOL_V1,
                    selected_capabilities: CAPABILITIES.iter().map(ToString::to_string).collect(),
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
                    current_output_seq: 9,
                    controller_generation: 7,
                    authorization_posture: AuthorizationPosture::StandaloneLocalOwner,
                }),
            );
            write(
                &mut stream,
                2,
                FrameBody::ScreenSnapshot(ScreenSnapshot {
                    fence: fence.clone(),
                    sequence_through: 9,
                    rows: 24,
                    columns: 80,
                    encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
                    controller_input_pending: None,
                    semantic_idle_ms: None,
                    repaint_bytes: b"screen".to_vec(),
                    alternate_screen: false,
                    cursor_visible: true,
                    truncated: false,
                    working_directory: None,
                    execution_location: None,
                    agent_identity: None,
                    agent_runtime_state: None,
                    provider_conversation_identity: None,
                    recovered_presentation: None,
                    actual_profile: None,
                    in_reply_to_request_id: None,
                }),
            );

            let input = codec.read_from(&mut stream).unwrap();
            let FrameBody::Input(input) = input.body else {
                panic!("controller must send input");
            };
            write(
                &mut stream,
                3,
                FrameBody::InputReceipt(InputReceipt {
                    request_id: input.request_id,
                    controller_generation: input.controller_generation,
                    state: InputReceiptState::WrittenToPty,
                    reason: None,
                    detail: None,
                }),
            );

            let resize = codec.read_from(&mut stream).unwrap();
            let FrameBody::Resize(resize) = resize.body else {
                panic!("controller must send resize");
            };
            write(
                &mut stream,
                4,
                FrameBody::ResizeReceipt(ResizeReceipt {
                    request_id: resize.request_id,
                    controller_generation: resize.controller_generation,
                    rows: Some(resize.rows),
                    columns: Some(resize.columns),
                    state: ResizeReceiptState::AppliedToTerminal,
                    reason: None,
                }),
            );

            let snapshot_request = codec.read_from(&mut stream).unwrap();
            let FrameBody::ScreenSnapshotRequest(_) = snapshot_request.body else {
                panic!("controller must request a snapshot");
            };
            write(
                &mut stream,
                5,
                FrameBody::ScreenSnapshot(ScreenSnapshot {
                    fence: fence.clone(),
                    sequence_through: 9,
                    rows: 30,
                    columns: 100,
                    encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
                    controller_input_pending: None,
                    semantic_idle_ms: None,
                    repaint_bytes: b"fresh-screen".to_vec(),
                    alternate_screen: false,
                    cursor_visible: true,
                    truncated: false,
                    working_directory: None,
                    execution_location: None,
                    agent_identity: None,
                    agent_runtime_state: None,
                    provider_conversation_identity: None,
                    recovered_presentation: None,
                    actual_profile: None,
                    in_reply_to_request_id: None,
                }),
            );

            let input = codec.read_from(&mut stream).unwrap();
            let FrameBody::Input(input) = input.body else {
                panic!("controller must send second input");
            };
            write(
                &mut stream,
                6,
                FrameBody::InputReceipt(InputReceipt {
                    request_id: input.request_id,
                    controller_generation: input.controller_generation,
                    state: InputReceiptState::Revoked,
                    reason: Some(OperationReceiptReason::StaleControllerGeneration),
                    detail: None,
                }),
            );
        });
        hello_receiver
    }

    #[test]
    fn standalone_controller_prefers_shared_writer_and_projects_mutation_receipts() {
        let fixture = fixture();
        let hello = serve_controller(fixture.socket_path.clone(), fixture.fence);
        let mut controller = LocalSessionController::connect(
            &fixture.catalog,
            &SessionSelector::new("session-1", Some("workspace-1".into())),
            ControllerAttachOptions::default(),
        )
        .unwrap();
        let observed_hello = hello.recv().unwrap();
        assert_eq!(
            observed_hello.requested_mode,
            hmux_session_protocol::AttachMode::Observer
        );
        assert!(observed_hello.requested_capabilities.iter().any(
            |capability| capability == hmux_session_protocol::SHARED_TERMINAL_INPUT_CAPABILITY
        ));
        assert_eq!(
            controller.attachment().negotiation.lifecycle,
            ObserverLifecycle::Observing
        );
        assert_eq!(
            controller.attachment().initial_snapshot.sequence_through,
            "9"
        );
        assert_eq!(controller.attachment().session.output_seq, "9");

        let input = controller
            .send_input_confirmed(b"hello".to_vec(), Duration::from_secs(1))
            .unwrap();
        assert_eq!(input.state, ControllerReceiptState::WrittenToPty);

        let mutations = controller.mutation_handle();
        let resize_id = mutations.resize(30, 100).unwrap();
        let ControllerEvent::ResizeReceipt(resize) = controller.read_event().unwrap().unwrap()
        else {
            panic!("expected resize receipt");
        };
        assert_eq!(resize.request_id, resize_id);
        assert_eq!(resize.state, ControllerReceiptState::AppliedToTerminal);

        mutations.request_snapshot().unwrap();
        let ControllerEvent::Snapshot(snapshot) = controller.read_event().unwrap().unwrap() else {
            panic!("expected current screen snapshot");
        };
        assert_eq!(snapshot.repaint_bytes, b"fresh-screen");

        let revoked_id = mutations.send_input(b"stale".to_vec()).unwrap();
        let ControllerEvent::InputReceipt(revoked) = controller.read_event().unwrap().unwrap()
        else {
            panic!("expected revoked input receipt");
        };
        assert_eq!(revoked.request_id, revoked_id);
        assert_eq!(revoked.state, ControllerReceiptState::Revoked);
        assert_eq!(
            revoked.reason,
            Some(ControllerReceiptReason::StaleControllerGeneration)
        );
    }
}
