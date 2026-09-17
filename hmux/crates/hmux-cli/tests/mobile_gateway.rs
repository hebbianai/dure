//! Drives the real `hmux mobile-gateway` subcommand over a pipe pair against a
//! real local Host.
//!
//! The subprocess is the point. Two of the properties under test — that stdout
//! carries frames and nothing else, and that diagnostics reach the operator on
//! stderr — are properties of the process, not of a function: an in-process
//! harness would never notice a stray `println!`.
//!
//! Against unmodified `main`, every test here fails at spawn: `mobile-gateway`
//! is not a subcommand, so clap exits 2 and the first frame read returns a
//! clean EOF instead of a `HelloAck`.
#![cfg(unix)]

use base64::Engine as _;
use hmux_client::{
    LocalAttachRole, LocalConnection, LocalSession, LocalSessionCatalog, SessionDescriptor,
    SessionLifecycle, SessionProbeStatus, SessionRetirementPolicy, SessionSelector,
    StandaloneCreateRequest, StandaloneSessionCreator, probe_local_session_exact,
    probe_local_session_exact_until,
};
use hmux_host::local_protocol::{
    AGENT_STATE_REPORT_CAPABILITY, AttachMode, Detach, ErrorCode, Exit, FrameBody, FrameCodec,
    FrameLimits, Hello, Input, InputReceiptState, PROTOCOL_V1, RECONNECT_RESUME_CAPABILITY,
    ReconnectCursor, RetryPosture, SESSION_RETIREMENT_CAPABILITY, SHARED_TERMINAL_INPUT_CAPABILITY,
    STANDALONE_TERMINATION_CAPABILITY, ScreenSnapshotRequest, SessionFence,
    SessionRetirementAction, SessionRetirementReceiptState, SessionRetirementRequest,
    StandaloneTerminate, VersionRange, WireFrame,
};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const FRAME_TIMEOUT: Duration = Duration::from_secs(10);

#[path = "mobile_gateway/retirement_tests.rs"]
mod retirement_tests;

#[path = "mobile_gateway/resolution_tests.rs"]
mod resolution_tests;

/// The runtime binary lands beside this package's binary in the same profile
/// directory. Failing loudly beats skipping: a silently skipped relay test is
/// indistinguishable from a passing one.
fn runtime_executable() -> PathBuf {
    let hmux = PathBuf::from(env!("CARGO_BIN_EXE_hmux"));
    let runtime = hmux.with_file_name(format!("hmux-runtime{}", std::env::consts::EXE_SUFFIX));
    assert!(
        runtime.is_file(),
        "hmux-runtime is missing at {}; run the workspace gate (`cargo test --workspace`)",
        runtime.display()
    );
    runtime
}

struct Fixture {
    _state: tempfile::TempDir,
    discovery_root: PathBuf,
    catalog: LocalSessionCatalog,
    session: LocalSession,
    descriptor: SessionDescriptor,
    launch_owner_proof: String,
}

/// A provider that answers each typed line, and can be told to fill the screen.
///
/// The flood is what makes the resume assertion mean something: a cold attach
/// has to be genuinely expensive before "the reattach cost less" is a claim
/// rather than a rounding difference. 256 KiB sits above the frame cap for a
/// single delta and well inside the Host's 4 MiB retention, so the screen is
/// large and the away-time deltas are still replayable.
const ANSWERING_PROVIDER: &str = "while IFS= read -r line; do case \"$line\" in \
     flood) head -c 262144 /dev/zero | tr '\\0' 'x'; printf '\\nflood-done\\n' ;; \
     *) printf 'relayed:%s\\n' \"$line\" ;; esac; done";

impl Fixture {
    fn start() -> Self {
        // One line, then idle. Kept as the default because most tests here
        // assert about frames rather than about output, and a provider that
        // never speaks again cannot race a frame assertion.
        Self::start_with_provider("IFS= read -r line; printf 'relayed:%s\\n' \"$line\"; sleep 30")
    }

    fn start_with_provider(provider_script: &str) -> Self {
        Self::start_with_provider_and_retirement(provider_script, None)
    }

    fn start_with_provider_and_retirement(
        provider_script: &str,
        retirement_policy: Option<SessionRetirementPolicy>,
    ) -> Self {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let creator = StandaloneSessionCreator::new(runtime_executable())
            .with_discovery_root(&discovery_root);
        let request = StandaloneCreateRequest::new(
            std::env::current_dir().unwrap().canonicalize().unwrap(),
            Some("gateway-smoke".into()),
            vec!["/bin/sh".into(), "-c".into(), provider_script.into()],
            24,
            80,
        )
        .unwrap()
        .with_retirement_policy_option(retirement_policy)
        .unwrap();
        let created = creator.create(request).unwrap();
        let launch_owner_proof = created.receipt().launch_owner_proof().to_string();
        let session = created.session().clone();
        let catalog = LocalSessionCatalog::new(&discovery_root);
        let descriptor = catalog
            .find(&SessionSelector::new(
                session.descriptor().session_id.clone(),
                Some(session.descriptor().workspace_id.clone()),
            ))
            .unwrap();
        Self {
            _state: state,
            discovery_root,
            catalog,
            session,
            descriptor,
            launch_owner_proof,
        }
    }

    fn fence(&self) -> SessionFence {
        SessionFence {
            workspace_id: self.descriptor.workspace_id.clone(),
            session_id: self.descriptor.session_id.clone(),
            runner_principal: self.descriptor.runner_principal.clone(),
            runner_instance: self.descriptor.runner_instance.clone(),
            channel_epoch: self.descriptor.channel_epoch.parse().unwrap(),
            host_instance_id: self.descriptor.host_instance_id.clone(),
            terminal_epoch: self.descriptor.terminal_epoch.clone(),
        }
    }

    fn gateway(&self, role: &str) -> RelayClient {
        RelayClient::spawn(&self.discovery_root, &self.descriptor.session_id, role)
    }

    /// Reads the Host's controller generation without moving it.
    ///
    /// This has to be a *non*-mutating probe or it cannot be used as a
    /// before/after measurement. An Observer attach takes the
    /// `AttachMode::Observer` branch of the Host's admission block, which reads
    /// `host.controller_generation()` and never calls `grant_control` —
    /// contrast the Controller branch, which grants on the way in and releases
    /// on teardown, moving the generation twice per attach.
    fn controller_generation(&self) -> u64 {
        self.session
            .connect(LocalAttachRole::Observer, None)
            .expect("an observer attach must succeed")
            .hello_ack()
            .controller_generation
    }

    /// Runs `--list` to completion and returns stdout verbatim.
    ///
    /// Verbatim on purpose: the containment assertion has to run against the
    /// bytes that actually left the process, not against a re-serialization of
    /// something already parsed.
    fn list(&self, session: Option<&str>) -> Vec<u8> {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hmux"));
        command
            .arg("--discovery-root")
            .arg(&self.discovery_root)
            .arg("mobile-gateway")
            .arg("--list");
        if let Some(session) = session {
            command.arg("--session").arg(session);
        }
        let output = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mobile-gateway --list failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }

    fn gateway_request(&self, request: serde_json::Value) -> serde_json::Value {
        gateway_request(&self.discovery_root, request)
    }

    fn abandon_unpresented_creation(&self, request_id: &str) -> serde_json::Value {
        self.gateway_request(serde_json::json!({
            "gateway_request_version": 3,
            "request": {
                "abandon_unpresented_creation": {
                    "request_id": request_id,
                    "session_id": self.descriptor.session_id,
                    "workspace_id": self.descriptor.workspace_id,
                    "launch_owner_proof": self.launch_owner_proof
                }
            }
        }))
    }

    fn session_input_request(&self, request_id: &str, bytes: &[u8]) -> serde_json::Value {
        serde_json::json!({
            "gateway_request_version": 5,
            "request": {
                "write_session_input": {
                    "request_id": request_id,
                    "expected_fence": self.fence(),
                    "bytes": bytes
                }
            }
        })
    }

