//! `hmux pair` — the laptop half of phone pairing.
//!
//! # What this is for
//!
//! Agents die when the laptop closes. The point of pairing is that the laptop
//! is in the path exactly once — while the owner is standing at the desk with
//! the phone — and never again:
//!
//! ```text
//! [once, at the desk]   phone --QR--> laptop
//!                       laptop appends the phone's PUBLIC key to
//!                       authorized_keys on every server it has credentials
//!                       for, forced-command and restricted, then hands the
//!                       phone the inventory
//! [forever after]       phone --ssh--> server A    (laptop: off)
//!                       phone --ssh--> server B
//! ```
//!
//! Nothing here installs a relay, a broker, or a rendezvous service. If a
//! design leaves the laptop on the steady-state path it is the wrong design;
//! the only artefact this leaves behind is a line in each server's
//! `authorized_keys` and a local record of which device it belongs to.
//!
//! The project owner authorised this explicitly, by name, after being shown
//! what it means: the laptop may append the paired phone's public key to
//! `authorized_keys` on every SSH host the desktop app has configured, as a
//! forced command. That is the mechanism that makes "the laptop can be closed"
//! possible at all.
//!
//! # The three secrets, kept apart
//!
//! 1. **The phone's public key.** Distributed. Its private half never leaves
//!    the phone; a request carrying private key material is refused outright
//!    ([`entry::refuse_private_key_material`]).
//! 2. **The Host's `capability_token`.** Never appears in this module, and must
//!    never reach the phone. It is read locally by `hmux mobile-gateway` on the
//!    session-owning box and never crosses a network — which is precisely why
//!    the forced command runs a first-class client there rather than a pump.
//! 3. **The pairing token.** Single-use, short-lived, carried in the QR, and
//!    never transmitted: possession is proven by HMAC ([`token`]).
//!
//! # Order of operations, and why
//!
//! Private-key refusal → parse → token proof → *persist the revocation record*
//! → install. The token is proven before anything is installed anywhere, and
//! the record of what is about to be written is durable before the first
//! destructive edit, so a crash mid-fleet leaves every possibly-touched server
//! nameable by `hmux pair revoke` rather than holding an unrevocable key.

pub(crate) mod authorized_keys;
mod connection;
pub(crate) mod devices;
pub(crate) mod entry;
pub(crate) mod host_key;
pub(crate) mod installer;
pub(crate) mod inventory;
// The no-network variant. Its own module because it shares the installer and
// the registry with `start` but none of its listener.
pub(crate) mod offline;
pub(crate) mod qr;
pub(crate) mod system_ssh;
pub(crate) mod token;

use crate::CliError;
use base64::Engine as _;
use devices::{DeviceRegistry, DeviceRegistryLease, PairedDevice, PairedHostRecord};
use entry::{AuthorizedKeyEntry, PhonePublicKey};
use hmux_client::online_pairing::{
    HostAnswer, MAX_REQUEST_BYTES, MIN_NONCE_BYTES, PAIRING_DEADLINE_ELAPSED,
    PAIRING_EXCHANGE_BUDGET, PAIRING_PROTOCOL_VERSION, PairedAnswer, PairingRequest,
    PairingResponse, RequestTranscript, ResponseTranscriptV1, ResponseTranscriptV2,
    pairing_time_remaining,
};
use installer::{ApplyRequest, AuthorizedKeyInstaller, SshExecInstaller};
use inventory::{HostTarget, InventoryHost, SshInvocation};
use std::error::Error;
use std::io::Read as _;
use std::net::{IpAddr, SocketAddr, TcpListener, UdpSocket};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use token::{PairingSession, PairingToken, RedeemRefusal};

macro_rules! cli_println {
    ($($argument:tt)*) => {
        crate::output::writeln(format_args!($($argument)*))
    };
}

pub(crate) type CommandResult = Result<(), Box<dyn Error>>;

/// How long an unattended listening socket may block a connected phone.
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);
/// How often the accept loop wakes to re-check the expiry.
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// A local sshd should offer its host key well before this expires.
const HOST_KEY_OBSERVATION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, clap::Args)]
pub(crate) struct PairStartArgs {
    /// LAN address to advertise. Defaults to this machine's routable address.
    #[arg(long, value_name = "ADDRESS")]
    pub(crate) address: Option<String>,

    /// Port to listen on. 0 asks the OS for a free one.
    #[arg(long, default_value_t = 0)]
    pub(crate) port: u16,

    /// How long the QR stays valid.
    #[arg(long, default_value_t = 120, value_parser = clap::value_parser!(u64).range(15..=600))]
    pub(crate) ttl_seconds: u64,

    /// Expected SSH host key; supplies legacy QR metadata with --remote-only.
    #[arg(long, value_name = "PATH")]
    pub(crate) host_key: Option<PathBuf>,

    /// The port this laptop's own sshd listens on.
    ///
    /// Reported to the phone as this laptop's coordinates. A wrong value here
    /// is a server the phone believes it can reach and cannot, which is the
    /// same class of lie as omitting a failed host.
    #[arg(long, default_value_t = 22)]
    pub(crate) laptop_ssh_port: u16,

