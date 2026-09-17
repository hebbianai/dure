use crate::runtime_broker::RuntimeBroker;
use crate::{
    ClientError, LocalSession, LocalSessionCatalog, LocalSessionController, SessionClass,
    SessionLifecycle, SessionSelector,
};
use hmux_runtime_contract::{
    MANAGED_ATTACH_BROKER_SUBCOMMAND, ManagedAttachBrokerResponse, ManagedAttachDecision,
    ManagedAttachFinalization, ManagedAttachReceipt, ManagedAttachRequest,
};
use std::fmt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

/// Resolve one managed session across the catalog's canonical and bounded
/// read-only roots while keeping its capability token inside hmux-client.
#[doc(hidden)]
pub fn prepare_managed_attach_receipt(
    catalog: &LocalSessionCatalog,
    request: &ManagedAttachRequest,
) -> Result<ManagedAttachReceipt, ClientError> {
    request.validate().map_err(protocol_error)?;
    let session = catalog.open(&SessionSelector::new(
        request.session_id(),
        Some(request.workspace_id().to_string()),
    ))?;
    let descriptor = session.descriptor();
    if descriptor.session_class != SessionClass::Managed
        || descriptor.lifecycle != SessionLifecycle::Ready
    {
        return Err(protocol_error("managed session is not ready"));
    }
    let authorization_proof_reference = session.managed_attach_authorization_proof()?;
    static TRANSACTION_SEQUENCE: AtomicU64 = AtomicU64::new(1);
    ManagedAttachReceipt::new(
        format!(
            "attach_{}_{}",
            std::process::id(),
            TRANSACTION_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ),
        request.session_id(),
        request.workspace_id(),
        session.manifest().clone(),
        authorization_proof_reference,
    )
    .map_err(protocol_error)
}

#[derive(Clone, Debug)]
pub struct ManagedSessionAttacher {
    runtime_executable: PathBuf,
    runtime_working_directory: PathBuf,
    discovery_root: Option<PathBuf>,
}

impl ManagedSessionAttacher {
    #[must_use]
    pub fn new(
        runtime_executable: impl Into<PathBuf>,
        runtime_working_directory: impl Into<PathBuf>,
    ) -> Self {
        Self {
            runtime_executable: runtime_executable.into(),
            runtime_working_directory: runtime_working_directory.into(),
            discovery_root: None,
        }
    }

    #[must_use]
    pub fn with_discovery_root(mut self, discovery_root: impl Into<PathBuf>) -> Self {
        self.discovery_root = Some(discovery_root.into());
        self
    }

    pub fn attach(
        &self,
        request: ManagedAttachRequest,
    ) -> Result<LocalSessionController, ClientError> {
        self.with_prepared_receipt(request, connect_prepared_controller)
    }

