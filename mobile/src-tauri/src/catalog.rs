//! Asking `hmux mobile-gateway` for its session catalog, and reading the answer.
//!
//! ## Why the request travels on the stream and not in the command
//!
//! This module used to run `hmux mobile-gateway --list` and read whatever came
//! back. That works only for a key with *no* forced command, which is not the
//! key `hmux pair` installs. sshd **replaces** the client's argv with the pinned
//! `command="…"` line and moves the request to `SSH_ORIGINAL_COMMAND`, so a
//! phone can append nothing — the `--list` this client asked for never reached
//! the far end. While `--session` was also required it was worse than useless:
//! the pinned line exited 2 before reading a byte, and a phone that had paired
//! with two real servers could neither list nor attach.
//!
//! So the request is now a document sent **on the channel**, which a forced
//! command cannot suppress. [`list_request`] is that document; the exec command
//! stays the plain gateway invocation (see `crate::relay::list_command`),
//! because a `--list` there would be discarded under a forced command and
//! redundant without one.
//!
//! ## Why a refusal is a `WireFrame` while a record is not
//!
//! Both shapes share the framing, and this reader has to accept either. A
//! record is a catalog document (below); a refusal is an ordinary protocol
//! `ErrorFrame`, which is the vocabulary the gateway already answers every other
//! refusal in. Reporting "malformed listing" for a perfectly well-formed refusal
//! would hide the one sentence that says what to fix, so
//! [`CatalogError::Refused`] carries it through.
//!
//! This is what makes attaching possible at all. A relayed attach is fenced by
//! all seven `SessionFence` fields, compared exactly, and four of them
//! (`runner_instance`, `channel_epoch`, `host_instance_id`, `terminal_epoch`)
//! move every time the Host is replaced or the box reboots. A phone cannot
//! guess them and cannot derive them from a session *name*, so without this
//! listing the client can attach exactly once, until the first restart.
//!
//! ## The wire shape, and why it is parsed here rather than imported
//!
//! Each record is a big-endian `u32` length followed by that many bytes of
//! JSON — the same framing as a protocol frame, deliberately **not** a
//! `WireFrame` (there is no `FrameBody` variant for a catalog, and minting one
//! is a protocol change the CLI may not make unilaterally). The stream ends at
//! EOF on a document boundary.
//!
//! The gateway's own `CatalogEntry` is private to `hmux-cli`, and the types it
//! borrows from — `SessionClass`, `SessionLifecycle`, `VersionRange` — derive
//! `Serialize` but not `Deserialize`. So the reader half is declared here.
//! That is a duplicated shape and it is worth naming as a cost: the guard
//! against drift is `gateway_catalog_version`, which this reader refuses when
//! it is newer than it understands rather than parsing a document written to a
//! shape it has never seen.
//!
//! ## What a hostile or broken far end can do
//!
//! Everything on this stream arrives from a machine the phone does not
//! control, so every bound is enforced here rather than assumed:
//!
//! - a length prefix larger than the protocol's own frame cap is refused
//!   before any allocation;
//! - an unbounded stream of records is refused at [`MAX_SESSIONS`] instead of
//!   growing a `Vec` until the app is killed by the OS;
//! - EOF *inside* a record is `Truncated`, which is a different answer from
//!   EOF *between* records. Collapsing them would make a connection dropped
//!   mid-listing indistinguishable from a server with fewer sessions.

use hmux_client::SessionFence;
use hmux_host::local_protocol::FrameLimits;
use serde::{Deserialize, Serialize};
use std::io::Read;

/// The document version this reader understands.
///
/// Refusing a *newer* version is the whole reason the field exists. A record
/// written to a shape this build has never seen would otherwise be parsed with
/// serde's tolerance for unknown fields, and the missing meaning would surface
/// as a fence the Host rejects — a failure three layers away from its cause.
///
/// Older answers stay readable: every field this version added is optional, so
/// a v1 gateway's record parses into the same shape with those fields absent.
pub const SUPPORTED_CATALOG_VERSION: u16 = 3;

/// Big-endian, four bytes, exactly as `FrameCodec` prefixes a frame.
pub(crate) const LENGTH_PREFIX_BYTES: usize = 4;

/// The request-document version this client speaks.
///
/// Versioned separately from [`SUPPORTED_CATALOG_VERSION`] because the question
/// and the answer evolve independently: a gateway that gains a new record field
/// has not changed what it takes to ask.
pub const GATEWAY_REQUEST_VERSION: u16 = 4;