    /// Forced command written into every authorized_keys entry.
    #[arg(long, value_name = "COMMAND", default_value = entry::DEFAULT_FORCED_COMMAND)]
    pub(crate) forced_command: String,

    /// Let the paired phone type, not only watch — and start sessions.
    ///
    /// Carries `--allow-create` with it (owner, 2026-09-04): a phone that may
    /// type is a phone that drives that box, and one that may type but not
    /// start still cannot begin anything while the laptop sleeps. The narrow
    /// middle is still reachable through `--forced-command`.
    ///
    /// Off by default, and that default is the interesting part. Observer
    /// authority is recoverable from the desk: whatever the phone does, the
    /// owner still owns the keyboard. Controller authority is a *lease*, and
    /// the Host grants exactly one with no way to take it back — so a phone
    /// holding it is a terminal the owner cannot type into until the phone
    /// gives it up. `mobile-gateway` bounds that by releasing the lease after
    /// the relayed client goes silent, which turns "until the phone gives it
    /// up" into a known number of minutes rather than a promise about iOS.
    ///
    /// Refuses to combine with `--forced-command`: the writable line is one
    /// exact string that `hmux-client` owns, and hand-writing a near-miss is
    /// the drift `gateway_invocation` exists to prevent.
    ///
    /// What enforces this ceiling is sshd, not us: the pinned line wins because
    /// sshd discards whatever the client asked to run. On a host that serves
    /// the session itself and never reads `authorized_keys` — Tailscale SSH is
    /// the case this repository has already hit — the client's own string runs
    /// and this flag decides nothing. Narrowing there is an sshd-side job.
    #[arg(long, conflicts_with = "forced_command")]
    pub(crate) writable: bool,

    /// Let the paired phone **start** a session on each server, not only reach
    /// the ones already running.
    ///
    /// Implied by `--writable`, which is the flag to reach for: a phone that
    /// may type is a phone that drives that box, and one that may type but not
    /// start cannot begin anything while the laptop sleeps. On its own this
    /// flag gives a phone that can start a session it may only watch, which is
    /// rarely what anybody wants.
    ///
    /// Off by default for the same reason `--writable` is: starting a process
    /// is a larger authority than reaching one, and a lost phone would carry it
    /// to every server this pairing touched. On is the answer for somebody who
    /// wants to begin work from the phone while the laptop is asleep — the
    /// laptop being awake is an availability property, not a security one.
    ///
    /// One flag for the whole pairing: this run writes the line on every
    /// configured server, so the choice is made once rather than per box. It is
    /// still revocable in one action with `hmux pair revoke`.
    ///
    /// Refuses to combine with `--forced-command` for the same reason
    /// `--writable` does — the line is one exact string `hmux-client` owns.
    #[arg(long, conflicts_with = "forced_command")]
    pub(crate) allow_create: bool,

    /// File this pairing under an identity the caller already minted.
    ///
    /// A hand-run `hmux pair` answers to nobody and mints a fresh uuid. The
    /// desktop app does not: the same click that shows the QR also registers
    /// the phone with this laptop's hub, and that registration has an id of its
    /// own. With two ids for one act of pairing, removing the device in the app
    /// drops the hub token and leaves the forced-command key installed on every
    /// server — permanently, because nothing left on the laptop names it. One
    /// id for one phone is what makes a single Remove revoke both.
    #[arg(long, value_name = "ID")]
    pub(crate) device_id: Option<String>,

    /// The hmux to invoke on each remote server.
    #[arg(long, value_name = "COMMAND", default_value = installer::DEFAULT_REMOTE_HMUX)]
    pub(crate) remote_hmux: String,

    /// The desktop app's exported host inventory.
    #[arg(long, value_name = "PATH")]
    pub(crate) inventory: Option<PathBuf>,

    /// Pair only configured remote hosts; the caller provides local access separately.
    #[arg(long)]
    pub(crate) remote_only: bool,

    /// Also print the QR payload as text.
    ///
    /// Off by default: the payload carries the pairing token, and a token in
    /// stdout is a token in a scrollback buffer, a pipe, and whatever log
    /// captured it. On screen inside a QR it is gone when the terminal clears.
    #[arg(long)]
    pub(crate) print_payload: bool,
}

#[derive(Debug, clap::Args)]
pub(crate) struct PairRevokeArgs {
    /// Device id, unique id prefix, or exact device name.
    pub(crate) device: String,

    /// Remove the record even if some hosts could not be reached.
    ///
    /// Off by default: dropping the record while a server still holds the key
    /// turns a recoverable failure into a key nobody can find again.
    #[arg(long)]
    pub(crate) forget_unreachable: bool,

    /// The desktop app's current host inventory.
    ///
    /// Revocation still uses the recorded endpoint and host-key pin. When the
    /// same host row still names that exact endpoint, its current credential
    /// replaces a stale recorded key path.
    #[arg(long, value_name = "PATH")]
    pub(crate) inventory: Option<PathBuf>,

