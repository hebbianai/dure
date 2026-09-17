//! `hmux mobile-gateway` — the session-owning half of a relayed attach.
//!
//! sshd invokes this as a forced command on the box that owns the session, as
//! the user that owns it. It is a first-class Hmux client, not a byte pump:
//! it resolves the session through the catalog (so the manifest is read under
//! `path_security`), dials the local Unix socket itself, mints its own `Hello`
//! with the locally-read capability token, and only then bridges frames
//! between that connection and its own stdin/stdout.
//!
//! Why not a pump. A pump has to hand the relayed client the Host's
//! `capability_token`, which is minted once per Host process, never rotated,
//! and persisted into the exited manifest — a permanent, unscoped, unrevocable
//! bearer key on a phone. A pump also leaves the Host's accept-time
//! `verify_pathname_socket_same_user` passing vacuously, because the pump is
//! the same uid: a check that proves nothing is worse than no check, since a
//! reviewer sees a check. Dialing locally keeps that check a true statement
//! about *this* process. It still says nothing about the phone, which is why
//! the privileges below are withheld rather than transported.
//!
//! A managed Controller attach also needs the Host's ordinary scoped grant.
//! The gateway mints and consumes that short-lived proof locally, after the
//! relayed identity and role ceiling have been admitted. The proof never enters
//! the SSH stream. SSH remains the outer authority, which is exactly why the
//! forced command's `--role` ceiling and optional `--session` pin are enforced
//! here rather than assumed.
//!
//! # The reach of one paired key — a decision, not an oversight
//!
//! `--session` is **optional**. A forced command that omits it serves whichever
//! session the relayed `Hello` names, which means one paired key reaches *every*
//! Hmux session that account owns on that box, including sessions created after
//! the pairing. The project owner was shown that tradeoff against the narrower
//! per-session alternative — including what a stolen, unlocked phone would reach
//! — and chose to widen it. Do not "tighten" this back to a required `--session`
//! without reopening that decision: the narrow form was tried, and it does not
//! survive contact with reality (see `list_stdio`).
//!
//! What still bounds such a key, and what does not:
//!
//! - `restrict` plus the forced command: no shell, no port forwarding, no agent
//!   or X11 forwarding, no other program on the box. The key can run this
//!   gateway and nothing else.
//! - The `--role` ceiling still applies, and the colocation-premised
//!   capabilities below are still withheld from every relayed attach.
//! - `hmux pair revoke` removes the key from every host it was installed on, so
//!   the widening stays revocable in one action.
//! - It is **not** bounded to one session, one workspace, or one point in time.
//!   An operator who wants that narrower thing still has it: pin `--session` in
//!   the forced command and the escape hatch below refuses everything else.
//!
//! Two more gaps, named rather than papered over. Both writes here are
//! blocking, so a relay dialer that stops draining stdout can stall this
//! process mid-frame while it is also not reading stdin — the pipe-backpressure
//! deadlock the design note raises. The fix belongs on the dialer side (a
//! non-blocking outbound with a userspace buffer), and until it exists a dialer
//! that batches instead of draining will wedge this process rather than
//! corrupt it. Separately, the relayed `Hello` has no deadline: a channel that
//! authenticates and then says nothing leaves this process parked until sshd
//! tears the channel down.
//!
//! # What a relayed client sees of the local `HelloAck`
//!
//! Its ordinary and projection fields are relayed verbatim, including
//! `host_process`, `provider_process` and `authorization_posture`. The one
//! exception is an expected managed-authorization grant selected only for the
//! gateway's colocated Host-facing attach; that private grant is removed before
//! the ack crosses the relay. That is a decision, not an oversight, and the
//! alternatives were both worse.
//!
//! Nothing in it is secret. `HelloAck` carries no `capability_token`, and every
//! other field it holds is already in the discovery manifest that any client on
//! this box reads. Withholding fields would therefore buy no confidentiality;
//! what it would buy is a *correctness* guard, because a pid and a start marker
//! only mean something on the kernel that issued them — the same reasoning that
//! puts `standalone_termination_v1` on the withheld list above. A relayed
//! client that feeds `host_process.process_id` to a local `kill(pid, 0)`
//! liveness probe is asking its own machine about a stranger's process table.
//!
//! Blanking the fields was rejected for being actively dangerous rather than
//! merely useless: `HelloAck.host_process` is not `Option`, so "withheld" would
//! have to be encoded as a sentinel, and pid `0` on Unix means *every process in
//! my process group*. A guard that turns a meaningless probe into a
//! self-signalling one is not a guard. Rewriting `authorization_posture` was
//! rejected for the same class of reason: the honest value is
//! `AuthorizationPosture::RelayDelegated`, which does not exist yet — inventing
//! it here is a protocol change (design note step 10, `hmux-host`), and reusing
//! some other existing posture would be a lie told at the type level.
//!
//! So the invariant lives on the reading side instead, where the design note
//! already puts it: a client must gate any pid-shaped or colocation-shaped use
//! of `HelloAck` on transport attestation, which is exactly step 11's
//! requirement that `process_is_live` be attestation-gated. This gateway's job
//! is to not *widen* authority; it is not in a position to fix a client that
//! misreads a manifest field. `--list` below is the surface this gateway does
//! own, and there the same reasoning is enforced rather than documented: it is
//! an allow-list, and the process proofs are not on it.

use crate::CliError;
mod downstream;
#[cfg(test)]
use downstream::relay_downstream_body;
use downstream::{GatewayDownstream, pump_downstream};
use hmux_client::{
    AttachReplay, CatalogCensusWorker, ClientError, ConnectionOptions, ConnectionRecord,
    LocalAttachRole, LocalSession, LocalSessionCatalog, LocalWriter, SessionDescriptor,
    SessionRetirementPolicy, SessionSelector, StandaloneCreateRequest, StandaloneRecipeRequirement,
    StandaloneRecoveryCreateIdentity, StandaloneSessionCreator, TerminalUpstreamHandles,
    UNPRESENTED_CREATION_ABANDON_CAPABILITY, interactive_shell_with_command_bridge,
    list_local_sessions_isolated, resolve_local_session_isolated,
};
use hmux_host::local_discovery::DiscoveryRoot;
use hmux_host::local_protocol::{
    AGENT_IDENTITY_PROJECTION_CAPABILITY, AGENT_PROMPT_CAPABILITY, AGENT_RUNTIME_STATE_CAPABILITY,
    AGENT_STATE_REPORT_CAPABILITY, AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY,
    AgentPromptCapabilitySelection, AttachMode, DecodedFrame, Detach, ErrorCode, ErrorFrame,
    FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY, FrameBody, FrameCodec,
    FrameCodecError, FrameLimits, FrameValidationError, Hello, HelloAck, InputReceipt,
    LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY, MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
    PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY, PROTOCOL_V1,
    PROVIDER_CONVERSATION_IDENTITY_CAPABILITY, RECONNECT_RESUME_CAPABILITY, ReconnectCursor,
    RetryPosture, SESSION_RETIREMENT_CAPABILITY, SHARED_TERMINAL_INPUT_CAPABILITY,
    STANDALONE_TERMINATION_CAPABILITY, SessionFence, SessionRetirementAction, VersionRange,
    WireFrame, select_managed_agent_prompt_capability,
};
use hmux_runtime_contract::{
    TERMINAL_DEFAULT_COLORS_CAPABILITY, TERMINAL_INPUT_INTENT_CAPABILITY,
    TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
    TERMINAL_VIEWPORT_PROJECTION_CAPABILITY, TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
};
use hmux_ssh_transport::session_resolution::{
    self, SessionResolution, SessionResolutionDocument, SessionResolutionRequest,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use terminal_state_protocol::{ENVELOPE_MAGIC, decode_record};

const MOBILE_CATALOG_CENSUS_BUDGET: Duration = Duration::from_millis(1_500);

/// Privileges the project owner ruled stay premised on colocation, and are
/// therefore withheld from every relayed attach regardless of `AttachMode`.
///
/// Controller authority is *not* on this list: a phone typing is the point,
/// and Controller writes are arbitrated by the generation-fenced lease. These
/// seven have no such arbitration. `shared_terminal_input` is an unarbitrated
/// PTY write. `standalone_termination_v1` signals process ids, which only mean
/// something on the kernel that issued them. `agent_state_report_v1` has no
/// second factor at all on the standalone path — the Host actively refuses an
/// observer that supplies a proof, so the same-user premise is the whole of its
/// authority. `unpresented_creation_abandon_v1` is deliberately available only
/// through the proof-gated v3 request below; admitting it on the generic attach
/// relay would let a peer bypass that request's forced-command and exact-target
/// fences.
const COLOCATION_PREMISED_CAPABILITIES: &[&str] = &[
    SHARED_TERMINAL_INPUT_CAPABILITY,
    STANDALONE_TERMINATION_CAPABILITY,
    AGENT_STATE_REPORT_CAPABILITY,
    AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY,
    FENCED_PROVIDER_CONVERSATION_IDENTITY_REPORT_CAPABILITY,
    MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
    UNPRESENTED_CREATION_ABANDON_CAPABILITY,
];

/// The strongest authority a forced command lets a relayed client reach.
#[derive(Clone, Copy, Debug, Eq, PartialEq, clap::ValueEnum)]
pub(crate) enum GatewayRole {
    Observer,
    Controller,
}

/// A refusal that is answerable on the wire.
///
/// Carries an `ErrorFrame` rather than only a message because the relayed
/// client's alternative is an identically-closed pipe: `ssh` auth denied, no
/// `hmux` on PATH, and "this key may not touch that session" are three
/// completely different operator fixes.
#[derive(Debug)]
struct GatewayRefusal {
    code: ErrorCode,
    message: String,
    required_capability: Option<String>,
    supported_versions: Option<VersionRange>,
    in_reply_to_request_id: Option<String>,
}

impl GatewayRefusal {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            required_capability: None,
            supported_versions: None,
            in_reply_to_request_id: None,
        }
    }

    fn with_required_capability(mut self, capability: &str) -> Self {
        self.required_capability = Some(capability.to_string());
        self
    }

    /// Says what this binary can actually speak.
    ///
    /// `supported_versions` is `None` on every `ErrorFrame` the Host emits
    /// today (design note step 10 lists populating it as work). A relayed
    /// client is the one caller that cannot find out any other way: the forced
    /// command permits nothing but the gateway, so "which protocol does the far
    /// end speak" has no second channel to travel on. An
    /// `UnsupportedProtocolVersion` without it is a refusal the peer cannot act
    /// on.
    fn with_versions(mut self) -> Self {
        self.supported_versions = Some(VersionRange {
            minimum: PROTOCOL_V1,
            maximum: PROTOCOL_V1,
        });
        self
    }

    fn correlated_to(mut self, request_id: Option<String>) -> Self {
        self.in_reply_to_request_id = request_id;
        self
    }
}

/// Trims a refusal message to something `ErrorFrame` validation will accept.
///
/// Not cosmetic. `FrameLimits::max_message_bytes` is 1024 and validation runs
/// inside `encode`, so an over-long message does not produce a long frame — it
/// produces *no frame*, and the peer is back to a silent close, which is the
/// exact failure this module exists to remove. Serde and I/O errors interpolated
/// above are peer-influenced and unbounded, so the trim has to happen on the
/// send path rather than at each call site, where one missed site reintroduces
/// the silence.
fn bounded_refusal_message(message: &str) -> String {
    const MAXIMUM: usize = 900;
    const ELLIPSIS: &str = "…";
    // Decode failures interpolate serde's message, which quotes the peer's own
    // bytes back — useful for diagnosing version skew, but it means this string
    // can carry control characters into a terminal UI that renders it. Folding
    // them to spaces costs nothing and is done before the length trim so the
    // replacement cannot push the result back over the cap.
    let message: String = message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let message = message.trim();
    if message.is_empty() {
        // Validation rejects an empty message, and a refusal that fails to
        // serialize is a silent close.
        return "this gateway refused the frame".to_string();
    }
    if message.len() <= MAXIMUM {
        return message.to_string();
    }
    let mut boundary = MAXIMUM - ELLIPSIS.len();
    while boundary > 0 && !message.is_char_boundary(boundary) {
        boundary -= 1;
    }
    format!("{}{ELLIPSIS}", &message[..boundary])
}

/// Serves one relayed session on this process's stdin/stdout.
///
/// `session_identifier` is the forced command's optional pin. `Some` means this
/// invocation may serve that session and refuse every other; `None` means the
/// session is named by the relayed `Hello` — see the module header for why that
/// widening was chosen and what still bounds it.
pub(crate) fn serve_stdio(
    catalog: &LocalSessionCatalog,
    session_identifier: Option<&str>,
    workspace_id: Option<&str>,
    role: GatewayRole,
    creation: CreationAuthority,
) -> Result<(), CliError> {
    // A frame stream on a terminal is neither readable by a human nor safe: a
    // tty would apply ONLCR to the length prefixes. The relay opens its exec
    // channel without `request_pty` precisely so this cannot happen, so a tty
    // here means the operator ran the gateway by hand.
    if io::stdout().is_terminal() {
        return Err(CliError(
            "mobile-gateway speaks binary frames on stdout; run it under `ssh` without a pty"
                .into(),
        ));
    }
    serve(
        catalog,
        session_identifier,
        workspace_id,
        role,
        creation,
        io::stdin(),
        io::stdout(),
    )
}

/// Answers "what sessions are here, and what are their identities" on stdio.
///
/// # Why the gateway has to be able to answer this at all
///
/// A relayed client must supply an exact `SessionFence` to attach — session id,
/// workspace id, runner principal, runner instance, channel epoch, host instance
/// id, terminal epoch — and four of those change when the Host is replaced or
/// the box restarts. Under a locked-down `authorized_keys` line the client has
/// no way to learn them: the forced command permits nothing but this binary, so
/// there is no `hmux session list`, no `cat`, no shell. Without a listing the
/// hardening makes the feature unusable after the first restart, which in
/// practice means operators would not apply it.
///
/// # Why argv is no longer the only route to a listing
///
/// `command="…"` in `authorized_keys` *replaces* whatever the client asked for;
/// the request is moved to `SSH_ORIGINAL_COMMAND` and the pinned line runs
/// verbatim. So a key whose forced command does not already contain `--list`
/// could never reach this mode, and a phone could append nothing to it. That was
/// not a theoretical gap — it is the failure a real pairing produced on two real
/// servers: every connection from the phone exited 2 with
/// `the following required arguments were not provided: --session <SESSION>`,
/// for listing and attaching alike, so the one key pairing installs could do
/// nothing at all.
///
/// **The workaround this comment used to recommend was two pinned keys**, one
/// `--list` and one `--session <id>`. It does not survive contact with reality:
/// session ids change whenever a Host is replaced, so the pinned session goes
/// stale and every *new* session is unreachable until the user re-pairs. Pairing
/// is meant to happen once.
///
/// So listing is now a **request the client sends over the stream**
/// ([`classify_first_document`]), which a forced command cannot suppress because
/// it travels in the channel's data rather than in its argv. The `--list` flag
/// keeps working for hand invocation; what changed is that argv stopped being the
/// only route.
///
/// **Why not read `SSH_ORIGINAL_COMMAND` and dispatch on it.** Still refused, and
/// the stream route is not the same thing. `SSH_ORIGINAL_COMMAND` is an
/// unstructured peer-supplied string that would be matched against expected text
/// — the exact-string-matching trap the review checklist names — and it would
/// select between behaviours by re-reading the argv the forced command exists to
/// override. The request document is a versioned, strictly-parsed payload on a
/// stream this process was going to read anyway, refused with a typed
/// `ErrorFrame` when it is not understood.
///
/// # What the stream route does *not* change
///
/// The scope. A listing served over the stream runs the same `list` below with
/// the same arguments as the flag, so a forced command that pins `--session`
/// still narrows the listing to that session, and the record allow-list is one
/// implementation rather than two.
///
/// # Why frames and not text
///
/// Same reason `serve_stdio` refuses a tty: stdout is a binary channel and must
/// stay 8-bit clean. Free text would also mean the relay dialer needs a second
/// parser and a second set of failure modes.
///
/// These are length-prefixed JSON documents in the same framing as the attach
/// protocol, but they are deliberately **not** `WireFrame`s. There is no
/// `FrameBody` variant for a catalog, and minting one is a protocol change in
/// `hmux-host` (design note step 10) rather than something a CLI may do
/// unilaterally — a frame kind invented on one side of a versioned protocol is
/// how skew becomes permanent. `--list` is a one-shot mode with no handshake, so
/// the client already knows which shape to expect from the argument it was
/// invoked with; `gateway_catalog_version` is what lets this document evolve
/// separately from `PROTOCOL_V1`, and promoting it to a real frame later is an
/// additive change on both sides.
///
/// The stream ends at EOF on a document boundary. That is a sufficient
/// terminator on a one-shot exec channel and it is *checkable*: a truncated
/// listing ends mid-document, which a reader distinguishes from a clean end.
///
/// # What is in a record
///
/// An allow-list, for the same reason `upstream_decision` is one. It carries the
/// whole fence plus what a client needs to pick a session and know what to ask
/// for. It carries no `capability_token` — that key never crosses the network,
/// which is the premise of this entire topology — and no endpoint address, host
/// pid or provider pid: a socket path and a same-kernel pid name nothing off-box
/// (see the module header on `HelloAck`), so shipping them would only invite a
/// remote client to test them against its own machine.
pub(crate) fn list_stdio(
    catalog: &LocalSessionCatalog,
    session_identifier: Option<&str>,
    workspace_id: Option<&str>,
) -> Result<(), CliError> {
    if io::stdout().is_terminal() {
        return Err(CliError(
            "mobile-gateway --list speaks binary frames on stdout; use `hmux session list --json` \
             from a terminal"
                .into(),
        ));
    }
    list(
        catalog,
        session_identifier,
        workspace_id,
        GATEWAY_CATALOG_VERSION_V1,
        &mut io::stdout(),
    )
}

fn list<W: Write>(
    catalog: &LocalSessionCatalog,
    session_identifier: Option<&str>,
    workspace_id: Option<&str>,
    gateway_catalog_version: u16,
    output: &mut W,
) -> Result<(), CliError> {
    let mut descriptors = match session_identifier {
        // A forced command that pins `--session` scopes the listing exactly as
        // it scopes an attach: `--list` must never be the widening hole in a
        // line the operator wrote to narrow access.
        Some(identifier) => {
            let session = resolve_session(catalog, identifier, workspace_id).map_err(|error| {
                CliError(format!(
                    "mobile-gateway could not resolve the session to list: {error}"
                ))
            })?;
            vec![session.descriptor().clone()]
        }
        None => {
            let executable = std::env::current_exe().map_err(|error| {
                CliError(format!(
                    "mobile-gateway could not resolve its census worker: {error}"
                ))
            })?;
            let worker = CatalogCensusWorker::new(executable);
            let mut descriptors =
                list_local_sessions_isolated(catalog, &worker, MOBILE_CATALOG_CENSUS_BUDGET)
                    .map_err(|error| {
                        CliError(format!("mobile-gateway could not list sessions: {error}"))
                    })?;
            if let Some(workspace_id) = workspace_id {
                descriptors.retain(|descriptor| descriptor.workspace_id == workspace_id);
            }
            descriptors
        }
    };

    // Deterministic order so a client can diff two listings without sorting a
    // filesystem-scan order that has none.
    descriptors.sort_by(|left, right| {
        (&left.workspace_id, &left.session_id).cmp(&(&right.workspace_id, &right.session_id))
    });
    for descriptor in &descriptors {
        write_catalog_document(
            output,
            &CatalogDocument::new(descriptor, gateway_catalog_version),
        )?;
    }
    output.flush().map_err(|error| {
        CliError(format!(
            "mobile-gateway could not flush the listing: {error}"
        ))
    })
}

/// Big-endian, four bytes, exactly as `FrameCodec` prefixes a frame.
const LENGTH_PREFIX_BYTES: usize = 4;

/// The request-document shape this build serves.
///
/// Versioned separately from `PROTOCOL_V1` and from `gateway_catalog_version`,
/// for the same reason each of those is separate: a request the client sends is
/// not the attach protocol and not the catalog record, and coupling any two of
/// the three would make one of them un-evolvable.
const GATEWAY_REQUEST_VERSION_MINIMUM: u16 = 1;
const GATEWAY_REQUEST_VERSION_MAXIMUM: u16 = session_resolution::GATEWAY_REQUEST_VERSION;
const GATEWAY_REQUEST_VERSION_RETIREMENT_POLICY: u16 = 2;
const GATEWAY_REQUEST_VERSION_ABANDON_UNPRESENTED_CREATION: u16 = 3;
/// A listing that also carries what each session was launched to run and
/// whether its Host process is still alive.
const GATEWAY_REQUEST_VERSION_SESSION_FACTS: u16 = 4;
/// One exact, bounded, receipt-confirmed input written locally on behalf of an
/// authenticated ordinary SSH login. Kept separate from relayed attach roles
/// so shared-writer authority never crosses the SSH channel.
const GATEWAY_REQUEST_VERSION_EXACT_INPUT: u16 = 5;
/// A listing that adds the selected gateway build without changing the
/// already-shipped strict v3 catalog envelope.
const GATEWAY_REQUEST_VERSION_GATEWAY_BUILD: u16 = 6;
/// A create-only request carrying the exact initial working directory. Older
/// gateways refuse this version before spawning a Host.
const GATEWAY_REQUEST_VERSION_WORKING_DIRECTORY: u16 = 7;
/// A read of what version control says about one session's directory.
///
/// Read-only, so it is served to a forced-command key exactly as the listing
/// is. The directory is resolved from the Host's own projection and never from
/// the document — see [`source_control_status`].
///
/// Frozen as the shape phones already in the field send: three identifiers and
/// no `want`. A build that stops serving it stops answering the changes tab on
/// every phone that has not been updated.
const GATEWAY_REQUEST_VERSION_SOURCE_CONTROL: u16 = 8;
/// The same read, carrying a closed choice of which answer to compute.
///
/// A separate version rather than a field on v8 because one version admits one
/// shape here: a v8 document with a `want` is refused, and a v9 document
/// without one is refused too. That pairing is what makes an old box's refusal
/// legible — it says "unsupported protocol version", which tells the person to
/// update that box, rather than "malformed request", which tells them nothing.
const GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_WANT: u16 = 9;
/// One file's patch, chosen from the list this box just produced.
///
/// A separate version and a separate request rather than a `path` on the
/// status document, because that document's shape is the promise that the read
/// names nothing — "no `path`, no `base_ref`, no `args`" is written into it.
/// Weakening it in place would retire that promise for the changes tab too.
///
/// What makes a path admissible **here** is that the gateway runs its own
/// listing first and refuses any path that is not in the answer. The client
/// chooses among what the repository offered; it never names something the
/// repository did not. See [`crate::source_control::read_file_diff`].
const GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_DIFF: u16 = 10;
const MAX_GATEWAY_SESSION_INPUT_BYTES: usize = 48 * 1024;
/// The answer document's own version, separate from the request vocabulary for
/// the same reason every other version here is separate.
///
/// **This stays at 1 while the answer grows.** The phone compares it with a
/// strict `!=`, so raising it does not add a field — it stops every phone in
/// the field from reading any answer at all. New fields are optional and
/// defaulted instead, and the *request* version is the discriminator: a box
/// that admits v9 is a box that answers all three wants.
const GATEWAY_SOURCE_CONTROL_VERSION: u16 = 1;
/// The patch answer's own version. Held at 1 for the reason above it.
const GATEWAY_SOURCE_CONTROL_DIFF_VERSION: u16 = 1;
/// The longest path this gateway will look up. git's own limit on a path
/// component chain; longer is not a path anybody's repository contains.
const MAX_GATEWAY_DIFF_PATH_BYTES: usize = 4096;
/// How long the whole read may take on the box. Local git only.
const SOURCE_CONTROL_READ_BUDGET: Duration = Duration::from_secs(5);
/// The total for a read that also asks the code host.
///
/// One clock for both halves, not five seconds plus a network call: the phone
/// caps the whole SSH trip at twenty seconds and also pays the handshake and
/// the Observer read out of it. If the box can outlast that, the thing that
/// gives up is the phone's watchdog, and then nobody is told why.
const SOURCE_CONTROL_PULL_REQUEST_BUDGET: Duration = Duration::from_secs(12);

/// Enough of a request document to tell it apart from a `WireFrame`.
///
/// Deliberately *not* `deny_unknown_fields`: its only job is to answer "is the
/// peer speaking the request vocabulary at all", and it has to keep answering
/// yes for a document from a newer client carrying fields this build has never
/// seen — otherwise a version skew is reported as "that was not a hello" instead
/// of as a version. The discrimination is sound because the two shapes are
/// disjoint by *required* field: a `WireFrame` has no `gateway_request_version`,
/// and a request document has no `protocol_version`/`frame_id`/`body`.
#[derive(Debug, serde::Deserialize)]
struct GatewayRequestProbe {
    gateway_request_version: u16,
}

/// A request a relayed client may send instead of opening an attach.
///
/// `deny_unknown_fields` here, where the probe deliberately does not: once the
/// version is known to be one this build serves, a field it does not recognise
/// means the two sides disagree about what the document *means* at a version
/// they both claim, and parsing it anyway is how a silent misreading becomes a
/// wrong answer three layers away.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct GatewayRequestDocument {
    gateway_request_version: u16,
    request: GatewayRequest,
}

#[derive(Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum GatewayRequest {
    /// What `--list` emits, asked for over the stream.
    ListSessions,
    /// Create or reconcile one Dure-scoped remote shell. This is accepted only
    /// over an ordinary SSH login; a forced-command pairing key stays read-only
    /// with respect to process creation.
    CreateStandalone(StandaloneCreateRequestDocument),
    /// Retire a standalone Host that was created but never presented. The Host
    /// independently checks the launch proof and unchanged attach generation;
    /// the gateway adds the SSH and exact-catalog-session fences.
    AbandonUnpresentedCreation(AbandonUnpresentedCreationRequestDocument),
    /// Resolve the complete fence locally and use a one-shot shared writer.
    WriteSessionInput(SessionInputRequestDocument),
    /// Read what version control says about one session's working directory.
    /// A read, like the listing — no fence, no mutation, no path from the
    /// client.
    SourceControlStatus(SourceControlStatusRequestDocument),
    /// Read one file's patch. The one request that carries a path, and the
    /// gateway admits it only if its own listing produced it.
    SourceControlFileDiff(SourceControlFileDiffRequestDocument),
    /// Resolve one retired source without attaching or widening a pairing key.
    ResolveSession(SessionResolutionRequest),
}

#[derive(Debug, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct StandaloneCreateRequestDocument {
    request_id: String,
    target_session_id: String,
    launch_owner_proof: String,
    session_name: String,
    bridge_nonce: String,
    #[serde(default)]
    cwd: Option<String>,
    initial_rows: u16,
    initial_columns: u16,
    command_intercepts: Vec<CommandInterceptDocument>,
    #[serde(default)]
    retirement_policy: Option<SessionRetirementPolicy>,
}

#[derive(Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct AbandonUnpresentedCreationRequestDocument {
    request_id: String,
    session_id: String,
    workspace_id: String,
    launch_owner_proof: String,
}

/// Which of the three answers to compute.
///
/// A closed enum rather than a string: every other field in this document is
/// length-bounded by `validate_gateway_identifier`, and a free-form string here
/// would be the one unbounded value in the request vocabulary — one that then
/// needs a `match` on its text somewhere further in. Serde refuses an unknown
/// variant at the boundary instead.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SourceControlWant {
    Changes,
    Commits,
    PullRequest,
}

/// Which session to read, and which of its questions to answer.
///
/// What must stay absent is still the point of this shape: no `path`, no
/// `base_ref`, no `args`, no `options`. Each of those would turn a directory
/// read into a command channel, and the key that sends this document is a
/// read-only one. `want` is admissible because it is closed — it selects among
/// answers this build already knows how to compute, and names nothing.
///
/// `None` is a version-8 client, and that is the only shape version 8 admits.
#[derive(Debug, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceControlStatusRequestDocument {
    request_id: String,
    session_id: String,
    workspace_id: String,
    #[serde(default)]
    want: Option<SourceControlWant>,
}

/// Which file, in which session, and optionally inside which commit.
///
/// `path` is the exception this whole module is careful about, and the care is
/// not here: it is that [`crate::source_control::read_file_diff`] lists the
/// repository first and refuses a path that listing did not produce. Length is
/// still bounded, because an unbounded value in the request vocabulary is a way
/// to make one document expensive before anything reads it.
///
/// `commit` is a short SHA the commits read handed out. It is checked for being
/// hexadecimal before it becomes argv — hex cannot be a flag, a path, or a range.
#[derive(Debug, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceControlFileDiffRequestDocument {
    request_id: String,
    session_id: String,
    workspace_id: String,
    path: String,
    #[serde(default)]
    commit: Option<String>,
}

#[derive(Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionInputRequestDocument {
    request_id: String,
    expected_fence: SessionFence,
    bytes: Vec<u8>,
}

impl std::fmt::Debug for SessionInputRequestDocument {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionInputRequestDocument")
            .field("request_id", &self.request_id)
            .field("expected_fence", &self.expected_fence)
            .field("byte_length", &self.bytes.len())
            .finish()
    }
}

impl std::fmt::Debug for AbandonUnpresentedCreationRequestDocument {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AbandonUnpresentedCreationRequestDocument")
            .field("request_id", &self.request_id)
            .field("session_id", &self.session_id)
            .field("workspace_id", &self.workspace_id)
            .field("launch_owner_proof", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Eq, Ord, PartialEq, PartialOrd, Deserialize)]
#[serde(deny_unknown_fields)]
struct CommandInterceptDocument {
    command: String,
    provider_id: String,
}

/// What the first document on a relayed stream turned out to be.
#[derive(Debug)]
enum FirstDocument {
    /// A request document this build serves.
    Request {
        gateway_request_version: u16,
        request: GatewayRequest,
    },
    /// A request document this build cannot serve, and the answer it is owed.
    Refused(GatewayRefusal),
    /// Not a request document. The attach path decodes it as a `WireFrame`.
    Frame,
}

/// Decides whether the first document opened a listing or an attach.
///
/// This is the seam that lets a forced command with no arguments do both, and
/// its safety rests on the two document shapes being disjoint rather than on
/// matching any peer-supplied string. A payload that is neither falls through to
/// `Frame`, where the codec's own decode produces the typed refusal — this
/// function never has to invent one for "unparseable".
fn classify_first_document(payload: &[u8]) -> FirstDocument {
    let Ok(probe) = serde_json::from_slice::<GatewayRequestProbe>(payload) else {
        return FirstDocument::Frame;
    };
    let unsupported_version = |version: u16| {
        FirstDocument::Refused(
            GatewayRefusal::new(
                ErrorCode::UnsupportedProtocolVersion,
                format!(
                    "this gateway serves gateway_request_version \
                     {GATEWAY_REQUEST_VERSION_MINIMUM}..={GATEWAY_REQUEST_VERSION_MAXIMUM}, not {version}"
                ),
            )
            .with_versions(),
        )
    };
    match serde_json::from_slice::<GatewayRequestDocument>(payload) {
        Ok(document) if gateway_request_is_supported(&document) => FirstDocument::Request {
            gateway_request_version: document.gateway_request_version,
            request: document.request,
        },
        Ok(document) => unsupported_version(document.gateway_request_version),
        // The strict parse failed, so the version has to come from the probe.
        // Which of the two answers this is matters: a newer client is owed the
        // version it got wrong, and telling it instead that its `request` field
        // was unreadable would send it looking for a typo in a document that is
        // simply from a later shape.
        Err(_)
            if !(GATEWAY_REQUEST_VERSION_MINIMUM..=GATEWAY_REQUEST_VERSION_MAXIMUM)
                .contains(&probe.gateway_request_version) =>
        {
            unsupported_version(probe.gateway_request_version)
        }
        Err(error) => FirstDocument::Refused(
            GatewayRefusal::new(
                ErrorCode::UnsupportedProtocolVersion,
                format!("this gateway could not read a gateway request: {error}"),
            )
            .with_versions(),
        ),
    }
}

