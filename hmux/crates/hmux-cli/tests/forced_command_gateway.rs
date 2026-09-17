//! Drives `hmux mobile-gateway` the way sshd actually drives it: as a **forced
//! command**, under a real `sshd`, reached by a real `ssh` client.
//!
//! # Why a real sshd, when `tests/mobile_gateway.rs` already spawns the binary
//!
//! Because the bug this file exists for is invisible over a pipe pair. A forced
//! command *replaces* the client's argv; the client's own request is moved to
//! `SSH_ORIGINAL_COMMAND` and the pinned line runs verbatim. Every test that
//! builds its own `Command` chooses the arguments, so every one of them was
//! green while the shipped configuration was dead: a phone that had paired
//! successfully with two real servers got
//!
//! ```text
//! error: the following required arguments were not provided: --session <SESSION>
//! ```
//!
//! on every connection, exit status 2, for listing and attaching alike, because
//! `MobileGatewayArgs::session` was `required_unless_present = "list"` and the
//! phone could append neither flag. A unit test over a pipe did not catch that
//! and would not catch its successor, so the properties here are asserted
//! through `authorized_keys`.
//!
//! # The lab
//!
//! No root, no Remote Login, nothing outside this test's temp directory: an
//! `sshd` of our own on a loopback ephemeral port, with generated host and
//! client keys and an `AuthorizedKeysFile` we write. The server process is owned
//! by the `Child` handle that started it and is killed by that handle alone —
//! other agents run their own daemons on this machine, and a pattern kill would
//! take theirs down too.
//!
//! # Reading `$HOME/.local/bin/hmux` without touching the real one
//!
//! [`the_default_pairing_forced_command_serves_a_real_ssh_client`] runs the
//! literal line `hmux pair` installs, `$HOME` expansion included. `$HOME` is
//! redirected to a temp directory through an `environment=` option so the
//! expansion lands on the binary *this build produced*. Without that redirection
//! the test would silently exercise whatever `hmux` the developer has installed
//! — which is how a reviewer's lab got `unrecognized subcommand` and spent an
//! afternoon on a different failure. The `command="…"` value itself is never
//! rewritten, and the test asserts that.
#![cfg(unix)]

use base64::Engine as _;
use hmux_client::{
    LocalSession, LocalSessionCatalog, SessionDescriptor, SessionSelector, StandaloneCreateRequest,
    StandaloneSessionCreator,
};
use hmux_host::local_protocol::{
    AttachMode, ErrorCode, ErrorFrame, FrameBody, FrameCodec, FrameLimits, Hello, PROTOCOL_V1,
    SessionFence, VersionRange, WireFrame,
};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Read, Write as _};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

/// Generous because every one of these crosses a real SSH handshake and starts a
/// real Host. A wrong answer arrives fast; only a hang uses the whole budget.
const FRAME_TIMEOUT: Duration = Duration::from_secs(30);
const SSHD_START_TIMEOUT: Duration = Duration::from_secs(15);
const SSHD_START_ATTEMPTS: usize = 8;
const MAX_SSH_DIAGNOSTIC_BYTES: usize = 16 * 1024;

/// Port selection and `sshd` bind are not one kernel operation. Keep that
/// unbound interval single-file within this test process; bounded retries below
/// handle another process winning the same interval.
static SSHD_START_LOCK: Mutex<()> = Mutex::new(());

fn hmux() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_hmux"))
}

/// The runtime binary lands beside this package's binary in the same profile
/// directory. Failing loudly beats skipping: a silently skipped relay test is
/// indistinguishable from a passing one.
fn runtime_executable() -> PathBuf {
    let runtime = hmux().with_file_name(format!("hmux-runtime{}", std::env::consts::EXE_SUFFIX));
    assert!(
        runtime.is_file(),
        "hmux-runtime is missing at {}; run the workspace gate (`cargo test --workspace`)",
        runtime.display()
    );
    runtime
}

/// The `sshd` this lab starts.
///
/// Located rather than hardcoded because the two machines this repository's
/// `cargo test` runs on put it in different places. Absent means the test fails
/// loudly with the fix in the message — a skipped forced-command test reads
/// exactly like a passing one, and that is the failure mode this whole file
/// exists to remove.
fn sshd_executable() -> PathBuf {
    const CANDIDATES: &[&str] = &[
        "/usr/sbin/sshd",
        "/usr/local/sbin/sshd",
        "/opt/homebrew/sbin/sshd",
        "/usr/lib/ssh/sshd",
    ];
    for candidate in CANDIDATES {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return path;
        }
    }
    panic!(
        "no sshd found in {CANDIDATES:?}; this test asserts about forced commands and cannot be \
         run without one (Debian/Ubuntu: `apt-get install -y openssh-server`)"
    );
}

/// Sessions on the box the gateway serves, in one discovery root.
struct Sessions {
    _state: tempfile::TempDir,
    discovery_root: PathBuf,
    catalog: LocalSessionCatalog,
    sessions: Vec<LocalSession>,
    descriptors: Vec<SessionDescriptor>,
}

