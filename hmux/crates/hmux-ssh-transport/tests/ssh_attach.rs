//! The whole chain, in one process: a real SSH server, a real exec channel, the
//! real pump, the real transport seam, and the real client handshake.
//!
//! This is a client-side transport test, not an end-to-end test against
//! `hmux mobile-gateway`; the gateway has its own real local-client relay tests.
//! The far end here is a scripted Host: a russh server
//! that reads the client's `Hello` off stream 0 and answers with a `HelloAck`, a
//! `ScreenSnapshot` and `OutputDelta` frames, exactly as `hmux-runtime`'s
//! `serve_client` would.
//!
//! What that leaves untested is one edge: whether the program sshd runs speaks
//! this protocol. Everything on this side of it — authentication, host key
//! pinning, the exec request, the frame pump, the attestation, the handshake,
//! the fence check and the output stream — is the shipped code.
//!
//! Keeping the carrier and gateway fixtures separate makes each failure local:
//! this suite diagnoses SSH chunking and handshake faults, while the gateway
//! suite diagnoses local attach and relay admission faults.

use hmux_client::{ObserverLifecycle, SessionRetirementPolicy};
use hmux_runtime_contract::{
    TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BASE_PROTOCOL_MINOR,
    TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
};
use hmux_session_protocol::{
    AGENT_PROMPT_CAPABILITY, AttachMode, AuthorizationPosture, FrameBody, FrameCodec, FrameLimits,
    Hello, HelloAck, LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY, LifecycleState,
    MANAGED_AUTHORIZATION_GRANT_CAPABILITY, OutputDelta, PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
    PROTOCOL_V1, ProcessProof, RECONNECT_RESUME_CAPABILITY, ReconnectCursor,
    SESSION_RETIREMENT_CAPABILITY, ScreenSnapshot, ScreenSnapshotEncoding, SessionFence,
    SessionRetirementAction, SessionRetirementReceipt, SessionRetirementReceiptState,
    SessionRetirementRequest, WireFrame,
};
use hmux_ssh_transport::{
    AttachError, AttachReplay, ClientError, DEFAULT_GATEWAY_COMMAND, HostKeyPolicy,
    LocalAttachRole, OutputBudget, OutputStop, PeerAttestation, RemoteAttach, SshAuthentication,
    SshEndpoint, SshExecConfig, TerminalSurfaceAccess, TerminalSurfaceEvent,
    attach_agent_prompt_over_ssh, attach_controller_over_ssh, attach_observer_over_ssh,
    attach_over_ssh, attach_terminal_surface_over_ssh, depart_gracefully_over_ssh, relay_output,
};
use russh::keys::{Algorithm, HashAlg, PrivateKey, ssh_key};
use russh::server::{Auth, ChannelOpenHandle, Handler, Msg, Server, Session};
use russh::{Channel, ChannelId};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use terminal_state_protocol::{
    BellEvent, BufferId, CellStyle, Grapheme, InputModes, InputReceipt, InputWrittenToPty,
    MouseEncoding, MouseTrackingMode, ResizeAppliedToTerminal, ResizeReceipt, RowTermination,
    TerminalCell, TerminalColorOverrides, TerminalEvent, TerminalRow, TerminalStateRecord,
    TerminalTables, UnderlineKind, UnicodeWidthProfile, ViewportAnchorStatus, ViewportFrame,
    agent_prompt_input_intent, decode_record, encode_record, input_intent, input_receipt,
    resize_receipt, terminal_event, terminal_state_record, viewport_intent,
};

const SCREEN: &[u8] = b"agent> waiting\r\n";
const DELTA_ONE: &[u8] = b"agent> building the thing\r\n";
const DELTA_TWO: &[u8] = b"agent> done\r\n";

fn fence() -> SessionFence {
    SessionFence {
        workspace_id: "workspace-1".to_string(),
        session_id: "session-1".to_string(),
        runner_principal: "local-user".to_string(),
        runner_instance: "runner-1".to_string(),
        channel_epoch: 7,
        host_instance_id: "host-1".to_string(),
        terminal_epoch: "terminal-1".to_string(),
    }
}

fn codec() -> FrameCodec {
    FrameCodec::new(FrameLimits::default())
}

fn framed_terminal(payload: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    framed.extend_from_slice(payload);
    framed
}

