//! The phone half of `hmux pair`: scan one QR at the desk, never need the
//! laptop again.
//!
//! ```text
//! [once, at the desk]
//!   phone --QR--> laptop
//!                 laptop appends this phone's PUBLIC key to authorized_keys on
//!                 every server it has credentials for, forced-command and
//!                 restricted, then hands the phone the inventory
//! [forever after]
//!   phone --ssh--> server A        laptop: off
//!   phone --ssh--> server B
//! ```
//!
//! The laptop is a **key distributor, not a relay**. Nothing here and nothing
//! downstream calls the address in the QR again: the inventory is copied into
//! [`crate::server_store`] and the laptop's address is not kept. Agents die when
//! the laptop closes, which is the entire reason this feature exists, so a
//! laptop on the steady-state path is a bug rather than a shortcut.
//!
//! # This file matches a host that already exists — it is not a proposal
//!
//! The laptop half landed on main as `hmux pair` (`e86df76`). Both endpoints use
//! [`hmux_client::online_pairing`] for the wire documents and proofs:
//!
//! - the QR payload is `hmux-pair:1?a=…&p=…&t=…&k=…&f=…&e=…&rp=2` (`qr.rs`),
//!   every value chosen to need no escaping; `rp=2` requires the answer proof
//!   that authenticates every SSH host-key pin;
//! - the request and answer are **one newline-delimited JSON document each way
//!   over plain TCP** — not HTTP, not SSH;
//! - possession of the pairing token is proven by HMAC-SHA256 over a shared,
//!   length-prefixed transcript. **The token itself is never transmitted.**
//!
//! An earlier draft of this file predated that host and invented a different
//! protocol entirely (an SSH exec channel with the token as an SSH password, a
//! JSON QR document, two public keys). It was replaced rather than adapted: a
//! proof computed over a different byte layout fails as
//! `pairing_proof_rejected`, which reads like a spent token, a clock problem, or
//! a hostile listener — anything except "the two sides disagree about field
//! order". Sharing the implementation makes that mismatch unrepresentable.
//!
//! # What is not claimed
//!
//! The single-use property of the token is the **laptop's** to enforce. A phone
//! cannot tell whether a token it was handed had already been spent. This
//! client's job is to not leak it: it is never persisted, never logged (see the
//! `Debug` impls), and dropped with the invitation the moment the exchange
//! ends.

use crate::server_store::{KeyConfinement, ServerEntry, CONFINEMENT_FORCED_COMMAND};
use base64::Engine as _;
use hmux_client::online_pairing::{
    contains_private_key_material, PairingRequest, PairingResponse, RequestTranscript,
    ResponseTranscriptV1, ResponseTranscriptV2, AUTHENTICATED_RESPONSE_PROOF_VERSION,
    PAIRING_PROTOCOL_VERSION,
};
use rand::rngs::SysRng;
use rand_core::TryRng;
use serde::Serialize;
use std::fmt;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod exchange;

/// The pairing wire version this build speaks.
pub const PAIRING_VERSION: u32 = PAIRING_PROTOCOL_VERSION;

/// The QR payload prefix, scheme and version in one token.
///
/// A camera hands this module whatever it saw — a URL, a Wi-Fi code, a boarding
/// pass — so the first question is "is this even ours", and the second is "is it
/// a version we speak". Splitting the two is what lets the UI say "that is not a
/// pairing code" instead of implying the laptop produced something broken.
const QR_SCHEME: &str = "hmux-pair:";

const SHA256_DIGEST_BYTES: usize = 32;

/// The prefix every fingerprint this client pins carries.
///
/// russh renders host keys as `SHA256:<base64>` and compares the rendered
/// string, so this is the only shape that can ever match. The QR carries the
/// same digest base64**url**-encoded (it has to survive a QR unescaped), which
/// is why [`pinnable_fingerprint`] re-encodes rather than passing the text
/// through.
const FINGERPRINT_PREFIX: &str = "SHA256:";

/// The largest QR payload this client will even try to parse.
///
/// A QR can carry a few kilobytes and the text arrives from a camera pointed at
/// something a stranger may have printed. Refusing the size before anything
/// parses it means a hostile code cannot choose how much work this process does.
pub const MAX_INVITATION_BYTES: usize = 4096;