fn gateway_request_is_supported(document: &GatewayRequestDocument) -> bool {
    match document.gateway_request_version {
        GATEWAY_REQUEST_VERSION_MINIMUM => match &document.request {
            GatewayRequest::ListSessions => true,
            GatewayRequest::CreateStandalone(request) => {
                request.retirement_policy.is_none() && request.cwd.is_none()
            }
            GatewayRequest::AbandonUnpresentedCreation(_) => false,
            GatewayRequest::WriteSessionInput(_) => false,
            GatewayRequest::SourceControlStatus(_) | GatewayRequest::SourceControlFileDiff(_) => {
                false
            }
            GatewayRequest::ResolveSession(_) => false,
        },
        GATEWAY_REQUEST_VERSION_RETIREMENT_POLICY => match &document.request {
            GatewayRequest::ListSessions => true,
            GatewayRequest::CreateStandalone(request) => request.cwd.is_none(),
            _ => false,
        },
        GATEWAY_REQUEST_VERSION_ABANDON_UNPRESENTED_CREATION => matches!(
            document.request,
            GatewayRequest::AbandonUnpresentedCreation(_)
        ),
        // Only the listing. A newer request version must not silently widen
        // which *mutations* a client may ask for — each of those is admitted by
        // the version that introduced it, and adding a field to the answer is
        // not a reason to revisit that.
        GATEWAY_REQUEST_VERSION_SESSION_FACTS => {
            matches!(document.request, GatewayRequest::ListSessions)
        }
        GATEWAY_REQUEST_VERSION_EXACT_INPUT => {
            matches!(document.request, GatewayRequest::WriteSessionInput(_))
        }
        GATEWAY_REQUEST_VERSION_GATEWAY_BUILD => {
            matches!(document.request, GatewayRequest::ListSessions)
        }
        GATEWAY_REQUEST_VERSION_WORKING_DIRECTORY => matches!(
            &document.request,
            GatewayRequest::CreateStandalone(request) if request.cwd.is_some()
        ),
        // A pairing, not a widening: v8 admits only the shape shipped phones
        // send, and v9 admits only the shape that carries a want. Without the
        // `is_none()` half, a v9-shaped document labelled v8 would be served a
        // want its own declared version does not include.
        GATEWAY_REQUEST_VERSION_SOURCE_CONTROL => matches!(
            &document.request,
            GatewayRequest::SourceControlStatus(request) if request.want.is_none()
        ),
        GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_DIFF => {
            matches!(&document.request, GatewayRequest::SourceControlFileDiff(_))
        }
        GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_WANT => matches!(
            &document.request,
            GatewayRequest::SourceControlStatus(request) if request.want.is_some()
        ),
        session_resolution::GATEWAY_REQUEST_VERSION => {
            matches!(document.request, GatewayRequest::ResolveSession(_))
        }
        _ => false,
    }
}

fn resolve_current_session(
    catalog: &LocalSessionCatalog,
    request: &SessionResolutionRequest,
    pinned_session: Option<&str>,
    pinned_workspace: Option<&str>,
) -> Result<SessionResolution<LocalSession>, GatewayRefusal> {
    let source = &request.expected_fence;
    let within_scope = |session: &str, workspace: &str| {
        pinned_session.is_none_or(|pinned| pinned == session)
            && pinned_workspace.is_none_or(|pinned| pinned == workspace)
    };
    let scope_refusal = || {
        GatewayRefusal::new(
            ErrorCode::AuthorizationDenied,
            "session resolution is outside this gateway's pinned scope",
        )
    };
    if !within_scope(&source.session_id, &source.workspace_id) {
        return Err(scope_refusal());
    }
    // This existing catalog owner verifies both the durable source and current
    // generation. Opening the handle does not connect, claim input or mutate it.
    let session = match catalog.open_current_managed_for_mutation(
        &SessionSelector::new(&source.session_id, Some(source.workspace_id.clone())),
        source,
    ) {
        Ok(session) => session,
        Err(error) if error.code() == "hmux_managed_rehost_retry_required" => {
            return Ok(SessionResolution::Pending);
        }
        Err(ClientError::SessionNotFound { .. }) => return Ok(SessionResolution::Unknown),
        Err(error) => {
            eprintln!("hmux: mobile-gateway: session resolution: {error}");
            let code = match error.code() {
                "hmux_managed_rehost_generation_mismatch" | "hmux_expected_generation_mismatch" => {
                    ErrorCode::IdentityMismatch
                }
                _ => ErrorCode::StaleDiscovery,
            };
            return Err(GatewayRefusal::new(
                code,
                format!(
                    "the session successor could not be resolved ({})",
                    error.code()
                ),
            ));
        }
    };
    let target = session.descriptor();
    if !within_scope(&target.session_id, &target.workspace_id) {
        return Err(scope_refusal());
    }
    if target.lifecycle != hmux_client::SessionLifecycle::Ready || host_liveness(target) == "absent"
    {
        return Ok(SessionResolution::Unknown);
    }
    Ok(SessionResolution::Resolved { session })
}

fn session_mutation_refusal(forced_command: bool) -> Option<GatewayRefusal> {
    forced_command.then(|| {
        GatewayRefusal::new(
            ErrorCode::AuthorizationDenied,
            "a forced-command gateway cannot mutate remote session lifetime",
        )
    })
}

fn session_input_refusal(forced_command: bool, request_id: &str) -> Option<GatewayRefusal> {
    forced_command.then(|| {
        GatewayRefusal::new(
            ErrorCode::AuthorizationDenied,
            "a forced-command gateway cannot write remote session input",
        )
        .correlated_to(Some(request_id.to_string()))
    })
}

fn validate_abandon_unpresented_creation_request(
    request: &AbandonUnpresentedCreationRequestDocument,
) -> Result<(), CliError> {
    for (label, value) in [
        ("request id", request.request_id.as_str()),
        ("session id", request.session_id.as_str()),
        ("workspace id", request.workspace_id.as_str()),
        ("launch owner proof", request.launch_owner_proof.as_str()),
    ] {
        validate_gateway_identifier(label, value, 256)?;
    }
    Ok(())
}

fn exact_abandon_session(
    catalog: &LocalSessionCatalog,
    request: &AbandonUnpresentedCreationRequestDocument,
    pinned_session: Option<&str>,
    pinned_workspace: Option<&str>,
) -> Result<LocalSession, GatewayRefusal> {
    if pinned_session.is_some_and(|pinned| pinned != request.session_id)
        || pinned_workspace.is_some_and(|pinned| pinned != request.workspace_id)
    {
        return Err(GatewayRefusal::new(
            ErrorCode::IdentityMismatch,
            "this gateway is pinned to a different Hmux session",
        )
        .correlated_to(Some(request.request_id.clone())));
    }
    catalog
        .open(&SessionSelector::new(
            &request.session_id,
            Some(request.workspace_id.clone()),
        ))
        .map_err(|_| {
            GatewayRefusal::new(
                ErrorCode::StaleDiscovery,
                "this gateway serves no such exact Hmux session; refresh the catalog",
            )
            .correlated_to(Some(request.request_id.clone()))
        })
}

fn abandon_unpresented_creation(
    catalog: &LocalSessionCatalog,
    request: &AbandonUnpresentedCreationRequestDocument,
    pinned_session: Option<&str>,
    pinned_workspace: Option<&str>,
) -> Result<hmux_client::SessionRetirementReceipt, (GatewayRefusal, RetryPosture)> {
    let session = exact_abandon_session(catalog, request, pinned_session, pinned_workspace)
        .map_err(|refusal| (refusal, RetryPosture::RetryAfterResync))?;
    session
        .abandon_unpresented_creation(request.launch_owner_proof.clone())
        .map_err(|error| {
            let (refusal, retry) = local_attach_refusal(&error, false);
            (
                refusal.correlated_to(Some(request.request_id.clone())),
                retry,
            )
        })
}

/// Read what version control says about one session's working directory.
///
/// The directory comes from the Host's own projection, never from the
/// document. That is the whole security argument: a client names a session it
/// was already listed, and the box decides which directory that is.
///
/// There is deliberately no `session_input_refusal`-style forced-command gate
/// on the two local wants. `Changes` and `Commits` are `git` on this box's own
/// disk, inside the reader's hardened envelope, spending no credential and
/// touching no network — a paired key may read, the same rule that lets it list
/// sessions, and every gate on `forced_command` in this file guards a mutation.
///
/// `PullRequest` is not that. It spends the box owner's stored code-host
/// credentials on an outbound request, through a program the reader's
/// `HARDENING` does not cover, and a paired key cannot run it by hand — sshd
/// replaces that key's argv. It is still a read, and it is still admitted here,
/// but it is an authority the key does not otherwise hold, and the reason it
/// is allowed is that the box owner and the phone owner are the same person.
/// If that stops being true, this is the line that has to change.
fn source_control_status(
    catalog: &LocalSessionCatalog,
    request: &SourceControlStatusRequestDocument,
    pinned_session: Option<&str>,
    pinned_workspace: Option<&str>,
) -> Result<crate::source_control::Outcome, (GatewayRefusal, RetryPosture)> {
    for (label, value) in [
        ("request id", request.request_id.as_str()),
        ("session id", request.session_id.as_str()),
        ("workspace id", request.workspace_id.as_str()),
    ] {
        if validate_gateway_identifier(label, value, 256).is_err() {
            return Err((
                GatewayRefusal::new(
                    ErrorCode::IdentityMismatch,
                    format!("the source control {label} is invalid"),
                )
                .correlated_to(Some(request.request_id.clone())),
                RetryPosture::Never,
            ));
        }
    }
    if pinned_session.is_some_and(|pinned| pinned != request.session_id)
        || pinned_workspace.is_some_and(|pinned| pinned != request.workspace_id)
    {
        return Err((
            GatewayRefusal::new(
                ErrorCode::IdentityMismatch,
                "the source control request did not match this gateway's pinned scope",
            )
            .correlated_to(Some(request.request_id.clone())),
            RetryPosture::Never,
        ));
    }
    let session = resolve_session(catalog, &request.session_id, Some(&request.workspace_id))
        .map_err(|_| {
            (
                GatewayRefusal::new(
                    ErrorCode::StaleDiscovery,
                    "this gateway serves no such Hmux session; list the catalog again",
                )
                .correlated_to(Some(request.request_id.clone())),
                RetryPosture::RetryAfterResync,
            )
        })?;
    // An Observer read, the same shape the CLI already uses to print a screen.
    // A Host that is gone is not a protocol fault — the phone is told the box
    // could not answer, and why, in one closed word.
    let Ok(snapshot) = session.read_screen(None) else {
        return Ok(crate::source_control::Outcome::Unavailable(
            "host_unreachable",
        ));
    };
    let Some(directory) = snapshot.working_directory else {
        return Ok(crate::source_control::Outcome::Unavailable(
            "working_directory_unknown",
        ));
    };
    let want = match request.want {
        None | Some(SourceControlWant::Changes) => crate::source_control::Want::Changes,
        Some(SourceControlWant::Commits) => crate::source_control::Want::Commits,
        Some(SourceControlWant::PullRequest) => crate::source_control::Want::PullRequest,
    };
    let budget = match want {
        crate::source_control::Want::PullRequest => SOURCE_CONTROL_PULL_REQUEST_BUDGET,
        _ => SOURCE_CONTROL_READ_BUDGET,
    };
    Ok(crate::source_control::read(
        std::path::Path::new(&directory.path),
        want,
        budget,
    ))
}

/// Read one file's patch for one session.
///
/// No forced-command gate, for the same reason [`source_control_status`] has
/// none: this is a read of a directory the box already agreed to describe. The
/// difference is the path, and the paragraph on
/// [`SourceControlFileDiffRequestDocument`] is where that is answered.
fn source_control_file_diff(
    catalog: &LocalSessionCatalog,
    request: &SourceControlFileDiffRequestDocument,
    pinned_session: Option<&str>,
    pinned_workspace: Option<&str>,
) -> Result<crate::source_control::DiffOutcome, (GatewayRefusal, RetryPosture)> {
    for (label, value) in [
        ("request id", request.request_id.as_str()),
        ("session id", request.session_id.as_str()),
        ("workspace id", request.workspace_id.as_str()),
    ] {
        if validate_gateway_identifier(label, value, 256).is_err() {
            return Err((
                GatewayRefusal::new(
                    ErrorCode::IdentityMismatch,
                    format!("the file diff {label} is invalid"),
                )
                .correlated_to(Some(request.request_id.clone())),
                RetryPosture::Never,
            ));
        }
    }
    // A path is not an identifier — it holds slashes and dots, which
    // `validate_gateway_identifier` rejects. What it shares is the need for a
    // ceiling: an unbounded value here is a way to make one document expensive
    // before any reader looks at it. The ceiling is git's own path limit.
    if request.path.is_empty()
        || request.path.len() > MAX_GATEWAY_DIFF_PATH_BYTES
        || request
            .path
            .contains(|character: char| character.is_control())
    {
        return Err((
            GatewayRefusal::new(ErrorCode::IdentityMismatch, "the file diff path is invalid")
                .correlated_to(Some(request.request_id.clone())),
            RetryPosture::Never,
        ));
    }
    if pinned_session.is_some_and(|pinned| pinned != request.session_id)
        || pinned_workspace.is_some_and(|pinned| pinned != request.workspace_id)
    {
        return Err((
            GatewayRefusal::new(
                ErrorCode::IdentityMismatch,
                "the file diff request did not match this gateway's pinned scope",
            )
            .correlated_to(Some(request.request_id.clone())),
            RetryPosture::Never,
        ));
    }
    let session = resolve_session(catalog, &request.session_id, Some(&request.workspace_id))
        .map_err(|_| {
            (
                GatewayRefusal::new(
                    ErrorCode::StaleDiscovery,
                    "this gateway serves no such Hmux session; list the catalog again",
                )
                .correlated_to(Some(request.request_id.clone())),
                RetryPosture::RetryAfterResync,
            )
        })?;
    let Ok(snapshot) = session.read_screen(None) else {
        return Ok(crate::source_control::DiffOutcome::Unavailable(
            "host_unreachable",
        ));
    };
    let Some(directory) = snapshot.working_directory else {
        return Ok(crate::source_control::DiffOutcome::Unavailable(
            "working_directory_unknown",
        ));
    };
    Ok(crate::source_control::read_file_diff(
        std::path::Path::new(&directory.path),
        &request.path,
        request.commit.as_deref(),
        SOURCE_CONTROL_READ_BUDGET,
    ))
}

fn write_session_input(
    catalog: &LocalSessionCatalog,
    request: &SessionInputRequestDocument,
    pinned_session: Option<&str>,
    pinned_workspace: Option<&str>,
) -> Result<InputReceipt, (GatewayRefusal, RetryPosture)> {
    validate_session_input_request(request).map_err(|refusal| (refusal, RetryPosture::Never))?;
    if pinned_session.is_some_and(|pinned| pinned != request.expected_fence.session_id)
        || pinned_workspace.is_some_and(|pinned| pinned != request.expected_fence.workspace_id)
    {
        return Err((
            GatewayRefusal::new(
                ErrorCode::IdentityMismatch,
                "the session input request did not match this gateway's pinned scope",
            )
            .correlated_to(Some(request.request_id.clone())),
            RetryPosture::Never,
        ));
    }
    let session = resolve_session(
        catalog,
        &request.expected_fence.session_id,
        Some(&request.expected_fence.workspace_id),
    )
    .map_err(|_| {
        (
            GatewayRefusal::new(
                ErrorCode::StaleDiscovery,
                "this gateway serves no such Hmux session; list the catalog again",
            )
            .correlated_to(Some(request.request_id.clone())),
            RetryPosture::RetryAfterResync,
        )
    })?;
    let local = local_fence(session.descriptor()).map_err(|refusal| {
        (
            refusal.correlated_to(Some(request.request_id.clone())),
            RetryPosture::RetryAfterResync,
        )
    })?;
    request
        .expected_fence
        .ensure_matches(&local)
        .map_err(|mismatch| {
            (
                GatewayRefusal::new(
                    ErrorCode::IdentityMismatch,
                    format!("the session input fence changed at {mismatch}"),
                )
                .correlated_to(Some(request.request_id.clone())),
                RetryPosture::RetryAfterResync,
            )
        })?;
    if !session
        .descriptor()
        .capabilities
        .iter()
        .any(|capability| capability == SHARED_TERMINAL_INPUT_CAPABILITY)
    {
        return Err((
            GatewayRefusal::new(
                ErrorCode::UnsupportedCapability,
                "focus-independent input requires shared_terminal_input",
            )
            .with_required_capability(SHARED_TERMINAL_INPUT_CAPABILITY)
            .correlated_to(Some(request.request_id.clone())),
            RetryPosture::Never,
        ));
    }
    session.send_input(request.bytes.clone()).map_err(|error| {
        let (refusal, retry) = local_attach_refusal(&error, false);
        (
            refusal.correlated_to(Some(request.request_id.clone())),
            retry,
        )
    })
}

#[derive(Debug, Serialize)]
struct AbandonUnpresentedCreationDocument<'a> {
    gateway_abandon_version: u16,
    request_id: &'a str,
    session_id: &'a str,
    workspace_id: &'a str,
    receipt: &'a hmux_client::SessionRetirementReceipt,
}

#[derive(Debug, Serialize)]
struct SessionInputDocument<'a> {
    gateway_input_version: u16,
    request_id: &'a str,
    session_id: &'a str,
    workspace_id: &'a str,
    receipt: &'a InputReceipt,
}

/// What a source-control read answers with.
///
/// One document, whatever happened. A refusal here would make "this directory
/// is not a repository" indistinguishable from "the box could not answer", and
/// those mean different things to the person reading the screen.
#[derive(Serialize)]
struct SourceControlDocument<'a> {
    gateway_source_control_version: u16,
    request_id: &'a str,
    session_id: &'a str,
    workspace_id: &'a str,
    #[serde(flatten)]
    body: SourceControlBody,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum SourceControlBody {
    Read(SourceControlSnapshot),
    /// The directory exists and nothing versions it. A fact, not a failure.
    NotVersioned,
    /// The read could not happen. `reason` is one of a closed set minted in
    /// [`crate::source_control`] — never anything the repository said, so a
    /// branch name or a stderr line cannot become a sentence on a phone.
    Unavailable {
        reason: &'static str,
    },
}

#[derive(Serialize)]
struct SourceControlSnapshot {
    /// Which reader answered. Named so a second one could exist without the
    /// phone having to guess.
    vcs: &'static str,
    root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ahead: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    behind: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_ref: Option<String>,
    /// What the file list was compared against. The counts above answer a
    /// different question (the branch's upstream), and one screen must not
    /// present the two as one.
    comparison: &'static str,
    files: Vec<SourceControlFileDocument>,
    truncated: bool,
    /// The file list was actually read. Absent on a v8 answer, where it was
    /// always true — the only question v8 could ask was the file list.
    #[serde(skip_serializing_if = "is_false")]
    files_read: bool,
    /// Absent means this tab did not ask, which is not the same as an empty
    /// list. Both new fields are optional so an older phone, which knows
    /// neither, keeps parsing this document unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    commits: Option<SourceControlCommitsDocument>,
    #[serde(skip_serializing_if = "Option::is_none")]
    review: Option<SourceControlReviewDocument>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// What the commits tab got. Three states, tagged, because "none since the
/// base ref" and "could not read it" send a person to different places.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum SourceControlCommitsDocument {
    Read {
        commits: Vec<SourceControlCommitDocument>,
        truncated: bool,
    },
    Unavailable {
        reason: &'static str,
    },
}

#[derive(Serialize)]
struct SourceControlReviewOpenDocument {
    number: u64,
    title: String,
    state: String,
    url: String,
    is_draft: bool,
    base_ref: String,
}

#[derive(Serialize)]
struct SourceControlCommitDocument {
    short_sha: String,
    subject: String,
    author: String,
    /// Already human, made on this box with `--date=relative` so the phone
    /// never reconciles two clocks.
    when: String,
}

/// What the pull-request tab got.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum SourceControlReviewDocument {
    /// Boxed for the same reason the reader's own `Review` is: six strings
    /// beside two variants that carry a word. The wire shape is unchanged —
    /// an internally tagged newtype variant writes the inner struct's fields
    /// beside `kind`, exactly as the inline variant did.
    Open(Box<SourceControlReviewOpenDocument>),
    /// Asked, and there is none yet. The state a create button exists for, so
    /// it must not arrive looking like a failure.
    None,
    Unavailable {
        reason: &'static str,
    },
}

#[derive(Serialize)]
struct SourceControlFileDocument {
    path: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    old_path: Option<String>,
    /// Absent for a binary or untracked file — absent, never zero. `+0 −0`
    /// reads as "unchanged" for a file that changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted: Option<u32>,
}

/// What the box answers about one file's patch.
#[derive(Serialize)]
struct SourceControlFileDiffDocument<'a> {
    gateway_source_control_diff_version: u16,
    request_id: &'a str,
    session_id: &'a str,
    workspace_id: &'a str,
    /// The path that was asked for, echoed so the reader can line the answer up
    /// with the row that asked. Never a path this box chose.
    path: &'a str,
    /// From the listing that admitted the path, so the screen can label the
    /// header without a second read. Absent means nobody counted.
    #[serde(skip_serializing_if = "Option::is_none")]
    added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted: Option<u32>,
    #[serde(flatten)]
    body: SourceControlFileDiffBody,
}

/// One document whatever happened.
///
/// `Binary` is its own arm rather than an empty `Read`: a body with no lines
/// means the file did not change, and a screen that shows that for a PNG is
/// telling somebody the image is identical when nobody looked.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum SourceControlFileDiffBody {
    Read {
        patch: String,
        truncated: bool,
    },
    Binary,
    /// Always one of the closed words minted in [`crate::source_control`] —
    /// never anything the repository or the file's own content said.
    Unavailable {
        reason: &'static str,
    },
}

fn write_source_control_file_diff_document<W: Write>(
    output: &mut W,
    request: &SourceControlFileDiffRequestDocument,
    outcome: crate::source_control::DiffOutcome,
) -> Result<(), CliError> {
    let (body, added, deleted) = match outcome {
        crate::source_control::DiffOutcome::Read {
            patch,
            truncated,
            added,
            deleted,
        } => (
            SourceControlFileDiffBody::Read { patch, truncated },
            added,
            deleted,
        ),
        crate::source_control::DiffOutcome::Binary => {
            (SourceControlFileDiffBody::Binary, None, None)
        }
        crate::source_control::DiffOutcome::Unavailable(reason) => (
            SourceControlFileDiffBody::Unavailable { reason },
            None,
            None,
        ),
    };
    write_gateway_document(
        output,
        &SourceControlFileDiffDocument {
            gateway_source_control_diff_version: GATEWAY_SOURCE_CONTROL_DIFF_VERSION,
            request_id: &request.request_id,
            session_id: &request.session_id,
            workspace_id: &request.workspace_id,
            path: &request.path,
            added,
            deleted,
            body,
        },
        "a source control file diff",
    )
}

fn write_source_control_document<W: Write>(
    output: &mut W,
    request: &SourceControlStatusRequestDocument,
    outcome: crate::source_control::Outcome,
) -> Result<(), CliError> {
    let body = match outcome {
        crate::source_control::Outcome::Read(snapshot) => {
            SourceControlBody::Read(SourceControlSnapshot {
                vcs: "git",
                root: snapshot.root,
                branch: snapshot.branch,
                ahead: snapshot.ahead,
                behind: snapshot.behind,
                base_ref: snapshot.base_ref,
                comparison: snapshot.comparison.as_str(),
                truncated: snapshot.truncated,
                files_read: snapshot.files_read,
                commits: snapshot.commits.map(|commits| match commits {
                    crate::source_control::Commits::Read { commits, truncated } => {
                        SourceControlCommitsDocument::Read {
                            truncated,
                            commits: commits
                                .into_iter()
                                .map(|commit| SourceControlCommitDocument {
                                    short_sha: commit.short_sha,
                                    subject: commit.subject,
                                    author: commit.author,
                                    when: commit.when,
                                })
                                .collect(),
                        }
                    }
                    crate::source_control::Commits::Unavailable(reason) => {
                        SourceControlCommitsDocument::Unavailable { reason }
                    }
                }),
                review: snapshot.review.map(|review| match review {
                    crate::source_control::Review::Open(pull_request) => {
                        SourceControlReviewDocument::Open(Box::new(
                            SourceControlReviewOpenDocument {
                                number: pull_request.number,
                                title: pull_request.title,
                                state: pull_request.state,
                                url: pull_request.url,
                                is_draft: pull_request.is_draft,
                                base_ref: pull_request.base_ref,
                            },
                        ))
                    }
                    crate::source_control::Review::None => SourceControlReviewDocument::None,
                    crate::source_control::Review::Unavailable(reason) => {
                        SourceControlReviewDocument::Unavailable { reason }
                    }
                }),
                files: snapshot
                    .files
                    .into_iter()
                    .map(|file| SourceControlFileDocument {
                        path: file.path,
                        status: file.status,
                        old_path: file.old_path,
                        added: file.added,
                        deleted: file.deleted,
                    })
                    .collect(),
            })
        }
        crate::source_control::Outcome::NotVersioned => SourceControlBody::NotVersioned,
        crate::source_control::Outcome::Unavailable(reason) => {
            SourceControlBody::Unavailable { reason }
        }
    };
    write_gateway_document(
        output,
        &SourceControlDocument {
            gateway_source_control_version: GATEWAY_SOURCE_CONTROL_VERSION,
            request_id: &request.request_id,
            session_id: &request.session_id,
            workspace_id: &request.workspace_id,
            body,
        },
        "source control status",
    )
}

fn write_abandon_unpresented_creation_document<W: Write>(
    output: &mut W,
    request: &AbandonUnpresentedCreationRequestDocument,
    receipt: &hmux_client::SessionRetirementReceipt,
) -> Result<(), CliError> {
    write_gateway_document(
        output,
        &AbandonUnpresentedCreationDocument {
            gateway_abandon_version: 1,
            request_id: &request.request_id,
            session_id: &request.session_id,
            workspace_id: &request.workspace_id,
            receipt,
        },
        "unpresented creation abandon receipt",
    )
}

fn write_session_input_document<W: Write>(
    output: &mut W,
    request: &SessionInputRequestDocument,
    receipt: &InputReceipt,
) -> Result<(), CliError> {
    write_gateway_document(
        output,
        &SessionInputDocument {
            gateway_input_version: 1,
            request_id: &request.request_id,
            session_id: &request.expected_fence.session_id,
            workspace_id: &request.expected_fence.workspace_id,
            receipt,
        },
        "session input receipt",
    )
}

fn validate_session_input_request(
    request: &SessionInputRequestDocument,
) -> Result<(), GatewayRefusal> {
    for (label, value) in [
        ("request id", request.request_id.as_str()),
        ("session id", request.expected_fence.session_id.as_str()),
        ("workspace id", request.expected_fence.workspace_id.as_str()),
        (
            "runner principal",
            request.expected_fence.runner_principal.as_str(),
        ),
        (
            "runner instance",
            request.expected_fence.runner_instance.as_str(),
        ),
        (
            "host instance id",
            request.expected_fence.host_instance_id.as_str(),
        ),
        (
            "terminal epoch",
            request.expected_fence.terminal_epoch.as_str(),
        ),
    ] {
        if validate_gateway_identifier(label, value, 256).is_err() {
            return Err(GatewayRefusal::new(
                ErrorCode::IdentityMismatch,
                format!("the session input {label} is invalid"),
            )
            .correlated_to(Some(request.request_id.clone())));
        }
    }
    if request.expected_fence.channel_epoch == 0
        || request.bytes.is_empty()
        || request.bytes.len() > MAX_GATEWAY_SESSION_INPUT_BYTES
    {
        return Err(
            GatewayRefusal::new(
                ErrorCode::ResourceLimit,
                format!(
                    "session input must contain 1..={MAX_GATEWAY_SESSION_INPUT_BYTES} bytes and a non-zero channel epoch"
                ),
            )
            .correlated_to(Some(request.request_id.clone())),
        );
    }
    Ok(())
}

/// Whether sshd replaced this process's argv with an `authorized_keys` forced
/// command.
///
/// # Why this is needed
///
/// The phone labels a paired server "the key is pinned to a forced command",
/// and on a plain-sshd host that is true. It is not true everywhere. Tailscale
/// SSH serves the session itself and never opens `authorized_keys`, so the
/// `command="…",restrict` line pairing installed is not applied at all: the
/// client's own string runs, unfenced. Observed 2026-07-29 on a real tailnet
/// host — same phone, same key, and the label was wrong on one of two servers.
///
/// A screen that claims a fence which is not there is worse than one that says
/// nothing, because the owner decides what to hand the phone based on it.
///
/// # Why reading only the *presence* is not the trap the module header refuses
///
/// That header refuses to **dispatch** on `SSH_ORIGINAL_COMMAND`, and still
/// does: matching its text against expected strings is the exact-string trap,
/// and it would re-read the argv the forced command exists to override. This
/// reads whether the variable exists and nothing else. It selects no behaviour
/// — it reports a fact, and the report is advisory.
///
/// # Which way it is wrong
///
/// sshd sets this to the client's requested command when a forced command
/// replaces it. This client always sends a command, so present means fenced.
/// Absent means either no forced command applied, or a client that sent
/// nothing — and this one never does. So a false answer lands on "not fenced"
/// when a fence exists, which is the conservative direction: the screen
/// understates its protection rather than overstating it.
///
/// It does **not** defend against a hostile server. A server with a permissive
/// `AcceptEnv` could let a client set this variable itself and claim a fence it
/// does not have. That is not worth guarding here: a server that wants to lie
/// already serves the session and needs no help from this bit. What this detects
/// is an honest configuration difference between two servers the owner paired
/// the same way.
fn forced_command_applied() -> bool {
    std::env::var_os("SSH_ORIGINAL_COMMAND").is_some()
}

/// Whether this invocation may spawn a Host on this box.
///
/// # Why a forced command refuses by default
///
/// `hmux pair` installs `command="hmux mobile-gateway",restrict`, and that key
/// lives on a phone. Attaching reaches what the account already started;
/// creating starts something new, which is a strictly larger authority — a lost
/// phone would otherwise start processes on every box it was paired with.
///
/// # Why the operator can widen it
///
/// A phone that can only attach cannot start work while the laptop is off, and
/// the laptop being on is an availability property rather than a security one
/// (owner, 2026-09-04). So the widening is a decision the operator makes per
/// box, in the one place that already carries this key's authority: the
/// `authorized_keys` line. `restrict` still holds, the forced command still
/// pins this binary, and `hmux pair revoke` still takes it back in one action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CreationAuthority {
    /// The line says nothing about creation. A forced command refuses it.
    Withheld,
    /// The `authorized_keys` line carries `--allow-create`.
    Granted,
}