fn terminal_viewport_record(
    projection_revision: u64,
    state_revision: u64,
    applied_intent_seq: u64,
) -> TerminalStateRecord {
    TerminalStateRecord {
        schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
        terminal_epoch: fence().terminal_epoch,
        through_output_seq: 1,
        state_revision,
        body: Some(terminal_state_record::Body::ViewportFrame(ViewportFrame {
            projection_revision,
            damage_base_projection_revision: 0,
            canonical_columns: 1,
            viewport_rows: 1,
            active_buffer: BufferId::Normal as i32,
            rows: vec![TerminalRow {
                row_id: state_revision,
                continues_from_previous: false,
                cells: vec![TerminalCell {
                    grapheme_index: 0,
                    style_index: 0,
                }],
                termination: RowTermination::HardBreak as i32,
                logical_line_id: state_revision,
                logical_cell_offset: 0,
                logical_cell_span: 1,
            }],
            tables: Some(TerminalTables {
                graphemes: vec![Grapheme {
                    text: "x".into(),
                    display_width: 1,
                }],
                styles: vec![CellStyle {
                    underline: UnderlineKind::None as i32,
                    ..CellStyle::default()
                }],
                hyperlinks: Vec::new(),
            }),
            cursor: None,
            input_modes: Some(InputModes {
                mouse_tracking: MouseTrackingMode::None as i32,
                mouse_encoding: MouseEncoding::Default as i32,
                ..InputModes::default()
            }),
            color_overrides: Some(TerminalColorOverrides::default()),
            unicode_width: Some(UnicodeWidthProfile {
                unicode_version: "test".into(),
                ambiguous_width: 1,
                emoji_width: 2,
            }),
            through_event_id: 1,
            title: "remote surface".into(),
            working_directory_uri: String::new(),
            follow_tail: true,
            has_more_before: false,
            has_more_after: false,
            changed_row_indices: Vec::new(),
            applied_intent_seq,
            anchor_status: ViewportAnchorStatus::FollowTail as i32,
            rows_from_tail: Some(0),
            input_output_timing: None,
        })),
    }
}

fn terminal_event_record() -> TerminalStateRecord {
    TerminalStateRecord {
        schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
        terminal_epoch: fence().terminal_epoch,
        through_output_seq: 1,
        state_revision: 2,
        body: Some(terminal_state_record::Body::Event(TerminalEvent {
            event_id: 1,
            event: Some(terminal_event::Event::Bell(BellEvent {})),
        })),
    }
}

fn take_complete_payloads(inbound: &Mutex<Vec<u8>>, data: &[u8]) -> Vec<Vec<u8>> {
    let mut buffered = inbound.lock().expect("inbound lock");
    buffered.extend_from_slice(data);
    let mut payloads = Vec::new();
    loop {
        if buffered.len() < 4 {
            break;
        }
        let length = u32::from_be_bytes(buffered[..4].try_into().unwrap()) as usize;
        if buffered.len() < 4 + length {
            break;
        }
        let framed: Vec<u8> = buffered.drain(..4 + length).collect();
        payloads.push(framed[4..].to_vec());
    }
    payloads
}

/// What the scripted Host grants in its `HelloAck`.
#[derive(Clone, Copy)]
enum Grant {
    /// An ordinary read-only remote observer: the capability this migration is
    /// supposed to deliver first.
    ObserverOnly,
    /// A generation-fenced controller grant suitable for the IDE adapter.
    Controller,
    /// A Host that hands a relayed client a PTY write that takes no lease.
    /// Nothing arbitrates it and its entire justification is "same user, same
    /// machine", so the client must refuse the attach it just completed.
    SharedTerminalInput,
    /// A fence that names a different session. The Host answering is real, the
    /// session is not the one asked for.
    WrongFence,
    /// A current Host that accepts a reconnect cursor and sends only the
    /// retained deltas that follow it.
    Resume,
    /// A Host that accepts an explicit, typed retirement departure from a
    /// short-lived observer without requiring the controller lease.
    Retirement,
    /// A Host that serves one bounded semantic terminal surface. It grants
    /// input only when the observer explicitly requested the relay-safe cap.
    TerminalSurface,
}

#[derive(Clone)]
struct ScriptedHost {
    grant: Grant,
    /// The `Hello` the client actually sent, so the test can assert on it
    /// rather than trust that the handshake happened.
    observed_hello: Arc<Mutex<Option<Hello>>>,
    observed_retirement: Arc<Mutex<Option<SessionRetirementRequest>>>,
    observed_attach_count: Arc<AtomicUsize>,
    observed_commands: Arc<Mutex<Vec<String>>>,
    observed_terminal: Arc<Mutex<Vec<Vec<u8>>>>,
    /// Stream 0 accumulates across channel data messages; SSH is free to chop
    /// wherever its window falls and a frame does not respect those boundaries.
    inbound: Arc<Mutex<Vec<u8>>>,
}

impl Server for ScriptedHost {
    type Handler = Self;

    fn new_client(&mut self, _peer: Option<SocketAddr>) -> Self {
        self.clone()
    }
}

