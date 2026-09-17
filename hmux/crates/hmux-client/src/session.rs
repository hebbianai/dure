use crate::connection::{ConnectionOptions, LocalAttachRole};
use crate::error::host_refused;
use crate::{ClientError, LocalConnection, LocalSession};
use hmux_host::local_discovery::{DiscoveredSession, DiscoveryManifest, LocalEndpointKind};
use hmux_host::provider_epoch::process_session_cleanup_is_incomplete;
pub use hmux_session_protocol::discovery::SessionClass;
use hmux_session_protocol::discovery::SessionRetirementPolicy;
use hmux_session_protocol::{
    FrameBody, SESSION_RETIREMENT_ADMIN_CAPABILITY, SESSION_RETIREMENT_CAPABILITY, SessionFence,
    SessionRetirementAction, SessionRetirementReceipt, SessionRetirementRequest,
    UNPRESENTED_CREATION_ABANDON_CAPABILITY,
};
pub use hmux_session_protocol::{ProtocolVersion, VersionRange};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const SESSION_RETIREMENT_RECEIPT_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionLifecycle {
    Ready,
    Exited,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointKind {
    UnixSocket,
    WindowsNamedPipe,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProcessDescriptor {
    pub process_id: u32,
    pub start_marker: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EndpointDescriptor {
    pub kind: EndpointKind,
    pub address: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExitDescriptor {
    pub exit_code: Option<i32>,
    pub platform_status: Option<String>,
    pub reason: String,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SessionFailureDescriptor {
    pub correlation_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub terminal_epoch: String,
    pub code: String,
    pub phase: String,
    pub summary: String,
    pub exit_kind: String,
    pub exit_code: Option<i32>,
    pub occurred_unix_ms: String,
    pub retry_posture: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SessionDescriptor {
    pub schema_version: u16,
    pub session_id: String,
    pub session_name: Option<String>,
    pub workspace_id: String,
    pub session_class: SessionClass,
    pub lifecycle: SessionLifecycle,
    pub provider_id: String,
    pub runtime_host: Option<String>,
    pub worktree_alias: Option<String>,
    pub branch: Option<String>,
    /// The bare name of what this session was launched to run, when the Host
    /// recorded one. Never the arguments — see `ManifestCommon::launch_program`.
    pub launch_program: Option<String>,
    pub runner_principal: String,
    pub runner_instance: String,
    pub channel_epoch: String,
    pub host_instance_id: String,
    pub terminal_epoch: String,
    pub output_seq: String,
    pub host_build_version: String,
    pub supported_protocol: VersionRange,
    pub capabilities: Vec<String>,
    pub retirement_policy: Option<SessionRetirementPolicy>,
    pub host_process: ProcessDescriptor,
    pub provider_process: ProcessDescriptor,
    pub endpoint: EndpointDescriptor,
    pub created_unix_ms: String,
    pub lifecycle_changed_unix_ms: String,
    pub exit: Option<ExitDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<SessionFailureDescriptor>,
}

impl SessionDescriptor {
    /// Compare only the complete Host generation. Mutable lifecycle, output
    /// sequence, capabilities, and process metadata are intentionally excluded.
    #[must_use]
    pub fn same_generation(&self, other: &Self) -> bool {
        self.workspace_id == other.workspace_id
            && self.session_id == other.session_id
            && self.runner_principal == other.runner_principal
            && self.runner_instance == other.runner_instance
            && self.channel_epoch == other.channel_epoch
            && self.host_instance_id == other.host_instance_id
            && self.terminal_epoch == other.terminal_epoch
    }

    #[must_use]
    pub fn matches_fence(&self, fence: &SessionFence) -> bool {
        self.workspace_id == fence.workspace_id
            && self.session_id == fence.session_id
            && self.runner_principal == fence.runner_principal
            && self.runner_instance == fence.runner_instance
            && self.channel_epoch == fence.channel_epoch.to_string()
            && self.host_instance_id == fence.host_instance_id
            && self.terminal_epoch == fence.terminal_epoch
    }

    /// An exited provider may leave descendants behind even after its exact
    /// Host and provider generations disappear. Replacement must keep treating
    /// that tombstone as live until an operator resolves the cleanup failure.
    #[must_use]
    pub fn process_session_cleanup_incomplete(&self) -> bool {
        self.exit
            .as_ref()
            .is_some_and(|exit| process_session_cleanup_is_incomplete(&exit.reason))
    }
}

impl LocalConnection {
    /// Explicitly depart this exact attachment and let the Host apply its
    /// configured last-client grace policy. This is the only client departure
    /// that may arm retirement; `Drop`, EOF, and legacy `Detach` remain
    /// preserve-only.
    pub fn depart_gracefully(&mut self) -> Result<SessionRetirementReceipt, ClientError> {
        self.request_session_retirement(SessionRetirementAction::GracefulClientDeparture)
    }

    fn request_session_retirement(
        &mut self,
        action: SessionRetirementAction,
    ) -> Result<SessionRetirementReceipt, ClientError> {
        let departure = matches!(action, SessionRetirementAction::GracefulClientDeparture);
        if !self.supports(SESSION_RETIREMENT_CAPABILITY) {
            if departure {
                // This remains an ordinary, preserve-only Detach. In
                // particular, an older Host must never infer retirement from
                // this graceful-departure fallback.
                let _ = self.detach("graceful_departure_retirement_unsupported");
            }
            return Err(ClientError::MissingCapability {
                capability: SESSION_RETIREMENT_CAPABILITY,
            });
        }
        let request_id = next_retirement_request_id();
        let expected_fence = self.hello_ack().actual_fence.clone();
        self.writer().send(FrameBody::SessionRetirementRequest(
            SessionRetirementRequest {
                request_id: request_id.clone(),
                expected_fence,
                action,
            },
        ))?;

        let receipt_deadline = Instant::now() + SESSION_RETIREMENT_RECEIPT_TIMEOUT;
        loop {
            let remaining = receipt_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ClientError::transport(
                    "hmux_session_retirement_receipt_timeout",
                    "Hmux Host did not return a retirement receipt before the deadline",
                ));
            }
            self.set_read_timeout(Some(remaining))?;
            self.set_completion_timeout(Some(remaining));
            match self.read_body()? {
                FrameBody::SessionRetirementReceipt(receipt)
                    if receipt.request_id == request_id =>
                {
                    if departure {
                        // Do not follow a typed departure with legacy Detach:
                        // the Host has already committed the explicit intent.
                        self.shutdown();
                    }
                    return Ok(receipt);
                }
                FrameBody::SessionRetirementReceipt(_) => {
                    return Err(ClientError::transport(
                        "hmux_session_retirement_receipt_uncorrelated",
                        "Hmux Host returned a retirement receipt for another request",
                    ));
                }
                FrameBody::OutputDelta(_)
                | FrameBody::ScreenSnapshot(_)
                | FrameBody::AgentRuntimeState(_)
                | FrameBody::ProviderConversationIdentity(_) => {}
                FrameBody::Exit(_) => {
                    return Err(ClientError::transport(
                        "hmux_session_retirement_exited",
                        "Hmux session exited before the retirement receipt arrived",
                    ));
                }
                FrameBody::Error(error) => return Err(host_refused(error)),
                _ => {}
            }
        }
    }
}

impl LocalSession {
    pub fn abandon_unpresented_creation(
        &self,
        launch_owner_proof: String,
    ) -> Result<SessionRetirementReceipt, ClientError> {
        self.ensure_retirement_session()?;
        let mut connection = self.connect_with_options(
            ConnectionOptions::new(LocalAttachRole::Controller, Some(launch_owner_proof))
                .with_optional_capabilities(&[
                    SESSION_RETIREMENT_CAPABILITY,
                    UNPRESENTED_CREATION_ABANDON_CAPABILITY,
                ]),
        )?;
        if !connection.supports(UNPRESENTED_CREATION_ABANDON_CAPABILITY) {
            connection.shutdown();
            return Err(ClientError::MissingCapability {
                capability: UNPRESENTED_CREATION_ABANDON_CAPABILITY,
            });
        }
        let result = connection
            .request_session_retirement(SessionRetirementAction::AbandonUnpresentedCreationV1);
        connection.shutdown();
        result
    }

    /// Replace this standalone session's durable retirement policy. `None`
    /// restores the compatibility default: retain until an explicit stop.
    pub fn configure_retirement_policy(
        &self,
        policy: Option<SessionRetirementPolicy>,
    ) -> Result<SessionRetirementReceipt, ClientError> {
        self.with_retirement_connection(|connection| {
            connection.request_session_retirement(SessionRetirementAction::Configure { policy })
        })
    }

    /// Inspect whether the session is currently eligible for retirement
    /// without changing its policy, provider, or any existing attachment.
    pub fn preview_retirement_sweep(&self) -> Result<SessionRetirementReceipt, ClientError> {
        self.with_retirement_connection(|connection| {
            connection.request_session_retirement(SessionRetirementAction::Sweep { apply: false })
        })
    }

    /// Re-evaluate the configured policy and apply an eligible retirement.
    pub fn apply_retirement_sweep(&self) -> Result<SessionRetirementReceipt, ClientError> {
        self.with_retirement_connection(|connection| {
            connection.request_session_retirement(SessionRetirementAction::Sweep { apply: true })
        })
    }

    /// Open a one-shot attachment and explicitly depart it. Long-lived clients
    /// should instead call [`LocalConnection::depart_gracefully`] on the exact
    /// attachment they are closing.
    pub fn depart_gracefully(&self) -> Result<SessionRetirementReceipt, ClientError> {
        self.ensure_retirement_session()?;
        let mut connection = self.connect_with_options(
            ConnectionOptions::new(LocalAttachRole::Observer, None)
                .with_optional_capabilities(&[SESSION_RETIREMENT_CAPABILITY]),
        )?;
        connection.depart_gracefully()
    }

    fn with_retirement_connection<F>(
        &self,
        operation: F,
    ) -> Result<SessionRetirementReceipt, ClientError>
    where
        F: FnOnce(&mut LocalConnection) -> Result<SessionRetirementReceipt, ClientError>,
    {
        self.ensure_retirement_session()?;
        let mut connection = self.connect_with_options(
            ConnectionOptions::new(LocalAttachRole::Observer, None).with_optional_capabilities(&[
                SESSION_RETIREMENT_CAPABILITY,
                SESSION_RETIREMENT_ADMIN_CAPABILITY,
            ]),
        )?;
        if !connection.supports(SESSION_RETIREMENT_ADMIN_CAPABILITY) {
            let _ = connection.detach("session_retirement_admin_unsupported");
            return Err(ClientError::MissingCapability {
                capability: SESSION_RETIREMENT_ADMIN_CAPABILITY,
            });
        }
        let result = operation(&mut connection);
        let _ = connection.detach("session_retirement_request_complete");
        result
    }

    fn ensure_retirement_session(&self) -> Result<(), ClientError> {
        if self.descriptor().session_class != SessionClass::Standalone {
            return Err(ClientError::transport(
                "hmux_session_retirement_managed",
                "managed Hmux sessions do not accept standalone retirement policy",
            ));
        }
        if self.descriptor().lifecycle != SessionLifecycle::Ready {
            return Err(ClientError::transport(
                "hmux_session_retirement_exited",
                "exited Hmux sessions cannot change or exercise retirement policy",
            ));
        }
        Ok(())
    }
}

fn next_retirement_request_id() -> String {
    static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
    format!(
        "session_retirement_{}_{}",
        std::process::id(),
        REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSelector {
    pub session_id: String,
    pub workspace_id: Option<String>,
}

impl SessionSelector {
    #[must_use]
    pub fn new(session_id: impl Into<String>, workspace_id: Option<String>) -> Self {
        Self {
            session_id: session_id.into(),
            workspace_id,
        }
    }
}

impl From<DiscoveredSession> for SessionDescriptor {
    fn from(discovered: DiscoveredSession) -> Self {
        let common = discovered.manifest.common();
        let supported_protocol = common.supported_protocol;
        let host_process = ProcessDescriptor {
            process_id: common.host_process.process_id,
            start_marker: common.host_process.start_marker.clone(),
        };
        let session_class = common.session_class;
        let base = SessionBase {
            schema_version: common.schema_version,
            session_id: common.lifetime.session_id.clone(),
            session_name: common.session_name.clone(),
            workspace_id: common.lifetime.workspace_id.clone(),
            session_class,
            provider_id: common.provider_id.clone(),
            runtime_host: common.runtime_context.runtime_host.clone(),
            worktree_alias: common.runtime_context.worktree_alias.clone(),
            branch: common.runtime_context.branch.clone(),
            launch_program: common.launch_program.clone(),
            runner_principal: common.lifetime.runner_principal.clone(),
            runner_instance: common.lifetime.runner_instance.clone(),
            channel_epoch: common.lifetime.channel_epoch.to_string(),
            host_instance_id: common.host_instance_id.clone(),
            host_build_version: common.host_build_version.clone(),
            supported_protocol,
            capabilities: common.capabilities.clone(),
            retirement_policy: common.retirement_policy,
            host_process,
            created_unix_ms: common.created_unix_ms.to_string(),
        };

        match discovered.manifest {
            DiscoveryManifest::Ready(manifest) => base.finish(
                SessionLifecycle::Ready,
                manifest.terminal_epoch,
                manifest.ready_output_seq,
                manifest.provider_process,
                manifest.endpoint.kind,
                manifest.endpoint.address,
                manifest.ready_unix_ms,
                None,
                None,
            ),
            DiscoveryManifest::Exited(manifest) => {
                let tombstone = manifest.tombstone;
                let failure = tombstone.failure.map(|failure| SessionFailureDescriptor {
                    correlation_id: failure.correlation_id,
                    session_id: failure.session_id,
                    workspace_id: failure.workspace_id,
                    terminal_epoch: failure.terminal_epoch,
                    code: failure.code,
                    phase: match failure.phase {
                        hmux_host::provider_epoch::SessionFailurePhase::ConversationIdentity => {
                            "conversation_identity"
                        }
                        hmux_host::provider_epoch::SessionFailurePhase::ProviderRuntime => {
                            "provider_runtime"
                        }
                    }
                    .to_string(),
                    summary: failure.summary,
                    exit_kind: failure.exit_kind.as_str().to_string(),
                    exit_code: failure.exit_code,
                    occurred_unix_ms: failure.occurred_unix_ms.to_string(),
                    retry_posture: match failure.retry_posture {
                        hmux_host::provider_epoch::SessionFailureRetryPosture::Never => "never",
                    }
                    .to_string(),
                });
                let exit = ExitDescriptor {
                    exit_code: tombstone.exit.exit_code,
                    platform_status: tombstone.exit.platform_status,
                    reason: tombstone.exit.reason,
                    kind: format!("{:?}", tombstone.exit_kind).to_lowercase(),
                };
                base.finish(
                    SessionLifecycle::Exited,
                    tombstone.fence.terminal_epoch,
                    tombstone.exit.final_output_seq,
                    tombstone.provider_process,
                    manifest.endpoint.kind,
                    manifest.endpoint.address,
                    manifest.exited_unix_ms,
                    Some(exit),
                    failure,
                )
            }
            DiscoveryManifest::Starting(_) => {
                unreachable!("discovery census never returns starting manifests")
            }
        }
    }
}

struct SessionBase {
    schema_version: u16,
    session_id: String,
    session_name: Option<String>,
    workspace_id: String,
    session_class: SessionClass,
    provider_id: String,
    runtime_host: Option<String>,
    worktree_alias: Option<String>,
    branch: Option<String>,
    launch_program: Option<String>,
    runner_principal: String,
    runner_instance: String,
    channel_epoch: String,
    host_instance_id: String,
    host_build_version: String,
    supported_protocol: VersionRange,
    capabilities: Vec<String>,
    retirement_policy: Option<SessionRetirementPolicy>,
    host_process: ProcessDescriptor,
    created_unix_ms: String,
}

impl SessionBase {
    #[allow(clippy::too_many_arguments)]
    fn finish(
        self,
        lifecycle: SessionLifecycle,
        terminal_epoch: String,
        output_seq: u64,
        provider_process: hmux_session_protocol::ProcessProof,
        endpoint_kind: LocalEndpointKind,
        endpoint_address: String,
        lifecycle_changed_unix_ms: u64,
        exit: Option<ExitDescriptor>,
        failure: Option<SessionFailureDescriptor>,
    ) -> SessionDescriptor {
        SessionDescriptor {
            schema_version: self.schema_version,
            session_id: self.session_id,
            session_name: self.session_name,
            workspace_id: self.workspace_id,
            session_class: self.session_class,
            lifecycle,
            provider_id: self.provider_id,
            runtime_host: self.runtime_host,
            worktree_alias: self.worktree_alias,
            branch: self.branch,
            launch_program: self.launch_program,
            runner_principal: self.runner_principal,
            runner_instance: self.runner_instance,
            channel_epoch: self.channel_epoch,
            host_instance_id: self.host_instance_id,
            terminal_epoch,
            output_seq: output_seq.to_string(),
            host_build_version: self.host_build_version,
            supported_protocol: self.supported_protocol,
            capabilities: self.capabilities,
            retirement_policy: self.retirement_policy,
            host_process: self.host_process,
            provider_process: ProcessDescriptor {
                process_id: provider_process.process_id,
                start_marker: provider_process.start_marker,
            },
            endpoint: EndpointDescriptor {
                kind: match endpoint_kind {
                    LocalEndpointKind::UnixSocket => EndpointKind::UnixSocket,
                    LocalEndpointKind::WindowsNamedPipe => EndpointKind::WindowsNamedPipe,
                },
                address: endpoint_address,
            },
            created_unix_ms: self.created_unix_ms,
            lifecycle_changed_unix_ms: lifecycle_changed_unix_ms.to_string(),
            exit,
            failure,
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use hmux_host::local_discovery::{
        ClaimLinkage, HostLifetimeIdentity, LocalEndpoint, ManifestCommon, ReadyManifest,
    };
    use hmux_session_protocol::{
        AuthorizationPosture, FrameCodec, FrameLimits, HelloAck, LifecycleState, PROTOCOL_V1,
        ProcessProof, RuntimeContext, ScreenSnapshot, ScreenSnapshotEncoding,
        SessionRetirementReceiptState, VersionRange, WireFrame,
    };
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;
    use std::sync::mpsc;
    use std::thread;
    use tempfile::TempDir;

    #[derive(Debug)]
    enum Cleanup {
        LegacyDetach,
        Eof,
        Other,
    }

    struct ServerObservation {
        request: Option<SessionRetirementRequest>,
        cleanup: Cleanup,
    }

    fn fence() -> SessionFence {
        SessionFence {
            workspace_id: "workspace".into(),
            session_id: "session".into(),
            runner_principal: "local-user".into(),
            runner_instance: "runner".into(),
            channel_epoch: 1,
            host_instance_id: "host".into(),
            terminal_epoch: "terminal".into(),
        }
    }

    fn session(socket_path: &Path, retirement_capability: bool) -> LocalSession {
        let fence = fence();
        let mut capabilities = vec!["screen_snapshot".into(), "live_output".into()];
        if retirement_capability {
            capabilities.push(SESSION_RETIREMENT_CAPABILITY.into());
            capabilities.push(SESSION_RETIREMENT_ADMIN_CAPABILITY.into());
        }
        LocalSession::from_manifest(DiscoveryManifest::Ready(ReadyManifest {
            common: ManifestCommon {
                launch_program: None,
                schema_version: 1,
                host_build_version: "test".into(),
                supported_protocol: VersionRange {
                    minimum: PROTOCOL_V1,
                    maximum: PROTOCOL_V1,
                },
                capabilities,
                lifetime: HostLifetimeIdentity {
                    workspace_id: fence.workspace_id,
                    session_id: fence.session_id,
                    runner_principal: fence.runner_principal,
                    runner_instance: fence.runner_instance,
                    channel_epoch: fence.channel_epoch,
                },
                host_instance_id: fence.host_instance_id,
                provider_id: "shell".into(),
                runtime_context: RuntimeContext::default(),
                claim_linkage: ClaimLinkage {
                    claim_id: None,
                    kickoff_action_id: None,
                },
                host_process: ProcessProof {
                    process_id: 10,
                    start_marker: "host-start".into(),
                },
                created_unix_ms: 1,
                session_class: SessionClass::Standalone,
                session_name: Some("fixture".into()),
                retirement_policy: None,
            },
            provider_process: ProcessProof {
                process_id: 11,
                start_marker: "provider-start".into(),
            },
            terminal_epoch: "terminal".into(),
            ready_output_seq: 1,
            endpoint: LocalEndpoint {
                kind: LocalEndpointKind::UnixSocket,
                address: socket_path.to_string_lossy().into_owned(),
            },
            capability_token: "secret".into(),
            ready_unix_ms: 2,
        }))
        .expect("fixture manifest must be valid")
    }

    fn snapshot(fence: SessionFence) -> ScreenSnapshot {
        ScreenSnapshot {
            fence,
            sequence_through: 1,
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
        }
    }

    fn write_frame(stream: &mut UnixStream, frame_id: u64, body: FrameBody) {
        FrameCodec::new(FrameLimits::default())
            .write_to(
                stream,
                &WireFrame {
                    protocol_version: PROTOCOL_V1,
                    frame_id,
                    body,
                },
            )
            .expect("fixture frame must write");
    }

    fn serve(
        listener: UnixListener,
        retirement_capability: bool,
        expect_admin_capability: bool,
        receipt_state: Option<SessionRetirementReceiptState>,
    ) -> mpsc::Receiver<ServerObservation> {
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("fixture client must connect");
            let codec = FrameCodec::new(FrameLimits::default());
            let hello = codec
                .read_from(&mut stream)
                .expect("fixture must read Hello");
            let FrameBody::Hello(hello) = hello.body else {
                panic!("client must begin with Hello");
            };
            assert_eq!(hello.expected_fence, fence());
            assert!(
                hello
                    .requested_capabilities
                    .iter()
                    .any(|capability| capability == SESSION_RETIREMENT_CAPABILITY)
            );
            assert_eq!(
                hello
                    .requested_capabilities
                    .iter()
                    .any(|capability| capability == SESSION_RETIREMENT_ADMIN_CAPABILITY),
                expect_admin_capability
            );
            let mut capabilities = vec!["screen_snapshot".into(), "live_output".into()];
            if retirement_capability {
                capabilities.push(SESSION_RETIREMENT_CAPABILITY.into());
                capabilities.push(SESSION_RETIREMENT_ADMIN_CAPABILITY.into());
            }
            write_frame(
                &mut stream,
                1,
                FrameBody::HelloAck(HelloAck {
                    selected_version: PROTOCOL_V1,
                    selected_capabilities: capabilities,
                    actual_fence: fence(),
                    host_build_version: "test".into(),
                    lifecycle: LifecycleState::Observing,
                    host_process: ProcessProof {
                        process_id: 10,
                        start_marker: "host-start".into(),
                    },
                    provider_process: Some(ProcessProof {
                        process_id: 11,
                        start_marker: "provider-start".into(),
                    }),
                    earliest_retained_output_seq: 1,
                    current_output_seq: 1,
                    controller_generation: 1,
                    authorization_posture: AuthorizationPosture::StandaloneLocalOwner,
                }),
            );
            write_frame(&mut stream, 2, FrameBody::ScreenSnapshot(snapshot(fence())));

            let next = codec.read_from(&mut stream);
            let (request, cleanup) = match next {
                Ok(frame) => match frame.body {
                    FrameBody::SessionRetirementRequest(request) => {
                        let state = receipt_state.expect("supported fixture must return a receipt");
                        let policy = match request.action {
                            SessionRetirementAction::Configure { policy } => policy,
                            _ => None,
                        };
                        write_frame(
                            &mut stream,
                            3,
                            FrameBody::SessionRetirementReceipt(SessionRetirementReceipt {
                                request_id: request.request_id.clone(),
                                state,
                                reason: None,
                                policy,
                            }),
                        );
                        let cleanup = match codec.read_from(&mut stream) {
                            Ok(frame) if matches!(frame.body, FrameBody::Detach(_)) => {
                                Cleanup::LegacyDetach
                            }
                            Ok(_) => Cleanup::Other,
                            Err(_) => Cleanup::Eof,
                        };
                        (Some(request), cleanup)
                    }
                    FrameBody::Detach(_) => (None, Cleanup::LegacyDetach),
                    _ => (None, Cleanup::Other),
                },
                Err(_) => (None, Cleanup::Eof),
            };
            sender
                .send(ServerObservation { request, cleanup })
                .expect("test must receive server observation");
        });
        receiver
    }

    fn fixture(
        retirement_capability: bool,
        expect_admin_capability: bool,
        receipt_state: Option<SessionRetirementReceiptState>,
    ) -> (TempDir, LocalSession, mpsc::Receiver<ServerObservation>) {
        let temp = tempfile::tempdir().expect("fixture root must exist");
        let socket_path = temp.path().join("host.sock");
        let listener = UnixListener::bind(&socket_path).expect("fixture socket must bind");
        let receiver = serve(
            listener,
            retirement_capability,
            expect_admin_capability,
            receipt_state,
        );
        let session = session(&socket_path, retirement_capability);
        (temp, session, receiver)
    }

    fn observation(receiver: mpsc::Receiver<ServerObservation>) -> ServerObservation {
        receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("fixture server must complete")
    }

    #[test]
    fn descriptor_without_failure_remains_additively_compatible() {
        let temp = tempfile::tempdir().expect("fixture root must exist");
        let descriptor = session(&temp.path().join("host.sock"), false)
            .descriptor()
            .clone();
        let encoded = serde_json::to_value(descriptor).expect("descriptor must serialize");
        assert!(encoded.get("failure").is_none());

        let decoded: SessionDescriptor =
            serde_json::from_value(encoded).expect("legacy descriptor must deserialize");
        assert!(decoded.failure.is_none());
    }

    #[test]
    fn configure_uses_negotiated_capability_exact_fence_and_correlated_receipt() {
        let (_temp, session, receiver) = fixture(
            true,
            true,
            Some(SessionRetirementReceiptState::PolicyUpdated),
        );
        let policy = SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
            grace_period_ms: 2_000,
        };

        let receipt = session
            .configure_retirement_policy(Some(policy))
            .expect("configuration must receive its receipt");
        let observed = observation(receiver);
        let request = observed.request.expect("Host must receive typed request");

        assert_eq!(request.expected_fence, fence());
        assert!(request.request_id.starts_with("session_retirement_"));
        assert_eq!(request.request_id, receipt.request_id);
        assert_eq!(
            request.action,
            SessionRetirementAction::Configure {
                policy: Some(policy)
            }
        );
        assert!(matches!(observed.cleanup, Cleanup::LegacyDetach));
    }

    #[test]
    fn sweep_wrappers_preserve_dry_run_default_and_explicit_apply() {
        for (apply, state) in [
            (false, SessionRetirementReceiptState::Eligible),
            (true, SessionRetirementReceiptState::RetirementArmed),
        ] {
            let (_temp, session, receiver) = fixture(true, true, Some(state));
            let receipt = if apply {
                session.apply_retirement_sweep()
            } else {
                session.preview_retirement_sweep()
            }
            .expect("sweep must receive its receipt");
            let observed = observation(receiver);
            let request = observed.request.expect("Host must receive typed request");

            assert_eq!(request.request_id, receipt.request_id);
            assert_eq!(request.action, SessionRetirementAction::Sweep { apply });
            assert!(matches!(observed.cleanup, Cleanup::LegacyDetach));
        }
    }

    #[test]
    fn graceful_departure_never_follows_typed_intent_with_legacy_detach() {
        let (_temp, session, receiver) = fixture(
            true,
            false,
            Some(SessionRetirementReceiptState::RetirementArmed),
        );
        let mut connection = session
            .connect_with_options(
                ConnectionOptions::new(LocalAttachRole::Observer, None)
                    .with_optional_capabilities(&[SESSION_RETIREMENT_CAPABILITY]),
            )
            .expect("fixture must attach");

        connection
            .depart_gracefully()
            .expect("graceful departure must receive its receipt");
        let observed = observation(receiver);

        assert!(matches!(
            observed.request.map(|request| request.action),
            Some(SessionRetirementAction::GracefulClientDeparture)
        ));
        assert!(matches!(observed.cleanup, Cleanup::Eof));
    }

    #[test]
    fn missing_capability_uses_only_preserve_detach_and_reports_unsupported() {
        let (_temp, session, receiver) = fixture(false, true, None);

        let error = session
            .apply_retirement_sweep()
            .expect_err("legacy Host must not receive a retirement request");
        let observed = observation(receiver);

        assert!(matches!(
            error,
            ClientError::MissingCapability {
                capability: SESSION_RETIREMENT_ADMIN_CAPABILITY
            }
        ));
        assert!(observed.request.is_none());
        assert!(matches!(observed.cleanup, Cleanup::LegacyDetach));
    }

    #[test]
    fn legacy_host_graceful_departure_falls_back_to_preserve_detach() {
        let (_temp, session, receiver) = fixture(false, false, None);
        let mut connection = session
            .connect_with_options(
                ConnectionOptions::new(LocalAttachRole::Observer, None)
                    .with_optional_capabilities(&[SESSION_RETIREMENT_CAPABILITY]),
            )
            .expect("fixture must attach");

        let error = connection
            .depart_gracefully()
            .expect_err("legacy Host cannot accept typed departure");
        let observed = observation(receiver);

        assert!(matches!(
            error,
            ClientError::MissingCapability {
                capability: SESSION_RETIREMENT_CAPABILITY
            }
        ));
        assert!(observed.request.is_none());
        assert!(matches!(observed.cleanup, Cleanup::LegacyDetach));
    }
}