/// The framed document that asks a gateway for its session catalog.
///
/// Written out here rather than imported from `hmux-cli`, whose request types
/// are private to that binary. That duplication is the same cost — and has the
/// same guard — as the record shape below: a version field the far end refuses
/// when it is not one it serves, rather than two sides quietly disagreeing.
///
/// Length-prefixed on purpose. It shares the framing with everything else on
/// this channel, so the gateway can read the first document before it knows
/// whether the peer is listing or attaching.
#[must_use]
pub fn list_request() -> Vec<u8> {
    let payload = format!(
        r#"{{"gateway_request_version":{GATEWAY_REQUEST_VERSION},"request":"list_sessions"}}"#
    );
    let mut framed = Vec::with_capacity(LENGTH_PREFIX_BYTES + payload.len());
    framed.extend_from_slice(
        &u32::try_from(payload.len())
            .expect("a fixed request document is far below u32::MAX")
            .to_be_bytes(),
    );
    framed.extend_from_slice(payload.as_bytes());
    framed
}

/// How many records one listing may carry.
///
/// A bound, not a product decision: 512 sessions on one box is already far
/// past anything a phone can render, and the alternative to a bound is letting
/// a far end decide how much memory this process allocates.
pub const MAX_SESSIONS: usize = 512;

/// One session a server is willing to tell this device about.
///
/// The field set is the gateway's allow-list, mirrored. It carries no
/// capability token (that key never crosses the network) and no socket path or
/// pid (both name nothing off-box), so there is nothing here to feed to a
/// local process probe even by mistake.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct RemoteSession {
    pub session_id: String,
    #[serde(default)]
    pub session_name: Option<String>,
    pub workspace_id: String,
    #[serde(default)]
    pub session_class: CatalogEnum,
    #[serde(default)]
    pub lifecycle: CatalogEnum,
    pub provider_id: String,
    /// The bare name of what the session was launched to run, when the gateway
    /// is new enough to say and the Host recorded one. Never the arguments.
    ///
    /// Describes the launch, not the present: a shell that later ran `ssh`
    /// still reads `zsh`. The list uses it to tell a session apart at a glance,
    /// never to decide what a session *is*.
    #[serde(default)]
    pub launch_program: Option<String>,
    /// Whether the Host process behind this session is still there, as the
    /// gateway proved it — `live`, `absent`, or `unknown`.
    ///
    /// Kept as text for the same reason `lifecycle` is: a state this build has
    /// never seen must not discard the row. `None` from a gateway too old to
    /// answer, which is *not* the same as `unknown` — one is "nobody asked",
    /// the other is "asked and could not tell".
    #[serde(default)]
    pub host_liveness: Option<String>,
    pub runner_principal: String,
    pub runner_instance: String,
    /// Decimal text, because the manifest carries it that way (`json_u64`) to
    /// survive a JSON parser that would round a `u64` through an `f64`.
    /// Converted to a number only in [`Self::fence`], where a malformed value
    /// is refused rather than silently zeroed.
    pub channel_epoch: String,
    pub host_instance_id: String,
    pub terminal_epoch: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

/// A snake_case enum from the gateway, kept as text.
///
/// `session_class` and `lifecycle` are the two fields a future Host could gain
/// a variant of without the catalog version moving. Decoding them into a
/// closed Rust enum would make one unknown variant discard the whole listing,
/// which is a worse failure than showing a row whose class this build does not
/// recognise. Meaning is applied in exactly one place — [`RemoteSession::is_ready`]
/// — and that predicate is deliberately positive: an unrecognised lifecycle is
/// *not* ready, so a new "terminating" state cannot read as attachable.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct CatalogEnum(pub String);

impl CatalogEnum {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The one lifecycle value that means "there is a live Host to attach to".
pub const LIFECYCLE_READY: &str = "ready";

impl RemoteSession {
    /// Whether this row is worth offering to open.
    ///
    /// Positive on purpose, like [`Self::is_ready`]: only a Host proved *gone*
    /// is dropped. A gateway that did not answer, and a probe that could not
    /// tell, both leave the session listed — a list that hides what it is
    /// unsure of is a list that loses sessions, and the user has no way to ask
    /// again for the one that vanished.
    #[must_use]
    pub fn host_is_gone(&self) -> bool {
        self.host_liveness.as_deref() == Some("absent")
    }

