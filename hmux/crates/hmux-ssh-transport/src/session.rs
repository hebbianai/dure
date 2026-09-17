//! Establishing the SSH session and the exec channel, with russh.
//!
//! russh rather than ssh2 for two reasons that are both about where this code
//! has to run. ssh2 is a C library — the desktop builds it with vendored
//! OpenSSL — and a phone build cannot carry that. And ssh2 takes a
//! session-wide lock on every read and write, so one blocking read starves
//! every other channel on the same session; a client that attaches to several
//! sessions at once would serialize on it.
//!
//! russh is not the pure-Rust story it is sometimes described as: it refuses to
//! build without `ring` or `aws-lc-rs`, both of which compile native code. What
//! it does have is a build that works with an ordinary cross toolchain, which
//! is verified against `aarch64-apple-ios` and `aarch64-linux-android`.

use crate::channel::{ChannelEvent, ExecChannelReader, ExecChannelWriter};
use crate::error::SshTransportError;
use russh::client::{Handle, Msg};
use russh::keys::{Algorithm, HashAlg, PrivateKeyWithHashAlg, decode_secret_key};
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use std::borrow::Cow;
use std::fmt;
use std::io;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncWrite, AsyncWriteExt};

/// The host-key preference shared by the direct russh client and system
/// OpenSSH operations that mint its pins.
const HOST_KEY_ALGORITHMS: &[Algorithm] = &[
    Algorithm::Ed25519,
    Algorithm::Ecdsa {
        curve: russh::keys::ssh_key::EcdsaCurve::NistP256,
    },
    Algorithm::Ecdsa {
        curve: russh::keys::ssh_key::EcdsaCurve::NistP384,
    },
    Algorithm::Ecdsa {
        curve: russh::keys::ssh_key::EcdsaCurve::NistP521,
    },
    Algorithm::Rsa {
        hash: Some(HashAlg::Sha512),
    },
    Algorithm::Rsa {
        hash: Some(HashAlg::Sha256),
    },
    Algorithm::Rsa { hash: None },
];

/// OpenSSH projection of [`HOST_KEY_ALGORITHMS`].
#[must_use]
pub fn openssh_host_key_algorithms() -> String {
    HOST_KEY_ALGORITHMS
        .iter()
        .map(AsRef::as_ref)
        .collect::<Vec<_>>()
        .join(",")
}

pub(crate) fn client_config() -> Arc<russh::client::Config> {
    Arc::new(russh::client::Config {
        // A phone's connection dies quietly. Without keepalives a session that
        // has already gone away stays open until a write eventually fails.
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        preferred: russh::Preferred {
            key: Cow::Borrowed(HOST_KEY_ALGORITHMS),
            ..russh::Preferred::default()
        },
        ..russh::client::Config::default()
    })
}

/// Where the session lives.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct SshEndpoint {
    pub host: String,
    pub port: u16,
}

/// How to prove who we are to sshd.
///
/// No `Debug` derive: the whole point of this type is that it holds key
/// material, and a struct that logs itself is how key material escapes.
#[derive(Clone)]
pub enum SshAuthentication {
    /// An OpenSSH-format private key, as text.
    PrivateKey {
        openssh_pem: String,
        passphrase: Option<String>,
    },
    /// Sign through the agent selected by `SSH_AUTH_SOCK`.
    Agent,
    Password(String),
}

impl fmt::Debug for SshAuthentication {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let method = match self {
            Self::PrivateKey { .. } => "private-key",
            Self::Agent => "ssh-agent",
            Self::Password(_) => "password",
        };
        formatter
            .debug_struct("SshAuthentication")
            .field("method", &method)
            .finish_non_exhaustive()
    }
}

/// Which host keys to accept, as `SHA256:...` fingerprints.
///
/// There is deliberately no "accept anything" variant. A relay attach carries
/// a session's entire input stream, and a client that accepts any host key
/// hands that stream to whoever answers the address — which is exactly the
/// position a phone on a hostile network is in. Pinning is the only mode.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct HostKeyPolicy {
    pinned: Vec<String>,
}

impl HostKeyPolicy {
    #[must_use]
    pub fn pinned(fingerprints: impl IntoIterator<Item = String>) -> Self {
        Self {
            pinned: fingerprints.into_iter().collect(),
        }
    }