impl Sessions {
    /// One session per name, all in the same discovery root — which is what
    /// makes "every session this account owns" a set with more than one element,
    /// and therefore what makes the unpinned-reach assertion mean anything.
    fn start(names: &[&str]) -> Self {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let mut sessions = Vec::new();
        let mut descriptors = Vec::new();
        let catalog = LocalSessionCatalog::new(&discovery_root);
        for name in names {
            let creator = StandaloneSessionCreator::new(runtime_executable())
                .with_discovery_root(&discovery_root);
            let request = StandaloneCreateRequest::new(
                std::env::current_dir().unwrap().canonicalize().unwrap(),
                Some((*name).to_string()),
                vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "IFS= read -r line; printf 'relayed:%s\\n' \"$line\"; sleep 60".into(),
                ],
                24,
                80,
            )
            .unwrap();
            let session = creator.create(request).unwrap().session().clone();
            let descriptor = catalog
                .find(&SessionSelector::new(
                    session.descriptor().session_id.clone(),
                    Some(session.descriptor().workspace_id.clone()),
                ))
                .unwrap();
            sessions.push(session);
            descriptors.push(descriptor);
        }
        Self {
            _state: state,
            discovery_root,
            catalog,
            sessions,
            descriptors,
        }
    }

    fn fence(&self, index: usize) -> SessionFence {
        let descriptor = &self.descriptors[index];
        SessionFence {
            workspace_id: descriptor.workspace_id.clone(),
            session_id: descriptor.session_id.clone(),
            runner_principal: descriptor.runner_principal.clone(),
            runner_instance: descriptor.runner_instance.clone(),
            channel_epoch: descriptor.channel_epoch.parse().unwrap(),
            host_instance_id: descriptor.host_instance_id.clone(),
            terminal_epoch: descriptor.terminal_epoch.clone(),
        }
    }

    /// The Host's real `capability_token`, read straight off the manifest.
    ///
    /// A hardcoded literal would prove nothing: the containment assertion has to
    /// run against the value these Hosts actually minted.
    fn capability_tokens(&self) -> Vec<String> {
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
        fn walk(directory: &Path, found: &mut Vec<String>) {
            let Ok(entries) = std::fs::read_dir(directory) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, found);
                } else if path.file_name().is_some_and(|name| name == "manifest.json") {
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(token) = token_in(&json) {
                                found.push(token);
                            }
                        }
                    }
                }
            }
        }
        let mut found = Vec::new();
        walk(&self.discovery_root, &mut found);
        assert_eq!(
            found.len(),
            self.descriptors.len(),
            "every Host must have published a token, or the containment assertion is vacuous"
        );
        assert!(found.iter().all(|token| !token.is_empty()));
        found
    }
}

impl Drop for Sessions {
    fn drop(&mut self) {
        for session in &self.sessions {
            let _ = session.terminate_standalone(&self.catalog, Duration::from_secs(2));
        }
    }
}

/// A private `sshd` on loopback, and the client key that reaches it.
struct SshdLab {
    directory: tempfile::TempDir,
    port: u16,
    /// The only handle anything in this file may use to stop the server. Other
    /// agents run their own daemons on this machine; a pattern kill would take
    /// theirs down with ours.
    server: Child,
}

impl SshdLab {
    fn start() -> Self {
        Self::start_with_first_port(None)
    }

    fn start_with_first_port(first_port: Option<u16>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        // sshd refuses a world-readable key directory even with StrictModes off
        // for some files, and this is cheap insurance either way.
        std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        keygen(&path.join("host_key"), "lab-host");
        keygen(&path.join("client_key"), "lab-client");
        std::fs::write(path.join("authorized_keys"), "").unwrap();
        std::fs::set_permissions(
            path.join("authorized_keys"),
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .unwrap();

        std::fs::write(
            path.join("sshd_config"),
            format!(
                "ListenAddress 127.0.0.1\n\
                 HostKey {host_key}\n\
                 AuthorizedKeysFile {authorized_keys}\n\
                 PasswordAuthentication no\n\
                 KbdInteractiveAuthentication no\n\
                 UsePAM no\n\
                 PubkeyAuthentication yes\n\
                 StrictModes no\n\
                 PrintMotd no\n\
                 PermitUserEnvironment yes\n\
                 LogLevel VERBOSE\n",
                host_key = path.join("host_key").display(),
                authorized_keys = path.join("authorized_keys").display(),
            ),
        )
        .unwrap();

        let _start_guard = SSHD_START_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let deadline = Instant::now() + SSHD_START_TIMEOUT;
        let mut failures = Vec::new();
        for attempt in 1..=SSHD_START_ATTEMPTS {
            let port = if attempt == 1 {
                first_port.unwrap_or_else(free_loopback_port)
            } else {
                free_loopback_port()
            };
            let pid_file = path.join(format!("sshd-{attempt}.pid"));
            // `-D` keeps the listener in the foreground, which is the whole
            // reason the `Child` handle is a usable owner: a daemonizing sshd
            // would leave a process this test could only find by pattern.
            let mut server = match Command::new(sshd_executable())
                .arg("-D")
                .arg("-f")
                .arg(path.join("sshd_config"))
                .arg("-p")
                .arg(port.to_string())
                .arg("-o")
                .arg(format!("PidFile={}", pid_file.display()))
                .arg("-E")
                .arg(path.join("sshd.log"))
                .spawn()
            {
                Ok(server) => server,
                Err(error) => {
                    failures.push(format!(
                        "attempt {attempt} port {port}: spawn failed: {error}"
                    ));
                    if Instant::now() >= deadline {
                        break;
                    }
                    continue;
                }
            };

            match Self::await_exact_listener(&mut server, port, &pid_file, deadline) {
                Ok(()) => {
                    return Self {
                        directory,
                        port,
                        server,
                    };
                }
                Err(error) => {
                    let _ = server.kill();
                    let _ = server.wait();
                    failures.push(format!("attempt {attempt} port {port}: {error}"));
                    if Instant::now() >= deadline {
                        break;
                    }
                }
            }
        }
        panic!(
            "could not start an exact owned sshd listener: {}; log: {}",
            failures.join(" | "),
            std::fs::read_to_string(path.join("sshd.log")).unwrap_or_default()
        );
    }

    fn await_exact_listener(
        server: &mut Child,
        port: u16,
        pid_file: &Path,
        deadline: Instant,
    ) -> Result<(), String> {
        let expected_pid = server.id();
        while Instant::now() < deadline {
            match server.try_wait() {
                Ok(Some(status)) => return Err(format!("child exited before bind ({status})")),
                Ok(None) => {}
                Err(error) => return Err(format!("could not inspect child: {error}")),
            }
            let published_pid = std::fs::read_to_string(pid_file)
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok());
            if published_pid == Some(expected_pid)
                && TcpStream::connect(("127.0.0.1", port)).is_ok()
            {
                return match server.try_wait() {
                    Ok(None) => Ok(()),
                    Ok(Some(status)) => {
                        Err(format!("child exited after publishing pid ({status})"))
                    }
                    Err(error) => Err(format!("could not recheck child: {error}")),
                };
            }
            thread::sleep(Duration::from_millis(50));
        }
        Err(format!(
            "deadline elapsed; expected pid {expected_pid}, published pid {:?}",
            std::fs::read_to_string(pid_file)
                .ok()
                .and_then(|value| value.trim().parse::<u32>().ok())
        ))
    }

    fn path(&self, name: &str) -> PathBuf {
        self.directory.path().join(name)
    }

    fn public_key(&self) -> String {
        std::fs::read_to_string(self.path("client_key.pub"))
            .unwrap()
            .trim()
            .to_string()
    }

