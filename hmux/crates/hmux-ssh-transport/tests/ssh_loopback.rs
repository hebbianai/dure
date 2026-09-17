//! End-to-end against a real SSH server, in this process.
//!
//! The unit tests drive a scripted channel because that is the only way to ask
//! for a failure after exactly five committed bytes. What they cannot check is
//! the binding itself: that the exec request carries the gateway command, that
//! **no PTY is requested**, that stream 2 is drained separately from stream 0,
//! and that a wrong host key is refused before anything else happens. Those are
//! statements about russh, so they get a russh server.
//!
//! The server is bound to loopback on an ephemeral port and lives for one
//! connection. No fixtures, no daemon, no network.

use hmux_runtime_contract::{
    MANAGED_CONVERSATION_WRITER_CONFLICT_CODE, MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND,
    MANAGED_CREATE_ADVANCE_CAPABILITY, MANAGED_CREATE_BROKER_SUBCOMMAND,
    MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND, MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2,
    MANAGED_CREATE_CHAIN_STOP_CAPABILITY, MANAGED_CREATE_CHAIN_STOP_CAPABILITY_V2,
    MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND, MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE,
    MANAGED_CREATE_RETIRED_EXACT_CODE, MANAGED_STOP_BROKER_SUBCOMMAND,
    MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION, MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND,
    ManagedCreateAdvanceBrokerResponse, ManagedCreateBrokerResponse,
    ManagedCreateChainStopBrokerResponse, ManagedCreateChainStopBrokerResponseV2,
    ManagedCreateChainStopReceipt, ManagedCreateChainStopReceiptV2, ManagedCreateGenerationFence,
    ManagedCreateOutcome, ManagedCreateReceipt, ManagedCreateReconcileBrokerResponse,
    ManagedCreateReconcileRequest, ManagedCreateRequest, ManagedStopBrokerResponse,
    ManagedStopOutcome, ManagedStopReceipt, ManagedStopReconcileRequest, ManagedStopRequest,
    PermissionMode,
};
use hmux_session_protocol::transport::{FrameReader, FrameWriter};
use hmux_session_protocol::{
    Detach, ErrorCode, ErrorFrame, FrameBody, FrameCodec, FrameLimits, InputReceiptState,
    PROTOCOL_V1, RetryPosture, SessionFence, WireFrame,
};
use hmux_ssh_transport::{
    DEFAULT_GATEWAY_COMMAND, HostKeyPolicy, RemoteHostLiveness,
    RemoteManagedCreateAdvanceResolution, RemoteManagedCreateResolution, RemoteSessionClass,
    RemoteSessionInputRequest, RemoteUnpresentedCreationAbandonRequest, SessionRetirementPolicy,
    SessionRetirementReceiptReason, SessionRetirementReceiptState, SshAuthentication, SshEndpoint,
    SshExecConfig, SshExecDialer, SshTransportError, abandon_unpresented_creation_over_ssh,
    create_managed_or_reconcile_and_advance_over_ssh, create_managed_or_reconcile_over_ssh,
    create_managed_over_ssh, execute_bounded_over_ssh, list_sessions_over_ssh,
    list_sessions_with_facts_over_ssh, observe_server_host_key, reconcile_managed_create_over_ssh,
    reconcile_managed_stop_over_ssh, stop_managed_create_chain_over_ssh,
    stop_managed_create_chain_v2_over_ssh, stop_managed_over_ssh, write_session_input_over_ssh,
};
use russh::keys::{Algorithm, HashAlg, PrivateKey, ssh_key};
use russh::server::{Auth, ChannelOpenHandle, Handler, Msg, Server, Session};
use russh::{Channel, ChannelId, Pty};
use std::io::Read;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[path = "ssh_loopback/frames.rs"]
mod frames;

/// What the fake gateway does once it is exec'd.
#[derive(Clone, Copy)]
enum Behaviour {
    /// Return one bounded read-only command receipt without reading stdin.
    BoundedCommand,
    /// Exceed the fixed stdout budget.
    BoundedCommandOversize,
    /// Accept the command but never produce a terminal outcome.
    BoundedCommandStall,
    /// Echo stream 0 back, which is enough to prove frames survive the round
    /// trip through a real channel.
    Echo,
    /// Behave like a box where the gateway is not installed.
    NotInstalled,
    /// Answer the gateway's versioned catalog request, then exit cleanly.
    Catalog,
    /// Answer the session-facts catalog used for remote Host rehost decisions.
    CatalogWithSessionFacts,
    /// Answer the already-shipped v3 session-facts shape, before the gateway
    /// build id was added to that same catalog version.
    CatalogWithShippedSessionFacts,
    /// Answer the proof-gated unpresented creation abandon request.
    AbandonUnpresentedCreation,
    /// Answer one exact, receipt-confirmed session input request.
    SessionInput,
    /// Accept one lifecycle-fenced managed create request.
    ManagedCreate,
    /// Return the ledger-owned successor from one create-advance exec.
    ManagedCreateAdvance,
    /// Refuse a managed create because another logical session owns the exact
    /// provider conversation on the remote discovery root.
    ManagedCreateConversationConflict,
    /// Refuse create with the one typed digest conflict, then terminalize its
    /// identity on the second SSH exec.
    ManagedCreateDigestConflictThenReconcile,
    /// Refuse an exact replay because its create identity is terminal.
    ManagedCreateRetired,
    /// Apply a managed create request but lose its receipt before SSH close.
    ManagedCreateNoReceipt,
    /// Return the terminal state of one exact managed-create identity.
    ManagedCreateReconcile,
    /// Apply managed-create reconciliation but lose its typed response.
    ManagedCreateReconcileNoResponse,
    /// Return one exact managed-stop receipt.
    ManagedStop,
    /// Return a valid receipt for the same operation and Host/terminal, but a
    /// different runner generation.
    ManagedStopWrongRunnerFence,
    /// Reconcile one journaled managed-stop intent or receipt.
    ManagedStopReconcile,
    /// Reconcile to a valid receipt for a different runner generation.
    ManagedStopReconcileWrongRunnerFence,
    /// Apply the request but lose its receipt before SSH close.
    ManagedStopNoReceipt,
    /// Advertise and execute one logical managed-create successor-chain stop.
    ManagedCreateChainStop,
    /// Return build info without the current create-advance capability.
    ManagedCreateAdvanceLegacyCapability,
    /// Return build info without the logical chain-stop capability.
    ManagedCreateChainStopCapabilityMissing,
    /// Advertise only the legacy chain-stop capability to a v2 caller.
    ManagedCreateChainStopV2CapabilityMissing,
}

#[derive(Clone)]
struct Observed {
    authentication_attempted: Arc<AtomicBool>,
    requested_pty: Arc<AtomicBool>,
    exec_command: Arc<Mutex<Option<String>>>,
    exec_commands: Arc<Mutex<Vec<String>>>,
    request_bytes: Arc<Mutex<Vec<u8>>>,
    request_documents: Arc<Mutex<Vec<Vec<u8>>>>,
    catalog_answered: Arc<AtomicBool>,
    catalog_answers: Arc<AtomicUsize>,
    /// TCP connections the server has accepted.
    connections: Arc<AtomicUsize>,
    /// Exec channels the client has closed.
    channels_closed: Arc<AtomicUsize>,
}

#[derive(Clone)]
struct FakeGateway {
    behaviour: Behaviour,
    observed: Observed,
}

impl Server for FakeGateway {
    type Handler = Self;

    fn new_client(&mut self, _peer: Option<SocketAddr>) -> Self {
        self.observed.connections.fetch_add(1, Ordering::AcqRel);
        self.clone()
    }
}