impl Handler for ScriptedHost {
    type Error = russh::Error;

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &ssh_key::PublicKey,
    ) -> Result<Auth, Self::Error> {
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

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.observed_commands
            .lock()
            .expect("command lock")
            .push(String::from_utf8_lossy(command).into_owned());
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let payloads = take_complete_payloads(&self.inbound, data);
        for payload in payloads {
            if payload.starts_with(&terminal_state_protocol::ENVELOPE_MAGIC) {
                self.handle_terminal(channel, payload, session)?;
                continue;
            }
            let Ok(decoded) = codec().decode_payload_for_dispatch(&payload) else {
                continue;
            };
            let Ok(frame) = decoded.into_valid() else {
                continue;
            };
            match frame.body {
                FrameBody::Hello(hello) => {
                    self.observed_attach_count.fetch_add(1, Ordering::AcqRel);
                    *self.observed_hello.lock().expect("hello lock") = Some(hello.clone());
                    for reply in self.script(&hello) {
                        session.data(channel, reply)?;
                    }
                }
                FrameBody::SessionRetirementRequest(request)
                    if matches!(self.grant, Grant::Retirement) =>
                {
                    *self.observed_retirement.lock().expect("retirement lock") =
                        Some(request.clone());
                    session.data(
                        channel,
                        codec()
                            .encode(&WireFrame {
                                protocol_version: PROTOCOL_V1,
                                frame_id: 5,
                                body: FrameBody::SessionRetirementReceipt(
                                    SessionRetirementReceipt {
                                        request_id: request.request_id,
                                        state: SessionRetirementReceiptState::RetirementArmed,
                                        reason: None,
                                        policy: Some(retirement_policy()),
                                    },
                                ),
                            })
                            .expect("retirement receipt encodes"),
                    )?;
                }
                _ => {}
            }
        }
        Ok(())
    }
}

impl ScriptedHost {
    fn script(&self, hello: &Hello) -> Vec<Vec<u8>> {
        let (capabilities, actual_fence, current_output_seq, lifecycle) = match self.grant {
            Grant::ObserverOnly => (
                vec!["screen_snapshot".to_string(), "live_output".to_string()],
                fence(),
                1,
                LifecycleState::Observing,
            ),
            Grant::Controller => (
                vec![
                    "screen_snapshot".to_string(),
                    "live_output".to_string(),
                    "terminal_input".to_string(),
                    "terminal_resize".to_string(),
                    "terminal_control".to_string(),
                ],
                fence(),
                1,
                LifecycleState::Controlling,
            ),
            Grant::SharedTerminalInput => (
                vec![
                    "screen_snapshot".to_string(),
                    "live_output".to_string(),
                    "terminal_input".to_string(),
                    "terminal_resize".to_string(),
                    "shared_terminal_input".to_string(),
                ],
                fence(),
                1,
                LifecycleState::Controlling,
            ),
            Grant::WrongFence => (
                vec!["screen_snapshot".to_string(), "live_output".to_string()],
                SessionFence {
                    session_id: "a-different-session".to_string(),
                    ..fence()
                },
                1,
                LifecycleState::Observing,
            ),
            Grant::Resume => (
                vec![
                    "screen_snapshot".to_string(),
                    "live_output".to_string(),
                    RECONNECT_RESUME_CAPABILITY.to_string(),
                ],
                fence(),
                3,
                LifecycleState::Observing,
            ),
            Grant::Retirement => (
                vec![
                    "screen_snapshot".to_string(),
                    "live_output".to_string(),
                    SESSION_RETIREMENT_CAPABILITY.to_string(),
                ],
                fence(),
                1,
                LifecycleState::Observing,
            ),
            Grant::TerminalSurface => {
                let mut capabilities = vec![
                    "screen_snapshot".to_string(),
                    "live_output".to_string(),
                    TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
                    TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
                ];
                if hello
                    .requested_capabilities
                    .iter()
                    .any(|capability| capability == TERMINAL_VIEWPORT_WHEEL_CAPABILITY)
                {
                    capabilities.push(TERMINAL_VIEWPORT_WHEEL_CAPABILITY.to_string());
                }
                let targeted_agent_prompt = hello
                    .requested_capabilities
                    .iter()
                    .any(|capability| capability == AGENT_PROMPT_CAPABILITY);
                if !targeted_agent_prompt
                    && hello
                        .requested_capabilities
                        .iter()
                        .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY)
                {
                    capabilities.push(TERMINAL_INPUT_INTENT_CAPABILITY.to_string());
                }
                if targeted_agent_prompt {
                    capabilities.push(AGENT_PROMPT_CAPABILITY.to_string());
                }
                if hello
                    .requested_capabilities
                    .iter()
                    .any(|capability| capability == PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY)
                {
                    capabilities.push(PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY.to_string());
                }
                (capabilities, fence(), 1, LifecycleState::Observing)
            }
        };

        let ack = HelloAck {
            selected_version: PROTOCOL_V1,
            selected_capabilities: capabilities,
            actual_fence: actual_fence.clone(),
            host_build_version: "scripted-host".to_string(),
            lifecycle,
            host_process: ProcessProof {
                process_id: 4242,
                start_marker: "scripted-host-start".to_string(),
            },
            provider_process: None,
            earliest_retained_output_seq: 1,
            current_output_seq,
            controller_generation: 1,
            authorization_posture: AuthorizationPosture::StandaloneLocalOwner,
        };
        let snapshot = ScreenSnapshot {
            fence: actual_fence.clone(),
            sequence_through: 1,
            rows: 24,
            columns: 80,
            encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
            controller_input_pending: None,
            semantic_idle_ms: None,
            repaint_bytes: SCREEN.to_vec(),
            alternate_screen: false,
            cursor_visible: true,
            truncated: false,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
            agent_runtime_state: None,
            provider_conversation_identity: None,
            actual_profile: None,
            in_reply_to_request_id: None,
            recovered_presentation: None,
        };
        let mut replies = vec![
            codec()
                .encode(&WireFrame {
                    protocol_version: PROTOCOL_V1,
                    frame_id: 1,
                    body: FrameBody::HelloAck(ack),
                })
                .expect("hello ack encodes"),
        ];
        if matches!(self.grant, Grant::TerminalSurface) {
            replies.push(framed_terminal(
                &encode_record(1, &terminal_viewport_record(1, 1, 1))
                    .expect("terminal seed encodes"),
            ));
            replies.push(framed_terminal(
                &encode_record(2, &terminal_event_record()).expect("terminal event encodes"),
            ));
            return replies;
        }

