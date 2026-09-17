#![cfg(all(unix, feature = "terminal-state-stream"))]

//! One composed managed-rehost recovery across a real SSH exec channel.
//!
//! The loopback SSH account executes the real runtime broker against a
//! disposable discovery root. It deliberately discards the first completed
//! response, then a fresh SSH connection reconciles using only the durable
//! operation identity. The replacement is finally exercised through the
//! structured terminal surface rather than trusted from the broker receipt.

use hmux_client::{
    AgentRuntimeActivity, AgentRuntimeAttention, AgentStateReport, LocalProcessGenerationStatus,
    LocalSessionCatalog, LocalSessionObserver, MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA,
    MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA_VERSION, ManagedAgentStateReporter,
    ManagedAttachRequest, ManagedCreateRequest, ManagedRehostRecipe, ManagedRehostReconcileRequest,
    ManagedRehostReplacement, ManagedRehostRequest, ManagedSessionCreator, ManagedSessionStopper,
    ManagedStopConversationFence, ManagedStopQuiescenceFence, ManagedStopRequest,
    ObserverAttachOptions, PermissionMode, ProviderConversationIdentitySeed,
    ProviderStateEnvironment, SessionDescriptor, SessionLifecycle, SessionSelector,
    TerminalEnvironment, TerminalSurfaceAccess, TerminalSurfaceAttachment, TerminalSurfaceEvent,
    probe_local_process_generation,
};
use hmux_host::local_protocol::FrameBody;
use hmux_runtime_contract::{
    MANAGED_CREATE_BROKER_SUBCOMMAND, MANAGED_REHOST_BROKER_SUBCOMMAND,
    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER, MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND,
    MANAGED_STOP_BROKER_SUBCOMMAND, MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND,
    ManagedCreateBrokerResponse, ManagedRehostBrokerResponse, ManagedStopBrokerResponse,
    read_json_frame, write_json_frame,
};
use hmux_ssh_transport::{
    HostKeyPolicy, RemoteManagedRehostError, RemoteManagedStopError, SshAuthentication,
    SshEndpoint, SshExecConfig, create_managed_over_ssh, reconcile_managed_rehost_over_ssh,
    rehost_managed_over_ssh, stop_managed_over_ssh,
};
use rand::rng;
use russh::keys::{Algorithm, HashAlg, PrivateKey, ssh_key};
use russh::server::{Auth, ChannelOpenHandle, Handler, Msg, Server, Session};
use russh::{Channel, ChannelId, Pty};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use terminal_state_protocol::{input_receipt, resize_receipt};

const POISONED_CODEX_HOME: &str = "/poisoned/remote-codex-home";

#[derive(Default)]
struct BrokerObservation {
    requested_pty: AtomicBool,
    commands: Mutex<Vec<String>>,
    broker_invocations: AtomicUsize,
    completed_responses: AtomicUsize,
    lost_responses: AtomicUsize,
}

struct RuntimeBrokerSshServer {
    runtime: PathBuf,
    cwd: PathBuf,
    discovery_root: PathBuf,
    isolated_home: PathBuf,
    observation: Arc<BrokerObservation>,
    poison_codex_home: bool,
    command: Option<String>,
    request: Vec<u8>,
    responded: bool,
}

impl Clone for RuntimeBrokerSshServer {
    fn clone(&self) -> Self {
        Self {
            runtime: self.runtime.clone(),
            cwd: self.cwd.clone(),
            discovery_root: self.discovery_root.clone(),
            isolated_home: self.isolated_home.clone(),
            observation: Arc::clone(&self.observation),
            poison_codex_home: self.poison_codex_home,
            command: None,
            request: Vec::new(),
            responded: false,
        }
    }
}

impl Server for RuntimeBrokerSshServer {
    type Handler = Self;

    fn new_client(&mut self, _peer: Option<SocketAddr>) -> Self {
        self.clone()
    }
}

impl Handler for RuntimeBrokerSshServer {
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
        self.observation
            .requested_pty
            .store(true, Ordering::Release);
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
        // Sequential exec channels can reuse one authenticated SSH connection.
        self.request.clear();
        self.responded = false;
        self.observation
            .commands
            .lock()
            .expect("command observation lock")
            .push(command.clone());
        self.command = Some(command);
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.responded {
            return Ok(());
        }
        self.request.extend_from_slice(data);
        let Some(expected) = framed_document_len(&self.request) else {
            return Ok(());
        };
        if self.request.len() < expected {
            return Ok(());
        }
        assert_eq!(
            self.request.len(),
            expected,
            "broker request has trailing bytes"
        );
        self.responded = true;