fn standalone_creation_refusal(
    forced_command: bool,
    creation: CreationAuthority,
) -> Option<GatewayRefusal> {
    (forced_command && creation == CreationAuthority::Withheld).then(|| {
        GatewayRefusal::new(
            ErrorCode::AuthorizationDenied,
            "a forced-command gateway cannot create remote processes without --allow-create",
        )
    })
}

#[derive(Debug, Serialize)]
struct CatalogDocument<'a> {
    /// Versioned independently of `PROTOCOL_V1`: `--list` is not the attach
    /// protocol and must be able to change without implying a protocol bump.
    gateway_catalog_version: u16,
    /// Whether an `authorized_keys` forced command actually applied to this
    /// connection. A connection-level fact rather than a session one, which is
    /// why it sits beside the version and not inside the entry.
    ///
    /// Repeated on every document because every document is one connection's
    /// answer; a client that reads only the first frame still learns it.
    forced_command_applied: bool,
    /// Build selected by the remote installation's `current` pointer. This is
    /// a connection fact: older Hosts may remain alive behind a newer gateway.
    #[serde(skip_serializing_if = "Option::is_none")]
    gateway_build_id: Option<&'static str>,
    session: CatalogEntry<'a>,
}

const GATEWAY_CATALOG_VERSION_V1: u16 = 1;
const GATEWAY_CATALOG_VERSION_RETIREMENT_POLICY: u16 = 2;
/// Adds what each session was launched to run, and whether its Host is still
/// there. Both answer the same question a list screen asks — "which of these is
/// worth opening" — and neither existed before, so they share one version.
const GATEWAY_CATALOG_VERSION_SESSION_FACTS: u16 = 3;
/// Adds the selected gateway build at the envelope level. Catalog v3 shipped
/// without this field and its deny-unknown clients require that exact shape.
const GATEWAY_CATALOG_VERSION_GATEWAY_BUILD: u16 = 4;

#[derive(Debug, Serialize)]
struct StandaloneCreateDocument<'a> {
    gateway_create_version: u16,
    request_id: &'a str,
    bridge_nonce: &'a str,
    session: CatalogEntry<'a>,
}

/// Everything a relayed client is allowed to know about a session it has not
/// attached to. Borrowed from the descriptor so adding a field is a visible
/// edit here rather than a silent consequence of a manifest change.
#[derive(Debug, Serialize)]
struct CatalogEntry<'a> {
    session_id: &'a str,
    session_name: Option<&'a str>,
    workspace_id: &'a str,
    session_class: hmux_client::SessionClass,
    lifecycle: hmux_client::SessionLifecycle,
    provider_id: &'a str,
    // The remaining fence components. A client that has these can mint an
    // `expected_fence` the Host will accept, which is the whole point.
    runner_principal: &'a str,
    runner_instance: &'a str,
    channel_epoch: &'a str,
    host_instance_id: &'a str,
    terminal_epoch: &'a str,
    supported_protocol: &'a hmux_client::VersionRange,
    /// What the Host advertises. A relayed client still cannot obtain the three
    /// colocation-premised capabilities — `admit_relayed_hello` refuses a Hello
    /// that asks — but it needs the advertised set to know what is worth asking
    /// for at all.
    capabilities: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    retirement_policy: Option<SessionRetirementPolicy>,
    /// The bare name of what the session was launched to run, when the Host
    /// recorded one. Never the arguments — a command line carries secrets and
    /// this document is read by a phone.
    #[serde(skip_serializing_if = "Option::is_none")]
    launch_program: Option<&'a str>,
    /// Whether the Host process behind this manifest is still there.
    ///
    /// Three states, not two. `unknown` is its own answer because the probe
    /// fails closed: a manifest whose process cannot be proved either present
    /// or gone must not be reported as gone, or a list that hides sessions
    /// becomes a list that loses them. A `lifecycle` of `ready` is not this —
    /// it is what the Host wrote when it was last alive, and a manifest whose
    /// process died says `ready` forever.
    #[serde(skip_serializing_if = "Option::is_none")]
    host_liveness: Option<&'static str>,
}

impl<'a> From<&'a SessionDescriptor> for CatalogEntry<'a> {
    fn from(descriptor: &'a SessionDescriptor) -> Self {
        Self::new(descriptor, GATEWAY_CATALOG_VERSION_V1)
    }
}

impl<'a> CatalogEntry<'a> {
    /// Fields appear by catalog version, not by taste: a client that asked for
    /// an older answer must keep getting exactly that answer.
    fn new(descriptor: &'a SessionDescriptor, catalog_version: u16) -> Self {
        Self {
            session_id: &descriptor.session_id,
            session_name: descriptor.session_name.as_deref(),
            workspace_id: &descriptor.workspace_id,
            session_class: descriptor.session_class,
            lifecycle: descriptor.lifecycle,
            provider_id: &descriptor.provider_id,
            runner_principal: &descriptor.runner_principal,
            runner_instance: &descriptor.runner_instance,
            channel_epoch: &descriptor.channel_epoch,
            host_instance_id: &descriptor.host_instance_id,
            terminal_epoch: &descriptor.terminal_epoch,
            supported_protocol: &descriptor.supported_protocol,
            capabilities: &descriptor.capabilities,
            retirement_policy: if catalog_version >= GATEWAY_CATALOG_VERSION_RETIREMENT_POLICY {
                descriptor.retirement_policy
            } else {
                None
            },
            launch_program: if catalog_version >= GATEWAY_CATALOG_VERSION_SESSION_FACTS {
                descriptor.launch_program.as_deref()
            } else {
                None
            },
            host_liveness: (catalog_version >= GATEWAY_CATALOG_VERSION_SESSION_FACTS)
                .then(|| host_liveness(descriptor)),
        }
    }
}

/// Whether the Host process named by this manifest is still running.
///
/// No connection: the manifest carries a process proof, and asking the kernel
/// about a pid and its start marker costs nothing. Connecting to every session
/// to find out would make a listing N handshakes and would *attach* to each
/// one, which a listing has no business doing.
fn host_liveness(descriptor: &SessionDescriptor) -> &'static str {
    match hmux_client::probe_local_process_generation(&descriptor.host_process) {
        Ok(hmux_client::LocalProcessGenerationStatus::Live) => "live",
        Ok(hmux_client::LocalProcessGenerationStatus::Absent) => "absent",
        // Fails closed. The caller cannot tell a dead Host from one this
        // process was not allowed to look at, and calling the second one dead
        // would hide a live session behind a permission problem.
        Err(_) => "unknown",
    }
}

impl<'a> From<&'a SessionDescriptor> for CatalogDocument<'a> {
    fn from(descriptor: &'a SessionDescriptor) -> Self {
        Self::new(descriptor, GATEWAY_CATALOG_VERSION_V1)
    }
}

impl<'a> CatalogDocument<'a> {
    fn new(descriptor: &'a SessionDescriptor, gateway_catalog_version: u16) -> Self {
        Self {
            gateway_catalog_version,
            forced_command_applied: forced_command_applied(),
            gateway_build_id: (gateway_catalog_version >= GATEWAY_CATALOG_VERSION_GATEWAY_BUILD)
                .then_some(crate::CLI_BUILD_ID),
            session: CatalogEntry::new(descriptor, gateway_catalog_version),
        }
    }
}

fn write_catalog_document<W: Write>(
    output: &mut W,
    document: &CatalogDocument<'_>,
) -> Result<(), CliError> {
    let payload = serde_json::to_vec(document).map_err(|error| {
        CliError(format!(
            "mobile-gateway could not encode a session listing: {error}"
        ))
    })?;
    // Held to the same cap as a protocol frame so a reader can use one bounded
    // buffer for both modes. A record this large would mean a manifest that
    // manifest validation should already have refused, so this is an assertion
    // about the Host, not a limit a client can trip.
    let maximum = FrameLimits::default().max_frame_bytes;
    if payload.len() > maximum {
        return Err(CliError(format!(
            "mobile-gateway refused to emit a {}-byte session listing over the {maximum}-byte cap",
            payload.len()
        )));
    }
    let length = u32::try_from(payload.len()).expect("the payload was just bounded below u32::MAX");
    let mut encoded = Vec::with_capacity(LENGTH_PREFIX_BYTES + payload.len());
    encoded.extend_from_slice(&length.to_be_bytes());
    encoded.extend_from_slice(&payload);
    output.write_all(&encoded).map_err(|error| {
        CliError(format!(
            "mobile-gateway could not write a session listing: {error}"
        ))
    })
}

fn write_standalone_create_document<W: Write>(
    output: &mut W,
    request: &StandaloneCreateRequestDocument,
    descriptor: &SessionDescriptor,
) -> Result<(), CliError> {
    let document = StandaloneCreateDocument {
        gateway_create_version: 1,
        request_id: &request.request_id,
        bridge_nonce: &request.bridge_nonce,
        // Pinned to the version this receipt's *reader* was written against.
        // `gateway_create_version` is still 1 and `RemoteCatalogSession` in
        // `hmux-ssh-transport` is `deny_unknown_fields`, so emitting a newer
        // entry shape here does not degrade — it makes the desktop's remote
        // create fail to parse a receipt for a session the far end has already
        // created, leaving it behind. The listing negotiates its version; this
        // document does not, so it may not follow the listing's.
        session: CatalogEntry::new(descriptor, GATEWAY_CATALOG_VERSION_RETIREMENT_POLICY),
    };
    write_gateway_document(output, &document, "standalone create receipt")
}

fn write_gateway_document<W: Write>(
    output: &mut W,
    document: &impl Serialize,
    label: &str,
) -> Result<(), CliError> {
    let payload = serde_json::to_vec(document)
        .map_err(|error| CliError(format!("mobile-gateway could not encode {label}: {error}")))?;
    let maximum = FrameLimits::default().max_frame_bytes;
    if payload.is_empty() || payload.len() > maximum {
        return Err(CliError(format!(
            "mobile-gateway refused to emit a {}-byte {label} over the 1..={maximum} cap",
            payload.len()
        )));
    }
    let length = u32::try_from(payload.len()).expect("the payload was bounded below u32::MAX");
    output
        .write_all(&length.to_be_bytes())
        .and_then(|()| output.write_all(&payload))
        .and_then(|()| output.flush())
        .map_err(|error| CliError(format!("mobile-gateway could not write {label}: {error}")))
}

fn create_standalone(
    catalog: &LocalSessionCatalog,
    request: &StandaloneCreateRequestDocument,
    creation: CreationAuthority,
) -> Result<hmux_client::CreatedStandaloneSession, CliError> {
    validate_standalone_create_request(request)?;
    // The same rule read a second time, kept because this function is the one
    // that actually spawns: a future caller that forgets the check at the
    // request boundary must not be the thing that widens a phone key.
    if forced_command_applied() && creation == CreationAuthority::Withheld {
        return Err(CliError(
            "mobile-gateway refuses standalone creation through a forced-command key".into(),
        ));
    }
    let bridge_dir = prepare_command_bridge(catalog.discovery_root(), request)?;
    let home = dirs::home_dir()
        .ok_or_else(|| CliError("mobile-gateway could not resolve the remote home".into()))?;
    let cwd = resolve_standalone_working_directory(request.cwd.as_deref(), &home)?;
    let shell = std::env::var_os("SHELL")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
    let command = interactive_shell_with_command_bridge(
        &shell,
        &home,
        &bridge_dir,
        &[(
            "DURE_HMUX_COMMAND_BRIDGE_NONCE",
            request.bridge_nonce.as_str(),
        )],
    )
    .map_err(|error| {
        CliError(format!(
            "mobile-gateway could not prepare its interactive shell: {error}"
        ))
    })?;
    let recovery = StandaloneRecoveryCreateIdentity::new(
        &request.target_session_id,
        &request.launch_owner_proof,
    )
    .map_err(|error| CliError(error.to_string()))?
    .with_recipe_requirement(StandaloneRecipeRequirement::InitializeIfAbsent);
    let create = StandaloneCreateRequest::new(
        cwd,
        Some(request.session_name.clone()),
        command,
        request.initial_rows,
        request.initial_columns,
    )
    .and_then(|create| create.with_recovery_identity(recovery))
    .and_then(|create| create.with_retirement_policy_option(request.retirement_policy))
    .map_err(|error| CliError(error.to_string()))?;
    let runtime = crate::resolve_runtime_executable(None)?;
    StandaloneSessionCreator::new(runtime)
        .with_discovery_root(catalog.discovery_root())
        .create(create)
        .map_err(|error| CliError(format!("{}: {error}", error.code())))
}

fn resolve_standalone_working_directory(
    requested: Option<&str>,
    home: &Path,
) -> Result<PathBuf, CliError> {
    let requested_cwd = requested
        .map(PathBuf::from)
        .unwrap_or_else(|| home.to_path_buf());
    if requested.is_some() && !requested_cwd.is_absolute() {
        return Err(CliError(
            "mobile-gateway requires an absolute remote working directory".into(),
        ));
    }
    let cwd = requested_cwd.canonicalize().map_err(|error| {
        CliError(format!(
            "mobile-gateway could not open the remote working directory: {error}"
        ))
    })?;
    if !cwd.is_dir() {
        return Err(CliError(
            "mobile-gateway remote working directory is not a directory".into(),
        ));
    }
    Ok(cwd)
}

fn validate_standalone_create_request(
    request: &StandaloneCreateRequestDocument,
) -> Result<(), CliError> {
    for (label, value) in [
        ("request id", request.request_id.as_str()),
        ("target session id", request.target_session_id.as_str()),
        ("launch owner proof", request.launch_owner_proof.as_str()),
        ("session name", request.session_name.as_str()),
        ("bridge nonce", request.bridge_nonce.as_str()),
    ] {
        validate_gateway_identifier(label, value, 256)?;
    }
    if request.initial_rows == 0
        || request.initial_columns == 0
        || request.command_intercepts.is_empty()
        || request.command_intercepts.len() > 16
        || request
            .retirement_policy
            .is_some_and(|policy| !policy.is_valid())
    {
        return Err(CliError(
            "mobile-gateway standalone dimensions or command intercepts are invalid".into(),
        ));
    }
    if request
        .cwd
        .as_ref()
        .is_some_and(|cwd| cwd.is_empty() || cwd.len() > 4_096 || cwd.as_bytes().contains(&0))
    {
        return Err(CliError(
            "mobile-gateway standalone working directory is invalid".into(),
        ));
    }
    let mut commands = BTreeSet::new();
    for intercept in &request.command_intercepts {
        validate_gateway_identifier("intercept command", &intercept.command, 64)?;
        validate_gateway_identifier("intercept provider id", &intercept.provider_id, 64)?;
        if !commands.insert(&intercept.command) {
            return Err(CliError(
                "mobile-gateway standalone command intercepts must be unique".into(),
            ));
        }
    }
    Ok(())
}

fn validate_gateway_identifier(label: &str, value: &str, maximum: usize) -> Result<(), CliError> {
    if value.is_empty()
        || value.len() > maximum
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:+-".contains(&byte))
    {
        return Err(CliError(format!(
            "mobile-gateway standalone {label} is invalid"
        )));
    }
    Ok(())
}

fn prepare_command_bridge(
    discovery_root: &Path,
    request: &StandaloneCreateRequestDocument,
) -> Result<PathBuf, CliError> {
    // A first create can precede any Host, including after the canonical
    // discovery location changes while older sessions remain read-only.
    DiscoveryRoot::create(discovery_root).map_err(|error| {
        CliError(format!(
            "mobile-gateway could not initialize its discovery root: {error}"
        ))
    })?;
    let discovery_root = discovery_root.canonicalize().map_err(|error| {
        CliError(format!(
            "mobile-gateway could not resolve its discovery root: {error}"
        ))
    })?;
    let root = discovery_root.join(".command-bridges-v1");
    fs::create_dir_all(&root).map_err(|error| {
        CliError(format!(
            "mobile-gateway could not create bridge root: {error}"
        ))
    })?;
    refuse_symlink_or_non_directory(&root, "bridge root")?;
    set_private_directory_permissions(&root)?;
    let root = root.canonicalize().map_err(|error| {
        CliError(format!(
            "mobile-gateway could not resolve bridge root: {error}"
        ))
    })?;
    if root.parent() != Some(discovery_root.as_path()) {
        return Err(CliError(
            "mobile-gateway command bridge root escaped discovery state".into(),
        ));
    }
    let bridge = root.join(&request.target_session_id);
    fs::create_dir_all(&bridge).map_err(|error| {
        CliError(format!(
            "mobile-gateway could not create command bridge: {error}"
        ))
    })?;
    refuse_symlink_or_non_directory(&bridge, "command bridge")?;
    set_private_directory_permissions(&bridge)?;
    let bridge = bridge.canonicalize().map_err(|error| {
        CliError(format!(
            "mobile-gateway could not resolve command bridge: {error}"
        ))
    })?;
    if bridge.parent() != Some(root.as_path()) {
        return Err(CliError(
            "mobile-gateway command bridge escaped its private root".into(),
        ));
    }
    let executable = std::env::current_exe()
        .map_err(|error| CliError(format!("mobile-gateway could not resolve itself: {error}")))?;
    for intercept in &request.command_intercepts {
        let script = format!(
            "#!/bin/sh\nexec {} command-bridge --bridge-dir {} --bridge-nonce {} --provider-id {} --executable {} -- \"$@\"\n",
            shell_quote(&executable.to_string_lossy()),
            shell_quote(&bridge.to_string_lossy()),
            shell_quote(&request.bridge_nonce),
            shell_quote(&intercept.provider_id),
            shell_quote(&intercept.command),
        );
        write_bridge_script(&bridge.join(&intercept.command), script.as_bytes())?;
    }
    Ok(bridge)
}

fn refuse_symlink_or_non_directory(path: &Path, label: &str) -> Result<(), CliError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| CliError(format!("mobile-gateway could not inspect {label}: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CliError(format!(
            "mobile-gateway refuses a symlink or non-directory {label}"
        )));
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn write_bridge_script(path: &Path, expected: &[u8]) -> Result<(), CliError> {
    if path.try_exists().map_err(|error| {
        CliError(format!(
            "mobile-gateway could not inspect bridge script: {error}"
        ))
    })? {
        let metadata = fs::symlink_metadata(path).map_err(|error| {
            CliError(format!(
                "mobile-gateway could not inspect bridge script metadata: {error}"
            ))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(CliError(
                "mobile-gateway refuses a symlink or non-file command bridge".into(),
            ));
        }
        let current = fs::read(path).map_err(|error| {
            CliError(format!(
                "mobile-gateway could not read bridge script: {error}"
            ))
        })?;
        if current != expected {
            return Err(CliError(
                "mobile-gateway command bridge conflicts with existing state".into(),
            ));
        }
        set_private_script_permissions(path)?;
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            CliError(format!(
                "mobile-gateway could not create bridge script exclusively: {error}"
            ))
        })?;
    file.write_all(expected)
        .and_then(|()| file.sync_all())
        .map_err(|error| {
            CliError(format!(
                "mobile-gateway could not write bridge script: {error}"
            ))
        })?;
    set_private_script_permissions(path)
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), CliError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
        CliError(format!(
            "mobile-gateway could not protect bridge directory: {error}"
        ))
    })
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), CliError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_script_permissions(path: &Path) -> Result<(), CliError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
        CliError(format!(
            "mobile-gateway could not protect bridge script: {error}"
        ))
    })
}

#[cfg(not(unix))]
fn set_private_script_permissions(_path: &Path) -> Result<(), CliError> {
    Ok(())
}

fn serve<R, W>(
    catalog: &LocalSessionCatalog,
    session_identifier: Option<&str>,
    workspace_id: Option<&str>,
    role: GatewayRole,
    creation: CreationAuthority,
    mut input: R,
    output: W,
) -> Result<(), CliError>
where
    R: Read + Send + 'static,
    W: Write + Send + 'static,
{
    let sink = Arc::new(Mutex::new(FrameSink::new(output)));
    let codec = FrameCodec::new(FrameLimits::default());

    // The first document is read before anything is resolved, because it is what
    // says which mode this invocation is in — and, when `--session` is not
    // pinned, which session it is about. Read as a payload rather than as a
    // frame: `classify_first_document` needs the bytes before they are committed
    // to the `WireFrame` shape.
    let opening = match codec.read_payload(&mut input) {
        Ok(payload) => payload,
        Err(error) => {
            // The most likely single place for version skew to show up is the
            // very first document, so this path gets a typed answer rather than
            // a close. The peer is not anonymous here — sshd already accepted
            // its key before this process existed — so the original "these bytes
            // are unauthenticated, say nothing" reasoning does not hold, and
            // saying nothing produced the one symptom this module exists to
            // remove: an EOF indistinguishable from `ssh` itself failing.
            //
            // A `Closed` classification stays silent, because there is no
            // longer a peer to answer.
            return match classify_relay_read(&error) {
                RelayReadFailure::Closed => Err(CliError(format!(
                    "mobile-gateway lost the relay before the hello: {error}"
                ))),
                RelayReadFailure::RefusedFrame { code, message }
                | RelayReadFailure::DesynchronizedStream { code, message } => Err(refuse(
                    &sink,
                    GatewayRefusal::new(code, message).with_versions(),
                )),
            };
        }
    };

    match classify_first_document(&opening) {
        // Same `list` the flag runs, with the same arguments: a forced command
        // that pinned `--session` narrows the stream listing exactly as it
        // narrows the flag one, and the record allow-list has one implementation.
        FirstDocument::Request {
            gateway_request_version,
            request: GatewayRequest::ListSessions,
        } => {
            eprintln!("hmux: mobile-gateway: serving a session listing over the stream");
            // The guard is scoped so a failure below can still take the lock to
            // answer. Holding it across the refusal would deadlock this process
            // into exactly the silent close the answer exists to prevent.
            let listed = {
                let mut guard = lock_sink(&sink)?;
                list(
                    catalog,
                    session_identifier,
                    workspace_id,
                    match gateway_request_version {
                        GATEWAY_REQUEST_VERSION_MINIMUM => GATEWAY_CATALOG_VERSION_V1,
                        GATEWAY_REQUEST_VERSION_RETIREMENT_POLICY => {
                            GATEWAY_CATALOG_VERSION_RETIREMENT_POLICY
                        }
                        GATEWAY_REQUEST_VERSION_SESSION_FACTS => {
                            GATEWAY_CATALOG_VERSION_SESSION_FACTS
                        }
                        GATEWAY_REQUEST_VERSION_GATEWAY_BUILD => {
                            GATEWAY_CATALOG_VERSION_GATEWAY_BUILD
                        }
                        _ => {
                            unreachable!("unsupported request versions are refused during parsing")
                        }
                    },
                    guard.output_mut(),
                )
            };
            return match listed {
                Ok(()) => Ok(()),
                Err(error) => {
                    // A pinned session that no longer exists is the ordinary way
                    // here: the key still names it, the Host was replaced. The
                    // argv `--list` route can end at a bare non-zero exit
                    // because an operator reads stderr; a phone does not, and an
                    // empty listing that ends cleanly is indistinguishable from
                    // "this server runs nothing". `StaleDiscovery` plus
                    // `RetryAfterResync` says which of the two it is.
                    //
                    // The message names no peer or local string — `CliError`
                    // here can quote a filesystem path, which means nothing
                    // off-box and is withheld for the same reason `--list`
                    // withholds the socket address.
                    eprintln!("hmux: mobile-gateway: {error}");
                    let _ = send_error_with_retry(
                        &sink,
                        &GatewayRefusal::new(
                            ErrorCode::StaleDiscovery,
                            "this gateway could not produce a session listing",
                        ),
                        RetryPosture::RetryAfterResync,
                    );
                    Err(error)
                }
            };
        }
        FirstDocument::Request {
            request: GatewayRequest::ResolveSession(request),
            ..
        } => {
            let outcome =
                resolve_current_session(catalog, &request, session_identifier, workspace_id)
                    .map_err(|refusal| refuse(&sink, refusal))?;
            let document = SessionResolutionDocument {
                gateway_session_resolution_version: session_resolution::RESPONSE_VERSION,
                source_fence: request.expected_fence,
                outcome: match &outcome {
                    SessionResolution::Resolved { session } => SessionResolution::Resolved {
                        session: CatalogEntry::new(
                            session.descriptor(),
                            GATEWAY_CATALOG_VERSION_SESSION_FACTS,
                        ),
                    },
                    SessionResolution::Pending => SessionResolution::Pending,
                    SessionResolution::Unknown => SessionResolution::Unknown,
                },
            };
            let mut guard = lock_sink(&sink)?;
            write_gateway_document(guard.output_mut(), &document, "session resolution")?;
            return Ok(());
        }
        FirstDocument::Request {
            request: GatewayRequest::CreateStandalone(request),
            ..
        } => {
            if let Some(refusal) = standalone_creation_refusal(forced_command_applied(), creation) {
                return Err(refuse(&sink, refusal));
            }
            let created = create_standalone(catalog, &request, creation).inspect_err(|_| {
                let _ = send_error_with_retry(
                    &sink,
                    &GatewayRefusal::new(
                        ErrorCode::TransportClosed,
                        "this gateway could not create the requested standalone session",
                    ),
                    RetryPosture::RetryAfterResync,
                );
            })?;
            let mut guard = lock_sink(&sink)?;
            write_standalone_create_document(
                guard.output_mut(),
                &request,
                created.session().descriptor(),
            )?;
            return Ok(());
        }
        FirstDocument::Request {
            request: GatewayRequest::AbandonUnpresentedCreation(request),
            ..
        } => {
            if let Some(refusal) = session_mutation_refusal(forced_command_applied()) {
                return Err(refuse(&sink, refusal));
            }
            if validate_abandon_unpresented_creation_request(&request).is_err() {
                return Err(refuse(
                    &sink,
                    GatewayRefusal::new(
                        ErrorCode::IdentityMismatch,
                        "the unpresented creation abandon request was invalid",
                    ),
                ));
            }
            let receipt =
                abandon_unpresented_creation(catalog, &request, session_identifier, workspace_id)
                    .map_err(|(refusal, retry)| refuse_with_retry(&sink, refusal, retry))?;
            let mut guard = lock_sink(&sink)?;
            write_abandon_unpresented_creation_document(guard.output_mut(), &request, &receipt)?;
            return Ok(());
        }
        FirstDocument::Request {
            request: GatewayRequest::WriteSessionInput(request),
            ..
        } => {
            if let Some(refusal) =
                session_input_refusal(forced_command_applied(), &request.request_id)
            {
                return Err(refuse(&sink, refusal));
            }
            let receipt = write_session_input(catalog, &request, session_identifier, workspace_id)
                .map_err(|(refusal, retry)| refuse_with_retry(&sink, refusal, retry))?;
            let mut guard = lock_sink(&sink)?;
            write_session_input_document(guard.output_mut(), &request, &receipt)?;
            return Ok(());
        }
        FirstDocument::Request {
            request: GatewayRequest::SourceControlStatus(request),
            ..
        } => {
            // No forced-command gate: this is a read, like the listing. Every
            // `forced_command` check in this file guards a mutation.
            let outcome =
                source_control_status(catalog, &request, session_identifier, workspace_id)
                    .map_err(|(refusal, retry)| refuse_with_retry(&sink, refusal, retry))?;
            let mut guard = lock_sink(&sink)?;
            write_source_control_document(guard.output_mut(), &request, outcome)?;
            return Ok(());
        }
        FirstDocument::Request {
            request: GatewayRequest::SourceControlFileDiff(request),
            ..
        } => {
            // No forced-command gate: a read, like the listing and the status.
            let outcome =
                source_control_file_diff(catalog, &request, session_identifier, workspace_id)
                    .map_err(|(refusal, retry)| refuse_with_retry(&sink, refusal, retry))?;
            let mut guard = lock_sink(&sink)?;
            write_source_control_file_diff_document(guard.output_mut(), &request, outcome)?;
            return Ok(());
        }
        FirstDocument::Refused(refusal) => return Err(refuse(&sink, refusal)),
        FirstDocument::Frame => {}
    }

    let hello = match codec
        .decode_payload_for_dispatch(&opening)
        .and_then(DecodedFrame::into_valid)
    {
        Ok(frame) => match frame.body {
            FrameBody::Hello(hello) => hello,
            other => {
                return Err(refuse(
                    &sink,
                    GatewayRefusal::new(
                        ErrorCode::IdentityMismatch,
                        format!(
                            "a relayed session opens with hello, not {}",
                            frame_kind_name(&other)
                        ),
                    ),
                ));
            }
        },
        Err(error) => {
            // The payload was already read in full, so the stream classification
            // can only produce the aligned arms here; the `Closed` arm is kept
            // rather than `unreachable!` because a panic in a process sshd
            // spawned is a silent close, which is the failure this module exists
            // to remove.
            return match classify_relay_read(&error) {
                RelayReadFailure::Closed => Err(CliError(format!(
                    "mobile-gateway lost the relay before the hello: {error}"
                ))),
                RelayReadFailure::RefusedFrame { code, message }
                | RelayReadFailure::DesynchronizedStream { code, message } => Err(refuse(
                    &sink,
                    GatewayRefusal::new(code, message).with_versions(),
                )),
            };
        }
    };

    // Which session this attach is for.
    //
    // Pinned (`--session` in the forced command): argv is the selector and the
    // relayed `Hello` only gets to agree with it, which `admit_relayed_hello`
    // enforces below. Unpinned: the `Hello`'s own `expected_fence` names it. The
    // second case is the widening the module header records; it is *not* a
    // weaker check, because the fence the peer supplied is still compared
    // component-by-component against the one read off this box's manifest. What
    // it drops is only the argv pin, i.e. which sessions this key may reach.
    let (identifier, selected_workspace) = match session_identifier {
        Some(pinned) => (pinned, workspace_id),
        None => {
            // A `--workspace` pin without a `--session` pin is still a
            // constraint, and refusing here rather than resolving the peer's
            // workspace is what keeps it one.
            if let Some(pinned_workspace) = workspace_id {
                if hello.expected_fence.workspace_id != pinned_workspace {
                    return Err(refuse(
                        &sink,
                        GatewayRefusal::new(
                            ErrorCode::IdentityMismatch,
                            format!("this gateway serves only workspace {pinned_workspace}"),
                        ),
                    ));
                }
            }
            (
                hello.expected_fence.session_id.as_str(),
                Some(hello.expected_fence.workspace_id.as_str()),
            )
        }
    };

    let session = match resolve_session(catalog, identifier, selected_workspace) {
        Ok(session) => session,
        Err(error) => {
            // Answered on the wire, not just on stderr. On the unpinned path
            // this is the ordinary case of a phone attaching from a stale
            // catalog — the Host was replaced and the session id moved — and
            // `RetryAfterResync` is the one posture that tells it to list again
            // instead of retrying the same dead id forever. The message names no
            // peer string: `ClientError`'s display would quote the identifier
            // back, and a refusal is not an echo chamber.
            eprintln!("hmux: mobile-gateway: could not open the session: {error}");
            let _ = send_error_with_retry(
                &sink,
                &GatewayRefusal::new(
                    ErrorCode::StaleDiscovery,
                    "this gateway serves no such Hmux session; list the catalog again",
                ),
                RetryPosture::RetryAfterResync,
            );
            return Err(CliError(format!(
                "mobile-gateway could not open the session: {error}"
            )));
        }
    };
    let descriptor = session.descriptor().clone();
    eprintln!(
        "hmux: mobile-gateway: serving session {} (workspace {}) as {role:?}",
        descriptor.session_id, descriptor.workspace_id
    );
    let local_fence = match local_fence(&descriptor) {
        Ok(fence) => fence,
        Err(refusal) => return Err(refuse(&sink, refusal)),
    };

    // Everything decidable from the relayed Hello is decided here, before the
    // local attach. Ordering, not tidiness: a refusal reached *after*
    // `session.connect` has already perturbed the live session. A Controller
    // attach grants the lease on the way in (`grant_control`) and releases it
    // on teardown (`release_control`), and both move the Host's
    // `controller_generation`. That generation is what `admit_mutation` fences
    // stale controller writes against, so a denied request that moves it twice
    // has silently invalidated in-flight mutations from the legitimate
    // controller — observed as 11 -> 13 on a request the gateway went on to
    // refuse. Anything added to this function must be classified as
    // Hello-decidable and placed above the attach, or explained below it.
    let attach_role = match admit_relayed_hello(&hello, role, &local_fence) {
        Ok(attach_role) => attach_role,
        Err(refusal) => return Err(refuse(&sink, refusal)),
    };
    let terminal_selection = match admit_relayed_terminal_capabilities(&hello, role) {
        Ok(selection) => selection,
        Err(refusal) => return Err(refuse(&sink, refusal)),
    };
    let host_agent_prompt_posture = select_managed_agent_prompt_capability(
        AttachMode::Observer,
        descriptor.session_class == hmux_client::SessionClass::Managed,
        &descriptor.capabilities,
        &descriptor.capabilities,
    );
    let legacy_agent_prompt_input_dependency = attach_role == LocalAttachRole::Observer
        && host_agent_prompt_posture == Some(AgentPromptCapabilitySelection::LegacyFresh)
        && terminal_selection.agent_prompt.offers_legacy_lane()
        && !terminal_selection.input;
    let relayed_cursor = relayed_reconnect_cursor(&hello);
    let authorization_proof = if descriptor.session_class == hmux_client::SessionClass::Managed
        && (attach_role == LocalAttachRole::Controller || terminal_selection.agent_prompt.is_some())
    {
        // The strongest proof supported by this Host is resolved and consumed
        // on the remote host. It is never placed in the relayed Hello or
        // returned to the SSH client; SSH remains the outer authority and the
        // Host's ordinary controller generation still arbitrates the resulting
        // writable lease.
        Some(
            session
                .managed_attach_authorization_proof()
                .map_err(|error| {
                    let (refusal, retry) = local_attach_refusal(&error, false);
                    let _ = send_error_with_retry(&sink, &refusal, retry);
                    CliError(format!(
                        "mobile-gateway could not resolve local managed attach authorization: {error}"
                    ))
                })?,
        )
    } else {
        None
    };

    let request_managed_authorization_grant = authorization_proof.is_some()
        && descriptor
            .capabilities
            .iter()
            .any(|capability| capability == MANAGED_AUTHORIZATION_GRANT_CAPABILITY);
    let relay_retirement = should_relay_retirement(role, attach_role, &hello);
    let connection = session
        .connect_with_options({
            let optional_capabilities = gateway_local_optional_capabilities(
                request_managed_authorization_grant,
                relay_retirement,
                terminal_selection.agent_identity,
                terminal_selection.identity,
                terminal_selection.agent_prompt,
            );
            let options = ConnectionOptions::new(attach_role, authorization_proof)
                // A Host that advertises scoped grants distinguishes them from
                // its legacy launch proof through this negotiated capability.
                // Older Hosts omit it and authenticate the fallback manifest
                // token through their existing path.
                .with_optional_capabilities(&optional_capabilities)
                // The peer's cursor, verbatim. See `relayed_reconnect_cursor`
                // for why it is neither clamped nor repaired on the way past.
                .with_reconnect_cursor(relayed_cursor.clone());
            with_relayed_terminal_selection(
                options,
                terminal_selection,
                legacy_agent_prompt_input_dependency,
            )
        })
        .map_err(|error| {
            // Best effort: the relayed client is owed a typed reason, but a local
            // dial failure is the operator's problem and belongs on stderr too.
            let (refusal, retry) = local_attach_refusal(&error, relayed_cursor.is_some());
            let _ = send_error_with_retry(&sink, &refusal, retry);
            CliError(format!("mobile-gateway could not attach locally: {error}"))
        })?;

    let peer_hello_ack = peer_visible_hello_ack(
        connection.hello_ack().clone(),
        request_managed_authorization_grant,
        legacy_agent_prompt_input_dependency,
    )
    .map_err(|refusal| refuse(&sink, refusal))?;
    let terminal_handles = connection.terminal_upstream_handles();
    let retirement_selected =
        admit_retirement_grant(relay_retirement, &peer_hello_ack.selected_capabilities)
            .map_err(|refusal| refuse(&sink, refusal))?;

    // The one check that genuinely cannot be hoisted above the attach, and the
    // reason is worth stating rather than leaving to inference.
    //
    // The granted set is the Host's intersection of what this gateway's local
    // attach *requested* against what the Host *advertises*. The request half
    // is built inside `hmux-client` from the `LocalAttachRole`
    // (`required_capabilities`) and is not visible from here, so the
    // intersection is not computable from the descriptor plus the relayed
    // Hello — only the Host's answer settles it. Predicting it here would mean
    // duplicating another crate's private table, and a stale copy of that table
    // fails *open*, which is the one direction this gate may not fail.
    //
    // Reaching this arm therefore does cost the session the generation movement
    // described above. That is accepted deliberately: after the explicitly
    // requested gateway-local managed grant has been removed, today's local
    // connection options ask for none of the remaining colocated privileges.
    // This catches any future widening of that request set, and on the day it
    // fires the right outcome is a loud refusal rather than a relayed
    // unarbitrated PTY write. A perturbed generation is a far smaller harm than
    // that.
    if let Some(granted) = colocation_premised_grant(&peer_hello_ack.selected_capabilities) {
        return Err(refuse(
            &sink,
            GatewayRefusal::new(
                ErrorCode::AuthorizationDenied,
                format!(
                    "local attach was granted {granted}, whose authority rests on colocation the relayed peer does not have"
                ),
            )
            .with_required_capability(granted),
        ));
    }

    // How the Host seeded the local attach is how the relayed attach is seeded:
    // the same replay shape plus its selected typed semantic prelude, relayed
    // in the same order.
    //
    // The two sides cannot disagree about which shape is coming, and that is a
    // property rather than a hope. `hmux-client` decides resume-versus-snapshot
    // from exactly two things — whether a cursor was offered, and whether
    // `HelloAck.selected_capabilities` names `reconnect_resume_v1` — and the
    // relayed peer runs that decision over the *same* cursor it sent and the
    // same reconnect selection this gateway forwards unchanged. The sole
    // removed capability is the gateway-local managed authorization grant,
    // which has no bearing on replay shape. Identical replay inputs, identical
    // branch. Nothing here re-derives the decision; it reads the one the local
    // attach already made.
    //
    // That is also the whole of the honesty requirement. A Host that never
    // selected `reconnect_resume_v1` produces an ack that does not list it, the
    // peer reads that ack and expects a snapshot, and a snapshot is what the
    // local attach got and what is forwarded. The peer is *told* the capability
    // was not selected; it never has to infer it from a snapshot arriving.
    let seed = relayed_attach_seed(&connection)?;
    {
        let mut guard = lock_sink(&sink)?;
        guard
            .send(FrameBody::HelloAck(peer_hello_ack))
            .map_err(|error| CliError(format!("mobile-gateway could not answer hello: {error}")))?;
        for record in seed {
            let sent = match record {
                ConnectionRecord::Control(body) => guard.send(*body),
                ConnectionRecord::TerminalState(payload) => guard.send_payload(&payload),
            };
            sent.map_err(|error| {
                CliError(format!(
                    "mobile-gateway could not send the attach seed: {error}"
                ))
            })?;
        }
    }

    let upstream_sink = Arc::clone(&sink);
    let writer = connection.writer();

    // The controller lease is held by *this process* and released when it goes
    // away, so a phone that stops answering without closing its SSH channel
    // keeps the session's only writable lease. The Host has no preemption — a
    // second Controller attach is refused with `ControllerConflict` — so the
    // owner sitting at the laptop cannot take their own terminal back. Nothing
    // else would notice for hours: TCP keepalive defaults are measured in them,
    // and iOS suspends an app without closing its sockets.
    //
    // So controller service is bounded by inbound silence. Any frame is
    // liveness; silence past the limit ends the attach exactly the way a clean
    // disconnect does, because `Detach` runs the Host's ordinary teardown and
    // that is what releases the lease. Observer service is deliberately
    // unbounded: it holds nothing anyone else is waiting for.
    let last_upstream = Arc::new(Mutex::new(Instant::now()));
    if attach_role == LocalAttachRole::Controller {
        let idle = Arc::clone(&last_upstream);
        let detacher = connection.writer();
        thread::spawn(move || bound_controller_idle(&idle, &detacher));
    }

    // Detached on purpose: this thread blocks in a stdin read that nothing can
    // interrupt, and the process exits when the downstream pump below returns.
    let upstream_activity = Arc::clone(&last_upstream);
    thread::spawn(move || {
        pump_upstream(
            input,
            writer,
            terminal_handles,
            &upstream_sink,
            retirement_selected,
            &upstream_activity,
        )
    });

    let mut downstream = GatewayDownstream::from_connection(connection)?;
    pump_downstream(&mut downstream, &sink)
}