        let mut frames = Vec::new();
        if !matches!(self.grant, Grant::Resume) {
            frames.push(WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 2,
                body: FrameBody::ScreenSnapshot(snapshot),
            });
        } else {
            assert_eq!(
                hello
                    .reconnect_cursor
                    .as_ref()
                    .map(|cursor| cursor.after_output_seq),
                Some(1),
                "the resume fixture requires the client to offer its exact cursor"
            );
        }
        for (offset, bytes) in [DELTA_ONE, DELTA_TWO].into_iter().enumerate() {
            frames.push(WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 3 + offset as u64,
                body: FrameBody::OutputDelta(OutputDelta {
                    terminal_epoch: actual_fence.terminal_epoch.clone(),
                    output_seq: 2 + offset as u64,
                    bytes: bytes.to_vec(),
                    rows: None,
                    columns: None,
                    working_directory: None,
                    execution_location: None,
                    agent_identity: None,
                }),
            });
        }
        replies.extend(
            frames
                .into_iter()
                .map(|frame| codec().encode(&frame).expect("scripted frame encodes")),
        );
        replies
    }

    fn handle_terminal(
        &self,
        channel: ChannelId,
        payload: Vec<u8>,
        session: &mut Session,
    ) -> Result<(), russh::Error> {
        self.observed_terminal
            .lock()
            .expect("terminal lock")
            .push(payload.clone());
        let decoded = decode_record(&payload).expect("client terminal record decodes");
        let reply = match decoded.record.body {
            Some(terminal_state_record::Body::ViewportIntent(intent)) => {
                let record = terminal_viewport_record(2, 2, intent.intent_seq);
                encode_record(100 + decoded.metadata.record_id, &record)
                    .expect("viewport acknowledgement encodes")
            }
            Some(terminal_state_record::Body::InputIntent(intent)) => {
                let body = match intent.intent {
                    Some(input_intent::Intent::Resize(resize)) => {
                        terminal_state_record::Body::ResizeReceipt(ResizeReceipt {
                            in_reply_to_record_id: decoded.metadata.record_id,
                            outcome: Some(resize_receipt::Outcome::AppliedToTerminal(
                                ResizeAppliedToTerminal {
                                    columns: resize.columns,
                                    rows: resize.rows,
                                },
                            )),
                        })
                    }
                    Some(input_intent::Intent::AgentPrompt(_)) => {
                        terminal_state_record::Body::InputReceipt(InputReceipt {
                            in_reply_to_record_id: decoded.metadata.record_id,
                            outcome: Some(input_receipt::Outcome::WrittenToPty(
                                InputWrittenToPty {
                                    input_baseline_output_sequence: Some(1),
                                    agent_runtime_revision: Some(7),
                                },
                            )),
                        })
                    }
                    _ => terminal_state_record::Body::InputReceipt(InputReceipt {
                        in_reply_to_record_id: decoded.metadata.record_id,
                        outcome: Some(input_receipt::Outcome::WrittenToPty(
                            InputWrittenToPty::default(),
                        )),
                    }),
                };
                encode_record(
                    100 + decoded.metadata.record_id,
                    &TerminalStateRecord {
                        schema_minor: u32::from(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
                        terminal_epoch: fence().terminal_epoch,
                        through_output_seq: 1,
                        state_revision: 2 + decoded.metadata.record_id,
                        body: Some(body),
                    },
                )
                .expect("terminal receipt encodes")
            }
            _ => panic!("unexpected upstream terminal record"),
        };
        session.data(channel, framed_terminal(&reply))?;
        Ok(())
    }
}

struct Fixture {
    port: u16,
    host_fingerprint: String,
    client_key: String,
    observed_hello: Arc<Mutex<Option<Hello>>>,
    observed_retirement: Arc<Mutex<Option<SessionRetirementRequest>>>,
    observed_attach_count: Arc<AtomicUsize>,
    observed_commands: Arc<Mutex<Vec<String>>>,
    observed_terminal: Arc<Mutex<Vec<Vec<u8>>>>,
}

fn retirement_policy() -> SessionRetirementPolicy {
    SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
        grace_period_ms: 2_000,
    }
}

fn start(grant: Grant) -> Fixture {
    start_with_connections(grant, 1)
}