        let command = self.command.as_deref().expect("exec precedes broker input");
        if command == hmux_ssh_transport::DEFAULT_GATEWAY_COMMAND {
            let mut child = Command::new(self.runtime.with_file_name("hmux"))
                .args(["--discovery-root"])
                .arg(&self.discovery_root)
                .args(["mobile-gateway", "--role", "observer"])
                .current_dir(&self.cwd)
                .env_remove(hmux_client::MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("real mobile gateway starts");
            child
                .stdin
                .take()
                .unwrap()
                .write_all(&self.request)
                .unwrap();
            let output = child.wait_with_output().unwrap();
            session.data(channel, output.stdout)?;
            session.extended_data(channel, 1, output.stderr)?;
            session.exit_status_request(channel, output.status.code().unwrap_or(1) as u32)?;
            session.eof(channel)?;
            session.close(channel)?;
            return Ok(());
        }
        enum ResponseKind {
            Create,
            Rehost,
            Stop,
        }
        let (subcommand, lose_response, response_kind) =
            if command.contains(MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND) {
                (
                    MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND,
                    false,
                    ResponseKind::Rehost,
                )
            } else if command.contains(MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND) {
                (
                    MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND,
                    false,
                    ResponseKind::Stop,
                )
            } else if command.contains(MANAGED_STOP_BROKER_SUBCOMMAND) {
                (MANAGED_STOP_BROKER_SUBCOMMAND, false, ResponseKind::Stop)
            } else if command.contains(MANAGED_CREATE_BROKER_SUBCOMMAND) {
                (
                    MANAGED_CREATE_BROKER_SUBCOMMAND,
                    false,
                    ResponseKind::Create,
                )
            } else {
                assert!(
                    command.contains(MANAGED_REHOST_BROKER_SUBCOMMAND),
                    "unexpected remote broker command: {command}"
                );
                (MANAGED_REHOST_BROKER_SUBCOMMAND, true, ResponseKind::Rehost)
            };
        self.observation
            .broker_invocations
            .fetch_add(1, Ordering::AcqRel);

        let mut command = Command::new(&self.runtime);
        command
            .arg("--no-autostart")
            .arg(subcommand)
            .current_dir(&self.cwd)
            .env(hmux_client::DISCOVERY_ROOT_ENV, &self.discovery_root)
            .env("HOME", &self.isolated_home)
            .env("DURE_HOME", self.isolated_home.join("dure"))
            .env_remove(hmux_client::MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV)
            .env_remove("HEBBIAN_HOME")
            .env_remove("BEADS_ACTOR")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if self.poison_codex_home {
            command.env("CODEX_HOME", POISONED_CODEX_HOME);
        } else {
            command.env_remove("CODEX_HOME");
        }
        let mut child = command.spawn().expect("real remote runtime broker starts");
        child
            .stdin
            .take()
            .expect("broker stdin")
            .write_all(&self.request)
            .expect("complete request reaches broker");
        let output = child.wait_with_output().expect("remote broker completes");
        assert!(
            output.status.success(),
            "remote broker failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        match response_kind {
            ResponseKind::Create => {
                let response: ManagedCreateBrokerResponse =
                    read_json_frame(&mut Cursor::new(&output.stdout))
                        .expect("create broker response decodes");
                assert!(
                    matches!(response, ManagedCreateBrokerResponse::Completed(_)),
                    "remote create broker did not complete: {response:?}"
                );
            }
            ResponseKind::Rehost => {
                let response: ManagedRehostBrokerResponse =
                    read_json_frame(&mut Cursor::new(&output.stdout))
                        .expect("rehost broker response decodes");
                assert!(
                    matches!(response, ManagedRehostBrokerResponse::Completed(_)),
                    "remote rehost broker did not complete: {response:?}"
                );
            }
            ResponseKind::Stop => {
                let _: ManagedStopBrokerResponse =
                    read_json_frame(&mut Cursor::new(&output.stdout))
                        .expect("stop broker response decodes");
            }
        }
        self.observation
            .completed_responses
            .fetch_add(1, Ordering::AcqRel);

        if lose_response {
            self.observation
                .lost_responses
                .fetch_add(1, Ordering::AcqRel);
        } else {
            session.data(channel, output.stdout)?;
        }
        if !output.stderr.is_empty() {
            session.extended_data(channel, 1, output.stderr)?;
        }
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
}

fn framed_document_len(bytes: &[u8]) -> Option<usize> {
    let prefix: [u8; 4] = bytes.get(..4)?.try_into().ok()?;
    usize::try_from(u32::from_be_bytes(prefix))
        .ok()?
        .checked_add(4)
}

struct SshFixture {
    port: u16,
    host_fingerprint: String,
    client_key: String,
    observation: Arc<BrokerObservation>,
    shutdown: tokio::sync::watch::Sender<bool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl SshFixture {
    fn start(runtime: &Path, cwd: &Path, discovery_root: &Path, isolated_home: &Path) -> Self {
        Self::start_with_environment(runtime, cwd, discovery_root, isolated_home, false)
    }

    fn start_with_poisoned_codex_home(
        runtime: &Path,
        cwd: &Path,
        discovery_root: &Path,
        isolated_home: &Path,
    ) -> Self {
        Self::start_with_environment(runtime, cwd, discovery_root, isolated_home, true)
    }

    fn start_with_environment(
        runtime: &Path,
        cwd: &Path,
        discovery_root: &Path,
        isolated_home: &Path,
        poison_codex_home: bool,
    ) -> Self {
        let host_key = PrivateKey::random(&mut rng(), Algorithm::Ed25519).expect("host key");
        let host_fingerprint = host_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let client_key = PrivateKey::random(&mut rng(), Algorithm::Ed25519)
            .expect("client key")
            .to_openssh(ssh_key::LineEnding::LF)
            .expect("client key encodes")
            .to_string();
        let observation = Arc::new(BrokerObservation::default());
        let (ready, port) = std::sync::mpsc::sync_channel(1);
        let (shutdown, mut shutdown_rx) = tokio::sync::watch::channel(false);
        let server = RuntimeBrokerSshServer {
            runtime: runtime.to_path_buf(),
            cwd: cwd.to_path_buf(),
            discovery_root: discovery_root.to_path_buf(),
            isolated_home: isolated_home.to_path_buf(),
            observation: Arc::clone(&observation),
            poison_codex_home,
            command: None,
            request: Vec::new(),
            responded: false,
        };
        let thread = thread::Builder::new()
            .name("managed-rehost-ssh-loopback".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("SSH server runtime");
                runtime.block_on(async move {
                    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                        .await
                        .expect("loopback listener");
                    ready
                        .send(listener.local_addr().expect("listener address").port())
                        .expect("listener port is reported");
                    let config = Arc::new(russh::server::Config {
                        keys: vec![host_key],
                        ..russh::server::Config::default()
                    });
                    let mut server = server;
                    'server: loop {
                        let accepted = tokio::select! {
                            accepted = listener.accept() => accepted,
                            changed = shutdown_rx.changed() => {
                                let _ = changed;
                                break 'server;
                            }
                        };
                        let (stream, _peer) = accepted.expect("loopback connection");
                        let mut session = russh::server::run_stream(
                            Arc::clone(&config),
                            stream,
                            server.new_client(None),
                        )
                        .await
                        .expect("SSH server session");
                        tokio::select! {
                            _ = &mut session => {}
                            changed = shutdown_rx.changed() => {
                                let _ = changed;
                                break 'server;
                            }
                        }
                    }
                });
            })
            .expect("SSH server thread");
        Self {
            port: port.recv().expect("SSH server reports its port"),
            host_fingerprint,
            client_key,
            observation,
            shutdown,
            thread: Some(thread),
        }
    }