    /// The hmux to invoke on each remote server.
    #[arg(long, value_name = "COMMAND", default_value = installer::DEFAULT_REMOTE_HMUX)]
    pub(crate) remote_hmux: String,
}

/// Runs a pairing window: render the QR, accept one proven request, stop.
pub(crate) fn start(args: PairStartArgs, json: bool) -> CommandResult {
    let home = dirs::home_dir().ok_or_else(|| {
        CliError("pairing could not resolve this account's home directory".into())
    })?;
    let inventory_path = match args.inventory {
        Some(path) => path,
        None => inventory::default_inventory_path()?,
    };
    let configured = inventory::load_configured_hosts(&inventory_path)?;
    let registry_path = DeviceRegistry::default_path()?;
    let assigned_device_id = match args.device_id.as_deref() {
        Some(raw) => {
            let id = parse_assigned_device_id(raw)?;
            // Refused before the QR is drawn, not after the phone arrives: two
            // devices filed under one id make `hmux pair revoke` ambiguous, and
            // by the time the second pairing completes its key is already on
            // every server. The caller can pick another id while nothing has
            // been installed.
            if DeviceRegistry::load(registry_path.clone())?
                .devices()
                .iter()
                .any(|device| device.device_id == id)
            {
                return Err(CliError(format!(
                    "a device is already paired under {id}; revoke it first or pair under \
                     another id"
                ))
                .into());
            }
            Some(id.to_string())
        }
        None => None,
    };

    let listener =
        TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], args.port))).map_err(|error| {
            CliError(format!(
                "pairing could not listen on port {}: {error}",
                args.port
            ))
        })?;
    let port = listener
        .local_addr()
        .map_err(|error| CliError(format!("pairing could not read its own port: {error}")))?
        .port();
    let address = match args.address {
        Some(address) => address,
        None => lan_address().ok_or_else(|| {
            CliError(
                "pairing could not determine this machine's LAN address; pass --address with the \
                 address the phone should reach"
                    .into(),
            )
        })?,
    };
    let fingerprint = if args.remote_only {
        host_key::remote_only_qr_metadata(args.host_key.as_deref()).map_err(CliError)?
    } else {
        host_key::observe_sshd(
            &address,
            args.laptop_ssh_port,
            args.host_key.as_deref(),
            HOST_KEY_OBSERVATION_TIMEOUT,
        )
        .map_err(CliError)?
    };

    let mut hosts = configured;
    if !args.remote_only {
        hosts.insert(
            0,
            inventory::this_laptop(&address, args.laptop_ssh_port, local_user()),
        );
    }

    let now = SystemTime::now();
    let mut session = PairingSession::new(
        PairingToken::generate(),
        now,
        Duration::from_secs(args.ttl_seconds),
    );
    let payload = qr::PairingPayload {
        address: address.clone(),
        port,
        token: session.token().encoded(),
        host_key_algorithm: fingerprint.algorithm.clone(),
        host_key_fingerprint_compact: fingerprint.compact.clone(),
        expires_at_unix_ms: unix_millis(session.expires_at()),
    }
    .encode();

    cli_println!("{}", qr::render(&payload).map_err(CliError)?)?;
    cli_println!(
        "Scan this QR with your phone — valid once, for {} seconds.\n\
         Address: {address}:{port}\n\
         Host key: {} {}\n\
         Servers: {}",
        args.ttl_seconds,
        fingerprint.algorithm,
        fingerprint.display,
        hosts.len()
    )?;
    if args.print_payload {
        cli_println!("payload: {payload}")?;
    }
    crate::output::flush()?;

    let this_laptop_pin = (!args.remote_only).then_some(fingerprint.display);
    let installer = SshExecInstaller::new(home, args.remote_hmux, this_laptop_pin);

    let forced_command =
        pairing_forced_command(args.writable, args.allow_create, &args.forced_command);
    let terms = PairingTerms {
        forced_command: &forced_command,
        device_id: assigned_device_id.as_deref(),
    };

    match serve(
        &listener,
        &mut session,
        &hosts,
        terms,
        &installer,
        &registry_path,
    )? {
        Some(answer) => {
            report_answer(&answer, json)?;
            Ok(())
        }
        None => Err(CliError(
            "pairing window closed with no device paired — the QR expired or was refused too many \
             times; run `hmux pair start` again"
                .into(),
        )
        .into()),
    }
}

/// What one pairing writes, and whose name it writes it under.
///
/// The two travel together because they end up in the same string: the forced
/// command is what sshd runs, and the device id is the comment that says whose
/// key it is. Passing them as one value keeps the accept path from growing a
/// parameter per policy question.
#[derive(Clone, Copy)]
pub(crate) struct PairingTerms<'a> {
    pub(crate) forced_command: &'a str,
    /// An identity minted elsewhere, already parsed by
    /// [`parse_assigned_device_id`]. `None` mints a fresh uuid — the hand-run
    /// case, where nothing else in the system needs to name this pairing.
    pub(crate) device_id: Option<&'a str>,
}