impl Handler for FakeGateway {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
        self.observed
            .authentication_attempted
            .store(true, Ordering::Release);
        Ok(Auth::reject())
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &ssh_key::PublicKey,
    ) -> Result<Auth, Self::Error> {
        self.observed
            .authentication_attempted
            .store(true, Ordering::Release);
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn channel_close(
        &mut self,
        _channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.observed.channels_closed.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _columns: u32,
        _rows: u32,
        _pixel_width: u32,
        _pixel_height: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.observed.requested_pty.store(true, Ordering::Release);
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(command).into_owned();
        *self.observed.exec_command.lock().expect("command lock") = Some(command.clone());
        self.observed
            .exec_commands
            .lock()
            .expect("commands lock")
            .push(command.clone());
        session.channel_success(channel)?;
        if let Behaviour::NotInstalled = self.behaviour {
            // SSH can end stdout before publishing the command's exit status.
            session.extended_data(channel, 1, b"bash: hmux: command not found\n".to_vec())?;
            session.eof(channel)?;
            let handle = session.handle();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let _ = handle.exit_status_request(channel, 127).await;
                let _ = handle.close(channel).await;
            });
        } else if let Behaviour::BoundedCommand = self.behaviour {
            session.data(
                channel,
                br#"{"schemaVersion":2,"capabilities":["managed_rehost_exact_fence_v1"]}"#.to_vec(),
            )?;
            session.extended_data(channel, 1, b"read-only diagnostic\n".to_vec())?;
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
        } else if let Behaviour::BoundedCommandOversize = self.behaviour {
            session.data(channel, vec![b'x'; 256 * 1024 + 1])?;
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
        } else if matches!(
            self.behaviour,
            Behaviour::ManagedCreateAdvance
                | Behaviour::ManagedCreateAdvanceLegacyCapability
                | Behaviour::ManagedCreateChainStop
                | Behaviour::ManagedCreateChainStopCapabilityMissing
                | Behaviour::ManagedCreateChainStopV2CapabilityMissing
        ) && command.ends_with(" hmux-build-info")
        {
            let capabilities = match self.behaviour {
                Behaviour::ManagedCreateAdvance => {
                    serde_json::json!([MANAGED_CREATE_ADVANCE_CAPABILITY])
                }
                Behaviour::ManagedCreateAdvanceLegacyCapability => {
                    serde_json::json!(["managed_create_advance_v2"])
                }
                Behaviour::ManagedCreateChainStop => serde_json::json!([
                    MANAGED_CREATE_CHAIN_STOP_CAPABILITY,
                    MANAGED_CREATE_CHAIN_STOP_CAPABILITY_V2,
                ]),
                Behaviour::ManagedCreateChainStopV2CapabilityMissing => {
                    serde_json::json!([MANAGED_CREATE_CHAIN_STOP_CAPABILITY])
                }
                Behaviour::ManagedCreateChainStopCapabilityMissing => serde_json::json!([]),
                _ => unreachable!("only capability-gated behaviours probe build info"),
            };
            session.data(
                channel,
                serde_json::to_vec(&serde_json::json!({
                    "schemaVersion": 1,
                    "capabilities": capabilities,
                }))
                .expect("build info encodes"),
            )?;
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
        }
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        match self.behaviour {
            Behaviour::Echo => session.data(channel, data.to_vec())?,
            Behaviour::BoundedCommand
            | Behaviour::BoundedCommandOversize
            | Behaviour::BoundedCommandStall
            | Behaviour::ManagedCreateAdvanceLegacyCapability => {}
            Behaviour::Catalog
            | Behaviour::CatalogWithSessionFacts
            | Behaviour::CatalogWithShippedSessionFacts
            | Behaviour::AbandonUnpresentedCreation
            | Behaviour::SessionInput
            | Behaviour::ManagedCreate
            | Behaviour::ManagedCreateAdvance
            | Behaviour::ManagedCreateConversationConflict
            | Behaviour::ManagedCreateDigestConflictThenReconcile
            | Behaviour::ManagedCreateRetired
            | Behaviour::ManagedCreateNoReceipt
            | Behaviour::ManagedCreateReconcile
            | Behaviour::ManagedCreateReconcileNoResponse
            | Behaviour::ManagedStop
            | Behaviour::ManagedStopWrongRunnerFence
            | Behaviour::ManagedStopReconcile
            | Behaviour::ManagedStopReconcileWrongRunnerFence
            | Behaviour::ManagedStopNoReceipt
            | Behaviour::ManagedCreateChainStop => {
                let mut request = self.observed.request_bytes.lock().expect("request lock");
                request.extend_from_slice(data);
                let complete = request
                    .get(..4)
                    .map(|prefix| {
                        let length =
                            u32::from_be_bytes(prefix.try_into().expect("four-byte prefix"))
                                as usize;
                        request.len() == length + 4
                    })
                    .unwrap_or(false);
                let multiple_answers = matches!(
                    self.behaviour,
                    Behaviour::CatalogWithShippedSessionFacts
                        | Behaviour::ManagedCreateDigestConflictThenReconcile
                );
                if complete
                    && (multiple_answers
                        || !self.observed.catalog_answered.swap(true, Ordering::AcqRel))
                {
                    let request_document = request.clone();
                    if multiple_answers {
                        request.clear();
                    }
                    drop(request);
                    let answer_index = self.observed.catalog_answers.fetch_add(1, Ordering::AcqRel);
                    self.observed
                        .request_documents
                        .lock()
                        .expect("request document lock")
                        .push(request_document.clone());
                    let request_version = matches!(
                        self.behaviour,
                        Behaviour::CatalogWithSessionFacts
                            | Behaviour::CatalogWithShippedSessionFacts
                    )
                    .then(|| {
                        serde_json::from_slice::<serde_json::Value>(
                            request_document
                                .get(4..)
                                .expect("the complete request has a length prefix"),
                        )
                        .expect("gateway request decodes")["gateway_request_version"]
                            .as_u64()
                            .expect("gateway request version")
                    });
                    if matches!(self.behaviour, Behaviour::CatalogWithShippedSessionFacts)
                        && answer_index == 0
                    {
                        assert_eq!(request_version, Some(6));
                        let response = serde_json::to_value(WireFrame {
                            protocol_version: PROTOCOL_V1,
                            frame_id: 1,
                            body: FrameBody::Error(ErrorFrame {
                                origin_code: None,
                                code: ErrorCode::UnsupportedProtocolVersion,
                                message: "this gateway serves gateway_request_version 1..=5, not 6"
                                    .into(),
                                retry: RetryPosture::Never,
                                required_capability: None,
                                supported_versions: None,
                                in_reply_to_request_id: None,
                            }),
                        })
                        .expect("version refusal encodes");
                        let payload =
                            serde_json::to_vec(&response).expect("version refusal payload encodes");
                        let mut encoded = Vec::with_capacity(payload.len() + 4);
                        encoded.extend_from_slice(&(payload.len() as u32).to_be_bytes());
                        encoded.extend_from_slice(&payload);
                        session.data(channel, encoded)?;
                        session.exit_status_request(channel, 1)?;
                        session.eof(channel)?;
                        session.close(channel)?;
                        return Ok(());
                    }
                    let response = match self.behaviour {
                        Behaviour::Catalog => serde_json::json!({
                            "gateway_catalog_version": 2,
                            "session": {
                                "session_id": "remote-session",
                                "session_name": "remote-shell",
                                "workspace_id": "remote-workspace",
                                "session_class": "standalone",
                                "lifecycle": "ready",
                                "provider_id": "shell",
                                "runner_principal": "principal",
                                "runner_instance": "instance",
                                "channel_epoch": "7",
                                "host_instance_id": "host-instance",
                                "terminal_epoch": "terminal-epoch",
                                "supported_protocol": {
                                    "minimum": { "major": 1, "minor": 0 },
                                    "maximum": { "major": 1, "minor": 0 }
                                },
                                "capabilities": ["screen_snapshot", "session_retirement_v1"],
                                "retirement_policy": {
                                    "kind": "after_graceful_last_client_departure_v1",
                                    "grace_period_ms": "2000"
                                }
                            }
                        }),
                        Behaviour::CatalogWithSessionFacts
                        | Behaviour::CatalogWithShippedSessionFacts => {
                            let request_version = request_version.expect("catalog request version");
                            let catalog_version = if request_version == 6 {
                                4
                            } else {
                                assert_eq!(request_version, 4);
                                3
                            };
                            let mut document = serde_json::json!({
                                "gateway_catalog_version": catalog_version,
                                "session": {
                                    "session_id": "remote-session",
                                    "session_name": "remote-shell",
                                    "workspace_id": "remote-workspace",
                                    "session_class": "managed",
                                    "lifecycle": "ready",
                                    "provider_id": "codex",
                                    "runner_principal": "principal",
                                    "runner_instance": "instance",
                                    "channel_epoch": "7",
                                    "host_instance_id": "host-instance",
                                    "terminal_epoch": "terminal-epoch",
                                    "supported_protocol": {
                                        "minimum": { "major": 1, "minor": 0 },
                                        "maximum": { "major": 1, "minor": 0 }
                                    },
                                    "capabilities": ["screen_snapshot", "terminal_input"],
                                    "launch_program": "codex",
                                    "host_liveness": "live"
                                }
                            });
                            if catalog_version == 4 {
                                document["gateway_build_id"] = "build-current".into();
                            }
                            document
                        }
                        Behaviour::AbandonUnpresentedCreation => serde_json::json!({
                            "gateway_abandon_version": 1,
                            "request_id": "request-1",
                            "session_id": "remote-session",
                            "workspace_id": "remote-workspace",
                            "receipt": {
                                "request_id": "host-retirement-1",
                                "state": "refused",
                                "reason": "generation_changed"
                            }
                        }),
                        Behaviour::SessionInput => serde_json::json!({
                            "gateway_input_version": 1,
                            "request_id": "request-input-1",
                            "session_id": "remote-session",
                            "workspace_id": "remote-workspace",
                            "receipt": {
                                "request_id": "external-input-1",
                                "controller_generation": "9",
                                "state": "written_to_pty",
                                "reason": null
                            }
                        }),
                        Behaviour::ManagedCreate => {
                            serde_json::to_value(ManagedCreateBrokerResponse::Completed(Box::new(
                                ManagedCreateReceipt::new(
                                    "managed-create-1",
                                    "managed-session-1",
                                    "managed-workspace-1",
                                    "codex",
                                    PermissionMode::Default,
                                    "/tmp/managed-discovery",
                                    ManagedCreateOutcome::Created,
                                )
                                .expect("managed create receipt")
                                .with_generation_fence(
                                    ManagedCreateGenerationFence::new(
                                        "principal-1",
                                        "runner-1",
                                        7,
                                        "host-1",
                                        "terminal-1",
                                    )
                                    .expect("managed create generation fence"),
                                )
                                .expect("fenced managed create receipt"),
                            )))
                            .expect("managed create response")
                        }
                        Behaviour::ManagedCreateAdvance => serde_json::to_value(
                            ManagedCreateAdvanceBrokerResponse::Advanced(Box::new(
                                ManagedCreateReceipt::new(
                                    "create-successor",
                                    "session-successor",
                                    "managed-workspace-1",
                                    "codex",
                                    PermissionMode::Default,
                                    "/tmp/managed-discovery",
                                    ManagedCreateOutcome::Created,
                                )
                                .expect("managed create successor receipt")
                                .with_generation_fence(
                                    ManagedCreateGenerationFence::new(
                                        "principal-1",
                                        "runner-1",
                                        7,
                                        "host-1",
                                        "terminal-1",
                                    )
                                    .expect("managed create successor fence"),
                                )
                                .expect("fenced managed create successor receipt"),
                            )),
                        )
                        .expect("managed create advance response"),
                        Behaviour::ManagedCreateConversationConflict => {
                            serde_json::to_value(ManagedCreateBrokerResponse::refused(
                                MANAGED_CONVERSATION_WRITER_CONFLICT_CODE,
                                "another managed session owns the exact conversation",
                            ))
                            .expect("managed create conversation conflict")
                        }
                        Behaviour::ManagedCreateDigestConflictThenReconcile => {
                            if answer_index == 0 {
                                serde_json::to_value(ManagedCreateBrokerResponse::refused(
                                    MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE,
                                    "the canonical request digest changed",
                                ))
                                .expect("managed create digest conflict")
                            } else {
                                serde_json::to_value(
                                    ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion,
                                )
                                .expect("managed create reconcile response")
                            }
                        }
                        Behaviour::ManagedCreateRetired => {
                            serde_json::to_value(ManagedCreateBrokerResponse::refused(
                                MANAGED_CREATE_RETIRED_EXACT_CODE,
                                "the exact managed create identity is retired",
                            ))
                            .expect("managed create retired response")
                        }
                        Behaviour::ManagedCreateNoReceipt => {
                            session.exit_status_request(channel, 0)?;
                            session.eof(channel)?;
                            session.close(channel)?;
                            return Ok(());
                        }
                        Behaviour::ManagedCreateReconcile => serde_json::to_value(
                            ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion,
                        )
                        .expect("managed create reconcile response"),
                        Behaviour::ManagedCreateReconcileNoResponse => {
                            session.exit_status_request(channel, 0)?;
                            session.eof(channel)?;
                            session.close(channel)?;
                            return Ok(());
                        }
                        Behaviour::ManagedStop | Behaviour::ManagedStopReconcile => {
                            let request = ManagedStopRequest::new(
                                "managed-stop-1",
                                "managed-session-1",
                                "managed-workspace-1",
                            )
                            .expect("managed stop request")
                            .with_expected_fence(
                                "principal-1",
                                "runner-1",
                                7,
                                "host-1",
                                "terminal-1",
                            )
                            .expect("managed stop fence");
                            serde_json::to_value(ManagedStopBrokerResponse::Completed(Box::new(
                                ManagedStopReceipt::from_request(
                                    &request,
                                    ManagedStopOutcome::Stopped,
                                    "managed_provider_stop",
                                )
                                .expect("managed stop receipt"),
                            )))
                            .expect("managed stop response")
                        }
                        Behaviour::ManagedStopWrongRunnerFence
                        | Behaviour::ManagedStopReconcileWrongRunnerFence => {
                            let request = ManagedStopRequest::new(
                                "managed-stop-1",
                                "managed-session-1",
                                "managed-workspace-1",
                            )
                            .expect("changed-runner managed stop request")
                            .with_expected_fence(
                                "principal-other",
                                "runner-other",
                                8,
                                "host-1",
                                "terminal-1",
                            )
                            .expect("changed-runner managed stop fence");
                            serde_json::to_value(ManagedStopBrokerResponse::Completed(Box::new(
                                ManagedStopReceipt::from_request(
                                    &request,
                                    ManagedStopOutcome::Stopped,
                                    "managed_provider_stop",
                                )
                                .expect("changed-runner managed stop receipt"),
                            )))
                            .expect("changed-runner managed stop response")
                        }
                        Behaviour::ManagedStopNoReceipt => {
                            session.exit_status_request(channel, 0)?;
                            session.eof(channel)?;
                            session.close(channel)?;
                            return Ok(());
                        }
                        Behaviour::ManagedCreateChainStop => {
                            let root = ManagedCreateReconcileRequest::new(
                                "managed-create-root-1",
                                "managed-session-root-1",
                                "managed-workspace-1",
                            )
                            .expect("managed create root");
                            let effective = ManagedCreateReconcileRequest::new(
                                "managed-create-successor-1",
                                "managed-session-successor-1",
                                "managed-workspace-1",
                            )
                            .expect("managed create successor");
                            let stop_request = ManagedStopRequest::new(
                                "managed-chain-stop-1",
                                effective.session_id(),
                                effective.workspace_id(),
                            )
                            .expect("managed successor stop request")
                            .with_expected_fence(
                                "principal-1",
                                "runner-1",
                                7,
                                "host-1",
                                "terminal-1",
                            )
                            .expect("managed successor stop fence");
                            let stop_receipt = ManagedStopReceipt::from_request(
                                &stop_request,
                                ManagedStopOutcome::Stopped,
                                "managed_provider_stop",
                            )
                            .expect("managed successor stop receipt");
                            let command = self
                                .observed
                                .exec_command
                                .lock()
                                .expect("command lock")
                                .clone()
                                .expect("chain-stop command");
                            if command.ends_with(MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2) {
                                serde_json::to_value(
                                    ManagedCreateChainStopBrokerResponseV2::Completed(Box::new(
                                        ManagedCreateChainStopReceiptV2::stopped(
                                            vec![root, effective],
                                            stop_receipt,
                                        )
                                        .expect("managed create chain-stop v2 receipt"),
                                    )),
                                )
                                .expect("managed create chain-stop v2 response")
                            } else {
                                serde_json::to_value(
                                    ManagedCreateChainStopBrokerResponse::Completed(Box::new(
                                        ManagedCreateChainStopReceipt::stopped(
                                            root,
                                            effective,
                                            stop_receipt,
                                        )
                                        .expect("managed create chain-stop v1 receipt"),
                                    )),
                                )
                                .expect("managed create chain-stop v1 response")
                            }
                        }
                        Behaviour::Echo
                        | Behaviour::NotInstalled
                        | Behaviour::BoundedCommand
                        | Behaviour::BoundedCommandOversize
                        | Behaviour::BoundedCommandStall
                        | Behaviour::ManagedCreateAdvanceLegacyCapability
                        | Behaviour::ManagedCreateChainStopCapabilityMissing
                        | Behaviour::ManagedCreateChainStopV2CapabilityMissing => {
                            unreachable!("only document behaviours reach this branch")
                        }
                    };
                    let payload = serde_json::to_vec(&response).expect("gateway response encodes");
                    let mut encoded = Vec::with_capacity(payload.len() + 4);
                    encoded.extend_from_slice(&(payload.len() as u32).to_be_bytes());
                    encoded.extend_from_slice(&payload);
                    session.data(channel, encoded)?;
                    session.exit_status_request(channel, 0)?;
                    session.eof(channel)?;
                    session.close(channel)?;
                } else {
                    drop(request);
                }
            }
            Behaviour::NotInstalled
            | Behaviour::ManagedCreateChainStopCapabilityMissing
            | Behaviour::ManagedCreateChainStopV2CapabilityMissing => {}
        }
        Ok(())
    }
}