    fn config(&self) -> SshExecConfig {
        let mut config = SshExecConfig::new(
            SshEndpoint {
                host: "127.0.0.1".into(),
                port: self.port,
            },
            "fixture-account",
            SshAuthentication::PrivateKey {
                openssh_pem: self.client_key.clone(),
                passphrase: None,
            },
            HostKeyPolicy::pinned([self.host_fingerprint.clone()]),
        );
        config.connect_timeout = Duration::from_secs(10);
        config
    }
}

impl Drop for SshFixture {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct ManagedFixtureCleanup {
    runtime: PathBuf,
    cwd: PathBuf,
    discovery_root: PathBuf,
}

impl Drop for ManagedFixtureCleanup {
    fn drop(&mut self) {
        let Ok(sessions) = LocalSessionCatalog::new(&self.discovery_root).list() else {
            return;
        };
        let stopper = ManagedSessionStopper::new(&self.runtime, &self.cwd)
            .with_discovery_root(&self.discovery_root);
        for descriptor in sessions
            .iter()
            .filter(|descriptor| descriptor.lifecycle == SessionLifecycle::Ready)
        {
            let _ = stopper.stop(exact_stop_request(
                format!("ssh-rehost-cleanup-{}", descriptor.session_id),
                descriptor,
            ));
        }
        for descriptor in sessions {
            let _ = wait_for_process_absence(&descriptor.provider_process, Duration::from_secs(3));
            let _ = wait_for_process_absence(&descriptor.host_process, Duration::from_secs(7));
        }
    }
}

#[test]
fn managed_rehost_response_loss_reconnects_and_reconciles_into_a_live_structured_target() {
    let state = tempfile::tempdir().expect("isolated test state");
    let discovery_root = state.path().join("discovery");
    let isolated_home = state.path().join("remote-home");
    std::fs::create_dir_all(&isolated_home).expect("isolated remote home");
    let cwd = std::env::current_dir()
        .expect("test cwd")
        .canonicalize()
        .expect("canonical test cwd");
    let runtime = PathBuf::from(env!("CARGO_BIN_EXE_hmux-runtime"));
    let _cleanup = ManagedFixtureCleanup {
        runtime: runtime.clone(),
        cwd: cwd.clone(),
        discovery_root: discovery_root.clone(),
    };
    let launch_marker = state.path().join("replacement-launches");
    let conversation_id = "conversation-ssh-response-loss";
    let created = ManagedSessionCreator::new(&runtime)
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "ssh-rehost-source-create",
                "ssh-rehost-source",
                "ssh-rehost-workspace",
                "codex",
                PermissionMode::BypassApprovals,
                &cwd,
                vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap()
            .with_conversation_identity(
                ProviderConversationIdentitySeed::new("codex", conversation_id).unwrap(),
            )
            .unwrap()
            .with_managed_rehost_recipe(
                ManagedRehostRecipe::new(
                    vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        "printf 'launch:%s\\n' \"$1\" >> \"$2\"; printf 'TARGET_READY\\r\\n'; while IFS= read -r line; do printf 'TARGET:%s\\r\\n' \"$line\"; done".into(),
                        "--".into(),
                        MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                        launch_marker.to_string_lossy().into_owned(),
                    ],
                    Some("fixture-credential-reference".into()),
                )
                .unwrap(),
            )
            .unwrap(),
        )
        .expect("managed source starts below the isolated discovery root");
    let source = created.session().descriptor().clone();
    assert!(discovery_root.starts_with(state.path()));

    let request = exact_rehost_request("ssh-response-loss-operation", &source)
        .with_expected_provider_id("codex")
        .unwrap()
        .with_expected_conversation_id(conversation_id)
        .unwrap()
        .with_expected_launch_reference("fixture-credential-reference")
        .unwrap();
    let reconcile = ManagedRehostReconcileRequest::by_operation_identity(
        request.operation_id(),
        request.source().session_id(),
        request.source().workspace_id(),
    )
    .unwrap();
    let ssh = SshFixture::start(&runtime, &cwd, &discovery_root, &isolated_home);

    let lost = rehost_managed_over_ssh(ssh.config(), request, Duration::from_secs(15))
        .expect_err("the first completed broker response is deliberately lost");
    assert!(matches!(lost, RemoteManagedRehostError::OutcomeUnknown(_)));

    let receipt =
        reconcile_managed_rehost_over_ssh(ssh.config(), reconcile, Duration::from_secs(15))
            .expect("a new SSH connection reconciles using only durable operation identity");
    assert!(receipt.replayed());
    assert_eq!(receipt.conversation_id(), Some(conversation_id));
    assert_eq!(
        receipt.launch_reference(),
        Some("fixture-credential-reference")
    );
    assert_eq!(
        ssh.observation.broker_invocations.load(Ordering::Acquire),
        2
    );
    assert_eq!(
        ssh.observation.completed_responses.load(Ordering::Acquire),
        2
    );
    assert_eq!(ssh.observation.lost_responses.load(Ordering::Acquire), 1);
    assert!(!ssh.observation.requested_pty.load(Ordering::Acquire));
    assert_eq!(
        ssh.observation
            .commands
            .lock()
            .expect("command observation lock")
            .len(),
        2,
        "response recovery must use one fresh SSH exec, not retry the destructive request"
    );

    wait_for_lifecycle(
        &discovery_root,
        &source.session_id,
        &source.workspace_id,
        SessionLifecycle::Exited,
    );
    assert_eq!(
        std::fs::read_to_string(&launch_marker).expect("replacement wrote its launch marker"),
        format!("launch:{conversation_id}\n"),
        "response loss and reconcile must launch exactly one replacement provider"
    );
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let ready = catalog
        .list()
        .unwrap()
        .into_iter()
        .filter(|descriptor| descriptor.lifecycle == SessionLifecycle::Ready)
        .collect::<Vec<_>>();
    assert_eq!(
        ready.len(),
        1,
        "exactly one replacement generation is ready"
    );
    let target = ready.into_iter().next().unwrap();
    assert_eq!(
        target.session_id,
        receipt.replacement_receipt().session_id()
    );
    assert_eq!(target.workspace_id, source.workspace_id);

    let source_fence = hmux_client::SessionFence {
        session_id: source.session_id.clone(),
        workspace_id: source.workspace_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: source.runner_instance.clone(),
        channel_epoch: source.channel_epoch.parse().unwrap(),
        host_instance_id: source.host_instance_id.clone(),
        terminal_epoch: source.terminal_epoch.clone(),
    };
    for _ in 0..2 {
        let hmux_ssh_transport::session_resolution::SessionResolution::Resolved { session } =
            hmux_ssh_transport::session_resolution::over_ssh::<
                hmux_ssh_transport::RemoteCatalogSession,
            >(ssh.config(), &source_fence, Duration::from_secs(5))
            .expect("mobile reconnect reads the durable successor through the real SSH gateway")
        else {
            panic!("completed rehost must resolve")
        };
        assert_eq!(session.session_id, target.session_id);
        assert_eq!(session.terminal_epoch, target.terminal_epoch);
        assert_ne!(session.session_id, source.session_id);
    }
    assert_eq!(
        ssh.observation.broker_invocations.load(Ordering::Acquire),
        2
    );
    assert!(!ssh.observation.requested_pty.load(Ordering::Acquire));

    let session = catalog
        .open(&SessionSelector::new(
            &target.session_id,
            Some(target.workspace_id.clone()),
        ))
        .expect("the reconciled exact target is attachable");
    let mut connection = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .expect("target accepts a structured writer surface");
    connection
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut surface = TerminalSurfaceAttachment::from_connection(connection)
        .expect("target supplies one complete structured viewport seed");
    assert_eq!(
        surface
            .initial_provider_conversation_identity()
            .expect("target seed carries Host-owned conversation identity")
            .conversation_id,
        conversation_id
    );
    wait_for_surface_text(&mut surface, "TARGET_READY");

    let resized = surface
        .send_resize_confirmed(101, 37, Duration::from_secs(5))
        .expect("structured resize receives a correlated final receipt");
    assert!(matches!(
        resized.outcome,
        Some(resize_receipt::Outcome::AppliedToTerminal(_))
    ));
    wait_for_surface_geometry(&mut surface, 101, 37);

    let input = surface
        .send_text_confirmed("ssh-input\n".into(), Duration::from_secs(5))
        .expect("structured input receives a correlated final receipt");
    assert!(matches!(
        input.outcome,
        Some(input_receipt::Outcome::WrittenToPty(_))
    ));
    wait_for_surface_text(&mut surface, "TARGET:ssh-input");
    surface.detach().unwrap();

    let stopped = ManagedSessionStopper::new(&runtime, &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_stop_request("ssh-rehost-target-cleanup", &target))
        .expect("exact target cleanup succeeds");
    assert_eq!(stopped.session_id(), target.session_id);
    assert!(wait_for_process_absence(
        &target.provider_process,
        Duration::from_secs(3)
    ));
    assert!(wait_for_process_absence(
        &target.host_process,
        Duration::from_secs(7)
    ));
    assert!(wait_for_process_absence(
        &source.provider_process,
        Duration::from_secs(3)
    ));
    assert!(wait_for_process_absence(
        &source.host_process,
        Duration::from_secs(7)
    ));
}