    /// Writes one `authorized_keys` line: the caller's option field, then this
    /// lab's public key.
    fn authorize_options(&self, options: &str) {
        self.authorize_line(&format!("{options} {}", self.public_key()));
    }

    fn authorize_line(&self, line: &str) {
        assert!(!line.contains('\n'), "an entry is one line: {line}");
        std::fs::write(self.path("authorized_keys"), format!("{line}\n")).unwrap();
    }

    /// Opens one exec channel to the forced command and speaks frames on it.
    ///
    /// The command string is deliberately something the gateway would refuse if
    /// it ever reached argv. sshd discards it — that is what a forced command
    /// does — and if a future change started honouring `SSH_ORIGINAL_COMMAND`
    /// this argument is what would make the difference visible instead of silent.
    fn relay(&self) -> SshRelay {
        self.relay_requesting("this-string-is-discarded-by-the-forced-command")
    }

    /// Opens a channel asking sshd to run `command`.
    ///
    /// Needed for the *unfenced* case: with no forced command in the entry,
    /// sshd runs what the client asked for, so the client has to ask for the
    /// gateway. `relay()` keeps sending a string that would fail if it ever
    /// reached argv, which is what makes a regression there visible.
    fn relay_requesting(&self, command: &str) -> SshRelay {
        let mut child = Command::new("ssh")
            .args(["-F", "/dev/null"])
            .arg("-p")
            .arg(self.port.to_string())
            .arg("-i")
            .arg(self.path("client_key"))
            .args([
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "UserKnownHostsFile=/dev/null",
                "-o",
                "LogLevel=ERROR",
                "-o",
                "BatchMode=yes",
            ])
            .arg(format!("{}@127.0.0.1", current_username()))
            .arg(command)
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
            loop {
                let message = match read_length_prefix(&mut stdout) {
                    PrefixOutcome::Eof => Inbound::CleanEof,
                    PrefixOutcome::Partial(observed) => Inbound::NotADocument(format!(
                        "stdout ended mid-length-prefix after {observed} bytes"
                    )),
                    PrefixOutcome::Length(length) => {
                        let mut payload = vec![0_u8; length];
                        match stdout.read_exact(&mut payload) {
                            Ok(()) => Inbound::Document(payload),
                            Err(error) => {
                                Inbound::NotADocument(format!("stdout ended mid-payload: {error}"))
                            }
                        }
                    }
                };
                let terminal = !matches!(message, Inbound::Document(_));
                if sender.send(message).is_err() || terminal {
                    break;
                }
            }
        });
        let stderr = thread::spawn(move || read_bounded_diagnostic(&mut stderr));
        SshRelay {
            child,
            stdin: Some(stdin),
            inbound,
            stderr: Some(stderr),
        }
    }
}

impl Drop for SshdLab {
    fn drop(&mut self) {
        let _ = self.server.kill();
        let _ = self.server.wait();
    }
}

fn current_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .expect("the lab authenticates as the account running the test")
}

fn keygen(path: &Path, comment: &str) {
    let status = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f"])
        .arg(path)
        .status()
        .unwrap();
    assert!(status.success(), "ssh-keygen failed for {}", path.display());
}

/// A port nothing is listening on right now.
///
/// Inherently a small race — the listener is closed before sshd binds — and the
/// alternative (a fixed port) is a guaranteed collision with the other agents
/// working on this machine.
fn free_loopback_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[derive(Debug)]
enum Inbound {
    /// One length-prefixed document. Deliberately *not* decoded here: an attach
    /// answers with `WireFrame`s and a listing answers with catalog documents,
    /// and both are read by the same loop because they share the framing.
    Document(Vec<u8>),
    /// The stream ended exactly on a document boundary.
    CleanEof,
    NotADocument(String),
}

struct SshRelay {
    child: Child,
    stdin: Option<ChildStdin>,
    inbound: mpsc::Receiver<Inbound>,
    stderr: Option<thread::JoinHandle<String>>,
}

impl SshRelay {
    fn send_frame(&mut self, body: FrameBody) {
        let encoded = FrameCodec::new(FrameLimits::default())
            .encode(&WireFrame {
                protocol_version: PROTOCOL_V1,
                frame_id: 1,
                body,
            })
            .unwrap();
        self.send_raw(&encoded);
    }

    /// Frames a hand-written JSON document, which is the only way to send
    /// something the codec would refuse to build — a gateway request is not a
    /// `WireFrame`, and a bad version is not a document any writer would emit.
    fn send_document(&mut self, payload: &[u8]) {
        let mut encoded = u32::try_from(payload.len()).unwrap().to_be_bytes().to_vec();
        encoded.extend_from_slice(payload);
        self.send_raw(&encoded);
    }

    fn send_raw(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(bytes).unwrap();
        stdin.flush().unwrap();
    }

    fn next(&self) -> Inbound {
        self.inbound
            .recv_timeout(FRAME_TIMEOUT)
            .expect("the forced command produced nothing before the deadline")
    }

    fn next_frame(&self) -> FrameBody {
        match self.next() {
            Inbound::Document(payload) => {
                let mut encoded = u32::try_from(payload.len()).unwrap().to_be_bytes().to_vec();
                encoded.extend_from_slice(&payload);
                FrameCodec::new(FrameLimits::default())
                    .decode(&encoded)
                    .expect("an attach answers with frames")
                    .body
            }
            other => panic!("expected a frame, got {other:?}"),
        }
    }

    fn next_error(&self) -> ErrorFrame {
        match self.next_frame() {
            FrameBody::Error(error) => error,
            other => panic!("expected an error frame, got {:?}", other.kind()),
        }
    }

    /// Every document up to a clean end of stream, plus the raw bytes.
    ///
    /// The raw bytes matter: the containment assertions below run over what
    /// actually left the process, not over a re-serialization of something
    /// already parsed.
    fn drain_documents(&self) -> (Vec<serde_json::Value>, Vec<u8>) {
        let mut documents = Vec::new();
        let mut raw = Vec::new();
        loop {
            match self.next() {
                Inbound::Document(payload) => {
                    raw.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_be_bytes());
                    raw.extend_from_slice(&payload);
                    documents.push(serde_json::from_slice(&payload).unwrap_or_else(|error| {
                        panic!(
                            "a listing document must be JSON ({error}): {}",
                            String::from_utf8_lossy(&payload)
                        )
                    }));
                }
                Inbound::CleanEof => return (documents, raw),
                Inbound::NotADocument(detail) => panic!("the listing stream broke: {detail}"),
            }
        }
    }

    fn close_stdin(&mut self) {
        self.stdin.take();
    }

    fn diagnostics(&mut self) -> String {
        self.close_stdin();
        let status = self.child.wait();
        let stderr = self.stderr.take().map(|h| h.join().unwrap()).unwrap();
        format!("ssh status {status:?}; stderr: {stderr}")
    }
}