#[test]
fn bounded_command_is_pinned_no_pty_and_captures_separate_streams() {
    let fixture = start(Behaviour::BoundedCommand);
    let mut config = config_for(&fixture, &fixture.host_fingerprint);
    config.command = r#""$HOME/.local/bin/hmux" capabilities --json"#.to_string();
    let output = execute_bounded_over_ssh(config, Duration::from_secs(2))
        .expect("bounded command completes");

    assert_eq!(output.exit_status, 0);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["schemaVersion"],
        2
    );
    assert_eq!(output.stderr, b"read-only diagnostic\n");
    assert!(!fixture.observed.requested_pty.load(Ordering::Acquire));
    assert_eq!(
        fixture.observed.exec_command.lock().unwrap().as_deref(),
        Some(r#""$HOME/.local/bin/hmux" capabilities --json"#)
    );
    assert!(fixture.observed.request_bytes.lock().unwrap().is_empty());
}

#[test]
fn bounded_command_rejects_output_pressure_and_stall() {
    let overflow = start(Behaviour::BoundedCommandOversize);
    let mut config = config_for(&overflow, &overflow.host_fingerprint);
    config.command = "read-only-overflow".to_string();
    let error = execute_bounded_over_ssh(config, Duration::from_secs(2)).unwrap_err();
    assert_eq!(error.code(), "hmux_ssh_output_too_large");

    let stalled = start(Behaviour::BoundedCommandStall);
    let mut config = config_for(&stalled, &stalled.host_fingerprint);
    config.command = "read-only-stall".to_string();
    let error = execute_bounded_over_ssh(config, Duration::from_millis(50)).unwrap_err();
    assert_eq!(error.code(), "hmux_ssh_timed_out");

    let wrong_key = start(Behaviour::BoundedCommand);
    let other_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let other_fingerprint = other_key
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();
    let mut config = config_for(&wrong_key, &other_fingerprint);
    config.command = "read-only-preflight".to_string();
    let error = execute_bounded_over_ssh(config, Duration::from_secs(2)).unwrap_err();
    assert_eq!(error.code(), "hmux_ssh_host_key_rejected");
    assert!(wrong_key.observed.exec_command.lock().unwrap().is_none());
    assert!(wrong_key.observed.request_bytes.lock().unwrap().is_empty());

    let missing = start(Behaviour::NotInstalled);
    let mut config = config_for(&missing, &missing.host_fingerprint);
    config.command = "read-only-preflight".to_string();
    let output = execute_bounded_over_ssh(config, Duration::from_secs(2)).unwrap();
    assert_eq!(output.exit_status, 127);
    assert!(String::from_utf8_lossy(&output.stderr).contains("command not found"));
    assert!(missing.observed.request_bytes.lock().unwrap().is_empty());
}