fn start_with_connections(grant: Grant, connection_count: usize) -> Fixture {
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

    let observed_hello = Arc::new(Mutex::new(None));
    let observed_retirement = Arc::new(Mutex::new(None));
    let observed_attach_count = Arc::new(AtomicUsize::new(0));
    let observed_commands = Arc::new(Mutex::new(Vec::new()));
    let observed_terminal = Arc::new(Mutex::new(Vec::new()));
    let (ready, port) = std::sync::mpsc::sync_channel(1);
    let host_observed = Arc::clone(&observed_hello);
    let host_retirement = Arc::clone(&observed_retirement);
    let host_attach_count = Arc::clone(&observed_attach_count);
    let host_commands = Arc::clone(&observed_commands);
    let host_terminal = Arc::clone(&observed_terminal);
    thread::Builder::new()
        .name("scripted-hmux-host".to_string())
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
                let mut server = ScriptedHost {
                    grant,
                    observed_hello: host_observed,
                    observed_retirement: host_retirement,
                    observed_attach_count: host_attach_count,
                    observed_commands: host_commands,
                    observed_terminal: host_terminal,
                    inbound: Arc::new(Mutex::new(Vec::new())),
                };
                let mut sessions = Vec::with_capacity(connection_count);
                for _ in 0..connection_count {
                    let (stream, _peer) = listener.accept().await.expect("connection");
                    let session = russh::server::run_stream(
                        Arc::clone(&config),
                        stream,
                        server.new_client(None),
                    )
                    .await
                    .expect("server session");
                    sessions.push(session);
                }
                for session in sessions {
                    let _ = session.await;
                }
            });
        })
        .expect("server thread");

    Fixture {
        port: port.recv().expect("the server reports its port"),
        host_fingerprint,
        client_key: client_pem,
        observed_hello,
        observed_retirement,
        observed_attach_count,
        observed_commands,
        observed_terminal,
    }
}

#[test]
fn two_remote_panes_hold_two_real_observer_attachments() {
    let fixture = start_with_connections(Grant::ObserverOnly, 2);
    let first = attach_observer_over_ssh(ssh_config(&fixture), fence(), None)
        .expect("the first pane observer attaches");
    let second = attach_observer_over_ssh(ssh_config(&fixture), fence(), None)
        .expect("the sibling pane observer attaches");

    assert_eq!(
        first.attachment().negotiation.lifecycle,
        ObserverLifecycle::Observing
    );
    assert_eq!(
        second.attachment().negotiation.lifecycle,
        ObserverLifecycle::Observing
    );
    assert_eq!(fixture.observed_attach_count.load(Ordering::Acquire), 2);
    first.detach().expect("first pane detaches");
    second.detach().expect("second pane detaches");
}

fn ssh_config(fixture: &Fixture) -> SshExecConfig {
    SshExecConfig::new(
        SshEndpoint {
            host: "127.0.0.1".to_string(),
            port: fixture.port,
        },
        "tester",
        SshAuthentication::PrivateKey {
            openssh_pem: fixture.client_key.clone(),
            passphrase: None,
        },
        HostKeyPolicy::pinned([fixture.host_fingerprint.clone()]),
    )
}

fn request(role: LocalAttachRole) -> RemoteAttach {
    RemoteAttach {
        fence: fence(),
        attach_secret: "gateway-minted-grant".to_string(),
        role,
        reconnect_cursor: None,
    }
}

#[test]
fn a_read_only_terminal_surface_crosses_ssh_without_input_authority() {
    let fixture = start(Grant::TerminalSurface);
    let mut surface = attach_terminal_surface_over_ssh(
        ssh_config(&fixture),
        fence(),
        TerminalSurfaceAccess::ReadOnly,
    )
    .expect("the read-only terminal surface attaches over SSH");

    assert_eq!(surface.current_frame().text(), "x\n");
    let TerminalSurfaceEvent::Event(event) = surface.read_event().expect("the bell crosses SSH")
    else {
        panic!("the first live terminal record must be the scripted event");
    };
    assert!(matches!(event.event, Some(terminal_event::Event::Bell(_))));

    let hello = fixture
        .observed_hello
        .lock()
        .expect("hello lock")
        .clone()
        .expect("the Host saw a Hello");
    assert_eq!(hello.requested_mode, AttachMode::Observer);
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|capability| capability == TERMINAL_VIEWPORT_PROJECTION_CAPABILITY)
    );
    assert!(
        !hello
            .requested_capabilities
            .iter()
            .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY),
        "projection must not imply terminal input"
    );
    assert_eq!(
        fixture
            .observed_commands
            .lock()
            .expect("command lock")
            .as_slice(),
        [DEFAULT_GATEWAY_COMMAND]
    );
    surface.detach().expect("surface detaches");
}

#[path = "ssh_attach/command_input.rs"]
mod command_input;