    fn wait_until_exited(&self) {
        let deadline = Instant::now() + FRAME_TIMEOUT;
        let selector = SessionSelector::new(
            self.descriptor.session_id.clone(),
            Some(self.descriptor.workspace_id.clone()),
        );
        loop {
            let descriptor = self.catalog.find(&selector).unwrap();
            if descriptor.lifecycle == SessionLifecycle::Exited {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "abandoned Host stayed live past the deadline"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// The Host's real `capability_token`, read straight off the manifest.
    ///
    /// A hardcoded literal would prove nothing here — the assertion has to be
    /// against the value this Host actually minted.
    fn capability_token(&self) -> String {
        // The manifest nests the token under a lifecycle-tagged envelope, so
        // the search is over the JSON tree rather than the top level — a
        // top-level lookup silently returned `None` and would have made the
        // containment assertion untestable rather than failing loudly.
        fn token_in(value: &serde_json::Value) -> Option<String> {
            match value {
                serde_json::Value::Object(fields) => {
                    if let Some(token) = fields.get("capability_token").and_then(|t| t.as_str()) {
                        return Some(token.to_string());
                    }
                    fields.values().find_map(token_in)
                }
                serde_json::Value::Array(items) => items.iter().find_map(token_in),
                _ => None,
            }
        }
        fn find(directory: &std::path::Path) -> Option<String> {
            for entry in std::fs::read_dir(directory).ok()? {
                let path = entry.ok()?.path();
                if path.is_dir() {
                    if let Some(found) = find(&path) {
                        return Some(found);
                    }
                } else if path.file_name().is_some_and(|name| name == "manifest.json") {
                    let text = std::fs::read_to_string(&path).ok()?;
                    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
                    if let Some(token) = token_in(&json) {
                        return Some(token);
                    }
                }
            }
            None
        }
        let token = find(&self.discovery_root)
            .expect("the standalone Host must have published a capability_token");
        assert!(
            !token.is_empty(),
            "an empty token would make the containment assertion vacuous"
        );
        token
    }
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn wait_until_exists(path: &Path) {
    let deadline = Instant::now() + FRAME_TIMEOUT;
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "provider readiness marker was not published at {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(10));
    }
}

/// Splits a `--list` stdout into its length-prefixed JSON documents, and proves
/// the stream ended on a document boundary rather than mid-write.
fn catalog_documents(bytes: &[u8]) -> Vec<serde_json::Value> {
    let mut documents = Vec::new();
    let mut offset = 0;
    while offset < bytes.len() {
        assert!(
            offset + 4 <= bytes.len(),
            "the listing ended inside a length prefix at byte {offset}"
        );
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        assert!(
            offset + length <= bytes.len(),
            "the listing declared {length} bytes but only {} remain",
            bytes.len() - offset
        );
        documents.push(serde_json::from_slice(&bytes[offset..offset + length]).unwrap());
        offset += length;
    }
    documents
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self
            .session
            .terminate_standalone(&self.catalog, Duration::from_secs(2));
    }
}

fn gateway_request(
    discovery_root: &std::path::Path,
    request: serde_json::Value,
) -> serde_json::Value {
    gateway_request_with_environment(discovery_root, request, &[])
}

fn gateway_request_with_environment(
    discovery_root: &std::path::Path,
    request: serde_json::Value,
    environment: &[(&str, &Path)],
) -> serde_json::Value {
    let output = gateway_request_output_with_environment(discovery_root, request, environment);
    assert!(
        output.status.success(),
        "mobile-gateway request failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut documents = catalog_documents(&output.stdout);
    assert_eq!(
        documents.len(),
        1,
        "gateway request must return one typed document; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    documents.pop().unwrap()
}

fn gateway_request_output(
    discovery_root: &std::path::Path,
    request: serde_json::Value,
) -> std::process::Output {
    gateway_request_output_with_environment(discovery_root, request, &[])
}

fn gateway_request_output_with_environment(
    discovery_root: &std::path::Path,
    request: serde_json::Value,
    environment: &[(&str, &Path)],
) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hmux"));
    command
        .arg("--discovery-root")
        .arg(discovery_root)
        .arg("mobile-gateway")
        .arg("--role")
        .arg("controller")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in environment {
        command.env(key, value);
    }
    let mut child = command.spawn().unwrap();
    let payload = serde_json::to_vec(&request).unwrap();
    let mut encoded = u32::try_from(payload.len()).unwrap().to_be_bytes().to_vec();
    encoded.extend_from_slice(&payload);
    child
        .stdin
        .take()
        .expect("gateway stdin")
        .write_all(&encoded)
        .unwrap();
    child.wait_with_output().unwrap()
}

#[derive(Debug)]
enum Inbound {
    Frame(Box<WireFrame>),
    /// The stream ended exactly on a frame boundary — nothing but frames was
    /// ever written.
    CleanEof,
    /// Bytes that are not a frame: a stray `println!`, an rc-file banner, a
    /// truncated prefix.
    NotAFrame(String),
}

struct RelayClient {
    child: Child,
    stdin: Option<ChildStdin>,
    /// Each message carries the running total of stdout bytes consumed through
    /// it, prefix included. Counting on this side rather than in the reader
    /// thread is what makes the number a measurement of what the *test* has
    /// taken delivery of — a shared counter would race ahead by however many
    /// frames the reader had already pulled off the pipe.
    inbound: mpsc::Receiver<(Inbound, usize)>,
    consumed_bytes: std::cell::Cell<usize>,
    stderr: Option<thread::JoinHandle<String>>,
}

impl RelayClient {
    fn spawn(discovery_root: &std::path::Path, session_id: &str, role: &str) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_hmux"))
            .arg("--discovery-root")
            .arg(discovery_root)
            .arg("mobile-gateway")
            .arg("--session")
            .arg(session_id)
            .arg("--role")
            .arg(role)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (sender, inbound) = mpsc::channel();
        thread::spawn(move || {
            let codec = FrameCodec::new(FrameLimits::default());
            let mut total = 0_usize;
            loop {
                let message = match read_length_prefix(&mut stdout) {
                    PrefixOutcome::Eof => Inbound::CleanEof,
                    PrefixOutcome::Partial(observed) => Inbound::NotAFrame(format!(
                        "stdout ended mid-length-prefix after {observed} bytes"
                    )),
                    PrefixOutcome::Length(length) => {
                        let mut payload = vec![0_u8; length];
                        match stdout.read_exact(&mut payload) {
                            Ok(()) => {
                                total += 4 + length;
                                let mut encoded = (length as u32).to_be_bytes().to_vec();
                                encoded.extend_from_slice(&payload);
                                match codec.decode(&encoded) {
                                    Ok(frame) => Inbound::Frame(Box::new(frame)),
                                    Err(error) => {
                                        Inbound::NotAFrame(format!("undecodable frame: {error}"))
                                    }
                                }
                            }
                            Err(error) => {
                                Inbound::NotAFrame(format!("stdout ended mid-payload: {error}"))
                            }
                        }
                    }
                };
                let terminal = !matches!(message, Inbound::Frame(_));
                if sender.send((message, total)).is_err() || terminal {
                    break;
                }
            }
        });
        let stderr = thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            text
        });
        Self {
            child,
            stdin: Some(stdin),
            inbound,
            consumed_bytes: std::cell::Cell::new(0),
            stderr: Some(stderr),
        }
    }

    fn send(&mut self, body: FrameBody, frame_id: u64) {
        let codec = FrameCodec::new(FrameLimits::default());
        let encoded = codec
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id,
                body,
            })
            .unwrap();
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&encoded).unwrap();
        stdin.flush().unwrap();
    }

    fn next(&self) -> Inbound {
        let (message, total) = self
            .inbound
            .recv_timeout(FRAME_TIMEOUT)
            .expect("mobile-gateway produced nothing before the deadline");
        self.consumed_bytes.set(total);
        message
    }

    /// Every stdout byte this client has taken delivery of, length prefixes
    /// included — the number a phone would have paid for on a cellular link.
    fn consumed_bytes(&self) -> usize {
        self.consumed_bytes.get()
    }

    fn next_body(&self) -> FrameBody {
        match self.next() {
            Inbound::Frame(frame) => {
                assert_eq!(frame.protocol_version, PROTOCOL_V1);
                assert_ne!(frame.frame_id, 0);
                frame.body
            }
            other => panic!("expected a frame, got {other:?}"),
        }
    }

    /// Writes bytes the codec never produced. Needed because every property
    /// about *undecodable* input is unreachable through a typed `FrameBody`.
    fn send_raw(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(bytes).unwrap();
        stdin.flush().unwrap();
    }

    /// A well-formed length prefix in front of a hand-written payload.
    ///
    /// Hand-written JSON is the only way to reach the properties under test: the
    /// codec refuses to encode an undecodable frame or an over-limit one, which
    /// is exactly why only a peer that does not share this binary's rules can
    /// produce them.
    ///
    /// Note `frame_id` is a JSON **string**, not a number (`json_u64`, so a
    /// `u64` survives a JavaScript client). A number there fails deserialization
    /// on `frame_id` — which silently turns every "unknown body kind" test into
    /// a "malformed envelope" test that passes for the wrong reason. The
    /// oversized-paste case below shares this envelope verbatim and *must*
    /// decode, which is what keeps the two honest.
    fn send_framed_payload(&mut self, payload: &[u8]) {
        let mut bytes = u32::try_from(payload.len()).unwrap().to_be_bytes().to_vec();
        bytes.extend_from_slice(payload);
        self.send_raw(&bytes);
    }

    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    fn stderr(&mut self) -> String {
        self.close_stdin();
        let _ = self.child.wait();
        self.stderr.take().map(|h| h.join().unwrap()).unwrap()
    }
}