struct Fixture {
    port: u16,
    host_fingerprint: String,
    client_key: String,
    observed: Observed,
}

/// Starts a bounded-connection SSH server on loopback and returns how to reach it.
fn start(behaviour: Behaviour) -> Fixture {
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("host key");
    let host_fingerprint = host_key
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();
    let client_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("client key");
    let client_pem = client_key
        .to_openssh(ssh_key::LineEnding::LF)
        .expect("client key encodes")
        .to_string();

    let observed = Observed {
        authentication_attempted: Arc::new(AtomicBool::new(false)),
        requested_pty: Arc::new(AtomicBool::new(false)),
        exec_command: Arc::new(Mutex::new(None)),
        exec_commands: Arc::new(Mutex::new(Vec::new())),
        request_bytes: Arc::new(Mutex::new(Vec::new())),
        request_documents: Arc::new(Mutex::new(Vec::new())),
        catalog_answered: Arc::new(AtomicBool::new(false)),
        catalog_answers: Arc::new(AtomicUsize::new(0)),
        connections: Arc::new(AtomicUsize::new(0)),
        channels_closed: Arc::new(AtomicUsize::new(0)),
    };

    let (ready, port) = std::sync::mpsc::sync_channel(1);
    let server_observed = observed.clone();
    thread::Builder::new()
        .name("fake-gateway".to_string())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("server runtime");
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .expect("loopback listener");
                ready
                    .send(listener.local_addr().expect("listener address").port())
                    .expect("port is reported");

                let config = Arc::new(russh::server::Config {
                    keys: vec![host_key],
                    ..russh::server::Config::default()
                });
                let mut server = FakeGateway {
                    behaviour,
                    observed: server_observed,
                };
                let connection_count = if matches!(
                    behaviour,
                    Behaviour::CatalogWithShippedSessionFacts
                        | Behaviour::ManagedCreateDigestConflictThenReconcile
                        | Behaviour::ManagedCreateAdvance
                        | Behaviour::ManagedCreateChainStop
                ) {
                    2
                } else {
                    1
                };
                for _ in 0..connection_count {
                    let (stream, _peer) = listener.accept().await.expect("expected connection");
                    let session =
                        russh::server::run_stream(config.clone(), stream, server.new_client(None))
                            .await
                            .expect("server session");
                    // Runs until the client hangs up, which is what keeps the
                    // channel alive for the duration of the test.
                    let _ = session.await;
                }
            });
        })
        .expect("server thread");

    Fixture {
        port: port.recv().expect("the server reports its port"),
        host_fingerprint,
        client_key: client_pem,
        observed,
    }
}

fn config_for(fixture: &Fixture, pinned: &str) -> SshExecConfig {
    let mut config = SshExecConfig::new(
        SshEndpoint {
            host: "127.0.0.1".to_string(),
            port: fixture.port,
        },
        "tester",
        SshAuthentication::PrivateKey {
            openssh_pem: fixture.client_key.clone(),
            passphrase: None,
        },
        HostKeyPolicy::pinned([pinned.to_string()]),
    );
    config.connect_timeout = Duration::from_secs(20);
    config
}

fn codec() -> FrameCodec {
    FrameCodec::new(FrameLimits::default())
}

fn detach(reason: &str) -> WireFrame {
    WireFrame {
        protocol_version: PROTOCOL_V1,
        frame_id: 1,
        body: FrameBody::Detach(Detach {
            reason: Some(reason.to_string()),
        }),
    }
}