/// The largest answer this client will read off the socket.
///
/// The laptop's answer is one JSON line carrying up to
/// [`MAX_INVENTORY_SERVERS`] host rows. The cap is what stops whoever answered
/// that port from choosing how much this process allocates.
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;

/// How many servers one answer may carry.
pub const MAX_INVENTORY_SERVERS: usize = 128;

/// Nonce length. The shared protocol requires at least 16 decoded bytes; 32 is
/// drawn because there is no reason to sit on the floor of that bound.
const NONCE_BYTES: usize = 32;

/// End-to-end budget for the exchange.
///
/// Long, because between the request and the answer the laptop is `ssh`-ing to
/// every server it knows and editing `authorized_keys` on each. Bounded anyway:
/// a phone held at a desk needs to be told the pairing failed, not left on a
/// spinner.
pub use hmux_client::online_pairing::PAIRING_EXCHANGE_BUDGET as PAIRING_BUDGET;

/// How long the laptop has to answer a TCP connect. A slice of
/// [`PAIRING_BUDGET`], not the whole of it — the laptop is on the same desk, and
/// if it does not accept a connection in 10 seconds it is not there.
pub const PAIRING_DIAL_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// The invitation the QR carried
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Eq, PartialEq)]
enum ResponseProofPolicy {
    /// V1 did not authenticate response pins. Only the pin carried by the QR
    /// itself can cross this compatibility boundary.
    LegacyV1 {
        qr_host_key_fingerprint: String,
    },
    AuthenticatedResponseV2,
}

/// What the QR code carried.
///
/// No `Debug` derive: `token` is the credential that makes the laptop authorize
/// this device on every server it knows, and a struct that prints itself is how
/// a credential reaches a log.
#[derive(Clone)]
pub struct PairingInvitation {
    pub address: String,
    pub port: u16,
    /// `SHA256:…`, ready to hand to `HostKeyPolicy::pinned`. Re-encoded from the
    /// QR's base64url form — see [`pinnable_fingerprint`].
    pub host_key_fingerprint: String,
    /// The algorithm the laptop published, carried so the UI can show the owner
    /// what they are about to trust.
    pub host_key_algorithm: String,
    pub expires_at_unix_ms: u64,
    response_proof_policy: ResponseProofPolicy,
    /// The raw 32-byte pairing secret. Never sent; only ever an HMAC key.
    token: Vec<u8>,
}

impl fmt::Debug for PairingInvitation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PairingInvitation")
            .field("address", &self.address)
            .field("port", &self.port)
            .field("host_key_algorithm", &self.host_key_algorithm)
            .field("host_key_fingerprint", &self.host_key_fingerprint)
            .field("expires_at_unix_ms", &self.expires_at_unix_ms)
            .field("response_proof_policy", &self.response_proof_policy)
            .finish_non_exhaustive()
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Why a scan or an exchange did not produce an inventory.
#[derive(Debug)]
pub enum PairingError {
    /// The scanned text is not an hmux pairing code at all.
    NotAPairingCode,
    /// The code is ours and describes a newer format.
    UnsupportedVersion { found: String, supported: u32 },
    /// The code is ours, at a version we speak, and does not describe a
    /// reachable laptop.
    Malformed { detail: String },
    /// Longer than any pairing code this build produces.
    Oversized { length: usize, maximum: usize },
    /// The QR's own expiry has passed. Refused before a packet is sent, which
    /// is why the expiry is in the payload at all: a phone pointed at a
    /// photograph of last week's screen says so instead of failing at a socket.
    Expired { expired_ago: Duration },
    /// The bytes never got to the laptop.
    Connect { detail: String },
    /// The connection worked and then broke.
    Io { detail: String },
    /// The exchange did not finish inside its budget.
    TimedOut { after: Duration },
    /// The laptop answered with something this build cannot read.
    MalformedAnswer { detail: String },
    /// The laptop refused, with its own stable reason token.
    Refused { reason: String, detail: String },
    /// Something answered on that address and could not prove it held the
    /// pairing token.
    ///
    /// Its own variant, and the loudest one, because it is the only failure here
    /// that means an attacker rather than a mistake: whoever answered got this
    /// device's public key and a device name, and would have got to choose the
    /// server list this phone trusts forever after.
    UnprovenAnswer,
    /// More servers than this client will hold.
    TooManyServers { maximum: usize },
    /// This client refuses to put private key material on the wire. Checked
    /// against the encoded request, mirroring the host's own pre-parse refusal,
    /// so the message names the field rather than arriving as a server refusal.
    PrivateKeyMaterial,
}