impl Drop for SshRelay {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

enum PrefixOutcome {
    Eof,
    Partial(usize),
    Length(usize),
}

fn read_length_prefix(reader: &mut impl Read) -> PrefixOutcome {
    let mut prefix = [0_u8; 4];
    let mut filled = 0;
    while filled < prefix.len() {
        match reader.read(&mut prefix[filled..]) {
            Ok(0) if filled == 0 => return PrefixOutcome::Eof,
            Ok(0) => return PrefixOutcome::Partial(filled),
            Ok(read) => filled += read,
            Err(_) if filled == 0 => return PrefixOutcome::Eof,
            Err(_) => return PrefixOutcome::Partial(filled),
        }
    }
    PrefixOutcome::Length(u32::from_be_bytes(prefix) as usize)
}

fn read_bounded_diagnostic(reader: &mut impl Read) -> String {
    let mut captured = Vec::with_capacity(MAX_SSH_DIAGNOSTIC_BYTES);
    let mut buffer = [0_u8; 1024];
    let mut truncated = false;
    while let Ok(read) = reader.read(&mut buffer) {
        if read == 0 {
            break;
        }
        let remaining = MAX_SSH_DIAGNOSTIC_BYTES.saturating_sub(captured.len());
        captured.extend_from_slice(&buffer[..read.min(remaining)]);
        truncated |= read > remaining;
    }
    let mut diagnostic = String::from_utf8_lossy(&captured).into_owned();
    if truncated {
        diagnostic.push_str("\n[diagnostic truncated]");
    }
    diagnostic
}

fn hello(fence: SessionFence, mode: AttachMode) -> FrameBody {
    FrameBody::Hello(Hello {
        supported_versions: VersionRange {
            minimum: PROTOCOL_V1,
            maximum: PROTOCOL_V1,
        },
        requested_capabilities: vec!["screen_snapshot".into(), "live_output".into()],
        expected_fence: fence,
        requested_mode: mode,
        reconnect_cursor: None,
        capability_token: "relayed-placeholder".into(),
        authorization_proof_reference: None,
        initial_snapshot_profile: None,
    })
}

/// The listing request, written as bytes rather than through a shared encoder.
///
/// Hand-written on purpose: a client that borrows the server's own serializer
/// agrees with a wrong one. This is the document a phone has to be able to
/// produce from the wire description alone.
const LIST_REQUEST: &[u8] = br#"{"gateway_request_version":1,"request":"list_sessions"}"#;

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// The option field of a forced command that pins nothing but the discovery
/// root — the shape `hmux pair` installs, with the root redirected so the test
/// serves its own sessions rather than the developer's.
fn unpinned_options(sessions: &Sessions, extra: &str) -> String {
    format!(
        "command=\"{hmux} --discovery-root {root} mobile-gateway{extra}\",restrict",
        hmux = hmux().display(),
        root = sessions.discovery_root.display(),
    )
}

/// The same invocation `unpinned_options` pins, but as a bare command for the
/// client to request. Built from the one helper so the fenced and unfenced cases
/// cannot drift into testing different gateways.
fn unfenced_gateway_command(sessions: &Sessions) -> String {
    format!(
        "{hmux} --discovery-root {root} mobile-gateway",
        hmux = hmux().display(),
        root = sessions.discovery_root.display(),
    )
}

fn pinned_options(sessions: &Sessions, session_id: &str) -> String {
    format!(
        "command=\"{hmux} --discovery-root {root} mobile-gateway --session {session_id} --role observer\",restrict",
        hmux = hmux().display(),
        root = sessions.discovery_root.display(),
    )
}

#[test]
fn a_pinned_forced_command_still_refuses_a_hello_for_another_session() {
    // The regression the widening creates. `--session` became optional, and the
    // one thing that must not have changed is what it means when it *is*
    // present: an operator who pins one session has to keep getting exactly one
    // session, enforced against the fence the peer supplied rather than against
    // the argv the peer could not choose.
    let sessions = Sessions::start(&["alpha", "beta"]);
    let lab = SshdLab::start();
    lab.authorize_options(&pinned_options(
        &sessions,
        &sessions.descriptors[0].session_id,
    ));

    let mut refused = lab.relay();
    refused.send_frame(hello(sessions.fence(1), AttachMode::Observer));
    let error = refused.next_error();
    assert_eq!(error.code, ErrorCode::IdentityMismatch);
    assert!(
        error.message.contains(&sessions.descriptors[0].session_id),
        "the refusal must name the session this key may reach: {}",
        error.message
    );
    assert!(
        !error.message.contains(&sessions.descriptors[1].session_id),
        "the peer's own string must not be reflected back: {}",
        error.message
    );

    // The companion half, in the same test so a refusal that came from a broken
    // lab cannot pass as a security property: the pinned session itself is
    // served over the identical forced command.
    let mut admitted = lab.relay();
    admitted.send_frame(hello(sessions.fence(0), AttachMode::Observer));
    let FrameBody::HelloAck(ack) = admitted.next_frame() else {
        panic!("the pinned session must be served by its own pinned key");
    };
    assert_eq!(
        ack.actual_fence.session_id,
        sessions.descriptors[0].session_id
    );
}

#[test]
fn an_unpinned_forced_command_reaches_every_session_the_account_owns() {
    // The widening, stated as a test rather than left to a comment. One key, no
    // `--session`, and both sessions answer — including one the key was never
    // told about. This is what the project owner approved; a change that
    // narrows it back has to fail here and read why.
    let sessions = Sessions::start(&["alpha", "beta"]);
    let lab = SshdLab::start();
    lab.authorize_options(&unpinned_options(&sessions, " --role observer"));

    for index in 0..2 {
        let mut relay = lab.relay();
        relay.send_frame(hello(sessions.fence(index), AttachMode::Observer));
        let FrameBody::HelloAck(ack) = relay.next_frame() else {
            panic!(
                "session {} must be reachable through an unpinned key",
                sessions.descriptors[index].session_id
            );
        };
        assert_eq!(
            ack.actual_fence.session_id,
            sessions.descriptors[index].session_id
        );
        assert_eq!(
            ack.actual_fence.workspace_id,
            sessions.descriptors[index].workspace_id
        );
    }
}

#[test]
fn a_stale_fence_is_still_refused_when_no_session_is_pinned() {
    // Losing the argv pin must not lose the fence check. The session id and
    // workspace now come from the peer, so those two comparisons are
    // tautological — the other five are what stop a phone resuming onto a
    // replaced Host, and they are read off this box's manifest.
    let sessions = Sessions::start(&["alpha"]);
    let lab = SshdLab::start();
    lab.authorize_options(&unpinned_options(&sessions, " --role observer"));

    let mut relay = lab.relay();
    let mut stale = sessions.fence(0);
    stale.terminal_epoch = format!("{}-stale", stale.terminal_epoch);
    relay.send_frame(hello(stale, AttachMode::Observer));
    let error = relay.next_error();
    assert_eq!(error.code, ErrorCode::IdentityMismatch);
    assert!(
        error.message.contains("different session"),
        "the refusal must say the fence disagreed: {}",
        error.message
    );
}

#[test]
fn a_hello_for_a_session_this_box_does_not_have_is_answered_not_dropped() {
    // The ordinary failure of an unpinned key: the phone attaches from a
    // catalog it fetched before the Host was replaced. A silent close here is
    // byte-identical to `ssh` itself failing, and the advice matters — retrying
    // the same dead id forever is the wrong loop.
    let sessions = Sessions::start(&["alpha"]);
    let lab = SshdLab::start();
    lab.authorize_options(&unpinned_options(&sessions, " --role observer"));

    let mut relay = lab.relay();
    let mut gone = sessions.fence(0);
    gone.session_id = "standalone_this_session_never_existed".into();
    relay.send_frame(hello(gone, AttachMode::Observer));
    let error = relay.next_error();
    assert_eq!(error.code, ErrorCode::StaleDiscovery);
    assert_eq!(
        error.retry,
        hmux_host::local_protocol::RetryPosture::RetryAfterResync,
        "reconnecting with the same dead id changes nothing; listing again does"
    );
    assert!(
        !error.message.contains("never_existed"),
        "a refusal is not an echo chamber: {}",
        error.message
    );
}

#[test]
fn a_listing_is_reachable_through_a_forced_command_that_cannot_be_appended_to() {
    // The half of the fix that argv cannot deliver. This key's forced command
    // contains no `--list` and the client cannot add one, so before the stream
    // route existed there was no way for a phone to learn the four fence
    // components that move when a Host is replaced.
    let sessions = Sessions::start(&["alpha", "beta"]);
    let tokens = sessions.capability_tokens();
    let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
    let occupied_port = occupied.local_addr().unwrap().port();
    // Reproduce the kernel race that caused CI attempt 30612997212/1: the port
    // was free when selected, then another listener won before sshd bound it.
    // The lab must reject that foreign listener and retry an exact owned child.
    let lab = SshdLab::start_with_first_port(Some(occupied_port));
    drop(occupied);
    lab.authorize_options(&unpinned_options(&sessions, ""));

    let mut relay = lab.relay();
    relay.send_document(LIST_REQUEST);
    let (documents, raw) = relay.drain_documents();
    let diagnostics = relay.diagnostics();
    let observed_session_ids = documents
        .iter()
        .filter_map(|document| document["session"]["session_id"].as_str())
        .collect::<Vec<_>>();

    // Positive control before the negative assertions: a containment claim over
    // a search that finds nothing is indistinguishable from a passing test.
    assert!(
        contains_bytes(&raw, sessions.descriptors[0].session_id.as_bytes()),
        "the search must find {}; observed {observed_session_ids:?}, raw bytes {}, {diagnostics}",
        sessions.descriptors[0].session_id,
        raw.len()
    );
    // The containment rules do not change with the route. Same bytes, same
    // allow-list, same reasons: the token never crosses the network, and a pid
    // or socket path means nothing on the phone's kernel.
    for token in &tokens {
        assert!(
            !contains_bytes(&raw, token.as_bytes()),
            "the capability token must never cross the network"
        );
    }
    assert!(!contains_bytes(&raw, b"capability_token"));

    assert_eq!(documents.len(), 2, "both sessions must be listed: {raw:?}");
    let mut listed: Vec<&str> = documents
        .iter()
        .map(|document| {
            assert_eq!(document["gateway_catalog_version"], 1);
            let session = &document["session"];
            for withheld in ["host_process", "provider_process", "endpoint"] {
                assert!(
                    session.get(withheld).is_none(),
                    "{withheld} is meaningless off-box and must not be listed"
                );
            }
            // Every fence component, because that is the reason a listing
            // exists at all.
            for required in [
                "session_id",
                "workspace_id",
                "runner_principal",
                "runner_instance",
                "channel_epoch",
                "host_instance_id",
                "terminal_epoch",
            ] {
                assert!(
                    session.get(required).is_some(),
                    "{required} is a fence component the client cannot guess"
                );
            }
            session["session_id"].as_str().unwrap()
        })
        .collect();
    listed.sort_unstable();
    let mut expected: Vec<&str> = sessions
        .descriptors
        .iter()
        .map(|descriptor| descriptor.session_id.as_str())
        .collect();
    expected.sort_unstable();
    assert_eq!(listed, expected);
}

#[test]
fn a_pinned_forced_command_narrows_a_stream_listing_exactly_as_it_narrows_the_flag() {
    // The scope has to travel with the route, or the stream listing becomes the
    // widening hole in a line the operator wrote to narrow access.
    let sessions = Sessions::start(&["alpha", "beta"]);
    let lab = SshdLab::start();
    lab.authorize_options(&pinned_options(
        &sessions,
        &sessions.descriptors[0].session_id,
    ));

    let mut relay = lab.relay();
    relay.send_document(LIST_REQUEST);
    let (documents, _) = relay.drain_documents();
    assert_eq!(documents.len(), 1, "a pinned key lists one session");
    assert_eq!(
        documents[0]["session"]["session_id"],
        sessions.descriptors[0].session_id.as_str()
    );
}

#[test]
fn a_pinned_key_whose_session_is_gone_answers_rather_than_ending_cleanly() {
    // The way a pinned key dies in practice: the operator wrote a session id
    // into the forced command and the Host was later replaced. A clean empty
    // listing here is byte-identical to "this server runs nothing", which is
    // the one sentence a phone must never say by accident.
    let sessions = Sessions::start(&["alpha"]);
    let lab = SshdLab::start();
    lab.authorize_options(&pinned_options(&sessions, "standalone_a_replaced_host"));

    let mut relay = lab.relay();
    relay.send_document(LIST_REQUEST);
    let error = relay.next_error();
    assert_eq!(error.code, ErrorCode::StaleDiscovery);
    assert_eq!(
        error.retry,
        hmux_host::local_protocol::RetryPosture::RetryAfterResync
    );
}

#[test]
fn a_request_version_this_build_does_not_serve_is_answered_on_the_wire() {
    // Version skew on the first document a phone ever sends. The whole point of
    // versioning the request is that the answer is legible; a close here would
    // be byte-identical to sshd refusing the key.
    let sessions = Sessions::start(&["alpha"]);
    let lab = SshdLab::start();
    lab.authorize_options(&unpinned_options(&sessions, ""));

    let mut relay = lab.relay();
    relay.send_document(br#"{"gateway_request_version":9999,"request":"list_sessions"}"#);
    let error = relay.next_error();
    assert_eq!(error.code, ErrorCode::UnsupportedProtocolVersion);
    assert!(
        error.message.contains("9999"),
        "the peer needs to know which version was refused: {}",
        error.message
    );
    assert!(
        error.supported_versions.is_some(),
        "a version refusal the peer cannot act on is a close with extra steps"
    );
}

#[test]
fn the_default_pairing_forced_command_serves_a_real_ssh_client() {
    // Item three, and the one that cannot be checked by reading a constant. A
    // default that produces a dead key fails hours later on someone else's
    // phone: this is exactly what happened when `--session` was required, and
    // the constant looked perfectly reasonable the whole time.
    //
    // The line under test is not written by this test. It is produced by the
    // shipped installer — `hmux pair start` with its default `--forced-command`
    // — and then handed to a real sshd verbatim.
    let sessions = Sessions::start(&["alpha", "beta"]);
    let lab = SshdLab::start();
    let home = lab.path("pairing-home");
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    std::fs::create_dir_all(home.join(".local/bin")).unwrap();
    // What `$HOME/.local/bin/hmux` must resolve to. A reviewer's lab that skips
    // this reaches the *installed* daily driver instead and gets
    // "unrecognized subcommand", which is a different failure entirely.
    std::os::unix::fs::symlink(hmux(), home.join(".local/bin/hmux")).unwrap();

    let installed = pair_one_device(&lab, &home);
    assert!(
        installed.starts_with("command=\""),
        "pairing must install a forced command: {installed}"
    );
    let (options, _) = installed
        .split_once(" ssh-ed25519 ")
        .expect("the entry carries options followed by the key");
    assert!(
        options.contains("restrict"),
        "restrict is what closes port forwarding: {installed}"
    );
    assert!(
        !options.contains("--session"),
        "a pinned session id would stale out on the next Host replacement, and it \
         cannot be supplied by the phone either: {installed}"
    );

    // The only edit: two `environment=` options so `$HOME` expands into this
    // lab. The `command="…"` value is untouched, which the assertion below
    // pins — rewriting it would make this test about a string of our own.
    let forced_command = options
        .split_once("\",restrict")
        .map(|(command, _)| format!("{command}\""))
        .expect("the option field is command=\"…\",restrict");
    let line = installed.replacen(
        "\",restrict",
        &format!(
            "\",restrict,environment=\"HOME={home}\",environment=\"HMUX_DISCOVERY_ROOT={root}\"",
            home = home.display(),
            root = sessions.discovery_root.display(),
        ),
        1,
    );
    assert!(
        line.contains(&forced_command),
        "the forced command must reach sshd byte-for-byte: {line}"
    );
    lab.authorize_line(&line);

    // Listing, which under the old contract exited 2 before a byte was read.
    let mut listing = lab.relay();
    listing.send_document(LIST_REQUEST);
    let (documents, _) = listing.drain_documents();
    assert_eq!(
        documents.len(),
        2,
        "the key pairing installs must be able to find the sessions it may serve"
    );

    // And an attach on the same key, which is the other half of what a paired
    // phone does.
    let mut attach = lab.relay();
    attach.send_frame(hello(sessions.fence(1), AttachMode::Observer));
    let body = attach.next_frame();
    let FrameBody::HelloAck(ack) = body else {
        panic!(
            "the paired key must serve an attach, got {:?}; sshd log: {}",
            body.kind(),
            std::fs::read_to_string(lab.path("sshd.log")).unwrap_or_default()
        );
    };
    assert_eq!(
        ack.actual_fence.session_id,
        sessions.descriptors[1].session_id
    );

    // The failure mode this whole change exists to remove, asserted as absent
    // rather than inferred from success.
    let diagnostics = attach.diagnostics();
    assert!(
        !diagnostics.contains("required arguments were not provided"),
        "the default forced command must not need arguments the phone cannot send: {diagnostics}"
    );
}

/// Runs the real `hmux pair start`, pairs this lab's key, and returns the
/// `authorized_keys` line the installer wrote.
fn pair_one_device(lab: &SshdLab, home: &Path) -> String {
    let host_key = lab.path("host_key.pub");
    let inventory = lab.path("inventory.json");
    // No remote hosts: this test is about the line, not about the ssh fan-out
    // that `tests/pairing.rs` already covers.
    std::fs::write(
        &inventory,
        r#"{"version":3,"agents":[],"projects":[],"sshHosts":[]}"#,
    )
    .unwrap();

    let mut child = Command::new(hmux())
        .env("HOME", home)
        .env("HMUX_PAIRING_INVENTORY", &inventory)
        .env("HMUX_PAIRING_DEVICES", lab.path("paired-devices.json"))
        .env("HMUX_PAIRING_SSH", "/usr/bin/false")
        .args([
            "pair",
            "start",
            "--address",
            "127.0.0.1",
            "--print-payload",
            "--port",
            "0",
            "--ttl-seconds",
            "60",
            "--host-key",
        ])
        .arg(&host_key)
        .arg("--laptop-ssh-port")
        .arg(lab.port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let public_key = lab.public_key();
    let answer = redeem_pairing(&mut child, &public_key);
    assert_eq!(answer["status"], "paired", "{answer}");

    let installed = std::fs::read_to_string(home.join(".ssh/authorized_keys")).unwrap();
    installed
        .lines()
        .find(|line| line.contains("hmux-pairing:"))
        .expect("pairing must have installed an entry")
        .to_string()
}

fn redeem_pairing(child: &mut Child, public_key: &str) -> serde_json::Value {
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut payload = None;
    let mut line = String::new();
    while stdout.read_line(&mut line).unwrap() > 0 {
        if let Some(rest) = line.trim_end().strip_prefix("payload: ") {
            payload = Some(rest.to_string());
            break;
        }
        line.clear();
    }
    let payload = payload.expect("`hmux pair start` must print its payload");
    let fields: BTreeMap<&str, &str> = payload
        .strip_prefix("hmux-pair:1?")
        .expect("the payload names its scheme and version")
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .collect();
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(fields["t"])
        .unwrap();

    let device_name = "lab phone";
    let nonce = [3u8; 16];
    let proof = hmac_sha256(
        &token,
        &transcript(
            b"hmux-pairing-request-v1",
            &[b"1", device_name.as_bytes(), public_key.as_bytes(), &nonce],
        ),
    );
    let request = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "device_name": device_name,
        "public_key": public_key,
        "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
        "proof": base64::engine::general_purpose::STANDARD.encode(proof),
    }))
    .unwrap();