#[test]
fn fresh_agent_prompt_is_one_typed_operation_over_ssh() {
    let fixture = start(Grant::TerminalSurface);
    let mut surface = attach_agent_prompt_over_ssh(ssh_config(&fixture), fence())
        .expect("the fresh-prompt surface attaches over SSH");

    let receipt = surface
        .send_fresh_agent_prompt_confirmed("ship over ssh".into(), Duration::from_secs(5))
        .expect("the Host acknowledges the atomic fresh prompt");
    assert_eq!(receipt.input().in_reply_to_record_id, 1);
    assert_eq!(receipt.input_baseline_output_sequence(), 1);
    assert_eq!(receipt.admitted_agent_runtime_revision(), Some(7));

    let hello = fixture
        .observed_hello
        .lock()
        .expect("hello lock")
        .clone()
        .expect("the Host saw a Hello");
    assert_eq!(hello.requested_mode, AttachMode::Observer);
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|requested| requested == AGENT_PROMPT_CAPABILITY)
    );
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|requested| requested == PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY)
    );
    assert!(
        !hello
            .requested_capabilities
            .iter()
            .any(|requested| requested == TERMINAL_INPUT_INTENT_CAPABILITY),
        "prompt-only SSH attach must not request generic terminal input"
    );
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|requested| requested == LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY)
    );
    assert!(
        !hello
            .requested_capabilities
            .iter()
            .any(|requested| requested == MANAGED_AUTHORIZATION_GRANT_CAPABILITY),
        "the remote peer must not request the gateway-local grant"
    );
    assert!(
        fixture.observed_commands.lock().expect("command lock")[0]
            .ends_with("mobile-gateway --role controller"),
        "the outer gateway ceiling must explicitly admit the write"
    );

    let observed = fixture
        .observed_terminal
        .lock()
        .expect("terminal lock")
        .clone();
    assert_eq!(observed.len(), 1);
    let input = decode_record(&observed[0]).expect("fresh prompt intent decodes");
    assert_eq!(
        input.metadata.record_id,
        receipt.input().in_reply_to_record_id
    );
    let Some(terminal_state_record::Body::InputIntent(intent)) = input.record.body else {
        panic!("the upstream record must be an input intent");
    };
    let Some(input_intent::Intent::AgentPrompt(prompt)) = intent.intent else {
        panic!("the upstream record must be the initial-agent-prompt operation");
    };
    assert_eq!(prompt.utf8, b"ship over ssh");
    let Some(agent_prompt_input_intent::Target::FreshAgent(_)) = prompt.target else {
        panic!("the upstream record must name a fresh-agent target");
    };
    surface.detach().expect("surface detaches");
}

#[test]
fn process_observed_fresh_agent_prompt_carries_its_negotiated_target_over_ssh() {
    let fixture = start(Grant::TerminalSurface);
    let mut surface = attach_agent_prompt_over_ssh(ssh_config(&fixture), fence())
        .expect("the process-observed prompt surface attaches over SSH");

    let receipt = surface
        .send_process_observed_fresh_agent_prompt_confirmed(
            "bootstrap over ssh".into(),
            Duration::from_secs(5),
        )
        .expect("the Host acknowledges the process-observed prompt");
    assert_eq!(receipt.input_baseline_output_sequence(), 1);

    let observed = fixture
        .observed_terminal
        .lock()
        .expect("terminal lock")
        .clone();
    assert_eq!(observed.len(), 1);
    let input = decode_record(&observed[0]).expect("process-observed prompt intent decodes");
    let Some(terminal_state_record::Body::InputIntent(intent)) = input.record.body else {
        panic!("the upstream record must be an input intent");
    };
    let Some(input_intent::Intent::AgentPrompt(prompt)) = intent.intent else {
        panic!("the upstream record must be an agent-prompt operation");
    };
    assert_eq!(prompt.utf8, b"bootstrap over ssh");
    assert!(matches!(
        prompt.target,
        Some(agent_prompt_input_intent::Target::ProcessObservedFreshAgent(_))
    ));
    surface.detach().expect("surface detaches");
}

#[test]
fn existing_conversation_agent_prompt_carries_exact_target_over_ssh() {
    let fixture = start(Grant::TerminalSurface);
    let mut surface = attach_agent_prompt_over_ssh(ssh_config(&fixture), fence())
        .expect("the existing-conversation prompt surface attaches over SSH");
    let expected =
        hmux_client::ProviderConversationIdentitySeed::new("codex", "conversation-remote-1")
            .unwrap();

    let receipt = surface
        .send_existing_idle_agent_prompt_confirmed(
            "continue over ssh".into(),
            &expected,
            Duration::from_secs(5),
        )
        .expect("the Host acknowledges the exact existing-conversation prompt");
    assert_eq!(receipt.input_baseline_output_sequence(), 1);
    assert_eq!(receipt.admitted_agent_runtime_revision(), Some(7));

    let hello = fixture
        .observed_hello
        .lock()
        .expect("hello lock")
        .clone()
        .expect("the Host saw a Hello");
    assert_eq!(hello.requested_mode, AttachMode::Observer);
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|requested| requested == AGENT_PROMPT_CAPABILITY)
    );
    assert!(
        !hello
            .requested_capabilities
            .iter()
            .any(|requested| requested == TERMINAL_INPUT_INTENT_CAPABILITY),
        "prompt-only SSH attach must not request generic terminal input"
    );
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|requested| requested == LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY)
    );

    let observed = fixture
        .observed_terminal
        .lock()
        .expect("terminal lock")
        .clone();
    assert_eq!(observed.len(), 1);
    let input = decode_record(&observed[0]).expect("existing prompt intent decodes");
    let Some(terminal_state_record::Body::InputIntent(intent)) = input.record.body else {
        panic!("the upstream record must be an input intent");
    };
    let Some(input_intent::Intent::AgentPrompt(prompt)) = intent.intent else {
        panic!("the upstream record must be an agent-prompt operation");
    };
    assert_eq!(prompt.utf8, b"continue over ssh");
    assert_eq!(prompt.admission_wait_ms, 0);
    let Some(agent_prompt_input_intent::Target::ExistingConversation(target)) = prompt.target
    else {
        panic!("the upstream record must name an existing conversation");
    };
    assert_eq!(target.expected_provider_id, "codex");
    assert_eq!(target.expected_conversation_id, "conversation-remote-1");
    surface.detach().expect("surface detaches");
}