/// Accepts connections until one redeems the token, then returns.
///
/// A refused request does not close the window: a stranger who sends one junk
/// packet must not be able to deny the owner the QR they are looking at. A
/// *successful* one closes it immediately — that is the single-use property,
/// and it is observable from outside as the port ceasing to accept.
fn serve<I: AuthorizedKeyInstaller>(
    listener: &TcpListener,
    session: &mut PairingSession,
    hosts: &[InventoryHost],
    terms: PairingTerms<'_>,
    installer: &I,
    registry_path: &Path,
) -> Result<Option<PairedAnswer>, CliError> {
    listener
        .set_nonblocking(true)
        .map_err(|error| CliError(format!("pairing could not configure its socket: {error}")))?;
    loop {
        let now = SystemTime::now();
        if now >= session.expires_at() || session.is_spent() {
            return Ok(None);
        }
        match listener.accept() {
            Ok((stream, peer)) => {
                match connection::handle_connection(
                    stream,
                    session,
                    hosts,
                    terms,
                    installer,
                    registry_path,
                    Instant::now() + PAIRING_EXCHANGE_BUDGET,
                ) {
                    Ok(Some(answer)) => return Ok(Some(answer)),
                    Ok(None) => {}
                    Err(error) => {
                        // Named on stderr rather than swallowed: the owner is
                        // watching this screen, and "someone on the network
                        // tried and was refused" is information they want.
                        eprintln!("hmux pair: refused a request from {peer}: {error}");
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL_INTERVAL);
            }
            Err(error) => {
                return Err(CliError(format!(
                    "pairing could not accept a connection: {error}"
                )));
            }
        }
    }
}

/// The whole decision, isolated from sockets so it can be driven directly.
#[cfg(test)]
pub(crate) fn handle_request<I: AuthorizedKeyInstaller>(
    session: &mut PairingSession,
    hosts: &[InventoryHost],
    terms: PairingTerms<'_>,
    installer: &I,
    registry: &mut DeviceRegistryLease,
    raw: &[u8],
    now: SystemTime,
) -> PairingResponse {
    match verify_request(session, raw, now, Instant::now() + PAIRING_EXCHANGE_BUDGET) {
        Ok(verified) => {
            complete_after_lease(session, hosts, terms, installer, registry, verified, now)
        }
        Err(response) => response,
    }
}

struct VerifiedPairingRequest {
    device_name: String,
    nonce: Vec<u8>,
    key: PhonePublicKey,
    accepted_at: SystemTime,
    deadline: Instant,
}

fn verify_request(
    session: &mut PairingSession,
    raw: &[u8],
    now: SystemTime,
    deadline: Instant,
) -> Result<VerifiedPairingRequest, PairingResponse> {
    // First, before any parsing: a private key must not reach a parser, a log
    // line, or the device registry, no matter which field it arrived in.
    if let Err(refusal) = entry::refuse_private_key_material(raw) {
        return Err(PairingResponse::refused(refusal.reason(), refusal.detail()));
    }
    let request: PairingRequest = match serde_json::from_slice(raw) {
        Ok(request) => request,
        Err(error) => {
            return Err(PairingResponse::refused(
                "malformed_request",
                format!("could not parse the pairing request: {error}"),
            ));
        }
    };
    if request.version != PAIRING_PROTOCOL_VERSION {
        return Err(PairingResponse::refused(
            "unsupported_protocol_version",
            format!("this hmux speaks pairing version {PAIRING_PROTOCOL_VERSION}"),
        ));
    }
    let nonce = match base64::engine::general_purpose::STANDARD.decode(&request.nonce) {
        Ok(nonce) if nonce.len() >= MIN_NONCE_BYTES => nonce,
        Ok(_) => {
            return Err(PairingResponse::refused(
                "malformed_request",
                format!("the nonce must be at least {MIN_NONCE_BYTES} bytes"),
            ));
        }
        Err(error) => {
            return Err(PairingResponse::refused(
                "malformed_request",
                format!("the nonce was not base64: {error}"),
            ));
        }
    };
    let proof = match base64::engine::general_purpose::STANDARD.decode(&request.proof) {
        Ok(proof) => proof,
        Err(error) => {
            return Err(PairingResponse::refused(
                "malformed_request",
                format!("the proof was not base64: {error}"),
            ));
        }
    };
    let key = match PhonePublicKey::parse(&request.public_key) {
        Ok(key) => key,
        Err(refusal) => {
            return Err(PairingResponse::refused(refusal.reason(), refusal.detail()));
        }
    };

    // Nothing above this line touched a server. Nothing below it happens
    // without a proof of the token.
    let transcript = RequestTranscript::new(
        request.version,
        &request.device_name,
        &request.public_key,
        &nonce,
    );
    if let Err(refusal) = session.redeem(&transcript, &proof, now) {
        return Err(PairingResponse::refused(
            refusal.reason(),
            redeem_detail(&refusal),
        ));
    }

    Ok(VerifiedPairingRequest {
        device_name: request.device_name,
        nonce,
        key,
        accepted_at: now,
        deadline,
    })
}

fn complete_after_lease<I: AuthorizedKeyInstaller>(
    session: &PairingSession,
    hosts: &[InventoryHost],
    terms: PairingTerms<'_>,
    installer: &I,
    registry: &mut DeviceRegistryLease,
    verified: VerifiedPairingRequest,
    now: SystemTime,
) -> PairingResponse {
    if now >= session.expires_at() {
        return PairingResponse::refused(
            "pairing_token_expired",
            "this pairing QR expired while waiting to begin; show a new one",
        );
    }
    if pairing_time_remaining(verified.deadline).is_err() {
        return PairingResponse::refused(
            PAIRING_DEADLINE_ELAPSED,
            "the pairing exchange expired before installation; nothing was installed",
        );
    }
    complete_pairing(session, hosts, terms, installer, registry, verified)
}

fn complete_pairing<I: AuthorizedKeyInstaller>(
    session: &PairingSession,
    hosts: &[InventoryHost],
    terms: PairingTerms<'_>,
    installer: &I,
    registry: &mut DeviceRegistryLease,
    verified: VerifiedPairingRequest,
) -> PairingResponse {
    let VerifiedPairingRequest {
        device_name,
        nonce,
        key,
        accepted_at,
        deadline,
    } = verified;

    // The caller's id when there is one: the desktop app has already minted an
    // identity for this phone and must be able to revoke this key by it.
    let device_id = terms
        .device_id
        .map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_string);
    // Under the lease, because this is the check that has to be true. `persist`
    // replaces a record with the same id, so a collision would drop the exact
    // `authorized_keys` line of the key already installed on the fleet — the
    // unrevocable key this whole ordering exists to prevent. `start` refuses an
    // assigned id it can already see, but that read happens before the QR and
    // another pairing can file the id while the phone is still walking over.
    if terms.device_id.is_some()
        && registry
            .devices()
            .iter()
            .any(|existing| existing.device_id == device_id)
    {
        return PairingResponse::refused(
            "pairing_identity_taken",
            "a device is already paired under this id; pairing over it would forget the key \
             already installed",
        );
    }
    let key_entry = match AuthorizedKeyEntry::build(&key, terms.forced_command, &device_id) {
        Ok(built) => built,
        Err(refusal) => {
            return PairingResponse::refused(refusal.reason(), refusal.detail());
        }
    };

    // The revocation record is durable *before* the first destructive edit.
    // If this process dies partway through the fleet, every server that might
    // now hold the key is already named, so `hmux pair revoke` can reach it.
    // Installing first and recording second would produce exactly the
    // unrevocable key this feature exists to avoid.
    let mut device = PairedDevice {
        device_id: device_id.clone(),
        device_name,
        fingerprint: key.fingerprint().to_string(),
        authorized_keys_entry: key_entry.line().to_string(),
        paired_at_unix_ms: unix_millis(accepted_at),
        hosts: hosts.iter().map(pending_record).collect(),
    };
    if let Err(error) = registry.persist(&device) {
        return registry_unwritable_response(&error);
    }

    let mut answers = Vec::with_capacity(hosts.len());
    for (index, host) in hosts.iter().enumerate() {
        let outcome = install_host(
            registry,
            &mut device,
            index,
            host,
            key_entry.line(),
            installer,
            Some(deadline),
        );
        let (installed, failure) = match outcome {
            HostInstallResult::Installed => (true, None),
            HostInstallResult::Failed(error) => (false, Some(error)),
        };
        let fingerprint = device.hosts[index].host_key_fingerprint.clone();
        answers.push(HostAnswer {
            id: host.id.clone(),
            name: host.name.clone(),
            host: host.host.clone(),
            port: host.port,
            user: host.user.clone(),
            installed,
            failure,
            host_key_fingerprint: fingerprint,
        });
    }

    if pairing_time_remaining(deadline).is_err() {
        return PairingResponse::refused(
            PAIRING_DEADLINE_ELAPSED,
            format!(
                "pairing timed out; partial installations remain recorded under {device_id}; \
                 inspect them with `hmux pair list` or remove them with `hmux pair revoke {device_id}`"
            ),
        );
    }
    let response_transcript_v1 = ResponseTranscriptV1::new(&nonce, &device_id, &answers);
    let response_transcript_v2 =
        ResponseTranscriptV2::new(PAIRING_PROTOCOL_VERSION, &nonce, &device_id, &answers);
    let answer = PairedAnswer {
        version: PAIRING_PROTOCOL_VERSION,
        device_id,
        proof: base64::engine::general_purpose::STANDARD
            .encode(session.token().response_proof_v1(&response_transcript_v1)),
        proof_v2: Some(
            base64::engine::general_purpose::STANDARD
                .encode(session.token().response_proof_v2(&response_transcript_v2)),
        ),
        hosts: answers,
    };
    PairingResponse::Paired(answer)
}