    let mut stream =
        TcpStream::connect((fields["a"], fields["p"].parse::<u16>().unwrap())).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    stream.write_all(&request).unwrap();
    stream.write_all(b"\n").unwrap();
    let mut answer = String::new();
    BufReader::new(&stream).read_line(&mut answer).unwrap();
    let answer: serde_json::Value = serde_json::from_str(answer.trim()).unwrap();
    let _ = child.wait();
    answer
}

#[test]
fn pairing_and_revoke_follow_the_same_proxyjump_alias_and_pin_the_target() {
    let jump = SshdLab::start();
    let target = SshdLab::start();
    let substitute = SshdLab::start();
    jump.authorize_line(&jump.public_key());
    target.authorize_line(&target.public_key());
    substitute.authorize_line(&substitute.public_key());

    let laptop = tempfile::tempdir().unwrap();
    let laptop_home = laptop.path();
    let ssh_directory = laptop_home.join(".ssh");
    std::fs::create_dir_all(&ssh_directory).unwrap();
    std::fs::set_permissions(
        &ssh_directory,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
    let known_hosts = ssh_directory.join("known_hosts");
    std::fs::write(
        &known_hosts,
        format!(
            "jump-trust-name {}\ntarget-trust-name {}\nsubstitute-trust-name {}\n",
            std::fs::read_to_string(jump.path("host_key.pub"))
                .unwrap()
                .trim(),
            std::fs::read_to_string(target.path("host_key.pub"))
                .unwrap()
                .trim(),
            std::fs::read_to_string(substitute.path("host_key.pub"))
                .unwrap()
                .trim(),
        ),
    )
    .unwrap();
    let config = ssh_directory.join("config");
    let write_config = |destination: &SshdLab, trust_name: &str| {
        std::fs::write(
            &config,
            format!(
                "Host jump-for-target\n\
             HostName 127.0.0.1\n\
             Port {jump_port}\n\
             User {user}\n\
             IdentityFile \"{jump_key}\"\n\
             IdentitiesOnly yes\n\
             HostKeyAlias jump-trust-name\n\
             UserKnownHostsFile \"{known_hosts}\"\n\
             StrictHostKeyChecking yes\n\
             Host target-via-jump\n\
             HostName 127.0.0.1\n\
             Port {target_port}\n\
             User {user}\n\
             IdentityFile \"{target_key}\"\n\
             IdentitiesOnly yes\n\
             ProxyJump jump-for-target\n\
             HostKeyAlias {trust_name}\n\
             UserKnownHostsFile \"{known_hosts}\"\n\
             StrictHostKeyChecking yes\n\
             RemoteCommand false\n\
             SessionType none\n\
             StdinNull yes\n\
             ForkAfterAuthentication yes\n",
                jump_port = jump.port,
                target_port = destination.port,
                user = current_username(),
                jump_key = jump.path("client_key").display(),
                target_key = destination.path("client_key").display(),
                known_hosts = known_hosts.display(),
            ),
        )
        .unwrap();
    };
    write_config(&target, "target-trust-name");
    std::fs::set_permissions(&config, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();

    let ssh_wrapper = laptop_home.join("ssh-with-fixture-config");
    std::fs::write(
        &ssh_wrapper,
        format!(
            "#!/bin/sh\nexec /usr/bin/ssh -F {} \"$@\"\n",
            shell_word(&config)
        ),
    )
    .unwrap();
    std::fs::set_permissions(
        &ssh_wrapper,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();

    let inventory = laptop_home.join("inventory.json");
    std::fs::write(
        &inventory,
        serde_json::to_vec(&serde_json::json!({
            "version": 3,
            "agents": [],
            "projects": [],
            "sshHosts": [{
                "id": "target",
                "name": "target through jump",
                "sshConfigAlias": "target-via-jump",
                // These are the phone's direct endpoint coordinates. The
                // laptop install route is the opaque alias above.
                "host": "127.0.0.1",
                "port": target.port,
                "user": current_username(),
                "auth": "key",
                "keyPath": "/decoy/must-not-reach-argv"
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let remote_home = laptop_home.join("remote-home");
    std::fs::create_dir_all(&remote_home).unwrap();
    let qr_metadata_key = laptop_home.join("qr-metadata-key");
    keygen(&qr_metadata_key, "remote-only-metadata");
    let remote_hmux = format!(
        "env HOME={} {}",
        shell_word(&remote_home),
        shell_word(&hmux())
    );
    let devices = laptop_home.join("paired-devices.json");
    let mut child = Command::new(hmux())
        .env("HOME", laptop_home)
        .env("HMUX_PAIRING_INVENTORY", &inventory)
        .env("HMUX_PAIRING_DEVICES", &devices)
        .env("HMUX_PAIRING_SSH", &ssh_wrapper)
        .args([
            "pair",
            "start",
            "--remote-only",
            "--address",
            "127.0.0.1",
            "--print-payload",
            "--port",
            "0",
            "--ttl-seconds",
            "60",
            "--host-key",
        ])
        .arg(qr_metadata_key.with_extension("pub"))
        .arg("--remote-hmux")
        .arg(&remote_hmux)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let answer = redeem_pairing(&mut child, &target.public_key());
    assert_eq!(answer["status"], "paired", "{answer}");
    assert_eq!(answer["hosts"][0]["installed"], true, "{answer}");
    assert_eq!(
        answer["hosts"][0]["host_key_fingerprint"],
        public_key_fingerprint(&target.path("host_key.pub")),
        "the target key, never the ProxyJump key, is the phone's pin"
    );
    assert_ne!(
        answer["hosts"][0]["host_key_fingerprint"],
        public_key_fingerprint(&jump.path("host_key.pub"))
    );
    assert_ne!(
        answer["hosts"][0]["host_key_fingerprint"],
        public_key_fingerprint(&qr_metadata_key.with_extension("pub")),
        "the remote-only QR compatibility key is not a remote receipt authority"
    );
    let installed = std::fs::read_to_string(remote_home.join(".ssh/authorized_keys")).unwrap();
    assert!(installed.contains("hmux-pairing:"), "{installed}");
    let registry: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&devices).unwrap()).unwrap();
    assert_eq!(
        registry["devices"][0]["hosts"][0]["ssh_config_alias"], "target-via-jump",
        "revocation must retain the exact OpenSSH route: {registry}"
    );
    assert_eq!(
        registry["devices"][0]["hosts"][0]["host_key_fingerprint"],
        public_key_fingerprint(&target.path("host_key.pub")),
        "the observed identity must be durable before mutation: {registry}"
    );

    let device_id = answer["device_id"].as_str().unwrap();
    let revoke = || {
        Command::new(hmux())
            .env("HOME", laptop_home)
            .env("HMUX_PAIRING_DEVICES", &devices)
            .env("HMUX_PAIRING_SSH", &ssh_wrapper)
            .args(["pair", "revoke", device_id, "--remote-hmux"])
            .arg(&remote_hmux)
            .status()
            .unwrap()
    };

    write_config(&substitute, "substitute-trust-name");
    let mismatch = revoke();
    assert!(
        !mismatch.success(),
        "an alias redirected to another SSH identity must be refused before mutation"
    );
    let after_mismatch = std::fs::read_to_string(remote_home.join(".ssh/authorized_keys")).unwrap();
    assert!(after_mismatch.contains("hmux-pairing:"), "{after_mismatch}");
    let retained: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&devices).unwrap()).unwrap();
    assert_eq!(retained["devices"].as_array().unwrap().len(), 1);

    write_config(&target, "target-trust-name");
    let status = revoke();
    assert!(
        status.success(),
        "revoke must reuse the stored config alias"
    );
    let after_revoke =
        std::fs::read_to_string(remote_home.join(".ssh/authorized_keys")).unwrap_or_default();
    assert!(!after_revoke.contains("hmux-pairing:"), "{after_revoke}");
}

fn public_key_fingerprint(path: &Path) -> String {
    let public_key = std::fs::read_to_string(path).unwrap();
    let encoded = public_key.split_ascii_whitespace().nth(1).unwrap();
    let blob = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(blob))
    )
}

fn shell_word(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
}

/// HMAC-SHA256, written from RFC 2104 so the stand-in checks rather than echoes.
fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let inner: Vec<u8> = block.iter().map(|byte| byte ^ 0x36).collect();
    let outer: Vec<u8> = block.iter().map(|byte| byte ^ 0x5c).collect();
    let mut first = Sha256::new();
    first.update(&inner);
    first.update(message);
    let first = first.finalize();
    let mut second = Sha256::new();
    second.update(&outer);
    second.update(first);
    second.finalize().to_vec()
}

/// Length-prefixed transcript, as documented in `pairing::token`.
fn transcript(label: &[u8], fields: &[&[u8]]) -> Vec<u8> {
    let mut encoded = Vec::new();
    for field in std::iter::once(&label).chain(fields.iter()) {
        encoded.extend_from_slice(&(field.len() as u64).to_be_bytes());
        encoded.extend_from_slice(field);
    }
    encoded
}

/// The report the phone labels a server with, checked both ways against a real
/// sshd.
///
/// Why both ways in one test: the value of this bit is entirely in the
/// *difference* between two servers the owner paired identically. A test that
/// only saw the fenced case would pass against a build that hard-coded `true`,
/// and that build is exactly the bug — the phone said "pinned to a forced
/// command" about a Tailscale host where nothing was pinned.
#[test]
fn the_listing_says_whether_a_forced_command_actually_applied() {
    let sessions = Sessions::start(&["alpha"]);

    // Fenced: the entry carries `command="…",restrict`, so sshd replaces the
    // client's argv and puts it in SSH_ORIGINAL_COMMAND.
    let fenced = SshdLab::start();
    fenced.authorize_options(&unpinned_options(&sessions, ""));
    let mut relay = fenced.relay();
    relay.send_document(LIST_REQUEST);
    let (documents, _) = relay.drain_documents();
    let first = documents.first().expect("a fenced listing answers");
    assert_eq!(
        first["forced_command_applied"],
        serde_json::Value::Bool(true),
        "a forced command applied and the listing must say so: {first}"
    );

    // Unfenced: same key material, same gateway, no `command=` in the entry.
    // This is the Tailscale-SSH shape reproduced with plain sshd — that host
    // never reads authorized_keys at all, and the observable end state is the
    // same one: the client's own string runs.
    let unfenced = SshdLab::start();
    unfenced.authorize_line(&unfenced.public_key());
    let mut relay = unfenced.relay_requesting(&unfenced_gateway_command(&sessions));
    relay.send_document(LIST_REQUEST);
    let (documents, _) = relay.drain_documents();
    let first = documents
        .first()
        .expect("an unfenced listing answers too — it is the same gateway");
    assert_eq!(
        first["forced_command_applied"],
        serde_json::Value::Bool(false),
        "no forced command applied and the listing must not claim one: {first}"
    );
    // The sessions themselves are still listed. The bit describes the fence,
    // not whether the gateway works — conflating the two would make an
    // unfenced server look broken instead of look unfenced.
    assert!(first["session"]["session_id"].is_string(), "{first}");
}