impl Drop for RelayClient {
    fn drop(&mut self) {
        self.stdin = None;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

enum PrefixOutcome {
    Eof,
    Partial(usize),
    Length(usize),
}

/// Distinguishes "the stream ended on a frame boundary" from "the stream ended
/// somewhere else", which is what makes the stdout-purity claim checkable.
fn read_length_prefix(reader: &mut impl Read) -> PrefixOutcome {
    let mut prefix = [0_u8; 4];
    let mut filled = 0;
    while filled < prefix.len() {
        match reader.read(&mut prefix[filled..]) {
            Ok(0) if filled == 0 => return PrefixOutcome::Eof,
            Ok(0) => return PrefixOutcome::Partial(filled),
            Ok(count) => filled += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) if filled == 0 => return PrefixOutcome::Eof,
            Err(_) => return PrefixOutcome::Partial(filled),
        }
    }
    PrefixOutcome::Length(u32::from_be_bytes(prefix) as usize)
}

/// A `Hello` from a phone that speaks resume: it negotiates the capability
/// every time, and offers a position only when it has one.
///
/// Both halves are what a real reconnecting client sends — `hmux-client` adds
/// `reconnect_resume_v1` to its requested set exactly when a cursor is set — and
/// keeping them together here is what makes the two attaches in the test differ
/// in one thing only.
fn resuming_hello(fence: SessionFence, cursor: Option<ReconnectCursor>) -> FrameBody {
    let FrameBody::Hello(mut frame) = hello(
        fence,
        AttachMode::Observer,
        &[
            "screen_snapshot",
            "live_output",
            RECONNECT_RESUME_CAPABILITY,
        ],
    ) else {
        unreachable!("hello() builds a Hello");
    };
    frame.reconnect_cursor = cursor;
    FrameBody::Hello(frame)
}

fn hello(fence: SessionFence, mode: AttachMode, capabilities: &[&str]) -> FrameBody {
    FrameBody::Hello(Hello {
        supported_versions: VersionRange {
            minimum: PROTOCOL_V1,
            maximum: PROTOCOL_V1,
        },
        requested_capabilities: capabilities.iter().map(|c| (*c).to_string()).collect(),
        expected_fence: fence,
        requested_mode: mode,
        reconnect_cursor: None,
        // The gateway ignores this field entirely: it mints its own Hello with
        // the token it read off the local disk. A relayed client has no token
        // and, until scoped grants exist, is not asked for one.
        capability_token: "relayed-client-has-no-token".into(),
        authorization_proof_reference: None,
        initial_snapshot_profile: None,
    })
}

fn expect_error(body: FrameBody) -> hmux_host::local_protocol::ErrorFrame {
    match body {
        FrameBody::Error(error) => error,
        other => panic!("expected an error frame, got {other:?}"),
    }
}

/// The next error frame, skipping the session traffic that keeps arriving
/// because the session is still alive — which is itself half the property.
fn next_error(relay: &RelayClient) -> hmux_host::local_protocol::ErrorFrame {
    loop {
        match relay.next_body() {
            FrameBody::Error(error) => return error,
            FrameBody::OutputDelta(_)
            | FrameBody::AgentRuntimeState(_)
            | FrameBody::ScreenSnapshot(_) => {}
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
}

/// Proves the attach still works after a refusal: a request goes up and its
/// answer comes back. Also proves the refused frame never reached the Host,
/// since a Host that had acted on it would not still be answering.
fn assert_session_still_answers(relay: &mut RelayClient, fence: SessionFence, request_id: &str) {
    relay.send(
        FrameBody::ScreenSnapshotRequest(ScreenSnapshotRequest {
            request_id: request_id.into(),
            expected_fence: fence,
            profile: None,
        }),
        99,
    );
    loop {
        match relay.next_body() {
            FrameBody::ScreenSnapshot(snapshot)
                if snapshot.in_reply_to_request_id.as_deref() == Some(request_id) =>
            {
                return;
            }
            FrameBody::ScreenSnapshot(_)
            | FrameBody::OutputDelta(_)
            | FrameBody::AgentRuntimeState(_) => {}
            other => panic!("the session did not survive the refusal: {other:?}"),
        }
    }
}

fn handshake(fixture: &Fixture, relay: &mut RelayClient) {
    relay.send(
        hello(
            fixture.fence(),
            AttachMode::Observer,
            &["screen_snapshot", "live_output"],
        ),
        1,
    );
    assert!(matches!(relay.next_body(), FrameBody::HelloAck(_)));
    assert!(matches!(relay.next_body(), FrameBody::ScreenSnapshot(_)));
}

#[test]
fn gateway_v2_creates_and_reconciles_a_deterministic_fresh_standalone() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("new-home/state/hmux-hosts");
    assert!(!discovery_root.exists());
    let request = serde_json::json!({
        "gateway_request_version": 2,
        "request": {
            "create_standalone": {
                "request_id": "gateway-fresh-request",
                "target_session_id": "standalone_gatewayfresh01",
                "launch_owner_proof": "gateway-fresh-launch-owner-proof",
                "session_name": "gateway-fresh",
                "bridge_nonce": "gateway-fresh-bridge-nonce",
                "initial_rows": 24,
                "initial_columns": 80,
                "command_intercepts": [{
                    "command": "codex",
                    "provider_id": "codex"
                }],
                "retirement_policy": null
            }
        }
    });

    let first = gateway_request(&discovery_root, request.clone());
    assert_eq!(first["gateway_create_version"], 1);
    assert_eq!(first["request_id"], "gateway-fresh-request");
    assert_eq!(first["session"]["session_id"], "standalone_gatewayfresh01");

    let catalog = LocalSessionCatalog::new(&discovery_root);
    let created = catalog
        .find(&SessionSelector::new(
            "standalone_gatewayfresh01",
            first["session"]["workspace_id"]
                .as_str()
                .map(str::to_string),
        ))
        .unwrap();
    assert_eq!(
        probe_local_session_exact(&catalog, &created),
        SessionProbeStatus::Healthy
    );

    let retried = gateway_request(&discovery_root, request);
    assert_eq!(
        retried["session"]["host_instance_id"],
        first["session"]["host_instance_id"]
    );
    assert_eq!(
        retried["session"]["terminal_epoch"],
        first["session"]["terminal_epoch"]
    );

    catalog
        .open(&SessionSelector::new(
            &created.session_id,
            Some(created.workspace_id.clone()),
        ))
        .unwrap()
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
}

#[test]
fn gateway_v7_uses_requested_cwd_without_replacing_remote_home_startup() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let remote_home = state.path().join("remote-home");
    let requested_cwd = state.path().join("remote-project");
    let home_started = state.path().join("home-started");
    let project_started = state.path().join("project-started");
    for directory in [&discovery_root, &remote_home, &requested_cwd] {
        std::fs::create_dir(directory).unwrap();
    }
    std::fs::set_permissions(&discovery_root, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(
        remote_home.join(".bash_profile"),
        format!("printf home > {}\n", shell_quote(&home_started)),
    )
    .unwrap();
    std::fs::write(
        requested_cwd.join(".bash_profile"),
        format!("printf project > {}\n", shell_quote(&project_started)),
    )
    .unwrap();
    let environment = [
        ("HOME", remote_home.as_path()),
        ("SHELL", Path::new("/bin/bash")),
    ];
    let request = serde_json::json!({
        "gateway_request_version": 7,
        "request": {
            "create_standalone": {
                "request_id": "gateway-cwd-request",
                "target_session_id": "standalone_gatewaycwd01",
                "launch_owner_proof": "gateway-cwd-launch-owner-proof",
                "session_name": "gateway-cwd",
                "bridge_nonce": "gateway-cwd-bridge-nonce",
                "cwd": requested_cwd,
                "initial_rows": 24,
                "initial_columns": 80,
                "command_intercepts": [{
                    "command": "codex",
                    "provider_id": "codex"
                }],
                "retirement_policy": null
            }
        }
    });

    let first = gateway_request_with_environment(&discovery_root, request.clone(), &environment);
    assert_eq!(first["gateway_create_version"], 1);
    assert_eq!(first["session"]["session_id"], "standalone_gatewaycwd01");

    let catalog = LocalSessionCatalog::new(&discovery_root);
    let selector = SessionSelector::new(
        "standalone_gatewaycwd01",
        first["session"]["workspace_id"]
            .as_str()
            .map(str::to_string),
    );
    let created = catalog.find(&selector).unwrap();
    let observer = catalog
        .open(&selector)
        .unwrap()
        .connect(LocalAttachRole::Observer, None)
        .unwrap();
    assert_eq!(
        observer
            .require_initial_snapshot()
            .unwrap()
            .working_directory
            .as_ref()
            .map(|working| working.path.as_str()),
        Some(requested_cwd.canonicalize().unwrap().to_str().unwrap())
    );
    observer.shutdown();
    let deadline = Instant::now() + FRAME_TIMEOUT;
    while !home_started.exists() && !project_started.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }

    let retried = gateway_request_with_environment(&discovery_root, request, &environment);
    assert_eq!(
        retried["session"]["host_instance_id"],
        first["session"]["host_instance_id"]
    );
    assert_eq!(
        retried["session"]["terminal_epoch"],
        first["session"]["terminal_epoch"]
    );

    catalog
        .open(&selector)
        .unwrap()
        .terminate_standalone(&catalog, Duration::from_secs(3))
        .unwrap();
    assert!(
        home_started.exists(),
        "the remote HOME startup file was not evaluated"
    );
    assert!(
        !project_started.exists(),
        "the requested cwd replaced the remote HOME startup authority"
    );
    assert_eq!(created.session_id, "standalone_gatewaycwd01");
}

#[test]
fn exact_input_coexists_with_and_does_not_replace_the_ui_controller() {
    let fixture = Fixture::start_with_provider(ANSWERING_PROVIDER);
    let mut ui_controller = fixture
        .session
        .connect(LocalAttachRole::Controller, None)
        .expect("the UI controller attaches first");
    let generation = ui_controller.hello_ack().controller_generation;

    let response = fixture
        .gateway_request(fixture.session_input_request("request-input-1", b"from-gateway\n"));
    assert_eq!(response["gateway_input_version"], 1);
    assert_eq!(response["request_id"], "request-input-1");
    assert_eq!(response["session_id"], fixture.descriptor.session_id);
    assert_eq!(response["workspace_id"], fixture.descriptor.workspace_id);
    assert_eq!(response["receipt"]["state"], "written_to_pty");

    ui_controller
        .writer()
        .send(FrameBody::Input(Input {
            request_id: "ui-after-gateway".into(),
            controller_generation: generation,
            bytes: b"from-ui-after-gateway\n".to_vec(),
        }))
        .expect("the original UI controller remains writable");
    loop {
        match ui_controller.read_body().unwrap() {
            FrameBody::InputReceipt(receipt) if receipt.request_id == "ui-after-gateway" => {
                assert_eq!(receipt.state, InputReceiptState::WrittenToPty);
                assert_eq!(receipt.controller_generation, generation);
                break;
            }
            FrameBody::OutputDelta(_) | FrameBody::ScreenSnapshot(_) => {}
            other => panic!("unexpected UI controller response after gateway input: {other:?}"),
        }
    }
}

#[test]
fn exact_input_refuses_a_stale_complete_fence_before_writing() {
    let fixture = Fixture::start_with_provider(ANSWERING_PROVIDER);
    let mut request = fixture.session_input_request("request-stale", b"must-not-land\n");
    request["request"]["write_session_input"]["expected_fence"]["terminal_epoch"] =
        "stale-terminal".into();

    let output = gateway_request_output(&fixture.discovery_root, request);
    assert!(!output.status.success());
    let documents = catalog_documents(&output.stdout);
    assert_eq!(documents.len(), 1);
    assert_eq!(documents[0]["body"]["kind"], "error");
    assert_eq!(documents[0]["body"]["payload"]["code"], "identity_mismatch");
    assert_eq!(
        documents[0]["body"]["payload"]["in_reply_to_request_id"],
        "request-stale"
    );
    let snapshot = fixture.session.read_screen(None).unwrap();
    assert!(!contains_bytes(&snapshot.repaint_bytes, b"must-not-land"));
}

#[test]
fn exact_input_never_reports_success_after_the_provider_epoch_exits() {
    let fixture = Fixture::start_with_provider("IFS= read -r line; exit 0");
    let receipt = fixture.session.send_input(b"exit\n".to_vec()).unwrap();
    assert_eq!(receipt.state, InputReceiptState::WrittenToPty);
    fixture.wait_until_exited();

    let output = gateway_request_output(
        &fixture.discovery_root,
        fixture.session_input_request("request-after-exit", b"must-not-land\n"),
    );
    assert!(!output.status.success());
    let documents = catalog_documents(&output.stdout);
    assert_eq!(documents.len(), 1);
    assert_eq!(documents[0]["body"]["kind"], "error");
    assert_ne!(documents[0]["body"]["payload"]["code"], "written_to_pty");
    assert_eq!(
        documents[0]["body"]["payload"]["in_reply_to_request_id"],
        "request-after-exit"
    );
}

#[test]
fn controller_gateway_relays_an_observer_scoped_graceful_departure() {
    let policy = SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
        grace_period_ms: 2_000,
    };
    let fixture = Fixture::start_with_provider_and_retirement("exec /bin/sh", Some(policy));
    let mut relay = fixture.gateway("controller");
    relay.send(
        hello(
            fixture.fence(),
            AttachMode::Observer,
            &["screen_snapshot", SESSION_RETIREMENT_CAPABILITY],
        ),
        1,
    );