    /// Run the private managed broker to mint the adapter authorization proof
    /// for the current Host generation, hand the prepared receipt to
    /// `use_receipt`, and finalize the grant transaction (commit on success,
    /// abort on failure). The proof stays inside this crate boundary; product
    /// callers only ever see the operation result.
    pub(crate) fn with_prepared_receipt<T>(
        &self,
        request: ManagedAttachRequest,
        use_receipt: impl FnOnce(ManagedAttachReceipt) -> Result<T, ClientError>,
    ) -> Result<T, ClientError> {
        request.validate().map_err(protocol_error)?;
        self.validate_runtime_context()?;

        let mut command = Command::new(&self.runtime_executable);
        command
            .arg("--no-autostart")
            .arg(MANAGED_ATTACH_BROKER_SUBCOMMAND)
            .current_dir(&self.runtime_working_directory);
        if let Some(discovery_root) = &self.discovery_root {
            command.env(crate::DISCOVERY_ROOT_ENV, discovery_root);
        }
        let mut broker = RuntimeBroker::<ManagedAttachBrokerResponse>::spawn(
            &mut command,
            "managed Hmux attach",
            "hmux_managed_runtime_failed",
        )?;
        broker.write(&request)?;
        let response = broker.read_response()?;
        let receipt = match response {
            ManagedAttachBrokerResponse::Prepared(receipt) => *receipt,
            ManagedAttachBrokerResponse::Refused(failure) => {
                broker.close_input();
                broker.finish()?;
                return Err(ClientError::transport(
                    "hmux_managed_attach_refused",
                    format!("{}: {}", failure.code, failure.message),
                ));
            }
        };

        if let Err(error) = receipt.validate() {
            broker.close_input();
            let _ = broker.finish();
            return Err(protocol_error(error));
        }
        let transaction_id = receipt.transaction_id().to_string();
        let attach_result =
            validate_receipt_identity(&request, &receipt).and_then(|()| use_receipt(receipt));
        let decision = if attach_result.is_ok() {
            ManagedAttachDecision::Commit
        } else {
            ManagedAttachDecision::Abort
        };
        let finalization = match decision {
            ManagedAttachDecision::Commit => ManagedAttachFinalization::commit(&transaction_id),
            ManagedAttachDecision::Abort => ManagedAttachFinalization::abort(&transaction_id),
        }
        .map_err(protocol_error)?;
        let finalization_result = broker.write(&finalization).and_then(|()| {
            broker.close_input();
            broker.finish()
        });

        match (attach_result, finalization_result) {
            (Ok(controller), Ok(())) => Ok(controller),
            (Err(attach), Ok(())) => Err(attach),
            (Ok(_), Err(finalization)) => Err(finalization),
            (Err(attach), Err(finalization)) => Err(ClientError::transport(
                "hmux_managed_attach_transaction_failed",
                format!(
                    "managed Hmux attach failed: {attach}; grant abort also failed: {finalization}"
                ),
            )),
        }
    }

    fn validate_runtime_context(&self) -> Result<(), ClientError> {
        if self.runtime_executable.as_os_str().is_empty() {
            return Err(runtime_error("managed Hmux runtime path is empty"));
        }
        if !self.runtime_working_directory.is_absolute() || !self.runtime_working_directory.is_dir()
        {
            return Err(runtime_error(
                "managed Hmux runtime working directory must be an existing absolute directory",
            ));
        }
        Ok(())
    }
}

fn validate_receipt_identity(
    request: &ManagedAttachRequest,
    receipt: &ManagedAttachReceipt,
) -> Result<(), ClientError> {
    if receipt.session_id() != request.session_id()
        || receipt.workspace_id() != request.workspace_id()
    {
        return Err(protocol_error(
            "managed attach receipt does not match the requested session",
        ));
    }
    Ok(())
}

fn connect_prepared_controller(
    receipt: ManagedAttachReceipt,
) -> Result<LocalSessionController, ClientError> {
    let proof = receipt.authorization_proof_reference().to_string();
    let session = LocalSession::from_manifest(receipt.manifest().clone())?;
    let descriptor = session.descriptor();
    if descriptor.session_class != SessionClass::Managed
        || descriptor.session_id != receipt.session_id()
        || descriptor.workspace_id != receipt.workspace_id()
    {
        return Err(protocol_error(
            "managed attach receipt does not match Hmux manifest identity",
        ));
    }
    LocalSessionController::connect_session(session, Some(proof))
}

fn protocol_error(error: impl fmt::Display) -> ClientError {
    ClientError::transport("hmux_managed_attach_protocol", error.to_string())
}