    /// Resolve exact endpoint keys from one stable owner-only OpenSSH trust
    /// file, then retain only their SHA-256 fingerprints.
    pub fn from_known_hosts_file(
        host: &str,
        port: u16,
        path: &Path,
    ) -> Result<Self, SshTransportError> {
        let before = known_hosts_metadata(path)?;
        let keys =
            russh::keys::known_hosts::known_host_keys_path(host, port, path).map_err(|error| {
                SshTransportError::KnownHosts {
                    detail: error.to_string(),
                }
            })?;
        let after = known_hosts_metadata(path)?;
        if !same_known_hosts_file(&before, &after) {
            return Err(SshTransportError::KnownHosts {
                detail: "the trust file changed while it was read".into(),
            });
        }
        if keys.is_empty() {
            return Err(SshTransportError::KnownHosts {
                detail: format!("no key for {host}:{port}"),
            });
        }
        Ok(Self::pinned(keys.into_iter().map(|(_, key)| {
            key.fingerprint(HashAlg::Sha256).to_string()
        })))
    }

    fn accepts(&self, fingerprint: &str) -> bool {
        self.pinned.iter().any(|pinned| pinned == fingerprint)
    }
}

const MAX_KNOWN_HOSTS_BYTES: u64 = 1024 * 1024;

fn known_hosts_metadata(path: &Path) -> Result<std::fs::Metadata, SshTransportError> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| SshTransportError::KnownHosts {
            detail: error.to_string(),
        })?;
    let unsafe_file = !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > MAX_KNOWN_HOSTS_BYTES;
    #[cfg(unix)]
    let unsafe_file = unsafe_file
        || metadata.mode() & 0o077 != 0
        // SAFETY: `geteuid` reads process identity and has no preconditions.
        || metadata.uid() != unsafe { libc::geteuid() };
    if unsafe_file {
        return Err(SshTransportError::KnownHosts {
            detail: "the trust file must be an owner-only regular file".into(),
        });
    }
    Ok(metadata)
}

#[cfg(unix)]
fn same_known_hosts_file(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.size() == right.size()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

#[cfg(not(unix))]
fn same_known_hosts_file(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && left.created().ok() == right.created().ok()
}

/// Everything needed to reach a gateway.
#[derive(Clone, Debug)]
pub struct SshExecConfig {
    pub endpoint: SshEndpoint,
    pub user: String,
    pub authentication: SshAuthentication,
    pub host_key: HostKeyPolicy,
    /// The command sshd runs. The default is the gateway; it is configurable
    /// because a deployment may install it under a path.
    pub command: String,
    pub connect_timeout: Duration,
    /// How long a writer waits for a stalled channel to drain before giving
    /// up. `None` waits forever. Bounding it is safe here in a way that
    /// `SO_SNDTIMEO` is not: the wait happens before a frame is admitted, so
    /// expiry cannot leave a partial frame on the wire.
    pub write_admission_timeout: Option<Duration>,
}

/// The gateway command: a first-class Hmux client on the session's machine,
/// not a byte pump. It reads the manifests, dials the local socket itself, and
/// only then bridges frames — so the capability token never crosses SSH.
///
/// The same string `hmux pair` pins in `authorized_keys`, and deliberately not
/// a second literal that merely looks like it. Where the forced command applies
/// this value is discarded; where something else authenticates the connection
/// — Tailscale SSH serves the session itself and never reads `authorized_keys`
/// — this is what actually runs. See [`hmux_client::gateway_invocation`].
pub const DEFAULT_GATEWAY_COMMAND: &str = hmux_client::gateway_invocation::GATEWAY_INVOCATION;
const CONTROLLER_GATEWAY_COMMAND: &str =
    hmux_client::gateway_invocation::CONTROLLER_GATEWAY_INVOCATION;

impl SshExecConfig {
    #[must_use]
    pub fn new(
        endpoint: SshEndpoint,
        user: impl Into<String>,
        authentication: SshAuthentication,
        host_key: HostKeyPolicy,
    ) -> Self {
        Self {
            endpoint,
            user: user.into(),
            authentication,
            host_key,
            command: DEFAULT_GATEWAY_COMMAND.to_string(),
            connect_timeout: Duration::from_secs(20),
            write_admission_timeout: None,
        }
    }

    /// Request the controller ceiling from an ordinary SSH exec gateway.
    ///
    /// A forced command remains authoritative and can keep an enrolled key
    /// observer-only; the gateway then returns a typed authorization refusal.
    #[must_use]
    pub fn with_controller_gateway(mut self) -> Self {
        self.command = CONTROLLER_GATEWAY_COMMAND.to_string();
        self
    }
}

pub(crate) struct ClientHandler {
    host_key: HostKeyPolicy,
    offered_fingerprint: Arc<std::sync::Mutex<Option<String>>>,
}

impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let accepted = self.host_key.accepts(&fingerprint);
        // Recorded even when accepted, so a rejection can name what the host
        // actually offered. russh reports a refusal as a generic connection
        // error, and "could not connect" sends the user to the wrong fix.
        *self
            .offered_fingerprint
            .lock()
            .expect("offered fingerprint lock") = Some(fingerprint);
        Ok(accepted)
    }
}