    let ack = match relay.next_body() {
        FrameBody::HelloAck(ack) => ack,
        other => panic!("expected hello_ack, got {other:?}"),
    };
    assert!(
        ack.selected_capabilities
            .iter()
            .any(|capability| capability == SESSION_RETIREMENT_CAPABILITY),
        "the real controller gateway withheld observer-scoped retirement"
    );
    assert!(matches!(relay.next_body(), FrameBody::ScreenSnapshot(_)));

    relay.send(
        FrameBody::SessionRetirementRequest(SessionRetirementRequest {
            request_id: "remote-pane-departure".into(),
            expected_fence: fixture.fence(),
            action: SessionRetirementAction::GracefulClientDeparture,
        }),
        2,
    );
    let receipt = loop {
        match relay.next_body() {
            FrameBody::SessionRetirementReceipt(receipt)
                if receipt.request_id == "remote-pane-departure" =>
            {
                break receipt;
            }
            FrameBody::OutputDelta(_)
            | FrameBody::AgentRuntimeState(_)
            | FrameBody::ScreenSnapshot(_) => {}
            other => panic!("expected a retirement receipt, got {other:?}"),
        }
    };
    assert_eq!(
        receipt.state,
        SessionRetirementReceiptState::RetirementArmed
    );
    assert_eq!(receipt.policy, Some(policy));
}

