//! Reaching a session on a machine this device does not share a kernel with.
//!
//! Two SSH exec channels, both to `hmux mobile-gateway` on the session-owning
//! box, both authenticated by a private key the user supplied:
//!
//! 1. the listing: one framed request document out
//!    ([`crate::catalog::list_request`]), a framed JSON catalog back, no
//!    handshake. This is how the client learns the seven fence fields it cannot
//!    guess. The request travels *on the channel* rather than as a `--list` in
//!    the exec command, because a forced command replaces the exec command and
//!    the key `hmux pair` installs is a forced command.
//! 2. the attach, which runs the real Hmux handshake through
//!    `TerminalSurfaceAttachment` and exchanges complete viewport frames and
//!    semantic input records.
//!
//! Nothing here invents a handshake. The attach path is the shipped seam
//! `hmux-ssh-transport` exposes and `examples/ssh_attach.rs` demonstrates; the
//! only thing this module does differently from `attach_over_ssh` is keep the
//! transport's interrupt handle, and that difference is the reason it composes
//! the two halves itself — see [`open_terminal_surface`].
//!
//! ## What authenticates what
//!
//! sshd authenticates the *key*. The gateway then runs as the account that key
//! authorized, reads the session manifest under `path_security` locally, and
//! mints its own `Hello` with the locally-read capability token — so the
//! session's real token never crosses the network, and this process never has
//! it. What this client sends in `Hello` is [`RELAY_ATTACH_PLACEHOLDER`]: a
//! non-secret constant, because the gateway does not check it and nothing yet
//! mints the scoped, expiring grant that will eventually go there. It is named
//! for what it is so that nobody reads the field as a second factor.
//!
//! ## The private key is not hardware-backed
//!
//! [`crate::identity_store`] keeps the key as an ordinary file in app storage.
//! It is readable by anything that can read this app's container and copyable
//! by a device backup. That is stated in the UI and in the report, and it is
//! the reason `device_identity` still reports `NotProvisioned`.

use crate::catalog::{self, read_catalog, CatalogError, RemoteSession};
use crate::source_control;
use crate::standalone;
use hmux_client::transport::{
    AttachedTransport, FrameCodec, FrameReader, FrameWriter, TransportError, TransportInterrupt,
};
use hmux_client::{ClientError, LocalConnection, TerminalSurfaceAccess, TerminalSurfaceAttachment};
use hmux_host::local_protocol::FrameLimits;
use hmux_ssh_transport::{
    HostKeyPolicy, SshAuthentication, SshEndpoint, SshExecConfig, SshExecDialer, SshFrameReader,
    SshTransportError, DEFAULT_GATEWAY_COMMAND,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// What this client puts in `Hello.capability_token` over a relay.
///
/// Deliberately a visible constant rather than a user-entered field. The
/// gateway ignores it — it mints its own local `Hello` with the token it read
/// off the session's disk — and no grant format exists yet. A prompt asking
/// the user for a "session secret" would manufacture the appearance of a
/// credential check that is not happening.
pub const RELAY_ATTACH_PLACEHOLDER: &str = "relayed-placeholder";

/// The prefix every fingerprint this client accepts carries.
///
/// russh renders host keys as `SHA256:<base64>` and [`HostKeyPolicy`] compares
/// the rendered string. An MD5 fingerprint (`ab:cd:…`), a bare base64 body, or
/// an `authorized_keys` line pasted whole would all be perfectly well-formed
/// text that can never equal what the host offers — so the connection would
/// fail at handshake time with "host key not pinned", naming the host rather
/// than the typo. Refusing the shape up front is the difference.
const FINGERPRINT_PREFIX: &str = "SHA256:";

/// Where to reach a gateway, and what to accept once there.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelayTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// `SHA256:…`. There is no accept-anything mode: a relay carries the whole
    /// of a session's stream, and trusting whoever answers the address hands
    /// that stream to whoever answers the address.
    pub host_key_fingerprint: String,
}