#[test]
fn selected_to_default_rehost_response_loss_unsets_the_remote_inherited_selector() {
    let state = tempfile::tempdir().expect("isolated test state");
    let discovery_root = state.path().join("discovery");
    let isolated_home = state.path().join("remote-home");
    let selected_home = state.path().join("selected-codex-home");
    let selected_sqlite_home = state.path().join("selected-codex-sqlite-home");
    std::fs::create_dir_all(&isolated_home).expect("isolated remote home");
    std::fs::create_dir_all(&selected_home).expect("selected Codex home");
    std::fs::create_dir_all(&selected_sqlite_home).expect("selected Codex sqlite home");
    let cwd = std::env::current_dir()
        .expect("test cwd")
        .canonicalize()
        .expect("canonical test cwd");
    let runtime = PathBuf::from(env!("CARGO_BIN_EXE_hmux-runtime"));
    let _cleanup = ManagedFixtureCleanup {
        runtime: runtime.clone(),
        cwd: cwd.clone(),
        discovery_root: discovery_root.clone(),
    };
    let source_home_marker = state.path().join("source-codex-home");
    let target_home_marker = state.path().join("target-codex-home");
    let launch_marker = state.path().join("replacement-launches");
    let conversation_id = "conversation-ssh-selected-to-default";
    let selected_environment = ProviderStateEnvironment::from_mutations(
        BTreeMap::from([
            (
                "CODEX_HOME".to_string(),
                selected_home.to_string_lossy().into_owned(),
            ),
            (
                "CODEX_SQLITE_HOME".to_string(),
                selected_sqlite_home.to_string_lossy().into_owned(),
            ),
        ]),
        BTreeSet::from([
            "CODEX_ACCESS_TOKEN".to_string(),
            "CODEX_API_KEY".to_string(),
            "OPENAI_API_KEY".to_string(),
        ]),
    )
    .unwrap();
    let created = ManagedSessionCreator::new(&runtime)
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "ssh-selected-to-default-source-create",
                "ssh-selected-to-default-source",
                "ssh-selected-to-default-workspace",
                "codex",
                PermissionMode::BypassApprovals,
                &cwd,
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "printf '%s' \"$CODEX_HOME\" > \"$1\"; sleep 30".into(),
                    "--".into(),
                    source_home_marker.to_string_lossy().into_owned(),
                ],
                24,
                80,
            )
            .unwrap()
            .with_provider_state_environment(selected_environment)
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap()
            .with_conversation_identity(
                ProviderConversationIdentitySeed::new("codex", conversation_id).unwrap(),
            )
            .unwrap()
            .with_managed_rehost_recipe(
                ManagedRehostRecipe::new(
                    vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        "sleep 30".into(),
                        "--".into(),
                        MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                    ],
                    Some("selected-profile".into()),
                )
                .unwrap(),
            )
            .unwrap(),
        )
        .expect("selected source starts below the isolated discovery root");
    let source = created.session().descriptor().clone();
    wait_for_file_content(
        &source_home_marker,
        selected_home.to_string_lossy().as_ref(),
    );

    let default_environment = ProviderStateEnvironment::from_mutations(
        BTreeMap::new(),
        BTreeSet::from(["CODEX_HOME".to_string(), "CODEX_SQLITE_HOME".to_string()]),
    )
    .unwrap();
    let replacement = ManagedRehostReplacement::new(
        "codex",
        PermissionMode::BypassApprovals,
        &cwd,
        24,
        80,
        TerminalEnvironment::default(),
        None,
        default_environment,
        ManagedRehostRecipe::new(
            vec![
                "/bin/sh".into(),
                "-c".into(),
                "printf 'launch:%s\\n' \"$1\" >> \"$2\"; printf '%s' \"${CODEX_HOME-unset}\" > \"$3\"; sleep 30".into(),
                "--".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                launch_marker.to_string_lossy().into_owned(),
                target_home_marker.to_string_lossy().into_owned(),
            ],
            None,
        )
        .unwrap(),
    )
    .unwrap();
    let request = exact_rehost_request("ssh-selected-to-default-operation", &source)
        .with_expected_provider_id("codex")
        .unwrap()
        .with_expected_conversation_id(conversation_id)
        .unwrap()
        .with_expected_launch_reference("selected-profile")
        .unwrap()
        .with_replacement(replacement)
        .unwrap();
    let serialized = serde_json::to_value(&request).unwrap();
    assert_eq!(
        serialized["schema"],
        MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA
    );
    assert_eq!(
        serialized["schemaVersion"],
        MANAGED_REHOST_PROVIDER_STATE_REMOVAL_SCHEMA_VERSION
    );
    let reconcile = ManagedRehostReconcileRequest::by_operation_identity(
        request.operation_id(),
        request.source().session_id(),
        request.source().workspace_id(),
    )
    .unwrap();
    let ssh =
        SshFixture::start_with_poisoned_codex_home(&runtime, &cwd, &discovery_root, &isolated_home);

    let lost = rehost_managed_over_ssh(ssh.config(), request, Duration::from_secs(15))
        .expect_err("the first completed broker response is deliberately lost");
    assert!(matches!(lost, RemoteManagedRehostError::OutcomeUnknown(_)));
    let receipt =
        reconcile_managed_rehost_over_ssh(ssh.config(), reconcile, Duration::from_secs(15))
            .expect("the explicit default replacement reconciles by durable operation identity");

    assert!(receipt.replayed());
    assert_eq!(receipt.conversation_id(), Some(conversation_id));
    assert_eq!(receipt.launch_reference(), None);
    assert_eq!(
        ssh.observation.broker_invocations.load(Ordering::Acquire),
        2
    );
    assert_eq!(ssh.observation.lost_responses.load(Ordering::Acquire), 1);
    wait_for_lifecycle(
        &discovery_root,
        &source.session_id,
        &source.workspace_id,
        SessionLifecycle::Exited,
    );
    wait_for_file_content(&target_home_marker, "unset");
    assert_eq!(
        std::fs::read_to_string(&launch_marker).unwrap(),
        format!("launch:{conversation_id}\n"),
        "response recovery must not launch a second replacement"
    );

    let ready = LocalSessionCatalog::new(&discovery_root)
        .list()
        .unwrap()
        .into_iter()
        .filter(|descriptor| descriptor.lifecycle == SessionLifecycle::Ready)
        .collect::<Vec<_>>();
    assert_eq!(ready.len(), 1);
    assert_eq!(
        ready[0].session_id,
        receipt.replacement_receipt().session_id()
    );
    let target = &ready[0];
    ManagedSessionStopper::new(&runtime, &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_stop_request(
            "ssh-selected-to-default-target-cleanup",
            target,
        ))
        .unwrap();
    assert!(wait_for_process_absence(
        &target.provider_process,
        Duration::from_secs(3)
    ));
    assert!(wait_for_process_absence(
        &target.host_process,
        Duration::from_secs(7)
    ));
    assert!(wait_for_process_absence(
        &source.provider_process,
        Duration::from_secs(3)
    ));
    assert!(wait_for_process_absence(
        &source.host_process,
        Duration::from_secs(7)
    ));
}