#[test]
fn relayed_observer_round_trips_frames_and_stdout_carries_nothing_else() {
    let fixture = Fixture::start();
    let mut relay = fixture.gateway("observer");
    relay.send(
        hello(
            fixture.fence(),
            AttachMode::Observer,
            &["screen_snapshot", "live_output"],
        ),
        1,
    );

    let ack = match relay.next_body() {
        FrameBody::HelloAck(ack) => ack,
        other => panic!("expected hello_ack, got {other:?}"),
    };
    assert!(ack.selected_capabilities.iter().any(|c| c == "live_output"));
    assert!(
        ack.selected_capabilities
            .iter()
            .any(|c| c == "screen_snapshot")
    );
    // The ruling: these three stay colocation-premised and are withheld from a
    // relayed attach regardless of AttachMode. The gateway never requests them,
    // so the Host's request/advertise intersection never selects them.
    for withheld in [
        SHARED_TERMINAL_INPUT_CAPABILITY,
        STANDALONE_TERMINATION_CAPABILITY,
        AGENT_STATE_REPORT_CAPABILITY,
    ] {
        assert!(
            !ack.selected_capabilities.iter().any(|c| c == withheld),
            "{withheld} must never be granted through the relay: {:?}",
            ack.selected_capabilities
        );
    }
    assert_eq!(ack.actual_fence, fixture.fence());

    assert!(matches!(relay.next_body(), FrameBody::ScreenSnapshot(_)));

    // Upstream then downstream: a frame written to the gateway's stdin reaches
    // the local Host, and its answer comes back out of stdout.
    relay.send(
        FrameBody::ScreenSnapshotRequest(ScreenSnapshotRequest {
            request_id: "relayed-snapshot".into(),
            expected_fence: fixture.fence(),
            profile: None,
        }),
        2,
    );
    let snapshot = loop {
        match relay.next_body() {
            FrameBody::ScreenSnapshot(snapshot) => break snapshot,
            FrameBody::OutputDelta(_) | FrameBody::AgentRuntimeState(_) => {}
            other => panic!("expected the requested snapshot, got {other:?}"),
        }
    };
    assert_eq!(
        snapshot.in_reply_to_request_id.as_deref(),
        Some("relayed-snapshot")
    );

    relay.send(
        FrameBody::Detach(Detach {
            reason: Some("test_complete".into()),
        }),
        3,
    );
    // Everything on stdout decoded as a frame, and the stream ended exactly on
    // a frame boundary: no banner, no `println!`, no partial write.
    loop {
        match relay.next() {
            Inbound::Frame(_) => {}
            Inbound::CleanEof => break,
            Inbound::NotAFrame(reason) => panic!("stdout was not frames-only: {reason}"),
        }
    }
}

#[test]
fn a_colocation_premised_frame_is_refused_without_ending_the_session() {
    let fixture = Fixture::start();
    let mut relay = fixture.gateway("observer");
    relay.send(
        hello(
            fixture.fence(),
            AttachMode::Observer,
            &["screen_snapshot", "live_output"],
        ),
        1,
    );
    assert!(matches!(relay.next_body(), FrameBody::HelloAck(_)));
    assert!(matches!(relay.next_body(), FrameBody::ScreenSnapshot(_)));

    relay.send(
        FrameBody::StandaloneTerminate(StandaloneTerminate {
            request_id: "relayed-kill".into(),
        }),
        2,
    );
    let error = loop {
        match relay.next_body() {
            FrameBody::Error(error) => break error,
            FrameBody::OutputDelta(_) | FrameBody::AgentRuntimeState(_) => {}
            other => panic!("expected a refusal, got {other:?}"),
        }
    };
    assert_eq!(error.code, ErrorCode::AuthorizationDenied);
    // The Host would also refuse this frame, and with the same code — so the
    // code alone would pass without the gateway's gate. The message is what
    // distinguishes "the gateway never forwarded it" from "the Host said no".
    assert!(
        error.message.contains("never relayed"),
        "the gateway, not the Host, must be the one refusing: {}",
        error.message
    );

    // The refusal must not be a teardown. The session is still attachable and
    // still answering, which is also how we know the terminate never reached
    // the Host.
    relay.send(
        FrameBody::ScreenSnapshotRequest(ScreenSnapshotRequest {
            request_id: "still-alive".into(),
            expected_fence: fixture.fence(),
            profile: None,
        }),
        3,
    );
    loop {
        match relay.next_body() {
            FrameBody::ScreenSnapshot(snapshot)
                if snapshot.in_reply_to_request_id.as_deref() == Some("still-alive") =>
            {
                break;
            }
            FrameBody::ScreenSnapshot(_)
            | FrameBody::OutputDelta(_)
            | FrameBody::AgentRuntimeState(_) => {}
            other => panic!("session did not survive the refusal: {other:?}"),
        }
    }
}

#[test]
fn a_relayed_hello_for_another_session_is_refused() {
    let fixture = Fixture::start();
    let mut relay = fixture.gateway("observer");
    let mut fence = fixture.fence();
    fence.session_id = "some-other-session".into();
    relay.send(hello(fence, AttachMode::Observer, &["screen_snapshot"]), 1);

    let error = expect_error(relay.next_body());
    assert_eq!(error.code, ErrorCode::IdentityMismatch);
    assert!(
        error.message.contains(&fixture.descriptor.session_id),
        "the refusal must name the session the forced command allows: {}",
        error.message
    );
    assert!(
        !error.message.contains("some-other-session"),
        "the peer's own string must not be echoed back: {}",
        error.message
    );
    assert!(matches!(relay.next(), Inbound::CleanEof));
    assert!(
        relay.stderr().contains("refused the relayed attach"),
        "the operator needs the refusal on stderr"
    );
}

#[test]
fn a_stale_relayed_fence_is_refused_against_the_hosts_answer() {
    let fixture = Fixture::start();
    let mut relay = fixture.gateway("observer");
    // Same session, same workspace — so the forced-command scope check passes.
    // Only the terminal epoch is stale, which is what a phone that slept
    // through a Host replacement would carry.
    let mut fence = fixture.fence();
    fence.terminal_epoch = "terminal_from_a_previous_host".into();
    relay.send(hello(fence, AttachMode::Observer, &["screen_snapshot"]), 1);
    let error = expect_error(relay.next_body());
    assert_eq!(error.code, ErrorCode::IdentityMismatch);
    assert!(matches!(relay.next(), Inbound::CleanEof));
}

#[test]
fn a_held_lease_is_relayed_as_contention_rather_than_as_a_dead_transport() {
    let fixture = Fixture::start();
    // The laptop is still attached and still holds the lease. This is the
    // ordinary "I forgot to detach before picking up my phone" case, and it is
    // the one contention state the Host produces on the attach path at all.
    let _laptop = fixture
        .session
        .connect(LocalAttachRole::Controller, None)
        .expect("the local controller attach must succeed");

    let mut relay = fixture.gateway("controller");
    relay.send(
        hello(
            fixture.fence(),
            AttachMode::Controller,
            &["screen_snapshot", "live_output", "terminal_input"],
        ),
        1,
    );

    let error = expect_error(relay.next_body());
    // Cause. `TransportClosed` sends the phone hunting a network fault that
    // does not exist, and hides the one fact that would let a human fix it in
    // two seconds: something else is holding the lease.
    assert_eq!(
        error.code,
        ErrorCode::ControllerConflict,
        "a held lease is contention, not a closed transport: {}",
        error.message
    );
    // Advice. The lease clears the moment the laptop releases, so `Never` is a
    // permanent instruction derived from a transient state — it disables a path
    // that would have worked on the next try.
    assert_eq!(
        error.retry,
        RetryPosture::Reconnect,
        "a contention refusal must say try again, not give up"
    );
    // And the Host's own words, not a substitute minted here. If the gateway
    // ever goes back to synthesizing its own message, the code and posture
    // could still be right by coincidence while the diagnosis is not.
    assert!(
        error.message.contains("controls this Hmux session"),
        "the Host's refusal must be propagated rather than replaced: {}",
        error.message
    );
    assert!(matches!(relay.next(), Inbound::CleanEof));
}

#[test]
fn a_refused_relayed_attach_leaves_the_controller_generation_untouched() {
    let fixture = Fixture::start();
    let before = fixture.controller_generation();

    let mut relay = fixture.gateway("controller");
    // Same session and same workspace, so the forced-command scope checks pass
    // and the refusal must come from the full fence comparison. Only the
    // terminal epoch is stale — what a phone that slept through a Host
    // replacement carries.
    let mut fence = fixture.fence();
    fence.terminal_epoch = "terminal_from_a_previous_host".into();
    // Controller on purpose. An Observer Hello would be refused just as
    // correctly and would move nothing either way, so an Observer probe here
    // would pass with or without the fix and prove nothing.
    relay.send(
        hello(
            fence,
            AttachMode::Controller,
            &["screen_snapshot", "live_output", "terminal_input"],
        ),
        1,
    );

    let error = expect_error(relay.next_body());
    assert_eq!(error.code, ErrorCode::IdentityMismatch);
    assert!(matches!(relay.next(), Inbound::CleanEof));
    // Wait for the process to be gone before measuring. A lease taken on the
    // way to refusing is released during teardown, so reading too early could
    // observe the grant and miss the release — or observe neither — and pass
    // for the wrong reason.
    let _ = relay.stderr();

    // The assertion that matters. Asserting only that the attach was refused
    // passes on the broken code too: the refusal was always correct, and what
    // was wrong was that reaching it cost the session two generation bumps
    // (`grant_control` in, `release_control` out). Generation movement is what
    // fences stale controller mutations, so a denied request moving it is a
    // denied request perturbing live arbitration state.
    assert_eq!(
        fixture.controller_generation(),
        before,
        "a denied relayed attach must not move the fence that arbitrates controller writes"
    );
}