    /// Whether this session is worth offering an attach for.
    #[must_use]
    pub fn is_ready(&self) -> bool {
        self.lifecycle.as_str() == LIFECYCLE_READY
    }

    /// The exact fence the Host will compare a relayed `Hello` against.
    ///
    /// Every field is copied, never defaulted. An absent or unparseable
    /// `channel_epoch` is an error here rather than a `0`, because `0` is a
    /// value the Host would compare and reject with `FenceMismatch` — a
    /// refusal that names the wrong cause.
    pub fn fence(&self) -> Result<SessionFence, CatalogError> {
        let channel_epoch =
            self.channel_epoch
                .parse::<u64>()
                .map_err(|error| CatalogError::Malformed {
                    detail: format!(
                        "channel_epoch {:?} is not a u64: {error}",
                        self.channel_epoch
                    ),
                })?;
        Ok(SessionFence {
            workspace_id: self.workspace_id.clone(),
            session_id: self.session_id.clone(),
            runner_principal: self.runner_principal.clone(),
            runner_instance: self.runner_instance.clone(),
            channel_epoch,
            host_instance_id: self.host_instance_id.clone(),
            terminal_epoch: self.terminal_epoch.clone(),
        })
    }
}

/// A discovered session, plus whether this client would offer to attach.
///
/// The `ready` flag is computed here, on the Rust side, and the webview is
/// given the answer rather than the `lifecycle` string to interpret. One place
/// applies meaning to that field — [`RemoteSession::is_ready`] — so a Host that
/// gains a new lifecycle value cannot end up attachable in the UI and refused
/// by the protocol.
#[derive(Clone, Debug, Serialize)]
pub struct DiscoveredSession {
    #[serde(flatten)]
    pub session: RemoteSession,
    pub ready: bool,
}

/// Drops the rows a list has no business offering.
///
/// Only a Host proved *gone* is removed. A session whose liveness the gateway
/// did not answer, or could not decide, stays — see
/// [`RemoteSession::host_is_gone`]. Filtering here rather than on the screen
/// keeps every list surface honest at once: the census and the per-server
/// listing are two callers of the same answer.
#[must_use]
pub fn worth_listing(sessions: Vec<RemoteSession>) -> Vec<DiscoveredSession> {
    sessions
        .into_iter()
        .filter(|session| !session.host_is_gone())
        .map(DiscoveredSession::from)
        .collect()
}

impl From<RemoteSession> for DiscoveredSession {
    fn from(session: RemoteSession) -> Self {
        Self {
            ready: session.is_ready(),
            session,
        }
    }
}

#[derive(Debug, Deserialize)]
struct CatalogDocument {
    gateway_catalog_version: u16,
    /// 강제 명령이 실제로 적용됐는지, 게이트웨이가 관측해 보고한 값.
    ///
    /// `Option`인 이유는 이 필드가 없는 게이트웨이가 아직 서버에 있을 수 있기
    /// 때문이다. 없으면 `None`이고, 화면은 "모른다"고 말한다 — `false`로
    /// 떨어뜨리면 멀쩡히 고정된 서버를 고정되지 않았다고 하고, `true`로
    /// 떨어뜨리면 이 필드를 만든 이유가 사라진다.
    #[serde(default)]
    forced_command_applied: Option<bool>,
    session: RemoteSession,
}

/// Just enough of a protocol `WireFrame` to recognise a refusal.
///
/// Not the real `WireFrame`: that type's `FrameBody` does not derive
/// `Deserialize` in this crate's feature set, and pulling it in would make a
/// listing reader depend on the whole frame vocabulary to read one sentence.
/// Unknown fields are ignored by design — everything else in the frame is the
/// attach protocol's business, not this reader's.
#[derive(Debug, Deserialize)]
struct RefusalDocument {
    body: RefusalBody,
}

#[derive(Debug, Deserialize)]
struct RefusalBody {
    kind: String,
    payload: RefusalPayload,
}

#[derive(Debug, Deserialize)]
struct RefusalPayload {
    code: String,
    message: String,
}

/// The gateway's refusal, if this document is one.
///
/// Tried only after the catalog parse fails, and gated on `kind == "error"` so
/// some future frame the gateway learns to send cannot be reported as a refusal
/// it is not.
pub(crate) fn refusal_in(payload: &[u8]) -> Option<(String, String)> {
    let document: RefusalDocument = serde_json::from_slice(payload).ok()?;
    (document.body.kind == "error")
        .then_some((document.body.payload.code, document.body.payload.message))
}

/// Why a listing could not be read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CatalogError {
    /// The stream ended in the middle of a record. Distinct from a clean end
    /// on purpose: this one means bytes were lost, not that the server has
    /// nothing more to say.
    Truncated {
        after_records: usize,
    },
    /// A length prefix past the protocol's frame cap, refused before
    /// allocating.
    Oversized {
        length: usize,
        maximum: usize,
    },
    TooManySessions {
        maximum: usize,
    },
    UnsupportedVersion {
        found: u16,
        supported: u16,
    },
    /// The gateway answered the request with a protocol `ErrorFrame` instead of
    /// records.
    ///
    /// Its own variant because it is the only failure here that is not a
    /// transport or shape problem: the far end understood the question and said
    /// no, and its sentence names the fix. Folding it into `Malformed` would
    /// report a working server as a broken one.
    Refused {
        code: String,
        message: String,
    },
    Malformed {
        detail: String,
    },
    Io {
        detail: String,
    },
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated { after_records } => write!(
                formatter,
                "the session listing ended inside a record after {after_records} complete ones"
            ),
            Self::Oversized { length, maximum } => write!(
                formatter,
                "the server announced a {length}-byte listing record over the {maximum}-byte cap"
            ),
            Self::TooManySessions { maximum } => {
                write!(formatter, "the server listed more than {maximum} sessions")
            }
            Self::UnsupportedVersion { found, supported } => write!(
                formatter,
                "the server speaks session-catalog version {found}; this build understands {supported}"
            ),
            Self::Refused { message, .. } => {
                write!(formatter, "서버가 세션 목록을 거절했습니다: {message}")
            }
            Self::Malformed { detail } => write!(formatter, "malformed session listing: {detail}"),
            Self::Io { detail } => write!(formatter, "could not read the session listing: {detail}"),
        }
    }
}