fn registry_unwritable_response(error: &CliError) -> PairingResponse {
    PairingResponse::refused(
        "revocation_record_unwritable",
        format!(
            "nothing was installed: pairing refuses to distribute a key it could not record for \
             revocation ({})",
            error.0
        ),
    )
}

enum HostInstallResult {
    Installed,
    Failed(String),
}

fn install_host<I: AuthorizedKeyInstaller>(
    registry: &mut DeviceRegistryLease,
    device: &mut PairedDevice,
    host_index: usize,
    host: &InventoryHost,
    entry: &str,
    installer: &I,
    deadline: Option<Instant>,
) -> HostInstallResult {
    let mut record_identity = |fingerprint: &str| {
        device.hosts[host_index].host_key_fingerprint = Some(fingerprint.to_owned());
        registry.persist(device).map_err(|error| {
            format!(
                "refusing to mutate {} because its observed SSH identity could not be recorded: {}",
                host.name, error.0
            )
        })?;
        if let Some(deadline) = deadline {
            pairing_time_remaining(deadline).map_err(str::to_owned)?;
        }
        Ok(())
    };
    let installation = deadline
        .map(pairing_time_remaining)
        .transpose()
        .map_err(str::to_owned)
        .and_then(|_| installer.install(host, entry, deadline, &mut record_identity));
    let result = match installation {
        Ok(true) => HostInstallResult::Installed,
        Ok(_) => HostInstallResult::Failed(format!(
            "{} did not confirm that the pairing key is installed",
            host.name
        )),
        Err(error) => HostInstallResult::Failed(error),
    };
    let record = &mut device.hosts[host_index];
    record.installed = matches!(result, HostInstallResult::Installed);
    record.failure = match &result {
        HostInstallResult::Installed => None,
        HostInstallResult::Failed(error) => Some(error.clone()),
    };
    if let Err(error) = registry.persist(device) {
        // The pre-mutation record already contains the endpoint pin and exact
        // key line, so revoke stays possible when this outcome projection lags.
        eprintln!(
            "hmux pair: WARNING — {} finished but its outcome record could not be updated: {}",
            host.name, error.0
        );
    }
    result
}