/// One exec channel on an already authenticated session, split into the
/// halves the pump drives. The session may carry any number of these.
pub(crate) struct ExecChannel {
    pub(crate) reader: RusshChannelReader,
    pub(crate) writer: RusshChannelWriter,
    pub(crate) prelude: Vec<ChannelEvent>,
}

/// Which step of opening an exec channel failed. A channel that could not be
/// opened at all says something about the connection; an exec the server
/// refused says something about the box.
pub(crate) enum OpenExecError {
    ChannelOpen(SshTransportError),
    Exec(SshTransportError),
}

pub(crate) async fn open_exec(
    session: &Handle<ClientHandler>,
    config: &SshExecConfig,
) -> Result<ExecChannel, OpenExecError> {
    let channel = open_exec_channel(session, config)
        .await
        .map_err(OpenExecError::ChannelOpen)?;

    // No `request_pty`, and that is a precondition rather than an omission. A
    // PTY would put a line discipline between the gateway and this stream:
    // ONLCR would rewrite \n inside a frame payload, ^C would be interpreted
    // rather than delivered, and the 8-bit-clean byte stream the frame codec
    // requires would be gone. An exec channel without a PTY is a raw pipe.
    let (channel, events) = start_exec(channel, config)
        .await
        .map_err(OpenExecError::Exec)?;
    let (read, write) = channel.split();
    Ok(ExecChannel {
        reader: RusshChannelReader { read },
        writer: RusshChannelWriter::new(write),
        prelude: events,
    })
}

pub(crate) type AuthenticatedSession = Handle<ClientHandler>;

pub(crate) async fn connect_authenticated(
    config: &SshExecConfig,
) -> Result<Handle<ClientHandler>, SshTransportError> {
    let target = format!("{}:{}", config.endpoint.host, config.endpoint.port);
    let offered_fingerprint = Arc::new(std::sync::Mutex::new(None));
    let handler = ClientHandler {
        host_key: config.host_key.clone(),
        offered_fingerprint: Arc::clone(&offered_fingerprint),
    };

    let mut session = russh::client::connect(
        client_config(),
        (config.endpoint.host.as_str(), config.endpoint.port),
        handler,
    )
    .await
    .map_err(|error| {
        let offered = offered_fingerprint
            .lock()
            .expect("offered fingerprint lock")
            .clone();
        match offered {
            Some(fingerprint) => SshTransportError::HostKeyRejected { fingerprint },
            None => SshTransportError::Connect {
                target: target.clone(),
                detail: error.to_string(),
            },
        }
    })?;

    authenticate(&mut session, config).await?;
    Ok(session)
}

async fn open_exec_channel(
    session: &Handle<ClientHandler>,
    config: &SshExecConfig,
) -> Result<russh::Channel<Msg>, SshTransportError> {
    session
        .channel_open_session()
        .await
        .map_err(|error| SshTransportError::Exec {
            command: config.command.clone(),
            detail: error.to_string(),
        })
}