/// Why a relay operation did not produce what was asked for.
#[derive(Debug)]
pub enum RelayError {
    /// The entry cannot describe a connection at all — refused before any
    /// packet is sent.
    Configuration { code: &'static str, detail: String },
    /// The bytes never got there: sshd refused the key, the host key was not
    /// the pinned one, the gateway is not on `PATH`.
    Ssh(SshTransportError),
    /// SSH worked, the command ran, and the command itself failed — the
    /// `hmux: command not found` case, and every other non-zero exit or
    /// stderr line from the far end. A separate variant from [`Self::Ssh`]
    /// because the fix is on the server's `PATH` or `authorized_keys`, not in
    /// its SSH configuration.
    Gateway { detail: String },
    /// The bytes got there and the *session* refused.
    Session(ClientError),
    /// The listing arrived and could not be believed.
    Catalog(CatalogError),
    /// The source-control answer arrived and could not be believed — or the
    /// box refused the question because its `hmux` is older than the reader,
    /// which is a distinct fix and carries its own variant inside.
    SourceControl(source_control::SourceControlError),
    /// The box would not start a session, or its receipt could not be believed.
    ///
    /// Its own variant because the likeliest one — a paired key the operator
    /// never widened with `--allow-create` — is fixed in that box's
    /// `authorized_keys`, which is not where any other failure here points.
    Create(standalone::CreateError),
    /// The server did not finish answering inside its budget.
    ///
    /// A separate variant from [`Self::Ssh`]'s own `Timeout`, which only covers
    /// the handshake: a box that completes the SSH handshake and then stops
    /// talking — a wedged filesystem, a swapping host, a gateway blocked on a
    /// manifest lock — produces no error at all, just a read that never
    /// returns. On a phone listing several servers at once that is the failure
    /// that matters, because one such box would otherwise hold the whole list.
    TimedOut { after: Duration },
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Configuration { detail, .. } => formatter.write_str(detail),
            Self::Gateway { detail } => write!(
                formatter,
                "hmux mobile-gateway did not run on the server: {detail}"
            ),
            Self::Ssh(error) => write!(formatter, "{error}"),
            Self::Session(error) => write!(formatter, "{error}"),
            Self::Catalog(error) => write!(formatter, "{error}"),
            Self::SourceControl(error) => write!(formatter, "{error}"),
            Self::Create(error) => write!(formatter, "{error}"),
            Self::TimedOut { after } => write!(
                formatter,
                "서버가 {}초 안에 응답을 마치지 못했습니다",
                after.as_secs()
            ),
        }
    }
}

impl std::error::Error for RelayError {}

impl RelayError {
    /// A stable code the UI branches on. The three vocabularies stay separate
    /// because they name three different fixes: edit the entry, fix the
    /// server's SSH setup, or look at the session.
    #[must_use]
    pub fn code(&self) -> &str {
        match self {
            Self::Configuration { code, .. } => code,
            Self::Gateway { .. } => "relay_gateway_failed",
            Self::Ssh(error) => error.code(),
            Self::Session(error) => error.code(),
            Self::Catalog(error) => error.code(),
            Self::SourceControl(error) => error.code(),
            Self::Create(error) => error.code(),
            Self::TimedOut { .. } => "relay_timed_out",
        }
    }
}

/// The command that opens a channel to the gateway.
///
/// **No `--list`, deliberately.** Under the `authorized_keys` line `hmux pair`
/// installs, sshd replaces this string entirely, so a `--list` here would be
/// discarded — which is precisely why asking for a listing had to stop being an
/// argv matter. The question is now [`crate::catalog::list_request`], sent on
/// the channel, and the same one document works whether or not a forced command
/// rewrote this string.
///
/// Keeping the flag here anyway would only mislead: on a key with no forced
/// command it would make the gateway answer and exit before reading the request,
/// which happens to work today and would silently become the only path that is
/// exercised.
#[must_use]
pub fn gateway_command() -> String {
    DEFAULT_GATEWAY_COMMAND.to_string()
}

/// Which host key an endpoint offers, learned by asking it.
///
/// # Why this dials with a policy that accepts nothing
///
/// A host key is a fact about the endpoint, and the only place that fact
/// exists is the endpoint. There is no "accept anything" mode here on purpose
/// — [`RelayTarget::host_key_fingerprint`] says why — so the way to read the
/// key without trusting it is to refuse it: the handshake names what it was
/// offered before it gives up ([`SshTransportError::HostKeyRejected`]), and
/// nothing beyond the handshake runs. No channel is opened, no command is
/// sent, and the key is *returned*, not stored — whoever asked decides whether
/// to trust it.
pub fn learn_host_key(
    host: &str,
    port: u16,
    username: &str,
    credential: RelayCredential,
) -> Result<String, RelayError> {
    let probe = RelayTarget {
        host: host.to_string(),
        port,
        username: username.to_string(),
        // Not a fingerprint, and not meant to be one: it is the shape
        // `ssh_config` demands, over a body no key can hash to. The dial is
        // for the refusal.
        host_key_fingerprint: format!("{FINGERPRINT_PREFIX}{UNMATCHABLE_KEY_BODY}"),
    };
    let config = ssh_config_with(&probe, credential, gateway_command())?;
    match list_sessions_within(config, DEFAULT_LIST_BUDGET) {
        Err(RelayError::Ssh(SshTransportError::HostKeyRejected { fingerprint })) => Ok(fingerprint),
        Err(error) => Err(error),
        // Unreachable unless a host key hashes to the body above, which is not
        // a base64 SHA-256 at all. Named rather than ignored: silently treating
        // it as success would pin a key nobody read.
        Ok(_) => Err(RelayError::Configuration {
            code: "relay_host_key_probe_accepted",
            detail: "호스트 키를 읽는 연결이 거부되지 않았습니다".to_string(),
        }),
    }
}