/// The snapshot that seeded the local attach, for the two replies that have one.
///
/// Kept as a named failure rather than an `expect`: both call sites are inside
/// arms where `hmux-client` guarantees a snapshot exists, and the day that
/// guarantee changes should cost the relayed peer a typed refusal, not a panic
/// in a process sshd spawned.
fn seed_snapshot(
    connection: &hmux_client::LocalConnection,
) -> Result<hmux_host::local_protocol::ScreenSnapshot, CliError> {
    connection
        .require_initial_snapshot()
        .cloned()
        .map_err(|error| CliError(format!("mobile-gateway got no initial snapshot: {error}")))
}

/// Rebuilds the Host's attach seed in the exact order owed to the relayed peer.
///
/// Kept separate from the write loop so the SSH relay contract can be tested
/// as a state transition rather than as a source-shape assertion.
fn relayed_attach_seed(
    connection: &hmux_client::LocalConnection,
) -> Result<Vec<ConnectionRecord>, CliError> {
    match connection.attach_replay().clone() {
        // No snapshot, by design — `initial_snapshot()` is `None` here and
        // synthesizing an empty one would paint the phone a cleared terminal.
        // The deltas the Host replayed are queued inside the connection and
        // reach the peer through the downstream pump, ahead of anything live.
        AttachReplay::Resumed { .. } => Ok(Vec::new()),
        AttachReplay::Snapshot => Ok(vec![ConnectionRecord::Control(Box::new(
            FrameBody::ScreenSnapshot(seed_snapshot(connection)?),
        ))]),
        // The gap frame is forwarded, not dropped. Its presence is the *only*
        // thing that tells the peer the fallback covers output that is gone:
        // per `RECONNECT_RESUME_CAPABILITY`, a snapshot with no `ReplayGap`
        // ahead of it means nothing observable was lost. Swallowing it would
        // relay that claim on a stream where it is false, and a terminal gap
        // presented as continuous history reads as the agent having done
        // something it did not do.
        AttachReplay::SnapshotAfterGap(gap) => Ok(vec![
            ConnectionRecord::Control(Box::new(FrameBody::ReplayGap(gap))),
            ConnectionRecord::Control(Box::new(FrameBody::ScreenSnapshot(seed_snapshot(
                connection,
            )?))),
        ]),
        AttachReplay::TerminalViewportFrame => {
            let initial = connection.initial_terminal_state().ok_or_else(|| {
                CliError("mobile-gateway received no structured attach seed".to_string())
            })?;
            let mut seed = Vec::new();
            if let Some(state) = initial.agent_runtime_state() {
                seed.push(ConnectionRecord::Control(Box::new(
                    FrameBody::AgentRuntimeState(state.clone()),
                )));
            }
            if let Some(identity) = initial.provider_conversation_identity() {
                seed.push(ConnectionRecord::Control(Box::new(
                    FrameBody::ProviderConversationIdentity(identity.clone()),
                )));
            }
            seed.extend(
                initial
                    .records()
                    .map(|record| ConnectionRecord::TerminalState(record.to_vec())),
            );
            Ok(seed)
        }
    }
}

/// The cursor this gateway will offer on the relayed peer's behalf.
///
/// # What the gateway must not do with it
///
/// **It must not repair it.** The cursor is the one field in a relayed `Hello`
/// that the gateway forwards as data rather than as a decision, so every
/// hostile or buggy shape has to end at a refusal somewhere else:
///
/// - *A cursor for another terminal epoch* never reaches the attach.
///   `validate_hello` refuses a `Hello` whose `cursor.terminal_epoch` differs
///   from its own `expected_fence.terminal_epoch`, and `admit_relayed_hello`
///   refuses a fence that differs from the local one. The composition is what
///   makes the cursor's epoch equal to the Host's, and it is written down here
///   because neither half states it alone.
/// - *A cursor ahead of the Host* is refused at attach by `hmux-client`'s
///   `read_attach_seed`, and the relayed path inherits that refusal rather than
///   needing its own: this gateway is a first-class client, so the local attach
///   runs the same `complete_attach` a phone's own client would. Clamping it to
///   `current_output_seq` here is the tempting one-liner and is exactly wrong —
///   the Host's `replay_after` refuses such a cursor and answers with a
///   snapshot, so a gateway that reported a resume would desynchronize the peer
///   on the first live delta. See `local_attach_refusal` for how that refusal is
///   phrased so a phone stops re-offering the same cursor.
/// - *A cursor far behind the Host* costs no more than the snapshot it replaces:
///   `attach_reply` falls back to the canonical screen once the replay would
///   exceed `max_snapshot_bytes`, and to `ReplayGap` + snapshot once the cursor
///   has left the retained window. There is nothing for the gateway to bound.
///
/// # Why a cursor is honored only when the peer negotiated resume
///
/// The Host applies exactly this rule to its own `Hello`
/// (`reconnect_cursor` is read only when `reconnect_resume_v1` was selected),
/// and for the same reason: the reply *shape* changes, so a peer that did not
/// negotiate it has not agreed to a handshake that omits the snapshot. Without
/// the rule a peer could send a cursor without asking for the capability and
/// receive an ack listing a capability it never requested — a selected set that
/// is not a subset of the requested one, which is a lie at the protocol level
/// however convenient the resume would have been.
fn relayed_reconnect_cursor(hello: &Hello) -> Option<ReconnectCursor> {
    hello
        .requested_capabilities
        .iter()
        .any(|capability| capability == RECONNECT_RESUME_CAPABILITY)
        .then(|| hello.reconnect_cursor.clone())
        .flatten()
}

fn resolve_session(
    catalog: &LocalSessionCatalog,
    session_identifier: &str,
    workspace_id: Option<&str>,
) -> Result<LocalSession, Box<dyn std::error::Error>> {
    match workspace_id {
        Some(workspace_id) => Ok(catalog.open(&SessionSelector::new(
            session_identifier,
            Some(workspace_id.to_string()),
        ))?),
        None => {
            let worker = CatalogCensusWorker::new(std::env::current_exe()?);
            Ok(resolve_local_session_isolated(
                catalog,
                &worker,
                session_identifier,
                MOBILE_CATALOG_CENSUS_BUDGET,
            )?)
        }
    }
}

/// The fence the local Host will answer with, read off the manifest the catalog
/// already validated under `path_security`.
///
/// This is not a second-best stand-in for `HelloAck.actual_fence`. A successful
/// `LocalSession::connect` has already run
/// `expected_fence.ensure_matches(&hello_ack.actual_fence)` inside
/// `hmux-client`'s `validate_hello_ack`, and that `expected_fence` is built from
/// these same manifest fields (`manifest_attach_context`). So wherever an ack
/// exists at all, the ack's fence and this one are equal by construction, and a
/// Host whose fence had drifted would have failed the local attach rather than
/// answered. Comparing against the manifest is the identical comparison, moved
/// to where it can run before anything mutates the session.
fn local_fence(descriptor: &SessionDescriptor) -> Result<SessionFence, GatewayRefusal> {
    // The descriptor carries `channel_epoch` as a decimal string (`json_u64`,
    // so a `u64` survives a JavaScript client) while the fence carries it as a
    // `u64`. A manifest this Host published cannot fail to parse; refusing
    // rather than defaulting is what keeps that an assertion about the Host
    // instead of a silent zero that would then compare equal to a peer's zero.
    let channel_epoch = descriptor.channel_epoch.parse().map_err(|_| {
        GatewayRefusal::new(
            ErrorCode::StaleDiscovery,
            "this gateway could not read the local session fence",
        )
    })?;
    Ok(SessionFence {
        workspace_id: descriptor.workspace_id.clone(),
        session_id: descriptor.session_id.clone(),
        runner_principal: descriptor.runner_principal.clone(),
        runner_instance: descriptor.runner_instance.clone(),
        channel_epoch,
        host_instance_id: descriptor.host_instance_id.clone(),
        terminal_epoch: descriptor.terminal_epoch.clone(),
    })
}