async fn authenticate(
    session: &mut Handle<ClientHandler>,
    config: &SshExecConfig,
) -> Result<(), SshTransportError> {
    if matches!(&config.authentication, SshAuthentication::Agent) {
        return authenticate_with_agent(session, config).await;
    }
    let result = match &config.authentication {
        SshAuthentication::Password(password) => session
            .authenticate_password(config.user.clone(), password.clone())
            .await
            .map_err(|error| SshTransportError::Connect {
                target: format!("{}:{}", config.endpoint.host, config.endpoint.port),
                detail: error.to_string(),
            })?,
        SshAuthentication::PrivateKey {
            openssh_pem,
            passphrase,
        } => {
            let key = decode_secret_key(openssh_pem, passphrase.as_deref()).map_err(|error| {
                SshTransportError::PrivateKey {
                    detail: error.to_string(),
                }
            })?;
            // RSA is three signature algorithms wearing one key format, and a
            // server that has disabled the SHA-1 one refuses an otherwise
            // valid key, so ask which it will take. Only for RSA: the question
            // waits up to a second for the server's extension info, and paying
            // that on every attach with an Ed25519 key would put a second of
            // latency on the common path for nothing.
            let hash = if matches!(key.algorithm(), Algorithm::Rsa { .. }) {
                session
                    .best_supported_rsa_hash()
                    .await
                    .ok()
                    .flatten()
                    .flatten()
            } else {
                None
            };
            session
                .authenticate_publickey(
                    config.user.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|error| SshTransportError::Connect {
                    target: format!("{}:{}", config.endpoint.host, config.endpoint.port),
                    detail: error.to_string(),
                })?
        }
        SshAuthentication::Agent => unreachable!("agent authentication returned above"),
    };
    if result.success() {
        Ok(())
    } else {
        Err(SshTransportError::Authentication {
            user: config.user.clone(),
        })
    }
}

#[cfg(unix)]
async fn authenticate_with_agent(
    session: &mut Handle<ClientHandler>,
    config: &SshExecConfig,
) -> Result<(), SshTransportError> {
    use russh::keys::agent::{AgentIdentity, client::AgentClient};

    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|error| SshTransportError::Agent {
            detail: error.to_string(),
        })?;
    let identities =
        agent
            .request_identities()
            .await
            .map_err(|error| SshTransportError::Agent {
                detail: error.to_string(),
            })?;
    for identity in identities {
        let hash = if matches!(identity.public_key().algorithm(), Algorithm::Rsa { .. }) {
            session
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten()
        } else {
            None
        };
        let result = match identity {
            AgentIdentity::PublicKey { key, .. } => {
                session
                    .authenticate_publickey_with(config.user.clone(), key, hash, &mut agent)
                    .await
            }
            AgentIdentity::Certificate { certificate, .. } => {
                session
                    .authenticate_certificate_with(
                        config.user.clone(),
                        certificate,
                        hash,
                        &mut agent,
                    )
                    .await
            }
        }
        .map_err(|error| SshTransportError::Agent {
            detail: error.to_string(),
        })?;
        if result.success() {
            return Ok(());
        }
    }
    Err(SshTransportError::Authentication {
        user: config.user.clone(),
    })
}

#[cfg(not(unix))]
async fn authenticate_with_agent(
    _session: &mut Handle<ClientHandler>,
    _config: &SshExecConfig,
) -> Result<(), SshTransportError> {
    Err(SshTransportError::Agent {
        detail: "SSH agent authentication is unavailable on this platform".into(),
    })
}

async fn start_exec(
    mut channel: russh::Channel<Msg>,
    config: &SshExecConfig,
) -> Result<(russh::Channel<Msg>, Vec<ChannelEvent>), SshTransportError> {
    channel
        .exec(true, config.command.as_bytes())
        .await
        .map_err(|error| SshTransportError::Exec {
            command: config.command.clone(),
            detail: error.to_string(),
        })?;

    let mut events = Vec::new();
    loop {
        let Some(message) = channel.wait().await else {
            return Err(SshTransportError::Exec {
                command: config.command.clone(),
                detail: "the channel closed before the command started".to_string(),
            });
        };
        match message {
            ChannelMsg::Success => break,
            ChannelMsg::Failure => {
                return Err(SshTransportError::Exec {
                    command: config.command.clone(),
                    detail: "the server refused the exec request".to_string(),
                });
            }
            // Nothing should arrive before the confirmation, but a message
            // consumed here would be gone for good, so anything that does is
            // handed to the pump rather than dropped.
            other => {
                if let Some(event) = classify(other) {
                    events.push(event);
                }
            }
        }
    }

    Ok((channel, events))
}