/// Appends one `authorized_keys` line on the host, over a password.
///
/// # Why a shell line and not this crate's own appender
///
/// The laptop's installer refuses to build a shell script for exactly this,
/// and it is right to: it has a file to be careful with (mode, trailing
/// newline, atomic rename) and its own tests reach that code. This has neither
/// — there is nothing of ours on the far end yet, which is the whole reason a
/// password is being used. So it runs the same line `ssh-copy-id` runs, and it
/// is idempotent: the key already being there is a success, not a second copy.
///
/// The password reaches only this call. It is not returned, not stored, and
/// the entry saved afterwards carries the key instead.
pub fn install_authorized_key(
    target: &RelayTarget,
    password: String,
    public_openssh: &str,
) -> Result<(), RelayError> {
    let line = public_openssh.trim();
    if line.is_empty() || line.contains('\n') || line.contains('\'') {
        return Err(RelayError::Configuration {
            code: "relay_public_key_unusable",
            detail: "설치할 공개 키가 한 줄이 아닙니다".to_string(),
        });
    }
    let command = format!(
        "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && \
         grep -qxF '{line}' ~/.ssh/authorized_keys || printf '%s\\n' '{line}' >> ~/.ssh/authorized_keys"
    );
    let config = ssh_config_with(target, RelayCredential::Password(password), command)?;
    // The command says nothing on success. Anything it does say is a shell
    // that could not write the file, which `run_to_end` reports as a gateway
    // failure — the same variant, because the fix is in the same place.
    run_to_end(config, DEFAULT_LIST_BUDGET)
}

/// Runs a command that answers with nothing, and reports what it said instead.
///
/// Nothing on the channel is a success here: the far end is a shell, not the
/// gateway, and its whole job is to change a file. A line on stderr or a
/// non-zero exit is the only thing worth reading back.
fn run_to_end(config: SshExecConfig, budget: Duration) -> Result<(), RelayError> {
    let started = Instant::now();
    let mut config = config;
    config.connect_timeout = config.connect_timeout.min(budget);
    let mut halves = SshExecDialer::open_halves(config).map_err(RelayError::Ssh)?;
    let watchdog = Watchdog::arm(
        halves.interrupt.clone() as Arc<dyn TransportInterrupt>,
        budget.saturating_sub(started.elapsed()),
    );
    let closing = close_reason(&mut halves.reader);
    if watchdog.fired() {
        return Err(RelayError::TimedOut { after: budget });
    }
    match closing {
        Some(detail) => Err(RelayError::Gateway { detail }),
        None => Ok(()),
    }
}

/// A fingerprint body no SHA-256 renders to — it is not even base64 of 32
/// bytes. Only [`learn_host_key`] uses it, and only to be refused.
const UNMATCHABLE_KEY_BODY: &str = "none";

/// How this phone proves who it is to a host.
///
/// A password is here for one job and one only — installing this phone's key
/// on a host that has never seen it ([`crate::install_authorized_key`]). It is
/// never stored: the app's storage is plaintext, an account password opens far
/// more than one box, and a key that *is* stored does the same job afterwards
/// without ever leaving the phone again.
pub enum RelayCredential {
    PrivateKey {
        openssh_pem: String,
        passphrase: Option<String>,
    },
    Password(String),
}

impl RelayCredential {
    fn into_authentication(self) -> SshAuthentication {
        match self {
            Self::PrivateKey {
                openssh_pem,
                passphrase,
            } => SshAuthentication::PrivateKey {
                openssh_pem,
                passphrase,
            },
            Self::Password(password) => SshAuthentication::Password(password),
        }
    }

    fn is_empty(&self) -> bool {
        match self {
            Self::PrivateKey { openssh_pem, .. } => openssh_pem.trim().is_empty(),
            Self::Password(password) => password.is_empty(),
        }
    }
}

/// Builds the SSH configuration, refusing anything malformed before dialing.
pub fn ssh_config(
    target: &RelayTarget,
    private_key_pem: String,
    passphrase: Option<String>,
    command: String,
) -> Result<SshExecConfig, RelayError> {
    ssh_config_with(
        target,
        RelayCredential::PrivateKey {
            openssh_pem: private_key_pem,
            passphrase,
        },
        command,
    )
}