fn runtime_error(error: impl fmt::Display) -> ClientError {
    ClientError::transport("hmux_managed_runtime_failed", error.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use hmux_host::local_discovery::{
        ClaimLinkage, DiscoveryManifest, HostLifetimeIdentity, LocalEndpoint, LocalEndpointKind,
        ManifestCommon, ReadyManifest, SessionClass,
    };
    use hmux_runtime_contract::{
        ManagedAttachBrokerResponse, ManagedAttachDecision, ManagedAttachReceipt,
        read_managed_attach_finalization, read_managed_attach_request,
        write_managed_attach_response,
    };
    use hmux_session_protocol::{
        AuthorizationPosture, FrameBody, FrameCodec, FrameLimits, Hello, HelloAck, InputReceipt,
        InputReceiptState, LifecycleState, PROTOCOL_V1, ProcessProof, RuntimeContext,
        ScreenSnapshot, ScreenSnapshotEncoding, SessionFence, VersionRange, WireFrame,
    };
    use std::io::Cursor;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    const CAPABILITIES: &[&str] = &[
        "screen_snapshot",
        "live_output",
        "terminal_input",
        "terminal_resize",
    ];

    #[test]
    fn commits_grant_only_after_controller_hello_ack() {
        let temp = tempfile::tempdir().unwrap();
        let socket_path = temp.path().join("host.sock");
        let manifest = managed_manifest(&socket_path);
        let (hello, host) = serve_controller(socket_path, fence(&manifest));
        let runtime = fake_runtime(
            temp.path(),
            ManagedAttachBrokerResponse::prepared(
                ManagedAttachReceipt::new(
                    "transaction-1",
                    "session-1",
                    "workspace-1",
                    manifest,
                    "reservation-1",
                )
                .unwrap(),
            ),
        );

        let controller = ManagedSessionAttacher::new(runtime, temp.path())
            .attach(ManagedAttachRequest::new("session-1", "workspace-1").unwrap())
            .unwrap();

        let hello = hello.recv().unwrap();
        assert_eq!(
            hello.authorization_proof_reference.as_deref(),
            Some("reservation-1")
        );
        assert_eq!(hello.capability_token, "capability-secret");
        assert_eq!(
            captured_finalization(temp.path(), "transaction-1").decision(),
            ManagedAttachDecision::Commit
        );
        drop(controller);
        host.join().unwrap();
    }

    #[test]
    fn aborts_grant_when_controller_connection_fails() {
        let temp = tempfile::tempdir().unwrap();
        let manifest = managed_manifest(&temp.path().join("missing.sock"));
        let runtime = fake_runtime(
            temp.path(),
            ManagedAttachBrokerResponse::prepared(
                ManagedAttachReceipt::new(
                    "transaction-2",
                    "session-1",
                    "workspace-1",
                    manifest,
                    "reservation-2",
                )
                .unwrap(),
            ),
        );

        let error = ManagedSessionAttacher::new(runtime, temp.path())
            .attach(ManagedAttachRequest::new("session-1", "workspace-1").unwrap())
            .unwrap_err();

        assert_eq!(error.code(), "hmux_endpoint_unavailable");
        assert_eq!(
            captured_finalization(temp.path(), "transaction-2").decision(),
            ManagedAttachDecision::Abort
        );
    }

    #[test]
    fn brokered_managed_controller_confirms_input_without_a_product_daemon() {
        let temp = tempfile::tempdir().unwrap();
        let socket_path = temp.path().join("host.sock");
        let manifest = managed_manifest(&socket_path);
        let (_hello, host) = serve_controller(socket_path, fence(&manifest));
        let runtime = fake_runtime(
            temp.path(),
            ManagedAttachBrokerResponse::prepared(
                ManagedAttachReceipt::new(
                    "transaction-input",
                    "session-1",
                    "workspace-1",
                    manifest,
                    "reservation-input",
                )
                .unwrap(),
            ),
        );

        let mut controller = ManagedSessionAttacher::new(runtime, temp.path())
            .attach(ManagedAttachRequest::new("session-1", "workspace-1").unwrap())
            .unwrap();
        let receipt = controller
            .send_input_confirmed(b"status\r".to_vec(), Duration::from_secs(1))
            .unwrap();

        assert_eq!(receipt.state, crate::ControllerReceiptState::WrittenToPty);
        controller.detach().unwrap();
        host.join().unwrap();
    }

    fn managed_manifest(socket_path: &std::path::Path) -> DiscoveryManifest {
        DiscoveryManifest::Ready(ReadyManifest {
            common: ManifestCommon {
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
                    runner_principal: "runner-1".into(),
                    runner_instance: "instance-1".into(),
                    channel_epoch: 1,
                },
                host_instance_id: "host-1".into(),
                provider_id: "codex".into(),
                runtime_context: RuntimeContext::default(),
                claim_linkage: ClaimLinkage {
                    claim_id: Some("claim-1".into()),
                    kickoff_action_id: None,
                },
                host_process: ProcessProof {
                    process_id: 100,
                    start_marker: "host-start".into(),
                },
                created_unix_ms: 1,
                session_class: SessionClass::Managed,
                session_name: None,
                retirement_policy: None,
            },
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
            capability_token: "capability-secret".into(),
            ready_unix_ms: 2,
        })
    }

    fn fence(manifest: &DiscoveryManifest) -> SessionFence {
        let common = manifest.common();
        SessionFence {
            workspace_id: common.lifetime.workspace_id.clone(),
            session_id: common.lifetime.session_id.clone(),
            runner_principal: common.lifetime.runner_principal.clone(),
            runner_instance: common.lifetime.runner_instance.clone(),
            channel_epoch: common.lifetime.channel_epoch,
            host_instance_id: common.host_instance_id.clone(),
            terminal_epoch: "terminal-1".into(),
        }
    }

    fn serve_controller(
        socket_path: PathBuf,
        fence: SessionFence,
    ) -> (mpsc::Receiver<Hello>, thread::JoinHandle<()>) {
        let listener = UnixListener::bind(socket_path).unwrap();
        let (sender, receiver) = mpsc::channel();
        let host = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let codec = FrameCodec::new(FrameLimits::default());
            let FrameBody::Hello(hello) = codec.read_from(&mut stream).unwrap().body else {
                panic!("controller must begin with Hello");
            };
            sender.send(hello).unwrap();
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
                    lifecycle: LifecycleState::Controlling,
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
                    controller_generation: 7,
                    authorization_posture: AuthorizationPosture::DaemonAuthorized,
                }),
            );
            write(
                &mut stream,
                2,
                FrameBody::ScreenSnapshot(ScreenSnapshot {
                    fence,
                    sequence_through: 1,
                    rows: 24,
                    columns: 80,
                    encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
                    controller_input_pending: None,
                    semantic_idle_ms: None,
                    repaint_bytes: b"managed-screen".to_vec(),
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
            if let Ok(frame) = codec.read_from(&mut stream) {
                if let FrameBody::Input(input) = frame.body {
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
                    let _ = codec.read_from(&mut stream);
                }
            }
        });
        (receiver, host)
    }

    fn fake_runtime(root: &std::path::Path, response: ManagedAttachBrokerResponse) -> PathBuf {
        let response_path = root.join("response.bin");
        let mut response_bytes = Vec::new();
        write_managed_attach_response(&mut response_bytes, &response).unwrap();
        std::fs::write(response_path, response_bytes).unwrap();

        let runtime = root.join("fake-hebbian");
        std::fs::write(
            &runtime,
            "#!/bin/sh\nruntime_dir=${0%/*}\ncat \"$runtime_dir/response.bin\"\ncat > \"$runtime_dir/input.bin\"\n",
        )
        .unwrap();
        let mut permissions = runtime.metadata().unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&runtime, permissions).unwrap();
        runtime
    }

    fn captured_finalization(
        root: &std::path::Path,
        transaction_id: &str,
    ) -> ManagedAttachFinalization {
        let input = std::fs::read(root.join("input.bin")).unwrap();
        let mut input = Cursor::new(input);
        let request = read_managed_attach_request(&mut input).unwrap();
        assert_eq!(request.session_id(), "session-1");
        assert_eq!(request.workspace_id(), "workspace-1");
        read_managed_attach_finalization(&mut input, transaction_id).unwrap()
    }
}