impl std::error::Error for CatalogError {}

impl CatalogError {
    /// A stable code for callers that branch rather than display.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Truncated { .. } => "catalog_truncated",
            Self::Oversized { .. } => "catalog_oversized",
            Self::TooManySessions { .. } => "catalog_too_many_sessions",
            Self::UnsupportedVersion { .. } => "catalog_unsupported_version",
            Self::Refused { .. } => "catalog_refused",
            Self::Malformed { .. } => "catalog_malformed",
            Self::Io { .. } => "catalog_io",
        }
    }
}

/// Reads every record on `source` until it ends cleanly.
///
/// Takes a `Read` rather than the SSH reader concretely so the framing is
/// testable against a byte slice — including the truncation and oversize
/// cases, which cannot be provoked reliably against a real server.
/// 목록 한 번의 결과.
///
/// 세션 목록만 돌려주던 것을 구조체로 바꾼 이유: 강제 명령이 실제로 적용됐는지는
/// **연결**의 사실이라 세션마다 반복되지만 세션의 속성이 아니고, 그렇다고 버리면
/// 화면이 페어링 시점의 의도(`attach_key_confinement`)를 관측된 사실처럼 말하게
/// 된다. Tailscale SSH 호스트에서 그 문장이 거짓이었다.
#[derive(Debug, Default)]
pub struct CatalogListing {
    pub sessions: Vec<RemoteSession>,
    /// 게이트웨이가 관측한 값. `None`은 그 필드를 보내지 않는 예전 게이트웨이라
    /// "모른다"는 뜻이다 — `false`로 떨어뜨리면 멀쩡한 서버를 의심하게 만든다.
    pub forced_command_applied: Option<bool>,
}