#[test]
fn an_observer_forced_command_refuses_a_controller_hello() {
    let fixture = Fixture::start();
    let mut relay = fixture.gateway("observer");
    relay.send(
        hello(
            fixture.fence(),
            AttachMode::Controller,
            &["screen_snapshot", "live_output", "terminal_input"],
        ),
        1,
    );
    let error = expect_error(relay.next_body());
    assert_eq!(error.code, ErrorCode::AuthorizationDenied);
    assert!(matches!(relay.next(), Inbound::CleanEof));
}

#[test]
fn a_relayed_hello_requesting_shared_terminal_input_is_refused() {
    let fixture = Fixture::start();
    // Even the permissive ceiling refuses it: the ruling withholds this one
    // regardless of AttachMode, because the write it buys is unarbitrated.
    let mut relay = fixture.gateway("controller");
    relay.send(
        hello(
            fixture.fence(),
            AttachMode::Observer,
            &[
                "screen_snapshot",
                "live_output",
                "terminal_input",
                SHARED_TERMINAL_INPUT_CAPABILITY,
            ],
        ),
        1,
    );
    let error = expect_error(relay.next_body());
    assert_eq!(error.code, ErrorCode::UnsupportedCapability);
    assert_eq!(
        error.required_capability.as_deref(),
        Some(SHARED_TERMINAL_INPUT_CAPABILITY)
    );
    assert!(matches!(relay.next(), Inbound::CleanEof));
}

#[test]
fn a_relayed_controller_types_into_the_session() {
    let fixture = Fixture::start();
    let mut relay = fixture.gateway("controller");
    relay.send(
        hello(
            fixture.fence(),
            AttachMode::Controller,
            &[
                "screen_snapshot",
                "live_output",
                "terminal_input",
                "terminal_resize",
            ],
        ),
        1,
    );
    let ack = match relay.next_body() {
        FrameBody::HelloAck(ack) => ack,
        other => panic!("expected hello_ack, got {other:?}"),
    };
    assert!(
        ack.selected_capabilities
            .iter()
            .any(|c| c == "terminal_input")
    );
    // Controller authority is grant-premised and arbitrated by the fenced
    // lease, so it is relayed. The three unarbitrated privileges are not.
    for withheld in [
        SHARED_TERMINAL_INPUT_CAPABILITY,
        STANDALONE_TERMINATION_CAPABILITY,
        AGENT_STATE_REPORT_CAPABILITY,
    ] {
        assert!(!ack.selected_capabilities.iter().any(|c| c == withheld));
    }
    assert!(matches!(relay.next_body(), FrameBody::ScreenSnapshot(_)));

    relay.send(
        FrameBody::Input(Input {
            request_id: "relayed-typing".into(),
            controller_generation: ack.controller_generation,
            bytes: b"from-the-phone\n".to_vec(),
        }),
        2,
    );

    let mut echoed = Vec::new();
    let deadline = std::time::Instant::now() + FRAME_TIMEOUT;
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "the provider never echoed the relayed keystrokes: {}",
            String::from_utf8_lossy(&echoed)
        );
        match relay.next_body() {
            FrameBody::OutputDelta(delta) => {
                echoed.extend_from_slice(&delta.bytes);
                if String::from_utf8_lossy(&echoed).contains("relayed:from-the-phone") {
                    break;
                }
            }
            FrameBody::InputReceipt(receipt) => {
                assert_eq!(receipt.request_id, "relayed-typing");
            }
            FrameBody::ScreenSnapshot(_) | FrameBody::AgentRuntimeState(_) => {}
            other => panic!("unexpected frame while waiting for the echo: {other:?}"),
        }
    }
}

#[test]
fn an_undecodable_frame_is_answered_rather_than_ending_the_attach() {
    let fixture = Fixture::start();
    let mut relay = fixture.gateway("observer");
    handshake(&fixture, &mut relay);

    // A well-formed frame whose body kind this binary has no variant for: a
    // phone one release ahead of the gateway. Before the classification landed
    // this hit `Err(error) => break`, and the peer got a bare EOF — byte-for-byte
    // what `ssh` auth failing looks like.
    relay.send_framed_payload(
        br#"{"protocol_version":{"major":1,"minor":0},"frame_id":"2","body":{"kind":"a_frame_from_a_later_release","payload":{}}}"#,
    );

    let error = next_error(&relay);
    assert_eq!(error.code, ErrorCode::UnsupportedProtocolVersion);
    // The peer cannot act on "unsupported version" without being told which
    // version is supported, and the forced command leaves it no second channel
    // to ask on.
    assert_eq!(
        error.supported_versions,
        Some(VersionRange {
            minimum: PROTOCOL_V1,
            maximum: PROTOCOL_V1,
        }),
        "an UnsupportedProtocolVersion refusal must name the versions this gateway speaks"
    );

    // The payload was consumed in full, so the stream is still frame-aligned and
    // only the frame was refused.
    assert_session_still_answers(&mut relay, fixture.fence(), "alive-after-undecodable");
}

#[test]
fn an_oversized_paste_is_refused_and_correlated_without_ending_the_attach() {
    let fixture = Fixture::start();
    let mut relay = fixture.gateway("controller");
    relay.send(
        hello(
            fixture.fence(),
            AttachMode::Controller,
            &["screen_snapshot", "live_output", "terminal_input"],
        ),
        1,
    );
    let ack = match relay.next_body() {
        FrameBody::HelloAck(ack) => ack,
        other => panic!("expected hello_ack, got {other:?}"),
    };
    assert!(matches!(relay.next_body(), FrameBody::ScreenSnapshot(_)));

    // `FrameLimits::max_input_bytes` is 64 KiB. This is the primary user path
    // named in the review: a long paste from a phone. It parses as a WireFrame
    // and then fails validation, so the payload is fully consumed and the
    // stream stays aligned.
    //
    // Hand-rolled because `FrameCodec::encode` validates: the codec will not
    // produce the very frame under test, which is the point — only a peer that
    // does not share this binary's limits can send it.
    let pasted = base64::engine::general_purpose::STANDARD_NO_PAD.encode(vec![b'x'; 64 * 1024 + 1]);
    relay.send_framed_payload(
        format!(
            r#"{{"protocol_version":{{"major":1,"minor":0}},"frame_id":"2","body":{{"kind":"input","payload":{{"request_id":"the-long-paste","controller_generation":"{}","bytes":"{pasted}"}}}}}}"#,
            ack.controller_generation
        )
        .as_bytes(),
    );

    let error = next_error(&relay);
    assert_eq!(error.code, ErrorCode::ResourceLimit);
    // Without correlation the phone has an Input in its pending map with no
    // receipt and no matchable error, so the paste appears to hang rather than
    // to fail.
    assert_eq!(
        error.in_reply_to_request_id.as_deref(),
        Some("the-long-paste"),
        "the refusal must name the request it refused"
    );

    assert_session_still_answers(&mut relay, fixture.fence(), "alive-after-paste");
}

#[test]
fn a_desynchronizing_frame_is_answered_before_the_stream_closes() {
    let fixture = Fixture::start();
    let mut relay = fixture.gateway("observer");
    handshake(&fixture, &mut relay);

    // Declaring more than `max_frame_bytes` makes the codec refuse *before* it
    // reads the payload, so those bytes stay queued and the next read would take
    // payload for a length prefix. Unlike the paste above, this one really is
    // unrecoverable — the point is that it is still answered.
    relay.send_raw(&(2_u32 * 1024 * 1024).to_be_bytes());

    let error = next_error(&relay);
    assert_eq!(error.code, ErrorCode::ResourceLimit);
    assert!(
        error.message.contains("frame-aligned"),
        "the peer must be told the stream is unusable, not just that a frame was too big: {}",
        error.message
    );
    // The stream is broken; the session is not. Reconnect is the recovery, and
    // saying so is the difference between a reattach and a support ticket.
    assert_eq!(error.retry, RetryPosture::Reconnect);

    // And the close that follows is a close after an answer, not a bare EOF.
    loop {
        match relay.next() {
            Inbound::Frame(_) => {}
            Inbound::CleanEof => break,
            Inbound::NotAFrame(reason) => panic!("stdout was not frames-only: {reason}"),
        }
    }
}