pub(crate) async fn execute_bounded(
    config: &SshExecConfig,
    maximum_output_bytes: usize,
) -> Result<(Vec<u8>, Vec<u8>, u32), SshTransportError> {
    let session = connect_authenticated(config).await?;
    let channel = open_exec_channel(&session, config).await?;
    let (mut channel, prelude) = start_exec(channel, config).await?;
    // The command has no stdin, so EOF prevents a forced command from waiting
    // for bytes that can never arrive. It is best-effort: a fast command may
    // have already closed the channel after publishing its complete result,
    // and the exit-status/stream events below remain the authority for that
    // outcome.
    let _ = channel.eof().await;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_status = None;

    for event in prelude {
        collect_exec_event(
            event,
            &mut stdout,
            &mut stderr,
            &mut exit_status,
            maximum_output_bytes,
            &config.command,
        )?;
    }
    loop {
        let event = match channel.wait().await {
            Some(message) => classify(message),
            None => Some(ChannelEvent::Ended),
        };
        let Some(event) = event else {
            continue;
        };
        let ended = matches!(event, ChannelEvent::Ended);
        collect_exec_event(
            event,
            &mut stdout,
            &mut stderr,
            &mut exit_status,
            maximum_output_bytes,
            &config.command,
        )?;
        if ended {
            break;
        }
    }
    let status = exit_status.ok_or_else(|| SshTransportError::Exec {
        command: config.command.clone(),
        detail: "the remote command closed without an exit status".to_string(),
    })?;
    drop(session);
    Ok((stdout, stderr, status))
}

fn collect_exec_event(
    event: ChannelEvent,
    stdout: &mut Vec<u8>,
    stderr: &mut Vec<u8>,
    exit_status: &mut Option<u32>,
    maximum_output_bytes: usize,
    command: &str,
) -> Result<(), SshTransportError> {
    match event {
        ChannelEvent::Data(bytes) => append_bounded(stdout, &bytes, "stdout", maximum_output_bytes),
        ChannelEvent::Diagnostic(bytes) => {
            append_bounded(stderr, &bytes, "stderr", maximum_output_bytes)
        }
        ChannelEvent::Exited(status) => {
            if exit_status.replace(status).is_some() {
                return Err(SshTransportError::Exec {
                    command: command.to_string(),
                    detail: "the remote command reported multiple exit statuses".to_string(),
                });
            }
            Ok(())
        }
        ChannelEvent::EndOfData | ChannelEvent::Ended => Ok(()),
    }
}

fn append_bounded(
    destination: &mut Vec<u8>,
    bytes: &[u8],
    stream: &'static str,
    maximum_output_bytes: usize,
) -> Result<(), SshTransportError> {
    if bytes.len() > maximum_output_bytes.saturating_sub(destination.len()) {
        return Err(SshTransportError::OutputLimit {
            stream,
            maximum_bytes: maximum_output_bytes,
        });
    }
    destination.extend_from_slice(bytes);
    Ok(())
}

fn classify(message: ChannelMsg) -> Option<ChannelEvent> {
    match message {
        ChannelMsg::Data { data } => Some(ChannelEvent::Data(data.to_vec())),
        // Stream 2 only. Any other extended stream is not something an Hmux
        // gateway produces, and guessing at it would risk feeding it to the
        // frame decoder.
        ChannelMsg::ExtendedData { data, ext: 1 } => Some(ChannelEvent::Diagnostic(data.to_vec())),
        ChannelMsg::ExitStatus { exit_status } => Some(ChannelEvent::Exited(exit_status)),
        ChannelMsg::ExitSignal {
            signal_name,
            error_message,
            ..
        } => Some(ChannelEvent::Diagnostic(
            format!("the remote command died on {signal_name:?}: {error_message}").into_bytes(),
        )),
        ChannelMsg::Eof => Some(ChannelEvent::EndOfData),
        ChannelMsg::Close => Some(ChannelEvent::Ended),
        _ => None,
    }
}