/// The same, for a credential that is not a key.
pub fn ssh_config_with(
    target: &RelayTarget,
    credential: RelayCredential,
    command: String,
) -> Result<SshExecConfig, RelayError> {
    if target.host.trim().is_empty() {
        return Err(RelayError::Configuration {
            code: "relay_host_missing",
            detail: "서버 호스트가 비어 있습니다".to_string(),
        });
    }
    if target.username.trim().is_empty() {
        return Err(RelayError::Configuration {
            code: "relay_username_missing",
            detail: "서버 계정이 비어 있습니다".to_string(),
        });
    }
    let fingerprint = target.host_key_fingerprint.trim();
    if !fingerprint.starts_with(FINGERPRINT_PREFIX) || fingerprint.len() <= FINGERPRINT_PREFIX.len()
    {
        return Err(RelayError::Configuration {
            code: "relay_host_key_not_pinned",
            detail: "호스트 키 지문은 SHA256:로 시작해야 합니다".to_string(),
        });
    }
    if credential.is_empty() {
        return Err(RelayError::Configuration {
            code: "relay_identity_missing",
            detail: "이 서버에 등록된 SSH 개인키가 없습니다".to_string(),
        });
    }

    let mut config = SshExecConfig::new(
        SshEndpoint {
            host: target.host.trim().to_string(),
            port: target.port,
        },
        target.username.trim(),
        credential.into_authentication(),
        HostKeyPolicy::pinned([fingerprint.to_string()]),
    );
    config.command = command;
    // A phone changes networks mid-dial. The default is 20s; the shorter
    // budget is about the user's patience, and expiring costs nothing because
    // no frame has been admitted yet.
    config.connect_timeout = Duration::from_secs(15);
    Ok(config)
}

/// Asks a gateway for its session catalog and reads the answer.
///
/// The listing is a one-shot mode with no handshake — one request document out,
/// records back until end of stream — so the frame *reader* is used as a plain
/// byte source and the records are parsed by [`crate::catalog`]. What is not
/// skipped is the diagnosis: an exec channel that produces nothing looks
/// identical whether the gateway detached politely or `hmux` is not on the
/// remote `PATH`, and the only place that distinction survives is
/// `FrameReader::read_frame`'s end-of-stream classification. So the stream is
/// drained, and then read_frame is asked once, on a boundary, purely for the
/// reason it reports.
pub fn list_sessions(config: SshExecConfig) -> Result<catalog::CatalogListing, RelayError> {
    list_sessions_within(config, DEFAULT_LIST_BUDGET)
}

/// How long one server gets to finish a listing, handshake included.
///
/// A number chosen for a phone holding several of these open at once, not for
/// a CLI. It is longer than a healthy loopback listing by two orders of
/// magnitude and shorter than the patience of anyone looking at a spinner.
pub const DEFAULT_LIST_BUDGET: Duration = Duration::from_secs(12);

/// Asks for a catalog under a wall-clock bound.
///
/// The dial is bounded by `connect_timeout`, which is narrowed to the budget so
/// a slow handshake cannot spend more than the whole allowance. Everything
/// *after* the handshake is bounded by an interrupt: the transport's own
/// `SshInterrupt` is the same wake path `LocalConnection::shutdown` uses, and
/// it is the only thing that can move a reader already blocked inside the
/// channel. A `Read` timeout alone would not do — the read that hangs is not
/// necessarily the first one, and a server that dribbles one byte per second
/// resets a per-read budget forever.
///
/// The expiry is reported as [`RelayError::TimedOut`] rather than as whatever
/// I/O error the interrupt produced, because those two mean different things to
/// the user: one is "this box is slow or wedged", the other is "the connection
/// broke".
pub fn list_sessions_within(
    config: SshExecConfig,
    budget: Duration,
) -> Result<catalog::CatalogListing, RelayError> {
    let started = Instant::now();
    let mut config = config;
    config.connect_timeout = config.connect_timeout.min(budget);

    let mut halves = SshExecDialer::open_halves(config).map_err(RelayError::Ssh)?;
    let watchdog = Watchdog::arm(
        halves.interrupt.clone() as Arc<dyn TransportInterrupt>,
        budget.saturating_sub(started.elapsed()),
    );

    // The question, on the channel. Under a forced command this is the *only*
    // way to ask: sshd discarded whatever exec command was requested, so a
    // gateway that got no document here would sit waiting for a `Hello` until
    // the watchdog fires.
    //
    // A write failure is carried rather than returned. One shape of key still
    // answers without reading: a forced command that pins `--list` itself emits
    // its records and exits, so this write can lose the race against the channel
    // closing — and failing there would report a working server as broken. If
    // the read then produces nothing usable, this is the better explanation and
    // it is the one reported.
    let request = catalog::list_request();
    let request_failure = halves.writer.write_frame(&request).err();

    let listing = read_catalog(&mut halves.reader).map_err(RelayError::Catalog);
    let closing = close_reason(&mut halves.reader);
    // Checked before the read's own error is examined. An interrupt surfaces as
    // an ordinary I/O failure, and reporting a deliberate expiry as a broken
    // connection sends the user to look at the network.
    if watchdog.fired() {
        return Err(RelayError::TimedOut { after: budget });
    }
    let listing = match listing {
        Ok(listing) => listing,
        Err(error) => {
            // The request never reached the far end *and* nothing usable came
            // back. That is one fault, and the write is its cause; reporting the
            // read's symptom would send the user looking at the wrong end.
            return Err(match request_failure {
                Some(failure) => RelayError::Gateway {
                    detail: format!("세션 목록 요청을 보내지 못했습니다: {failure}"),
                },
                None => error,
            });
        }
    };
    match closing {
        // The gateway said something on stderr or exited non-zero. If it also
        // produced a complete listing that is a warning, not a failure — but
        // an *empty* listing plus a diagnostic is the "hmux: command not
        // found" case, and reporting it as "this server runs no sessions" is
        // the exact wrong answer.
        Some(detail) if listing.sessions.is_empty() => Err(RelayError::Gateway { detail }),
        _ => Ok(listing),
    }
}