/// Two channels to one box ride one SSH connection: the second attach costs
/// an exec channel, not a TCP connect, key exchange and authentication. Each
/// channel still runs its own gateway command and ends on its own.
#[test]
fn channels_to_the_same_box_share_one_connection() {
    let fixture = start(Behaviour::Echo);
    let config = config_for(&fixture, &fixture.host_fingerprint);

    let mut first = SshExecDialer::open_halves(config.clone()).expect("first channel");
    let mut second = SshExecDialer::open_halves(config).expect("second channel");
    assert_eq!(fixture.observed.connections.load(Ordering::Acquire), 1);
    assert_eq!(
        fixture
            .observed
            .exec_commands
            .lock()
            .expect("commands lock")
            .len(),
        2
    );

    // Both channels carry frames independently.
    let codec = codec();
    let frame = detach("first");
    let encoded = codec.encode(&frame).expect("frame encodes");
    first.writer.write_frame(&encoded).expect("first write");
    let decoded = first
        .reader
        .read_frame(&codec)
        .expect("first channel echoes")
        .expect("not a clean close");
    assert_eq!(decoded.frame(), &frame);

    // Dropping one pane's halves closes its channel — and so its gateway —
    // while the connection stays up for the other.
    drop(first);
    let closed_by = std::time::Instant::now() + Duration::from_secs(5);
    while fixture.observed.channels_closed.load(Ordering::Acquire) == 0 {
        assert!(
            std::time::Instant::now() < closed_by,
            "the first channel was never closed"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let frame = detach("second");
    let encoded = codec.encode(&frame).expect("frame encodes");
    second.writer.write_frame(&encoded).expect("second write");
    let decoded = second
        .reader
        .read_frame(&codec)
        .expect("the second channel outlives the first")
        .expect("not a clean close");
    assert_eq!(decoded.frame(), &frame);
    assert_eq!(fixture.observed.connections.load(Ordering::Acquire), 1);
}

#[test]
fn catalog_discovery_uses_the_same_no_pty_exec_channel() {
    let fixture = start(Behaviour::Catalog);
    let sessions = list_sessions_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        Duration::from_secs(5),
    )
    .expect("the remote catalog is listed");

    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "remote-session");
    assert_eq!(sessions[0].workspace_id, "remote-workspace");
    assert_eq!(sessions[0].session_class, RemoteSessionClass::Standalone);
    assert_eq!(
        sessions[0].retirement_policy,
        Some(
            SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                grace_period_ms: 2_000,
            }
        )
    );
    assert!(
        !fixture.observed.requested_pty.load(Ordering::Acquire),
        "catalog discovery must not request an SSH PTY"
    );
    assert_eq!(
        fixture
            .observed
            .exec_command
            .lock()
            .expect("command lock")
            .as_deref(),
        Some(DEFAULT_GATEWAY_COMMAND)
    );
    let request = fixture.observed.request_bytes.lock().expect("request lock");
    let length = u32::from_be_bytes(request[..4].try_into().unwrap()) as usize;
    assert_eq!(length, request.len() - 4);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&request[4..]).unwrap(),
        serde_json::json!({
            "gateway_request_version": 2,
            "request": "list_sessions"
        })
    );
}

#[test]
fn session_facts_catalog_crosses_a_real_no_pty_ssh_channel() {
    let fixture = start(Behaviour::CatalogWithSessionFacts);
    let sessions = list_sessions_with_facts_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        Duration::from_secs(5),
    )
    .expect("the remote session-facts catalog is listed");

    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_class, RemoteSessionClass::Managed);
    assert_eq!(
        sessions[0].gateway_build_id.as_deref(),
        Some("build-current")
    );
    assert_eq!(sessions[0].launch_program.as_deref(), Some("codex"));
    assert!(
        !fixture.observed.requested_pty.load(Ordering::Acquire),
        "session-facts discovery must not request an SSH PTY"
    );
    let request = fixture.observed.request_bytes.lock().expect("request lock");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&request[4..]).unwrap(),
        serde_json::json!({
            "gateway_request_version": 6,
            "request": "list_sessions"
        })
    );
}

#[test]
fn current_client_typed_falls_back_to_the_shipped_v3_catalog_over_real_ssh() {
    let fixture = start(Behaviour::CatalogWithShippedSessionFacts);
    let sessions = list_sessions_with_facts_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        Duration::from_secs(5),
    )
    .expect("the shipped v3 session-facts catalog remains compatible");

    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_class, RemoteSessionClass::Managed);
    assert_eq!(sessions[0].gateway_build_id, None);
    assert_eq!(sessions[0].launch_program.as_deref(), Some("codex"));
    assert_eq!(sessions[0].host_liveness, Some(RemoteHostLiveness::Live));
    assert!(
        !fixture.observed.requested_pty.load(Ordering::Acquire),
        "session-facts discovery must not request an SSH PTY"
    );
    let documents = fixture
        .observed
        .request_documents
        .lock()
        .expect("request documents lock");
    let versions = documents
        .iter()
        .map(|document| {
            serde_json::from_slice::<serde_json::Value>(&document[4..]).unwrap()
                ["gateway_request_version"]
                .as_u64()
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(versions, vec![6, 4]);
}

#[test]
fn shipped_v3_client_reads_the_current_gateway_compatibility_catalog_over_real_ssh() {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ShippedV3CatalogDocument {
        gateway_catalog_version: u16,
        #[serde(default)]
        forced_command_applied: bool,
        session: serde_json::Value,
    }

    let fixture = start(Behaviour::CatalogWithSessionFacts);
    let mut transport = SshExecDialer::open_halves(config_for(&fixture, &fixture.host_fingerprint))
        .expect("the frozen client opens the gateway");
    let payload = br#"{"gateway_request_version":4,"request":"list_sessions"}"#;
    let mut request = Vec::with_capacity(payload.len() + 4);
    request.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    request.extend_from_slice(payload);
    transport
        .writer
        .write_frame(&request)
        .expect("the frozen v3 listing request is sent");
    transport.writer.close_write().expect("request EOF is sent");

    let mut prefix = [0_u8; 4];
    transport
        .reader
        .read_exact(&mut prefix)
        .expect("the compatibility catalog has a length prefix");
    let mut response = vec![0_u8; u32::from_be_bytes(prefix) as usize];
    transport
        .reader
        .read_exact(&mut response)
        .expect("the compatibility catalog is complete");
    let document = serde_json::from_slice::<ShippedV3CatalogDocument>(&response)
        .expect("the strict shipped v3 envelope accepts the current gateway response");
    assert_eq!(document.gateway_catalog_version, 3);
    assert!(!document.forced_command_applied);
    assert_eq!(document.session["host_liveness"], "live");
    assert!(
        !fixture.observed.requested_pty.load(Ordering::Acquire),
        "the frozen compatibility listing must not request an SSH PTY"
    );
}

#[test]
fn unpresented_creation_abandon_uses_a_typed_v3_no_pty_transaction() {
    let fixture = start(Behaviour::AbandonUnpresentedCreation);
    let receipt = abandon_unpresented_creation_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        RemoteUnpresentedCreationAbandonRequest {
            request_id: "request-1".into(),
            session_id: "remote-session".into(),
            workspace_id: "remote-workspace".into(),
            launch_owner_proof: "launch-proof-1".into(),
        },
        Duration::from_secs(5),
    )
    .expect("the remote gateway returns a typed abandon receipt");

    assert_eq!(receipt.request_id, "request-1");
    assert_eq!(receipt.session_id, "remote-session");
    assert_eq!(receipt.workspace_id, "remote-workspace");
    assert_eq!(
        receipt.receipt.state,
        SessionRetirementReceiptState::Refused
    );
    assert_eq!(
        receipt.receipt.reason,
        Some(SessionRetirementReceiptReason::GenerationChanged)
    );
    assert!(
        !fixture.observed.requested_pty.load(Ordering::Acquire),
        "unpresented creation abandon must not request an SSH PTY"
    );
    let request = fixture.observed.request_bytes.lock().expect("request lock");
    let length = u32::from_be_bytes(request[..4].try_into().unwrap()) as usize;
    assert_eq!(length, request.len() - 4);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&request[4..]).unwrap(),
        serde_json::json!({
            "gateway_request_version": 3,
            "request": {
                "abandon_unpresented_creation": {
                    "request_id": "request-1",
                    "session_id": "remote-session",
                    "workspace_id": "remote-workspace",
                    "launch_owner_proof": "launch-proof-1"
                }
            }
        })
    );
}