fn redeem_detail(refusal: &RedeemRefusal) -> &'static str {
    match refusal {
        RedeemRefusal::AlreadyUsed => "this pairing QR was already used; show a new one",
        RedeemRefusal::Expired => "this pairing QR expired; show a new one",
        RedeemRefusal::TooManyAttempts => "too many rejected attempts; show a new QR",
        RedeemRefusal::BadProof => "the request did not prove it holds the pairing token",
    }
}

fn pending_record(host: &InventoryHost) -> PairedHostRecord {
    let ssh_config_alias = match &host.target {
        HostTarget::Remote(SshInvocation::ConfigAlias(alias)) => Some(alias.clone()),
        HostTarget::ThisLaptop | HostTarget::Remote(SshInvocation::Explicit) => None,
    };
    PairedHostRecord {
        id: host.id.clone(),
        name: host.name.clone(),
        host: host.host.clone(),
        port: host.port,
        user: host.user.clone(),
        auth: host.auth.clone(),
        key_path: host.key_path.clone(),
        ssh_config_alias,
        host_key_fingerprint: None,
        this_laptop: matches!(&host.target, HostTarget::ThisLaptop),
        installed: false,
        failure: Some("pairing was interrupted before this host was attempted".into()),
    }
}

fn report_answer(answer: &PairedAnswer, json: bool) -> CommandResult {
    if json {
        let encoded =
            serde_json::to_string_pretty(answer).map_err(|error| CliError(error.to_string()))?;
        cli_println!("{encoded}")?;
        return Ok(());
    }
    cli_println!("Paired: {}", answer.device_id)?;
    for host in &answer.hosts {
        match &host.failure {
            None => cli_println!(
                "  Installed  {} ({}@{}:{})",
                host.name,
                host.user,
                host.host,
                host.port
            )?,
            Some(failure) => cli_println!(
                "  FAILED     {} ({}@{}:{}) — {failure}",
                host.name,
                host.user,
                host.host,
                host.port
            )?,
        }
    }
    let failed = answer.hosts.iter().filter(|host| !host.installed).count();
    if failed > 0 {
        cli_println!(
            "{failed} server(s) did not receive the key. Check the names above and pair again once they are reachable."
        )?;
    }
    Ok(())
}

/// Lists paired devices and where their keys were installed.
pub(crate) fn list(json: bool) -> CommandResult {
    let registry = DeviceRegistry::load(DeviceRegistry::default_path()?)?;
    if json {
        cli_println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "registry": registry.path().display().to_string(),
                "devices": registry.devices(),
            }))
            .map_err(|error| CliError(error.to_string()))?
        )?;
        return Ok(());
    }
    if registry.devices().is_empty() {
        cli_println!("No paired devices ({})", registry.path().display())?;
        return Ok(());
    }
    for device in registry.devices() {
        cli_println!(
            "{}  {}  {}",
            device.device_id,
            device.device_name,
            device.fingerprint
        )?;
        for host in &device.hosts {
            cli_println!(
                "    {}  {}@{}:{}{}",
                if host.installed {
                    "installed"
                } else {
                    "FAILED   "
                },
                host.user,
                host.host,
                host.port,
                host.failure
                    .as_ref()
                    .map(|failure| format!(" — {failure}"))
                    .unwrap_or_default()
            )?;
        }
    }
    Ok(())
}