pub(crate) struct RusshChannelReader {
    read: ChannelReadHalf,
}

impl ExecChannelReader for RusshChannelReader {
    async fn next_event(&mut self) -> ChannelEvent {
        loop {
            // `wait` is a receive on a tokio channel, so dropping this future
            // -- which the pump does on every detach -- leaves any unreceived
            // message queued rather than losing it.
            let Some(message) = self.read.wait().await else {
                return ChannelEvent::Ended;
            };
            if let Some(event) = classify(message) {
                return event;
            }
        }
    }
}

pub(crate) struct RusshChannelWriter {
    write: ChannelWriteHalf<Msg>,
    /// russh's own `AsyncWrite` half. Boxed because the concrete type is
    /// opaque and `AsyncWriteExt::write` needs `Unpin`.
    stream: Pin<Box<dyn AsyncWrite>>,
}

impl RusshChannelWriter {
    fn new(write: ChannelWriteHalf<Msg>) -> Self {
        let stream = Box::pin(write.make_writer());
        Self { write, stream }
    }
}

impl ExecChannelWriter for RusshChannelWriter {
    async fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // Deliberately one `write`, not `write_all`. russh chops this at the
        // channel's window and reports what it took; that count is what the
        // all-or-nothing frame contract is built on.
        self.stream.write(bytes).await
    }

    async fn finish(&mut self) -> io::Result<()> {
        self.write.eof().await.map_err(io::Error::other)
    }

    async fn close(&mut self) {
        let _ = self.write.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::fs::Permissions;
    use std::fs::write;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn config() -> SshExecConfig {
        SshExecConfig::new(
            SshEndpoint {
                host: "server.example".to_string(),
                port: 22,
            },
            "developer",
            SshAuthentication::Password("test-only".to_string()),
            HostKeyPolicy::pinned(["SHA256:test".to_string()]),
        )
    }

    #[test]
    fn controller_attach_uses_the_explicit_controller_gateway_ceiling() {
        assert_eq!(config().command, DEFAULT_GATEWAY_COMMAND);
        assert_eq!(
            config().with_controller_gateway().command,
            CONTROLLER_GATEWAY_COMMAND
        );
    }

    #[test]
    fn russh_and_openssh_share_one_host_key_preference() {
        let config = client_config();
        assert_eq!(config.preferred.key.as_ref(), HOST_KEY_ALGORITHMS);
        assert_eq!(
            openssh_host_key_algorithms(),
            "ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,\
             ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256,ssh-rsa"
        );
    }

    #[test]
    fn authentication_debug_never_exposes_material() {
        assert!(format!("{:?}", SshAuthentication::Agent).contains("ssh-agent"));
        let key = SshAuthentication::PrivateKey {
            openssh_pem: "secret".into(),
            passphrase: Some("passphrase".into()),
        };
        let debug = format!("{key:?}");
        assert!(debug.contains("private-key"));
        assert!(!debug.contains("secret"));
        assert!(!debug.contains("passphrase"));
    }

    #[test]
    fn known_hosts_file_selects_only_the_exact_endpoint() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("known_hosts");
        write(
            &path,
            concat!(
                "[server.example]:2222 ssh-ed25519 ",
                "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ\n",
            ),
        )
        .unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&path, Permissions::from_mode(0o600)).unwrap();

        let policy = HostKeyPolicy::from_known_hosts_file("server.example", 2222, &path).unwrap();
        let key = russh::keys::parse_public_key_base64(
            "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ",
        )
        .unwrap();
        assert!(policy.accepts(&key.fingerprint(HashAlg::Sha256).to_string()));

        let error = HostKeyPolicy::from_known_hosts_file("other.example", 2222, &path).unwrap_err();
        assert_eq!(error.code(), "hmux_ssh_host_trust_unavailable");

        #[cfg(unix)]
        {
            std::fs::set_permissions(&path, Permissions::from_mode(0o644)).unwrap();
            let error =
                HostKeyPolicy::from_known_hosts_file("server.example", 2222, &path).unwrap_err();
            assert_eq!(error.code(), "hmux_ssh_host_trust_unavailable");
        }
    }
}