/// How long one box gets to answer what version control says about a session.
///
/// Longer than a listing's because the box may spend its own budget inside the
/// reader — five seconds there for the two local reads, twelve for the one that
/// also asks the code host, plus the handshake and the Observer read that
/// resolves the directory. Twelve is chosen on the box so that the slowest
/// answer still finishes inside this, and the thing that gives up is the box,
/// which can say why, rather than this watchdog, which cannot.
pub const DEFAULT_SOURCE_CONTROL_BUDGET: Duration = Duration::from_secs(20);

/// Asks one box what version control says about one session.
///
/// The same shape as [`list_sessions_within`], and for the same reasons: the
/// question goes on the channel because a forced command discarded the exec
/// string, the write failure is carried rather than returned because a server
/// can answer without reading, and the watchdog is examined before the read's
/// own error so a deliberate expiry is not reported as a broken connection.
pub fn source_control_status_within(
    config: SshExecConfig,
    request_id: &str,
    session_id: &str,
    workspace_id: &str,
    want: source_control::Want,
    budget: Duration,
) -> Result<source_control::SourceControlDocument, RelayError> {
    let started = Instant::now();
    let mut config = config;
    config.connect_timeout = config.connect_timeout.min(budget);

    let mut halves = SshExecDialer::open_halves(config).map_err(RelayError::Ssh)?;
    let watchdog = Watchdog::arm(
        halves.interrupt.clone() as Arc<dyn TransportInterrupt>,
        budget.saturating_sub(started.elapsed()),
    );

    let request = source_control::request(request_id, session_id, workspace_id, want);
    let request_failure = halves.writer.write_frame(&request).err();

    let answer = source_control::read(&mut halves.reader, FrameLimits::default().max_frame_bytes);
    let closing = close_reason(&mut halves.reader);
    if watchdog.fired() {
        return Err(RelayError::TimedOut { after: budget });
    }
    match answer {
        Ok(document) => Ok(document),
        Err(error) => Err(match request_failure {
            Some(failure) => RelayError::Gateway {
                detail: format!("변경 목록 요청을 보내지 못했습니다: {failure}"),
            },
            // A box whose `hmux` predates the reader closes with a diagnostic
            // and nothing else; that sentence is the better explanation than
            // the empty read it caused.
            None => match closing {
                Some(detail)
                    if matches!(error, source_control::SourceControlError::Malformed { .. }) =>
                {
                    RelayError::Gateway { detail }
                }
                _ => RelayError::SourceControl(error),
            },
        }),
    }
}

/// How long one box gets to start a session and answer with its receipt.
///
/// Longer than a listing's: the far end spawns a Host and waits for it to
/// publish a manifest before it can describe the session. Shorter than the
/// source-control budget, which also waits on a code host.
pub const DEFAULT_CREATE_BUDGET: Duration = Duration::from_secs(20);

/// Asks one box to start a session, and reads what it started.
///
/// The same shape as [`source_control_status_within`], and for the same
/// reasons: the question goes on the channel because a forced command
/// discarded the exec string, the write failure is carried rather than
/// returned, and the watchdog is examined before the read's own error.
///
/// The box refuses this unless its `authorized_keys` line was widened with
/// `--allow-create`. That refusal is carried through with the words the box
/// used — it names the flag, and the person who can add it is the one reading.
pub fn create_session_within(
    config: SshExecConfig,
    ids: &standalone::CreateIds,
    cwd: Option<&str>,
    budget: Duration,
) -> Result<standalone::CreateReceipt, RelayError> {
    let started = Instant::now();
    let mut config = config;
    config.connect_timeout = config.connect_timeout.min(budget);

    let mut halves = SshExecDialer::open_halves(config).map_err(RelayError::Ssh)?;
    let watchdog = Watchdog::arm(
        halves.interrupt.clone() as Arc<dyn TransportInterrupt>,
        budget.saturating_sub(started.elapsed()),
    );

    let request = standalone::create_request(ids, cwd);
    let request_failure = halves.writer.write_frame(&request).err();

    let answer =
        standalone::read_created(&mut halves.reader, ids, standalone::MAX_CREATE_ANSWER_BYTES);
    let closing = close_reason(&mut halves.reader);
    if watchdog.fired() {
        return Err(RelayError::TimedOut { after: budget });
    }
    match answer {
        Ok(receipt) => Ok(receipt),
        Err(error) => Err(match request_failure {
            Some(failure) => RelayError::Gateway {
                detail: format!("세션 생성 요청을 보내지 못했습니다: {failure}"),
            },
            // A box whose `hmux` predates the create reader closes with a
            // diagnostic and nothing else; that sentence explains more than the
            // empty read it caused.
            None => match closing {
                Some(detail) if matches!(error, standalone::CreateError::Malformed { .. }) => {
                    RelayError::Gateway { detail }
                }
                _ => RelayError::Create(error),
            },
        }),
    }
}