/// The thing nobody had demonstrated: a client that attaches over SSH and
/// prints the session's output.
///
/// Every layer here is the shipped one. The assertion is on the bytes that came
/// out the far end, not on the attach returning `Ok` — a stub that fabricated a
/// connection would satisfy the latter, and the point of this test is that the
/// screen contents actually crossed an SSH exec channel and came back through
/// the frame codec in order.
#[test]
fn a_client_attaches_over_ssh_and_prints_the_sessions_output() {
    let fixture = start(Grant::ObserverOnly);

    let mut connection = attach_over_ssh(ssh_config(&fixture), request(LocalAttachRole::Observer))
        .expect("the attach completes over SSH");

    // The relay is what it says it is. Both halves of this are load-bearing:
    // a shipped dialer must not claim colocation, and it must not claim to be
    // the test-only variant either.
    assert!(matches!(connection.attestation(), PeerAttestation::Relayed));
    assert!(!connection.attestation().is_colocated());

    let mut rendered = Vec::new();
    let receipt = relay_output(
        &mut connection,
        &mut rendered,
        OutputBudget {
            duration: Some(Duration::from_secs(10)),
            frames: Some(2),
        },
    )
    .expect("output streams");

    assert_eq!(receipt.stop, OutputStop::BudgetSpent);
    assert_eq!(receipt.applied_cursor.after_output_seq, 3);
    // Snapshot first, then deltas in order. Concatenated rather than checked
    // for containment, because the ordering is the protocol's guarantee and a
    // containment check would pass on a stream that arrived backwards.
    let mut expected = Vec::new();
    expected.extend_from_slice(SCREEN);
    expected.extend_from_slice(DELTA_ONE);
    expected.extend_from_slice(DELTA_TWO);
    assert_eq!(
        String::from_utf8_lossy(&rendered),
        String::from_utf8_lossy(&expected)
    );

    // The Host received a real handshake, not something shaped like one.
    let hello = fixture
        .observed_hello
        .lock()
        .expect("hello lock")
        .clone()
        .expect("the Host saw a Hello");
    assert_eq!(hello.expected_fence, fence());
    assert_eq!(hello.capability_token, "gateway-minted-grant");
    assert_eq!(hello.requested_mode, AttachMode::Observer);
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|capability| capability == "live_output")
    );
}

#[test]
fn the_ide_controller_helper_requests_a_fenced_remote_controller() {
    let fixture = start(Grant::Controller);

    let controller = attach_controller_over_ssh(ssh_config(&fixture), fence(), None)
        .expect("the remote controller attaches");

    assert_eq!(
        controller.attachment().negotiation.lifecycle,
        ObserverLifecycle::Controlling
    );
    assert_eq!(
        controller.attachment().initial_snapshot.repaint_bytes,
        SCREEN
    );
    assert_eq!(
        controller
            .mutation_handle()
            .send_input(b"echo controller\n".to_vec())
            .expect("controller input is submitted")
            .split('_')
            .next(),
        Some("controller")
    );

    let hello = fixture
        .observed_hello
        .lock()
        .expect("hello lock")
        .clone()
        .expect("the Host saw a Hello");
    assert_eq!(hello.expected_fence, fence());
    assert_eq!(hello.capability_token, "ssh-gateway-delegated");
    assert_eq!(hello.requested_mode, AttachMode::Controller);
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|capability| capability == "session_retirement_v1"),
        "an explicit close cannot reach typed retirement unless the controller negotiated it"
    );
}