/// Removes one device's key from every host it was installed on.
pub(crate) fn revoke(args: PairRevokeArgs, json: bool) -> CommandResult {
    let home = dirs::home_dir().ok_or_else(|| {
        CliError("revocation could not resolve this account's home directory".into())
    })?;
    let mut registry = DeviceRegistry::acquire(DeviceRegistry::default_path()?, None)?;
    let device = registry.find(&args.device)?.clone();
    let installer = SshExecInstaller::new(home, args.remote_hmux, None);
    let current_hosts = args
        .inventory
        .as_deref()
        .map(inventory::load_configured_hosts)
        .transpose()?;

    let mut results = Vec::new();
    let mut unreachable = 0usize;
    for record in &device.hosts {
        let host = revocation_host(record, current_hosts.as_deref());
        // Every recorded host is attempted, including ones whose install
        // failed: "the install failed" and "the install succeeded and the
        // report was lost" are indistinguishable from here, and the cost of a
        // removal that finds nothing is one wasted ssh.
        match installer.revoke(
            &host,
            &device.authorized_keys_entry,
            record.host_key_fingerprint.as_deref(),
        ) {
            Ok(removed) => results.push((record, Ok(removed))),
            Err(error) => {
                unreachable += 1;
                results.push((record, Err(error)));
            }
        }
    }

    if json {
        cli_println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "deviceId": device.device_id,
                "hosts": results.iter().map(|(record, outcome)| serde_json::json!({
                    "id": record.id,
                    "name": record.name,
                    "host": record.host,
                    "port": record.port,
                    "user": record.user,
                    "removed": outcome.as_ref().ok().copied().unwrap_or(false),
                    "failure": outcome.as_ref().err(),
                })).collect::<Vec<_>>(),
            }))
            .map_err(|error| CliError(error.to_string()))?
        )?;
    } else {
        cli_println!("Revoking {} ({})", device.device_name, device.device_id)?;
        for (record, outcome) in &results {
            match outcome {
                Ok(true) => {
                    cli_println!("  Removed  {}@{}:{}", record.user, record.host, record.port)?
                }
                Ok(false) => {
                    cli_println!("  Absent   {}@{}:{}", record.user, record.host, record.port)?
                }
                Err(error) => cli_println!(
                    "  FAILED   {}@{}:{} — {error}",
                    record.user,
                    record.host,
                    record.port
                )?,
            }
        }
    }

    if unreachable == 0 || args.forget_unreachable {
        registry.forget(&device.device_id)?;
        if unreachable > 0 {
            eprintln!(
                "hmux pair: the key may still be present on {unreachable} server(s). The record was dropped at your request."
            );
        }
        return Ok(());
    }
    Err(CliError(format!(
        "Could not remove the key from {unreachable} server(s). The record is kept so you can retry. Pass --forget-unreachable to drop it anyway."
    ))
    .into())
}

/// Rebuilds the recorded destructive target, refreshing only its credential.
///
/// Host id alone is not enough: a row can be edited or reused. Coordinates and
/// route must still match byte-for-byte before a current key path is trusted;
/// the recorded host-key pin remains the final remote-identity fence.
fn revocation_host(
    record: &PairedHostRecord,
    current_hosts: Option<&[InventoryHost]>,
) -> InventoryHost {
    let target = if record.this_laptop {
        HostTarget::ThisLaptop
    } else {
        HostTarget::Remote(
            record
                .ssh_config_alias
                .clone()
                .map_or(SshInvocation::Explicit, SshInvocation::ConfigAlias),
        )
    };
    // ponytail: O(paired hosts × inventory) is fine for a human-sized fleet;
    // index current hosts by identity if fleet-sized inventories become real.
    let current = current_hosts.and_then(|hosts| {
        hosts
            .iter()
            .find(|host| same_revocation_endpoint(record, host))
    });
    InventoryHost {
        id: record.id.clone(),
        name: record.name.clone(),
        host: record.host.clone(),
        port: record.port,
        user: record.user.clone(),
        auth: current
            .map(|host| host.auth.clone())
            .unwrap_or_else(|| record.auth.clone()),
        key_path: current
            .map(|host| host.key_path.clone())
            .unwrap_or_else(|| record.key_path.clone()),
        target,
    }
}

fn same_revocation_endpoint(record: &PairedHostRecord, current: &InventoryHost) -> bool {
    let same_target = match (
        &current.target,
        record.this_laptop,
        &record.ssh_config_alias,
    ) {
        (HostTarget::ThisLaptop, true, None) => true,
        (HostTarget::Remote(SshInvocation::Explicit), false, None) => true,
        (
            HostTarget::Remote(SshInvocation::ConfigAlias(current_alias)),
            false,
            Some(recorded_alias),
        ) => current_alias == recorded_alias,
        _ => false,
    };
    current.id == record.id
        && current.host == record.host
        && current.port == record.port
        && current.user == record.user
        && same_target
}