impl fmt::Display for PairingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAPairingCode => formatter.write_str("hmux 페어링 코드가 아닙니다"),
            Self::UnsupportedVersion { found, supported } => write!(
                formatter,
                "페어링 코드가 버전 {found}입니다 — 이 앱은 {supported}까지 읽습니다"
            ),
            Self::Malformed { detail } => {
                write!(formatter, "페어링 코드가 잘못되었습니다: {detail}")
            }
            Self::Oversized { length, maximum } => write!(
                formatter,
                "스캔한 내용이 {length}바이트로 페어링 코드 상한 {maximum}바이트를 넘습니다"
            ),
            Self::Expired { expired_ago } => write!(
                formatter,
                "이 QR은 {}초 전에 만료되었습니다 — 노트북에서 다시 띄우세요",
                expired_ago.as_secs()
            ),
            Self::Connect { detail } => {
                write!(formatter, "노트북에 연결하지 못했습니다: {detail}")
            }
            Self::Io { detail } => write!(formatter, "페어링 중 연결이 끊겼습니다: {detail}"),
            Self::TimedOut { after } => write!(
                formatter,
                "페어링이 {}초 안에 끝나지 않았습니다",
                after.as_secs()
            ),
            Self::MalformedAnswer { detail } => {
                write!(formatter, "노트북의 응답을 읽을 수 없습니다: {detail}")
            }
            Self::Refused { reason, detail } => {
                write!(
                    formatter,
                    "노트북이 페어링을 거절했습니다 ({reason}): {detail}"
                )
            }
            Self::UnprovenAnswer => formatter.write_str(
                "그 주소에서 응답한 상대가 QR의 페어링 토큰을 갖고 있음을 증명하지 못했습니다 — \
                 노트북이 아닌 다른 기기일 수 있습니다",
            ),
            Self::TooManyServers { maximum } => {
                write!(formatter, "노트북이 서버를 {maximum}개보다 많이 보냈습니다")
            }
            Self::PrivateKeyMaterial => formatter.write_str(
                "요청에 개인키로 보이는 내용이 들어 있어 전송을 거부했습니다 — 기기 이름을 \
                 확인하세요",
            ),
        }
    }
}

impl std::error::Error for PairingError {}

impl PairingError {
    /// A stable code the UI branches on.
    #[must_use]
    pub fn code(&self) -> &str {
        match self {
            Self::NotAPairingCode => "pairing_not_a_code",
            Self::UnsupportedVersion { .. } => "pairing_unsupported_version",
            Self::Malformed { .. } => "pairing_malformed_code",
            Self::Oversized { .. } => "pairing_code_oversized",
            Self::Expired { .. } => "pairing_code_expired",
            Self::Connect { .. } => "pairing_connect_failed",
            Self::Io { .. } => "pairing_io_failed",
            Self::TimedOut { .. } => "pairing_timed_out",
            Self::MalformedAnswer { .. } => "pairing_malformed_answer",
            // The host's own token, passed through rather than remapped: it
            // already distinguishes a spent QR from an expired one from a
            // rejected proof, and those send the owner to three different
            // actions.
            Self::Refused { reason, .. } => reason,
            Self::UnprovenAnswer => "pairing_answer_unproven",
            Self::TooManyServers { .. } => "pairing_too_many_servers",
            Self::PrivateKeyMaterial => "pairing_private_key_material",
        }
    }
}

// ---------------------------------------------------------------------------
// Parsing the QR
// ---------------------------------------------------------------------------