#[test]
fn exact_session_input_uses_a_typed_v5_no_pty_transaction() {
    let fixture = start(Behaviour::SessionInput);
    let receipt = write_session_input_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        RemoteSessionInputRequest {
            request_id: "request-input-1".into(),
            expected_fence: SessionFence {
                workspace_id: "remote-workspace".into(),
                session_id: "remote-session".into(),
                runner_principal: "principal".into(),
                runner_instance: "instance".into(),
                channel_epoch: 7,
                host_instance_id: "host-instance".into(),
                terminal_epoch: "terminal-epoch".into(),
            },
            bytes: b"status\r".to_vec(),
        },
        Duration::from_secs(5),
    )
    .expect("the remote gateway returns a written-to-PTY input receipt");

    assert_eq!(receipt.request_id, "request-input-1");
    assert_eq!(receipt.session_id, "remote-session");
    assert_eq!(receipt.workspace_id, "remote-workspace");
    assert_eq!(receipt.receipt.request_id, "external-input-1");
    assert_eq!(receipt.receipt.state, InputReceiptState::WrittenToPty);
    assert!(
        !fixture.observed.requested_pty.load(Ordering::Acquire),
        "exact input must not request an SSH PTY"
    );
    assert_eq!(
        fixture
            .observed
            .exec_command
            .lock()
            .expect("command lock")
            .as_deref(),
        Some(DEFAULT_GATEWAY_COMMAND)
    );
    let request = fixture.observed.request_bytes.lock().expect("request lock");
    let length = u32::from_be_bytes(request[..4].try_into().unwrap()) as usize;
    assert_eq!(length, request.len() - 4);
    let value: serde_json::Value = serde_json::from_slice(&request[4..]).unwrap();
    assert_eq!(value["gateway_request_version"], 5);
    assert_eq!(
        value["request"]["write_session_input"]["request_id"],
        "request-input-1"
    );
    assert_eq!(
        value["request"]["write_session_input"]["expected_fence"]["terminal_epoch"],
        "terminal-epoch"
    );
    assert_eq!(
        value["request"]["write_session_input"]["bytes"],
        serde_json::json!([115, 116, 97, 116, 117, 115, 13])
    );
}

fn managed_create_request() -> ManagedCreateRequest {
    ManagedCreateRequest::new(
        "managed-create-1",
        "managed-session-1",
        "managed-workspace-1",
        "codex",
        PermissionMode::Default,
        "/tmp/managed-work",
        vec!["codex".into()],
        24,
        80,
    )
    .unwrap()
    .with_required_managed_stop_request_version(MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION)
    .unwrap()
}

fn managed_stop_request() -> ManagedStopRequest {
    ManagedStopRequest::new("managed-stop-1", "managed-session-1", "managed-workspace-1")
        .unwrap()
        .with_expected_fence("principal-1", "runner-1", 7, "host-1", "terminal-1")
        .unwrap()
}

fn managed_create_chain_root() -> ManagedCreateReconcileRequest {
    ManagedCreateReconcileRequest::new(
        "managed-create-root-1",
        "managed-session-root-1",
        "managed-workspace-1",
    )
    .unwrap()
}

#[test]
fn remote_managed_create_reconcile_is_identity_only_and_requires_no_pty() {
    let fixture = start(Behaviour::ManagedCreateReconcile);
    let response = reconcile_managed_create_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        ManagedCreateReconcileRequest::new(
            "managed-create-1",
            "managed-session-1",
            "managed-workspace-1",
        )
        .unwrap(),
        Duration::from_secs(5),
    )
    .expect("the remote ledger returns its terminal tombstone");

    assert_eq!(
        response,
        ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
    );
    assert_eq!(
        fixture
            .observed
            .exec_command
            .lock()
            .expect("command lock")
            .as_deref(),
        Some(
            format!(
                "\"$HOME/.local/bin/hmux-runtime\" --no-autostart {MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND}"
            )
            .as_str()
        )
    );
    assert!(!fixture.observed.requested_pty.load(Ordering::Acquire));
    let request = fixture.observed.request_bytes.lock().expect("request lock");
    let value: serde_json::Value = serde_json::from_slice(&request[4..]).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 5);
    assert!(value.get("providerId").is_none());
    assert!(value.get("requestDigest").is_none());
}

#[test]
fn remote_managed_create_reconcile_response_loss_retries_the_same_identity() {
    let request = ManagedCreateReconcileRequest::new(
        "managed-create-1",
        "managed-session-1",
        "managed-workspace-1",
    )
    .unwrap();
    let lost = start(Behaviour::ManagedCreateReconcileNoResponse);
    let error = reconcile_managed_create_over_ssh(
        config_for(&lost, &lost.host_fingerprint),
        request.clone(),
        Duration::from_secs(5),
    )
    .expect_err("a lost typed response must preserve an unknown outcome");
    assert_eq!(
        error.code(),
        "hmux_remote_managed_create_reconcile_outcome_unknown"
    );
    assert!(!lost.observed.requested_pty.load(Ordering::Acquire));

    let replay = start(Behaviour::ManagedCreateReconcile);
    assert_eq!(
        reconcile_managed_create_over_ssh(
            config_for(&replay, &replay.host_fingerprint),
            request,
            Duration::from_secs(5),
        )
        .unwrap(),
        ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
    );
}

#[test]
fn remote_managed_create_advance_preflights_then_uses_one_destructive_no_pty_exec() {
    let fixture = start(Behaviour::ManagedCreateAdvance);
    let request = managed_create_request();
    let resolution = create_managed_or_reconcile_and_advance_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        config_for(&fixture, &fixture.host_fingerprint),
        request.clone(),
        Duration::from_secs(5),
    )
    .expect("the remote ledger returns its persisted successor");
    let RemoteManagedCreateAdvanceResolution::Advanced(receipt) = resolution else {
        panic!("the remote successor must remain distinct from source normalization")
    };
    assert_eq!(receipt.session_id(), "session-successor");
    assert_eq!(
        fixture
            .observed
            .exec_command
            .lock()
            .expect("command lock")
            .as_deref(),
        Some(
            format!(
                "\"$HOME/.local/bin/hmux-runtime\" --no-autostart {MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND}"
            )
            .as_str()
        )
    );
    assert!(!fixture.observed.requested_pty.load(Ordering::Acquire));
    let bytes = fixture.observed.request_bytes.lock().expect("request lock");
    let value: serde_json::Value = serde_json::from_slice(&bytes[4..]).unwrap();
    assert_eq!(value["schema"], "hmux-managed-create-advance-v2");
    assert_eq!(value["schemaVersion"], 2);
    assert_eq!(value["request"]["sessionId"], request.session_id());
    assert_eq!(
        value["request"]["idempotencyKey"],
        request.idempotency_key()
    );
    assert!(!String::from_utf8_lossy(&bytes).contains("session-successor"));
    assert!(!String::from_utf8_lossy(&bytes).contains("create-successor"));
    assert_eq!(
        fixture
            .observed
            .exec_commands
            .lock()
            .expect("commands lock")
            .as_slice(),
        [
            "\"$HOME/.local/bin/hmux-runtime\" --no-autostart hmux-build-info".to_string(),
            format!(
                "\"$HOME/.local/bin/hmux-runtime\" --no-autostart {MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND}"
            ),
        ]
    );
}

#[test]
fn remote_managed_create_advance_refuses_the_legacy_v2_capability_before_destructive_exec() {
    assert_eq!(
        MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND,
        "internal-hmux-managed-create-advance-v3"
    );
    let fixture = start(Behaviour::ManagedCreateAdvanceLegacyCapability);
    let error = create_managed_or_reconcile_and_advance_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        config_for(&fixture, &fixture.host_fingerprint),
        managed_create_request(),
        Duration::from_secs(5),
    )
    .expect_err("the pre-atomic v2 runtime must be fenced before create advance");
    assert_eq!(error.code(), "hmux_remote_runtime_update_required");
    assert_eq!(
        fixture
            .observed
            .exec_commands
            .lock()
            .expect("commands lock")
            .as_slice(),
        ["\"$HOME/.local/bin/hmux-runtime\" --no-autostart hmux-build-info".to_string()]
    );
    assert!(
        fixture
            .observed
            .request_bytes
            .lock()
            .expect("request lock")
            .is_empty()
    );
    assert!(!fixture.observed.requested_pty.load(Ordering::Acquire));
}