/// `hmux pair apply-authorized-key` — the far side of the ssh hop.
///
/// Deliberately the *same* code the laptop runs on itself, so the trailing
/// newline rule, the atomic replace and the mode preservation have one
/// implementation and one set of tests rather than a Rust one and a shell one.
pub(crate) fn apply_authorized_key_stdio(remove: bool) -> CommandResult {
    let home = dirs::home_dir()
        .ok_or_else(|| CliError("no home directory to install an authorized key into".into()))?;
    let mut raw = String::new();
    std::io::stdin()
        .read_to_string(&mut raw)
        .map_err(|error| CliError(format!("could not read the request: {error}")))?;
    entry::refuse_private_key_material(raw.as_bytes())
        .map_err(|refusal| CliError(refusal.detail().into()))?;
    let request: ApplyRequest = serde_json::from_str(raw.trim())
        .map_err(|error| CliError(format!("could not parse the request: {error}")))?;
    if request.version != installer::APPLY_PROTOCOL_VERSION {
        return Err(CliError(format!(
            "this hmux speaks pairing apply version {}",
            installer::APPLY_PROTOCOL_VERSION
        ))
        .into());
    }
    let ApplyRequest {
        version: _,
        entry: line,
    } = request;
    // A line without both options is not an entry this feature produced, and
    // writing it would mean an ssh hop could append arbitrary authorized_keys
    // content through a program whose name says it installs pairing keys.
    // Shape-matched against the exact line `AuthorizedKeyEntry::build` emits,
    // not merely searched for the words: a comment field containing the text
    // "restrict" must not be enough to get an unrestricted key written by a
    // program whose name says it installs restricted ones.
    if line.contains('\n')
        || line.contains('\r')
        || !line.starts_with("command=\"")
        || !line.contains("\",restrict ")
    {
        return Err(CliError(
            "refusing an authorized_keys line that is not a single restricted forced-command entry"
                .into(),
        )
        .into());
    }
    let (receipt, legacy_host_key_fingerprint) = if remove {
        let removed = installer::revoke_locally(&home, &line).map_err(CliError)?;
        (
            installer::ApplyReceipt {
                version: installer::APPLY_PROTOCOL_VERSION,
                installed: removed,
                already_present: !removed,
                authorized_keys_path: home.join(".ssh/authorized_keys").display().to_string(),
            },
            None,
        )
    } else {
        // Keep the v1 field readable by deployed controllers. Current code
        // authorizes only the key observed by its own OpenSSH process.
        let published_pin = host_key::discover_published()
            .ok()
            .map(|fingerprint| fingerprint.display);
        (
            installer::apply_locally(&home, &line).map_err(CliError)?,
            published_pin,
        )
    };
    cli_println!(
        "{}",
        installer::serialize_wire_receipt(&receipt, legacy_host_key_fingerprint.as_deref())
            .map_err(|error| CliError(error.to_string()))?
    )?;
    Ok(())
}

/// This machine's routable address, without sending a packet.
///
/// `UdpSocket::connect` on a datagram socket only consults the routing table
/// and binds a source address; nothing leaves the machine. The destination is
/// TEST-NET-1, which is reserved for documentation and must never be routed, so
/// even a misreading of this code cannot turn it into a call home.
fn lan_address() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(address) if !address.is_loopback() && !address.is_unspecified() => {
            Some(address.to_string())
        }
        _ => None,
    }
}

fn local_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .unwrap_or_else(|_| "unknown".into())
}

fn unix_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// The one line this pairing will write.
///
/// A hand-written `--forced-command` is taken verbatim; it is the escape hatch
/// for an operator who wants a shape these two flags do not spell. Otherwise
/// the line is composed by the module that owns the spelling.
///
/// **`--writable` carries creation with it** (owner, 2026-09-04). A phone that
/// may type is a phone that drives that box, and one that may type but not
/// start cannot begin anything while the laptop sleeps — which was the whole
/// reason the widening exists. The narrow middle (type, never start) stays
/// reachable through `--forced-command`.
#[must_use]
fn pairing_forced_command(writable: bool, allow_create: bool, explicit: &str) -> String {
    if writable || allow_create {
        hmux_client::gateway_invocation::pairing_invocation(writable, true)
    } else {
        explicit.to_string()
    }
}

/// An identity a caller may hand this pairing, parsed once at the boundary.
///
/// The id is not only a registry key: it is written into the `authorized_keys`
/// comment on every server this pairing reaches. A value carrying a newline
/// would append a second line to a file whose every line is an authorization,
/// and one carrying a space would rename the field it lands in. So the
/// characters are narrowed here, once, and the rest of the module handles a
/// value whose invalid states no longer exist.
fn parse_assigned_device_id(raw: &str) -> Result<&str, CliError> {
    const LIMIT: usize = 128;
    let ok = !raw.is_empty()
        && raw.len() <= LIMIT
        && raw
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'));
    if ok {
        return Ok(raw);
    }
    Err(CliError(format!(
        "--device-id must be 1..={LIMIT} characters of [A-Za-z0-9._:-]; it is written into the \
         authorized_keys comment on every server this pairing reaches"
    )))
}

#[cfg(test)]
mod tests;