/// Re-encodes the QR's base64url digest as the `SHA256:…` string russh compares.
///
/// The QR uses base64**url** without padding because the payload must survive a
/// QR unescaped (`qr.rs`); russh renders `SHA256:` + standard base64 without
/// padding. They are the same digest in two alphabets, and passing the QR's text
/// through unchanged would produce a pin that is well-formed and can never
/// match — a failure that surfaces much later as "host key not pinned", naming
/// the server rather than the encoding.
///
/// The length is checked because a digest that is not 32 bytes is not a SHA-256
/// digest, and a pin that can never match is worse than no pin: it fails at the
/// far end of a dial instead of here.
fn pinnable_fingerprint(compact: &str) -> Result<String, PairingError> {
    let digest = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(compact)
        .map_err(|error| PairingError::Malformed {
            detail: format!("호스트 키 지문이 base64url이 아닙니다: {error}"),
        })?;
    if digest.len() != SHA256_DIGEST_BYTES {
        return Err(PairingError::Malformed {
            detail: format!(
                "호스트 키 지문이 SHA-256 길이({SHA256_DIGEST_BYTES}바이트)가 아닙니다: {}바이트",
                digest.len()
            ),
        });
    }
    Ok(format!(
        "{FINGERPRINT_PREFIX}{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
    ))
}

/// One required QR parameter, or the refusal that names it.
///
/// A helper rather than six copies of the same `match`: the failure text has to
/// name the parameter, and six hand-written copies is how one of them ends up
/// naming the wrong letter.
fn required(value: Option<&str>, name: &str) -> Result<String, PairingError> {
    match value {
        Some(text) if !text.is_empty() => Ok(text.to_string()),
        _ => Err(PairingError::Malformed {
            detail: format!("`{name}` 값이 없습니다"),
        }),
    }
}

/// Reads a scanned QR payload: `hmux-pair:1?a=…&p=…&t=…&k=…&f=…&e=…&rp=2`.
///
/// Strict, because everything after this point trusts the invitation. The
/// fingerprint becomes the only thing standing between this phone and an
/// impostor laptop, and the token is the credential that impostor would be
/// handed, so a blank or misshapen field is refused here rather than turned into
/// a dial that would accept anyone.
///
/// Unknown parameters are ignored rather than refused: the host may add one
/// additively at the same version, and refusing would make a forward-compatible
/// change break every fielded phone. Every parameter this build *needs* is
/// required, so ignoring an extra cannot weaken anything.
pub fn parse_invitation(scanned: &str) -> Result<PairingInvitation, PairingError> {
    if scanned.len() > MAX_INVITATION_BYTES {
        return Err(PairingError::Oversized {
            length: scanned.len(),
            maximum: MAX_INVITATION_BYTES,
        });
    }
    let payload = scanned.trim();
    let rest = payload
        .strip_prefix(QR_SCHEME)
        .ok_or(PairingError::NotAPairingCode)?;
    let (version, query) = rest.split_once('?').ok_or(PairingError::NotAPairingCode)?;
    if version != PAIRING_VERSION.to_string() {
        return Err(PairingError::UnsupportedVersion {
            found: version.to_string(),
            supported: PAIRING_VERSION,
        });
    }

    let mut address = None;
    let mut port = None;
    let mut token = None;
    let mut algorithm = None;
    let mut fingerprint = None;
    let mut expires = None;
    let mut response_proof_version = None;
    for parameter in query.split('&') {
        let Some((key, value)) = parameter.split_once('=') else {
            return Err(PairingError::Malformed {
                detail: format!("`{parameter}`에 값이 없습니다"),
            });
        };
        match key {
            "a" => address = Some(value),
            "p" => port = Some(value),
            "t" => token = Some(value),
            "k" => algorithm = Some(value),
            "f" => fingerprint = Some(value),
            "e" => expires = Some(value),
            "rp" => response_proof_version = Some(value),
            _ => {}
        }
    }

    let address = required(address, "a")?;
    let port = required(port, "p")?;
    let token = required(token, "t")?;
    let algorithm = required(algorithm, "k")?;
    let fingerprint = required(fingerprint, "f")?;
    let expires = required(expires, "e")?;
    let supported_response_proof = AUTHENTICATED_RESPONSE_PROOF_VERSION.to_string();
    let requires_response_v2 = match response_proof_version {
        None => false,
        Some(version) if version == supported_response_proof => true,
        Some(version) => {
            return Err(PairingError::Malformed {
                detail: format!("응답 proof 버전 `{version}`을 지원하지 않습니다"),
            });
        }
    };

    let port: u16 = port.parse().map_err(|_| PairingError::Malformed {
        detail: format!("포트 `{port}`를 읽을 수 없습니다"),
    })?;
    // Port 0 round-trips through `parse` as a valid `u16` and only fails at
    // connect, as an opaque error.
    if port == 0 {
        return Err(PairingError::Malformed {
            detail: "포트가 0입니다".to_string(),
        });
    }
    let expires_at_unix_ms: u64 = expires.parse().map_err(|_| PairingError::Malformed {
        detail: format!("만료 시각 `{expires}`를 읽을 수 없습니다"),
    })?;
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&token)
        .map_err(|error| PairingError::Malformed {
            detail: format!("페어링 토큰이 base64url이 아닙니다: {error}"),
        })?;
    if token.is_empty() {
        return Err(PairingError::Malformed {
            detail: "페어링 토큰이 비어 있습니다".to_string(),
        });
    }
    let host_key_fingerprint = pinnable_fingerprint(&fingerprint)?;
    let response_proof_policy = if requires_response_v2 {
        ResponseProofPolicy::AuthenticatedResponseV2
    } else {
        ResponseProofPolicy::LegacyV1 {
            qr_host_key_fingerprint: host_key_fingerprint.clone(),
        }
    };

    Ok(PairingInvitation {
        address,
        port,
        host_key_fingerprint,
        host_key_algorithm: algorithm,
        expires_at_unix_ms,
        response_proof_policy,
        token,
    })
}