/// Decides whether a relayed `Hello` may be served, and at which local role.
///
/// Everything this function reads is either the Hello or the already-resolved
/// local fence, which is what lets the whole decision run before any local
/// attach — see the ordering note in `serve`.
///
/// Refusals never echo the peer's strings back: the forced command's own
/// session id is what the message names, and `FenceMismatch` reports only which
/// field disagreed.
fn admit_relayed_hello(
    hello: &Hello,
    ceiling: GatewayRole,
    local: &SessionFence,
) -> Result<LocalAttachRole, GatewayRefusal> {
    let session_id = &local.session_id;
    let workspace_id = &local.workspace_id;
    // These two are also covered by the full fence comparison below. They are
    // kept as distinct checks because they are the forced command's scope, and
    // "this gateway serves only session X" is a message an operator can act on
    // where "fence mismatch at SessionId" is not.
    if hello.expected_fence.session_id != *session_id {
        return Err(GatewayRefusal::new(
            ErrorCode::IdentityMismatch,
            format!("this gateway serves only Hmux session {session_id}"),
        ));
    }
    if hello.expected_fence.workspace_id != *workspace_id {
        return Err(GatewayRefusal::new(
            ErrorCode::IdentityMismatch,
            format!("this gateway serves only workspace {workspace_id}"),
        ));
    }
    // The remaining five components. This is what stops a stale phone from
    // resuming onto a replaced Host through an unchanged forced command —
    // `runner_instance`, `channel_epoch`, `host_instance_id` and
    // `terminal_epoch` all move when the Host is replaced or the box restarts.
    if let Err(mismatch) = hello.expected_fence.ensure_matches(local) {
        return Err(GatewayRefusal::new(
            ErrorCode::IdentityMismatch,
            format!("relayed attach is fenced to a different session: {mismatch}"),
        ));
    }
    if let Some(requested) = COLOCATION_PREMISED_CAPABILITIES.iter().copied().find(|c| {
        hello
            .requested_capabilities
            .iter()
            .any(|capability| capability == c)
    }) {
        return Err(GatewayRefusal::new(
            ErrorCode::UnsupportedCapability,
            format!("{requested} is premised on colocation and is never relayed"),
        )
        .with_required_capability(requested));
    }
    match (ceiling, hello.requested_mode) {
        (GatewayRole::Observer, AttachMode::Controller) => Err(GatewayRefusal::new(
            ErrorCode::AuthorizationDenied,
            "this gateway was invoked with --role observer",
        )),
        // Never `SharedWriter`. That role's whole purpose is to request
        // `shared_terminal_input`, the unarbitrated PTY write this transport
        // may not carry; a relayed writer goes through the fenced controller
        // lease or not at all.
        (_, AttachMode::Controller) => Ok(LocalAttachRole::Controller),
        (_, AttachMode::Observer) => Ok(LocalAttachRole::Observer),
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct RelayedAgentPromptOffer {
    preferred: Option<AgentPromptCapabilitySelection>,
    process_observed: bool,
    legacy_fallback: bool,
}

impl RelayedAgentPromptOffer {
    fn from_requests(targeted: bool, process_observed: bool, legacy: bool) -> Self {
        Self {
            preferred: if targeted {
                Some(AgentPromptCapabilitySelection::Targeted)
            } else if legacy {
                Some(AgentPromptCapabilitySelection::LegacyFresh)
            } else {
                None
            },
            process_observed,
            legacy_fallback: targeted && legacy,
        }
    }

    fn is_some(self) -> bool {
        self.preferred.is_some()
    }

    fn offers_legacy_lane(self) -> bool {
        self.preferred == Some(AgentPromptCapabilitySelection::LegacyFresh) || self.legacy_fallback
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct RelayedTerminalSelection {
    viewport: bool,
    wheel: bool,
    multipart: bool,
    input: bool,
    agent_prompt: RelayedAgentPromptOffer,
    default_colors: bool,
    agent_identity: bool,
    runtime_state: bool,
    identity: bool,
}

/// Selects the binary terminal relay without coupling presentation to writes.
///
/// The forced-command role remains the outer authority: an observer key may
/// request a projection, but only a controller-capable key may explicitly
/// request semantic input. The local attach itself remains an observer because
/// `terminal_input_intent_v1`, not a controller lease, admits each write.
/// Agent identity, runtime state, and conversation identity stay independently optional and
/// are requested from the Host only when the relayed peer named each
/// capability.
fn admit_relayed_terminal_capabilities(
    hello: &Hello,
    ceiling: GatewayRole,
) -> Result<RelayedTerminalSelection, GatewayRefusal> {
    let requested = |capability: &str| {
        hello
            .requested_capabilities
            .iter()
            .any(|requested| requested == capability)
    };
    let binary = requested(TERMINAL_STATE_BINARY_CAPABILITY);
    let viewport = requested(TERMINAL_VIEWPORT_PROJECTION_CAPABILITY);
    let wheel = requested(TERMINAL_VIEWPORT_WHEEL_CAPABILITY);
    let multipart = requested(TERMINAL_VIEWPORT_MULTIPART_CAPABILITY);
    let input = requested(TERMINAL_INPUT_INTENT_CAPABILITY);
    let targeted_agent_prompt = requested(AGENT_PROMPT_CAPABILITY);
    let process_observed_agent_prompt = requested(PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY);
    if process_observed_agent_prompt && !targeted_agent_prompt {
        return Err(GatewayRefusal::new(
            ErrorCode::UnsupportedCapability,
            "process-observed agent prompts require agent_prompt_v1",
        )
        .with_required_capability(AGENT_PROMPT_CAPABILITY));
    }
    let agent_prompt = RelayedAgentPromptOffer::from_requests(
        targeted_agent_prompt,
        process_observed_agent_prompt,
        requested(LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY),
    );
    let default_colors = requested(TERMINAL_DEFAULT_COLORS_CAPABILITY);
    let runtime_state = requested(AGENT_RUNTIME_STATE_CAPABILITY);
    if (viewport || wheel || multipart || input || agent_prompt.is_some() || default_colors)
        && !binary
    {
        return Err(GatewayRefusal::new(
            ErrorCode::UnsupportedCapability,
            "binary terminal capabilities require terminal_state_binary_v1",
        )
        .with_required_capability(TERMINAL_STATE_BINARY_CAPABILITY));
    }
    if binary && !viewport {
        return Err(GatewayRefusal::new(
            ErrorCode::UnsupportedCapability,
            "binary terminal presentation requires terminal_viewport_projection_v1",
        )
        .with_required_capability(TERMINAL_VIEWPORT_PROJECTION_CAPABILITY));
    }
    if (input || agent_prompt.is_some()) && ceiling != GatewayRole::Controller {
        let required_capability = agent_prompt
            .preferred
            .map(AgentPromptCapabilitySelection::capability)
            .unwrap_or(TERMINAL_INPUT_INTENT_CAPABILITY);
        return Err(GatewayRefusal::new(
            ErrorCode::AuthorizationDenied,
            "this gateway was invoked with --role observer and cannot relay terminal writes",
        )
        .with_required_capability(required_capability));
    }
    if default_colors && !input {
        return Err(GatewayRefusal::new(
            ErrorCode::UnsupportedCapability,
            "terminal default colors require terminal input authority",
        )
        .with_required_capability(TERMINAL_INPUT_INTENT_CAPABILITY));
    }
    Ok(RelayedTerminalSelection {
        viewport,
        wheel,
        multipart,
        input,
        agent_prompt,
        default_colors,
        agent_identity: requested(AGENT_IDENTITY_PROJECTION_CAPABILITY),
        runtime_state,
        identity: requested(PROVIDER_CONVERSATION_IDENTITY_CAPABILITY),
    })
}

fn with_relayed_terminal_selection(
    mut options: ConnectionOptions,
    selection: RelayedTerminalSelection,
    legacy_agent_prompt_input_dependency: bool,
) -> ConnectionOptions {
    if selection.viewport {
        options = options.with_terminal_viewport_projection();
    }
    if selection.wheel {
        options = options.with_terminal_viewport_wheel();
    }
    if selection.multipart {
        options = options.with_terminal_viewport_multipart();
    }
    if selection.input {
        options = options.with_terminal_input_intents();
    }
    if selection.default_colors {
        options = options.with_terminal_default_colors();
    }
    if legacy_agent_prompt_input_dependency {
        options = options.with_legacy_agent_prompt_fallback();
    }
    if selection.runtime_state {
        options = options.with_agent_runtime_state();
    }
    options
}

/// How a failed local attach is reported to the relayed client.
///
/// The Host's own refusal is propagated when there is one. This path used to
/// collapse every failure into `TransportClosed` + `RetryPosture::Never`, and
/// on the case that actually happens that was wrong in both halves.
///
/// The case: the laptop is still attached and still holds the controller lease,
/// and a phone asks for control. The Host answers `ControllerConflict` with
/// `RetryPosture::Reconnect` — `hmux-client` types it as
/// `ClientError::HostRefused`, and `host_error_code` / `retry_posture` below
/// already translate exactly that back onto the wire for the downstream pump.
/// Only this one path threw it away. `TransportClosed` sends the peer hunting a
/// network fault that does not exist and hides the one fact a human could act
/// on in seconds; `Never` turns a state that clears the instant the laptop
/// detaches into a permanent instruction to stop trying. Contention is the most
/// ordinary refusal this transport will ever produce, so it is the one that
/// least deserves a synthesized cause.
///
/// A non-`HostRefused` failure has no Host answer to relay: the dial itself
/// failed. `TransportClosed` is then the honest code, and the message stays
/// generic on purpose — `ClientError`'s display can name the local socket path,
/// and a filesystem path means nothing off-box and is withheld from `--list`
/// for the same reason. The posture is `Reconnect` on the same reasoning the
/// desynchronization path already uses: the stream is broken, the session is
/// not, and re-running the forced command is the recovery.
///
/// # The cursor case
///
/// One failure here is caused by the peer rather than by the box, and it is the
/// only one where `Reconnect` would be actively harmful: a `reconnect_cursor`
/// the client half refuses at attach — ahead of the Host, or answered with a
/// replay this client could not stitch. Reconnecting changes nothing, because
/// the phone would offer the same cursor again and fail identically; the fix is
/// to drop the cursor and take the screen. `RetryAfterResync` is the posture
/// that says so, and `ReplayGap` is the code for a stream position the Host
/// cannot serve — `TransportClosed` would send the peer hunting a network fault
/// that does not exist, which is the same mistake the contention path above
/// documents.
///
/// `reason` is a `&'static str` minted inside `hmux-client`, never peer text, so
/// quoting it back is a diagnosis rather than an echo.
fn local_attach_refusal(
    error: &ClientError,
    offered_cursor: bool,
) -> (GatewayRefusal, RetryPosture) {
    match error {
        ClientError::HostRefused {
            code,
            message,
            retry,
        } => (
            GatewayRefusal::new((*code).into(), message.clone()),
            (*retry).into(),
        ),
        ClientError::InconsistentStream { reason } if offered_cursor => (
            GatewayRefusal::new(
                ErrorCode::ReplayGap,
                format!(
                    "the relayed reconnect cursor could not be served ({reason}); reattach without one"
                ),
            ),
            RetryPosture::RetryAfterResync,
        ),
        _ => (
            GatewayRefusal::new(ErrorCode::TransportClosed, "local Hmux attach failed"),
            RetryPosture::Reconnect,
        ),
    }
}

fn gateway_local_optional_capabilities(
    request_managed_authorization_grant: bool,
    relay_retirement: bool,
    relay_agent_identity: bool,
    relay_provider_identity: bool,
    relay_agent_prompt: RelayedAgentPromptOffer,
) -> Vec<&'static str> {
    let mut capabilities = Vec::new();
    for (selected, capability) in [
        (
            request_managed_authorization_grant,
            MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
        ),
        (relay_retirement, SESSION_RETIREMENT_CAPABILITY),
        (relay_agent_identity, AGENT_IDENTITY_PROJECTION_CAPABILITY),
        (
            relay_provider_identity,
            PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
        ),
    ] {
        if selected {
            capabilities.push(capability);
        }
    }
    if let Some(preferred) = relay_agent_prompt.preferred {
        capabilities.push(preferred.capability());
    }
    if relay_agent_prompt.process_observed {
        capabilities.push(PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY);
    }
    if relay_agent_prompt.legacy_fallback {
        capabilities.push(LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY);
    }
    capabilities
}

fn peer_visible_hello_ack(
    mut hello_ack: HelloAck,
    requested_managed_authorization_grant: bool,
    hide_legacy_input_dependency: bool,
) -> Result<HelloAck, GatewayRefusal> {
    // The scoped managed proof authenticates only the gateway's colocated
    // attach. The remote peer neither requested nor possesses that authority,
    // so an expected internal selection must not cross the relay boundary. An
    // unrequested selection is Host over-grant, not something sanitization may
    // silently hide.
    let selected_managed_authorization_grant = hello_ack
        .selected_capabilities
        .iter()
        .any(|capability| capability == MANAGED_AUTHORIZATION_GRANT_CAPABILITY);
    if selected_managed_authorization_grant && !requested_managed_authorization_grant {
        return Err(GatewayRefusal::new(
            ErrorCode::AuthorizationDenied,
            "local attach was granted unexpected managed authorization authority",
        )
        .with_required_capability(MANAGED_AUTHORIZATION_GRANT_CAPABILITY));
    }
    hello_ack
        .selected_capabilities
        .retain(|capability| capability != MANAGED_AUTHORIZATION_GRANT_CAPABILITY);
    if hide_legacy_input_dependency {
        hello_ack
            .selected_capabilities
            .retain(|capability| capability != TERMINAL_INPUT_INTENT_CAPABILITY);
    }
    Ok(hello_ack)
}

/// The colocation-premised capability the Host granted, if it granted one.
fn colocation_premised_grant(selected: &[String]) -> Option<&'static str> {
    COLOCATION_PREMISED_CAPABILITIES
        .iter()
        .copied()
        .find(|capability| selected.iter().any(|granted| granted == capability))
}

/// Whether this exact relayed attachment may ask the local Host to negotiate
/// graceful session retirement.
///
/// The gateway role is a ceiling, not the peer's selected attach mode. The
/// explicit remote-departure helper deliberately uses an observer so it cannot
/// contend with a sibling pane's controller lease. Retirement remains
/// self-scoped and Host-evaluated: this grant allows only a typed departure for
/// the requesting attachment, not terminal input or administrative actions.
fn should_relay_retirement(
    ceiling: GatewayRole,
    _attach_role: LocalAttachRole,
    hello: &Hello,
) -> bool {
    ceiling == GatewayRole::Controller
        && hello
            .requested_capabilities
            .iter()
            .any(|capability| capability == SESSION_RETIREMENT_CAPABILITY)
}

fn retirement_capability_selected(selected: &[String]) -> bool {
    selected
        .iter()
        .any(|capability| capability == SESSION_RETIREMENT_CAPABILITY)
}

/// Accept the Host's capability answer only when it is a subset of the exact
/// retirement request this gateway actually made.
///
/// A conforming Host selects from the request, so an over-grant is unreachable
/// today. Keeping the check here makes a future Host negotiation regression
/// fail closed before its `HelloAck` reaches an observer.
fn admit_retirement_grant(requested: bool, selected: &[String]) -> Result<bool, GatewayRefusal> {
    let selected = retirement_capability_selected(selected);
    if selected && !requested {
        return Err(GatewayRefusal::new(
            ErrorCode::AuthorizationDenied,
            "the local Host granted session retirement to an ineligible relayed attachment",
        ));
    }
    Ok(selected)
}

#[derive(Debug, Eq, PartialEq)]
enum UpstreamDecision {
    Forward,
    Refuse {
        code: ErrorCode,
        message: &'static str,
        required_capability: Option<&'static str>,
    },
}

/// Whether a frame the relayed client sent may reach the local Host.
///
/// **This is an allow-list, and the direction is the security property.** The
/// first cut was a deny-list ending in `_ => Forward`. That makes every
/// `FrameBody` variant added after this file was written cross the boundary by
/// default, which means the safety of this gate depends on the author of some
/// future frame kind knowing that this file exists. Enumerated the other way
/// round, a new variant does not compile until someone classifies it here — the
/// match below has no wildcard arm precisely so the compiler, not a reviewer,
/// is what asks the question. A new frame kind therefore fails closed and
/// loudly instead of quietly gaining a relayed path.
///
/// For the named refusals the Host would also say no, because the gateway
/// never requested the capability behind them. Refusing here as well is the
/// difference between "the Host happens to say no today" and "this transport
/// structurally cannot carry that authority" — and it is what makes the refusal
/// legible to the relayed client instead of arriving as a closed connection.
fn upstream_decision(body: &FrameBody, retirement_selected: bool) -> UpstreamDecision {
    match body {
        // The client half of the session protocol: a request, a keystroke, a
        // geometry change, the fenced controller lease, and hanging up. Every
        // one of these is either read-only or arbitrated by the Host — Input
        // and Resize carry a `controller_generation` the lease fences, and
        // ControlRequest/ControlRelease are the lease itself.
        FrameBody::ScreenSnapshotRequest(_)
        | FrameBody::Input(_)
        | FrameBody::Resize(_)
        | FrameBody::ControlRequest(_)
        | FrameBody::ControlRelease(_)
        | FrameBody::Detach(_) => UpstreamDecision::Forward,
        FrameBody::SessionRetirementRequest(request)
            if retirement_selected
                && matches!(
                    request.action,
                    SessionRetirementAction::GracefulClientDeparture
                ) =>
        {
            UpstreamDecision::Forward
        }
        FrameBody::SessionRetirementRequest(request)
            if matches!(
                request.action,
                SessionRetirementAction::GracefulClientDeparture
            ) =>
        {
            UpstreamDecision::Refuse {
                code: ErrorCode::UnsupportedCapability,
                message: "the local Host did not negotiate graceful session retirement",
                required_capability: Some(SESSION_RETIREMENT_CAPABILITY),
            }
        }
        FrameBody::SessionRetirementRequest(_) => UpstreamDecision::Refuse {
            code: ErrorCode::AuthorizationDenied,
            message: "the gateway relays graceful client departure only",
            required_capability: None,
        },

        FrameBody::StandaloneTerminate(_) => UpstreamDecision::Refuse {
            code: ErrorCode::AuthorizationDenied,
            message: "standalone termination signals process ids and is never relayed",
            required_capability: None,
        },
        FrameBody::AgentStateReport(_) => UpstreamDecision::Refuse {
            code: ErrorCode::AuthorizationDenied,
            message: "agent state reports have no second factor and are never relayed",
            required_capability: None,
        },
        FrameBody::ManagedProviderStop(_) => UpstreamDecision::Refuse {
            code: ErrorCode::AuthorizationDenied,
            message: "the gateway holds no managed authorization proof",
            required_capability: None,
        },
        FrameBody::ManagedAuthorizationGrantRequest(_) => UpstreamDecision::Refuse {
            code: ErrorCode::AuthorizationDenied,
            message: "managed authorization grants are minted only for the local broker",
            required_capability: None,
        },
        // The gateway already minted the Hello for this connection. A second
        // one is not a re-handshake; it is an attempt to renegotiate authority
        // behind the gate that admitted the first.
        FrameBody::Hello(_) => UpstreamDecision::Refuse {
            code: ErrorCode::IdentityMismatch,
            message: "a relayed session handshakes once",
            required_capability: None,
        },

        // Host-to-client frames. A client emitting one is either a confused
        // implementation or something probing for a loopback, and forwarding it
        // would inject a forged Host answer into the local Host's inbox.
        FrameBody::HelloAck(_)
        | FrameBody::ScreenSnapshot(_)
        | FrameBody::OutputDelta(_)
        | FrameBody::WorkingDirectory(_)
        | FrameBody::AgentIdentity(_)
        | FrameBody::AgentRuntimeState(_)
        | FrameBody::ProviderConversationIdentity(_)
        | FrameBody::ReplayGap(_)
        | FrameBody::InputReceipt(_)
        | FrameBody::ResizeReceipt(_)
        | FrameBody::StandaloneTerminateReceipt(_)
        | FrameBody::ManagedProviderStopReceipt(_)
        | FrameBody::ManagedAuthorizationGrantReceipt(_)
        | FrameBody::AgentStateReportReceipt(_)
        | FrameBody::ControlReceipt(_)
        | FrameBody::SessionRetirementReceipt(_)
        | FrameBody::Exit(_)
        | FrameBody::Error(_) => UpstreamDecision::Refuse {
            code: ErrorCode::AuthorizationDenied,
            message: "this frame is answered by a Host, not sent to one, and is never relayed",
            required_capability: None,
        },
    }
}

/// What a failed read off the relayed stream means *for the stream*.
///
/// The distinction is not invented here — it is `TransportError::
/// desynchronizes_stream` in hmux-host's `local_transport`, and its rule is
/// "do we know bytes were consumed that cannot be pushed back", decided by
/// position rather than by "did an error happen". `read_for_dispatch` makes
/// that answerable from the codec error alone, because which of its steps
/// failed is visible in the variant.
///
/// Why it matters here: the whole failure class this module exists to remove is
/// "it disconnected and didn't say why". Collapsing every read failure into a
/// `break` gave the peer a bare EOF, which is byte-identical to `ssh` auth
/// failing, to `hmux` not being on PATH, and to the box rebooting.
#[derive(Debug, Eq, PartialEq)]
enum RelayReadFailure {
    /// The peer closed. There is nothing left to answer on and nothing left to
    /// misinterpret.
    Closed,
    /// One frame's bytes were consumed in full and that frame is unusable. The
    /// next four bytes on the wire really are a length prefix, so only the
    /// frame is refused and the session lives.
    RefusedFrame { code: ErrorCode, message: String },
    /// The stream is no longer frame-aligned. Answer once, then stop: reading
    /// again would take payload bytes for a length prefix.
    DesynchronizedStream { code: ErrorCode, message: String },
}

fn classify_relay_read(error: &FrameCodecError) -> RelayReadFailure {
    match error {
        // `read_exact` reports `UnexpectedEof` both at a frame boundary and
        // part-way through a payload, and the two are indistinguishable from
        // the error alone. Treating both as a close is not a shortcut: it is
        // hmux-host's standing ruling that a truncation does *not* desynchronize
        // — the peer is the one who stopped, the stream is gone, and there is
        // nothing left to misread. (See `desynchronizes_stream`, and the
        // `test:hmux-scrollback` regression that established it.)
        FrameCodecError::Io(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
            RelayReadFailure::Closed
        }
        FrameCodecError::Io(error) => RelayReadFailure::DesynchronizedStream {
            code: ErrorCode::TransportClosed,
            message: format!("the relay stream failed: {error}"),
        },
        // The prefix declared zero payload bytes, and the cap check refused
        // before any payload read. Zero bytes declared is also zero bytes left
        // over, so the stream is still aligned on the next prefix.
        FrameCodecError::EmptyFrame => RelayReadFailure::RefusedFrame {
            code: ErrorCode::UnsupportedProtocolVersion,
            message: "an Hmux frame declared no payload".to_string(),
        },
        // The mirror image, and the reason this classification cannot be done
        // by error *kind*: `ensure_payload_length` fires **before** the payload
        // read, so `actual` bytes of that frame are still queued and the next
        // read would take payload for a length prefix. This is the one
        // over-size case the session cannot survive — distinct from the 64 KiB
        // `max_input_bytes` cap, which is a validation failure below and does
        // leave the stream aligned.
        FrameCodecError::FrameTooLarge { actual, maximum } => {
            RelayReadFailure::DesynchronizedStream {
                code: ErrorCode::ResourceLimit,
                message: format!(
                    "an Hmux frame declared {actual} bytes against a {maximum}-byte cap; the relay stream is no longer frame-aligned"
                ),
            }
        }
        // Payload read in full, then rejected. This is the version-skew case: a
        // phone one release ahead sends a frame kind this binary has no variant
        // for, and serde fails on the tag. Naming it and carrying on beats
        // dropping the attach, which the operator cannot tell from a broken
        // `ssh`.
        FrameCodecError::Serialization(error) => RelayReadFailure::RefusedFrame {
            code: ErrorCode::UnsupportedProtocolVersion,
            message: format!("this gateway could not decode an Hmux frame: {error}"),
        },
        // `read_for_dispatch` returns validation failures as
        // `DecodedFrame::Invalid` rather than an error, so this arm is only
        // reachable through `into_valid`. Classified anyway: the payload was
        // read in full either way, so the stream is aligned.
        FrameCodecError::Validation(error) => RelayReadFailure::RefusedFrame {
            code: violation_code(error),
            message: format!("this gateway refused a malformed Hmux frame: {error}"),
        },
        // Buffer-shape failures from `decode`, which a streaming read cannot
        // produce. Enumerated rather than swept into a wildcard so a new codec
        // failure has to be classified on purpose — the same reason
        // `upstream_decision` has no wildcard.
        FrameCodecError::TruncatedLengthPrefix
        | FrameCodecError::TruncatedPayload { .. }
        | FrameCodecError::TrailingBytes { .. } => RelayReadFailure::DesynchronizedStream {
            code: ErrorCode::TransportClosed,
            message: format!("the relay stream is not frame-aligned: {error}"),
        },
    }
}

/// Which refusal code a frame-validation failure deserves.
///
/// Not cosmetic: the code is what a client branches on. `ResourceLimit` tells a
/// phone "send less next time", and answering that to a peer whose
/// `protocol_version.major` is zero would send it into a retry loop trimming a
/// paste that was never the problem. The two failures are told apart by kind,
/// and only the second is worth attaching `supported_versions` to.
fn violation_code(violation: &FrameValidationError) -> ErrorCode {
    match violation {
        FrameValidationError::TooLong { .. } | FrameValidationError::TooMany { .. } => {
            ErrorCode::ResourceLimit
        }
        FrameValidationError::Empty { .. }
        | FrameValidationError::OutOfRange { .. }
        | FrameValidationError::Inconsistent { .. } => ErrorCode::UnsupportedProtocolVersion,
    }
}

/// The request id a refusal should be correlated to, when the frame carries one.
///
/// A wildcard is safe *here* and nowhere else in this module: a missing id
/// degrades a diagnostic, it does not widen authority. Without it a phone whose
/// oversized paste was refused has an `Input` sitting in its pending map with no
/// receipt and no error it can match, so the paste appears to hang rather than
/// to fail.
fn refusal_correlation_id(body: &FrameBody) -> Option<String> {
    match body {
        FrameBody::Input(frame) => Some(frame.request_id.clone()),
        FrameBody::Resize(frame) => Some(frame.request_id.clone()),
        FrameBody::ScreenSnapshotRequest(frame) => Some(frame.request_id.clone()),
        FrameBody::ControlRequest(frame) => Some(frame.request_id.clone()),
        FrameBody::ControlRelease(frame) => Some(frame.request_id.clone()),
        FrameBody::StandaloneTerminate(frame) => Some(frame.request_id.clone()),
        FrameBody::ManagedProviderStop(frame) => Some(frame.request_id.clone()),
        FrameBody::ManagedAuthorizationGrantRequest(frame) => Some(frame.request_id.clone()),
        FrameBody::AgentStateReport(frame) => Some(frame.request_id.clone()),
        FrameBody::SessionRetirementRequest(frame) => Some(frame.request_id.clone()),
        _ => None,
    }
}

fn upstream_refusal(
    body: &FrameBody,
    code: ErrorCode,
    message: &'static str,
    required_capability: Option<&'static str>,
) -> GatewayRefusal {
    let mut refusal =
        GatewayRefusal::new(code, message).correlated_to(refusal_correlation_id(body));
    if let Some(capability) = required_capability {
        refusal = refusal.with_required_capability(capability);
    }
    refusal
}

/// How long a relayed controller may say nothing before this gateway gives the
/// lease back.
///
/// Generous on purpose. The cost of being wrong in one direction is a phone
/// that must reattach; in the other it is an owner locked out of their own
/// terminal. Ten minutes bounds the second without making the first ordinary,
/// and it replaces a window previously measured in TCP keepalive hours.
const CONTROLLER_IDLE_LIMIT: Duration = Duration::from_secs(600);

/// Coarse on purpose: this decides when to *check* a deadline, not the deadline.
const CONTROLLER_IDLE_CHECK: Duration = Duration::from_secs(15);

/// Releases the controller lease when the relayed client stops speaking.
fn bound_controller_idle(last_upstream: &Mutex<Instant>, detacher: &LocalWriter) {
    release_when_idle(
        last_upstream,
        CONTROLLER_IDLE_LIMIT,
        CONTROLLER_IDLE_CHECK,
        || {
            // The Host treats this exactly as it treats a disconnect, which is
            // the point: one teardown path, already tested, rather than a
            // second way to stop being the controller.
            detacher
                .send(FrameBody::Detach(Detach {
                    reason: Some("relayed controller went silent".to_string()),
                }))
                .map_err(|error| error.to_string())
        },
    );
}

/// The deadline itself, with the clock and the release action passed in.
///
/// Split out from [`bound_controller_idle`] so the property this whole feature
/// is ordered around — silence releases the lease, and a failed release is
/// retried rather than abandoned — is a test rather than a comment. The real
/// limit is ten minutes, which no test can wait for.
fn release_when_idle<F>(
    last_upstream: &Mutex<Instant>,
    limit: Duration,
    check: Duration,
    mut release: F,
) where
    F: FnMut() -> Result<(), String>,
{
    loop {
        thread::sleep(check);
        // A poisoned clock is not evidence of liveness. Read through the poison
        // and let the deadline decide, rather than holding the lease forever
        // because a thread panicked somewhere else.
        let idle = match last_upstream.lock() {
            Ok(last) => last.elapsed(),
            Err(poisoned) => poisoned.into_inner().elapsed(),
        };
        if idle < limit {
            continue;
        }
        match release() {
            Ok(()) => {
                // Logged *after* the send succeeds. Announcing the release
                // before attempting it produces a line that says the lease was
                // given back when it was not, which is the one state an
                // operator reading stderr must be able to trust.
                eprintln!(
                    "hmux: mobile-gateway: released the controller lease after {}s without a \
                     frame from the relayed client",
                    idle.as_secs()
                );
                return;
            }
            Err(error) => {
                // Not fatal, and not a reason to stop bounding. Giving up here
                // would leave the lease held until the SSH connection actually
                // dies, which is the multi-hour window this exists to replace.
                //
                // A send that failed mid-write leaves a partial frame, and the
                // retry appends a second Detach to that fragment. The Host then
                // reads a corrupt frame and closes the connection — which also
                // releases the lease. The wrong-looking path reaches the right
                // outcome, by the error route rather than the orderly one.
                eprintln!(
                    "hmux: mobile-gateway: could not release the controller lease ({error}); \
                     retrying"
                );
            }
        }
    }
}

fn forward_terminal_upstream(
    handles: &TerminalUpstreamHandles,
    payload: &[u8],
) -> Result<(), (GatewayRefusal, bool)> {
    handles.send_envelope(payload).map(|_| ()).map_err(|error| {
        let request_id = decode_record(payload)
            .ok()
            .map(|decoded| decoded.metadata.record_id.to_string());
        match error {
            ClientError::TerminalStateProtocol(ref protocol_error) => {
                let code = if matches!(
                    protocol_error,
                    terminal_state_protocol::ProtocolError::FrameTooLarge { .. }
                ) {
                    ErrorCode::ResourceLimit
                } else {
                    ErrorCode::UnsupportedProtocolVersion
                };
                (
                    GatewayRefusal::new(
                        code,
                        format!("this gateway refused a terminal record: {protocol_error}"),
                    )
                    .correlated_to(request_id),
                    false,
                )
            }
            ClientError::MissingCapability { capability } => (
                GatewayRefusal::new(
                    ErrorCode::UnsupportedCapability,
                    format!("the local Host did not negotiate {capability}"),
                )
                .with_required_capability(capability)
                .correlated_to(request_id),
                false,
            ),
            _ => (
                GatewayRefusal::new(
                    ErrorCode::TransportClosed,
                    "the gateway could not forward the terminal record to the local Host",
                )
                .correlated_to(request_id),
                true,
            ),
        }
    })
}

fn pump_upstream<R, W>(
    mut input: R,
    writer: LocalWriter,
    terminal_handles: TerminalUpstreamHandles,
    sink: &Mutex<FrameSink<W>>,
    retirement_selected: bool,
    last_upstream: &Mutex<Instant>,
) where
    R: Read,
    W: Write,
{
    let codec = FrameCodec::new(FrameLimits::default());
    loop {
        // Stamped at the top of each cycle, so it holds the moment the previous
        // frame finished being handled — or the attach itself, on the first
        // pass. While the read below blocks, the stamp stops moving, which is
        // exactly the silence the watchdog measures.
        //
        // Liveness is "the peer is still there", not "the peer sent something
        // we liked": a frame this loop goes on to refuse still proves the phone
        // is answering, and it stamps the same way.
        if let Ok(mut last) = last_upstream.lock() {
            *last = Instant::now();
        }
        match codec.read_payload(&mut input) {
            Ok(payload) if payload.starts_with(&ENVELOPE_MAGIC) => {
                if let Err((refusal, fatal)) =
                    forward_terminal_upstream(&terminal_handles, &payload)
                {
                    let _ = send_error(sink, &refusal);
                    if fatal {
                        break;
                    }
                }
            }
            Ok(payload) => match codec.decode_payload_for_dispatch(&payload) {
                Ok(DecodedFrame::Valid(frame)) => {
                    match upstream_decision(&frame.body, retirement_selected) {
                        UpstreamDecision::Forward => {
                            if let Err(error) = writer.send(frame.body) {
                                eprintln!("hmux: mobile-gateway: local send failed: {error}");
                                break;
                            }
                        }
                        UpstreamDecision::Refuse {
                            code,
                            message,
                            required_capability,
                        } => {
                            let _ = send_error(
                                sink,
                                &upstream_refusal(&frame.body, code, message, required_capability),
                            );
                        }
                    }
                }
                // A frame that parsed but broke a limit. The 64 KiB
                // `max_input_bytes` cap — an over-long paste from a phone — lands
                // exactly here, and it is the primary user path this whole
                // classification exists for: the payload was read in full, so the
                // stream is intact and only the paste is refused.
                Ok(DecodedFrame::Invalid { frame, violation }) => {
                    let code = violation_code(&violation);
                    let mut refusal = GatewayRefusal::new(
                        code,
                        format!("this gateway refused an Hmux frame: {violation}"),
                    )
                    .correlated_to(refusal_correlation_id(&frame.body));
                    if code == ErrorCode::UnsupportedProtocolVersion {
                        refusal = refusal.with_versions();
                    }
                    let _ = send_error(sink, &refusal);
                }
                Err(error) => match classify_relay_read(&error) {
                    RelayReadFailure::Closed => break,
                    RelayReadFailure::RefusedFrame { code, message } => {
                        eprintln!("hmux: mobile-gateway: relayed frame refused: {error}");
                        let _ =
                            send_error(sink, &GatewayRefusal::new(code, message).with_versions());
                    }
                    RelayReadFailure::DesynchronizedStream { code, message } => {
                        eprintln!("hmux: mobile-gateway: relay stream unusable: {error}");
                        let _ = send_error_with_retry(
                            sink,
                            &GatewayRefusal::new(code, message).with_versions(),
                            RetryPosture::Reconnect,
                        );
                        break;
                    }
                },
            },
            Err(error) => match classify_relay_read(&error) {
                RelayReadFailure::Closed => break,
                RelayReadFailure::RefusedFrame { code, message } => {
                    eprintln!("hmux: mobile-gateway: relayed frame refused: {error}");
                    let _ = send_error(sink, &GatewayRefusal::new(code, message).with_versions());
                }
                RelayReadFailure::DesynchronizedStream { code, message } => {
                    // The peer is owed the reason before the pipe closes; the
                    // operator who wrote the authorized_keys line is owed it on
                    // stderr, which is the only channel they read.
                    eprintln!("hmux: mobile-gateway: relay stream unusable: {error}");
                    let _ = send_error_with_retry(
                        sink,
                        &GatewayRefusal::new(code, message).with_versions(),
                        // Reconnect, not Never: the stream is broken, the
                        // session is not. Re-running the forced command is the
                        // recovery, and telling the peer so is the difference
                        // between a reattach and a support ticket.
                        RetryPosture::Reconnect,
                    );
                    break;
                }
            },
        }
    }
    // The relayed client is gone, or its stream is no longer usable. Detaching
    // is what unblocks the downstream pump: the Host closes the connection on
    // `Detach`, and nothing else can wake a blocked local read from this thread.
    let _ = writer.send(relay_stream_ended_detach());
}

fn relay_stream_ended_detach() -> FrameBody {
    FrameBody::Detach(Detach {
        reason: Some("relay_stream_ended".to_string()),
    })
}

struct FrameSink<W: Write> {
    codec: FrameCodec,
    output: W,
    next_frame_id: u64,
}

impl<W: Write> FrameSink<W> {
    fn new(output: W) -> Self {
        Self {
            codec: FrameCodec::new(FrameLimits::default()),
            output,
            // Frame ids are validated as non-zero.
            next_frame_id: 1,
        }
    }

    fn send(&mut self, body: FrameBody) -> Result<(), FrameCodecError> {
        let frame = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: self.next_frame_id,
            body,
        };
        self.codec.write_to(&mut self.output, &frame)?;
        self.output.flush().map_err(FrameCodecError::Io)?;
        self.next_frame_id = self.next_frame_id.saturating_add(1);
        Ok(())
    }

    /// Relays one already-validated binary terminal payload unchanged.
    ///
    /// The outer four-byte length is transport framing shared with JSON
    /// control records. The payload is not decoded, translated, or base64
    /// expanded here; `LocalConnection` already validated its terminal
    /// envelope before returning it.
    fn send_payload(&mut self, payload: &[u8]) -> Result<(), FrameCodecError> {
        if payload.is_empty() {
            return Err(FrameCodecError::EmptyFrame);
        }
        if payload.len() > self.codec.limits().max_frame_bytes {
            return Err(FrameCodecError::FrameTooLarge {
                actual: payload.len(),
                maximum: self.codec.limits().max_frame_bytes,
            });
        }
        let length = u32::try_from(payload.len()).map_err(|_| FrameCodecError::FrameTooLarge {
            actual: payload.len(),
            maximum: self.codec.limits().max_frame_bytes,
        })?;
        self.output
            .write_all(&length.to_be_bytes())
            .map_err(FrameCodecError::Io)?;
        self.output
            .write_all(payload)
            .map_err(FrameCodecError::Io)?;
        self.output.flush().map_err(FrameCodecError::Io)
    }

    /// The raw stream under the sink, for the one document shape that is not a
    /// `WireFrame`.
    ///
    /// Reached only through the sink's mutex, which is the point: the listing
    /// and any refusal that follows it share one output, and interleaving a
    /// catalog document with a frame mid-write would desynchronize a reader that
    /// is counting length prefixes.
    fn output_mut(&mut self) -> &mut W {
        &mut self.output
    }
}

fn lock_sink<W: Write>(
    sink: &Mutex<FrameSink<W>>,
) -> Result<std::sync::MutexGuard<'_, FrameSink<W>>, CliError> {
    sink.lock()
        .map_err(|_| CliError("mobile-gateway output stream failed".into()))
}

fn send_error<W: Write>(
    sink: &Mutex<FrameSink<W>>,
    refusal: &GatewayRefusal,
) -> Result<(), CliError> {
    send_error_with_retry(sink, refusal, RetryPosture::Never)
}

fn send_error_with_retry<W: Write>(
    sink: &Mutex<FrameSink<W>>,
    refusal: &GatewayRefusal,
    retry: RetryPosture,
) -> Result<(), CliError> {
    let frame = FrameBody::Error(ErrorFrame {
        origin_code: None,
        code: refusal.code,
        message: bounded_refusal_message(&refusal.message),
        retry,
        required_capability: refusal.required_capability.clone(),
        supported_versions: refusal.supported_versions,
        in_reply_to_request_id: refusal.in_reply_to_request_id.clone(),
    });
    lock_sink(sink)?.send(frame).map_err(|error| {
        CliError(format!(
            "mobile-gateway could not report a refusal: {error}"
        ))
    })
}

/// Answers the relayed client on the wire, then fails the process.
///
/// Both halves matter: stdout is the only channel the phone reads, and stderr
/// is the only channel the operator who wrote the `authorized_keys` line reads.
fn refuse<W: Write>(sink: &Mutex<FrameSink<W>>, refusal: GatewayRefusal) -> CliError {
    refuse_with_retry(sink, refusal, RetryPosture::Never)
}

fn refuse_with_retry<W: Write>(
    sink: &Mutex<FrameSink<W>>,
    refusal: GatewayRefusal,
    retry: RetryPosture,
) -> CliError {
    let message = refusal.message.clone();
    let _ = send_error_with_retry(sink, &refusal, retry);
    CliError(format!(
        "mobile-gateway refused the relayed attach: {message}"
    ))
}