#[test]
fn an_undecodable_hello_is_answered_rather_than_dropped() {
    let fixture = Fixture::start();
    let mut relay = fixture.gateway("observer");
    // Version skew is most likely to surface on the very first frame, which is
    // also where a silent close is least distinguishable from `ssh` failing.
    relay.send_framed_payload(
        br#"{"protocol_version":{"major":1,"minor":0},"frame_id":"1","body":{"kind":"hello_from_a_later_release","payload":{}}}"#,
    );

    let error = expect_error(relay.next_body());
    assert_eq!(error.code, ErrorCode::UnsupportedProtocolVersion);
    assert_eq!(
        error.supported_versions,
        Some(VersionRange {
            minimum: PROTOCOL_V1,
            maximum: PROTOCOL_V1,
        })
    );
    assert!(matches!(relay.next(), Inbound::CleanEof));
}

#[test]
fn a_host_to_client_frame_is_refused_rather_than_forwarded() {
    let fixture = Fixture::start();
    let mut relay = fixture.gateway("observer");
    handshake(&fixture, &mut relay);

    // `Exit` is a frame a Host answers with, never one a client sends. It is on
    // no deny-list, so under the previous `_ => Forward` default it crossed the
    // boundary into the local Host's inbox unremarked. Under an allow-list it is
    // refused because it was never enumerated as permitted.
    relay.send(
        FrameBody::Exit(Exit {
            final_output_seq: 0,
            exit_code: Some(0),
            platform_status: None,
            reason: "forged-by-the-relayed-client".into(),
        }),
        2,
    );

    let error = next_error(&relay);
    assert_eq!(error.code, ErrorCode::AuthorizationDenied);
    // The message is what distinguishes "the gateway refused it" from "the Host
    // happened to answer with an error"; the code alone would not.
    assert!(
        error.message.contains("answered by a Host"),
        "the gateway, not the Host, must be the one refusing: {}",
        error.message
    );

    assert_session_still_answers(&mut relay, fixture.fence(), "alive-after-forged-exit");
}

#[test]
fn list_names_the_session_without_leaking_the_capability_token() {
    let fixture = Fixture::start();
    let token = fixture.capability_token();
    let listing = fixture.list(Some(&fixture.descriptor.session_id));

    // Positive control first. Every assertion below is a negative one, and a
    // negative assertion over a broken search is indistinguishable from a
    // passing test — this is what keeps the containment claim from going vacuous
    // if `contains_bytes` or the listing ever stops producing bytes at all.
    assert!(
        contains_bytes(&listing, fixture.descriptor.session_id.as_bytes()),
        "the search must be able to find something that is genuinely present"
    );

    // Against the raw bytes, before any parsing, and as a byte search rather
    // than through a UTF-8 conversion: the stream interleaves binary length
    // prefixes with JSON, so converting first would make the conversion the
    // thing under test. A leak through an unexpected field would also survive a
    // parse-then-inspect check of only the fields we expect.
    assert!(
        !contains_bytes(&listing, token.as_bytes()),
        "the capability token must never cross the network"
    );
    assert!(
        !contains_bytes(&listing, b"capability_token"),
        "not even the field name should appear"
    );
    let rendered = String::from_utf8_lossy(&listing).into_owned();

    let documents = catalog_documents(&listing);
    assert_eq!(
        documents.len(),
        1,
        "expected exactly one session: {rendered}"
    );
    let session = &documents[0]["session"];
    assert_eq!(documents[0]["gateway_catalog_version"], 1);

    // Every fence component, because that is the reason `--list` exists: a
    // relayed client cannot mint an `expected_fence` the Host accepts without
    // all seven, and four of them change when the Host is replaced.
    assert_eq!(session["session_id"], fixture.descriptor.session_id);
    assert_eq!(session["workspace_id"], fixture.descriptor.workspace_id);
    assert_eq!(
        session["runner_principal"],
        fixture.descriptor.runner_principal
    );
    assert_eq!(
        session["runner_instance"],
        fixture.descriptor.runner_instance
    );
    assert_eq!(session["channel_epoch"], fixture.descriptor.channel_epoch);
    assert_eq!(
        session["host_instance_id"],
        fixture.descriptor.host_instance_id
    );
    assert_eq!(session["terminal_epoch"], fixture.descriptor.terminal_epoch);
    assert_eq!(session["session_name"], "gateway-smoke");

    // Allow-list, not deny-list: a pid or a socket path means nothing on the
    // phone's kernel, so neither is shipped.
    for withheld in ["host_process", "provider_process", "endpoint"] {
        assert!(
            session.get(withheld).is_none(),
            "{withheld} is meaningless off-box and must not be listed: {rendered}"
        );
    }
}

#[test]
fn list_emits_frames_not_text() {
    let fixture = Fixture::start();
    let listing = fixture.list(None);
    // The first four bytes are a length prefix, and the whole stream partitions
    // into documents with nothing left over. A stray `println!` or an rc-file
    // banner would break the partition, which is why this asserts over the
    // bytes rather than over parsed JSON.
    assert!(listing.len() > 4);
    let documents = catalog_documents(&listing);
    assert!(
        documents
            .iter()
            .any(|d| d["session"]["session_id"] == fixture.descriptor.session_id.as_str()),
        "the listing must name the live session"
    );
}

#[test]
fn stream_catalog_freezes_v3_and_names_the_gateway_only_in_v4() {
    let fixture = Fixture::start();
    let shipped = fixture.gateway_request(serde_json::json!({
        "gateway_request_version": 4,
        "request": "list_sessions"
    }));
    assert_eq!(shipped["gateway_catalog_version"], 3);
    assert!(shipped.get("gateway_build_id").is_none());
    assert_eq!(shipped["session"]["host_liveness"], "live");

    let current = fixture.gateway_request(serde_json::json!({
        "gateway_request_version": 6,
        "request": "list_sessions"
    }));
    assert_eq!(current["gateway_catalog_version"], 4);
    assert!(
        current["gateway_build_id"]
            .as_str()
            .is_some_and(|build_id| !build_id.is_empty())
    );
    assert_eq!(current["session"]["host_liveness"], "live");
}

/// The laptop half of the story: a local writer that makes the session produce
/// output on demand.
///
/// The relay attaches as an observer, so the bytes a reattach has to catch up on
/// cannot come from the phone. That is not a test convenience — it is the shape
/// of the real case, where the agent keeps working while the phone is away.
fn laptop(fixture: &Fixture) -> LocalConnection {
    fixture
        .session
        .connect(fixture.session.writable_attach_role(), None)
        .expect("a local writable attach must succeed")
}

/// Types `line` and returns only once `marker` has come back, so nothing here
/// measures a cursor against output the Host has not produced yet.
fn drive_output(connection: &mut LocalConnection, line: &str, marker: &str) {
    connection
        .writer()
        .send(FrameBody::Input(Input {
            request_id: format!("laptop-{line}"),
            controller_generation: connection.hello_ack().controller_generation,
            bytes: format!("{line}\n").into_bytes(),
        }))
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    let mut seen = Vec::new();
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "the provider never answered {marker:?}; saw {:?}",
            String::from_utf8_lossy(&seen)
        );
        match connection.read_body().unwrap() {
            FrameBody::OutputDelta(delta) => {
                seen.extend_from_slice(&delta.bytes);
                if contains_bytes(&seen, marker.as_bytes()) {
                    return;
                }
            }
            FrameBody::Exit(exit) => panic!("the provider exited early: {}", exit.reason),
            _ => {}
        }
    }
}