pub fn read_catalog<R: Read>(source: &mut R) -> Result<CatalogListing, CatalogError> {
    let maximum = FrameLimits::default().max_frame_bytes;
    let mut sessions = Vec::new();
    let mut forced_command_applied = None;
    loop {
        let mut prefix = [0_u8; LENGTH_PREFIX_BYTES];
        match read_exact_or_end(source, &mut prefix)? {
            // EOF on a record boundary: the listing is complete.
            ReadEnd::Ended => {
                return Ok(CatalogListing {
                    sessions,
                    forced_command_applied,
                });
            }
            ReadEnd::Partial => {
                return Err(CatalogError::Truncated {
                    after_records: sessions.len(),
                });
            }
            ReadEnd::Filled => {}
        }

        let length = u32::from_be_bytes(prefix) as usize;
        if length > maximum {
            return Err(CatalogError::Oversized { length, maximum });
        }
        if sessions.len() == MAX_SESSIONS {
            return Err(CatalogError::TooManySessions {
                maximum: MAX_SESSIONS,
            });
        }

        let mut payload = vec![0_u8; length];
        match read_exact_or_end(source, &mut payload)? {
            ReadEnd::Filled => {}
            // A zero-length record is not a clean end — the prefix promised a
            // document and none arrived.
            ReadEnd::Ended | ReadEnd::Partial => {
                return Err(CatalogError::Truncated {
                    after_records: sessions.len(),
                });
            }
        }

        let document: CatalogDocument = match serde_json::from_slice(&payload) {
            Ok(document) => document,
            // Not a record. Before calling it malformed, check whether it is the
            // gateway saying no in the protocol's own error vocabulary — an
            // unsupported request version and a stale pin both arrive this way,
            // and both name a fix that "malformed session listing" would hide.
            Err(error) => match refusal_in(&payload) {
                Some((code, message)) => return Err(CatalogError::Refused { code, message }),
                None => {
                    return Err(CatalogError::Malformed {
                        detail: error.to_string(),
                    });
                }
            },
        };
        if document.gateway_catalog_version > SUPPORTED_CATALOG_VERSION {
            return Err(CatalogError::UnsupportedVersion {
                found: document.gateway_catalog_version,
                supported: SUPPORTED_CATALOG_VERSION,
            });
        }
        // 첫 문서의 값을 쓴다. 모든 문서가 같은 연결에서 나오므로 값도 같고,
        // 뒤 문서가 다른 값을 말한다면 그건 우리가 고칠 수 있는 상태가 아니다 —
        // 첫 값을 지키면 적어도 화면이 스크롤 중에 문장을 바꾸지는 않는다.
        forced_command_applied = forced_command_applied.or(document.forced_command_applied);
        sessions.push(document.session);
    }
}

/// Visible to the crate because [`crate::pairing`] reads the same framing off
/// the same kind of one-shot exec channel. Duplicating this would mean two
/// copies of the one subtlety that makes the terminator sound, and the copy
/// that drifted would report a dropped connection as a shorter document.
pub(crate) enum ReadEnd {
    /// The buffer was filled.
    Filled,
    /// Nothing at all was available — a clean end of stream.
    Ended,
    /// Some bytes arrived and then the stream ended.
    Partial,
}

/// `read_exact`, but able to tell "nothing was there" from "half of it was".
///
/// `Read::read_exact` collapses both into `UnexpectedEof`, and the whole
/// terminator argument for this format rests on being able to distinguish
/// them.
pub(crate) fn read_exact_or_end<R: Read>(
    source: &mut R,
    buffer: &mut [u8],
) -> Result<ReadEnd, CatalogError> {
    if buffer.is_empty() {
        return Ok(ReadEnd::Filled);
    }
    let mut filled = 0;
    while filled < buffer.len() {
        let read = source
            .read(&mut buffer[filled..])
            .map_err(|error| CatalogError::Io {
                detail: error.to_string(),
            })?;
        if read == 0 {
            return Ok(if filled == 0 {
                ReadEnd::Ended
            } else {
                ReadEnd::Partial
            });
        }
        filled += read;
    }
    Ok(ReadEnd::Filled)
}

#[cfg(test)]
mod tests {

    /// 죽은 것이 *증명된* 세션만 목록에서 빠진다.
    ///
    /// 이 시험이 지키는 것은 필터가 아니라 그 방향이다. 모르는 것을 숨기면
    /// 사용자에게는 세션이 사라진 것으로 보이고, 다시 부를 방법이 없다 —
    /// 낡은 게이트웨이(값 없음)와 판정 실패(unknown)가 그 경우다.
    #[test]
    fn only_a_host_proved_gone_is_dropped_from_a_listing() {
        let row = |liveness: Option<&str>| RemoteSession {
            session_id: "s".into(),
            session_name: None,
            workspace_id: "w".into(),
            session_class: CatalogEnum::default(),
            lifecycle: CatalogEnum("ready".into()),
            provider_id: "p".into(),
            launch_program: None,
            host_liveness: liveness.map(str::to_string),
            runner_principal: "r".into(),
            runner_instance: "i".into(),
            channel_epoch: "1".into(),
            host_instance_id: "h".into(),
            terminal_epoch: "t".into(),
            capabilities: Vec::new(),
        };

        let listed = worth_listing(vec![
            row(Some("live")),
            row(Some("absent")),
            row(Some("unknown")),
            row(None),
        ]);

        assert_eq!(
            listed.len(),
            3,
            "only the one proved absent may be dropped: {listed:?}"
        );
        assert!(listed
            .iter()
            .all(|entry| entry.session.host_liveness.as_deref() != Some("absent")));
    }
    use super::*;