/// Asks one box for one file's patch.
///
/// The same shape as [`source_control_status_within`] — the question goes on
/// the channel because a forced command discarded the exec string, the write
/// failure is carried rather than returned, and the watchdog is examined
/// before the read's own error.
pub fn file_diff_within(
    config: SshExecConfig,
    request_id: &str,
    session_id: &str,
    workspace_id: &str,
    path: &str,
    commit: Option<&str>,
    budget: Duration,
) -> Result<source_control::FileDiffDocument, RelayError> {
    let started = Instant::now();
    let mut config = config;
    config.connect_timeout = config.connect_timeout.min(budget);

    let mut halves = SshExecDialer::open_halves(config).map_err(RelayError::Ssh)?;
    let watchdog = Watchdog::arm(
        halves.interrupt.clone() as Arc<dyn TransportInterrupt>,
        budget.saturating_sub(started.elapsed()),
    );

    let request =
        source_control::file_diff_request(request_id, session_id, workspace_id, path, commit);
    let request_failure = halves.writer.write_frame(&request).err();

    let answer =
        source_control::read_file_diff(&mut halves.reader, FrameLimits::default().max_frame_bytes);
    let closing = close_reason(&mut halves.reader);
    if watchdog.fired() {
        return Err(RelayError::TimedOut { after: budget });
    }
    match answer {
        Ok(document) => Ok(document),
        Err(error) => Err(match request_failure {
            Some(failure) => RelayError::Gateway {
                detail: format!("패치 요청을 보내지 못했습니다: {failure}"),
            },
            None => match closing {
                Some(detail)
                    if matches!(error, source_control::SourceControlError::Malformed { .. }) =>
                {
                    RelayError::Gateway { detail }
                }
                _ => RelayError::SourceControl(error),
            },
        }),
    }
}

/// Interrupts a transport once a deadline passes, and says whether it did.
///
/// Its own thread rather than a read timeout, for the reason above. It is
/// disarmed on drop so a fast server does not leave a thread sleeping out the
/// rest of the budget: the phone lists every server at once, and a sleeping
/// thread per server per refresh is a leak with a good excuse.
pub(crate) struct Watchdog {
    /// `None` only after `disarm` has taken the handle, which `Drop` does.
    signal: Option<Arc<WatchdogSignal>>,
    joiner: Option<std::thread::JoinHandle<()>>,
    fired: Arc<AtomicBool>,
}

struct WatchdogSignal {
    finished: Mutex<bool>,
    changed: Condvar,
}

impl Watchdog {
    pub(crate) fn arm(interrupt: Arc<dyn TransportInterrupt>, budget: Duration) -> Self {
        let signal = Arc::new(WatchdogSignal {
            finished: Mutex::new(false),
            changed: Condvar::new(),
        });
        let fired = Arc::new(AtomicBool::new(false));
        let waiting = Arc::clone(&signal);
        let raised = Arc::clone(&fired);
        let joiner = std::thread::Builder::new()
            .name("dure-mobile-relay-watchdog".to_string())
            .spawn(move || {
                let mut finished = waiting.finished.lock().expect("watchdog lock");
                let mut left = budget;
                // A `Condvar` wait can return without a notification, so the
                // loop re-checks the flag *and* the remaining time. Treating
                // one wake as the deadline would cut a healthy server off.
                while !*finished && !left.is_zero() {
                    let started = Instant::now();
                    let (held, outcome) = waiting
                        .changed
                        .wait_timeout(finished, left)
                        .expect("watchdog wait");
                    finished = held;
                    if outcome.timed_out() {
                        break;
                    }
                    left = left.saturating_sub(started.elapsed());
                }
                if !*finished {
                    // Order matters: the flag is set before the interrupt, so a
                    // reader woken by it observes the expiry rather than racing
                    // the classification.
                    raised.store(true, Ordering::SeqCst);
                    interrupt.interrupt();
                }
            })
            .expect("spawn the relay watchdog thread");
        Self {
            signal: Some(signal),
            joiner: Some(joiner),
            fired,
        }
    }