#[test]
fn an_explicit_remote_departure_uses_an_observer_and_sends_the_typed_action() {
    let fixture = start(Grant::Retirement);

    let receipt = depart_gracefully_over_ssh(ssh_config(&fixture), fence())
        .expect("the explicit departure completes over SSH");

    assert_eq!(
        receipt.state,
        SessionRetirementReceiptState::RetirementArmed
    );
    assert_eq!(receipt.policy, Some(retirement_policy()));

    let hello = fixture
        .observed_hello
        .lock()
        .expect("hello lock")
        .clone()
        .expect("the Host saw a Hello");
    assert_eq!(hello.requested_mode, AttachMode::Observer);
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|capability| capability == SESSION_RETIREMENT_CAPABILITY)
    );

    let request = fixture
        .observed_retirement
        .lock()
        .expect("retirement lock")
        .clone()
        .expect("the Host saw an explicit retirement request");
    assert_eq!(request.expected_fence, fence());
    assert_eq!(
        request.action,
        SessionRetirementAction::GracefulClientDeparture
    );
}

/// A transport reconnect is not a fresh attach. The cursor must cross the SSH
/// adapter, the Host must be allowed to seed with replayed deltas instead of a
/// snapshot, and the rendering helper must not clear the caller's existing
/// terminal by demanding a snapshot that deliberately does not exist.
#[test]
fn a_relayed_reconnect_resumes_without_redownloading_a_snapshot() {
    let fixture = start(Grant::Resume);
    let mut attach = request(LocalAttachRole::Observer);
    attach.reconnect_cursor = Some(ReconnectCursor {
        terminal_epoch: fence().terminal_epoch,
        after_output_seq: 1,
    });

    let mut connection =
        attach_over_ssh(ssh_config(&fixture), attach).expect("the cursor attach completes");
    assert_eq!(
        connection.attach_replay(),
        &AttachReplay::Resumed {
            after_output_seq: 1,
            through_output_seq: 3,
        }
    );
    assert!(
        connection.initial_snapshot().is_none(),
        "a served cursor must not pay for a replacement screen"
    );

    let mut rendered = Vec::new();
    let receipt = relay_output(
        &mut connection,
        &mut rendered,
        OutputBudget {
            duration: Some(Duration::from_secs(10)),
            frames: Some(2),
        },
    )
    .expect("replayed deltas render");
    assert_eq!(receipt.stop, OutputStop::BudgetSpent);
    assert_eq!(receipt.applied_cursor.after_output_seq, 3);
    assert_eq!([DELTA_ONE, DELTA_TWO].concat(), rendered);

    let hello = fixture
        .observed_hello
        .lock()
        .expect("hello lock")
        .clone()
        .expect("the Host saw a Hello");
    assert_eq!(
        hello.reconnect_cursor,
        Some(ReconnectCursor {
            terminal_epoch: fence().terminal_epoch,
            after_output_seq: 1,
        })
    );
}

#[test]
fn a_zero_frame_resume_never_claims_buffered_replay_was_applied() {
    let fixture = start(Grant::Resume);
    let mut attach = request(LocalAttachRole::Observer);
    attach.reconnect_cursor = Some(ReconnectCursor {
        terminal_epoch: fence().terminal_epoch,
        after_output_seq: 1,
    });
    let mut connection =
        attach_over_ssh(ssh_config(&fixture), attach).expect("the cursor attach completes");

    let mut rendered = Vec::new();
    let receipt = relay_output(
        &mut connection,
        &mut rendered,
        OutputBudget {
            duration: Some(Duration::from_secs(10)),
            frames: Some(0),
        },
    )
    .expect("zero-frame relay stops cleanly");

    assert_eq!(receipt.stop, OutputStop::BudgetSpent);
    assert_eq!(
        receipt.applied_cursor,
        ReconnectCursor {
            terminal_epoch: fence().terminal_epoch,
            after_output_seq: 1,
        }
    );
    assert!(rendered.is_empty());
}

/// The gate, over the transport it was written for, reached the only way a real
/// client reaches it.
///
/// The unit tests drive `validate_hello_ack` directly. This drives a whole
/// attach across a real SSH channel and asserts the refusal survives every layer
/// in between — which is the version that would have caught a relay path that
/// forked the handshake instead of reusing it.
#[test]
fn a_relayed_attach_is_refused_colocation_premised_authority_end_to_end() {
    let fixture = start(Grant::SharedTerminalInput);

    let error = attach_over_ssh(ssh_config(&fixture), request(LocalAttachRole::SharedWriter))
        .expect_err("shared_terminal_input must not be granted to a relayed attach");

    assert_eq!(error.code(), "hmux_uncolocated_authority");
    assert!(
        matches!(error, AttachError::Session(_)),
        "the channel worked; the session refused"
    );
}

/// A Host that answers for a different session is refused, and refused as a
/// *session* failure rather than a transport one. Over a relay this is the
/// ordinary case of an operator holding a stale fence, and reporting it as a
/// connection problem would send them to the network.
#[test]
fn an_attach_against_the_wrong_session_is_a_fence_mismatch_not_a_transport_error() {
    let fixture = start(Grant::WrongFence);

    let error = attach_over_ssh(ssh_config(&fixture), request(LocalAttachRole::Observer))
        .expect_err("a fence that names another session must not attach");

    assert!(
        matches!(error, AttachError::Session(ClientError::FenceMismatch(_))),
        "unexpected error {error:?}"
    );
}