    fn record(session_id: &str) -> Vec<u8> {
        framed(&format!(
            r#"{{"gateway_catalog_version":1,"session":{{
                "session_id":"{session_id}","session_name":"작업","workspace_id":"ws-1",
                "session_class":"standalone","lifecycle":"ready","provider_id":"claude",
                "runner_principal":"kattpish","runner_instance":"run-7",
                "channel_epoch":"18446744073709551615","host_instance_id":"host-3",
                "terminal_epoch":"term-2",
                "supported_protocol":{{"minimum":{{"major":1,"minor":0}},"maximum":{{"major":1,"minor":0}}}},
                "capabilities":["working_directory_projection_v1"]}}}}"#
        ))
    }

    fn framed(payload: &str) -> Vec<u8> {
        let bytes = payload.as_bytes();
        let mut encoded = (bytes.len() as u32).to_be_bytes().to_vec();
        encoded.extend_from_slice(bytes);
        encoded
    }

    #[test]
    fn the_listing_request_is_framed_and_names_its_version() {
        // What a forced command cannot take away from this client. Asserted as
        // bytes because the reader is a different codebase — this string *is*
        // the contract, not a rendering of one.
        let request = list_request();
        let (prefix, payload) = request.split_at(LENGTH_PREFIX_BYTES);
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

    #[test]
    fn a_refusal_is_reported_as_one_rather_than_as_a_malformed_listing() {
        // The gateway answers a request it cannot serve with the protocol's own
        // `ErrorFrame`, on the same framing. Calling that "malformed" would
        // throw away the only sentence that says what to fix — here, that the
        // server speaks an older request version than this build sends.
        let refusal = framed(
            r#"{"protocol_version":{"major":1,"minor":0},"frame_id":"1","body":{"kind":"error",
                "payload":{"code":"unsupported_protocol_version",
                "message":"this gateway serves gateway_request_version 1, not 9999",
                "retry":"never","required_capability":null,
                "supported_versions":null,"in_reply_to_request_id":null}}}"#,
        );

        let error = read_catalog(&mut refusal.as_slice()).expect_err("a refusal is not a listing");

        assert_eq!(error.code(), "catalog_refused");
        let CatalogError::Refused { code, message } = error else {
            panic!("a refusal must keep its code and message");
        };
        assert_eq!(code, "unsupported_protocol_version");
        assert!(message.contains("9999"), "{message}");
    }

    #[test]
    fn a_document_that_is_neither_a_record_nor_a_refusal_is_still_malformed() {
        // The refusal path must not become a catch-all: a frame the gateway is
        // not answering with — or plain garbage — has to stay a shape failure,
        // or every parser bug would surface as "the server refused".
        let stray = framed(
            r#"{"protocol_version":{"major":1,"minor":0},"frame_id":"1",
                "body":{"kind":"hello_ack","payload":{}}}"#,
        );

        assert_eq!(
            read_catalog(&mut stray.as_slice())
                .expect_err("a non-catalog document is not a listing")
                .code(),
            "catalog_malformed"
        );
    }

    #[test]
    fn reads_every_record_up_to_a_clean_end() {
        let mut stream = record("alpha");
        stream.extend(record("beta"));

        let sessions = read_catalog(&mut stream.as_slice())
            .expect("a complete listing")
            .sessions;

        assert_eq!(
            sessions
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "beta"]
        );
    }

    #[test]
    fn an_empty_stream_is_a_server_with_no_sessions() {
        let sessions = read_catalog(&mut [].as_slice())
            .expect("an empty listing is not an error")
            .sessions;

        assert!(sessions.is_empty());
    }

    /// The property the format's terminator argument rests on. Without it a
    /// connection dropped mid-listing looks exactly like a shorter listing,
    /// and the user picks from a silently truncated set.
    #[test]
    fn a_record_cut_short_is_truncation_not_a_shorter_listing() {
        let mut stream = record("alpha");
        let complete = stream.len();
        stream.extend(record("beta"));
        stream.truncate(complete + 12);

        let error = read_catalog(&mut stream.as_slice())
            .expect_err("a half-delivered record must not read as the end of the list");

        assert_eq!(error, CatalogError::Truncated { after_records: 1 });
    }

    #[test]
    fn a_length_prefix_cut_short_is_also_truncation() {
        let mut stream = record("alpha");
        stream.extend_from_slice(&[0, 0]);

        let error = read_catalog(&mut stream.as_slice()).expect_err("half a prefix is truncation");

        assert_eq!(error, CatalogError::Truncated { after_records: 1 });
    }

    /// Refused from the prefix alone, before the `vec![0; length]` that would
    /// otherwise be the allocation a remote peer got to choose.
    #[test]
    fn an_oversized_record_is_refused_before_it_is_allocated() {
        let maximum = FrameLimits::default().max_frame_bytes;
        let stream = ((maximum + 1) as u32).to_be_bytes().to_vec();

        let error = read_catalog(&mut stream.as_slice()).expect_err("the cap must hold");

        assert_eq!(
            error,
            CatalogError::Oversized {
                length: maximum + 1,
                maximum
            }
        );
    }

    #[test]
    fn a_newer_catalog_version_is_refused_rather_than_parsed_leniently() {
        let stream = framed(
            r#"{"gateway_catalog_version":4,"session":{"session_id":"a","workspace_id":"w",
               "provider_id":"p","runner_principal":"r","runner_instance":"i",
               "channel_epoch":"1","host_instance_id":"h","terminal_epoch":"t"}}"#,
        );

        let error = read_catalog(&mut stream.as_slice()).expect_err("a future shape is refused");

        assert_eq!(
            error,
            CatalogError::UnsupportedVersion {
                found: 4,
                supported: SUPPORTED_CATALOG_VERSION
            }
        );
    }

    /// `channel_epoch` is `u64` on the wire and travels as decimal text
    /// precisely because a JSON number would round through `f64`. Parsing it
    /// back must not lose the top bits either.
    #[test]
    fn the_fence_carries_channel_epoch_through_u64_exactly() {
        let sessions = read_catalog(&mut record("alpha").as_slice())
            .expect("listing")
            .sessions;

        let fence = sessions[0].fence().expect("fence");

        assert_eq!(fence.channel_epoch, u64::MAX);
        assert_eq!(fence.session_id, "alpha");
        assert_eq!(fence.workspace_id, "ws-1");
        assert_eq!(fence.runner_principal, "kattpish");
        assert_eq!(fence.runner_instance, "run-7");
        assert_eq!(fence.host_instance_id, "host-3");
        assert_eq!(fence.terminal_epoch, "term-2");
    }

    #[test]
    fn an_unparseable_channel_epoch_is_an_error_rather_than_zero() {
        let stream = framed(
            r#"{"gateway_catalog_version":1,"session":{"session_id":"a","workspace_id":"w",
               "provider_id":"p","runner_principal":"r","runner_instance":"i",
               "channel_epoch":"not-a-number","host_instance_id":"h","terminal_epoch":"t"}}"#,
        );
        let sessions = read_catalog(&mut stream.as_slice())
            .expect("listing")
            .sessions;

        let error = sessions[0]
            .fence()
            .expect_err("a bad epoch must not become 0, which the Host would reject as a mismatch");

        assert!(matches!(error, CatalogError::Malformed { .. }));
    }

    /// A lifecycle this build has never heard of must not read as attachable.
    #[test]
    fn an_unknown_lifecycle_is_not_ready() {
        let stream = framed(
            r#"{"gateway_catalog_version":1,"session":{"session_id":"a","workspace_id":"w",
               "lifecycle":"terminating","provider_id":"p","runner_principal":"r",
               "runner_instance":"i","channel_epoch":"1","host_instance_id":"h",
               "terminal_epoch":"t"}}"#,
        );

        let sessions = read_catalog(&mut stream.as_slice())
            .expect("listing")
            .sessions;

        assert!(!sessions[0].is_ready());
        assert_eq!(sessions[0].lifecycle.as_str(), "terminating");
    }

    #[test]
    fn a_ready_session_is_offered() {
        let sessions = read_catalog(&mut record("alpha").as_slice())
            .expect("listing")
            .sessions;

        assert!(sessions[0].is_ready());
    }
}