    pub(crate) fn fired(&self) -> bool {
        self.fired.load(Ordering::SeqCst)
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        if let Some(signal) = self.signal.take() {
            *signal.finished.lock().expect("watchdog lock") = true;
            signal.changed.notify_all();
        }
        if let Some(joiner) = self.joiner.take() {
            // Joined, not detached. A detached thread still holds the interrupt
            // handle, and interrupting a *later* attach on the same transport
            // is precisely the stale-cancellation bug this design is meant to
            // avoid. The wait is bounded by the notify above.
            let _ = joiner.join();
        }
    }
}

/// Why the channel closed, when the far end said anything about it.
fn close_reason(reader: &mut SshFrameReader) -> Option<String> {
    let codec = FrameCodec::new(FrameLimits::default());
    match reader.read_frame(&codec) {
        Err(TransportError::Io { source, .. }) => Some(source.to_string()),
        // Anything else means the stream did not end the way the catalog
        // reader believed it did. That is already reported by the catalog
        // reader itself, so there is nothing to add.
        _ => None,
    }
}

pub struct RelayTerminalAttachment {
    pub surface: TerminalSurfaceAttachment,
    pub interrupt: Arc<dyn TransportInterrupt>,
    pub attestation: &'static str,
}

/// Opens a relayed TerminalSurface and keeps the exact interrupt handle that
/// can stop its blocked reader when the mobile screen closes.
pub fn open_terminal_surface(
    config: SshExecConfig,
    session: &RemoteSession,
    access: TerminalSurfaceAccess,
) -> Result<RelayTerminalAttachment, RelayError> {
    let config = match access {
        TerminalSurfaceAccess::ReadOnly => config,
        TerminalSurfaceAccess::Writer => config.with_controller_gateway(),
    };
    let halves = SshExecDialer::open_halves(config).map_err(RelayError::Ssh)?;
    let interrupt = Arc::clone(&halves.interrupt) as Arc<dyn TransportInterrupt>;
    let transport = AttachedTransport::relayed(
        Box::new(halves.reader),
        Box::new(halves.writer),
        halves.interrupt,
    );
    open_relayed_terminal_surface(transport, interrupt, session, access)
}