#[test]
fn current_remote_broker_applies_exact_some_rolling_stop_to_old_host() {
    let state = tempfile::tempdir().expect("isolated test state");
    let discovery_root = state.path().join("discovery");
    let isolated_home = state.path().join("remote-home");
    std::fs::create_dir_all(&isolated_home).unwrap();
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let runtime = PathBuf::from(env!("CARGO_BIN_EXE_hmux-runtime"));
    let _cleanup = ManagedFixtureCleanup {
        runtime: runtime.clone(),
        cwd: cwd.clone(),
        discovery_root: discovery_root.clone(),
    };
    let ssh = SshFixture::start(&runtime, &cwd, &discovery_root, &isolated_home);
    let omitted = "managed_provider_conversation_fenced_stop_v1";

    let current = create_managed_over_ssh(
        ssh.config(),
        ManagedCreateRequest::new(
            "ssh-v5-create",
            "ssh-v5-session",
            "ssh-v5-workspace",
            "codex",
            PermissionMode::Default,
            &cwd,
            vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(
            hmux_client::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
        )
        .unwrap()
        .with_conversation_identity(
            ProviderConversationIdentitySeed::new("codex", "conversation-ssh-v5").unwrap(),
        )
        .unwrap(),
        Duration::from_secs(10),
    )
    .unwrap();
    let current_descriptor = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            current.session_id(),
            Some(current.workspace_id().to_string()),
        ))
        .unwrap();
    assert!(
        current_descriptor
            .capabilities
            .iter()
            .any(|capability| { capability == "managed_provider_conversation_fenced_stop_v1" })
    );
    stop_managed_over_ssh(
        ssh.config(),
        exact_conversation_stop(
            "ssh-v5-stop",
            &current_descriptor,
            Some("conversation-ssh-v5"),
            None,
        ),
        Duration::from_secs(10),
    )
    .unwrap();

    let discard = create_old_host(
        &runtime,
        &cwd,
        &discovery_root,
        "ssh-discard",
        "conversation-ssh-discard",
        omitted,
    );
    let stopped = stop_managed_over_ssh(
        ssh.config(),
        exact_conversation_stop(
            "ssh-discard-stop",
            &discard,
            Some("conversation-ssh-discard"),
            None,
        ),
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(stopped.session_id(), discard.session_id);

    let preserve = create_old_host(
        &runtime,
        &cwd,
        &discovery_root,
        "ssh-preserve",
        "conversation-ssh-preserve",
        omitted,
    );
    let quiescence = remote_waiting_fence(&runtime, &cwd, &discovery_root, &preserve);
    let stopped = stop_managed_over_ssh(
        ssh.config(),
        exact_conversation_stop(
            "ssh-preserve-stop",
            &preserve,
            Some("conversation-ssh-preserve"),
            Some(quiescence),
        ),
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(stopped.session_id(), preserve.session_id);

    for (suffix, expected) in [
        ("ssh-mismatch", Some("conversation-other")),
        ("ssh-none", None),
    ] {
        let actual = format!("conversation-{suffix}");
        let descriptor = create_old_host(&runtime, &cwd, &discovery_root, suffix, &actual, omitted);
        let error = stop_managed_over_ssh(
            ssh.config(),
            exact_conversation_stop(format!("{suffix}-refused"), &descriptor, expected, None),
            Duration::from_secs(10),
        )
        .unwrap_err();
        assert!(matches!(error, RemoteManagedStopError::Refused { .. }));
        assert_eq!(
            LocalSessionCatalog::new(&discovery_root)
                .find(&SessionSelector::new(
                    &descriptor.session_id,
                    Some(descriptor.workspace_id.clone()),
                ))
                .unwrap()
                .lifecycle,
            SessionLifecycle::Ready
        );
        ManagedSessionStopper::new(&runtime, &cwd)
            .with_discovery_root(&discovery_root)
            .stop(exact_conversation_stop(
                format!("{suffix}-cleanup"),
                &descriptor,
                Some(&actual),
                None,
            ))
            .unwrap();
    }

    let no_projection = create_old_host(
        &runtime,
        &cwd,
        &discovery_root,
        "ssh-no-projection",
        "conversation-ssh-no-projection",
        "managed_provider_conversation_fenced_stop_v1,provider_conversation_identity_v1",
    );
    let error = stop_managed_over_ssh(
        ssh.config(),
        exact_conversation_stop(
            "ssh-no-projection-refused",
            &no_projection,
            Some("conversation-ssh-no-projection"),
            None,
        ),
        Duration::from_secs(10),
    )
    .unwrap_err();
    assert!(matches!(error, RemoteManagedStopError::Refused { .. }));
    ManagedSessionStopper::new(&runtime, &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_stop_request(
            "ssh-no-projection-cleanup",
            &no_projection,
        ))
        .unwrap();
    assert!(!ssh.observation.requested_pty.load(Ordering::Acquire));
}

fn create_old_host(
    runtime: &Path,
    cwd: &Path,
    discovery_root: &Path,
    suffix: &str,
    conversation_id: &str,
    omitted_capabilities: &str,
) -> SessionDescriptor {
    let request = ManagedCreateRequest::new(
        format!("{suffix}-create"),
        format!("{suffix}-session"),
        "ssh-old-host-workspace",
        "codex",
        PermissionMode::Default,
        cwd,
        vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
        24,
        80,
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("codex", conversation_id).unwrap(),
    )
    .unwrap();
    let mut input = Vec::new();
    write_json_frame(&mut input, &request).unwrap();
    let mut child = Command::new(runtime)
        .arg("--no-autostart")
        .arg(hmux_runtime_contract::MANAGED_CREATE_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env(
            "HMUX_RUNTIME_TEST_HOST_OMIT_CAPABILITIES",
            omitted_capabilities,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let response: ManagedCreateBrokerResponse =
        read_json_frame(&mut Cursor::new(output.stdout)).unwrap();
    assert!(matches!(
        response,
        ManagedCreateBrokerResponse::Completed(_)
    ));
    let descriptor = LocalSessionCatalog::new(discovery_root)
        .find(&SessionSelector::new(
            format!("{suffix}-session"),
            Some("ssh-old-host-workspace".into()),
        ))
        .unwrap();
    assert!(
        !descriptor
            .capabilities
            .iter()
            .any(|capability| { capability == "managed_provider_conversation_fenced_stop_v1" })
    );
    descriptor
}

fn exact_conversation_stop(
    stop_id: impl Into<String>,
    descriptor: &SessionDescriptor,
    conversation_id: Option<&str>,
    quiescence: Option<ManagedStopQuiescenceFence>,
) -> ManagedStopRequest {
    let request = exact_stop_request(stop_id, descriptor)
        .with_expected_conversation(
            ManagedStopConversationFence::new("codex", conversation_id.map(ToString::to_string))
                .unwrap(),
        )
        .unwrap();
    quiescence.map_or(request.clone(), |fence| {
        request.with_expected_quiescence(fence).unwrap()
    })
}

fn remote_waiting_fence(
    runtime: &Path,
    cwd: &Path,
    discovery_root: &Path,
    descriptor: &SessionDescriptor,
) -> ManagedStopQuiescenceFence {
    ManagedAgentStateReporter::new(runtime, cwd)
        .with_discovery_root(discovery_root)
        .report_agent_state(
            ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id).unwrap(),
            AgentStateReport {
                identity_only: false,
                activity: AgentRuntimeActivity::Waiting,
                attention: AgentRuntimeAttention::None,
                turn_completed: false,
                turn_completion_id: None,
                causality: None,
                working_ttl_ms: None,
                conversation_identity: None,
                expected_observation: None,
            },
        )
        .unwrap();
    let observer = LocalSessionObserver::connect(
        &LocalSessionCatalog::new(discovery_root),
        &SessionSelector::new(
            &descriptor.session_id,
            Some(descriptor.workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let snapshot = &observer.attachment().initial_snapshot;
    let runtime = snapshot.agent_runtime_state.as_ref().unwrap();
    let fence = ManagedStopQuiescenceFence::new(
        &runtime.terminal_epoch,
        runtime.revision.parse().unwrap(),
        snapshot.sequence_through.parse().unwrap(),
    )
    .unwrap();
    observer.detach().unwrap();
    fence
}

fn exact_rehost_request(
    operation_id: &str,
    descriptor: &SessionDescriptor,
) -> ManagedRehostRequest {
    ManagedRehostRequest::new(
        operation_id,
        &descriptor.session_id,
        &descriptor.workspace_id,
        &descriptor.runner_principal,
        &descriptor.runner_instance,
        descriptor.channel_epoch.parse().unwrap(),
        &descriptor.host_instance_id,
        &descriptor.terminal_epoch,
        true,
    )
    .unwrap()
}

fn exact_stop_request(
    stop_id: impl Into<String>,
    descriptor: &SessionDescriptor,
) -> ManagedStopRequest {
    ManagedStopRequest::new(stop_id, &descriptor.session_id, &descriptor.workspace_id)
        .and_then(|request| {
            request.with_expected_fence(
                &descriptor.runner_principal,
                &descriptor.runner_instance,
                descriptor.channel_epoch.parse().unwrap(),
                &descriptor.host_instance_id,
                &descriptor.terminal_epoch,
            )
        })
        .unwrap()
}

fn wait_for_file_content(path: &Path, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if std::fs::read_to_string(path).ok().as_deref() == Some(expected) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "provider did not publish {expected:?} to {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_lifecycle(
    discovery_root: &Path,
    session_id: &str,
    workspace_id: &str,
    lifecycle: SessionLifecycle,
) {
    let catalog = LocalSessionCatalog::new(discovery_root);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let current = catalog
            .find(&SessionSelector::new(
                session_id,
                Some(workspace_id.to_string()),
            ))
            .unwrap()
            .lifecycle;
        if current == lifecycle {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "lifecycle did not reach {lifecycle:?}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_surface_text(surface: &mut TerminalSurfaceAttachment, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !surface.current_frame().text().contains(expected) {
        assert!(
            Instant::now() < deadline,
            "structured target never rendered {expected:?}"
        );
        match surface.read_event().expect("structured target event") {
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Receipt(receipt) => {
                panic!("unexpected receipt while waiting for target output: {receipt:?}")
            }
            TerminalSurfaceEvent::Control(body) => {
                if matches!(*body, FrameBody::Exit(_) | FrameBody::Error(_)) {
                    panic!("target ended before rendering {expected:?}: {body:?}")
                }
            }
        }
    }
}

fn wait_for_surface_geometry(surface: &mut TerminalSurfaceAttachment, columns: u32, rows: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while (
        surface.current_frame().viewport().canonical_columns,
        surface.current_frame().viewport().viewport_rows,
    ) != (columns, rows)
    {
        assert!(
            Instant::now() < deadline,
            "structured target did not publish geometry {columns}x{rows}"
        );
        match surface
            .read_event()
            .expect("structured target resize event")
        {
            TerminalSurfaceEvent::Frame(_) | TerminalSurfaceEvent::Event(_) => {}
            TerminalSurfaceEvent::Receipt(receipt) => {
                panic!("unexpected receipt while waiting for target geometry: {receipt:?}")
            }
            TerminalSurfaceEvent::Control(body) => {
                if matches!(*body, FrameBody::Exit(_) | FrameBody::Error(_)) {
                    panic!("target ended before publishing resized geometry: {body:?}")
                }
            }
        }
    }
}

fn wait_for_process_absence(process: &hmux_client::ProcessDescriptor, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if matches!(
            probe_local_process_generation(process),
            Ok(LocalProcessGenerationStatus::Absent)
        ) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(20));
    }
}
