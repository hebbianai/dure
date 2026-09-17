//! Current-client compatibility against a frozen pre-exact-input gateway.
//!
//! The v4 half is intentionally a wire harness, not a call into the current
//! gateway parser. Reusing production parsing here would let both sides drift
//! together and turn the test green without proving a shipped old Host can
//! still answer. A small v5 generation shares only the provider model so the
//! test can prove that the old generation's refusal did not mutate it.

use hmux_session_protocol::{
    AuthorizationPosture, ErrorCode, FrameBody, FrameCodec, FrameLimits, HelloAck, LifecycleState,
    PROTOCOL_V1, ProcessProof, ScreenSnapshot, ScreenSnapshotEncoding, SessionFence, WireFrame,
};
use hmux_ssh_transport::{
    CatalogError, HostKeyPolicy, RemoteSessionInputRequest, SshAuthentication, SshEndpoint,
    SshExecConfig, attach_observer_over_ssh, list_sessions_over_ssh, write_session_input_over_ssh,
};
use russh::keys::{Algorithm, HashAlg, PrivateKey, ssh_key};
use russh::server::{Auth, ChannelOpenHandle, Handler, Msg, Server, Session};
use russh::{Channel, ChannelId, Pty};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const TRANSACTION_TIMEOUT: Duration = Duration::from_secs(5);
const FROZEN_V4_CATALOG: &[u8] = include_bytes!("fixtures/gateway_v4_catalog.json");
const FROZEN_V4_EXACT_INPUT_REFUSAL: &[u8] =
    include_bytes!("fixtures/gateway_v4_exact_input_refusal.json");
const FROZEN_V4_HELLO_ACK: &[u8] = include_bytes!("fixtures/gateway_v4_hello_ack.json");
const FROZEN_V4_SNAPSHOT: &[u8] = include_bytes!("fixtures/gateway_v4_snapshot.json");

#[derive(Clone, Copy)]
enum GatewayGeneration {
    FrozenV4,
    CurrentV5,
}

impl GatewayGeneration {
    fn build_label(self) -> &'static str {
        match self {
            Self::FrozenV4 => "frozen-gateway-v4",
            Self::CurrentV5 => "current-gateway-v5",
        }
    }
}

#[derive(Clone)]
struct ProviderState {
    fence: SessionFence,
    screen: Arc<Mutex<Vec<u8>>>,
    input_receipts: Arc<AtomicUsize>,
    v4_version_refusals: Arc<AtomicUsize>,
    v4_attachments: Arc<AtomicUsize>,
    v5_attachments: Arc<AtomicUsize>,
}