/// The claim this feature exists for: a phone that reconnects pays for the bytes
/// it missed, not for the screen it already has.
///
/// Two attaches that differ in exactly one thing — the second offers the cursor
/// the first left it with — measured on the wire rather than in the gateway.
///
/// The assertions are deliberately not structural. `AttachReplay::Resumed` lives
/// inside the gateway's own process and would be just as true if the gateway
/// then relayed a snapshot anyway; what a phone pays is what leaves stdout. So
/// the test asserts the absence of the `ScreenSnapshot` frame *on the wire*, the
/// absence of the pre-drop screen's bytes, and the byte total itself — with a
/// positive control on the cold attach, because "the reattach was cheap" is
/// vacuous if the attach it is compared against was cheap too.
///
/// Removing the passthrough (`with_reconnect_cursor(relayed_cursor)` in
/// `serve`) fails this twice over, in the order the assertions run: first at the
/// ack, whose `selected_capabilities` come back `["live_output",
/// "screen_snapshot"]` because a gateway that offers no cursor never negotiates
/// resume, and then — with that assertion removed — at the `ScreenSnapshot` arm,
/// where the screen the phone already held arrives all over again.
#[test]
fn a_relayed_reattach_with_a_cursor_costs_deltas_rather_than_a_screen() {
    let fixture = Fixture::start_with_provider(ANSWERING_PROVIDER);
    let mut laptop = laptop(&fixture);
    // Fill the screen before the phone ever attaches, so the cold attach is
    // genuinely expensive and the comparison below has something to mean.
    drive_output(&mut laptop, "flood", "flood-done");

    // --- The cold attach. A cursor is negotiated but none is offered, which is
    // exactly what a first attach looks like.
    let mut relay = fixture.gateway("observer");
    relay.send(resuming_hello(fixture.fence(), None), 1);
    let ack = match relay.next_body() {
        FrameBody::HelloAck(ack) => ack,
        other => panic!("expected hello_ack, got {other:?}"),
    };
    assert!(
        !ack.selected_capabilities
            .iter()
            .any(|c| c == RECONNECT_RESUME_CAPABILITY),
        "asking for resume without offering a position must not negotiate it: {:?}",
        ack.selected_capabilities
    );
    let snapshot = match relay.next_body() {
        FrameBody::ScreenSnapshot(snapshot) => snapshot,
        other => panic!("a cold attach must be seeded by the screen, got {other:?}"),
    };
    let cold_bytes = relay.consumed_bytes();
    // What a real client would carry away: the last position it was handed.
    let cursor = ReconnectCursor {
        terminal_epoch: fixture.fence().terminal_epoch,
        after_output_seq: snapshot.sequence_through,
    };
    // The phone's link dies. The forced command's process goes with it.
    drop(relay);

    // Work the phone missed.
    drive_output(&mut laptop, "while-away", "relayed:while-away");

    // --- The reattach, differing only in the cursor.
    let mut relay = fixture.gateway("observer");
    relay.send(resuming_hello(fixture.fence(), Some(cursor.clone())), 1);
    let ack = match relay.next_body() {
        FrameBody::HelloAck(ack) => ack,
        other => panic!("expected hello_ack, got {other:?}"),
    };
    // Honesty first: the peer is *told* the Host selected resume. Without this
    // it would be left inferring the reply shape from what did or did not
    // arrive, which is the same guess the snapshot-less handshake exists to
    // remove.
    assert!(
        ack.selected_capabilities
            .iter()
            .any(|c| c == RECONNECT_RESUME_CAPABILITY),
        "a resumed attach must say so in the ack: {:?}",
        ack.selected_capabilities
    );
    assert!(
        ack.current_output_seq > cursor.after_output_seq,
        "the away-time output must be genuinely ahead of the cursor, or there is nothing to resume"
    );

    let mut replayed = Vec::new();
    loop {
        match relay.next_body() {
            FrameBody::OutputDelta(delta) => {
                replayed.extend_from_slice(&delta.bytes);
                if contains_bytes(&replayed, b"relayed:while-away") {
                    break;
                }
            }
            // The failure this test exists to catch. A snapshot here is the
            // gateway redownloading a screen the phone already holds.
            FrameBody::ScreenSnapshot(_) => {
                panic!("the reattach redownloaded the screen instead of resuming")
            }
            // And this one is worse than a wasted download: a gap says output
            // is gone. This cursor is inside the retained window, so claiming
            // one would be false.
            FrameBody::ReplayGap(gap) => {
                panic!("the Host reported a gap it does not have: {gap:?}")
            }
            FrameBody::AgentRuntimeState(_) => {}
            other => panic!("unexpected frame while resuming: {other:?}"),
        }
    }
    let resumed_bytes = relay.consumed_bytes();

    // By bytes, not by structure. The screen the phone kept was never re-sent…
    assert!(
        !contains_bytes(&replayed, b"flood-done"),
        "resume re-sent output the phone already had"
    );
    // …and the positive control: the attach it is being compared against really
    // did cost a screen, so the comparison is not measuring two cheap attaches.
    assert!(
        cold_bytes > 200_000,
        "the cold attach cost only {cold_bytes} bytes; the comparison below would prove nothing"
    );
    assert!(
        resumed_bytes * 20 < cold_bytes,
        "a reattach cost {resumed_bytes} bytes against a cold attach's {cold_bytes}; \
         the cursor bought nothing"
    );
}

/// A cursor the Host cannot serve must be refused with advice the phone can act
/// on — and must not become a resume the gateway invented.
///
/// `u64::MAX` is the hostile shape: it claims output this Host never produced.
/// The Host answers such a cursor with a snapshot, so a gateway that clamped it
/// and reported a resume would desynchronize the peer on the first live delta —
/// a terminal gap the user reads as the agent having done something it did not.
/// The refusal is inherited rather than reimplemented: this gateway is a
/// first-class client, so the same `hmux-client` attach path a phone would run
/// locally is what says no.
///
/// The posture is half the assertion. `Reconnect` would send the phone round the
/// same loop with the same cursor forever.
#[test]
fn a_relayed_cursor_ahead_of_the_host_is_refused_with_advice_that_can_be_acted_on() {
    let fixture = Fixture::start_with_provider(ANSWERING_PROVIDER);
    let mut laptop = laptop(&fixture);
    drive_output(&mut laptop, "hello", "relayed:hello");

    let mut relay = fixture.gateway("observer");
    relay.send(
        resuming_hello(
            fixture.fence(),
            Some(ReconnectCursor {
                terminal_epoch: fixture.fence().terminal_epoch,
                after_output_seq: u64::MAX,
            }),
        ),
        1,
    );

    let error = expect_error(relay.next_body());
    assert_eq!(
        error.code,
        ErrorCode::ReplayGap,
        "a cursor the Host cannot serve is a stream-position refusal, not a dead transport: {}",
        error.message
    );
    assert_eq!(
        error.retry,
        RetryPosture::RetryAfterResync,
        "the phone has to be told to drop the cursor, not to try the same one again"
    );
    assert!(
        error.message.contains("reattach without one"),
        "the refusal must name the fix: {}",
        error.message
    );
    assert!(matches!(relay.next(), Inbound::CleanEof));

    // The session is untouched by the refusal: an honest attach still works.
    let mut relay = fixture.gateway("observer");
    relay.send(resuming_hello(fixture.fence(), None), 1);
    assert!(matches!(relay.next_body(), FrameBody::HelloAck(_)));
    assert!(matches!(relay.next_body(), FrameBody::ScreenSnapshot(_)));
}

/// When the cursor has fallen out of the Host's retained window, the relayed
/// peer must be told a gap happened — not handed a snapshot that looks like
/// continuous history.
///
/// This is the arm whose comment in `mobile_gateway.rs` argues hardest and,
/// until this test, the only one with nothing exercising it. The failure it
/// guards against is silent: a snapshot with no `ReplayGap` ahead of it is a
/// positive claim that nothing observable was lost. Relay that claim on a
/// stream where it is false and a phone paints a terminal whose missing middle
/// reads as the agent having done something it did not do.
///
/// So the assertion is on the ORDER and PRESENCE of the gap frame, not on the
/// attach succeeding — the attach succeeded before this fix too.
#[test]
fn a_relayed_cursor_the_host_retired_is_answered_with_the_gap_before_the_screen() {
    let fixture = Fixture::start_with_provider(ANSWERING_PROVIDER);
    let mut laptop = laptop(&fixture);

    // A position the Host still holds.
    drive_output(&mut laptop, "flood", "flood-done");
    let cursor = laptop.reconnect_cursor();

    // Push that position out of the retained delta budget. Each flood is
    // 256 KiB; the budget is measured in MiB, so this is deliberately many.
    for _ in 0..24 {
        drive_output(&mut laptop, "flood", "flood-done");
    }
    drop(laptop);

    let mut relay = fixture.gateway("observer");
    relay.send(resuming_hello(fixture.fence(), Some(cursor)), 1);
    match relay.next_body() {
        FrameBody::HelloAck(_) => {}
        other => panic!("expected hello_ack, got {other:?}"),
    }

    // The gap must arrive FIRST. A peer that reads the snapshot before knowing
    // a gap occurred has already rendered the lie.
    match relay.next_body() {
        FrameBody::ReplayGap(_) => {}
        FrameBody::ScreenSnapshot(_) => {
            panic!("the screen arrived without the gap that says history is missing")
        }
        other => panic!("expected a replay gap, got {other:?}"),
    }
    match relay.next_body() {
        FrameBody::ScreenSnapshot(_) => {}
        other => panic!("expected the screen after the gap, got {other:?}"),
    }
}