#[test]
fn remote_managed_create_negotiates_stop_before_launch_and_stops_without_a_pty() {
    let create_fixture = start(Behaviour::ManagedCreate);
    let created = create_managed_over_ssh(
        config_for(&create_fixture, &create_fixture.host_fingerprint),
        managed_create_request(),
        Duration::from_secs(5),
    )
    .expect("the lifecycle-compatible runtime creates the provider");
    assert_eq!(created.outcome(), ManagedCreateOutcome::Created);
    assert_eq!(
        created
            .generation_fence()
            .expect("remote receipt generation")
            .terminal_epoch(),
        "terminal-1"
    );
    assert_eq!(
        create_fixture
            .observed
            .exec_command
            .lock()
            .expect("command lock")
            .as_deref(),
        Some(
            format!(
                "\"$HOME/.local/bin/hmux-runtime\" --no-autostart {MANAGED_CREATE_BROKER_SUBCOMMAND}"
            )
            .as_str()
        )
    );
    assert!(
        !create_fixture
            .observed
            .requested_pty
            .load(Ordering::Acquire)
    );
    let create_bytes = create_fixture
        .observed
        .request_bytes
        .lock()
        .expect("request lock");
    let create_json: serde_json::Value = serde_json::from_slice(&create_bytes[4..]).unwrap();
    assert_eq!(create_json["schemaVersion"], 3);
    assert_eq!(create_json["requiredManagedStopRequestVersion"], 3);
    drop(create_bytes);

    let stop_fixture = start(Behaviour::ManagedStop);
    let stopped = stop_managed_over_ssh(
        config_for(&stop_fixture, &stop_fixture.host_fingerprint),
        managed_stop_request(),
        Duration::from_secs(5),
    )
    .expect("the exact complete-fence stop succeeds");
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
    assert_eq!(
        stop_fixture
            .observed
            .exec_command
            .lock()
            .expect("command lock")
            .as_deref(),
        Some(
            format!(
                "\"$HOME/.local/bin/hmux-runtime\" --no-autostart {MANAGED_STOP_BROKER_SUBCOMMAND}"
            )
            .as_str()
        )
    );
    assert!(!stop_fixture.observed.requested_pty.load(Ordering::Acquire));
}

#[test]
fn remote_managed_create_receipt_loss_is_ambiguous_not_a_request_failure() {
    let fixture = start(Behaviour::ManagedCreateNoReceipt);

    let error = create_managed_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        managed_create_request(),
        Duration::from_secs(5),
    )
    .expect_err("missing receipt cannot prove that remote create was not admitted");

    assert_eq!(error.code(), "hmux_remote_managed_create_outcome_unknown");
    assert!(error.to_string().contains("no receipt"));
}

#[test]
fn remote_managed_create_preserves_exact_conversation_writer_conflict() {
    let fixture = start(Behaviour::ManagedCreateConversationConflict);

    let error = create_managed_or_reconcile_over_ssh(
        || config_for(&fixture, &fixture.host_fingerprint),
        managed_create_request(),
        Duration::from_secs(5),
    )
    .expect_err("the remote Host must preserve exact conversation ownership");

    assert_eq!(error.code(), MANAGED_CONVERSATION_WRITER_CONFLICT_CODE);
    assert!(!fixture.observed.requested_pty.load(Ordering::Acquire));
}

#[test]
fn remote_managed_create_composes_only_the_typed_digest_conflict() {
    let fixture = start(Behaviour::ManagedCreateDigestConflictThenReconcile);

    let resolution = create_managed_or_reconcile_over_ssh(
        || config_for(&fixture, &fixture.host_fingerprint),
        managed_create_request(),
        Duration::from_secs(5),
    )
    .expect("the typed digest conflict must enter identity-only reconciliation");

    assert!(matches!(
        resolution,
        RemoteManagedCreateResolution::AbandonedBeforeCompletion
    ));
    let documents = fixture
        .observed
        .request_documents
        .lock()
        .expect("request documents lock");
    assert_eq!(documents.len(), 2);
    let reconcile: serde_json::Value = serde_json::from_slice(&documents[1][4..]).unwrap();
    assert_eq!(reconcile.as_object().unwrap().len(), 5);
    assert!(reconcile.get("providerId").is_none());
    assert!(reconcile.get("requestDigest").is_none());
}

#[test]
fn remote_managed_create_projects_exact_tombstone_as_typed_retirement() {
    let fixture = start(Behaviour::ManagedCreateRetired);

    let resolution = create_managed_or_reconcile_over_ssh(
        || config_for(&fixture, &fixture.host_fingerprint),
        managed_create_request(),
        Duration::from_secs(5),
    )
    .expect("an exact tombstone must be a typed terminal resolution");

    assert!(matches!(resolution, RemoteManagedCreateResolution::Retired));
    assert_eq!(
        fixture
            .observed
            .request_documents
            .lock()
            .expect("request documents lock")
            .len(),
        1,
        "an exact tombstone must not invoke identity reconciliation"
    );
}

#[test]
fn remote_managed_create_refuses_changed_ssh_authority_before_reconcile_exec() {
    let fixture = start(Behaviour::ManagedCreateDigestConflictThenReconcile);
    let mut calls = 0;

    let error = create_managed_or_reconcile_over_ssh(
        || {
            let mut config = config_for(&fixture, &fixture.host_fingerprint);
            if calls == 1 {
                config.user = "another-user".into();
            }
            calls += 1;
            config
        },
        managed_create_request(),
        Duration::from_secs(5),
    )
    .expect_err("identity reconcile must stay on the create authority");

    assert_eq!(
        error.code(),
        "hmux_remote_managed_create_reconcile_authority_inconsistent"
    );
    assert_eq!(
        fixture
            .observed
            .request_documents
            .lock()
            .expect("request documents lock")
            .len(),
        1,
        "the changed authority must be rejected before a second SSH exec"
    );
}

#[test]
fn remote_managed_stop_receipt_loss_is_ambiguous_not_success() {
    let fixture = start(Behaviour::ManagedStopNoReceipt);

    let error = stop_managed_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        managed_stop_request(),
        Duration::from_secs(5),
    )
    .expect_err("missing receipt cannot be inferred as successful stop");

    assert_eq!(error.code(), "hmux_remote_managed_stop_outcome_unknown");
    assert!(error.to_string().contains("no receipt"));
}

#[test]
fn remote_managed_create_chain_stop_preflights_and_stops_without_a_pty() {
    let fixture = start(Behaviour::ManagedCreateChainStop);
    let receipt = stop_managed_create_chain_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        config_for(&fixture, &fixture.host_fingerprint),
        managed_create_chain_root(),
        Duration::from_secs(5),
    )
    .expect("the remote runtime closes and stops the successor chain");

    assert_eq!(receipt.root(), &managed_create_chain_root());
    assert_eq!(
        receipt.effective().session_id(),
        "managed-session-successor-1"
    );
    assert_eq!(
        receipt
            .stop_receipt()
            .expect("the effective generation was stopped")
            .session_id(),
        "managed-session-successor-1"
    );
    assert!(!fixture.observed.requested_pty.load(Ordering::Acquire));
    assert_eq!(
        *fixture
            .observed
            .exec_commands
            .lock()
            .expect("commands lock"),
        vec![
            "\"$HOME/.local/bin/hmux-runtime\" --no-autostart hmux-build-info".to_string(),
            format!(
                "\"$HOME/.local/bin/hmux-runtime\" --no-autostart {MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND}"
            ),
        ]
    );
    let documents = fixture
        .observed
        .request_documents
        .lock()
        .expect("request documents lock");
    assert_eq!(documents.len(), 1);
    let root: ManagedCreateReconcileRequest =
        serde_json::from_slice(&documents[0][4..]).expect("chain-stop root decodes");
    assert_eq!(root, managed_create_chain_root());
}