impl ProviderState {
    fn new() -> Self {
        Self {
            fence: SessionFence {
                workspace_id: "rolling-workspace".into(),
                session_id: "rolling-session".into(),
                runner_principal: "rolling-principal".into(),
                runner_instance: "rolling-runner".into(),
                channel_epoch: 7,
                host_instance_id: "rolling-host".into(),
                terminal_epoch: "rolling-terminal".into(),
            },
            screen: Arc::new(Mutex::new(b"provider-before-rollout\n".to_vec())),
            input_receipts: Arc::new(AtomicUsize::new(0)),
            v4_version_refusals: Arc::new(AtomicUsize::new(0)),
            v4_attachments: Arc::new(AtomicUsize::new(0)),
            v5_attachments: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn catalog_document(&self) -> serde_json::Value {
        serde_json::json!({
            "gateway_catalog_version": 2,
            "session": {
                "session_id": self.fence.session_id,
                "session_name": "rolling-shell",
                "workspace_id": self.fence.workspace_id,
                "session_class": "standalone",
                "lifecycle": "ready",
                "provider_id": "shell",
                "runner_principal": self.fence.runner_principal,
                "runner_instance": self.fence.runner_instance,
                "channel_epoch": self.fence.channel_epoch.to_string(),
                "host_instance_id": self.fence.host_instance_id,
                "terminal_epoch": self.fence.terminal_epoch,
                "supported_protocol": {
                    "minimum": { "major": 1, "minor": 0 },
                    "maximum": { "major": 1, "minor": 0 }
                },
                "capabilities": ["screen_snapshot", "live_output"],
                "retirement_policy": null
            }
        })
    }

    fn attach_reply(
        &self,
        generation: GatewayGeneration,
        hello: &hmux_session_protocol::Hello,
    ) -> Reply {
        assert_eq!(hello.expected_fence, self.fence);
        assert_eq!(
            hello.requested_mode,
            hmux_session_protocol::AttachMode::Observer
        );
        if matches!(generation, GatewayGeneration::FrozenV4) {
            self.v4_attachments.fetch_add(1, Ordering::AcqRel);
            return Reply::open(vec![
                frozen_frame(FROZEN_V4_HELLO_ACK),
                frozen_frame(FROZEN_V4_SNAPSHOT),
            ]);
        }
        self.v5_attachments.fetch_add(1, Ordering::AcqRel);
        let ack = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body: FrameBody::HelloAck(HelloAck {
                selected_version: PROTOCOL_V1,
                selected_capabilities: vec!["screen_snapshot".into(), "live_output".into()],
                actual_fence: self.fence.clone(),
                host_build_version: generation.build_label().into(),
                lifecycle: LifecycleState::Observing,
                host_process: ProcessProof {
                    process_id: 41,
                    start_marker: "host-generation-v5".into(),
                },
                provider_process: Some(ProcessProof {
                    process_id: 42,
                    start_marker: "provider-generation-stable".into(),
                }),
                earliest_retained_output_seq: 1,
                current_output_seq: 1,
                controller_generation: 11,
                authorization_posture: AuthorizationPosture::DaemonAuthorizedObserver,
            }),
        };
        let snapshot = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 2,
            body: FrameBody::ScreenSnapshot(ScreenSnapshot {
                fence: self.fence.clone(),
                sequence_through: 1,
                rows: 24,
                columns: 80,
                encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
                controller_input_pending: None,
                semantic_idle_ms: None,
                repaint_bytes: self.screen.lock().expect("provider screen lock").clone(),
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
        };
        Reply::open(vec![frame(ack), frame(snapshot)])
    }

    fn request_reply(&self, generation: GatewayGeneration, request: &serde_json::Value) -> Reply {
        let version = request["gateway_request_version"]
            .as_u64()
            .expect("gateway request version");
        if request["request"] == "list_sessions" {
            assert_eq!(
                version, 2,
                "the current client must retain the v2 listing request"
            );
            let catalog = match generation {
                GatewayGeneration::FrozenV4 => frozen_document(FROZEN_V4_CATALOG),
                GatewayGeneration::CurrentV5 => document(self.catalog_document()),
            };
            return Reply::closed(vec![catalog], 0);
        }
        assert_eq!(version, 5, "only exact input is introduced after v4");
        match generation {
            GatewayGeneration::FrozenV4 => {
                self.v4_version_refusals.fetch_add(1, Ordering::AcqRel);
                Reply::closed(vec![frozen_frame(FROZEN_V4_EXACT_INPUT_REFUSAL)], 1)
            }
            GatewayGeneration::CurrentV5 => {
                let input = &request["request"]["write_session_input"];
                assert_eq!(
                    input["expected_fence"],
                    serde_json::to_value(&self.fence).expect("fence encodes")
                );
                let bytes: Vec<u8> =
                    serde_json::from_value(input["bytes"].clone()).expect("input bytes");
                self.screen
                    .lock()
                    .expect("provider screen lock")
                    .extend_from_slice(&bytes);
                self.input_receipts.fetch_add(1, Ordering::AcqRel);
                Reply::closed(
                    vec![document(serde_json::json!({
                        "gateway_input_version": 1,
                        "request_id": input["request_id"],
                        "session_id": self.fence.session_id,
                        "workspace_id": self.fence.workspace_id,
                        "receipt": {
                            "request_id": "rolling-input-receipt",
                            "controller_generation": "11",
                            "state": "written_to_pty",
                            "reason": null,
                            "detail": null
                        }
                    }))],
                    0,
                )
            }
        }
    }
}

struct Reply {
    frames: Vec<Vec<u8>>,
    exit_status: Option<u32>,
}

impl Reply {
    fn open(frames: Vec<Vec<u8>>) -> Self {
        Self {
            frames,
            exit_status: None,
        }
    }

    fn closed(frames: Vec<Vec<u8>>, exit_status: u32) -> Self {
        Self {
            frames,
            exit_status: Some(exit_status),
        }
    }
}

fn frame(value: WireFrame) -> Vec<u8> {
    FrameCodec::new(FrameLimits::default())
        .encode(&value)
        .expect("frozen gateway frame")
}

fn document(value: serde_json::Value) -> Vec<u8> {
    let payload = serde_json::to_vec(&value).expect("frozen gateway document");
    let mut framed = Vec::with_capacity(payload.len() + 4);
    framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    framed.extend_from_slice(&payload);
    framed
}

fn frozen_document(payload: &[u8]) -> Vec<u8> {
    serde_json::from_slice::<serde_json::Value>(payload).expect("frozen v4 fixture is valid JSON");
    let mut framed = Vec::with_capacity(payload.len() + 4);
    framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    framed.extend_from_slice(payload);
    framed
}

fn frozen_frame(payload: &[u8]) -> Vec<u8> {
    let frame: WireFrame =
        serde_json::from_slice(payload).expect("frozen v4 fixture is a compatible wire frame");
    frame
        .validate(&FrameLimits::default())
        .expect("frozen v4 fixture is a valid wire frame");
    frozen_document(payload)
}

#[derive(Clone)]
struct FrozenGateway {
    generation: GatewayGeneration,
    provider: ProviderState,
    request: Arc<Mutex<Vec<u8>>>,
    answered: Arc<AtomicBool>,
}

impl Server for FrozenGateway {
    type Handler = Self;

    fn new_client(&mut self, _peer: Option<SocketAddr>) -> Self {
        self.clone()
    }
}

impl Handler for FrozenGateway {
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
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.answered.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut request = self.request.lock().expect("request lock");
        request.extend_from_slice(data);
        let Some(prefix) = request.get(..4) else {
            return Ok(());
        };
        let length = u32::from_be_bytes(prefix.try_into().expect("length prefix")) as usize;
        if request.len() != length + 4 {
            return Ok(());
        }
        let payload = request[4..].to_vec();
        drop(request);
        if self.answered.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        let reply = match serde_json::from_slice::<serde_json::Value>(&payload) {
            Ok(request) if request.get("gateway_request_version").is_some() => {
                self.provider.request_reply(self.generation, &request)
            }
            _ => {
                let opening: WireFrame =
                    serde_json::from_slice(&payload).expect("a relay opens with a wire frame");
                let FrameBody::Hello(hello) = opening.body else {
                    panic!("a frozen gateway relay opens with Hello")
                };
                self.provider.attach_reply(self.generation, &hello)
            }
        };
        for frame in reply.frames {
            session.data(channel, frame)?;
        }
        if let Some(status) = reply.exit_status {
            session.exit_status_request(channel, status)?;
            session.eof(channel)?;
            session.close(channel)?;
        }
        Ok(())
    }
}

struct GatewayFixture {
    port: u16,
    host_fingerprint: String,
    client_key: String,
}

fn start(generation: GatewayGeneration, provider: ProviderState) -> GatewayFixture {
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
    let (ready, port) = std::sync::mpsc::sync_channel(1);
    thread::Builder::new()
        .name("frozen-gateway-v4".into())
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
                let mut server = FrozenGateway {
                    generation,
                    provider,
                    request: Arc::new(Mutex::new(Vec::new())),
                    answered: Arc::new(AtomicBool::new(false)),
                };
                let (stream, _peer) = listener.accept().await.expect("one connection");
                let session = russh::server::run_stream(config, stream, server.new_client(None))
                    .await
                    .expect("server session");
                let _ = session.await;
            });
        })
        .expect("server thread");
    GatewayFixture {
        port: port.recv().expect("server port"),
        host_fingerprint,
        client_key: client_pem,
    }
}