pub fn open_relayed_terminal_surface(
    transport: AttachedTransport,
    interrupt: Arc<dyn TransportInterrupt>,
    session: &RemoteSession,
    access: TerminalSurfaceAccess,
) -> Result<RelayTerminalAttachment, RelayError> {
    let fence = session.fence().map_err(RelayError::Catalog)?;
    let attestation = hmux_ssh_transport::describe_attestation(transport.attestation());
    let connection = LocalConnection::attach_over_transport(
        transport,
        fence,
        RELAY_ATTACH_PLACEHOLDER.to_string(),
        TerminalSurfaceAttachment::connection_options(access, None),
    )
    .map_err(RelayError::Session)?;
    let surface =
        TerminalSurfaceAttachment::from_connection(connection).map_err(RelayError::Session)?;
    Ok(RelayTerminalAttachment {
        surface,
        interrupt,
        attestation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> RelayTarget {
        RelayTarget {
            host: "box.example".to_string(),
            port: 22,
            username: "kattpish".to_string(),
            host_key_fingerprint: "SHA256:AAAABBBBCCCC".to_string(),
        }
    }

    const KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n";

    #[test]
    fn a_well_formed_target_produces_a_config_carrying_the_pinned_fingerprint() {
        let config = ssh_config(&target(), KEY.to_string(), None, gateway_command())
            .expect("a complete target must configure");

        assert_eq!(config.endpoint.host, "box.example");
        assert_eq!(config.user, "kattpish");
        assert_eq!(
            config.host_key,
            HostKeyPolicy::pinned(["SHA256:AAAABBBBCCCC".to_string()])
        );
        // No `--list`. A forced command replaces this string outright, so a flag
        // here reaches nothing on the key `hmux pair` installs; the question is
        // `catalog::list_request`, sent on the channel. Asserted rather than
        // left to the doc comment because re-adding the flag would look like a
        // harmless restoration and would quietly make the argv path the only
        // one the tests ever exercise.
        // The shared constant, not a copy of its text. The client's string and
        // the forced command `hmux pair` installs have to be the same one: a
        // host that authenticates some other way — Tailscale SSH serves the
        // session itself and never opens `authorized_keys` — runs *this*
        // string, and a relative `hmux` is not on a non-interactive PATH. A
        // literal here would let the two drift and stay green, because every
        // plain-sshd host discards this value before it can matter.
        assert_eq!(config.command, DEFAULT_GATEWAY_COMMAND);
        assert!(!config.command.contains("--list"));
        assert!(
            config.command.starts_with('"'),
            "the program must be an absolute, quoted path so it resolves without \
             PATH on a host that skips the forced command: {}",
            config.command
        );
    }

    #[test]
    fn the_listing_request_is_a_framed_versioned_document() {
        // The one thing a forced command cannot take away from this client. Its
        // bytes are asserted here rather than round-tripped through a
        // deserializer of ours, because the reader is a different codebase and
        // the wire shape is the contract between them.
        let request = crate::catalog::list_request();
        let (prefix, payload) = request.split_at(4);
        assert_eq!(
            u32::from_be_bytes(prefix.try_into().unwrap()) as usize,
            payload.len(),
            "the gateway reads a length prefix before it knows what the document is"
        );
        assert_eq!(
            std::str::from_utf8(payload).unwrap(),
            r#"{"gateway_request_version":4,"request":"list_sessions"}"#
        );
    }

    /// The failure this prevents is a *late* one. A bare base64 body is
    /// well-formed text that simply never equals `SHA256:…`, so without this
    /// check the user sees "the host key was not pinned" and goes looking at
    /// the server.
    #[test]
    fn a_fingerprint_without_the_sha256_prefix_is_refused_before_dialing() {
        let mut candidate = target();
        candidate.host_key_fingerprint = "AAAABBBBCCCC".to_string();

        let error = ssh_config(&candidate, KEY.to_string(), None, gateway_command())
            .expect_err("an unprefixed fingerprint must be refused");

        assert_eq!(error.code(), "relay_host_key_not_pinned");
    }

    #[test]
    fn a_bare_prefix_with_no_body_is_refused() {
        let mut candidate = target();
        candidate.host_key_fingerprint = "SHA256:".to_string();

        let error = ssh_config(&candidate, KEY.to_string(), None, gateway_command())
            .expect_err("an empty fingerprint body must be refused");

        assert_eq!(error.code(), "relay_host_key_not_pinned");
    }

    #[test]
    fn a_server_with_no_stored_key_is_refused_before_dialing() {
        let error = ssh_config(&target(), "   \n".to_string(), None, gateway_command())
            .expect_err("no identity means no connection");

        assert_eq!(error.code(), "relay_identity_missing");
    }

    /// Stands in for `SshInterrupt`, which cannot be constructed outside its
    /// own crate — it names a live SSH session. The watchdog only ever needs
    /// the trait.
    #[derive(Default)]
    struct RecordingInterrupt {
        interrupted: AtomicBool,
    }

    impl TransportInterrupt for RecordingInterrupt {
        fn interrupt(&self) {
            self.interrupted.store(true, Ordering::SeqCst);
        }
    }

    fn handle(interrupt: &Arc<RecordingInterrupt>) -> Arc<dyn TransportInterrupt> {
        Arc::clone(interrupt) as Arc<dyn TransportInterrupt>
    }

    /// The failure this exists to stop: a box that finishes the SSH handshake
    /// and then says nothing produces no error at all, so without the
    /// interrupt the reader blocks for the life of the process — and on a
    /// phone, for the life of the whole session list.
    #[test]
    fn a_transport_that_never_answers_is_interrupted_when_the_budget_expires() {
        let interrupt = Arc::new(RecordingInterrupt::default());
        let watchdog = Watchdog::arm(handle(&interrupt), Duration::from_millis(30));

        for _ in 0..200 {
            if watchdog.fired() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        assert!(watchdog.fired(), "the watchdog never expired");
        assert!(interrupt.interrupted.load(Ordering::SeqCst));
    }

    /// A server that answers quickly must not be cut off, and must not leave a
    /// thread holding an interrupt handle behind it.
    #[test]
    fn a_transport_that_answers_in_time_is_left_alone() {
        let interrupt = Arc::new(RecordingInterrupt::default());
        let watchdog = Watchdog::arm(handle(&interrupt), Duration::from_secs(30));

        drop(watchdog);

        assert!(
            !interrupt.interrupted.load(Ordering::SeqCst),
            "a completed listing was interrupted anyway"
        );
    }

    /// Dropping the watchdog joins its thread. If it did not, the handle could
    /// outlive this scope and interrupt a *later* attach on the same
    /// transport — a stale cancellation, which is worse than no cancellation
    /// because it looks like the far end hung up.
    #[test]
    fn dropping_the_watchdog_retires_its_thread_before_returning() {
        let interrupt = Arc::new(RecordingInterrupt::default());

        {
            let _watchdog = Watchdog::arm(handle(&interrupt), Duration::from_millis(20));
        }

        // The only other strong reference was the watchdog thread's. If the
        // drop returned before that thread retired, this count is 2.
        assert_eq!(Arc::strong_count(&interrupt), 1);
    }

    /// A budget already spent by the handshake must not be rounded up into a
    /// fresh full allowance for the read.
    #[test]
    fn a_zero_budget_expires_immediately_rather_than_waiting_forever() {
        let interrupt = Arc::new(RecordingInterrupt::default());
        let watchdog = Watchdog::arm(handle(&interrupt), Duration::ZERO);

        for _ in 0..200 {
            if watchdog.fired() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        assert!(watchdog.fired());
    }
}