#[test]
fn remote_managed_create_chain_stop_v2_returns_ordered_chain_without_a_pty() {
    let fixture = start(Behaviour::ManagedCreateChainStop);
    let receipt = stop_managed_create_chain_v2_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        config_for(&fixture, &fixture.host_fingerprint),
        managed_create_chain_root(),
        Duration::from_secs(5),
    )
    .expect("the v2 remote runtime returns its ordered successor chain");

    assert_eq!(receipt.root(), &managed_create_chain_root());
    assert_eq!(receipt.chain().len(), 2);
    assert_eq!(
        receipt.effective().session_id(),
        "managed-session-successor-1"
    );
    assert!(!fixture.observed.requested_pty.load(Ordering::Acquire));
    assert_eq!(
        *fixture
            .observed
            .exec_commands
            .lock()
            .expect("commands lock"),
        vec![
            "\"$HOME/.local/bin/hmux-runtime\" --no-autostart hmux-build-info".to_string(),
            format!(
                "\"$HOME/.local/bin/hmux-runtime\" --no-autostart {MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2}"
            ),
        ]
    );
}

#[test]
fn remote_managed_create_chain_stop_never_falls_back_without_capability() {
    let fixture = start(Behaviour::ManagedCreateChainStopCapabilityMissing);
    let error = stop_managed_create_chain_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        config_for(&fixture, &fixture.host_fingerprint),
        managed_create_chain_root(),
        Duration::from_secs(5),
    )
    .expect_err("an old runtime cannot safely emulate logical chain stop");

    assert_eq!(error.code(), "hmux_remote_runtime_update_required");
    assert_eq!(
        *fixture
            .observed
            .exec_commands
            .lock()
            .expect("commands lock"),
        vec!["\"$HOME/.local/bin/hmux-runtime\" --no-autostart hmux-build-info".to_string()]
    );
    assert!(
        fixture
            .observed
            .request_documents
            .lock()
            .expect("request documents lock")
            .is_empty(),
        "missing capability must not trigger a destructive exact-stop fallback"
    );
}

#[test]
fn remote_managed_create_chain_stop_v2_does_not_fall_back_to_v1() {
    let fixture = start(Behaviour::ManagedCreateChainStopV2CapabilityMissing);
    let error = stop_managed_create_chain_v2_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        config_for(&fixture, &fixture.host_fingerprint),
        managed_create_chain_root(),
        Duration::from_secs(5),
    )
    .expect_err("a v1-only runtime cannot supply an ordered chain receipt");

    assert_eq!(error.code(), "hmux_remote_runtime_update_required");
    assert!(
        error
            .to_string()
            .contains(MANAGED_CREATE_CHAIN_STOP_CAPABILITY_V2)
    );
    assert_eq!(
        *fixture
            .observed
            .exec_commands
            .lock()
            .expect("commands lock"),
        vec!["\"$HOME/.local/bin/hmux-runtime\" --no-autostart hmux-build-info".to_string()]
    );
    assert!(
        fixture
            .observed
            .request_documents
            .lock()
            .expect("request documents lock")
            .is_empty(),
        "missing v2 capability must not call either destructive broker"
    );
}

#[test]
fn remote_managed_stop_rejects_a_receipt_with_a_changed_runner_fence() {
    let fixture = start(Behaviour::ManagedStopWrongRunnerFence);

    let error = stop_managed_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        managed_stop_request(),
        Duration::from_secs(5),
    )
    .expect_err("a changed runner fence cannot acknowledge the exact stop");

    assert_eq!(error.code(), "hmux_remote_managed_stop_outcome_unknown");
    assert!(error.to_string().contains("exact request fence"));
}

#[test]
fn remote_managed_stop_reconcile_requires_no_pty() {
    let fixture = start(Behaviour::ManagedStopReconcile);
    let receipt = reconcile_managed_stop_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        ManagedStopReconcileRequest::from_stop_request(&managed_stop_request()).unwrap(),
        Duration::from_secs(5),
    )
    .expect("the durable stop receipt replays without catalog state");

    assert_eq!(receipt.outcome(), ManagedStopOutcome::Stopped);
    assert_eq!(
        fixture
            .observed
            .exec_command
            .lock()
            .expect("command lock")
            .as_deref(),
        Some(
            format!(
                "\"$HOME/.local/bin/hmux-runtime\" --no-autostart {MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND}"
            )
            .as_str()
        )
    );
    assert!(!fixture.observed.requested_pty.load(Ordering::Acquire));
}

#[test]
fn remote_managed_stop_reconcile_rejects_a_changed_runner_fence() {
    let fixture = start(Behaviour::ManagedStopReconcileWrongRunnerFence);
    let error = reconcile_managed_stop_over_ssh(
        config_for(&fixture, &fixture.host_fingerprint),
        ManagedStopReconcileRequest::from_stop_request(&managed_stop_request()).unwrap(),
        Duration::from_secs(5),
    )
    .expect_err("reconcile cannot replay a receipt for another runner generation");

    assert_eq!(error.code(), "hmux_remote_managed_stop_outcome_unknown");
    assert!(error.to_string().contains("generation fence"));
}

/// A relayed transport proves nothing about where the peer is, and the type
/// system is what has to say so: no colocation witness is reachable, for any
/// session, so the operations that signal pids cannot compile against it.
///
/// The variant itself is asserted, not only its answer. `SshExecDialer::open`
/// is `pub` and not test-gated, so a shipped dialer reporting `Simulated` --
/// documented as something no shipped dialer produces -- would leave a false
/// invariant written down for whoever builds the next gate on it. Both variants
/// refuse today, so nothing but this assertion can tell them apart.
#[test]
fn a_relayed_transport_yields_no_colocation_witness() {
    use hmux_client::{PeerAttestation, SessionScope};

    let fixture = start(Behaviour::Echo);
    let transport = SshExecDialer::open(config_for(&fixture, &fixture.host_fingerprint))
        .expect("the transport opens");

    assert!(matches!(transport.attestation(), PeerAttestation::Relayed));
    assert!(!transport.attestation().is_colocated());
    assert!(
        transport
            .attestation()
            .witness_for(&SessionScope::new("workspace-1", "session-1", "host-1"))
            .is_err()
    );
}

/// The failure a real deployment hits first. Without stream 2 this is an empty
/// pipe that closed for no stated reason, and the user has nothing to act on.
#[test]
fn a_missing_gateway_reports_its_stderr_rather_than_an_empty_pipe() {
    let fixture = start(Behaviour::NotInstalled);
    let codec = codec();

    let mut transport = SshExecDialer::open_halves(config_for(&fixture, &fixture.host_fingerprint))
        .expect("sshd accepted the exec; the command is what failed");

    let error = transport
        .reader
        .read_frame(&codec)
        .expect_err("a gateway that never started is not a clean detach");
    let message = error.to_string();
    assert!(
        message.contains("command not found"),
        "unexpected message {message}"
    );
    assert!(message.contains("127"), "unexpected message {message}");
}

/// Host key pinning is the only mode this transport has. A relay carries a
/// session's entire input stream, so accepting whoever answers the address
/// hands that stream to whoever answers the address.
#[test]
fn an_unpinned_host_key_is_refused() {
    let fixture = start(Behaviour::Echo);
    let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .expect("another key")
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();

    let error = SshExecDialer::open(config_for(&fixture, &other))
        .expect_err("an unpinned host key must not connect");

    match &error {
        SshTransportError::HostKeyRejected { fingerprint } => {
            // Naming what was offered is what makes a rebuilt box actionable
            // rather than mysterious.
            assert_eq!(fingerprint, &fixture.host_fingerprint);
        }
        other => panic!("expected a host key refusal, got {other}"),
    }
    assert_eq!(error.code(), "hmux_ssh_host_key_rejected");
}

#[test]
fn host_key_observation_stops_before_opening_an_exec_channel() {
    let fixture = start(Behaviour::Echo);

    let observed = observe_server_host_key(
        SshEndpoint {
            host: "127.0.0.1".to_string(),
            port: fixture.port,
        },
        Duration::from_secs(2),
    )
    .unwrap();

    assert_eq!(observed.algorithm(), "ssh-ed25519");
    assert_eq!(observed.fingerprint(), fixture.host_fingerprint);
    assert!(
        !fixture
            .observed
            .authentication_attempted
            .load(Ordering::Acquire)
    );
    assert!(fixture.observed.exec_command.lock().unwrap().is_none());
    assert!(fixture.observed.request_bytes.lock().unwrap().is_empty());
}