fn config(fixture: &GatewayFixture) -> SshExecConfig {
    let mut config = SshExecConfig::new(
        SshEndpoint {
            host: "127.0.0.1".into(),
            port: fixture.port,
        },
        "tester",
        SshAuthentication::PrivateKey {
            openssh_pem: fixture.client_key.clone(),
            passphrase: None,
        },
        HostKeyPolicy::pinned([fixture.host_fingerprint.clone()]),
    );
    config.connect_timeout = TRANSACTION_TIMEOUT;
    config
}

fn input_request(
    provider: &ProviderState,
    request_id: &str,
    bytes: &[u8],
) -> RemoteSessionInputRequest {
    RemoteSessionInputRequest {
        request_id: request_id.into(),
        expected_fence: provider.fence.clone(),
        bytes: bytes.to_vec(),
    }
}

#[test]
fn current_client_degrades_against_v4_without_mutating_the_provider() {
    let provider = ProviderState::new();

    let list_gateway = start(GatewayGeneration::FrozenV4, provider.clone());
    let listed = list_sessions_over_ssh(config(&list_gateway), TRANSACTION_TIMEOUT)
        .expect("the current client must list through a frozen v4 gateway");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].session_id, provider.fence.session_id);
    assert_eq!(listed[0].host_instance_id, provider.fence.host_instance_id);

    let attach_before = start(GatewayGeneration::FrozenV4, provider.clone());
    let observer = attach_observer_over_ssh(config(&attach_before), provider.fence.clone(), None)
        .expect("the current observer must attach through a frozen v4 gateway");
    assert_eq!(
        observer.attachment().host_build_version,
        "frozen-gateway-v4"
    );
    assert_eq!(
        observer.attachment().initial_snapshot.repaint_bytes,
        b"provider-before-rollout\n"
    );
    drop(observer);

    let input_gateway = start(GatewayGeneration::FrozenV4, provider.clone());
    let error = write_session_input_over_ssh(
        config(&input_gateway),
        input_request(&provider, "v5-against-v4", b"must-not-land\r"),
        TRANSACTION_TIMEOUT,
    )
    .expect_err("a frozen v4 gateway must refuse the v5-only operation");
    assert_eq!(error.code(), "hmux_protocol_version_unsupported");
    let CatalogError::Refused {
        code: ErrorCode::UnsupportedProtocolVersion,
        message,
    } = error
    else {
        panic!("the refusal must retain its typed remote error code")
    };
    assert!(message.contains("1..=4, not 5"));
    assert_eq!(provider.input_receipts.load(Ordering::Acquire), 0);
    assert_eq!(
        provider
            .screen
            .lock()
            .expect("provider screen lock")
            .as_slice(),
        b"provider-before-rollout\n"
    );

    let attach_after = start(GatewayGeneration::FrozenV4, provider.clone());
    let observer = attach_observer_over_ssh(config(&attach_after), provider.fence.clone(), None)
        .expect("the provider must remain attachable after the version refusal");
    assert_eq!(
        observer.attachment().initial_snapshot.repaint_bytes,
        b"provider-before-rollout\n"
    );
    drop(observer);

    let current_gateway = start(GatewayGeneration::CurrentV5, provider.clone());
    let receipt = write_session_input_over_ssh(
        config(&current_gateway),
        input_request(&provider, "v5-against-v5", b"accepted-once\r"),
        TRANSACTION_TIMEOUT,
    )
    .expect("the current generation accepts the same exact-input contract");
    assert_eq!(receipt.receipt.request_id, "rolling-input-receipt");

    let current_attach = start(GatewayGeneration::CurrentV5, provider.clone());
    let observer = attach_observer_over_ssh(config(&current_attach), provider.fence.clone(), None)
        .expect("the current Host generation must adopt the retained provider");
    assert_eq!(
        observer.attachment().host_build_version,
        "current-gateway-v5"
    );
    assert_eq!(
        observer.attachment().initial_snapshot.repaint_bytes,
        b"provider-before-rollout\naccepted-once\r"
    );
    drop(observer);

    assert_eq!(provider.input_receipts.load(Ordering::Acquire), 1);
    assert_eq!(provider.v4_version_refusals.load(Ordering::Acquire), 1);
    assert_eq!(provider.v4_attachments.load(Ordering::Acquire), 2);
    assert_eq!(provider.v5_attachments.load(Ordering::Acquire), 1);
    assert_eq!(
        provider
            .screen
            .lock()
            .expect("provider screen lock")
            .as_slice(),
        b"provider-before-rollout\naccepted-once\r"
    );
}