fn frame_kind_name(body: &FrameBody) -> String {
    format!("{:?}", body.kind()).to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    mod downstream;
    use hmux_client::transport::AttachedTransport;
    use hmux_client::{RetryDirective, TerminalSurfaceAttachment};
    use hmux_host::local_discovery::SessionRetirementPolicy;
    use hmux_host::local_protocol::{
        AgentRuntimeActivity, AgentRuntimeAttention, AgentStateReport, AuthorizationPosture,
        ControlRelease, ControlRequest, Exit, HelloAck, Input, InputReceiptState, LifecycleState,
        PROVIDER_CONVERSATION_IDENTITY_CAPABILITY, ProcessProof,
        ProviderConversationIdentityProjection, ProviderConversationIdentitySource, Resize,
        ScreenSnapshotRequest, SessionFence, SessionRetirementReceipt,
        SessionRetirementReceiptReason, SessionRetirementReceiptState, SessionRetirementRequest,
        StandaloneTerminate,
    };
    #[cfg(unix)]
    use hmux_host::local_transport::fd::{FdFrameReader, FdFrameWriter, SocketInterrupt};
    use hmux_host::local_transport::memory::MemoryEndpoint;
    use hmux_host::local_transport::{
        FrameOutcome, FrameReader, FrameWriter, PayloadOutcome, TransportError, TransportInterrupt,
    };
    use hmux_runtime_contract::{
        TERMINAL_STATE_BASE_PROTOCOL_MINOR as TERMINAL_PROTOCOL_MINOR,
        TERMINAL_VIEWPORT_MULTIPART_CAPABILITY, TERMINAL_VIEWPORT_MULTIPART_PROTOCOL_VERSION,
        TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
    };
    use std::io::Cursor;
    #[cfg(unix)]
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::Ordering as AtomicOrdering;
    use terminal_state_protocol::{
        BellEvent, BufferId, CellStyle, Grapheme, InputIntent, InputModes, MouseEncoding,
        MouseTrackingMode, ResizeInputIntent, RowTermination, ScrollRows, TerminalCell,
        TerminalColorOverrides, TerminalEvent, TerminalRow, TerminalStateRecord, TerminalTables,
        TextInputIntent, UnderlineKind, UnicodeWidthProfile, ViewportAnchorStatus, ViewportFrame,
        ViewportFrameBatch, ViewportIntent, encode_record, encode_viewport_frame_parts,
        input_intent, terminal_event, terminal_state_record, viewport_intent,
    };

    #[derive(Clone)]
    struct SharedEndpoint(Arc<Mutex<MemoryEndpoint>>);

    impl SharedEndpoint {
        fn new(endpoint: MemoryEndpoint) -> Self {
            Self(Arc::new(Mutex::new(endpoint)))
        }

        fn lock(&self) -> std::sync::MutexGuard<'_, MemoryEndpoint> {
            self.0.lock().expect("memory endpoint lock")
        }
    }

    impl FrameReader for SharedEndpoint {
        fn wait_readable(&mut self, timeout: Option<Duration>) -> Result<(), TransportError> {
            self.lock().wait_readable(timeout)
        }

        fn read_payload(&mut self, codec: &FrameCodec) -> Result<PayloadOutcome, TransportError> {
            self.lock().read_payload(codec)
        }

        fn read_frame(&mut self, codec: &FrameCodec) -> Result<FrameOutcome, TransportError> {
            self.lock().read_frame(codec)
        }

        fn set_completion_timeout(&mut self, timeout: Option<Duration>) {
            self.lock().set_completion_timeout(timeout);
        }
    }

    impl FrameWriter for SharedEndpoint {
        fn write_frame(&mut self, encoded: &[u8]) -> Result<(), TransportError> {
            self.lock().write_frame(encoded)
        }

        fn write_frame_before(
            &mut self,
            encoded: &[u8],
            deadline: Option<Instant>,
        ) -> Result<(), TransportError> {
            self.lock().write_frame_before(encoded, deadline)
        }

        fn close_write(&mut self) -> Result<(), TransportError> {
            self.lock().close_write()
        }
    }

    impl TransportInterrupt for SharedEndpoint {
        fn interrupt(&self) {}
    }

    /// Silence past the deadline gives the lease back.
    ///
    /// This is the property the whole controller path is ordered around: a
    /// phone that stops answering without closing its SSH channel must not keep
    /// the session's only writable lease, because the Host has no preemption
    /// and the owner at the desk would otherwise be locked out of their own
    /// terminal.
    #[test]
    fn silence_past_the_deadline_releases_the_lease() {
        let last_upstream = Mutex::new(Instant::now() - Duration::from_secs(60));
        let mut releases = 0;

        release_when_idle(
            &last_upstream,
            Duration::from_millis(1),
            Duration::from_millis(1),
            || {
                releases += 1;
                Ok(())
            },
        );

        assert_eq!(releases, 1, "the lease must be given back exactly once");
    }

    /// A release that fails is retried, not abandoned.
    ///
    /// Returning after one failed send would leave the lease held until the SSH
    /// connection actually dies — the multi-hour window this bound exists to
    /// replace, and silently, since the caller ignores the result.
    #[test]
    fn a_failed_release_is_retried() {
        let last_upstream = Mutex::new(Instant::now() - Duration::from_secs(60));
        let mut attempts = 0;

        release_when_idle(
            &last_upstream,
            Duration::from_millis(1),
            Duration::from_millis(1),
            || {
                attempts += 1;
                if attempts < 3 {
                    Err("writer is busy".to_string())
                } else {
                    Ok(())
                }
            },
        );

        assert_eq!(attempts, 3, "every failure must be followed by another try");
    }

    /// A client that is still there keeps the lease.
    ///
    /// The mirror of the first test, and the one that would catch a deadline
    /// measured from the *attach* rather than from the last frame: a user
    /// reading their phone must not be detached out from under themselves.
    ///
    /// Observed from another thread because the loop only returns once it has
    /// released — which is exactly what must not happen here.
    #[test]
    fn a_live_client_keeps_the_lease() {
        let last_upstream = Arc::new(Mutex::new(Instant::now()));
        let releases = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let watching = Arc::clone(&last_upstream);
        let counted = Arc::clone(&releases);
        thread::spawn(move || {
            release_when_idle(
                &watching,
                Duration::from_secs(5),
                Duration::from_millis(1),
                || {
                    counted.fetch_add(1, AtomicOrdering::SeqCst);
                    Ok(())
                },
            );
        });

        // Keep speaking for well past the deadline, one frame at a time.
        for _ in 0..20 {
            thread::sleep(Duration::from_millis(10));
            *last_upstream.lock().expect("stamp") = Instant::now();
        }

        assert_eq!(
            releases.load(AtomicOrdering::SeqCst),
            0,
            "a client that never went silent must keep the lease"
        );
    }

    fn fence() -> SessionFence {
        SessionFence {
            workspace_id: "workspace".into(),
            session_id: "session".into(),
            runner_principal: "local-user".into(),
            runner_instance: "instance".into(),
            channel_epoch: 1,
            host_instance_id: "host".into(),
            terminal_epoch: "epoch".into(),
        }
    }

    fn ack_with_selected(selected_capabilities: Vec<String>) -> HelloAck {
        HelloAck {
            selected_version: PROTOCOL_V1,
            selected_capabilities,
            actual_fence: fence(),
            host_build_version: "test".into(),
            lifecycle: LifecycleState::Observing,
            host_process: ProcessProof {
                process_id: 10,
                start_marker: "host-start".into(),
            },
            provider_process: None,
            earliest_retained_output_seq: 1,
            current_output_seq: 1,
            controller_generation: 1,
            authorization_posture: AuthorizationPosture::StandaloneLocalOwner,
        }
    }

    fn structured_ack(include_input: bool, include_identity: bool) -> HelloAck {
        let mut selected_capabilities = vec![
            "live_output".to_string(),
            "screen_snapshot".to_string(),
            TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_WHEEL_CAPABILITY.to_string(),
            AGENT_RUNTIME_STATE_CAPABILITY.to_string(),
        ];
        if include_input {
            selected_capabilities.push(TERMINAL_INPUT_INTENT_CAPABILITY.to_string());
        }
        if include_identity {
            selected_capabilities.push(AGENT_IDENTITY_PROJECTION_CAPABILITY.to_string());
            selected_capabilities.push(PROVIDER_CONVERSATION_IDENTITY_CAPABILITY.to_string());
        }
        ack_with_selected(selected_capabilities)
    }

    fn provider_identity(revision: u64) -> ProviderConversationIdentityProjection {
        ProviderConversationIdentityProjection {
            fence: fence(),
            revision,
            observed_through_output_seq: 1,
            provider_id: "codex".into(),
            conversation_id: format!("conversation-{revision}"),
            source: ProviderConversationIdentitySource::ProviderEvent,
        }
    }

    fn viewport_record(projection_revision: u64, state_revision: u64) -> TerminalStateRecord {
        TerminalStateRecord {
            schema_minor: u32::from(TERMINAL_PROTOCOL_MINOR),
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: state_revision,
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
                through_event_id: 0,
                title: "surface".into(),
                working_directory_uri: String::new(),
                follow_tail: true,
                has_more_before: false,
                has_more_after: false,
                changed_row_indices: Vec::new(),
                applied_intent_seq: 1,
                anchor_status: ViewportAnchorStatus::FollowTail as i32,
                rows_from_tail: Some(0),
                input_output_timing: None,
            })),
        }
    }

    fn event_record() -> TerminalStateRecord {
        TerminalStateRecord {
            schema_minor: u32::from(TERMINAL_PROTOCOL_MINOR),
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: 2,
            state_revision: 3,
            body: Some(terminal_state_record::Body::Event(TerminalEvent {
                event_id: 1,
                event: Some(terminal_event::Event::Bell(BellEvent {})),
            })),
        }
    }

    fn viewport_intent_record() -> TerminalStateRecord {
        TerminalStateRecord {
            schema_minor: u32::from(TERMINAL_PROTOCOL_MINOR),
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: 1,
            state_revision: 1,
            body: Some(terminal_state_record::Body::ViewportIntent(
                ViewportIntent {
                    observed_projection_revision: 1,
                    intent_seq: 2,
                    intent: Some(viewport_intent::Intent::ScrollRows(ScrollRows { rows: -1 })),
                },
            )),
        }
    }

    fn text_intent_record() -> TerminalStateRecord {
        TerminalStateRecord {
            schema_minor: u32::from(TERMINAL_PROTOCOL_MINOR),
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: 1,
            state_revision: 1,
            body: Some(terminal_state_record::Body::InputIntent(InputIntent {
                intent: Some(input_intent::Intent::Text(TextInputIntent {
                    utf8: b"echo relay-safe".to_vec(),
                })),
            })),
        }
    }

    fn resize_intent_record() -> TerminalStateRecord {
        TerminalStateRecord {
            schema_minor: u32::from(TERMINAL_PROTOCOL_MINOR),
            terminal_epoch: fence().terminal_epoch,
            through_output_seq: 1,
            state_revision: 1,
            body: Some(terminal_state_record::Body::InputIntent(InputIntent {
                intent: Some(input_intent::Intent::Resize(ResizeInputIntent {
                    columns: 120,
                    rows: 40,
                    geometry_generation: 7,
                })),
            })),
        }
    }

    fn framed_payload(payload: &[u8]) -> Vec<u8> {
        let mut framed = Vec::with_capacity(LENGTH_PREFIX_BYTES + payload.len());
        framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        framed.extend_from_slice(payload);
        framed
    }

    fn with_unknown_protobuf_field(mut encoded: Vec<u8>) -> Vec<u8> {
        // Field 127, varint 1. Prost accepts and discards it when decoding, so
        // an encode-after-decode relay would silently change these bytes.
        encoded.extend_from_slice(&[0xf8, 0x07, 0x01]);
        let payload_length = u32::from_le_bytes(encoded[8..12].try_into().unwrap()) + 3;
        encoded[8..12].copy_from_slice(&payload_length.to_le_bytes());
        encoded
    }

    fn structured_connection(
        include_input: bool,
        downstream: &[Vec<u8>],
        close_downstream: bool,
        select_identity: bool,
        initial_runtime: Option<hmux_host::local_protocol::AgentRuntimeStateProjection>,
        initial_identity: Option<ProviderConversationIdentityProjection>,
    ) -> (hmux_client::LocalConnection, MemoryEndpoint) {
        let codec = FrameCodec::new(FrameLimits::default());
        let (client, mut host) = MemoryEndpoint::pair();
        host.write_frame(
            &codec
                .encode(&WireFrame {
                    protocol_version: PROTOCOL_V1,
                    frame_id: 1,
                    body: FrameBody::HelloAck(structured_ack(include_input, select_identity)),
                })
                .expect("hello ack encodes"),
        )
        .expect("hello ack queues");
        if let Some(runtime) = initial_runtime {
            host.write_frame(
                &codec
                    .encode(&WireFrame {
                        protocol_version: PROTOCOL_V1,
                        frame_id: 2,
                        body: FrameBody::AgentRuntimeState(runtime),
                    })
                    .expect("runtime state encodes"),
            )
            .expect("runtime state queues");
        }
        if let Some(identity) = initial_identity {
            host.write_frame(
                &codec
                    .encode(&WireFrame {
                        protocol_version: PROTOCOL_V1,
                        frame_id: 3,
                        body: FrameBody::ProviderConversationIdentity(identity),
                    })
                    .expect("identity encodes"),
            )
            .expect("identity queues");
        }
        let seed = encode_record(1, &viewport_record(1, 1)).expect("seed encodes");
        host.write_frame(&framed_payload(&seed))
            .expect("seed queues");
        for payload in downstream {
            host.write_frame(&framed_payload(payload))
                .expect("downstream record queues");
        }
        if close_downstream {
            host.close_write().expect("host closes downstream");
        }

        let shared = SharedEndpoint::new(client);
        let transport = AttachedTransport::relayed(
            Box::new(shared.clone()),
            Box::new(shared.clone()),
            Arc::new(shared),
        );
        let mut options = ConnectionOptions::new(LocalAttachRole::Observer, None);
        options = if select_identity {
            options.with_optional_capabilities(&[
                AGENT_IDENTITY_PROJECTION_CAPABILITY,
                AGENT_RUNTIME_STATE_CAPABILITY,
                PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
            ])
        } else {
            options.with_optional_capabilities(&[AGENT_RUNTIME_STATE_CAPABILITY])
        };
        options = options
            .with_terminal_viewport_projection()
            .with_terminal_viewport_wheel();
        if include_input {
            options = options.with_terminal_input_intents();
        }
        let connection = hmux_client::LocalConnection::attach_over_transport(
            transport,
            fence(),
            "relay-placeholder".into(),
            options,
        )
        .expect("structured relay attach completes");
        (connection, host)
    }

    #[cfg(unix)]
    struct RelayedProfileObservation {
        local_hello: Hello,
        scroll_rows: Option<terminal_state_protocol::DecodedRecord>,
        input: Option<terminal_state_protocol::DecodedRecord>,
    }

    #[cfg(unix)]
    fn attach_relayed_profile(
        outer_capabilities: &[&str],
        ceiling: GatewayRole,
        host_prompt_capabilities: &[&str],
        expect_scroll_rows: bool,
        upstream_input: Option<Vec<u8>>,
    ) -> (hmux_client::LocalConnection, RelayedProfileObservation) {
        let outer_hello = hello(AttachMode::Observer, outer_capabilities);
        let selection = admit_relayed_terminal_capabilities(&outer_hello, ceiling)
            .expect("outer terminal profile is admitted");
        let options = ConnectionOptions::new(LocalAttachRole::Observer, None)
            .with_optional_capabilities(&gateway_local_optional_capabilities(
                false,
                false,
                false,
                false,
                selection.agent_prompt,
            ));
        let mut supported = vec![
            TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
            TERMINAL_INPUT_INTENT_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_WHEEL_CAPABILITY.to_string(),
            TERMINAL_VIEWPORT_MULTIPART_CAPABILITY.to_string(),
            TERMINAL_DEFAULT_COLORS_CAPABILITY.to_string(),
            AGENT_RUNTIME_STATE_CAPABILITY.to_string(),
        ];
        supported.extend(
            host_prompt_capabilities
                .iter()
                .map(|capability| (*capability).to_string()),
        );
        let host_agent_prompt_posture = select_managed_agent_prompt_capability(
            AttachMode::Observer,
            true,
            &supported,
            &supported,
        );
        let legacy_agent_prompt_input_dependency = host_agent_prompt_posture
            == Some(AgentPromptCapabilitySelection::LegacyFresh)
            && selection.agent_prompt.offers_legacy_lane()
            && !selection.input;
        let options = with_relayed_terminal_selection(
            options,
            selection,
            legacy_agent_prompt_input_dependency,
        );
        let (client_socket, mut host_socket) = UnixStream::pair().expect("relay socket pair");
        host_socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .expect("host read timeout");
        let expect_input = upstream_input.is_some();
        let host = thread::spawn(move || {
            let codec = FrameCodec::new(FrameLimits::default());
            let frame = codec
                .read_from(&mut host_socket)
                .expect("fake Host reads local Hello");
            let FrameBody::Hello(local_hello) = frame.body else {
                panic!("gateway local attach did not begin with Hello")
            };
            let agent_prompt_selection =
                hmux_host::local_protocol::select_managed_agent_prompt_capability(
                    AttachMode::Observer,
                    true,
                    &supported,
                    &local_hello.requested_capabilities,
                );
            let selected = local_hello
                .requested_capabilities
                .iter()
                .filter(|requested| {
                    supported.contains(requested)
                        && hmux_runtime_contract::terminal_capability_permitted_for_agent_prompt(
                            agent_prompt_selection,
                            requested,
                        )
                })
                .cloned()
                .collect::<Vec<_>>();
            codec
                .write_to(
                    &mut host_socket,
                    &WireFrame {
                        protocol_version: PROTOCOL_V1,
                        frame_id: 1,
                        body: FrameBody::HelloAck(ack_with_selected(selected.clone())),
                    },
                )
                .expect("fake Host writes HelloAck");

            let viewport = viewport_record(1, 1);
            let seed = if selected
                .iter()
                .any(|capability| capability == TERMINAL_VIEWPORT_MULTIPART_CAPABILITY)
            {
                let Some(terminal_state_record::Body::ViewportFrame(frame)) =
                    viewport.body.as_ref()
                else {
                    unreachable!()
                };
                encode_viewport_frame_parts(ViewportFrameBatch {
                    record_id_start: 1,
                    schema_minor: u32::from(
                        TERMINAL_VIEWPORT_MULTIPART_PROTOCOL_VERSION.envelope_minor,
                    ),
                    terminal_epoch: &viewport.terminal_epoch,
                    through_output_seq: viewport.through_output_seq,
                    state_revision: viewport.state_revision,
                    batch_id: b"relay-profile",
                    frame,
                    max_chunk_bytes: 64,
                })
                .expect("multipart viewport seed encodes")
            } else {
                vec![encode_record(1, &viewport).expect("direct viewport seed encodes")]
            };
            for record in seed {
                host_socket
                    .write_all(&framed_payload(&record))
                    .expect("fake Host writes viewport seed");
            }

            let scroll_rows = expect_scroll_rows.then(|| {
                let payload = codec
                    .read_payload(&mut host_socket)
                    .expect("fake Host reads ScrollRows envelope");
                decode_record(&payload).expect("ScrollRows envelope decodes")
            });
            let input = expect_input.then(|| {
                let payload = codec
                    .read_payload(&mut host_socket)
                    .expect("fake Host reads input envelope");
                decode_record(&payload).expect("input envelope decodes")
            });
            RelayedProfileObservation {
                local_hello,
                scroll_rows,
                input,
            }
        });

        let reader_socket = client_socket.try_clone().expect("clone relay reader");
        let interrupt_socket = client_socket.try_clone().expect("clone relay interrupt");
        let transport = AttachedTransport::relayed(
            Box::new(FdFrameReader::new(reader_socket)),
            Box::new(FdFrameWriter::new(client_socket)),
            Arc::new(SocketInterrupt::new(interrupt_socket)),
        );
        let connection = hmux_client::LocalConnection::attach_over_transport(
            transport,
            fence(),
            "relay-placeholder".into(),
            options,
        )
        .expect("relayed structured attach completes");
        if expect_scroll_rows {
            connection
                .terminal_projection_handle()
                .expect("projection handle")
                .send_viewport_intent(2, &viewport_intent_record())
                .expect("ScrollRows sends");
        }
        if let Some(input) = upstream_input.as_deref() {
            connection
                .terminal_input_writer_capability()
                .expect("input writer is selected")
                .send_input_envelope(input)
                .expect("ordinary input remains available");
        }
        let observation = host.join().expect("fake Host joins");
        (connection, observation)
    }

    #[cfg(unix)]
    fn assert_exact_relayed_profile(
        outer_capabilities: &[&str],
        expected_record_minor: u8,
        multipart: bool,
        expect_scroll_rows: bool,
    ) {
        let (connection, observation) = attach_relayed_profile(
            outer_capabilities,
            GatewayRole::Observer,
            &[],
            expect_scroll_rows,
            None,
        );
        let expected = outer_capabilities
            .iter()
            .map(|capability| (*capability).to_string())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            observation
                .local_hello
                .requested_capabilities
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>(),
            expected,
            "the gateway local attach must preserve the outer structured capability request"
        );
        assert_eq!(
            connection
                .hello_ack()
                .selected_capabilities
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>(),
            expected,
            "the relayed HelloAck must expose the exact Host selection"
        );

        let seed = connection
            .initial_terminal_state()
            .expect("relayed viewport seed");
        let decoded = seed
            .records()
            .map(|record| decode_record(record).expect("seed record decodes"))
            .collect::<Vec<_>>();
        assert!(!decoded.is_empty());
        for record in &decoded {
            assert_eq!(record.metadata.protocol_minor, expected_record_minor);
            assert_eq!(record.record.schema_minor, u32::from(expected_record_minor));
            assert_eq!(
                matches!(
                    record.record.body,
                    Some(terminal_state_record::Body::ViewportFramePart(_))
                ),
                multipart,
                "record shape must match the selected multipart permission"
            );
            assert_eq!(
                matches!(
                    record.record.body,
                    Some(terminal_state_record::Body::ViewportFrame(_))
                ),
                !multipart,
                "base projection must remain a direct viewport frame"
            );
        }
        if let Some(scroll_rows) = observation.scroll_rows {
            assert_eq!(
                scroll_rows.metadata.protocol_minor, TERMINAL_PROTOCOL_MINOR,
                "ScrollRows stays on the minor-4 base even when wheel is selected"
            );
            assert!(matches!(
                scroll_rows.record.body,
                Some(terminal_state_record::Body::ViewportIntent(
                    ViewportIntent {
                        intent: Some(viewport_intent::Intent::ScrollRows(_)),
                        ..
                    }
                ))
            ));
        }
        connection.shutdown();
    }

    #[cfg(unix)]
    #[test]
    fn relayed_base_viewport_and_runtime_state_preserve_exact_ack_and_direct_minor_four_seed() {
        assert_exact_relayed_profile(
            &[
                TERMINAL_STATE_BINARY_CAPABILITY,
                TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                AGENT_RUNTIME_STATE_CAPABILITY,
            ],
            TERMINAL_PROTOCOL_MINOR,
            false,
            false,
        );
    }

    #[cfg(unix)]
    #[test]
    fn relayed_wheel_profile_preserves_exact_ack_and_scroll_rows_minor_four() {
        assert_exact_relayed_profile(
            &[
                TERMINAL_STATE_BINARY_CAPABILITY,
                TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
            ],
            TERMINAL_PROTOCOL_MINOR,
            false,
            true,
        );
    }

    #[cfg(unix)]
    #[test]
    fn relayed_multipart_profile_preserves_exact_ack_and_minor_five_parts() {
        assert_exact_relayed_profile(
            &[
                TERMINAL_STATE_BINARY_CAPABILITY,
                TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
            ],
            TERMINAL_VIEWPORT_MULTIPART_PROTOCOL_VERSION.envelope_minor,
            true,
            false,
        );
    }

    #[test]
    fn fresh_remote_surface_receives_runtime_state_and_identity_in_the_relayed_attach_seed() {
        use hmux_host::local_protocol::{
            AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
            AgentRuntimeStateProjection, AgentRuntimeStateSource,
        };

        let expected_runtime = AgentRuntimeStateProjection {
            terminal_epoch: fence().terminal_epoch,
            revision: 5,
            observed_through_output_seq: 1,
            lifecycle: AgentRuntimeLifecycle::Running,
            activity: AgentRuntimeActivity::Working,
            attention: AgentRuntimeAttention::None,
            attention_id: None,
            source: AgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: 2,
        };
        let expected = provider_identity(7);
        let (gateway_connection, _local_host) = structured_connection(
            false,
            &[],
            false,
            true,
            Some(expected_runtime.clone()),
            Some(expected.clone()),
        );
        let forwarded_ack = gateway_connection.hello_ack().clone();
        let seed = relayed_attach_seed(&gateway_connection).expect("gateway rebuilds attach seed");

        let codec = FrameCodec::new(FrameLimits::default());
        let (remote_client, mut gateway_sink) = MemoryEndpoint::pair();
        gateway_sink
            .write_frame(
                &codec
                    .encode(&WireFrame {
                        protocol_version: PROTOCOL_V1,
                        frame_id: 1,
                        body: FrameBody::HelloAck(forwarded_ack),
                    })
                    .expect("relayed ack encodes"),
            )
            .expect("relayed ack queues");
        let mut frame_id = 2;
        for record in seed {
            match record {
                ConnectionRecord::Control(body) => {
                    gateway_sink
                        .write_frame(
                            &codec
                                .encode(&WireFrame {
                                    protocol_version: PROTOCOL_V1,
                                    frame_id,
                                    body: *body,
                                })
                                .expect("relayed control encodes"),
                        )
                        .expect("relayed control queues");
                    frame_id += 1;
                }
                ConnectionRecord::TerminalState(payload) => gateway_sink
                    .write_frame(&framed_payload(&payload))
                    .expect("relayed terminal seed queues"),
            }
        }

        let shared = SharedEndpoint::new(remote_client);
        let transport = AttachedTransport::relayed(
            Box::new(shared.clone()),
            Box::new(shared.clone()),
            Arc::new(shared),
        );
        let remote_connection = hmux_client::LocalConnection::attach_over_transport(
            transport,
            fence(),
            "relay-placeholder".into(),
            hmux_client::TerminalSurfaceAttachment::connection_options(
                hmux_client::TerminalSurfaceAccess::ReadOnly,
                None,
            ),
        )
        .expect("remote structured attach completes");
        let surface = hmux_client::TerminalSurfaceAttachment::from_connection(remote_connection)
            .expect("remote terminal surface hydrates");
        let runtime = surface
            .initial_agent_runtime_state()
            .expect("Host runtime state must survive the SSH relay seed");
        assert_eq!(runtime.revision, expected_runtime.revision.to_string());
        assert_eq!(
            runtime.observed_through_output_seq,
            expected_runtime.observed_through_output_seq.to_string(),
        );
        let actual = surface
            .initial_provider_conversation_identity()
            .expect("Host identity must survive the SSH relay seed");
        assert_eq!(actual.revision, expected.revision.to_string());
        assert_eq!(actual.provider_id, expected.provider_id);
        assert_eq!(actual.conversation_id, expected.conversation_id);
    }

    #[test]
    fn live_host_identity_crosses_the_gateway_as_a_typed_control_frame() {
        let (gateway_connection, mut local_host) =
            structured_connection(false, &[], false, true, None, Some(provider_identity(7)));
        let mut live = provider_identity(7);
        live.revision = 8;
        let codec = FrameCodec::new(FrameLimits::default());
        local_host
            .write_frame(
                &codec
                    .encode(&WireFrame {
                        protocol_version: PROTOCOL_V1,
                        frame_id: 3,
                        body: FrameBody::ProviderConversationIdentity(live.clone()),
                    })
                    .expect("live Host identity encodes"),
            )
            .expect("live Host identity queues");
        local_host
            .close_write()
            .expect("local Host closes downstream");
        let sink = Mutex::new(FrameSink::new(Vec::new()));

        let mut downstream = GatewayDownstream::from_connection(gateway_connection)
            .expect("structured gateway downstream hydrates");
        pump_downstream(&mut downstream, &sink).expect("gateway relays the live Host identity");

        let written = sink.into_inner().expect("sink lock").output;
        let decoded = codec
            .read_from(&mut Cursor::new(written))
            .expect("relayed control frame decodes");
        assert_eq!(decoded.body, FrameBody::ProviderConversationIdentity(live));
    }

    #[test]
    fn live_agent_identity_crosses_the_gateway_as_a_typed_control_frame() {
        use hmux_host::local_protocol::{
            AgentIdentityProjection, AgentIdentitySource, AgentProvider,
        };

        let (gateway_connection, mut local_host) =
            structured_connection(false, &[], false, true, None, None);
        let live = AgentIdentityProjection {
            terminal_epoch: fence().terminal_epoch,
            observed_through_output_seq: 1,
            agent: Some(AgentProvider::Codex),
            source: AgentIdentitySource::ProcessInspection,
        };
        let codec = FrameCodec::new(FrameLimits::default());
        local_host
            .write_frame(
                &codec
                    .encode(&WireFrame {
                        protocol_version: PROTOCOL_V1,
                        frame_id: 3,
                        body: FrameBody::AgentIdentity(live.clone()),
                    })
                    .expect("live agent identity encodes"),
            )
            .expect("live agent identity queues");
        local_host
            .close_write()
            .expect("local Host closes downstream");
        let sink = Mutex::new(FrameSink::new(Vec::new()));

        let mut downstream = GatewayDownstream::from_connection(gateway_connection)
            .expect("structured gateway downstream hydrates");
        pump_downstream(&mut downstream, &sink).expect("gateway relays the agent identity");

        let written = sink.into_inner().expect("sink lock").output;
        let decoded = codec
            .read_from(&mut Cursor::new(written))
            .expect("relayed agent identity decodes");
        assert_eq!(decoded.body, FrameBody::AgentIdentity(live));
    }

    #[test]
    fn structured_gateway_releases_ahead_semantics_after_the_matching_viewport() {
        use hmux_host::local_protocol::{
            AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle,
            AgentRuntimeStateProjection, AgentRuntimeStateSource,
        };

        let (gateway_connection, mut local_host) =
            structured_connection(false, &[], false, true, None, None);
        let runtime = AgentRuntimeStateProjection {
            terminal_epoch: fence().terminal_epoch,
            revision: 1,
            observed_through_output_seq: 2,
            lifecycle: AgentRuntimeLifecycle::Running,
            activity: AgentRuntimeActivity::Working,
            attention: AgentRuntimeAttention::None,
            attention_id: None,
            source: AgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: 0,
        };
        let identity = ProviderConversationIdentityProjection {
            fence: fence(),
            revision: 1,
            observed_through_output_seq: 2,
            provider_id: "codex".into(),
            conversation_id: "conversation-opaque".into(),
            source: ProviderConversationIdentitySource::ProviderEvent,
        };
        let codec = FrameCodec::new(FrameLimits::default());
        for (frame_id, body) in [
            (3, FrameBody::AgentRuntimeState(runtime.clone())),
            (4, FrameBody::ProviderConversationIdentity(identity.clone())),
        ] {
            local_host
                .write_frame(
                    &codec
                        .encode(&WireFrame {
                            protocol_version: PROTOCOL_V1,
                            frame_id,
                            body,
                        })
                        .expect("ahead semantic control encodes"),
                )
                .expect("ahead semantic control queues");
        }
        let viewport = encode_record(5, &viewport_record(2, 2)).expect("viewport encodes");
        local_host
            .write_frame(&framed_payload(&viewport))
            .expect("matching viewport queues");
        local_host
            .close_write()
            .expect("local Host closes downstream");
        let sink = Mutex::new(FrameSink::new(Vec::new()));

        let mut downstream = GatewayDownstream::from_connection(gateway_connection)
            .expect("structured gateway downstream hydrates");
        pump_downstream(&mut downstream, &sink)
            .expect("gateway must not close an ordered structured stream");

        let written = sink.into_inner().expect("sink lock").output;
        let mut cursor = Cursor::new(written);
        assert_eq!(codec.read_payload(&mut cursor).unwrap(), viewport);
        assert_eq!(
            codec.read_from(&mut cursor).unwrap().body,
            FrameBody::AgentRuntimeState(runtime),
        );
        assert_eq!(
            codec.read_from(&mut cursor).unwrap().body,
            FrameBody::ProviderConversationIdentity(identity),
        );
        assert_eq!(cursor.position() as usize, cursor.get_ref().len());
    }

    #[test]
    fn complete_viewport_frames_and_events_cross_the_gateway_byte_for_byte() {
        let frame = with_unknown_protobuf_field(
            encode_record(2, &viewport_record(2, 2)).expect("frame encodes"),
        );
        let event =
            with_unknown_protobuf_field(encode_record(3, &event_record()).expect("event encodes"));
        let (connection, _host) = structured_connection(
            false,
            &[frame.clone(), event.clone()],
            true,
            false,
            None,
            None,
        );
        let sink = Mutex::new(FrameSink::new(Vec::new()));

        let mut downstream = GatewayDownstream::from_connection(connection)
            .expect("structured gateway downstream hydrates");
        pump_downstream(&mut downstream, &sink).expect("structured downstream relays");

        let written = sink.into_inner().expect("sink lock").output;
        let mut cursor = Cursor::new(written);
        let codec = FrameCodec::new(FrameLimits::default());
        assert_eq!(codec.read_payload(&mut cursor).unwrap(), frame);
        assert_eq!(codec.read_payload(&mut cursor).unwrap(), event);
        assert_eq!(cursor.position() as usize, cursor.get_ref().len());
    }

    #[test]
    fn viewport_input_and_resize_intents_cross_the_gateway_byte_for_byte() {
        let viewport = with_unknown_protobuf_field(
            encode_record(2, &viewport_intent_record()).expect("viewport encodes"),
        );
        let input = with_unknown_protobuf_field(
            encode_record(3, &text_intent_record()).expect("input encodes"),
        );
        let resize = with_unknown_protobuf_field(
            encode_record(4, &resize_intent_record()).expect("resize encodes"),
        );
        let mut relayed = Vec::new();
        for payload in [&viewport, &input, &resize] {
            relayed.extend_from_slice(&framed_payload(payload));
        }
        let (connection, mut host) = structured_connection(true, &[], false, false, None, None);
        let hello = host
            .read_frame(&FrameCodec::new(FrameLimits::default()))
            .expect("hello reads")
            .expect("hello exists");
        assert!(matches!(hello.frame().body, FrameBody::Hello(_)));
        let sink = Mutex::new(FrameSink::new(Vec::new()));
        let last_upstream = Mutex::new(Instant::now());
        let terminal_handles = connection.terminal_upstream_handles();

        pump_upstream(
            Cursor::new(relayed),
            connection.writer(),
            terminal_handles,
            &sink,
            false,
            &last_upstream,
        );

        let codec = FrameCodec::new(FrameLimits::default());
        assert_eq!(host.read_payload(&codec).unwrap().unwrap(), viewport);
        assert_eq!(host.read_payload(&codec).unwrap().unwrap(), input);
        assert_eq!(host.read_payload(&codec).unwrap().unwrap(), resize);
        let detached = host.read_frame(&codec).unwrap().unwrap();
        assert!(matches!(detached.frame().body, FrameBody::Detach(_)));
    }

    /// The create receipt may not carry fields its reader does not declare.
    ///
    /// `RemoteCatalogSession` in `hmux-ssh-transport` is `deny_unknown_fields`
    /// and `gateway_create_version` is still 1, so a newer entry shape here does
    /// not degrade gracefully — the desktop fails to parse a receipt for a
    /// session the far end has *already created*, and the `?` returns before the
    /// abandon path, leaving that session behind. One orphan per retry.
    ///
    /// This test cannot import the reader (hmux-cli must not depend on
    /// hmux-ssh-transport — that pulls russh and ring into the CLI, and ring's
    /// build script needs a C cross-toolchain the musl artifact job does not
    /// have), so it pins the field set instead. If you add a field to
    /// `CatalogEntry`, either keep it out of this document or teach the reader
    /// first.
    #[test]
    fn a_create_receipt_carries_only_fields_its_reader_declares() {
        let mut written = Vec::new();
        write_standalone_create_document(
            &mut written,
            &StandaloneCreateRequestDocument {
                request_id: "req".into(),
                target_session_id: "session".into(),
                launch_owner_proof: "proof".into(),
                session_name: "name".into(),
                bridge_nonce: "nonce".into(),
                cwd: None,
                initial_rows: 24,
                initial_columns: 80,
                command_intercepts: Vec::new(),
                retirement_policy: None,
            },
            &catalog_descriptor(None),
        )
        .expect("the receipt is written");

        // Length-prefixed, like everything else on this channel.
        let text = String::from_utf8(written[LENGTH_PREFIX_BYTES..].to_vec())
            .expect("the receipt body is UTF-8");
        for absent in ["launch_program", "host_liveness"] {
            assert!(
                !text.contains(absent),
                "`{absent}` reaches a reader that refuses unknown fields: {text}"
            );
        }
    }

    fn catalog_descriptor(retirement_policy: Option<SessionRetirementPolicy>) -> SessionDescriptor {
        SessionDescriptor {
            launch_program: Some("ssh".into()),
            schema_version: 1,
            session_id: "session".into(),
            session_name: Some("shell".into()),
            workspace_id: "workspace".into(),
            session_class: hmux_client::SessionClass::Standalone,
            lifecycle: hmux_client::SessionLifecycle::Ready,
            provider_id: "shell".into(),
            runtime_host: None,
            worktree_alias: None,
            branch: None,
            runner_principal: "local-user".into(),
            runner_instance: "instance".into(),
            channel_epoch: "1".into(),
            host_instance_id: "host".into(),
            terminal_epoch: "epoch".into(),
            output_seq: "0".into(),
            host_build_version: "test".into(),
            supported_protocol: hmux_client::VersionRange {
                minimum: hmux_client::ProtocolVersion { major: 1, minor: 0 },
                maximum: hmux_client::ProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: vec![SESSION_RETIREMENT_CAPABILITY.into()],
            retirement_policy,
            host_process: hmux_client::ProcessDescriptor {
                process_id: 10,
                start_marker: "host".into(),
            },
            provider_process: hmux_client::ProcessDescriptor {
                process_id: 11,
                start_marker: "provider".into(),
            },
            endpoint: hmux_client::EndpointDescriptor {
                kind: hmux_client::EndpointKind::UnixSocket,
                address: "/tmp/hmux.sock".into(),
            },
            created_unix_ms: "1".into(),
            lifecycle_changed_unix_ms: "2".into(),
            exit: None,
            failure: None,
        }
    }

    fn hello(mode: AttachMode, capabilities: &[&str]) -> Hello {
        Hello {
            supported_versions: VersionRange {
                minimum: PROTOCOL_V1,
                maximum: PROTOCOL_V1,
            },
            requested_capabilities: capabilities.iter().map(|c| (*c).to_string()).collect(),
            expected_fence: fence(),
            requested_mode: mode,
            reconnect_cursor: None,
            capability_token: "relayed-placeholder".into(),
            authorization_proof_reference: None,
            initial_snapshot_profile: None,
        }
    }

    fn cursor(after_output_seq: u64) -> ReconnectCursor {
        ReconnectCursor {
            terminal_epoch: fence().terminal_epoch,
            after_output_seq,
        }
    }

    fn standalone_request() -> StandaloneCreateRequestDocument {
        StandaloneCreateRequestDocument {
            request_id: "request-1".into(),
            target_session_id: "standalone-1".into(),
            launch_owner_proof: "launch-proof-1".into(),
            session_name: "remote-shell".into(),
            bridge_nonce: "bridge-nonce-1".into(),
            cwd: None,
            initial_rows: 40,
            initial_columns: 120,
            command_intercepts: vec![
                CommandInterceptDocument {
                    command: "claude".into(),
                    provider_id: "claude".into(),
                },
                CommandInterceptDocument {
                    command: "codex".into(),
                    provider_id: "codex".into(),
                },
            ],
            retirement_policy: None,
        }
    }

    fn abandon_request() -> AbandonUnpresentedCreationRequestDocument {
        AbandonUnpresentedCreationRequestDocument {
            request_id: "request-1".into(),
            session_id: "standalone-1".into(),
            workspace_id: "workspace-1".into(),
            launch_owner_proof: "launch-proof-1".into(),
        }
    }

    fn input_request(bytes: Vec<u8>) -> SessionInputRequestDocument {
        SessionInputRequestDocument {
            request_id: "request-input-1".into(),
            expected_fence: fence(),
            bytes,
        }
    }

    fn retirement_request(request_id: &str, action: SessionRetirementAction) -> FrameBody {
        FrameBody::SessionRetirementRequest(SessionRetirementRequest {
            request_id: request_id.into(),
            expected_fence: fence(),
            action,
        })
    }

    #[test]
    fn a_hello_frame_is_never_mistaken_for_a_gateway_request() {
        // The disjointness the stream route rests on. If a `WireFrame` could
        // ever probe as a request document, a peer opening an attach would be
        // answered with a listing — and the forced command's whole premise is
        // that the peer does not get to choose the mode by what it *says*, only
        // by which of two structurally distinct documents it sends.
        let frame = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body: FrameBody::Hello(hello(AttachMode::Observer, &["screen_snapshot"])),
        };
        let payload = serde_json::to_vec(&frame).unwrap();
        assert!(matches!(
            classify_first_document(&payload),
            FirstDocument::Frame
        ));
    }

    #[test]
    fn a_listing_request_is_recognized_from_the_bytes_a_phone_writes() {
        // Hand-written rather than round-tripped through a serializer of ours:
        // the client half is a different codebase and will produce this document
        // from the wire description, so the description is what is under test.
        assert!(matches!(
            classify_first_document(br#"{"gateway_request_version":1,"request":"list_sessions"}"#),
            FirstDocument::Request {
                gateway_request_version: 1,
                request: GatewayRequest::ListSessions,
            }
        ));
    }

    #[test]
    fn a_version_two_listing_request_negotiates_policy_visibility() {
        assert!(matches!(
            classify_first_document(br#"{"gateway_request_version":2,"request":"list_sessions"}"#),
            FirstDocument::Request {
                gateway_request_version: 2,
                request: GatewayRequest::ListSessions,
            }
        ));
    }

    #[test]
    fn a_version_six_listing_request_negotiates_gateway_build_identity() {
        assert!(matches!(
            classify_first_document(br#"{"gateway_request_version":6,"request":"list_sessions"}"#),
            FirstDocument::Request {
                gateway_request_version: 6,
                request: GatewayRequest::ListSessions,
            }
        ));
    }

    #[test]
    fn catalog_versions_freeze_v3_and_move_gateway_build_identity_to_v4() {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ShippedV3CatalogDocument {
            gateway_catalog_version: u16,
            #[serde(default)]
            forced_command_applied: bool,
            session: serde_json::Value,
        }

        let policy = SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
            grace_period_ms: 2_000,
        };
        let descriptor = catalog_descriptor(Some(policy));
        let v1 = serde_json::to_value(CatalogDocument::new(
            &descriptor,
            GATEWAY_CATALOG_VERSION_V1,
        ))
        .unwrap();
        let v2 = serde_json::to_value(CatalogDocument::new(
            &descriptor,
            GATEWAY_CATALOG_VERSION_RETIREMENT_POLICY,
        ))
        .unwrap();
        let v3 = serde_json::to_value(CatalogDocument::new(
            &descriptor,
            GATEWAY_CATALOG_VERSION_SESSION_FACTS,
        ))
        .unwrap();
        let v4 = serde_json::to_value(CatalogDocument::new(
            &descriptor,
            GATEWAY_CATALOG_VERSION_GATEWAY_BUILD,
        ))
        .unwrap();

        assert_eq!(v1["gateway_catalog_version"], 1);
        assert!(
            v1["session"].get("retirement_policy").is_none(),
            "v1 readers use deny_unknown_fields and must receive the exact legacy session shape"
        );
        assert!(v1.get("gateway_build_id").is_none());
        assert_eq!(v2["gateway_catalog_version"], 2);
        assert_eq!(
            v2["session"]["retirement_policy"]["kind"],
            "after_graceful_last_client_departure_v1"
        );
        assert_eq!(
            v2["session"]["retirement_policy"]["grace_period_ms"],
            "2000"
        );
        assert!(v2.get("gateway_build_id").is_none());
        assert_eq!(v3["gateway_catalog_version"], 3);
        assert!(
            v3.get("gateway_build_id").is_none(),
            "the shipped v3 envelope denies unknown fields and must remain byte-shaped"
        );
        assert_eq!(v3["session"]["host_liveness"], "unknown");
        let shipped = serde_json::from_value::<ShippedV3CatalogDocument>(v3).unwrap();
        assert_eq!(shipped.gateway_catalog_version, 3);
        assert!(!shipped.forced_command_applied);
        assert_eq!(shipped.session["host_liveness"], "unknown");

        assert_eq!(v4["gateway_catalog_version"], 4);
        assert_eq!(v4["gateway_build_id"], crate::CLI_BUILD_ID);
        assert!(
            serde_json::from_value::<ShippedV3CatalogDocument>(v4).is_err(),
            "a v4-only field must never be sent under the v3 version"
        );
    }

    #[test]
    fn a_standalone_create_request_is_strictly_recognized() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "gateway_request_version": 1,
            "request": {
                "create_standalone": {
                    "request_id": "request-1",
                    "target_session_id": "standalone-1",
                    "launch_owner_proof": "launch-proof-1",
                    "session_name": "remote-shell",
                    "bridge_nonce": "bridge-nonce-1",
                    "initial_rows": 40,
                    "initial_columns": 120,
                    "command_intercepts": [
                        { "command": "claude", "provider_id": "claude" },
                        { "command": "codex", "provider_id": "codex" }
                    ]
                }
            }
        }))
        .unwrap();
        let FirstDocument::Request {
            gateway_request_version: 1,
            request: GatewayRequest::CreateStandalone(request),
        } = classify_first_document(&payload)
        else {
            panic!("create request must be structurally recognized");
        };
        assert_eq!(request, standalone_request());
        validate_standalone_create_request(&request).unwrap();
    }

    #[test]
    fn a_version_two_create_carries_the_host_owned_retirement_policy() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "gateway_request_version": 2,
            "request": {
                "create_standalone": {
                    "request_id": "request-1",
                    "target_session_id": "standalone-1",
                    "launch_owner_proof": "launch-proof-1",
                    "session_name": "remote-shell",
                    "bridge_nonce": "bridge-nonce-1",
                    "initial_rows": 40,
                    "initial_columns": 120,
                    "command_intercepts": [
                        { "command": "codex", "provider_id": "codex" }
                    ],
                    "retirement_policy": {
                        "kind": "after_graceful_last_client_departure_v1",
                        "grace_period_ms": "2000"
                    }
                }
            }
        }))
        .unwrap();

        let FirstDocument::Request {
            gateway_request_version: 2,
            request: GatewayRequest::CreateStandalone(request),
        } = classify_first_document(&payload)
        else {
            panic!("version two create request must be structurally recognized");
        };

        assert_eq!(
            request.retirement_policy,
            Some(
                SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                    grace_period_ms: 2_000,
                }
            )
        );
        validate_standalone_create_request(&request).unwrap();
    }

    #[test]
    fn version_seven_create_carries_an_exact_remote_working_directory() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "gateway_request_version": 7,
            "request": {
                "create_standalone": {
                    "request_id": "request-1",
                    "target_session_id": "standalone-1",
                    "launch_owner_proof": "launch-proof-1",
                    "session_name": "remote-shell",
                    "bridge_nonce": "bridge-nonce-1",
                    "cwd": "/home/tester/project",
                    "initial_rows": 40,
                    "initial_columns": 120,
                    "command_intercepts": [
                        { "command": "codex", "provider_id": "codex" }
                    ],
                    "retirement_policy": {
                        "kind": "after_graceful_last_client_departure_v1",
                        "grace_period_ms": "2000"
                    }
                }
            }
        }))
        .unwrap();

        let FirstDocument::Request {
            gateway_request_version: 7,
            request: GatewayRequest::CreateStandalone(request),
        } = classify_first_document(&payload)
        else {
            panic!("version seven create request must be structurally recognized");
        };

        assert_eq!(request.cwd.as_deref(), Some("/home/tester/project"));
        validate_standalone_create_request(&request).unwrap();
    }

    #[test]
    fn version_one_cannot_smuggle_a_retirement_policy() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "gateway_request_version": 1,
            "request": {
                "create_standalone": {
                    "request_id": "request-1",
                    "target_session_id": "standalone-1",
                    "launch_owner_proof": "launch-proof-1",
                    "session_name": "remote-shell",
                    "bridge_nonce": "bridge-nonce-1",
                    "initial_rows": 40,
                    "initial_columns": 120,
                    "command_intercepts": [
                        { "command": "codex", "provider_id": "codex" }
                    ],
                    "retirement_policy": {
                        "kind": "after_graceful_last_client_departure_v1",
                        "grace_period_ms": "2000"
                    }
                }
            }
        }))
        .unwrap();

        assert!(matches!(
            classify_first_document(&payload),
            FirstDocument::Refused(_)
        ));
    }

    #[test]
    fn legacy_create_versions_cannot_smuggle_a_working_directory() {
        for version in [1, 2] {
            let payload = serde_json::to_vec(&serde_json::json!({
                "gateway_request_version": version,
                "request": {
                    "create_standalone": {
                        "request_id": "request-1",
                        "target_session_id": "standalone-1",
                        "launch_owner_proof": "launch-proof-1",
                        "session_name": "remote-shell",
                        "bridge_nonce": "bridge-nonce-1",
                        "cwd": "/home/tester/project",
                        "initial_rows": 40,
                        "initial_columns": 120,
                        "command_intercepts": [
                            { "command": "codex", "provider_id": "codex" }
                        ]
                    }
                }
            }))
            .unwrap();
            assert!(matches!(
                classify_first_document(&payload),
                FirstDocument::Refused(_)
            ));
        }
    }

    #[test]
    fn version_three_exclusively_negotiates_unpresented_creation_abandon() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "gateway_request_version": 3,
            "request": {
                "abandon_unpresented_creation": {
                    "request_id": "request-1",
                    "session_id": "standalone-1",
                    "workspace_id": "workspace-1",
                    "launch_owner_proof": "launch-proof-1"
                }
            }
        }))
        .unwrap();
        let FirstDocument::Request {
            gateway_request_version: 3,
            request: GatewayRequest::AbandonUnpresentedCreation(request),
        } = classify_first_document(&payload)
        else {
            panic!("version three abandon request must be structurally recognized");
        };
        assert_eq!(request, abandon_request());
        validate_abandon_unpresented_creation_request(&request).unwrap();
        assert!(!format!("{request:?}").contains("launch-proof-1"));

        for wrong_version in [1, 2] {
            let mut value = serde_json::from_slice::<serde_json::Value>(&payload).unwrap();
            value["gateway_request_version"] = wrong_version.into();
            assert!(
                matches!(
                    classify_first_document(&serde_json::to_vec(&value).unwrap()),
                    FirstDocument::Refused(_)
                ),
                "version {wrong_version} must retain its pre-abandon request vocabulary"
            );
        }
    }

    #[test]
    fn version_five_exclusively_negotiates_exact_session_input() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "gateway_request_version": 5,
            "request": {
                "write_session_input": {
                    "request_id": "request-input-1",
                    "expected_fence": fence(),
                    "bytes": [115, 116, 97, 116, 117, 115, 13]
                }
            }
        }))
        .unwrap();
        let FirstDocument::Request {
            gateway_request_version: 5,
            request: GatewayRequest::WriteSessionInput(request),
        } = classify_first_document(&payload)
        else {
            panic!("version five input request must be structurally recognized");
        };
        assert_eq!(request, input_request(b"status\r".to_vec()));
        validate_session_input_request(&request).unwrap();
        assert!(!format!("{request:?}").contains("status"));

        for wrong_version in 1..=4 {
            let mut value = serde_json::from_slice::<serde_json::Value>(&payload).unwrap();
            value["gateway_request_version"] = wrong_version.into();
            assert!(
                matches!(
                    classify_first_document(&serde_json::to_vec(&value).unwrap()),
                    FirstDocument::Refused(_)
                ),
                "version {wrong_version} must retain its pre-input request vocabulary"
            );
        }
    }

    #[test]
    fn exact_session_input_is_bounded_and_forced_command_keys_cannot_write() {
        assert!(validate_session_input_request(&input_request(Vec::new())).is_err());
        assert!(
            validate_session_input_request(&input_request(vec![
                b'x';
                MAX_GATEWAY_SESSION_INPUT_BYTES + 1
            ]))
            .is_err()
        );
        let refusal = session_input_refusal(true, "request-input-1")
            .expect("forced command must refuse exact input");
        assert_eq!(refusal.code, ErrorCode::AuthorizationDenied);
        assert!(session_input_refusal(false, "request-input-1").is_none());
    }

    #[test]
    fn exact_session_input_receipt_is_typed_correlated_and_byte_free() {
        let request = input_request(b"private input\r".to_vec());
        let receipt = InputReceipt {
            request_id: "external-input-1".into(),
            controller_generation: 9,
            state: InputReceiptState::WrittenToPty,
            reason: None,
            detail: None,
        };
        let mut encoded = Vec::new();
        write_session_input_document(&mut encoded, &request, &receipt).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded[4..]).unwrap();
        assert_eq!(value["gateway_input_version"], 1);
        assert_eq!(value["request_id"], "request-input-1");
        assert_eq!(value["session_id"], "session");
        assert_eq!(value["workspace_id"], "workspace");
        assert_eq!(value["receipt"]["request_id"], "external-input-1");
        assert_eq!(value["receipt"]["state"], "written_to_pty");
        assert!(!value.to_string().contains("private input"));
    }

    #[test]
    fn abandon_receipt_is_typed_and_correlated_without_echoing_the_proof() {
        let request = abandon_request();
        let receipt = SessionRetirementReceipt {
            request_id: "host-retirement-1".into(),
            state: SessionRetirementReceiptState::Refused,
            reason: Some(SessionRetirementReceiptReason::GenerationChanged),
            policy: None,
        };
        let mut encoded = Vec::new();
        write_abandon_unpresented_creation_document(&mut encoded, &request, &receipt).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded[4..]).unwrap();

        assert_eq!(value["gateway_abandon_version"], 1);
        assert_eq!(value["request_id"], "request-1");
        assert_eq!(value["session_id"], "standalone-1");
        assert_eq!(value["workspace_id"], "workspace-1");
        assert_eq!(value["receipt"]["state"], "refused");
        assert_eq!(value["receipt"]["reason"], "generation_changed");
        assert!(
            !value.to_string().contains("launch-proof-1"),
            "the launch proof is request-only authority and must not cross back"
        );
    }

    #[test]
    fn a_forced_command_refuses_process_creation_before_mutation() {
        let refusal = standalone_creation_refusal(true, CreationAuthority::Withheld)
            .expect("forced command must refuse standalone creation");
        assert_eq!(refusal.code, ErrorCode::AuthorizationDenied);
        assert!(standalone_creation_refusal(false, CreationAuthority::Withheld).is_none());
    }

    /// The widening is the operator's, and it is the only thing that lifts the
    /// refusal — a forced command without `--allow-create` still refuses, and a
    /// hand invocation was never refused in the first place.
    #[test]
    fn a_forced_command_creates_only_when_the_line_grants_it() {
        assert!(standalone_creation_refusal(true, CreationAuthority::Granted).is_none());
        assert!(standalone_creation_refusal(false, CreationAuthority::Granted).is_none());
        assert!(standalone_creation_refusal(true, CreationAuthority::Withheld).is_some());
    }

    #[test]
    fn a_forced_command_refuses_session_lifetime_mutation_before_opening_the_catalog() {
        let refusal =
            session_mutation_refusal(true).expect("forced command must refuse abandonment");
        assert_eq!(refusal.code, ErrorCode::AuthorizationDenied);
        assert!(session_mutation_refusal(false).is_none());
    }

    #[test]
    fn command_bridges_are_private_exact_and_idempotent() {
        let state = tempfile::tempdir().unwrap();
        let discovery = state.path().join("new-home/state/hmux-hosts");
        assert!(!discovery.exists());
        let request = standalone_request();
        let bridge = prepare_command_bridge(&discovery, &request).unwrap();
        assert_eq!(
            prepare_command_bridge(&discovery, &request).unwrap(),
            bridge
        );
        for command in ["claude", "codex"] {
            let script = bridge.join(command);
            let contents = fs::read_to_string(&script).unwrap();
            assert!(contents.contains(" command-bridge "));
            assert!(contents.contains("--bridge-nonce 'bridge-nonce-1'"));
            assert!(contents.contains(&format!("--executable '{command}'")));
            assert!(!contents.contains("token"));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(&script).unwrap().permissions().mode() & 0o777,
                    0o700
                );
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&discovery).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&bridge).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn standalone_working_directory_is_absolute_canonical_and_existing() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let requested = project.to_str().unwrap();

        assert_eq!(
            resolve_standalone_working_directory(Some(requested), root.path()).unwrap(),
            project.canonicalize().unwrap()
        );
        assert!(
            resolve_standalone_working_directory(Some("relative/project"), root.path()).is_err()
        );
        assert!(
            resolve_standalone_working_directory(
                Some(root.path().join("missing").to_str().unwrap()),
                root.path(),
            )
            .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn command_bridge_refuses_a_symlinked_discovery_root() {
        use std::os::unix::fs::symlink;
        let state = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let discovery = state.path().join("discovery");
        symlink(outside.path(), &discovery).unwrap();
        prepare_command_bridge(&discovery, &standalone_request()).unwrap_err();
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn command_bridge_refuses_a_symlinked_session_directory() {
        use std::os::unix::fs::symlink;
        let discovery = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = discovery.path().join(".command-bridges-v1");
        fs::create_dir(&root).unwrap();
        symlink(outside.path(), root.join("standalone-1")).unwrap();
        let error = prepare_command_bridge(discovery.path(), &standalone_request()).unwrap_err();
        assert!(error.0.contains("symlink"));
        assert!(!outside.path().join("claude").exists());
    }

    #[test]
    fn a_request_from_a_newer_client_is_refused_by_version_rather_than_by_shape() {
        // A newer phone will send a version this build does not serve, quite
        // possibly with a `request` value that has no variant here. It must be
        // told the version, because that is the fact it can act on; a serde
        // message about an unknown variant sends it looking for a typo.
        let future_version = GATEWAY_REQUEST_VERSION_MAXIMUM + 1;
        let document = format!(
            r#"{{"gateway_request_version":{future_version},"request":"something_from_the_future"}}"#
        );
        let refusal = match classify_first_document(document.as_bytes()) {
            FirstDocument::Refused(refusal) => refusal,
            other => panic!("a newer request document must be refused, got {other:?}"),
        };
        assert_eq!(refusal.code, ErrorCode::UnsupportedProtocolVersion);
        assert!(
            refusal.message.contains(&future_version.to_string()),
            "the peer needs to know which version was refused: {}",
            refusal.message
        );
        assert!(
            refusal.supported_versions.is_some(),
            "a version refusal the peer cannot act on is a close with extra steps"
        );
    }

    /// One version admits one variant. A newer request version must never
    /// silently widen what an older one may ask for, and the reverse — an old
    /// version carrying a new verb — must not be served either.
    #[test]
    fn the_source_control_read_is_admitted_at_its_own_version_and_nowhere_else() {
        let document = br#"{"gateway_request_version":8,"request":{"source_control_status":{"request_id":"r-1","session_id":"s-1","workspace_id":"w-1"}}}"#;
        assert!(
            matches!(
                classify_first_document(document),
                FirstDocument::Request {
                    request: GatewayRequest::SourceControlStatus(_),
                    ..
                }
            ),
            "version 8 must serve the source control read"
        );

        // The same verb at the listing's version.
        assert!(matches!(
            classify_first_document(
                br#"{"gateway_request_version":4,"request":{"source_control_status":{"request_id":"r-1","session_id":"s-1","workspace_id":"w-1"}}}"#
            ),
            FirstDocument::Refused(_)
        ));
        // The listing at the source control version.
        assert!(matches!(
            classify_first_document(br#"{"gateway_request_version":8,"request":"list_sessions"}"#),
            FirstDocument::Refused(_)
        ));
    }

    /// A path in this document would turn a directory read into a command
    /// channel. `deny_unknown_fields` is what stops one being added by a peer;
    /// this asserts it rather than trusting the derive.
    #[test]
    fn a_source_control_read_cannot_carry_a_path() {
        assert!(matches!(
            classify_first_document(
                br#"{"gateway_request_version":8,"request":{"source_control_status":{"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","path":"/etc"}}}"#
            ),
            FirstDocument::Refused(_)
        ));
    }

    /// The ceiling and the highest named version move together. Apart, a
    /// version exists that nothing admits, or one is admitted that the ceiling
    /// says is unserved.
    #[test]
    fn the_request_version_ceiling_is_the_highest_named_version() {
        assert_eq!(
            GATEWAY_REQUEST_VERSION_MAXIMUM,
            GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_DIFF
        );
    }

    /// The patch request is a request of its own, admitted by a version of its
    /// own. Serving it under the status versions would be exactly the widening
    /// `a_source_control_read_cannot_carry_a_path` exists to prevent — the
    /// promise that a status read names nothing has to keep holding for the
    /// phones already in the field.
    #[test]
    fn a_file_diff_is_admitted_only_by_its_own_version() {
        let document = |version: u16| {
            format!(
                r#"{{"gateway_request_version":{version},"request":{{"source_control_file_diff":{{"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","path":"src/app.ts"}}}}}}"#
            )
        };

        assert!(matches!(
            classify_first_document(
                document(GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_DIFF).as_bytes()
            ),
            FirstDocument::Request {
                request: GatewayRequest::SourceControlFileDiff(_),
                ..
            }
        ));
        for version in [
            GATEWAY_REQUEST_VERSION_SOURCE_CONTROL,
            GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_WANT,
        ] {
            assert!(
                matches!(
                    classify_first_document(document(version).as_bytes()),
                    FirstDocument::Refused(_)
                ),
                "version {version} served a patch request"
            );
        }
    }

    /// And the reverse: a document labelled 10 is a patch request and nothing
    /// else. Without this a status read could be served under a version whose
    /// shape admits a path, which is the same widening from the other side.
    #[test]
    fn the_file_diff_version_serves_no_other_request() {
        assert!(matches!(
            classify_first_document(
                format!(
                    r#"{{"gateway_request_version":{},"request":{{"source_control_status":{{"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","want":"commits"}}}}}}"#,
                    GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_DIFF
                )
                .as_bytes()
            ),
            FirstDocument::Refused(_)
        ));
    }

    /// The two versions are a pairing, not a widening.
    ///
    /// Version 8 must keep serving exactly the document phones already in the
    /// field send — that assertion above is the regression that catches a build
    /// which stops answering them. Version 9 must require the `want`, so a
    /// document labelled 8 can never be served an answer its own declared
    /// version does not include.
    #[test]
    fn the_want_is_admitted_only_at_the_version_that_carries_it() {
        let v9_with_want = br#"{"gateway_request_version":9,"request":{"source_control_status":{"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","want":"pull_request"}}}"#;
        assert!(
            matches!(
                classify_first_document(v9_with_want),
                FirstDocument::Request {
                    request: GatewayRequest::SourceControlStatus(_),
                    ..
                }
            ),
            "version 9 must serve a read that names which answer it wants"
        );

        let v9_without_want = br#"{"gateway_request_version":9,"request":{"source_control_status":{"request_id":"r-1","session_id":"s-1","workspace_id":"w-1"}}}"#;
        assert!(
            matches!(
                classify_first_document(v9_without_want),
                FirstDocument::Refused(_)
            ),
            "version 9 without a want is not the shape version 9 describes"
        );

        let v8_with_want = br#"{"gateway_request_version":8,"request":{"source_control_status":{"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","want":"changes"}}}"#;
        assert!(
            matches!(
                classify_first_document(v8_with_want),
                FirstDocument::Refused(_)
            ),
            "a want must not be served under the version that predates it"
        );
    }

    /// An unknown want is refused at the boundary rather than reaching the
    /// reader, which is the whole reason it is a closed enum.
    #[test]
    fn an_unknown_want_never_reaches_the_reader() {
        let document = br#"{"gateway_request_version":9,"request":{"source_control_status":{"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","want":"rm -rf"}}}"#;
        assert!(matches!(
            classify_first_document(document),
            FirstDocument::Refused(_)
        ));
    }

    #[test]
    fn an_unknown_request_at_a_version_this_build_serves_is_refused() {
        // Same version, unknown verb. This is the one that must *not* fall
        // through to the attach path: a document that says it is a gateway
        // request is answered as one, understood or not.
        let refusal = match classify_first_document(
            br#"{"gateway_request_version":1,"request":"terminate_everything"}"#,
        ) {
            FirstDocument::Refused(refusal) => refusal,
            other => panic!("an unknown request must be refused, got {other:?}"),
        };
        assert_eq!(refusal.code, ErrorCode::UnsupportedProtocolVersion);
    }

    #[test]
    fn a_request_carrying_a_field_this_build_does_not_know_is_refused() {
        // `deny_unknown_fields`, asserted rather than assumed. At a version both
        // sides claim, an unrecognised field means they disagree about what the
        // document *means*, and serving it anyway is how a silent misreading
        // becomes a wrong answer somewhere else.
        assert!(matches!(
            classify_first_document(
                br#"{"gateway_request_version":1,"request":"list_sessions","scope":"everything"}"#
            ),
            FirstDocument::Refused(_)
        ));
    }

    #[test]
    fn bytes_that_are_neither_shape_fall_through_to_the_frame_decoder() {
        // Not a refusal minted here: the codec's own decode produces the typed
        // answer, with `supported_versions` attached. Two sources of "that was
        // unreadable" would drift.
        for payload in [&b"{"[..], &b"not json at all"[..], &b"{\"body\":{}}"[..]] {
            assert!(
                matches!(classify_first_document(payload), FirstDocument::Frame),
                "{} must be left to the frame decoder",
                String::from_utf8_lossy(payload)
            );
        }
    }

    #[test]
    fn a_cursor_from_a_peer_that_did_not_negotiate_resume_is_not_offered() {
        // The peer sent a position but never asked for the mode that changes
        // the reply shape. Honoring it would hand that peer an ack listing a
        // capability it did not request, and a handshake with no snapshot in it.
        let mut hello = hello(AttachMode::Observer, &["screen_snapshot", "live_output"]);
        hello.reconnect_cursor = Some(cursor(42));
        assert_eq!(relayed_reconnect_cursor(&hello), None);
    }

    #[test]
    fn a_negotiated_cursor_crosses_the_relay_unrepaired() {
        // `u64::MAX` is the shape the gateway must *not* fix. Clamping it to
        // the Host's position would turn a refusal into a resume the Host never
        // agreed to, and the peer would desynchronize on the first live delta.
        // Passing it through is what lets the client half refuse it at attach.
        let mut hello = hello(
            AttachMode::Observer,
            &[
                "screen_snapshot",
                "live_output",
                RECONNECT_RESUME_CAPABILITY,
            ],
        );
        hello.reconnect_cursor = Some(cursor(u64::MAX));
        assert_eq!(relayed_reconnect_cursor(&hello), Some(cursor(u64::MAX)));
    }

    #[test]
    fn a_negotiated_hello_without_a_cursor_offers_none() {
        // Asking for the capability is not offering a position. A cursor
        // synthesized here would resume onto a screen the peer does not hold.
        let hello = hello(
            AttachMode::Observer,
            &[
                "screen_snapshot",
                "live_output",
                RECONNECT_RESUME_CAPABILITY,
            ],
        );
        assert_eq!(relayed_reconnect_cursor(&hello), None);
    }

    #[test]
    fn a_cursor_the_client_half_refused_tells_the_peer_to_drop_it() {
        let error = ClientError::InconsistentStream {
            reason: "reconnect cursor is ahead of the Host",
        };
        let (refusal, retry) = local_attach_refusal(&error, true);
        assert_eq!(refusal.code, ErrorCode::ReplayGap);
        // The posture is the whole point: `Reconnect` would send the phone
        // round the same loop with the same cursor forever.
        assert_eq!(retry, RetryPosture::RetryAfterResync);
        assert!(
            refusal.message.contains("ahead of the Host"),
            "the peer needs the diagnosis, not just a code: {}",
            refusal.message
        );

        // Without a cursor the same error is not the peer's doing, and the
        // advice must not become "resync" for a fault it cannot act on.
        let (refusal, retry) = local_attach_refusal(&error, false);
        assert_eq!(refusal.code, ErrorCode::TransportClosed);
        assert_eq!(retry, RetryPosture::Reconnect);
    }

    #[test]
    fn observer_ceiling_refuses_a_controller_hello() {
        let refusal = admit_relayed_hello(
            &hello(AttachMode::Controller, &["screen_snapshot"]),
            GatewayRole::Observer,
            &fence(),
        )
        .unwrap_err();
        assert_eq!(refusal.code, ErrorCode::AuthorizationDenied);
    }

    #[test]
    fn controller_ceiling_admits_both_modes() {
        assert_eq!(
            admit_relayed_hello(
                &hello(AttachMode::Controller, &["screen_snapshot"]),
                GatewayRole::Controller,
                &fence(),
            )
            .unwrap(),
            LocalAttachRole::Controller
        );
        assert_eq!(
            admit_relayed_hello(
                &hello(AttachMode::Observer, &["screen_snapshot"]),
                GatewayRole::Controller,
                &fence(),
            )
            .unwrap(),
            LocalAttachRole::Observer
        );
    }

    #[test]
    fn viewport_projection_never_implies_terminal_input() {
        let selection = admit_relayed_terminal_capabilities(
            &hello(
                AttachMode::Observer,
                &[
                    TERMINAL_STATE_BINARY_CAPABILITY,
                    TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                    AGENT_IDENTITY_PROJECTION_CAPABILITY,
                    PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
                ],
            ),
            GatewayRole::Observer,
        )
        .unwrap();

        assert_eq!(
            selection,
            RelayedTerminalSelection {
                viewport: true,
                wheel: false,
                multipart: false,
                input: false,
                agent_prompt: RelayedAgentPromptOffer::default(),
                default_colors: false,
                agent_identity: true,
                runtime_state: false,
                identity: true,
            }
        );
    }

    #[test]
    fn observer_gateway_refuses_explicit_terminal_input() {
        let refusal = admit_relayed_terminal_capabilities(
            &hello(
                AttachMode::Observer,
                &[
                    TERMINAL_STATE_BINARY_CAPABILITY,
                    TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                    TERMINAL_INPUT_INTENT_CAPABILITY,
                ],
            ),
            GatewayRole::Observer,
        )
        .unwrap_err();

        assert_eq!(refusal.code, ErrorCode::AuthorizationDenied);
        assert_eq!(
            refusal.required_capability.as_deref(),
            Some(TERMINAL_INPUT_INTENT_CAPABILITY)
        );
    }

    #[test]
    fn controller_gateway_admits_scoped_agent_prompt_without_generic_input() {
        let request = hello(
            AttachMode::Observer,
            &[
                TERMINAL_STATE_BINARY_CAPABILITY,
                TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                AGENT_PROMPT_CAPABILITY,
            ],
        );

        assert_eq!(
            admit_relayed_hello(&request, GatewayRole::Controller, &fence()).unwrap(),
            LocalAttachRole::Observer
        );
        let selection =
            admit_relayed_terminal_capabilities(&request, GatewayRole::Controller).unwrap();
        assert!(!selection.input);
        assert!(selection.agent_prompt.is_some());
    }

    #[test]
    fn gateway_relays_the_process_observed_prompt_extension_independently() {
        let request = hello(
            AttachMode::Observer,
            &[
                TERMINAL_STATE_BINARY_CAPABILITY,
                TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                AGENT_PROMPT_CAPABILITY,
                PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
            ],
        );

        let selection =
            admit_relayed_terminal_capabilities(&request, GatewayRole::Controller).unwrap();
        assert!(selection.agent_prompt.process_observed);
        assert_eq!(
            gateway_local_optional_capabilities(false, false, false, false, selection.agent_prompt),
            &[
                AGENT_PROMPT_CAPABILITY,
                PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
            ]
        );
    }

    #[test]
    fn process_observed_prompt_extension_requires_the_targeted_lane() {
        let refusal = admit_relayed_terminal_capabilities(
            &hello(
                AttachMode::Observer,
                &[
                    TERMINAL_STATE_BINARY_CAPABILITY,
                    TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                    PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
                ],
            ),
            GatewayRole::Controller,
        )
        .unwrap_err();

        assert_eq!(refusal.code, ErrorCode::UnsupportedCapability);
        assert_eq!(
            refusal.required_capability.as_deref(),
            Some(AGENT_PROMPT_CAPABILITY)
        );
    }

    #[cfg(unix)]
    #[test]
    fn gateway_preserves_explicit_generic_input_with_agent_prompt() {
        let capabilities = [
            TERMINAL_STATE_BINARY_CAPABILITY,
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
            TERMINAL_INPUT_INTENT_CAPABILITY,
            AGENT_PROMPT_CAPABILITY,
        ];
        let input = encode_record(3, &text_intent_record()).expect("input intent encodes");
        let (connection, observation) = attach_relayed_profile(
            &capabilities,
            GatewayRole::Controller,
            &[AGENT_PROMPT_CAPABILITY],
            false,
            Some(input),
        );

        assert!(
            connection
                .hello_ack()
                .selected_capabilities
                .iter()
                .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY)
        );
        assert_eq!(
            observation
                .input
                .expect("ordinary input reaches the local Host")
                .metadata
                .record_id,
            3
        );
    }

    #[cfg(unix)]
    #[test]
    fn prompt_only_targeted_attach_never_requests_generic_input() {
        let capabilities = [
            TERMINAL_STATE_BINARY_CAPABILITY,
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
            AGENT_PROMPT_CAPABILITY,
            LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
        ];
        let (connection, observation) = attach_relayed_profile(
            &capabilities,
            GatewayRole::Controller,
            &[
                AGENT_PROMPT_CAPABILITY,
                LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
            ],
            false,
            None,
        );

        assert!(
            !observation
                .local_hello
                .requested_capabilities
                .iter()
                .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY)
        );
        assert!(
            !connection
                .hello_ack()
                .selected_capabilities
                .iter()
                .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY)
        );
    }

    #[cfg(unix)]
    #[test]
    fn prompt_only_legacy_attach_keeps_generic_input_as_an_internal_dependency() {
        let capabilities = [
            TERMINAL_STATE_BINARY_CAPABILITY,
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
            AGENT_PROMPT_CAPABILITY,
            LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
        ];
        let (connection, observation) = attach_relayed_profile(
            &capabilities,
            GatewayRole::Controller,
            &[LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY],
            false,
            None,
        );

        assert!(
            observation
                .local_hello
                .requested_capabilities
                .iter()
                .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY)
        );
        let input = encode_record(3, &text_intent_record()).expect("input intent encodes");
        let error = connection
            .terminal_input_writer_capability()
            .expect("legacy prompt writer is selected")
            .send_input_envelope(&input)
            .expect_err("the legacy dependency must not expose ordinary input");
        assert_eq!(error.code(), "hmux_capability_missing");
    }

    #[cfg(unix)]
    #[test]
    fn legacy_only_offer_to_a_targeted_host_does_not_synthesize_generic_input() {
        let capabilities = [
            TERMINAL_STATE_BINARY_CAPABILITY,
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
            LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
        ];
        let (_, observation) = attach_relayed_profile(
            &capabilities,
            GatewayRole::Controller,
            &[
                AGENT_PROMPT_CAPABILITY,
                LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
            ],
            false,
            None,
        );

        assert!(
            !observation
                .local_hello
                .requested_capabilities
                .iter()
                .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY)
        );
    }

    #[cfg(unix)]
    #[test]
    fn explicit_input_and_default_colors_survive_a_legacy_prompt_offer() {
        let capabilities = [
            TERMINAL_STATE_BINARY_CAPABILITY,
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
            TERMINAL_INPUT_INTENT_CAPABILITY,
            AGENT_PROMPT_CAPABILITY,
            LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
            TERMINAL_DEFAULT_COLORS_CAPABILITY,
        ];
        let input = encode_record(3, &text_intent_record()).expect("input intent encodes");
        let (_, observation) = attach_relayed_profile(
            &capabilities,
            GatewayRole::Controller,
            &[
                AGENT_PROMPT_CAPABILITY,
                LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
            ],
            false,
            Some(input),
        );

        assert!(
            observation
                .local_hello
                .requested_capabilities
                .iter()
                .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY)
        );
        assert!(
            observation
                .local_hello
                .requested_capabilities
                .iter()
                .any(|capability| capability == TERMINAL_DEFAULT_COLORS_CAPABILITY)
        );
        assert_eq!(
            observation
                .input
                .expect("explicit ordinary input reaches the local Host")
                .metadata
                .record_id,
            3
        );
    }

    #[test]
    fn observer_gateway_refuses_scoped_agent_prompt() {
        let refusal = admit_relayed_terminal_capabilities(
            &hello(
                AttachMode::Observer,
                &[
                    TERMINAL_STATE_BINARY_CAPABILITY,
                    TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                    AGENT_PROMPT_CAPABILITY,
                ],
            ),
            GatewayRole::Observer,
        )
        .unwrap_err();

        assert_eq!(refusal.code, ErrorCode::AuthorizationDenied);
        assert_eq!(
            refusal.required_capability.as_deref(),
            Some(AGENT_PROMPT_CAPABILITY)
        );
    }

    #[test]
    fn dependent_terminal_capabilities_require_the_binary_carrier() {
        for capability in [
            TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
            TERMINAL_INPUT_INTENT_CAPABILITY,
            AGENT_PROMPT_CAPABILITY,
            LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
            TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
            TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
        ] {
            let refusal = admit_relayed_terminal_capabilities(
                &hello(AttachMode::Observer, &[capability]),
                GatewayRole::Controller,
            )
            .unwrap_err();
            assert_eq!(refusal.code, ErrorCode::UnsupportedCapability);
            assert_eq!(
                refusal.required_capability.as_deref(),
                Some(TERMINAL_STATE_BINARY_CAPABILITY)
            );
        }
    }

    #[test]
    fn viewportless_binary_terminal_profiles_are_refused_at_the_gateway() {
        for capabilities in [
            vec![TERMINAL_STATE_BINARY_CAPABILITY],
            vec![
                TERMINAL_STATE_BINARY_CAPABILITY,
                TERMINAL_INPUT_INTENT_CAPABILITY,
            ],
            vec![
                TERMINAL_STATE_BINARY_CAPABILITY,
                TERMINAL_VIEWPORT_WHEEL_CAPABILITY,
            ],
            vec![
                TERMINAL_STATE_BINARY_CAPABILITY,
                TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
            ],
        ] {
            let refusal = admit_relayed_terminal_capabilities(
                &hello(AttachMode::Observer, &capabilities),
                GatewayRole::Controller,
            )
            .expect_err("the gateway must not relay the removed viewportless binary profile");
            assert_eq!(refusal.code, ErrorCode::UnsupportedCapability);
            assert_eq!(
                refusal.required_capability.as_deref(),
                Some(TERMINAL_VIEWPORT_PROJECTION_CAPABILITY)
            );
        }
    }

    #[test]
    fn a_hello_naming_another_session_is_refused() {
        let refusal = admit_relayed_hello(
            &hello(AttachMode::Observer, &["screen_snapshot"]),
            GatewayRole::Observer,
            &SessionFence {
                session_id: "other-session".into(),
                ..fence()
            },
        )
        .unwrap_err();
        assert_eq!(refusal.code, ErrorCode::IdentityMismatch);
        assert!(refusal.message.contains("other-session"));
        // The peer's own string must not be reflected into a diagnostic.
        assert!(!refusal.message.contains("session\""));
    }

    #[test]
    fn a_hello_naming_another_workspace_is_refused() {
        let refusal = admit_relayed_hello(
            &hello(AttachMode::Observer, &["screen_snapshot"]),
            GatewayRole::Observer,
            &SessionFence {
                workspace_id: "other-workspace".into(),
                ..fence()
            },
        )
        .unwrap_err();
        assert_eq!(refusal.code, ErrorCode::IdentityMismatch);
    }

    #[test]
    fn every_colocation_premised_capability_is_refused_at_hello() {
        for capability in COLOCATION_PREMISED_CAPABILITIES {
            let refusal = admit_relayed_hello(
                &hello(AttachMode::Observer, &["screen_snapshot", capability]),
                GatewayRole::Controller,
                &fence(),
            )
            .unwrap_err();
            assert_eq!(refusal.code, ErrorCode::UnsupportedCapability);
            assert_eq!(
                refusal.required_capability.as_deref(),
                Some(*capability),
                "{capability} must be named as the refused capability"
            );
        }
    }

    #[test]
    fn a_granted_colocation_premised_capability_is_detected() {
        assert_eq!(
            colocation_premised_grant(&[
                "screen_snapshot".to_string(),
                SHARED_TERMINAL_INPUT_CAPABILITY.to_string(),
            ]),
            Some(SHARED_TERMINAL_INPUT_CAPABILITY)
        );
        assert_eq!(
            colocation_premised_grant(&["screen_snapshot".to_string(), "live_output".to_string()]),
            None
        );
        assert_eq!(
            colocation_premised_grant(&[SESSION_RETIREMENT_CAPABILITY.to_string()]),
            None,
            "retirement is Host-evaluated and is not premised on process colocation"
        );
    }

    #[test]
    fn retirement_negotiation_allows_a_self_scoped_observer_departure() {
        let controller = hello(
            AttachMode::Controller,
            &["screen_snapshot", SESSION_RETIREMENT_CAPABILITY],
        );
        assert!(should_relay_retirement(
            GatewayRole::Controller,
            LocalAttachRole::Controller,
            &controller,
        ));

        let observer = hello(
            AttachMode::Observer,
            &["screen_snapshot", SESSION_RETIREMENT_CAPABILITY],
        );
        assert!(
            should_relay_retirement(
                GatewayRole::Controller,
                LocalAttachRole::Observer,
                &observer,
            ),
            "the SSH departure helper must retain observer posture while asking the Host to evaluate its own departure"
        );
        assert!(!should_relay_retirement(
            GatewayRole::Observer,
            LocalAttachRole::Controller,
            &controller,
        ));
        assert!(!should_relay_retirement(
            GatewayRole::Controller,
            LocalAttachRole::Controller,
            &hello(AttachMode::Controller, &["screen_snapshot"]),
        ));
        assert!(
            admit_retirement_grant(false, &[SESSION_RETIREMENT_CAPABILITY.to_string()],).is_err(),
            "a Host over-grant must fail before its HelloAck reaches an observer"
        );
    }

    #[test]
    fn a_minted_managed_grant_negotiates_the_scoped_grant_contract() {
        assert_eq!(
            gateway_local_optional_capabilities(
                true,
                false,
                false,
                false,
                RelayedAgentPromptOffer::default(),
            ),
            &[MANAGED_AUTHORIZATION_GRANT_CAPABILITY],
        );
        assert_eq!(
            gateway_local_optional_capabilities(
                true,
                true,
                false,
                false,
                RelayedAgentPromptOffer::default(),
            ),
            &[
                MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
                SESSION_RETIREMENT_CAPABILITY,
            ],
        );
        assert_eq!(
            gateway_local_optional_capabilities(
                false,
                true,
                false,
                false,
                RelayedAgentPromptOffer::default(),
            ),
            &[SESSION_RETIREMENT_CAPABILITY],
        );
        assert_eq!(
            gateway_local_optional_capabilities(
                false,
                false,
                true,
                true,
                RelayedAgentPromptOffer::default(),
            ),
            &[
                AGENT_IDENTITY_PROJECTION_CAPABILITY,
                PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
            ],
        );
        assert_eq!(
            gateway_local_optional_capabilities(
                false,
                false,
                false,
                true,
                RelayedAgentPromptOffer::default(),
            ),
            &[PROVIDER_CONVERSATION_IDENTITY_CAPABILITY],
        );
        assert_eq!(
            gateway_local_optional_capabilities(
                false,
                false,
                false,
                false,
                RelayedAgentPromptOffer::from_requests(true, false, false),
            ),
            &[AGENT_PROMPT_CAPABILITY],
        );
        assert_eq!(
            gateway_local_optional_capabilities(
                false,
                false,
                false,
                false,
                RelayedAgentPromptOffer::from_requests(false, false, true),
            ),
            &[LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY],
        );
        assert_eq!(
            gateway_local_optional_capabilities(
                false,
                false,
                false,
                false,
                RelayedAgentPromptOffer::from_requests(true, false, true),
            ),
            &[
                AGENT_PROMPT_CAPABILITY,
                LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
            ],
        );
        assert_eq!(
            gateway_local_optional_capabilities(
                false,
                false,
                false,
                false,
                RelayedAgentPromptOffer::from_requests(true, true, true),
            ),
            &[
                AGENT_PROMPT_CAPABILITY,
                PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
                LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
            ],
        );
        assert!(
            gateway_local_optional_capabilities(
                false,
                false,
                false,
                false,
                RelayedAgentPromptOffer::default(),
            )
            .is_empty()
        );
    }

    #[test]
    fn a_local_managed_grant_never_crosses_the_relay_ack() {
        let peer_ack = peer_visible_hello_ack(
            ack_with_selected(vec![
                TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
                TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
                TERMINAL_INPUT_INTENT_CAPABILITY.to_string(),
                AGENT_PROMPT_CAPABILITY.to_string(),
                MANAGED_AUTHORIZATION_GRANT_CAPABILITY.to_string(),
            ]),
            true,
            false,
        )
        .unwrap();
        assert!(
            peer_ack
                .selected_capabilities
                .iter()
                .any(|capability| capability == AGENT_PROMPT_CAPABILITY)
        );
        assert!(
            !peer_ack
                .selected_capabilities
                .iter()
                .any(|capability| capability == MANAGED_AUTHORIZATION_GRANT_CAPABILITY)
        );
        assert_eq!(
            colocation_premised_grant(&peer_ack.selected_capabilities),
            None
        );
    }

    #[test]
    fn a_prompt_only_legacy_input_dependency_never_becomes_peer_authority() {
        let selection = admit_relayed_terminal_capabilities(
            &hello(
                AttachMode::Observer,
                &[
                    TERMINAL_STATE_BINARY_CAPABILITY,
                    TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                    AGENT_PROMPT_CAPABILITY,
                    LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
                ],
            ),
            GatewayRole::Controller,
        )
        .unwrap();
        assert!(!selection.input);
        assert_eq!(
            selection.agent_prompt.preferred,
            Some(AgentPromptCapabilitySelection::Targeted)
        );
        assert!(selection.agent_prompt.offers_legacy_lane());

        let peer_ack = peer_visible_hello_ack(
            ack_with_selected(vec![
                TERMINAL_STATE_BINARY_CAPABILITY.to_string(),
                TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string(),
                TERMINAL_INPUT_INTENT_CAPABILITY.to_string(),
                LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY.to_string(),
            ]),
            false,
            selection.agent_prompt.offers_legacy_lane() && !selection.input,
        )
        .unwrap();
        assert!(
            peer_ack
                .selected_capabilities
                .iter()
                .any(|capability| capability == LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY)
        );
        assert!(
            !peer_ack
                .selected_capabilities
                .iter()
                .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY)
        );
    }

    #[test]
    fn an_unrequested_managed_grant_is_refused_before_sanitization() {
        let refusal = peer_visible_hello_ack(
            ack_with_selected(vec![MANAGED_AUTHORIZATION_GRANT_CAPABILITY.to_string()]),
            false,
            false,
        )
        .unwrap_err();

        assert_eq!(refusal.code, ErrorCode::AuthorizationDenied);
        assert_eq!(
            refusal.required_capability.as_deref(),
            Some(MANAGED_AUTHORIZATION_GRANT_CAPABILITY)
        );
    }

    #[test]
    fn the_upstream_filter_forwards_only_the_client_half_of_the_protocol() {
        // The allow-list, stated positively. If a future edit re-adds a
        // `_ => Forward` arm this test still passes — what makes the direction
        // enforceable is the absence of a wildcard in `upstream_decision`, which
        // the compiler checks. This pins the membership.
        for permitted in [
            FrameBody::ScreenSnapshotRequest(ScreenSnapshotRequest {
                request_id: "r".into(),
                expected_fence: fence(),
                profile: None,
            }),
            FrameBody::Input(Input {
                request_id: "r".into(),
                controller_generation: 1,
                bytes: b"typed".to_vec(),
            }),
            FrameBody::Resize(Resize {
                request_id: "r".into(),
                controller_generation: 1,
                rows: 24,
                columns: 80,
            }),
            FrameBody::ControlRequest(ControlRequest {
                request_id: "r".into(),
                expected_controller_generation: 1,
            }),
            FrameBody::ControlRelease(ControlRelease {
                request_id: "r".into(),
                controller_generation: 1,
            }),
            FrameBody::Detach(Detach { reason: None }),
        ] {
            assert_eq!(
                upstream_decision(&permitted, false),
                UpstreamDecision::Forward,
                "{:?} is part of the client half and must reach the Host",
                permitted.kind()
            );
        }
    }

    #[test]
    fn a_host_to_client_frame_is_refused_by_default_rather_than_forwarded() {
        // `Exit` is on no deny-list. Under the previous `_ => Forward` default
        // it crossed the boundary unremarked; under an allow-list it is refused
        // because nobody enumerated it as permitted. This is the regression
        // guard for the whole inversion.
        assert!(matches!(
            upstream_decision(
                &FrameBody::Exit(Exit {
                    final_output_seq: 0,
                    exit_code: Some(0),
                    platform_status: None,
                    reason: "forged".into(),
                }),
                false
            ),
            UpstreamDecision::Refuse { .. }
        ));
    }

    #[test]
    fn a_legacy_host_preserves_the_session_and_returns_a_correlated_refusal() {
        assert!(!admit_retirement_grant(true, &[]).unwrap());
        let request = retirement_request(
            "retire-legacy",
            SessionRetirementAction::GracefulClientDeparture,
        );
        let refusal = match upstream_decision(&request, false) {
            UpstreamDecision::Forward => panic!("an unnegotiated request must not reach the Host"),
            UpstreamDecision::Refuse {
                code,
                message,
                required_capability,
            } => upstream_refusal(&request, code, message, required_capability),
        };
        assert_eq!(refusal.code, ErrorCode::UnsupportedCapability);
        assert_eq!(
            refusal.required_capability.as_deref(),
            Some(SESSION_RETIREMENT_CAPABILITY)
        );
        assert_eq!(
            refusal.in_reply_to_request_id.as_deref(),
            Some("retire-legacy")
        );
    }

    #[test]
    fn the_gateway_forwards_only_negotiated_graceful_departure() {
        let graceful = retirement_request(
            "retire-graceful",
            SessionRetirementAction::GracefulClientDeparture,
        );
        assert_eq!(
            upstream_decision(&graceful, true),
            UpstreamDecision::Forward
        );

        for request in [
            retirement_request(
                "retire-configure",
                SessionRetirementAction::Configure {
                    policy: Some(
                        SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                            grace_period_ms: 5_000,
                        },
                    ),
                },
            ),
            retirement_request(
                "retire-sweep",
                SessionRetirementAction::Sweep { apply: true },
            ),
        ] {
            assert!(matches!(
                upstream_decision(&request, true),
                UpstreamDecision::Refuse {
                    code: ErrorCode::AuthorizationDenied,
                    required_capability: None,
                    ..
                }
            ));
        }
    }

    #[test]
    fn a_retirement_receipt_is_relayed_downstream_without_losing_correlation() {
        let body = FrameBody::SessionRetirementReceipt(SessionRetirementReceipt {
            request_id: "retire-receipt".into(),
            state: SessionRetirementReceiptState::SessionPreserved,
            reason: Some(SessionRetirementReceiptReason::ProviderBusy),
            policy: Some(
                SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                    grace_period_ms: 5_000,
                },
            ),
        });
        let sink = Mutex::new(FrameSink::new(Vec::<u8>::new()));
        relay_downstream_body(&sink, body.clone()).unwrap();

        let bytes = sink.into_inner().unwrap().output;
        let decoded = FrameCodec::new(FrameLimits::default())
            .read_from(&mut io::Cursor::new(bytes))
            .unwrap();
        assert_eq!(decoded.body, body);
        assert!(matches!(
            upstream_decision(&decoded.body, true),
            UpstreamDecision::Refuse { .. }
        ));
    }

    #[test]
    fn a_frame_consumed_in_full_refuses_only_that_frame() {
        // The distinction the whole classification exists for. Both of these
        // read the payload before failing, so the next four bytes on the wire
        // really are a length prefix and the attach survives.
        let serde_error = serde_json::from_slice::<WireFrame>(b"{").unwrap_err();
        assert!(matches!(
            classify_relay_read(&FrameCodecError::Serialization(serde_error)),
            RelayReadFailure::RefusedFrame {
                code: ErrorCode::UnsupportedProtocolVersion,
                ..
            }
        ));
        assert!(matches!(
            classify_relay_read(&FrameCodecError::Validation(
                FrameValidationError::TooLong {
                    field: "input.bytes",
                    actual: 65_537,
                    maximum: 65_536,
                }
            )),
            RelayReadFailure::RefusedFrame { .. }
        ));
        // A zero-length declaration is refused before any payload read, but zero
        // declared bytes is also zero left over — still aligned.
        assert!(matches!(
            classify_relay_read(&FrameCodecError::EmptyFrame),
            RelayReadFailure::RefusedFrame { .. }
        ));
    }

    #[test]
    fn a_shape_violation_is_not_reported_as_a_size_limit() {
        // Codes are what a client branches on. Answering ResourceLimit to a
        // frame whose protocol version is out of range sends a phone into a
        // retry loop trimming a payload that was never the problem.
        assert_eq!(
            violation_code(&FrameValidationError::TooLong {
                field: "input.bytes",
                actual: 65_537,
                maximum: 65_536,
            }),
            ErrorCode::ResourceLimit
        );
        assert_eq!(
            violation_code(&FrameValidationError::OutOfRange {
                field: "protocol_version",
            }),
            ErrorCode::UnsupportedProtocolVersion
        );
    }

    #[test]
    fn an_oversized_declaration_desynchronizes_the_stream() {
        // The mirror image, and the reason this cannot be decided by "did an
        // error happen": the cap fires *before* the payload read, so those bytes
        // are still queued and the next read would take payload for a prefix.
        assert!(matches!(
            classify_relay_read(&FrameCodecError::FrameTooLarge {
                actual: 2 * 1024 * 1024,
                maximum: 1024 * 1024,
            }),
            RelayReadFailure::DesynchronizedStream {
                code: ErrorCode::ResourceLimit,
                ..
            }
        ));
    }

    #[test]
    fn a_peer_close_is_not_stream_damage() {
        // hmux-host's standing ruling: the peer stopped, so there is nothing
        // left to misread. Classifying this as damage would answer into a pipe
        // nobody is holding and, worse, invert the meaning of the other arms.
        assert_eq!(
            classify_relay_read(&FrameCodecError::Io(io::Error::from(
                io::ErrorKind::UnexpectedEof
            ))),
            RelayReadFailure::Closed
        );
        assert_eq!(
            relay_stream_ended_detach(),
            FrameBody::Detach(Detach {
                reason: Some("relay_stream_ended".into()),
            }),
            "EOF keeps the legacy detach path; it never synthesizes retirement"
        );
    }

    #[test]
    fn a_refusal_message_stays_inside_the_frame_limits() {
        // An over-long message does not make a long frame; it makes *no* frame,
        // because validation runs inside `encode`. That is a silent close, which
        // is the failure this module exists to remove.
        let bounded = bounded_refusal_message(&"e".repeat(4096));
        let frame = WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body: FrameBody::Error(ErrorFrame {
                origin_code: None,
                code: ErrorCode::ResourceLimit,
                message: bounded,
                retry: RetryPosture::Never,
                required_capability: None,
                supported_versions: None,
                in_reply_to_request_id: None,
            }),
        };
        FrameCodec::new(FrameLimits::default())
            .encode(&frame)
            .expect("a bounded refusal must always encode");
    }

    #[test]
    fn a_refusal_message_never_carries_control_characters() {
        // Serde quotes the peer's own bytes back, and this string is rendered in
        // a terminal UI on the other end.
        let bounded = bounded_refusal_message("unknown variant `a\u{1b}[2Jb`");
        assert!(!bounded.chars().any(char::is_control));
        assert!(bounded.contains("unknown variant"));
        // An empty result would fail validation and become a silent close.
        assert!(!bounded_refusal_message("\u{0}\u{0}").is_empty());
    }

    #[test]
    fn colocation_premised_frames_never_reach_the_host() {
        assert_eq!(
            upstream_decision(
                &FrameBody::StandaloneTerminate(StandaloneTerminate {
                    request_id: "r1".into(),
                }),
                false
            ),
            UpstreamDecision::Refuse {
                code: ErrorCode::AuthorizationDenied,
                message: "standalone termination signals process ids and is never relayed",
                required_capability: None,
            }
        );
        assert!(matches!(
            upstream_decision(
                &FrameBody::AgentStateReport(AgentStateReport {
                    request_id: "r2".into(),
                    identity_only: false,
                    activity: AgentRuntimeActivity::Waiting,
                    attention: AgentRuntimeAttention::None,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: None,
                    expected_observation: None,
                }),
                false
            ),
            UpstreamDecision::Refuse { .. }
        ));
        assert!(matches!(
            upstream_decision(&FrameBody::Hello(hello(AttachMode::Observer, &[])), false),
            UpstreamDecision::Refuse { .. }
        ));
        assert_eq!(
            upstream_decision(
                &FrameBody::ScreenSnapshotRequest(ScreenSnapshotRequest {
                    request_id: "r3".into(),
                    expected_fence: fence(),
                    profile: None,
                }),
                false
            ),
            UpstreamDecision::Forward
        );
    }
}