/// Refuses an invitation whose QR has already expired.
///
/// Separate from parsing so the clock is an argument: a phone whose clock is
/// wrong would otherwise refuse every valid QR with no way to see why, and a
/// test that had to wait two minutes would not be written.
pub fn refuse_if_expired(
    invitation: &PairingInvitation,
    now: SystemTime,
) -> Result<(), PairingError> {
    let now_ms = now
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default();
    if now_ms >= invitation.expires_at_unix_ms {
        return Err(PairingError::Expired {
            expired_ago: Duration::from_millis(now_ms - invitation.expires_at_unix_ms),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// What the phone keeps
// ---------------------------------------------------------------------------

/// One server the laptop reported on, after this client has decided whether it
/// can be dialed.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PairedHost {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// `SHA256:…` when the laptop supplied one this client can pin. QR proof
    /// capability v2 authenticates this exact value before it reaches storage.
    pub host_key_fingerprint: Option<String>,
    pub installed: bool,
    /// Why this server has no key, in the laptop's own words. Present exactly
    /// when the phone must not treat this server as reachable.
    pub failure: Option<String>,
}

impl PairedHost {
    /// Whether this device can actually dial the server.
    ///
    /// Two conditions, not one. A server the laptop failed to install on is
    /// obvious. A server it *did* install on but published no host key for is
    /// the subtle one: this client has no accept-anything mode, so an unpinnable
    /// server is one it can never connect to, and adopting it would put a row on
    /// the list that renders as "connect" and fails forever.
    #[must_use]
    pub fn is_usable(&self) -> bool {
        self.installed && self.host_key_fingerprint.is_some()
    }

    /// The sentence the phone shows for a server it cannot use.
    #[must_use]
    pub fn refusal(&self) -> Option<String> {
        if self.is_usable() {
            return None;
        }
        if !self.installed {
            return Some(
                self.failure
                    .clone()
                    .unwrap_or_else(|| "노트북이 이 서버에 키를 설치하지 못했습니다".to_string()),
            );
        }
        Some(
            "키는 설치되었지만 이 서버의 호스트 키 지문을 받지 못해 고정할 수 없습니다 — \
             해당 서버의 sshd 공개 호스트 키를 확인하세요"
                .to_string(),
        )
    }
}

/// Everything the laptop had to say, and the last thing it will ever say.
#[derive(Clone, Debug, Serialize)]
pub struct PairingAnswer {
    pub device_id: String,
    /// **Every** host the laptop reported, usable or not.
    ///
    /// Never filtered. A server that silently disappears reads exactly like a
    /// server that does not exist, and the one machine the owner came to the
    /// desk for is the one that will have failed.
    pub hosts: Vec<PairedHost>,
}

impl PairingAnswer {
    /// The rows that become entries in this device's own server list.
    ///
    /// No `#[must_use]`: `Iterator` already carries one, and clippy's
    /// `double_must_use` is right that a second says nothing.
    pub fn usable(&self) -> impl Iterator<Item = &PairedHost> {
        self.hosts.iter().filter(|host| host.is_usable())
    }
}

/// Turns one usable row into a stored server.
///
/// `paired` is set here and nowhere else: it records that these keys were
/// installed by a laptop that will not be consulted again, which is what makes
/// deleting the entry unrecoverable.
///
/// `attach_key_confinement` is [`CONFINEMENT_FORCED_COMMAND`] because
/// `hmux pair` always writes `command="…",restrict` — both options, always
/// (`hmux-cli::pairing::entry::AuthorizedKeyEntry::build`). What the forced
/// command *is* is chosen by the laptop (`--forced-command`) and is not in the
/// answer, so this client records the confinement and does not claim to know the
/// mode. That distinction is why the census classifies a gateway that refuses to
/// run as `NotProvisioned` rather than as a broken server.
#[must_use]
pub fn to_entry(host: &PairedHost) -> ServerEntry {
    ServerEntry {
        id: host.id.clone(),
        label: if host.name.trim().is_empty() {
            host.host.clone()
        } else {
            host.name.clone()
        },
        host: host.host.clone(),
        port: host.port,
        username: host.user.clone(),
        host_key_fingerprint: host.host_key_fingerprint.clone().unwrap_or_default(),
        paired: true,
        attach_key_confinement: KeyConfinement(CONFINEMENT_FORCED_COMMAND.to_string()),
    }
}

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

fn refuse_private_key_material(raw: &[u8]) -> Result<(), PairingError> {
    if contains_private_key_material(raw) {
        return Err(PairingError::PrivateKeyMaterial);
    }
    Ok(())
}

/// Draws a fresh nonce from the OS generator.
///
/// `SysRng` is fallible on a phone (an unentitled process, a platform that has
/// not finished seeding) and the refusal is surfaced rather than papered over: a
/// predictable nonce would let a proof captured off the LAN be replayed inside
/// the same pairing window, which is the one thing the nonce is there to stop.
fn fresh_nonce() -> Result<Vec<u8>, PairingError> {
    let mut nonce = [0u8; NONCE_BYTES];
    SysRng
        .try_fill_bytes(&mut nonce)
        .map_err(|error| PairingError::Malformed {
            detail: format!("기기의 난수 생성기를 쓸 수 없습니다: {error}"),
        })?;
    Ok(nonce.to_vec())
}

/// Runs the pairing exchange: one JSON line out, one JSON line back.
///
/// Plain TCP, deliberately — see the module header. The order below is the
/// security argument and is not interchangeable:
///
/// 1. build the request and refuse it locally if it carries key material;
/// 2. compute the proof over the request transcript, keyed by the token;
/// 3. write one line, read one line under a bound;
/// 4. **verify the answer's own proof before believing a word of it.**
///
/// Step 4 is what makes a stranger answering that port a named failure rather
/// than a server list this phone trusts forever.
pub fn enroll(
    invitation: &PairingInvitation,
    device_name: &str,
    public_key: &str,
) -> Result<PairingAnswer, PairingError> {
    let deadline = Instant::now() + PAIRING_BUDGET;
    let nonce = fresh_nonce()?;
    let transcript = RequestTranscript::new(PAIRING_VERSION, device_name, public_key, &nonce);
    let proof = transcript.proof(&invitation.token);

    let request = PairingRequest {
        version: PAIRING_VERSION,
        device_name: device_name.to_string(),
        public_key: public_key.to_string(),
        nonce: base64::engine::general_purpose::STANDARD.encode(&nonce),
        proof: base64::engine::general_purpose::STANDARD.encode(proof),
    };
    let mut encoded = serde_json::to_vec(&request).map_err(|error| PairingError::Malformed {
        detail: error.to_string(),
    })?;
    refuse_private_key_material(&encoded)?;
    encoded.push(b'\n');

    let raw = exchange::exchange(invitation, &encoded, deadline)?;
    read_answer(
        &raw,
        &nonce,
        &invitation.token,
        &invitation.response_proof_policy,
    )
}

/// Parses one answer and verifies it was written by whoever holds the token.
///
/// A refusal is read *before* the proof is checked. That is deliberate and it is
/// the one asymmetry here: a refusal carries no inventory, no key and no
/// authority — it is a sentence the owner needs ("this QR was already used") —
/// while a `paired` answer decides which servers this phone trusts for the rest
/// of its life. Demanding a proof on the refusal path would replace a useful
/// message with [`PairingError::UnprovenAnswer`] every time the token was
/// already spent, because a laptop that refuses before redeeming has nothing to
/// key an HMAC with that the phone could check either.
fn read_answer(
    raw: &[u8],
    nonce: &[u8],
    token: &[u8],
    proof_policy: &ResponseProofPolicy,
) -> Result<PairingAnswer, PairingError> {
    let response: PairingResponse = serde_json::from_slice(trim_newline(raw)).map_err(|error| {
        PairingError::MalformedAnswer {
            detail: error.to_string(),
        }
    })?;
    let answer = match response {
        PairingResponse::Refused(refusal) => {
            if refusal.reason == hmux_client::online_pairing::PAIRING_DEADLINE_ELAPSED {
                return Err(PairingError::TimedOut {
                    after: PAIRING_BUDGET,
                });
            }
            return Err(PairingError::Refused {
                reason: refusal.reason,
                detail: refusal.detail,
            });
        }
        PairingResponse::Paired(answer) => answer,
    };
    if answer.version != PAIRING_VERSION {
        return Err(PairingError::UnsupportedVersion {
            found: answer.version.to_string(),
            supported: PAIRING_VERSION,
        });
    }
    if answer.hosts.len() > MAX_INVENTORY_SERVERS {
        return Err(PairingError::TooManyServers {
            maximum: MAX_INVENTORY_SERVERS,
        });
    }

    let verified = match proof_policy {
        ResponseProofPolicy::LegacyV1 { .. } => {
            let offered = decode_proof(&answer.proof)?;
            ResponseTranscriptV1::new(nonce, &answer.device_id, &answer.hosts)
                .verifies(token, &offered)
        }
        ResponseProofPolicy::AuthenticatedResponseV2 => {
            let offered = answer
                .proof_v2
                .as_deref()
                .ok_or(PairingError::UnprovenAnswer)
                .and_then(decode_proof)?;
            ResponseTranscriptV2::new(answer.version, nonce, &answer.device_id, &answer.hosts)
                .verifies(token, &offered)
        }
    };
    if !verified {
        return Err(PairingError::UnprovenAnswer);
    }

    Ok(PairingAnswer {
        device_id: answer.device_id,
        hosts: answer
            .hosts
            .into_iter()
            .map(|host| PairedHost {
                host_key_fingerprint: authenticated_fingerprint(
                    host.host_key_fingerprint.as_deref(),
                    proof_policy,
                ),
                id: host.id,
                name: host.name,
                host: host.host,
                port: host.port,
                user: host.user,
                installed: host.installed,
                failure: host.failure,
            })
            .collect(),
    })
}

fn decode_proof(encoded: &str) -> Result<Vec<u8>, PairingError> {
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| PairingError::UnprovenAnswer)
}

fn authenticated_fingerprint(
    candidate: Option<&str>,
    proof_policy: &ResponseProofPolicy,
) -> Option<String> {
    let candidate = usable_fingerprint(candidate)?;
    match proof_policy {
        ResponseProofPolicy::AuthenticatedResponseV2 => Some(candidate),
        ResponseProofPolicy::LegacyV1 {
            qr_host_key_fingerprint,
        } if candidate == qr_host_key_fingerprint.as_str() => Some(candidate),
        ResponseProofPolicy::LegacyV1 { .. } => None,
    }
}

/// Keeps a fingerprint only if this client could ever pin it.
///
/// The laptop sends `None` for a machine with no published sshd host key
/// (`installer::apply_locally` says so in as many words). It could also send
/// something shaped wrong. Both become `None` here, so the single question
/// "can this row be dialed" has one answer instead of failing later at a
/// handshake with a message about the server.
fn usable_fingerprint(candidate: Option<&str>) -> Option<String> {
    let text = candidate?.trim();
    if text.starts_with(FINGERPRINT_PREFIX) && text.len() > FINGERPRINT_PREFIX.len() {
        Some(text.to_string())
    } else {
        None
    }
}

fn trim_newline(raw: &[u8]) -> &[u8] {
    let mut end = raw.len();
    while end > 0 && (raw[end - 1] == b'\n' || raw[end - 1] == b'\r') {
        end -= 1;
    }
    &raw[..end]
}

#[cfg(test)]
mod tests;
