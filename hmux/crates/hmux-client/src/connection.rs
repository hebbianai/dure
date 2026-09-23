#[cfg(any(unix, windows))]
mod local_attach;
#[cfg(any(unix, windows))]
use local_attach::connect_manifest;

mod handshake_error;
use handshake_error::classify_handshake_failure;

use crate::ClientError;
use crate::error::host_refused;
use crate::transport::AttachedTransport;
use hmux_host::local_discovery::{DiscoveryManifest, LocalEndpointKind};
use hmux_local_platform::peer_attestation::{PeerAttestation, SessionScope};
#[cfg(feature = "terminal-state-stream")]
use hmux_runtime_contract::{
    TERMINAL_DEFAULT_COLORS_CAPABILITY, TERMINAL_DEFAULT_COLORS_PROTOCOL_VERSION,
    TERMINAL_INPUT_INTENT_CAPABILITY, TERMINAL_STATE_BASE_PROTOCOL_MINOR,
    TERMINAL_STATE_BINARY_CAPABILITY, TERMINAL_VIEWPORT_MULTIPART_CAPABILITY,
    TERMINAL_VIEWPORT_MULTIPART_PROTOCOL_VERSION, TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
    TERMINAL_VIEWPORT_WHEEL_CAPABILITY, TERMINAL_VIEWPORT_WHEEL_PROTOCOL_VERSION,
    selected_terminal_base_protocol_minor, terminal_default_colors_permitted,
    terminal_viewport_multipart_permitted, terminal_viewport_wheel_permitted,
};
use hmux_session_protocol::transport::{FrameReader, FrameWriter, TransportInterrupt};
#[cfg(feature = "terminal-state-stream")]
use hmux_session_protocol::{
    AGENT_IDENTITY_PROJECTION_CAPABILITY, AGENT_PROMPT_CAPABILITY, AGENT_RUNTIME_STATE_CAPABILITY,
    AgentIdentityProjection, AgentPromptCapabilitySelection, AgentRuntimeStateProjection,
    LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY, PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
    PROVIDER_CONVERSATION_IDENTITY_CAPABILITY, ProviderConversationIdentityProjection,
    WORKING_DIRECTORY_FRAME_CAPABILITY, WorkingDirectoryProjection,
    select_managed_agent_prompt_capability,
};
use hmux_session_protocol::{
    AGENT_STATE_REPORT_CAPABILITY, AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY, AttachMode,
    DEFAULT_MAX_FRAME_BYTES, Detach, FrameBody, FrameCodec, FrameLimits, Hello, HelloAck,
    LifecycleState, PROTOCOL_V1, ProcessProof, RECONNECT_RESUME_CAPABILITY, ReconnectCursor,
    ReplayGap, STANDALONE_TERMINATION_CAPABILITY, ScreenSnapshot, ScreenSnapshotProfile,
    SessionFence, UNPRESENTED_CREATION_ABANDON_CAPABILITY, VersionRange, WireFrame,
};
use std::collections::VecDeque;
use std::fmt;
#[cfg(feature = "terminal-state-stream")]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(feature = "terminal-state-stream")]
use hmux_session_protocol::Resize;

#[cfg(feature = "terminal-state-stream")]
use terminal_state_protocol::{
    DecodedRecord, ENVELOPE_MAGIC, MAX_ENVELOPE_BYTES, MAX_VIEWPORT_FRAME_PARTS,
    TerminalStateRecord, ViewportFrameAssembler, ViewportFrameAssembly, ViewportFrameProgress,
    decode_record, encode_record_for_minor, terminal_state_record,
};

pub use hmux_session_protocol::SHARED_TERMINAL_INPUT_CAPABILITY;

#[cfg(feature = "terminal-state-stream")]
static TERMINAL_MUTATION_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[cfg(feature = "terminal-state-stream")]
#[derive(Clone, Copy)]
struct SelectedTerminalProtocol {
    base_record_minor: u8,
    viewport_multipart: bool,
    viewport_wheel: bool,
    default_colors: bool,
}

#[cfg(feature = "terminal-state-stream")]
impl SelectedTerminalProtocol {
    fn accepts(self, decoded: &DecodedRecord) -> bool {
        match decoded.record.body.as_ref() {
            Some(terminal_state_record::Body::ViewportFramePart(_)) => {
                let multipart_minor = TERMINAL_VIEWPORT_MULTIPART_PROTOCOL_VERSION.envelope_minor;
                self.viewport_multipart
                    && decoded.metadata.protocol_minor == multipart_minor
                    && decoded.record.schema_minor == u32::from(multipart_minor)
            }
            Some(terminal_state_record::Body::WheelReceipt(_)) => {
                let wheel_minor = TERMINAL_VIEWPORT_WHEEL_PROTOCOL_VERSION.envelope_minor;
                self.viewport_wheel
                    && decoded.metadata.protocol_minor == wheel_minor
                    && decoded.record.schema_minor == u32::from(wheel_minor)
            }
            _ => {
                decoded.metadata.protocol_minor <= self.base_record_minor
                    && decoded.record.schema_minor <= u32::from(self.base_record_minor)
            }
        }
    }
}

const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);

/// Mutable typed Host projections can advance while the terminal viewport
/// worker is preparing its initial binary seed. Keep only the newest one, but
/// cap the number accepted before the seed so a peer cannot extend the attach
/// handshake indefinitely.
#[cfg(feature = "terminal-state-stream")]
const MAX_STRUCTURED_ATTACH_SEMANTIC_PRELUDES: usize = 64;

/// The slowest link on which a legitimate frame is still expected to finish.
///
/// 16 KiB/s is roughly 128 kbit/s — a deliberately poor cellular link rather
/// than a median one, because this number's whole job is to be pessimistic. It
/// is the *only* free parameter in [`FRAME_COMPLETION_TIMEOUT`]: everything else
/// in that derivation is measured or fixed by the protocol.
const MINIMUM_RELAY_THROUGHPUT_BYTES_PER_SECOND: u64 = 16 * 1024;

/// How long a frame may take to finish once its first byte has arrived.
///
/// This bounds something the previous code did not bound at all:
/// `set_read_timeout` only gated time-to-first-byte, so after `poll` reported
/// readable the two `read_exact` calls could block forever. Locally that was
/// invisible, because a small frame is already in the kernel buffer by the
/// time poll fires. Over a link where a 700 KiB snapshot arrives across many
/// segments, a peer that stalls mid-frame hung every bounded one-shot caller
/// indefinitely.
///
/// It shipped at a flat 15s that the design note recorded as a guess. It is now
/// derived, from `hmux-runtime`'s `frame_completion_budget` measurement:
///
/// - A maximum-size frame really is close to `DEFAULT_MAX_FRAME_BYTES`. A
///   4096-row scrollback on a wide terminal produces a 956 KB `ScreenSnapshot`
///   on the wire, so the ceiling is a value that occurs, not a theoretical one.
/// - Transport is not the binding term. That 956 KB frame completes in **11 ms
///   median, 39 ms worst** over a local socket. Fifteen seconds bought three
///   orders of magnitude of headroom against a cost that is already negligible.
/// - A stalled consumer passes through 1:1. Injecting a 250 ms pause mid-frame
///   moved completion to 261 ms median — the stall plus the same 11 ms. So the
///   deadline is governed by how long a reader stops reading and by link
///   bandwidth, and by nothing local.
/// - Which makes 15s the wrong direction. It implied a throughput floor of
///   956 KB / 15 s ≈ 64 KB/s ≈ 510 kbit/s: any relay slower than that would have
///   its **first attach's snapshot** cut off mid-frame and the connection
///   permanently poisoned. That is squarely inside bad-cellular territory — the
///   condition the relay exists to serve. Poisoning a healthy slow link is a
///   worse failure than noticing a wedged peer a minute late, because the
///   client cannot recover from it and the user cannot retry past it.
///
/// So: `DEFAULT_MAX_FRAME_BYTES / MINIMUM_RELAY_THROUGHPUT_BYTES_PER_SECOND`,
/// which is 64 seconds. A blocked read is woken by
/// [`LocalConnection::shutdown`]'s interrupt, so the longer budget does not make
/// teardown or detach any slower — it only delays declaring a peer wedged.
///
/// Still the wrong *shape*, and knowingly so: the frame's length prefix is read
/// before its payload, so the deadline could be `declared_bytes / throughput`
/// and a 200-byte receipt would not inherit a megabyte's budget. That belongs in
/// `drive_read_frame`, where the declared length lives, and is tracked
/// separately. Note that reconnect resume shrinks the exposure meanwhile: after
/// the first attach, a resumed reconnect carries `OutputDelta`s bounded by
/// `max_output_bytes` rather than a snapshot, so the megabyte frame is now a
/// cold-attach event rather than a per-drop one.
const FRAME_COMPLETION_TIMEOUT: Duration =
    Duration::from_secs(DEFAULT_MAX_FRAME_BYTES as u64 / MINIMUM_RELAY_THROUGHPUT_BYTES_PER_SECOND);

/// Which role an attach asks the Host for.
///
/// "Local" throughout this crate's public surface — `LocalConnection`,
/// `LocalWriter`, `LocalAttachRole`, `LocalSession` — means **local to the
/// Host**: the session lives in one Host process, on one machine, and these
/// types speak its protocol. It does not mean local to the client. A phone
/// attaching over SSH uses exactly these types, which is why nothing here may
/// assume the peer shares this kernel; what does depend on that takes a
/// colocation witness by argument. The names predate the relay and a rename is
/// tracked separately.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalAttachRole {
    Observer,
    Controller,
    SharedWriter,
}

#[cfg(feature = "terminal-state-stream")]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum TerminalInputRequest {
    #[default]
    None,
    Full,
    LegacyAgentPromptFallback,
}

/// What an attach asks for, independent of how the bytes get there.
///
/// Public because [`LocalConnection::attach_over_transport`] needs it: a caller
/// supplying its own transport has to describe the attach in the same terms the
/// local dial path uses, or the two would drift.
#[derive(Clone)]
pub struct ConnectionOptions {
    role: LocalAttachRole,
    authorization_proof_reference: Option<String>,
    optional_capabilities: Vec<&'static str>,
    initial_snapshot_profile: Option<ScreenSnapshotProfile>,
    reconnect_cursor: Option<ReconnectCursor>,
    handshake_timeout: Option<Duration>,
    handshake_completion_timeout: Duration,
    handshake_deadline: Option<Instant>,
    enforce_handshake_write_deadline: bool,
    #[cfg(feature = "terminal-state-stream")]
    terminal_viewport_projection: bool,
    #[cfg(feature = "terminal-state-stream")]
    terminal_viewport_wheel: bool,
    #[cfg(feature = "terminal-state-stream")]
    terminal_viewport_multipart: bool,
    #[cfg(feature = "terminal-state-stream")]
    terminal_input: TerminalInputRequest,
    #[cfg(feature = "terminal-state-stream")]
    terminal_default_colors: bool,
    #[cfg(feature = "terminal-state-stream")]
    agent_runtime_state: bool,
}

impl ConnectionOptions {
    #[must_use]
    pub fn new(role: LocalAttachRole, authorization_proof_reference: Option<String>) -> Self {
        Self {
            role,
            authorization_proof_reference,
            optional_capabilities: Vec::new(),
            initial_snapshot_profile: None,
            reconnect_cursor: None,
            handshake_timeout: None,
            handshake_completion_timeout: FRAME_COMPLETION_TIMEOUT,
            handshake_deadline: None,
            enforce_handshake_write_deadline: false,
            #[cfg(feature = "terminal-state-stream")]
            terminal_viewport_projection: false,
            #[cfg(feature = "terminal-state-stream")]
            terminal_viewport_wheel: false,
            #[cfg(feature = "terminal-state-stream")]
            terminal_viewport_multipart: false,
            #[cfg(feature = "terminal-state-stream")]
            terminal_input: TerminalInputRequest::None,
            #[cfg(feature = "terminal-state-stream")]
            terminal_default_colors: false,
            #[cfg(feature = "terminal-state-stream")]
            agent_runtime_state: false,
        }
    }

    #[must_use]
    pub fn with_optional_capabilities(mut self, capabilities: &[&'static str]) -> Self {
        self.optional_capabilities = capabilities.to_vec();
        self
    }

    /// Selects complete, replaceable viewport frames for this connection.
    #[cfg(feature = "terminal-state-stream")]
    #[must_use]
    pub fn with_terminal_viewport_projection(mut self) -> Self {
        self.terminal_viewport_projection = true;
        self
    }

    /// Selects the Host-owned typed agent runtime projection on a structured
    /// connection. Relay adapters call this only when their outer peer asked
    /// for the same capability, so `HelloAck` cannot over-grant it.
    #[cfg(feature = "terminal-state-stream")]
    #[must_use]
    pub fn with_agent_runtime_state(mut self) -> Self {
        self.agent_runtime_state = true;
        self
    }

    /// Requests minor-5 wheel intents in addition to the base viewport.
    #[cfg(feature = "terminal-state-stream")]
    #[must_use]
    pub fn with_terminal_viewport_wheel(mut self) -> Self {
        self.terminal_viewport_projection = true;
        self.terminal_viewport_wheel = true;
        self
    }

    /// Requests multipart viewport frames in addition to the base viewport.
    #[cfg(feature = "terminal-state-stream")]
    #[must_use]
    pub fn with_terminal_viewport_multipart(mut self) -> Self {
        self.terminal_viewport_projection = true;
        self.terminal_viewport_multipart = true;
        self
    }

    /// Requests semantic binary input with the sole structured presentation.
    ///
    /// The capability is relay-safe: connection admission grants write
    /// authority and the terminal epoch fences each record. Neither depends on
    /// a controller lease or peer colocation. Input still requires a viewport,
    /// so the builder selects that complete profile atomically.
    #[cfg(feature = "terminal-state-stream")]
    #[must_use]
    pub fn with_terminal_input_intents(mut self) -> Self {
        self.terminal_viewport_projection = true;
        self.terminal_input = TerminalInputRequest::Full;
        self
    }

    /// Requests generic input only because the former fresh-prompt capability
    /// required it. The resulting connection never exposes ordinary input.
    #[cfg(feature = "terminal-state-stream")]
    #[must_use]
    pub fn with_legacy_agent_prompt_fallback(mut self) -> Self {
        self.terminal_viewport_projection = true;
        if self.terminal_input == TerminalInputRequest::None {
            self.terminal_input = TerminalInputRequest::LegacyAgentPromptFallback;
        }
        self
    }

    /// Requests ordered terminal-default color updates on this writable
    /// structured surface.
    #[cfg(feature = "terminal-state-stream")]
    #[must_use]
    pub fn with_terminal_default_colors(mut self) -> Self {
        self.terminal_viewport_projection = true;
        self.terminal_input = TerminalInputRequest::Full;
        self.terminal_default_colors = true;
        self
    }

    #[must_use]
    pub fn with_initial_snapshot_profile(mut self, profile: Option<ScreenSnapshotProfile>) -> Self {
        self.initial_snapshot_profile = profile;
        self
    }

    /// Bounds the attach handshake. Local transports apply it from dial through
    /// the initial snapshot. A caller-supplied legacy writer that implements
    /// only `write_frame` keeps its existing all-or-nothing Hello admission,
    /// then shares this budget across every handshake read; callers that need
    /// the write itself bounded must use [`Self::with_handshake_deadline`].
    #[must_use]
    pub fn with_handshake_timeout(mut self, timeout: Duration) -> Self {
        self.handshake_timeout = Some(timeout);
        self
    }

    /// Resume this attach after `cursor` instead of redownloading the screen.
    ///
    /// Pass the fence's `terminal_epoch` and the last `output_seq` the caller
    /// actually *applied* — not the last one it received, because a frame that
    /// arrived and was dropped is a frame the Host will now skip.
    ///
    /// Setting it is a request, never an assumption. The Host may answer with a
    /// snapshot anyway (an older Host, a cursor outside the retained window, or
    /// a replay that would have cost more than the snapshot), so a caller must
    /// read [`LocalConnection::attach_replay`] rather than assume its screen
    /// survived. The reply that says bytes were genuinely lost is
    /// [`AttachReplay::SnapshotAfterGap`].
    #[must_use]
    pub fn with_reconnect_cursor(mut self, cursor: Option<ReconnectCursor>) -> Self {
        self.reconnect_cursor = cursor;
        self
    }

    /// Bounds each frame read during the attach handshake. Health probes use a
    /// shorter local-only budget so a peer that sends only a length prefix
    /// cannot stall a whole catalog census indefinitely.
    #[must_use]
    pub fn with_handshake_completion_timeout(mut self, timeout: Duration) -> Self {
        self.handshake_completion_timeout = timeout;
        self
    }

    /// Applies one absolute deadline to Hello admission and every read in the
    /// attach handshake. Unlike a per-frame timeout, later phases consume the
    /// same remaining budget instead of starting a fresh clock. A custom
    /// writer without deadline support is rejected before any Hello bytes are
    /// written.
    #[must_use]
    pub fn with_handshake_deadline(mut self, deadline: Instant) -> Self {
        self.handshake_deadline = Some(deadline);
        self.enforce_handshake_write_deadline = true;
        self
    }

    pub(crate) fn begin_handshake(&mut self) {
        let Some(timeout) = self.handshake_timeout.take() else {
            return;
        };
        let Some(relative_deadline) = Instant::now().checked_add(timeout) else {
            return;
        };
        self.handshake_deadline = Some(
            self.handshake_deadline
                .map_or(relative_deadline, |deadline| {
                    deadline.min(relative_deadline)
                }),
        );
    }
}

#[derive(Clone, Copy)]
struct HandshakeReadBudget {
    completion_timeout: Duration,
    deadline: Option<Instant>,
}

impl HandshakeReadBudget {
    fn first_byte_timeout(self) -> Duration {
        self.remaining()
            .unwrap_or(DEFAULT_HANDSHAKE_TIMEOUT)
            .min(DEFAULT_HANDSHAKE_TIMEOUT)
    }

    fn frame_completion_timeout(self) -> Duration {
        self.remaining()
            .unwrap_or(self.completion_timeout)
            .min(self.completion_timeout)
    }

    fn remaining(self) -> Option<Duration> {
        self.deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
    }
}

/// How the Host seeded this attach: the difference between "you missed
/// nothing", "you missed nothing observable", and "you missed bytes".
///
/// A caller must branch on this. A silent gap in a terminal stream is not a
/// cosmetic defect — the user reads the result as the agent having done
/// something it did not do — so the one case where output was genuinely lost is
/// a distinct variant rather than a flag on a snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AttachReplay {
    /// A canonical screen snapshot, complete through its own
    /// `sequence_through`. Either no cursor was offered, or the Host declined to
    /// resume for a reason that is not a hole in the stream. Nothing the client
    /// could observe was lost; this is what every attach did before resume
    /// existed.
    Snapshot,
    /// The cursor had fallen out of the Host's retained window: output between
    /// the cursor and the snapshot is *gone*, and the snapshot is a recovery
    /// rather than a continuation.
    SnapshotAfterGap(ReplayGap),
    /// The Host served the cursor. Every delta from `after_output_seq + 1`
    /// through `through_output_seq` was replayed in order and is handed to
    /// [`LocalConnection::read_body`] ahead of any live output. No snapshot was
    /// sent and none is needed.
    Resumed {
        after_output_seq: u64,
        through_output_seq: u64,
    },
    /// One complete replaceable viewport frame for this connection. No
    /// terminal history replica or raw ANSI replay accompanies it.
    TerminalViewportFrame,
}

/// The binary records that atomically seeded a structured attach.
#[cfg(feature = "terminal-state-stream")]
#[derive(Clone)]
pub struct InitialTerminalState {
    records: Vec<Vec<u8>>,
    terminal_epoch: String,
    through_output_seq: u64,
    state_revision: u64,
    agent_identity: Option<AgentIdentityProjection>,
    agent_runtime_state: Option<AgentRuntimeStateProjection>,
    provider_conversation_identity: Option<ProviderConversationIdentityProjection>,
    working_directory: Option<WorkingDirectoryProjection>,
}

#[cfg(feature = "terminal-state-stream")]
impl fmt::Debug for InitialTerminalState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InitialTerminalState")
            .field("record_count", &self.records.len())
            .field(
                "encoded_bytes",
                &self.records.iter().map(Vec::len).sum::<usize>(),
            )
            .field("terminal_epoch", &self.terminal_epoch)
            .field("through_output_seq", &self.through_output_seq)
            .field("state_revision", &self.state_revision)
            .field("has_agent_identity", &self.agent_identity.is_some())
            .field(
                "has_agent_runtime_state",
                &self.agent_runtime_state.is_some(),
            )
            .field(
                "has_provider_conversation_identity",
                &self.provider_conversation_identity.is_some(),
            )
            .finish()
    }
}

#[cfg(feature = "terminal-state-stream")]
impl InitialTerminalState {
    pub fn records(&self) -> impl Iterator<Item = &[u8]> {
        self.records.iter().map(Vec::as_slice)
    }

    #[must_use]
    pub fn terminal_epoch(&self) -> &str {
        &self.terminal_epoch
    }

    #[must_use]
    pub fn through_output_seq(&self) -> u64 {
        self.through_output_seq
    }

    #[must_use]
    pub fn state_revision(&self) -> u64 {
        self.state_revision
    }

    /// Host-owned runtime state observed immediately before the binary attach
    /// seed. The connection reducer has already validated its epoch and
    /// ordering boundary.
    #[must_use]
    pub fn agent_runtime_state(&self) -> Option<&AgentRuntimeStateProjection> {
        self.agent_runtime_state.as_ref()
    }

    #[must_use]
    pub fn agent_identity(&self) -> Option<&AgentIdentityProjection> {
        self.agent_identity.as_ref()
    }

    #[must_use]
    pub fn working_directory(&self) -> Option<&WorkingDirectoryProjection> {
        self.working_directory.as_ref()
    }

    /// Host-owned identity observed immediately before the binary attach seed.
    ///
    /// Relays use this typed projection to preserve the original handshake
    /// ordering; callers must not synthesize identity from terminal output.
    #[must_use]
    pub fn provider_conversation_identity(
        &self,
    ) -> Option<&ProviderConversationIdentityProjection> {
        self.provider_conversation_identity.as_ref()
    }
}

/// One post-attach record. Structured connections still carry JSON lifecycle
/// and correlated mutation receipts, but terminal presentation is binary only.
#[cfg(feature = "terminal-state-stream")]
pub enum ConnectionRecord {
    Control(Box<FrameBody>),
    TerminalState(Vec<u8>),
}

#[cfg(feature = "terminal-state-stream")]
impl fmt::Debug for ConnectionRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Control(body) => formatter.debug_tuple("Control").field(body).finish(),
            Self::TerminalState(bytes) => formatter
                .debug_struct("TerminalState")
                .field("encoded_len", &bytes.len())
                .finish(),
        }
    }
}

#[cfg(feature = "terminal-state-stream")]
pub(crate) enum BufferedRecordRead {
    /// No complete carrier payload is buffered and nothing was consumed.
    NotReady,
    /// A reducer-staged semantic control was ready without another carrier
    /// payload being consumed.
    Ready(ConnectionRecord),
    /// Exactly one complete carrier payload was consumed. It may stage a
    /// future semantic control without releasing a record yet.
    Consumed {
        record: Option<ConnectionRecord>,
        payload_bytes: usize,
    },
}

/// An attached Hmux session, one connection's worth.
///
/// "Local" here means local *to the Host*, not to the client — see
/// [`LocalAttachRole`]. The transport underneath may be a Unix socket on this
/// machine or a relay from a phone; what separates them is the attestation, not
/// the type.
pub struct LocalConnection {
    reader: Box<dyn FrameReader>,
    interrupt: Arc<dyn TransportInterrupt>,
    /// What the transport underneath proves about its peer. Operations that
    /// depend on the peer sharing this kernel take a witness obtained from
    /// here, so a relayed connection cannot reach them by accident.
    attestation: PeerAttestation,
    writer: LocalWriter,
    #[cfg(feature = "terminal-state-stream")]
    terminal_projection: Option<TerminalProjectionHandle>,
    #[cfg(feature = "terminal-state-stream")]
    terminal_input_writer: Option<TerminalInputWriterCapability>,
    selected_version: hmux_session_protocol::ProtocolVersion,
    hello_ack: HelloAck,
    initial_snapshot: Option<ScreenSnapshot>,
    #[cfg(feature = "terminal-state-stream")]
    initial_terminal_state: Option<InitialTerminalState>,
    #[cfg(feature = "terminal-state-stream")]
    terminal_protocol: Option<SelectedTerminalProtocol>,
    attach_replay: AttachReplay,
    /// Deltas the Host replayed during the handshake, still owed to the caller.
    ///
    /// They are read eagerly because deciding resume-versus-fallback requires
    /// consuming them, but they are ordinary stream content and must reach the
    /// caller before anything live — so they queue here rather than being
    /// dropped or re-requested.
    replayed: VecDeque<FrameBody>,
    stream: TerminalStreamReducer,
    read_timeout: Option<Duration>,
    completion_timeout: Option<Duration>,
    /// Set once the byte stream is known to be no longer frame-aligned.
    ///
    /// Fail-closed on purpose. A desynchronized length-prefixed stream is a
    /// protocol-confusion primitive, not a degraded-but-usable connection: the
    /// next read would take payload bytes for a length. Refusing is the only
    /// safe answer, and the caller reattaches.
    poisoned: bool,
    detach_started: Arc<AtomicBool>,
    peer_closed: bool,
}

impl fmt::Debug for LocalConnection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut debug = formatter.debug_struct("LocalConnection");
        debug
            .field("hello_ack", &self.hello_ack)
            .field("initial_snapshot", &self.initial_snapshot);
        #[cfg(feature = "terminal-state-stream")]
        debug.field("initial_terminal_state", &self.initial_terminal_state);
        debug
            .field("attach_replay", &self.attach_replay)
            .field("last_output_seq", &self.stream.last_output_seq)
            .field("attestation", &self.attestation)
            .field(
                "detach_started",
                &self.detach_started.load(Ordering::Acquire),
            )
            .field("peer_closed", &self.peer_closed)
            .finish_non_exhaustive()
    }
}

impl LocalConnection {
    pub(crate) fn connect(
        manifest: &DiscoveryManifest,
        options: ConnectionOptions,
    ) -> Result<Self, ClientError> {
        connect_manifest(manifest, options)
    }

    /// Attaches over a transport the caller connected itself.
    ///
    /// This is the seam a relay plugs into: an SSH exec channel, or anything
    /// else that can move bytes. It runs the **same** handshake the local dial
    /// runs — same `Hello`, same `HelloAck` validation, same initial snapshot
    /// handling, same colocation gate on the granted capabilities — by calling
    /// the same function, so the two cannot drift into two trust models.
    ///
    /// It deliberately does not dial. Obtaining a stream stays the dialer's job
    /// (see `UnixSocketDialer::open`, which takes a *path* and connects itself
    /// so that no caller can substitute a socketpair), and a caller-supplied
    /// carrier can only arrive through [`AttachedTransport::relayed`], which has
    /// no way to claim colocation. So a relayed attach is refused the three
    /// privileges whose whole justification is the same-user premise —
    /// `shared_terminal_input`, `standalone_termination_v1`,
    /// `agent_state_report_v1` — regardless of the role it asked for. It is
    /// *not* refused the controller lease: that authority rests on a
    /// gateway-minted grant and is arbitrated by a generation fence, neither of
    /// which colocation was ever what protected.
    ///
    /// `attach_secret` is the bearer credential the Host expects in `Hello`.
    /// Named for what it is rather than `capability_token`, because over a relay
    /// a gateway substitutes a scoped grant for the real token, and that
    /// substitution should be visible at the call site.
    pub fn attach_over_transport(
        transport: AttachedTransport,
        fence: SessionFence,
        attach_secret: String,
        mut options: ConnectionOptions,
    ) -> Result<Self, ClientError> {
        options.begin_handshake();
        complete_attach(transport, fence, attach_secret, None, options)
    }

    #[must_use]
    pub fn writer(&self) -> LocalWriter {
        self.writer.clone()
    }

    /// Returns the projection authority minted when attach capabilities were
    /// validated. Later viewport writes do not re-evaluate presentation state.
    #[cfg(feature = "terminal-state-stream")]
    pub fn terminal_projection_handle(&self) -> Result<TerminalProjectionHandle, ClientError> {
        self.terminal_projection
            .clone()
            .ok_or(ClientError::MissingCapability {
                capability: TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
            })
    }

    /// Returns the optional PTY writer minted at attach. Focus, provider, and
    /// UI state cannot manufacture this capability later.
    #[cfg(feature = "terminal-state-stream")]
    pub fn terminal_input_writer_capability(&self) -> Option<TerminalInputWriterCapability> {
        self.terminal_input_writer.clone()
    }

    /// Returns the structured ingress handles minted by this attach. Each
    /// optional handle reflects the capabilities selected during the handshake
    /// and cannot be added later by presentation state.
    #[cfg(feature = "terminal-state-stream")]
    #[must_use]
    pub fn terminal_upstream_handles(&self) -> TerminalUpstreamHandles {
        TerminalUpstreamHandles {
            projection: self.terminal_projection.clone(),
            input_writer: self.terminal_input_writer.clone(),
        }
    }

    #[must_use]
    pub fn hello_ack(&self) -> &HelloAck {
        &self.hello_ack
    }

    /// The snapshot that seeded this attach, when one did.
    ///
    /// `None` exactly when [`Self::attach_replay`] is [`AttachReplay::Resumed`]
    /// — a resumed attach deliberately has no snapshot, because the caller
    /// already holds the screen it would redraw and downloading it again is the
    /// cost resume exists to avoid.
    ///
    /// It returns `Option` rather than synthesizing an empty snapshot on
    /// resume. Empty `repaint_bytes` is not "no change" to a caller that paints
    /// it — it is a cleared terminal, which is the exact class of silent
    /// corruption this feature must not introduce.
    #[must_use]
    pub fn initial_snapshot(&self) -> Option<&ScreenSnapshot> {
        self.initial_snapshot.as_ref()
    }

    /// Complete binary terminal-state seed selected for this connection.
    #[cfg(feature = "terminal-state-stream")]
    #[must_use]
    pub fn initial_terminal_state(&self) -> Option<&InitialTerminalState> {
        self.initial_terminal_state.as_ref()
    }

    /// The seeding snapshot, for callers whose flow has no other answer.
    ///
    /// An attach that offered no `reconnect_cursor` always has one, so for every
    /// such caller this cannot fail. It returns a `Result` rather than
    /// unwrapping so that adding a cursor to one of those call sites without
    /// also handling [`AttachReplay::Resumed`] is a refusal at run time instead
    /// of a panic — and so no `expect` grows here that a later reader would
    /// have to re-derive the safety of.
    pub fn require_initial_snapshot(&self) -> Result<&ScreenSnapshot, ClientError> {
        self.initial_snapshot
            .as_ref()
            .ok_or(ClientError::InconsistentStream {
                reason: "this attach resumed from a cursor and has no seeding snapshot",
            })
    }

    /// How the Host seeded this attach, and whether anything was lost.
    #[must_use]
    pub fn attach_replay(&self) -> &AttachReplay {
        &self.attach_replay
    }

    /// The cursor to offer on the next attach, given everything this connection
    /// has handed the caller so far.
    ///
    /// Exists so the cursor is derived in one place rather than reassembled by
    /// each caller out of a snapshot sequence plus its own delta bookkeeping —
    /// a cursor that is one delta too low silently re-sends output the user
    /// already read, and one too high silently loses output they never did.
    ///
    /// It advances when a frame is *handed over*, not when it is applied. A
    /// caller that can drop a frame after receiving it — one that renders on
    /// another thread, say — must record its own applied position instead, for
    /// the reason spelled out on
    /// [`ConnectionOptions::with_reconnect_cursor`].
    #[must_use]
    pub fn reconnect_cursor(&self) -> ReconnectCursor {
        ReconnectCursor {
            terminal_epoch: self.hello_ack.actual_fence.terminal_epoch.clone(),
            after_output_seq: self.stream.last_output_seq,
        }
    }

    #[must_use]
    pub fn supports(&self, capability: &str) -> bool {
        self.hello_ack
            .selected_capabilities
            .iter()
            .any(|selected| selected == capability)
    }

    pub(crate) fn last_output_seq(&self) -> u64 {
        self.stream.last_output_seq
    }

    pub fn read_body(&mut self) -> Result<FrameBody, ClientError> {
        self.read_body_optional()?.ok_or_else(transport_closed)
    }

    /// Reads one record from a structured connection without conflating
    /// binary terminal state with JSON lifecycle/receipt control frames.
    #[cfg(feature = "terminal-state-stream")]
    pub fn read_record(&mut self) -> Result<ConnectionRecord, ClientError> {
        self.read_record_optional_with_deadline(None)?
            .ok_or_else(transport_closed)
    }

    #[cfg(feature = "terminal-state-stream")]
    pub fn read_record_optional(&mut self) -> Result<Option<ConnectionRecord>, ClientError> {
        self.read_record_optional_with_deadline(None)
    }

    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn read_record_before(
        &mut self,
        deadline: Instant,
    ) -> Result<ConnectionRecord, ClientError> {
        self.read_record_optional_with_deadline(Some(deadline))?
            .ok_or_else(transport_closed)
    }

    #[cfg(feature = "terminal-state-stream")]
    fn read_record_optional_with_deadline(
        &mut self,
        deadline: Option<Instant>,
    ) -> Result<Option<ConnectionRecord>, ClientError> {
        let Some(terminal_protocol) = self.terminal_protocol else {
            return self
                .read_body_optional_with_deadline(deadline)
                .map(|body| body.map(|body| ConnectionRecord::Control(Box::new(body))));
        };
        if self.poisoned {
            return Err(ClientError::StreamDesynchronized {
                reason: "an earlier frame left this stream misaligned",
            });
        }
        let codec = FrameCodec::new(FrameLimits::default());
        loop {
            if let Some(body) = self.stream.take_ready_semantic_control()? {
                return Ok(Some(ConnectionRecord::Control(Box::new(body))));
            }
            let first_byte_timeout = bounded_read_timeout(deadline, self.read_timeout)?;
            self.reader.wait_readable(first_byte_timeout)?;
            let completion_timeout = bounded_read_timeout(deadline, self.completion_timeout)?;
            let payload = match self.read_one_payload(&codec, completion_timeout)? {
                Some(payload) => payload,
                None => return Ok(None),
            };
            if let Some(record) =
                self.accept_structured_payload(payload, terminal_protocol, &codec)?
            {
                return Ok(Some(record));
            }
        }
    }

    /// Advances at most one reducer step without waiting for carrier bytes.
    /// A consumed payload reports its exact length even when it only stages a
    /// future semantic control and releases no record yet.
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn read_record_if_complete_buffered(
        &mut self,
    ) -> Result<BufferedRecordRead, ClientError> {
        let Some(terminal_protocol) = self.terminal_protocol else {
            return Ok(BufferedRecordRead::NotReady);
        };
        if self.poisoned {
            return Err(ClientError::StreamDesynchronized {
                reason: "an earlier frame left this stream misaligned",
            });
        }
        let codec = FrameCodec::new(FrameLimits::default());
        if let Some(body) = self.stream.take_ready_semantic_control()? {
            return Ok(BufferedRecordRead::Ready(ConnectionRecord::Control(
                Box::new(body),
            )));
        }
        let Some(payload) = self.try_read_one_complete_payload(&codec, self.completion_timeout)?
        else {
            return Ok(BufferedRecordRead::NotReady);
        };
        let payload_bytes = payload.len();
        let record = self.accept_structured_payload(payload, terminal_protocol, &codec)?;
        Ok(BufferedRecordRead::Consumed {
            record,
            payload_bytes,
        })
    }

    #[cfg(feature = "terminal-state-stream")]
    fn accept_structured_payload(
        &mut self,
        payload: Vec<u8>,
        terminal_protocol: SelectedTerminalProtocol,
        codec: &FrameCodec,
    ) -> Result<Option<ConnectionRecord>, ClientError> {
        if payload.starts_with(&ENVELOPE_MAGIC) {
            let decoded = decode_record(&payload)?;
            if !terminal_protocol.accepts(&decoded) {
                return Err(ClientError::InconsistentStream {
                    reason: "terminal-state record kind exceeds its selected protocol minor",
                });
            }
            if decoded.record.terminal_epoch != self.hello_ack.actual_fence.terminal_epoch {
                return Err(ClientError::InconsistentStream {
                    reason: "terminal-state record epoch does not match attach fence",
                });
            }
            if !matches!(
                decoded.record.body,
                Some(
                    terminal_state_record::Body::ViewportFrame(_)
                        | terminal_state_record::Body::ViewportFramePart(_)
                        | terminal_state_record::Body::Event(_)
                        | terminal_state_record::Body::InputReceipt(_)
                        | terminal_state_record::Body::ResizeReceipt(_)
                        | terminal_state_record::Body::WheelReceipt(_)
                )
            ) {
                return Err(ClientError::InconsistentStream {
                    reason: "unsupported terminal record appeared on the viewport stream",
                });
            }
            return Ok(Some(ConnectionRecord::TerminalState(payload)));
        }

        let frame = codec.decode_payload_for_dispatch(&payload)?.into_valid()?;
        if frame.protocol_version != self.selected_version {
            return Err(ClientError::ProtocolVersionMismatch);
        }
        if self.stream.accept_structured_control(&frame.body)? {
            Ok(Some(ConnectionRecord::Control(Box::new(frame.body))))
        } else {
            Ok(None)
        }
    }

    /// Advances the JSON control reducer only after the structured surface's
    /// single viewport assembler has accepted and installed a complete direct
    /// or multipart frame. A part can never call this boundary.
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn accept_complete_terminal_viewport(
        &mut self,
        progress: &ViewportFrameProgress,
    ) -> Result<(), ClientError> {
        self.stream.accept_complete_terminal_viewport(progress)
    }

    pub(crate) fn read_body_before(&mut self, deadline: Instant) -> Result<FrameBody, ClientError> {
        self.read_body_optional_with_deadline(Some(deadline))?
            .ok_or_else(transport_closed)
    }

    pub(crate) fn read_body_optional(&mut self) -> Result<Option<FrameBody>, ClientError> {
        self.read_body_optional_with_deadline(None)
    }

    fn read_body_optional_with_deadline(
        &mut self,
        deadline: Option<Instant>,
    ) -> Result<Option<FrameBody>, ClientError> {
        // Replayed deltas are already validated and already sequenced into the
        // reducer; hand them over before touching the wire so the caller sees
        // one contiguous stream across the drop it is recovering from.
        if let Some(body) = self.replayed.pop_front() {
            return Ok(Some(body));
        }
        if self.poisoned {
            return Err(ClientError::StreamDesynchronized {
                reason: "an earlier frame left this stream misaligned",
            });
        }
        let codec = FrameCodec::new(FrameLimits::default());
        loop {
            // Two deadlines with opposite recovery semantics. This one bounds
            // time-to-first-byte and is retry-safe -- hmux-cli polls on it.
            let first_byte_timeout = bounded_read_timeout(deadline, self.read_timeout)?;
            self.reader.wait_readable(first_byte_timeout)?;
            let completion_timeout = bounded_read_timeout(deadline, self.completion_timeout)?;
            let frame = match self.read_one_frame(&codec, completion_timeout)? {
                Some(frame) => frame,
                None => return Ok(None),
            };
            if frame.protocol_version != self.selected_version {
                return Err(ClientError::ProtocolVersionMismatch);
            }
            if self.stream.accept(&frame.body)? {
                return Ok(Some(frame.body));
            }
        }
    }

    /// Reads one frame under the completion deadline, poisoning the connection
    /// if the stream stops being frame-aligned.
    ///
    /// `Interrupted` deliberately does not poison: a detach is not damage, and
    /// treating it as damage would mark every ordinary disconnect corrupt.
    fn read_one_frame(
        &mut self,
        codec: &FrameCodec,
        completion_timeout: Option<Duration>,
    ) -> Result<Option<WireFrame>, ClientError> {
        let Some(payload) = self.read_one_payload(codec, completion_timeout)? else {
            return Ok(None);
        };
        codec
            .decode_payload_for_dispatch(&payload)?
            .into_valid()
            .map(Some)
            .map_err(ClientError::Protocol)
    }

    fn read_one_payload(
        &mut self,
        codec: &FrameCodec,
        completion_timeout: Option<Duration>,
    ) -> Result<Option<Vec<u8>>, ClientError> {
        self.reader.set_completion_timeout(completion_timeout);
        match self.reader.read_payload(codec) {
            Ok(Some(payload)) => Ok(Some(payload)),
            Ok(None) => {
                self.peer_closed = true;
                Ok(None)
            }
            Err(error) => {
                if error.desynchronizes_stream() {
                    self.poisoned = true;
                }
                Err(ClientError::from(error))
            }
        }
    }

    #[cfg(feature = "terminal-state-stream")]
    fn try_read_one_complete_payload(
        &mut self,
        codec: &FrameCodec,
        completion_timeout: Option<Duration>,
    ) -> Result<Option<Vec<u8>>, ClientError> {
        self.reader.set_completion_timeout(completion_timeout);
        match self.reader.try_read_complete_payload(codec) {
            Ok(payload) => Ok(payload),
            Err(error) => {
                if error.desynchronizes_stream() {
                    self.poisoned = true;
                }
                Err(ClientError::from(error))
            }
        }
    }

    /// Bounds time-to-first-byte for subsequent reads. Retained as a
    /// `Result` so callers do not change; it cannot fail today.
    pub fn set_read_timeout(&mut self, timeout: Option<Duration>) -> Result<(), ClientError> {
        self.read_timeout = timeout;
        Ok(())
    }

    /// Bounds how long one frame may take once it has started.
    ///
    /// Distinct from [`Self::set_read_timeout`], which bounds only the wait
    /// for a frame to begin. Firing this one poisons the connection, because
    /// the bytes already consumed cannot be pushed back — so callers that
    /// tighten it are choosing to fail fast rather than to retry.
    pub fn set_completion_timeout(&mut self, timeout: Option<Duration>) {
        self.completion_timeout = timeout;
    }

    /// What the underlying transport proves about the peer.
    #[must_use]
    pub fn attestation(&self) -> &PeerAttestation {
        &self.attestation
    }

    pub fn detach(&mut self, reason: &'static str) -> Result<(), ClientError> {
        let _ = self.begin_detach(reason)?;
        self.shutdown();
        Ok(())
    }

    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn detach_confirmed(
        &mut self,
        reason: &'static str,
        timeout: Duration,
    ) -> Result<(), ClientError> {
        let _ = self.begin_detach(reason)?;
        if self.peer_closed {
            return Ok(());
        }
        // Keep the read half live. The Host removes this connection's surface
        // before it closes the transport, so clean EOF is the completion proof
        // that a successor geometry proposal cannot overlap this one.
        self.writer.shutdown();
        let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
            ClientError::transport(
                "hmux_detach_deadline_invalid",
                "Hmux detach completion deadline overflowed",
            )
        })?;
        let codec = FrameCodec::new(FrameLimits::default());
        loop {
            self.reader
                .wait_readable(Some(remaining_read_deadline(deadline)?))?;
            let completion_timeout = remaining_read_deadline(deadline)?;
            if self
                .read_one_payload(&codec, Some(completion_timeout))?
                .is_none()
            {
                return Ok(());
            }
        }
    }

    fn begin_detach(&mut self, reason: &'static str) -> Result<bool, ClientError> {
        begin_detach(&self.writer, self.detach_started.as_ref(), reason)
    }

    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn terminal_surface_detach_handle(&self) -> TerminalSurfaceDetachHandle {
        TerminalSurfaceDetachHandle {
            writer: self.writer.clone(),
            started: Arc::clone(&self.detach_started),
        }
    }

    pub fn interrupt_handle(&self) -> Result<ConnectionInterrupt, ClientError> {
        Ok(ConnectionInterrupt {
            inner: Arc::clone(&self.interrupt),
        })
    }

    pub fn shutdown(&self) {
        // Interrupt before closing the write half. On a relay `close_write` is
        // an end-of-stream signal that flushes queued data and can block on a
        // backpressured channel, and this runs from `Drop` -- so waking the
        // reader first is what keeps teardown from stalling.
        self.interrupt.interrupt();
        self.writer.shutdown();
    }
}

fn remaining_read_deadline(deadline: Instant) -> Result<Duration, ClientError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(ClientError::transport(
            "hmux_read_deadline_exceeded",
            "Hmux read did not complete before its absolute deadline",
        ));
    }
    Ok(remaining)
}

fn bounded_read_timeout(
    deadline: Option<Instant>,
    configured: Option<Duration>,
) -> Result<Option<Duration>, ClientError> {
    let remaining = deadline.map(remaining_read_deadline).transpose()?;
    Ok(match (remaining, configured) {
        (Some(remaining), Some(configured)) => Some(remaining.min(configured)),
        (Some(remaining), None) => Some(remaining),
        (None, configured) => configured,
    })
}

impl Drop for LocalConnection {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub struct ConnectionInterrupt {
    inner: Arc<dyn TransportInterrupt>,
}

impl fmt::Debug for ConnectionInterrupt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConnectionInterrupt")
            .finish_non_exhaustive()
    }
}

impl ConnectionInterrupt {
    pub fn interrupt(&self) {
        self.inner.interrupt();
    }
}

/// The write half of an attached session.
///
/// "Local" means local to the Host — see [`LocalAttachRole`]. A relayed writer
/// is this same type; nothing here may assume the bytes originate on this
/// machine.
#[derive(Clone)]
pub struct LocalWriter {
    inner: Arc<Mutex<WriterState>>,
}

/// Cloneable authority to request departure for one exact terminal surface
/// without first taking ownership of its potentially blocked downstream
/// reader. It cannot retire the session or another attachment.
#[cfg(feature = "terminal-state-stream")]
#[derive(Clone, Debug)]
pub struct TerminalSurfaceDetachHandle {
    writer: LocalWriter,
    started: Arc<AtomicBool>,
}

#[cfg(feature = "terminal-state-stream")]
impl TerminalSurfaceDetachHandle {
    pub fn begin_detach(&self) -> Result<bool, ClientError> {
        begin_detach(
            &self.writer,
            self.started.as_ref(),
            "terminal_surface_detach",
        )
    }
}

fn begin_detach(
    writer: &LocalWriter,
    started: &AtomicBool,
    reason: &'static str,
) -> Result<bool, ClientError> {
    if started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(false);
    }
    writer.send(FrameBody::Detach(Detach {
        reason: Some(reason.to_string()),
    }))?;
    Ok(true)
}

/// Attach-validated capability for connection-local projection intents.
///
/// Wheel remains part of this handle because its final sink is selected by
/// the Host terminal actor. It does not grant text, key, paste, or resize
/// input.
#[cfg(feature = "terminal-state-stream")]
#[derive(Clone)]
pub struct TerminalProjectionHandle {
    inner: Arc<Mutex<WriterState>>,
    base_protocol_minor: u8,
    default_colors: bool,
}

/// Attach-validated capability for semantic PTY input.
#[cfg(feature = "terminal-state-stream")]
#[derive(Clone)]
pub struct TerminalInputWriterCapability {
    inner: Arc<Mutex<WriterState>>,
    base_protocol_minor: u8,
    ordinary_input: bool,
    agent_prompt: Option<AgentPromptCapabilitySelection>,
    process_observed_agent_prompt: bool,
}

/// Attach-time structured ingress authority. Projection and semantic PTY input
/// exist only when their independent handles were minted by the handshake.
#[cfg(feature = "terminal-state-stream")]
#[derive(Clone, Debug)]
pub struct TerminalUpstreamHandles {
    projection: Option<TerminalProjectionHandle>,
    input_writer: Option<TerminalInputWriterCapability>,
}

#[cfg(feature = "terminal-state-stream")]
impl fmt::Debug for TerminalProjectionHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalProjectionHandle")
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "terminal-state-stream")]
impl fmt::Debug for TerminalInputWriterCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalInputWriterCapability")
            .finish_non_exhaustive()
    }
}

struct WriterState {
    writer: Box<dyn FrameWriter>,
    selected_version: hmux_session_protocol::ProtocolVersion,
    next_frame_id: u64,
}

impl fmt::Debug for LocalWriter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalWriter")
            .finish_non_exhaustive()
    }
}

impl LocalWriter {
    pub fn send(&self, body: FrameBody) -> Result<(), ClientError> {
        self.send_with_deadline(body, None)
    }

    /// Sends one final canonical geometry request from a structured surface.
    ///
    /// The legacy JSON field remains zero solely for wire compatibility; a
    /// SharedWriter is authorized by its connection and the Host substitutes
    /// its current internal generation. The successor surface-policy frame can
    /// replace this method without reviving controller ownership.
    #[cfg(feature = "terminal-state-stream")]
    pub fn send_terminal_resize(&self, rows: u16, columns: u16) -> Result<String, ClientError> {
        if rows == 0 || columns == 0 {
            return Err(ClientError::transport(
                "hmux_resize_invalid",
                "Hmux terminal dimensions must be non-zero",
            ));
        }
        let request_id = format!(
            "surface_resize_{}_{}",
            std::process::id(),
            TERMINAL_MUTATION_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        self.send(FrameBody::Resize(Resize {
            request_id: request_id.clone(),
            controller_generation: 0,
            rows,
            columns,
        }))?;
        Ok(request_id)
    }

    pub(crate) fn send_before(
        &self,
        body: FrameBody,
        deadline: Instant,
    ) -> Result<(), ClientError> {
        self.send_with_deadline(body, Some(deadline))
    }

    fn send_with_deadline(
        &self,
        body: FrameBody,
        deadline: Option<Instant>,
    ) -> Result<(), ClientError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| ClientError::transport("hmux_writer_poisoned", "Hmux writer failed"))?;
        let frame_id = state.next_frame_id;
        let frame = WireFrame {
            protocol_version: state.selected_version,
            frame_id,
            body,
        };
        // Encoding is deliberately separate from writing. `encode` validates
        // first, so an oversized frame -- a large paste, say -- fails having
        // emitted nothing, and must leave this connection perfectly usable.
        // Only a failed *write* can leave a partial frame on the wire.
        let encoded = FrameCodec::new(FrameLimits::default())
            .encode(&frame)
            .map_err(ClientError::Protocol)?;
        state.writer.write_frame_before(&encoded, deadline)?;
        state.next_frame_id = state.next_frame_id.saturating_add(1);
        Ok(())
    }

    fn shutdown(&self) {
        if let Ok(mut state) = self.inner.lock() {
            let _ = state.writer.close_write();
        }
    }
}

#[cfg(feature = "terminal-state-stream")]
impl TerminalProjectionHandle {
    fn protocol_minor_for(
        &self,
        intent: &terminal_state_protocol::ViewportIntent,
    ) -> Result<u8, ClientError> {
        if matches!(
            intent.intent,
            Some(terminal_state_protocol::viewport_intent::Intent::Wheel(_))
        ) {
            Ok(TERMINAL_VIEWPORT_WHEEL_PROTOCOL_VERSION.envelope_minor)
        } else if matches!(
            intent.intent,
            Some(terminal_state_protocol::viewport_intent::Intent::TerminalDefaultColors(_))
        ) {
            if !self.default_colors {
                return Err(ClientError::MissingCapability {
                    capability: TERMINAL_DEFAULT_COLORS_CAPABILITY,
                });
            }
            Ok(TERMINAL_DEFAULT_COLORS_PROTOCOL_VERSION.envelope_minor)
        } else {
            Ok(self.base_protocol_minor)
        }
    }

    /// Sends one connection-local viewport intent. The Host chooses whether a
    /// wheel targets scrollback or the PTY from its canonical terminal modes.
    pub fn send_viewport_intent(
        &self,
        record_id: u64,
        record: &TerminalStateRecord,
    ) -> Result<(), ClientError> {
        let Some(terminal_state_record::Body::ViewportIntent(intent)) = record.body.as_ref() else {
            return Err(ClientError::transport(
                "hmux_terminal_viewport_intent_required",
                "structured viewport ingress requires a viewport intent",
            ));
        };
        let protocol_minor = self.protocol_minor_for(intent)?;
        let mut record = record.clone();
        record.schema_minor = u32::from(protocol_minor);
        let encoded = encode_record_for_minor(protocol_minor, record_id, &record)?;
        write_terminal_envelope(&self.inner, &encoded)
    }

    /// Forwards a serialized viewport intent after checking its kind-specific
    /// negotiated minor. This is the adapter boundary for browser and relay
    /// clients that construct protobuf records outside Rust.
    pub fn send_viewport_envelope(&self, encoded: &[u8]) -> Result<u64, ClientError> {
        let decoded = decode_record(encoded)?;
        let Some(terminal_state_record::Body::ViewportIntent(intent)) =
            decoded.record.body.as_ref()
        else {
            return Err(ClientError::transport(
                "hmux_terminal_viewport_intent_required",
                "structured viewport ingress requires a viewport intent",
            ));
        };
        self.send_decoded_viewport_envelope(encoded, &decoded, intent)
    }

    fn send_decoded_viewport_envelope(
        &self,
        encoded: &[u8],
        decoded: &terminal_state_protocol::DecodedRecord,
        intent: &terminal_state_protocol::ViewportIntent,
    ) -> Result<u64, ClientError> {
        let protocol_minor = self.protocol_minor_for(intent)?;
        require_exact_terminal_minor(decoded, protocol_minor)?;
        write_terminal_envelope(&self.inner, encoded)?;
        Ok(decoded.metadata.record_id)
    }
}

#[cfg(feature = "terminal-state-stream")]
impl TerminalInputWriterCapability {
    pub(crate) fn agent_prompt_selection(&self) -> Option<AgentPromptCapabilitySelection> {
        self.agent_prompt
    }

    pub(crate) fn supports_process_observed_agent_prompt(&self) -> bool {
        self.process_observed_agent_prompt
    }

    /// Sends semantic input through the writer capability validated at attach.
    pub fn send_input(
        &self,
        record_id: u64,
        record: &TerminalStateRecord,
    ) -> Result<(), ClientError> {
        self.send_input_with_deadline(record_id, record, None)
    }

    pub(crate) fn send_input_before(
        &self,
        record_id: u64,
        record: &TerminalStateRecord,
        deadline: Instant,
    ) -> Result<(), ClientError> {
        self.send_input_with_deadline(record_id, record, Some(deadline))
    }

    fn send_input_with_deadline(
        &self,
        record_id: u64,
        record: &TerminalStateRecord,
        deadline: Option<Instant>,
    ) -> Result<(), ClientError> {
        self.require_input_capability(record)?;
        let mut record = record.clone();
        record.schema_minor = u32::from(self.base_protocol_minor);
        let encoded = encode_record_for_minor(self.base_protocol_minor, record_id, &record)
            .map_err(|error| ClientError::write_not_started(error.to_string()))?;
        write_terminal_envelope_before(&self.inner, &encoded, deadline)
    }

    /// Forwards one serialized semantic input record through this writer.
    pub fn send_input_envelope(&self, encoded: &[u8]) -> Result<u64, ClientError> {
        let decoded = decode_record(encoded)?;
        self.send_decoded_input_envelope(encoded, &decoded)
    }

    fn send_decoded_input_envelope(
        &self,
        encoded: &[u8],
        decoded: &terminal_state_protocol::DecodedRecord,
    ) -> Result<u64, ClientError> {
        require_exact_terminal_minor(decoded, self.base_protocol_minor)?;
        self.require_input_capability(&decoded.record)?;
        write_terminal_envelope(&self.inner, encoded)?;
        Ok(decoded.metadata.record_id)
    }

    fn require_input_capability(&self, record: &TerminalStateRecord) -> Result<(), ClientError> {
        let required = required_input_capability(record)?;
        let available = match required {
            InputCapabilityRequirement::Ordinary => self.ordinary_input,
            InputCapabilityRequirement::FreshAgentPrompt => self.agent_prompt.is_some(),
            InputCapabilityRequirement::TargetedAgentPrompt => {
                self.agent_prompt == Some(AgentPromptCapabilitySelection::Targeted)
            }
            InputCapabilityRequirement::ProcessObservedAgentPrompt => {
                self.agent_prompt == Some(AgentPromptCapabilitySelection::Targeted)
                    && self.process_observed_agent_prompt
            }
            InputCapabilityRequirement::LegacyFreshAgentPrompt => {
                self.agent_prompt == Some(AgentPromptCapabilitySelection::LegacyFresh)
            }
        };
        if !available {
            return Err(ClientError::MissingCapability {
                capability: required.capability(),
            });
        }
        Ok(())
    }
}

#[cfg(feature = "terminal-state-stream")]
impl TerminalUpstreamHandles {
    /// Routes one external structured envelope through the attach-validated
    /// handle for its semantic kind. Presentation state never grants writes.
    pub fn send_envelope(&self, encoded: &[u8]) -> Result<u64, ClientError> {
        let decoded = decode_record(encoded)?;
        match decoded.record.body.as_ref() {
            Some(terminal_state_record::Body::ViewportIntent(intent)) => self
                .projection
                .as_ref()
                .ok_or(ClientError::MissingCapability {
                    capability: TERMINAL_VIEWPORT_PROJECTION_CAPABILITY,
                })?
                .send_decoded_viewport_envelope(encoded, &decoded, intent),
            Some(terminal_state_record::Body::InputIntent(_)) => {
                let required = required_input_capability(&decoded.record)?;
                self.input_writer
                    .as_ref()
                    .ok_or(ClientError::MissingCapability {
                        capability: required.capability(),
                    })?
                    .send_decoded_input_envelope(encoded, &decoded)
            }
            _ => Err(ClientError::transport(
                "hmux_terminal_upstream_record_required",
                "structured upstream accepts only input or viewport intent records",
            )),
        }
    }
}

#[cfg(feature = "terminal-state-stream")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InputCapabilityRequirement {
    Ordinary,
    FreshAgentPrompt,
    TargetedAgentPrompt,
    ProcessObservedAgentPrompt,
    LegacyFreshAgentPrompt,
}

#[cfg(feature = "terminal-state-stream")]
impl InputCapabilityRequirement {
    fn capability(self) -> &'static str {
        match self {
            Self::Ordinary => TERMINAL_INPUT_INTENT_CAPABILITY,
            Self::FreshAgentPrompt | Self::TargetedAgentPrompt => AGENT_PROMPT_CAPABILITY,
            Self::ProcessObservedAgentPrompt => PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY,
            Self::LegacyFreshAgentPrompt => LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY,
        }
    }
}

#[cfg(feature = "terminal-state-stream")]
fn required_input_capability(
    record: &TerminalStateRecord,
) -> Result<InputCapabilityRequirement, ClientError> {
    let Some(terminal_state_record::Body::InputIntent(intent)) = record.body.as_ref() else {
        return Err(ClientError::transport(
            "hmux_terminal_input_record_required",
            "structured upstream accepts only terminal input intents",
        ));
    };
    let requirement = match intent.intent.as_ref() {
        Some(terminal_state_protocol::input_intent::Intent::AgentPrompt(prompt)) => {
            match prompt.target.as_ref() {
                Some(
                    terminal_state_protocol::agent_prompt_input_intent::Target::FreshAgent(_),
                ) => InputCapabilityRequirement::FreshAgentPrompt,
                Some(
                    terminal_state_protocol::agent_prompt_input_intent::Target::ExistingConversation(_),
                ) => InputCapabilityRequirement::TargetedAgentPrompt,
                Some(
                    terminal_state_protocol::agent_prompt_input_intent::Target::ProcessObservedFreshAgent(_),
                ) => InputCapabilityRequirement::ProcessObservedAgentPrompt,
                None => InputCapabilityRequirement::LegacyFreshAgentPrompt,
            }
        }
        _ => InputCapabilityRequirement::Ordinary,
    };
    Ok(requirement)
}

#[cfg(feature = "terminal-state-stream")]
fn require_exact_terminal_minor(
    decoded: &terminal_state_protocol::DecodedRecord,
    permitted_minor: u8,
) -> Result<(), ClientError> {
    if decoded.metadata.protocol_minor != permitted_minor
        || decoded.record.schema_minor != u32::from(permitted_minor)
    {
        return Err(ClientError::transport(
            "hmux_terminal_protocol_minor_unnegotiated",
            "structured terminal record does not use its negotiated kind-specific minor",
        ));
    }
    Ok(())
}

#[cfg(feature = "terminal-state-stream")]
fn write_terminal_envelope(
    inner: &Arc<Mutex<WriterState>>,
    encoded: &[u8],
) -> Result<(), ClientError> {
    write_terminal_envelope_before(inner, encoded, None)
}

#[cfg(feature = "terminal-state-stream")]
fn write_terminal_envelope_before(
    inner: &Arc<Mutex<WriterState>>,
    encoded: &[u8],
    deadline: Option<Instant>,
) -> Result<(), ClientError> {
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(ClientError::write_not_started(
            "terminal input deadline elapsed before writer admission",
        ));
    }
    if encoded.len() > MAX_ENVELOPE_BYTES {
        return Err(ClientError::transport(
            "hmux_terminal_input_too_large",
            "structured terminal input exceeds its bounded envelope",
        ));
    }
    let length = u32::try_from(encoded.len()).map_err(|_| {
        ClientError::transport(
            "hmux_terminal_input_too_large",
            "structured terminal input length exceeds u32",
        )
    })?;
    let mut framed = Vec::with_capacity(encoded.len() + 4);
    framed.extend_from_slice(&length.to_be_bytes());
    framed.extend_from_slice(encoded);

    let mut state = inner
        .lock()
        .map_err(|_| ClientError::transport("hmux_writer_poisoned", "Hmux writer failed"))?;
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(ClientError::write_not_started(
            "terminal input deadline elapsed while waiting for writer admission",
        ));
    }
    state.writer.write_frame_before(&framed, deadline)?;
    state.next_frame_id = state.next_frame_id.saturating_add(1);
    Ok(())
}

#[derive(Debug)]
struct TerminalStreamReducer {
    fence: SessionFence,
    last_output_seq: u64,
    last_agent_identity_observation_seq: Option<u64>,
    last_working_directory_observation_seq: Option<u64>,
    last_agent_runtime_revision: Option<u64>,
    last_provider_conversation_identity_revision: Option<u64>,
    last_provider_conversation_identity: Option<(String, String)>,
    conversation_continuations: bool,
    discard_output_through: Option<u64>,
    discard_agent_runtime_through: Option<u64>,
    discard_provider_conversation_identity_through: Option<u64>,
    #[cfg(feature = "terminal-state-stream")]
    pending_agent_identity: Option<PendingAgentIdentity>,
    #[cfg(feature = "terminal-state-stream")]
    pending_working_directory: Option<PendingWorkingDirectory>,
    #[cfg(feature = "terminal-state-stream")]
    pending_agent_runtime_state: Option<PendingAgentRuntimeState>,
    #[cfg(feature = "terminal-state-stream")]
    pending_provider_conversation_identity: Option<PendingProviderConversationIdentity>,
    #[cfg(feature = "terminal-state-stream")]
    next_pending_semantic_order: u64,
}

#[cfg(feature = "terminal-state-stream")]
#[derive(Debug)]
struct PendingAgentIdentity {
    order: u64,
    identity: AgentIdentityProjection,
}

#[cfg(feature = "terminal-state-stream")]
#[derive(Debug)]
struct PendingWorkingDirectory {
    order: u64,
    projection: WorkingDirectoryProjection,
}

#[cfg(feature = "terminal-state-stream")]
#[derive(Debug)]
struct PendingAgentRuntimeState {
    order: u64,
    state: AgentRuntimeStateProjection,
}

#[cfg(feature = "terminal-state-stream")]
#[derive(Debug)]
struct PendingProviderConversationIdentity {
    order: u64,
    identity: ProviderConversationIdentityProjection,
}

impl TerminalStreamReducer {
    fn new(
        fence: SessionFence,
        sequence_through: u64,
        agent_identity_observation_seq: Option<u64>,
        agent_runtime_revision: Option<u64>,
        provider_conversation_identity_revision: Option<u64>,
        provider_conversation_identity: Option<(String, String)>,
    ) -> Self {
        Self {
            fence,
            last_output_seq: sequence_through,
            last_agent_identity_observation_seq: agent_identity_observation_seq,
            last_working_directory_observation_seq: None,
            last_agent_runtime_revision: agent_runtime_revision,
            last_provider_conversation_identity_revision: provider_conversation_identity_revision,
            last_provider_conversation_identity: provider_conversation_identity,
            conversation_continuations: false,
            discard_output_through: None,
            discard_agent_runtime_through: None,
            discard_provider_conversation_identity_through: None,
            #[cfg(feature = "terminal-state-stream")]
            pending_agent_identity: None,
            #[cfg(feature = "terminal-state-stream")]
            pending_working_directory: None,
            #[cfg(feature = "terminal-state-stream")]
            pending_agent_runtime_state: None,
            #[cfg(feature = "terminal-state-stream")]
            pending_provider_conversation_identity: None,
            #[cfg(feature = "terminal-state-stream")]
            next_pending_semantic_order: 1,
        }
    }

    #[cfg(feature = "terminal-state-stream")]
    fn accept_structured_control(&mut self, body: &FrameBody) -> Result<bool, ClientError> {
        match body {
            FrameBody::AgentIdentity(identity)
                if identity.observed_through_output_seq > self.last_output_seq
                    || self.pending_agent_identity.is_some() =>
            {
                self.stage_agent_identity(identity.clone())?;
                Ok(false)
            }
            FrameBody::WorkingDirectory(projection)
                if projection.observed_through_output_seq > self.last_output_seq
                    || self.pending_working_directory.is_some() =>
            {
                self.stage_working_directory(projection.clone())?;
                Ok(false)
            }
            FrameBody::AgentRuntimeState(state)
                if state.observed_through_output_seq > self.last_output_seq
                    || self.pending_agent_runtime_state.is_some() =>
            {
                self.stage_agent_runtime_state(state.clone())?;
                Ok(false)
            }
            FrameBody::ProviderConversationIdentity(identity)
                if identity.observed_through_output_seq > self.last_output_seq
                    || self.pending_provider_conversation_identity.is_some() =>
            {
                self.stage_provider_conversation_identity(identity.clone())?;
                Ok(false)
            }
            _ => self.accept(body),
        }
    }

    #[cfg(feature = "terminal-state-stream")]
    fn accept_complete_terminal_viewport(
        &mut self,
        progress: &ViewportFrameProgress,
    ) -> Result<(), ClientError> {
        if progress.terminal_epoch != self.fence.terminal_epoch {
            return Err(ClientError::InconsistentStream {
                reason: "terminal viewport frame epoch does not match attach fence",
            });
        }
        if progress.through_output_seq < self.last_output_seq {
            return Err(ClientError::InconsistentStream {
                reason: "terminal viewport frame predates observed output",
            });
        }
        self.last_output_seq = progress.through_output_seq;
        Ok(())
    }

    #[cfg(feature = "terminal-state-stream")]
    fn stage_agent_identity(
        &mut self,
        identity: AgentIdentityProjection,
    ) -> Result<(), ClientError> {
        if identity.terminal_epoch != self.fence.terminal_epoch {
            return Err(ClientError::InconsistentStream {
                reason: "agent identity terminal epoch does not match attach fence",
            });
        }
        if identity.observed_through_output_seq <= self.last_output_seq {
            return Err(ClientError::InconsistentStream {
                reason: "agent identity moved behind its pending viewport",
            });
        }
        if self
            .last_agent_identity_observation_seq
            .is_some_and(|sequence| identity.observed_through_output_seq < sequence)
            || self.pending_agent_identity.as_ref().is_some_and(|pending| {
                identity.observed_through_output_seq < pending.identity.observed_through_output_seq
            })
        {
            return Err(ClientError::InconsistentStream {
                reason: "agent identity output observation moved backward",
            });
        }
        let order = self.take_pending_semantic_order()?;
        self.pending_agent_identity = Some(PendingAgentIdentity { order, identity });
        Ok(())
    }

    #[cfg(feature = "terminal-state-stream")]
    fn stage_working_directory(
        &mut self,
        projection: WorkingDirectoryProjection,
    ) -> Result<(), ClientError> {
        if projection.terminal_epoch != self.fence.terminal_epoch {
            return Err(ClientError::InconsistentStream {
                reason: "working directory terminal epoch does not match attach fence",
            });
        }
        if projection.observed_through_output_seq <= self.last_output_seq {
            return Err(ClientError::InconsistentStream {
                reason: "working directory moved behind its pending viewport",
            });
        }
        if self
            .last_working_directory_observation_seq
            .is_some_and(|sequence| projection.observed_through_output_seq < sequence)
            || self
                .pending_working_directory
                .as_ref()
                .is_some_and(|pending| {
                    projection.observed_through_output_seq
                        < pending.projection.observed_through_output_seq
                })
        {
            return Err(ClientError::InconsistentStream {
                reason: "working directory output observation moved backward",
            });
        }
        let order = self.take_pending_semantic_order()?;
        self.pending_working_directory = Some(PendingWorkingDirectory { order, projection });
        Ok(())
    }

    #[cfg(feature = "terminal-state-stream")]
    fn stage_agent_runtime_state(
        &mut self,
        state: AgentRuntimeStateProjection,
    ) -> Result<(), ClientError> {
        if state.terminal_epoch != self.fence.terminal_epoch {
            return Err(ClientError::InconsistentStream {
                reason: "agent runtime state terminal epoch does not match attach fence",
            });
        }
        if state.observed_through_output_seq <= self.last_output_seq {
            return Err(ClientError::InconsistentStream {
                reason: "agent runtime state moved behind its pending viewport",
            });
        }
        if self
            .last_agent_runtime_revision
            .is_some_and(|revision| state.revision <= revision)
            || self
                .pending_agent_runtime_state
                .as_ref()
                .is_some_and(|pending| state.revision <= pending.state.revision)
        {
            return Err(ClientError::InconsistentStream {
                reason: "agent runtime state revision did not advance",
            });
        }
        if self
            .pending_agent_runtime_state
            .as_ref()
            .is_some_and(|pending| {
                state.observed_through_output_seq < pending.state.observed_through_output_seq
            })
        {
            return Err(ClientError::InconsistentStream {
                reason: "agent runtime state output observation moved backward",
            });
        }
        let order = self.take_pending_semantic_order()?;
        self.pending_agent_runtime_state = Some(PendingAgentRuntimeState { order, state });
        Ok(())
    }

    #[cfg(feature = "terminal-state-stream")]
    fn stage_provider_conversation_identity(
        &mut self,
        identity: ProviderConversationIdentityProjection,
    ) -> Result<(), ClientError> {
        self.fence.ensure_matches(&identity.fence)?;
        if identity.observed_through_output_seq <= self.last_output_seq {
            return Err(ClientError::InconsistentStream {
                reason: "provider conversation identity moved behind its pending viewport",
            });
        }
        self.ensure_provider_conversation_identity(
            &identity.provider_id,
            &identity.conversation_id,
            identity.revision,
        )?;
        if let Some(pending) = self.pending_provider_conversation_identity.as_ref() {
            if pending.identity.provider_id != identity.provider_id
                || (!self.conversation_continuations
                    && pending.identity.conversation_id != identity.conversation_id)
            {
                return Err(ClientError::InconsistentStream {
                    reason: "provider conversation identity changed within one Host generation",
                });
            }
            if identity.revision <= pending.identity.revision {
                return Err(ClientError::InconsistentStream {
                    reason: "provider conversation identity revision did not advance",
                });
            }
            if identity.observed_through_output_seq < pending.identity.observed_through_output_seq {
                return Err(ClientError::InconsistentStream {
                    reason: "provider conversation identity output observation moved backward",
                });
            }
        }
        if self
            .last_provider_conversation_identity_revision
            .is_some_and(|revision| identity.revision <= revision)
        {
            return Err(ClientError::InconsistentStream {
                reason: "provider conversation identity revision did not advance",
            });
        }
        let order = self.take_pending_semantic_order()?;
        self.pending_provider_conversation_identity =
            Some(PendingProviderConversationIdentity { order, identity });
        Ok(())
    }

    #[cfg(feature = "terminal-state-stream")]
    fn take_pending_semantic_order(&mut self) -> Result<u64, ClientError> {
        let order = self.next_pending_semantic_order;
        self.next_pending_semantic_order =
            order
                .checked_add(1)
                .ok_or(ClientError::InconsistentStream {
                    reason: "pending semantic control order overflow",
                })?;
        Ok(order)
    }

    #[cfg(feature = "terminal-state-stream")]
    fn take_ready_semantic_control(&mut self) -> Result<Option<FrameBody>, ClientError> {
        let agent_identity_order = self
            .pending_agent_identity
            .as_ref()
            .filter(|pending| pending.identity.observed_through_output_seq <= self.last_output_seq)
            .map(|pending| pending.order);
        let runtime_order = self
            .pending_agent_runtime_state
            .as_ref()
            .filter(|pending| pending.state.observed_through_output_seq <= self.last_output_seq)
            .map(|pending| pending.order);
        let identity_order = self
            .pending_provider_conversation_identity
            .as_ref()
            .filter(|pending| pending.identity.observed_through_output_seq <= self.last_output_seq)
            .map(|pending| pending.order);
        let working_directory_order = self
            .pending_working_directory
            .as_ref()
            .filter(|pending| {
                pending.projection.observed_through_output_seq <= self.last_output_seq
            })
            .map(|pending| pending.order);
        let ready = [
            agent_identity_order.map(|order| (order, 0_u8)),
            runtime_order.map(|order| (order, 1_u8)),
            identity_order.map(|order| (order, 2_u8)),
            working_directory_order.map(|order| (order, 3_u8)),
        ]
        .into_iter()
        .flatten()
        .min_by_key(|(order, _)| *order);
        let body = match ready.map(|(_, kind)| kind) {
            None => return Ok(None),
            Some(0) => FrameBody::AgentIdentity(
                self.pending_agent_identity
                    .take()
                    .ok_or(ClientError::InconsistentStream {
                        reason: "ready agent identity disappeared",
                    })?
                    .identity,
            ),
            Some(1) => FrameBody::AgentRuntimeState(
                self.pending_agent_runtime_state
                    .take()
                    .ok_or(ClientError::InconsistentStream {
                        reason: "ready agent runtime state disappeared",
                    })?
                    .state,
            ),
            Some(2) => FrameBody::ProviderConversationIdentity(
                self.pending_provider_conversation_identity
                    .take()
                    .ok_or(ClientError::InconsistentStream {
                        reason: "ready provider conversation identity disappeared",
                    })?
                    .identity,
            ),
            Some(3) => FrameBody::WorkingDirectory(
                self.pending_working_directory
                    .take()
                    .ok_or(ClientError::InconsistentStream {
                        reason: "ready working directory disappeared",
                    })?
                    .projection,
            ),
            Some(_) => unreachable!("semantic control kind is bounded by the local table"),
        };
        if !self.accept(&body)? {
            return Err(ClientError::InconsistentStream {
                reason: "pending semantic control was unexpectedly discarded",
            });
        }
        Ok(Some(body))
    }

    fn accept(&mut self, body: &FrameBody) -> Result<bool, ClientError> {
        match body {
            FrameBody::OutputDelta(delta) => {
                if delta.terminal_epoch != self.fence.terminal_epoch {
                    return Err(ClientError::InconsistentStream {
                        reason: "output terminal epoch does not match attach fence",
                    });
                }
                if delta.output_seq <= self.last_output_seq
                    && self
                        .discard_output_through
                        .is_some_and(|sequence| delta.output_seq <= sequence)
                {
                    return Ok(false);
                }
                let expected =
                    self.last_output_seq
                        .checked_add(1)
                        .ok_or(ClientError::InconsistentStream {
                            reason: "output sequence overflow",
                        })?;
                if delta.output_seq != expected {
                    return Err(ClientError::InconsistentStream {
                        reason: "output delta is not contiguous",
                    });
                }
                self.last_output_seq = delta.output_seq;
                self.discard_output_through = None;
            }
            FrameBody::ScreenSnapshot(snapshot) => {
                self.fence.ensure_matches(&snapshot.fence)?;
                if snapshot.sequence_through < self.last_output_seq {
                    // Older Hosts wrote requested snapshots and live deltas
                    // through separate producers. If delta N+1 won that race,
                    // the following snapshot through N is harmlessly stale;
                    // never roll the reducer back or reconnect for it.
                    return Ok(false);
                }
                if snapshot.sequence_through > self.last_output_seq {
                    self.discard_output_through = Some(snapshot.sequence_through);
                }
                self.last_output_seq = snapshot.sequence_through;
                if let Some(identity) = &snapshot.agent_identity {
                    if self
                        .last_agent_identity_observation_seq
                        .is_some_and(|sequence| identity.observed_through_output_seq < sequence)
                    {
                        return Err(ClientError::InconsistentStream {
                            reason: "screen snapshot predates observed agent identity",
                        });
                    }
                    self.last_agent_identity_observation_seq =
                        Some(identity.observed_through_output_seq);
                }
                if let Some(projection) = &snapshot.working_directory {
                    if self
                        .last_working_directory_observation_seq
                        .is_some_and(|sequence| projection.observed_through_output_seq < sequence)
                    {
                        return Err(ClientError::InconsistentStream {
                            reason: "screen snapshot predates observed working directory",
                        });
                    }
                    self.last_working_directory_observation_seq =
                        Some(projection.observed_through_output_seq);
                }
                if let Some(state) = &snapshot.agent_runtime_state {
                    if self
                        .last_agent_runtime_revision
                        .is_some_and(|revision| state.revision < revision)
                    {
                        return Err(ClientError::InconsistentStream {
                            reason: "screen snapshot predates observed agent runtime state",
                        });
                    }
                    if self.last_agent_runtime_revision != Some(state.revision) {
                        self.discard_agent_runtime_through = Some(state.revision);
                    }
                    self.last_agent_runtime_revision = Some(state.revision);
                }
                if let Some(identity) = &snapshot.provider_conversation_identity {
                    self.fence.ensure_matches(&identity.fence)?;
                    self.ensure_provider_conversation_identity(
                        &identity.provider_id,
                        &identity.conversation_id,
                        identity.revision,
                    )?;
                    if self
                        .last_provider_conversation_identity_revision
                        .is_some_and(|revision| identity.revision < revision)
                    {
                        return Err(ClientError::InconsistentStream {
                            reason: "screen snapshot predates observed provider conversation identity",
                        });
                    }
                    if self.last_provider_conversation_identity_revision != Some(identity.revision)
                    {
                        self.discard_provider_conversation_identity_through =
                            Some(identity.revision);
                    }
                    self.last_provider_conversation_identity_revision = Some(identity.revision);
                    self.last_provider_conversation_identity = Some((
                        identity.provider_id.clone(),
                        identity.conversation_id.clone(),
                    ));
                }
            }
            FrameBody::AgentIdentity(identity) => {
                if identity.terminal_epoch != self.fence.terminal_epoch {
                    return Err(ClientError::InconsistentStream {
                        reason: "agent identity terminal epoch does not match attach fence",
                    });
                }
                if identity.observed_through_output_seq > self.last_output_seq {
                    return Err(ClientError::InconsistentStream {
                        reason: "agent identity is ahead of observed output",
                    });
                }
                if self
                    .last_agent_identity_observation_seq
                    .is_some_and(|sequence| identity.observed_through_output_seq < sequence)
                {
                    return Err(ClientError::InconsistentStream {
                        reason: "agent identity output observation moved backward",
                    });
                }
                self.last_agent_identity_observation_seq =
                    Some(identity.observed_through_output_seq);
            }
            FrameBody::WorkingDirectory(projection) => {
                if projection.terminal_epoch != self.fence.terminal_epoch {
                    return Err(ClientError::InconsistentStream {
                        reason: "working directory terminal epoch does not match attach fence",
                    });
                }
                if projection.observed_through_output_seq > self.last_output_seq {
                    return Err(ClientError::InconsistentStream {
                        reason: "working directory is ahead of observed output",
                    });
                }
                if self
                    .last_working_directory_observation_seq
                    .is_some_and(|sequence| projection.observed_through_output_seq < sequence)
                {
                    return Err(ClientError::InconsistentStream {
                        reason: "working directory output observation moved backward",
                    });
                }
                self.last_working_directory_observation_seq =
                    Some(projection.observed_through_output_seq);
            }
            FrameBody::AgentRuntimeState(state) => {
                if state.terminal_epoch != self.fence.terminal_epoch {
                    return Err(ClientError::InconsistentStream {
                        reason: "agent runtime state terminal epoch does not match attach fence",
                    });
                }
                if state.observed_through_output_seq > self.last_output_seq {
                    return Err(ClientError::InconsistentStream {
                        reason: "agent runtime state is ahead of observed output",
                    });
                }
                if self
                    .last_agent_runtime_revision
                    .is_some_and(|revision| state.revision <= revision)
                    && self
                        .discard_agent_runtime_through
                        .is_some_and(|revision| state.revision <= revision)
                {
                    return Ok(false);
                }
                if self
                    .last_agent_runtime_revision
                    .is_some_and(|revision| state.revision <= revision)
                {
                    return Err(ClientError::InconsistentStream {
                        reason: "agent runtime state revision did not advance",
                    });
                }
                self.last_agent_runtime_revision = Some(state.revision);
                self.discard_agent_runtime_through = None;
            }
            FrameBody::ProviderConversationIdentity(identity) => {
                self.fence.ensure_matches(&identity.fence)?;
                if identity.observed_through_output_seq > self.last_output_seq {
                    return Err(ClientError::InconsistentStream {
                        reason: "provider conversation identity is ahead of observed output",
                    });
                }
                if self
                    .last_provider_conversation_identity_revision
                    .is_some_and(|revision| identity.revision <= revision)
                    && self
                        .discard_provider_conversation_identity_through
                        .is_some_and(|revision| identity.revision <= revision)
                {
                    return Ok(false);
                }
                self.ensure_provider_conversation_identity(
                    &identity.provider_id,
                    &identity.conversation_id,
                    identity.revision,
                )?;
                if self
                    .last_provider_conversation_identity_revision
                    .is_some_and(|revision| identity.revision <= revision)
                {
                    return Err(ClientError::InconsistentStream {
                        reason: "provider conversation identity revision did not advance",
                    });
                }
                self.last_provider_conversation_identity_revision = Some(identity.revision);
                self.last_provider_conversation_identity = Some((
                    identity.provider_id.clone(),
                    identity.conversation_id.clone(),
                ));
                self.discard_provider_conversation_identity_through = None;
            }
            FrameBody::ReplayGap(gap) if gap.cursor.terminal_epoch != self.fence.terminal_epoch => {
                return Err(ClientError::InconsistentStream {
                    reason: "replay gap terminal epoch does not match attach fence",
                });
            }
            FrameBody::Exit(exit) => {
                if exit.final_output_seq < self.last_output_seq {
                    return Err(ClientError::InconsistentStream {
                        reason: "exit sequence predates observed output",
                    });
                }
                self.last_output_seq = exit.final_output_seq;
            }
            FrameBody::Error(error) => return Err(host_refused(error.clone())),
            _ => {}
        }
        Ok(true)
    }

    fn ensure_provider_conversation_identity(
        &self,
        provider_id: &str,
        conversation_id: &str,
        revision: u64,
    ) -> Result<(), ClientError> {
        if self
            .last_provider_conversation_identity
            .as_ref()
            .is_some_and(|(current_provider, current_conversation)| {
                current_provider != provider_id
                    || (current_conversation != conversation_id
                        && (!self.conversation_continuations
                            || self
                                .last_provider_conversation_identity_revision
                                .is_none_or(|current| revision <= current)))
            })
        {
            return Err(ClientError::InconsistentStream {
                reason: "provider conversation identity changed within one Host generation",
            });
        }
        Ok(())
    }
}

/// The attach handshake, over whatever transport is already connected.
///
/// Transport-neutral, and deliberately outside the `cfg(unix)` arm that guards
/// [`connect_manifest`]. That placement is the point rather than tidiness: the
/// build this seam exists for — no `local-runtime`, no filesystem socket — has
/// no dialer, and if the handshake lived behind the dialer's `cfg` the seam
/// would be absent on exactly the target it was built to serve.
///
/// The local dial and the public seam both land here, so there is exactly one
/// `Hello`, one `HelloAck` validation, one initial-snapshot rule and one
/// colocation gate. A relay that forked this would be a second trust model that
/// no test of the first one covers.
fn complete_attach(
    transport: AttachedTransport,
    expected_fence: SessionFence,
    attach_secret: String,
    expected_processes: Option<ManifestProcessProofs>,
    options: ConnectionOptions,
) -> Result<LocalConnection, ClientError> {
    let AttachedTransport {
        mut reader,
        mut writer,
        interrupt,
        attestation,
    } = transport;
    let handshake_budget = HandshakeReadBudget {
        completion_timeout: options.handshake_completion_timeout,
        deadline: options.handshake_deadline,
    };

    let capability_profile = attach_capability_profile(&options);
    let codec = FrameCodec::new(FrameLimits::default());
    let hello = codec.encode(&WireFrame {
        protocol_version: PROTOCOL_V1,
        frame_id: 1,
        body: FrameBody::Hello(Hello {
            supported_versions: VersionRange {
                minimum: PROTOCOL_V1,
                maximum: PROTOCOL_V1,
            },
            requested_capabilities: capability_profile.requested.clone(),
            expected_fence: expected_fence.clone(),
            requested_mode: match options.role {
                LocalAttachRole::Controller => AttachMode::Controller,
                LocalAttachRole::Observer | LocalAttachRole::SharedWriter => AttachMode::Observer,
            },
            reconnect_cursor: options.reconnect_cursor.clone(),
            capability_token: attach_secret,
            authorization_proof_reference: options.authorization_proof_reference,
            initial_snapshot_profile: options.initial_snapshot_profile,
        }),
    })?;
    if options.enforce_handshake_write_deadline {
        writer.write_frame_before(&hello, options.handshake_deadline)?;
    } else {
        writer.write_frame(&hello)?;
    }

    let hello_ack_frame =
        read_handshake_frame(reader.as_mut(), &codec, "hello_ack", handshake_budget)?;
    if hello_ack_frame.protocol_version != PROTOCOL_V1 {
        return Err(ClientError::ProtocolVersionMismatch);
    }
    let hello_ack = match hello_ack_frame.body {
        FrameBody::HelloAck(ack) => ack,
        FrameBody::Error(error) => return Err(host_refused(error)),
        other => {
            return Err(ClientError::UnexpectedFrame {
                expected: "hello_ack",
                actual: frame_kind_name(&other),
            });
        }
    };
    validate_hello_ack(
        &expected_fence,
        &capability_profile.required,
        &hello_ack,
        &attestation,
    )?;
    #[cfg(feature = "terminal-state-stream")]
    let agent_prompt = select_managed_agent_prompt_capability(
        AttachMode::Observer,
        true,
        &hello_ack.selected_capabilities,
        &capability_profile.requested,
    );
    #[cfg(feature = "terminal-state-stream")]
    let requested_agent_prompt = capability_profile.requested.iter().any(|capability| {
        matches!(
            capability.as_str(),
            AGENT_PROMPT_CAPABILITY | LEGACY_INITIAL_AGENT_PROMPT_CAPABILITY
        )
    });
    #[cfg(feature = "terminal-state-stream")]
    if requested_agent_prompt && agent_prompt.is_none() {
        return Err(ClientError::MissingCapability {
            capability: AGENT_PROMPT_CAPABILITY,
        });
    }
    #[cfg(feature = "terminal-state-stream")]
    let terminal_protocol = SelectedTerminalProtocol {
        base_record_minor: selected_terminal_base_protocol_minor(&hello_ack.selected_capabilities)
            .unwrap_or(TERMINAL_STATE_BASE_PROTOCOL_MINOR),
        viewport_multipart: terminal_viewport_multipart_permitted(&hello_ack.selected_capabilities),
        viewport_wheel: terminal_viewport_wheel_permitted(&hello_ack.selected_capabilities),
        default_colors: terminal_default_colors_permitted(&hello_ack.selected_capabilities),
    };
    if let Some(expected_processes) = expected_processes.as_ref() {
        validate_manifest_process_proofs(expected_processes, &hello_ack)?;
    }

    let AttachSeed {
        replay,
        initial_snapshot,
        #[cfg(feature = "terminal-state-stream")]
        initial_terminal_state,
        replayed,
        sequence_through,
    } = {
        #[cfg(feature = "terminal-state-stream")]
        {
            if options.terminal_viewport_projection {
                if options.reconnect_cursor.is_some() {
                    return Err(ClientError::InconsistentStream {
                        reason: "structured terminal attach does not use raw output cursors",
                    });
                }
                read_terminal_state_attach_seed(
                    reader.as_mut(),
                    &codec,
                    &expected_fence,
                    &hello_ack,
                    terminal_protocol,
                    handshake_budget,
                )?
            } else {
                read_attach_seed(
                    reader.as_mut(),
                    &codec,
                    &expected_fence,
                    &hello_ack,
                    options.reconnect_cursor.as_ref(),
                    handshake_budget,
                )?
            }
        }
        #[cfg(not(feature = "terminal-state-stream"))]
        {
            read_attach_seed(
                reader.as_mut(),
                &codec,
                &expected_fence,
                &hello_ack,
                options.reconnect_cursor.as_ref(),
                handshake_budget,
            )?
        }
    };

    let selected_version = hello_ack.selected_version;
    #[cfg(feature = "terminal-state-stream")]
    let terminal_input_intents = hello_ack
        .selected_capabilities
        .iter()
        .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY);
    #[cfg(feature = "terminal-state-stream")]
    let process_observed_agent_prompt = hello_ack
        .selected_capabilities
        .iter()
        .any(|capability| capability == PROCESS_OBSERVED_AGENT_PROMPT_CAPABILITY);
    #[cfg(feature = "terminal-state-stream")]
    let terminal_viewport_projection = options.terminal_viewport_projection;
    #[cfg(feature = "terminal-state-stream")]
    let initial_structured_provider_identity = initial_terminal_state
        .as_ref()
        .and_then(InitialTerminalState::provider_conversation_identity);
    #[cfg(feature = "terminal-state-stream")]
    let initial_provider_identity = initial_structured_provider_identity.or_else(|| {
        initial_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.provider_conversation_identity.as_deref())
    });
    #[cfg(not(feature = "terminal-state-stream"))]
    let initial_provider_identity = initial_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.provider_conversation_identity.as_deref());
    #[cfg(feature = "terminal-state-stream")]
    let initial_agent_runtime_revision = initial_terminal_state
        .as_ref()
        .and_then(InitialTerminalState::agent_runtime_state)
        .map(|state| state.revision)
        .or_else(|| {
            initial_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.agent_runtime_state.as_ref())
                .map(|state| state.revision)
        });
    #[cfg(not(feature = "terminal-state-stream"))]
    let initial_agent_runtime_revision = initial_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.agent_runtime_state.as_ref())
        .map(|state| state.revision);
    #[cfg(feature = "terminal-state-stream")]
    let initial_agent_identity_observation_seq = initial_terminal_state
        .as_ref()
        .and_then(InitialTerminalState::agent_identity)
        .map(|identity| identity.observed_through_output_seq)
        .or_else(|| {
            initial_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.agent_identity.as_ref())
                .map(|identity| identity.observed_through_output_seq)
        });
    #[cfg(not(feature = "terminal-state-stream"))]
    let initial_agent_identity_observation_seq = initial_snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.agent_identity.as_ref())
        .map(|identity| identity.observed_through_output_seq);
    let mut stream_reducer = TerminalStreamReducer::new(
        expected_fence,
        sequence_through,
        initial_agent_identity_observation_seq,
        initial_agent_runtime_revision,
        initial_provider_identity.map(|identity| identity.revision),
        initial_provider_identity.map(|identity| {
            (
                identity.provider_id.clone(),
                identity.conversation_id.clone(),
            )
        }),
    );
    stream_reducer.conversation_continuations =
        hello_ack.selected_capabilities.iter().any(|capability| {
            capability == hmux_session_protocol::PROVIDER_CONVERSATION_CONTINUATION_CAPABILITY
        });
    let writer = LocalWriter {
        inner: Arc::new(Mutex::new(WriterState {
            writer,
            selected_version,
            next_frame_id: 2,
        })),
    };
    let detach_started = Arc::new(AtomicBool::new(false));
    #[cfg(feature = "terminal-state-stream")]
    let terminal_projection = terminal_viewport_projection.then(|| TerminalProjectionHandle {
        inner: Arc::clone(&writer.inner),
        base_protocol_minor: terminal_protocol.base_record_minor,
        default_colors: terminal_protocol.default_colors,
    });
    #[cfg(feature = "terminal-state-stream")]
    let terminal_input_writer =
        (terminal_input_intents || agent_prompt.is_some()).then(|| TerminalInputWriterCapability {
            inner: Arc::clone(&writer.inner),
            base_protocol_minor: terminal_protocol.base_record_minor,
            ordinary_input: terminal_input_intents
                && options.terminal_input == TerminalInputRequest::Full,
            agent_prompt,
            process_observed_agent_prompt,
        });
    Ok(LocalConnection {
        reader,
        interrupt,
        attestation,
        writer,
        #[cfg(feature = "terminal-state-stream")]
        terminal_projection,
        #[cfg(feature = "terminal-state-stream")]
        terminal_input_writer,
        selected_version,
        hello_ack,
        initial_snapshot,
        #[cfg(feature = "terminal-state-stream")]
        initial_terminal_state,
        #[cfg(feature = "terminal-state-stream")]
        terminal_protocol: terminal_viewport_projection.then_some(terminal_protocol),
        attach_replay: replay,
        replayed,
        stream: stream_reducer,
        read_timeout: None,
        completion_timeout: Some(FRAME_COMPLETION_TIMEOUT),
        poisoned: false,
        detach_started,
        peer_closed: false,
    })
}

/// What the Host's post-`HelloAck` frames established about where this attach
/// starts.
struct AttachSeed {
    replay: AttachReplay,
    initial_snapshot: Option<ScreenSnapshot>,
    #[cfg(feature = "terminal-state-stream")]
    initial_terminal_state: Option<InitialTerminalState>,
    replayed: VecDeque<FrameBody>,
    /// The output sequence the caller is now current through, whichever way the
    /// Host answered.
    sequence_through: u64,
}

#[cfg(feature = "terminal-state-stream")]
fn read_terminal_state_attach_seed(
    reader: &mut dyn FrameReader,
    codec: &FrameCodec,
    expected_fence: &SessionFence,
    hello_ack: &HelloAck,
    terminal_protocol: SelectedTerminalProtocol,
    budget: HandshakeReadBudget,
) -> Result<AttachSeed, ClientError> {
    let mut assembler = ViewportFrameAssembler::default();
    let mut records = Vec::new();
    let mut agent_identity = None;
    let mut agent_runtime_state = None;
    let mut provider_conversation_identity = None;
    let mut working_directory = None;
    let working_directory_selected = hello_ack
        .selected_capabilities
        .iter()
        .any(|capability| capability == WORKING_DIRECTORY_FRAME_CAPABILITY);
    let agent_runtime_state_selected = hello_ack
        .selected_capabilities
        .iter()
        .any(|capability| capability == AGENT_RUNTIME_STATE_CAPABILITY);
    let agent_identity_selected = hello_ack
        .selected_capabilities
        .iter()
        .any(|capability| capability == AGENT_IDENTITY_PROJECTION_CAPABILITY);
    let provider_identity_selected = hello_ack
        .selected_capabilities
        .iter()
        .any(|capability| capability == PROVIDER_CONVERSATION_IDENTITY_CAPABILITY);
    let mut semantic_preludes = 0usize;
    loop {
        let payload = read_terminal_viewport_attach_payload(reader, codec, budget)?;
        if !payload.starts_with(&ENVELOPE_MAGIC) {
            semantic_preludes = semantic_preludes.saturating_add(1);
            if semantic_preludes > MAX_STRUCTURED_ATTACH_SEMANTIC_PRELUDES {
                return Err(ClientError::InconsistentStream {
                    reason: "terminal viewport attach semantic preludes exceed their bound",
                });
            }
            let frame = codec.decode_payload_for_dispatch(&payload)?.into_valid()?;
            if frame.protocol_version != hello_ack.selected_version {
                return Err(ClientError::ProtocolVersionMismatch);
            }
            match frame.body {
                FrameBody::AgentIdentity(identity) if agent_identity_selected => {
                    if identity.terminal_epoch != expected_fence.terminal_epoch {
                        return Err(ClientError::InconsistentStream {
                            reason: "agent identity terminal epoch does not match attach fence",
                        });
                    }
                    if agent_identity
                        .as_ref()
                        .is_some_and(|current: &AgentIdentityProjection| {
                            identity.observed_through_output_seq
                                < current.observed_through_output_seq
                        })
                    {
                        return Err(ClientError::InconsistentStream {
                            reason: "agent identity observation moved backward during attach",
                        });
                    }
                    agent_identity = Some(identity);
                    continue;
                }
                FrameBody::AgentRuntimeState(state) if agent_runtime_state_selected => {
                    if state.terminal_epoch != expected_fence.terminal_epoch {
                        return Err(ClientError::InconsistentStream {
                            reason: "agent runtime state terminal epoch does not match attach fence",
                        });
                    }
                    if agent_runtime_state.as_ref().is_some_and(
                        |current: &AgentRuntimeStateProjection| state.revision <= current.revision,
                    ) {
                        return Err(ClientError::InconsistentStream {
                            reason: "agent runtime state revision did not advance during attach",
                        });
                    }
                    agent_runtime_state = Some(state);
                    continue;
                }
                FrameBody::WorkingDirectory(projection) if working_directory_selected => {
                    if projection.terminal_epoch != expected_fence.terminal_epoch {
                        return Err(ClientError::InconsistentStream {
                            reason: "working directory terminal epoch does not match attach fence",
                        });
                    }
                    if working_directory.as_ref().is_some_and(
                        |current: &WorkingDirectoryProjection| {
                            projection.observed_through_output_seq
                                < current.observed_through_output_seq
                        },
                    ) {
                        return Err(ClientError::InconsistentStream {
                            reason: "working directory observation moved backward during attach",
                        });
                    }
                    working_directory = Some(projection);
                    continue;
                }
                FrameBody::ProviderConversationIdentity(identity)
                    if provider_identity_selected && provider_conversation_identity.is_none() =>
                {
                    expected_fence.ensure_matches(&identity.fence)?;
                    provider_conversation_identity = Some(identity);
                    continue;
                }
                FrameBody::Error(error) => return Err(host_refused(error)),
                FrameBody::Exit(exit) => {
                    return Err(host_refused(hmux_session_protocol::ErrorFrame {
                        origin_code: None,
                        code: hmux_session_protocol::ErrorCode::SessionExited,
                        message: exit.reason,
                        retry: hmux_session_protocol::RetryPosture::Never,
                        required_capability: None,
                        supported_versions: None,
                        in_reply_to_request_id: None,
                    }));
                }
                other => {
                    return Err(ClientError::UnexpectedFrame {
                        expected: "terminal_viewport_frame",
                        actual: frame_kind_name(&other),
                    });
                }
            }
        }
        if records.len() == MAX_VIEWPORT_FRAME_PARTS {
            return Err(ClientError::InconsistentStream {
                reason: "terminal viewport attach frame exceeds its part bound",
            });
        }
        let decoded = decode_terminal_handshake_payload(
            &payload,
            codec,
            hello_ack.selected_version,
            "terminal_viewport_frame",
        )?;
        if !terminal_protocol.accepts(&decoded) {
            return Err(ClientError::InconsistentStream {
                reason: "terminal viewport record kind exceeds its selected protocol minor",
            });
        }
        if decoded.record.terminal_epoch != expected_fence.terminal_epoch {
            return Err(ClientError::InconsistentStream {
                reason: "terminal viewport frame epoch does not match attach fence",
            });
        }
        let assembly = assembler.push_downstream(decoded);
        records.push(payload);
        let viewport_record = match assembly {
            ViewportFrameAssembly::Pending if records.len() == MAX_VIEWPORT_FRAME_PARTS => {
                return Err(ClientError::InconsistentStream {
                    reason: "terminal viewport attach frame exceeds its part bound",
                });
            }
            ViewportFrameAssembly::Pending => continue,
            ViewportFrameAssembly::Downstream(decoded)
            | ViewportFrameAssembly::Complete(decoded) => decoded.record,
            ViewportFrameAssembly::ResyncRequired(_) => {
                return Err(ClientError::InconsistentStream {
                    reason: "terminal viewport attach frame is incomplete or inconsistent",
                });
            }
        };
        if !matches!(
            viewport_record.body.as_ref(),
            Some(terminal_state_record::Body::ViewportFrame(_))
        ) {
            return Err(ClientError::UnexpectedFrame {
                expected: "terminal_viewport_frame",
                actual: "terminal state non-viewport frame".to_string(),
            });
        }
        if viewport_record.through_output_seq < hello_ack.current_output_seq {
            return Err(ClientError::InconsistentStream {
                reason: "terminal viewport frame predates HelloAck",
            });
        }
        let sequence_through = viewport_record.through_output_seq;
        if provider_conversation_identity
            .as_ref()
            .is_some_and(|identity| identity.observed_through_output_seq > sequence_through)
        {
            return Err(ClientError::InconsistentStream {
                reason: "provider conversation identity is ahead of terminal viewport frame",
            });
        }
        if agent_runtime_state
            .as_ref()
            .is_some_and(|state| state.observed_through_output_seq > sequence_through)
        {
            return Err(ClientError::InconsistentStream {
                reason: "agent runtime state is ahead of terminal viewport frame",
            });
        }
        if agent_identity
            .as_ref()
            .is_some_and(|identity| identity.observed_through_output_seq > sequence_through)
        {
            return Err(ClientError::InconsistentStream {
                reason: "agent identity is ahead of terminal viewport frame",
            });
        }
        if working_directory
            .as_ref()
            .is_some_and(|projection: &WorkingDirectoryProjection| {
                projection.observed_through_output_seq > sequence_through
            })
        {
            return Err(ClientError::InconsistentStream {
                reason: "working directory is ahead of terminal viewport frame",
            });
        }
        return Ok(AttachSeed {
            replay: AttachReplay::TerminalViewportFrame,
            initial_snapshot: None,
            initial_terminal_state: Some(InitialTerminalState {
                records,
                terminal_epoch: viewport_record.terminal_epoch,
                through_output_seq: sequence_through,
                state_revision: viewport_record.state_revision,
                agent_identity,
                agent_runtime_state,
                provider_conversation_identity,
                working_directory,
            }),
            replayed: VecDeque::new(),
            sequence_through,
        });
    }
}

/// Reads the Host's answer to the attach: a snapshot, a gap plus a snapshot, or
/// a resume.
///
/// The three are told apart by frame kind, with one prior decision that no frame
/// can carry: when the offered cursor already equals
/// `HelloAck.current_output_seq` the Host is contractually required to resume
/// with **zero** frames, so reading here at all would block until the session
/// next produced output. See `RECONNECT_RESUME_CAPABILITY` for why that
/// invariant exists instead of a marker frame.
fn read_attach_seed(
    reader: &mut dyn FrameReader,
    codec: &FrameCodec,
    expected_fence: &SessionFence,
    hello_ack: &HelloAck,
    cursor: Option<&ReconnectCursor>,
    budget: HandshakeReadBudget,
) -> Result<AttachSeed, ClientError> {
    let resuming = cursor.filter(|_| {
        hello_ack
            .selected_capabilities
            .iter()
            .any(|selected| selected == RECONNECT_RESUME_CAPABILITY)
    });

    let Some(cursor) = resuming else {
        // No cursor, or a Host that never selected the capability and will
        // therefore answer exactly as it always did.
        let snapshot = read_attach_snapshot(reader, codec, expected_fence, hello_ack, budget)?;
        let sequence_through = snapshot.sequence_through;
        return Ok(AttachSeed {
            replay: AttachReplay::Snapshot,
            initial_snapshot: Some(snapshot),
            #[cfg(feature = "terminal-state-stream")]
            initial_terminal_state: None,
            replayed: VecDeque::new(),
            sequence_through,
        });
    };

    if cursor.after_output_seq > hello_ack.current_output_seq {
        // A cursor AHEAD of the Host is refused here, loudly, at attach.
        //
        // An earlier version resumed it on the reasoning that the Host has no
        // later output to send anyway. That was wrong, and wrong in the worst
        // shape: the Host's own `replay_after` refuses a cursor ahead of it by
        // construction, so it falls back to sending a full snapshot — which
        // this client, believing it had resumed, never reads. The reducer then
        // discards that snapshot as stale and the FIRST live delta fails as
        // non-contiguous. Reproduced against the shipped Host.
        //
        // So the choice is not "refuse" versus "tolerate". It is "refuse at
        // attach" versus "break silently on the first byte of output, in a
        // terminal, where a gap reads as the agent having done something it did
        // not do". A caller that over-counted can retry with no cursor.
        return Err(ClientError::InconsistentStream {
            reason: "reconnect cursor is ahead of the Host",
        });
    }

    if cursor.after_output_seq == hello_ack.current_output_seq {
        // Nothing to replay, and both sides agree on where the stream is.
        return Ok(AttachSeed {
            replay: AttachReplay::Resumed {
                after_output_seq: cursor.after_output_seq,
                through_output_seq: cursor.after_output_seq,
            },
            initial_snapshot: None,
            #[cfg(feature = "terminal-state-stream")]
            initial_terminal_state: None,
            replayed: VecDeque::new(),
            sequence_through: cursor.after_output_seq,
        });
    }

    let first = read_handshake_frame(reader, codec, "screen_snapshot", budget)?;
    if first.protocol_version != hello_ack.selected_version {
        return Err(ClientError::ProtocolVersionMismatch);
    }
    match first.body {
        FrameBody::ScreenSnapshot(snapshot) => {
            validate_attach_snapshot(&snapshot, expected_fence, hello_ack)?;
            let sequence_through = snapshot.sequence_through;
            Ok(AttachSeed {
                replay: AttachReplay::Snapshot,
                initial_snapshot: Some(snapshot),
                #[cfg(feature = "terminal-state-stream")]
                initial_terminal_state: None,
                replayed: VecDeque::new(),
                sequence_through,
            })
        }
        FrameBody::ReplayGap(gap) => {
            if gap.cursor.terminal_epoch != expected_fence.terminal_epoch {
                return Err(ClientError::InconsistentStream {
                    reason: "replay gap terminal epoch does not match attach fence",
                });
            }
            let snapshot = read_attach_snapshot(reader, codec, expected_fence, hello_ack, budget)?;
            let sequence_through = snapshot.sequence_through;
            Ok(AttachSeed {
                replay: AttachReplay::SnapshotAfterGap(gap),
                initial_snapshot: Some(snapshot),
                #[cfg(feature = "terminal-state-stream")]
                initial_terminal_state: None,
                replayed: VecDeque::new(),
                sequence_through,
            })
        }
        FrameBody::OutputDelta(delta) => {
            let mut replayed = VecDeque::new();
            let mut sequence_through = cursor.after_output_seq;
            let mut delta = delta;
            loop {
                if delta.terminal_epoch != expected_fence.terminal_epoch {
                    return Err(ClientError::InconsistentStream {
                        reason: "output terminal epoch does not match attach fence",
                    });
                }
                if delta.output_seq != sequence_through.saturating_add(1) {
                    // The whole promise of resume is that the caller may append
                    // these to what it already holds. A hole here is not a
                    // degraded resume, it is corruption presented as history.
                    return Err(ClientError::InconsistentStream {
                        reason: "replayed output delta is not contiguous",
                    });
                }
                sequence_through = delta.output_seq;
                replayed.push_back(FrameBody::OutputDelta(delta));
                if sequence_through >= hello_ack.current_output_seq {
                    break;
                }
                let next = read_handshake_frame(reader, codec, "output_delta", budget)?;
                if next.protocol_version != hello_ack.selected_version {
                    return Err(ClientError::ProtocolVersionMismatch);
                }
                match next.body {
                    FrameBody::OutputDelta(next_delta) => delta = next_delta,
                    FrameBody::Error(error) => return Err(host_refused(error)),
                    other => {
                        return Err(ClientError::UnexpectedFrame {
                            expected: "output_delta",
                            actual: frame_kind_name(&other),
                        });
                    }
                }
            }
            Ok(AttachSeed {
                replay: AttachReplay::Resumed {
                    after_output_seq: cursor.after_output_seq,
                    through_output_seq: sequence_through,
                },
                initial_snapshot: None,
                #[cfg(feature = "terminal-state-stream")]
                initial_terminal_state: None,
                replayed,
                sequence_through,
            })
        }
        FrameBody::Error(error) => Err(host_refused(error)),
        other => Err(ClientError::UnexpectedFrame {
            expected: "screen_snapshot",
            actual: frame_kind_name(&other),
        }),
    }
}

fn read_attach_snapshot(
    reader: &mut dyn FrameReader,
    codec: &FrameCodec,
    expected_fence: &SessionFence,
    hello_ack: &HelloAck,
    budget: HandshakeReadBudget,
) -> Result<ScreenSnapshot, ClientError> {
    let frame = read_handshake_frame(reader, codec, "screen_snapshot", budget)?;
    if frame.protocol_version != hello_ack.selected_version {
        return Err(ClientError::ProtocolVersionMismatch);
    }
    let snapshot = match frame.body {
        FrameBody::ScreenSnapshot(snapshot) => snapshot,
        FrameBody::Error(error) => return Err(host_refused(error)),
        other => {
            return Err(ClientError::UnexpectedFrame {
                expected: "screen_snapshot",
                actual: frame_kind_name(&other),
            });
        }
    };
    validate_attach_snapshot(&snapshot, expected_fence, hello_ack)?;
    Ok(snapshot)
}

fn validate_attach_snapshot(
    snapshot: &ScreenSnapshot,
    expected_fence: &SessionFence,
    hello_ack: &HelloAck,
) -> Result<(), ClientError> {
    expected_fence.ensure_matches(&snapshot.fence)?;
    if snapshot.sequence_through < hello_ack.current_output_seq {
        return Err(ClientError::InconsistentStream {
            reason: "initial snapshot predates HelloAck",
        });
    }
    Ok(())
}

/// Reads one frame during the handshake, where a silent peer or a stream that
/// is not Hmux at all has to be distinguishable from a protocol error.
///
/// A relay makes both failures ordinary: `ssh` may authenticate and then find
/// no gateway on PATH, or a login rc file may print a banner ahead of the
/// first frame. Reporting either as a closed pipe would leave the operator
/// with nothing to act on.
fn read_handshake_frame(
    reader: &mut dyn FrameReader,
    codec: &FrameCodec,
    expected: &'static str,
    budget: HandshakeReadBudget,
) -> Result<WireFrame, ClientError> {
    reader
        .wait_readable(Some(budget.first_byte_timeout()))
        .map_err(|error| classify_handshake_failure(error, expected))?;
    reader.set_completion_timeout(Some(budget.frame_completion_timeout()));
    match reader.read_frame(codec) {
        Ok(Some(frame)) => frame.into_valid().map_err(ClientError::Protocol),
        Ok(None) => Err(ClientError::UnexpectedFrame {
            expected,
            actual: "closed transport".to_string(),
        }),
        Err(error) => Err(classify_handshake_failure(error, expected)),
    }
}

#[cfg(feature = "terminal-state-stream")]
fn read_terminal_viewport_attach_payload(
    reader: &mut dyn FrameReader,
    codec: &FrameCodec,
    budget: HandshakeReadBudget,
) -> Result<Vec<u8>, ClientError> {
    reader
        .wait_readable(Some(budget.first_byte_timeout()))
        .map_err(|error| classify_handshake_failure(error, "terminal_viewport_frame"))?;
    reader.set_completion_timeout(Some(budget.frame_completion_timeout()));
    match reader.read_payload(codec) {
        Ok(Some(payload)) => Ok(payload),
        Ok(None) => Err(ClientError::TerminalViewportAttachTransportClosed),
        Err(error) => Err(classify_handshake_failure(error, "terminal_viewport_frame")),
    }
}

#[cfg(feature = "terminal-state-stream")]
fn decode_terminal_handshake_payload(
    payload: &[u8],
    codec: &FrameCodec,
    selected_version: hmux_session_protocol::ProtocolVersion,
    expected: &'static str,
) -> Result<DecodedRecord, ClientError> {
    if payload.starts_with(&ENVELOPE_MAGIC) {
        return decode_record(payload).map_err(Into::into);
    }
    let frame = codec.decode_payload_for_dispatch(payload)?.into_valid()?;
    if frame.protocol_version != selected_version {
        return Err(ClientError::ProtocolVersionMismatch);
    }
    match frame.body {
        FrameBody::Error(error) => Err(host_refused(error)),
        FrameBody::Exit(exit) => Err(host_refused(hmux_session_protocol::ErrorFrame {
            origin_code: None,
            code: hmux_session_protocol::ErrorCode::SessionExited,
            message: exit.reason,
            retry: hmux_session_protocol::RetryPosture::Never,
            required_capability: None,
            supported_versions: None,
            in_reply_to_request_id: None,
        })),
        other => Err(ClientError::UnexpectedFrame {
            expected,
            actual: frame_kind_name(&other),
        }),
    }
}

#[cfg(not(any(unix, windows)))]
fn connect_manifest(
    _manifest: &DiscoveryManifest,
    _options: ConnectionOptions,
) -> Result<LocalConnection, ClientError> {
    Err(platform_unsupported())
}

fn required_capabilities(role: LocalAttachRole) -> &'static [&'static str] {
    match role {
        LocalAttachRole::Observer => &["screen_snapshot", "live_output"],
        LocalAttachRole::Controller => &[
            "screen_snapshot",
            "live_output",
            "terminal_input",
            "terminal_resize",
        ],
        LocalAttachRole::SharedWriter => &[
            "screen_snapshot",
            "live_output",
            "terminal_input",
            "terminal_resize",
            SHARED_TERMINAL_INPUT_CAPABILITY,
        ],
    }
}

struct AttachCapabilityProfile {
    requested: Vec<String>,
    required: Vec<&'static str>,
}

fn attach_capability_profile(options: &ConnectionOptions) -> AttachCapabilityProfile {
    #[cfg(feature = "terminal-state-stream")]
    let uses_structured_terminal = options.terminal_viewport_projection;
    #[cfg(not(feature = "terminal-state-stream"))]
    let uses_structured_terminal = false;

    let mut required = if uses_structured_terminal {
        Vec::new()
    } else {
        required_capabilities(options.role).to_vec()
    };
    let resume = options
        .reconnect_cursor
        .is_some()
        .then_some(RECONNECT_RESUME_CAPABILITY);
    let mut requested = if uses_structured_terminal {
        options
            .optional_capabilities
            .iter()
            .copied()
            .chain(resume)
            .map(str::to_string)
            .collect::<Vec<_>>()
    } else {
        requested_capabilities(
            options.role,
            &options.optional_capabilities,
            options.reconnect_cursor.is_some(),
        )
    };

    #[cfg(feature = "terminal-state-stream")]
    if uses_structured_terminal {
        required.push(TERMINAL_STATE_BINARY_CAPABILITY);
        requested.push(TERMINAL_STATE_BINARY_CAPABILITY.to_string());
        required.push(TERMINAL_VIEWPORT_PROJECTION_CAPABILITY);
        requested.push(TERMINAL_VIEWPORT_PROJECTION_CAPABILITY.to_string());
        if options.terminal_viewport_wheel {
            requested.push(TERMINAL_VIEWPORT_WHEEL_CAPABILITY.to_string());
        }
        if options.terminal_viewport_multipart {
            requested.push(TERMINAL_VIEWPORT_MULTIPART_CAPABILITY.to_string());
        }
        if options.terminal_input != TerminalInputRequest::None {
            requested.push(TERMINAL_INPUT_INTENT_CAPABILITY.to_string());
            if options.terminal_input == TerminalInputRequest::Full {
                required.push(TERMINAL_INPUT_INTENT_CAPABILITY);
            }
        }
        if options.terminal_default_colors {
            requested.push(TERMINAL_DEFAULT_COLORS_CAPABILITY.to_string());
        }
        if options.agent_runtime_state {
            requested.push(AGENT_RUNTIME_STATE_CAPABILITY.to_string());
        }
    }

    required.sort_unstable();
    required.dedup();
    requested.sort();
    requested.dedup();
    AttachCapabilityProfile {
        requested,
        required,
    }
}

fn requested_capabilities(
    role: LocalAttachRole,
    optional_capabilities: &[&str],
    reconnect_resume: bool,
) -> Vec<String> {
    // Asked for only when a cursor is actually offered. Selecting it changes the
    // shape of the Host's reply, so requesting it unconditionally would make
    // every plain attach negotiate a mode it never uses.
    let resume = reconnect_resume.then_some(RECONNECT_RESUME_CAPABILITY);
    let mut capabilities = required_capabilities(role)
        .iter()
        .copied()
        .chain(optional_capabilities.iter().copied())
        .chain(resume)
        .map(str::to_string)
        .collect::<Vec<_>>();
    capabilities.sort();
    capabilities.dedup();
    capabilities
}

/// Capabilities the Host has *some* path to granting on the strength of the
/// peer being the same OS user on the same machine, and nothing else.
///
/// Existence of such a path, not universality of it, is the membership rule,
/// because a capability name on the wire does not say which path produced it.
/// `shared_terminal_input` needs only that the Host advertised it and the
/// client asked, in either session class. `standalone_termination_v1` falls out
/// of plain capability intersection. `agent_state_report_v1` is proof-gated for
/// a managed session but proof-less for a standalone one — and it is the same
/// string either way, so it is listed. A standalone Observer that *does* offer
/// a proof is refused outright, so for these there is no second factor to fall
/// back on: the written justification is that a Unix socket peer already proved
/// colocation, and that premise is the whole of their authority.
///
/// `managed_provider_stop_v1` is deliberately absent. It is advertised only by
/// managed Hosts and gated on the adapter-minted proof on every path, so no arm
/// of it rests on this premise. Refusing it here would be a guess dressed as a
/// rule.
///
/// Listing capabilities rather than postures is the point. An earlier draft
/// refused `AuthorizationPosture::StandaloneLocalOwner` and so never fired for
/// managed sessions: the Host computes the shared-writer grant without
/// consulting the session class, so a managed Observer receives PTY writes
/// under `DaemonAuthorizedObserver` on exactly the same premise. What the
/// grants have in common is the premise, not the posture name.
const COLOCATION_PREMISED_CAPABILITIES: &[&str] = &[
    SHARED_TERMINAL_INPUT_CAPABILITY,
    STANDALONE_TERMINATION_CAPABILITY,
    UNPRESENTED_CREATION_ABANDON_CAPABILITY,
    AGENT_STATE_REPORT_CAPABILITY,
    AGENT_STATE_REPORT_COMPLETION_ID_CAPABILITY,
];

/// The scope a colocation witness for this session must carry.
///
/// Derived in one place because the dialer binds the witness with it and the
/// handshake cross-check re-derives it to look the witness up. Two independent
/// constructions that drifted would not fail loudly — they would make every
/// attach look like a witness for someone else's session.
fn session_scope(fence: &SessionFence) -> SessionScope {
    SessionScope::new(
        fence.workspace_id.clone(),
        fence.session_id.clone(),
        fence.host_instance_id.clone(),
    )
}

fn validate_hello_ack(
    expected_fence: &SessionFence,
    required_capabilities: &[&'static str],
    hello_ack: &HelloAck,
    attestation: &PeerAttestation,
) -> Result<(), ClientError> {
    if hello_ack.selected_version != PROTOCOL_V1 {
        return Err(ClientError::ProtocolVersionMismatch);
    }
    expected_fence.ensure_matches(&hello_ack.actual_fence)?;
    for capability in required_capabilities {
        if !hello_ack
            .selected_capabilities
            .iter()
            .any(|selected| selected == capability)
        {
            return Err(ClientError::MissingCapability { capability });
        }
    }
    refuse_authority_without_colocation(expected_fence, hello_ack, attestation)
}

/// Refuses a grant whose authority rests on a premise this transport does not
/// establish.
///
/// Not a posture check on its own, even though the posture is what carries the
/// premise on the wire: a posture confers no capability by itself, and refusing
/// `StandaloneLocalOwner` outright would also refuse a read-only remote
/// observer — the first thing a relay is supposed to deliver, and the thing
/// that stays safe because it authorizes nothing.
///
/// Asks for the witness rather than for [`PeerAttestation::is_colocated`]
/// because this answer authorizes something. A witness taken for another
/// session, or against a Host that has since been replaced, is precisely the
/// stale evidence the scope binding exists to reject.
///
/// Fails closed by construction: the only shipped dialer produces a
/// session-bound colocated attestation, so every caller today reaches the same
/// `Ok` it reached before this check existed.
fn refuse_authority_without_colocation(
    expected_fence: &SessionFence,
    hello_ack: &HelloAck,
    attestation: &PeerAttestation,
) -> Result<(), ClientError> {
    let granted = COLOCATION_PREMISED_CAPABILITIES
        .iter()
        .copied()
        .find(|capability| {
            hello_ack
                .selected_capabilities
                .iter()
                .any(|selected| selected == capability)
        });
    let Some(granted) = granted else {
        return Ok(());
    };
    match attestation.witness_for(&session_scope(expected_fence)) {
        Ok(_) => Ok(()),
        Err(error) => Err(ClientError::transport(
            "hmux_uncolocated_authority",
            format!(
                "Hmux Host granted {granted}, which rests on the peer being the same user on the same machine: {error}"
            ),
        )),
    }
}

struct AttachContext {
    endpoint: hmux_host::local_discovery::LocalEndpoint,
    capability_token: String,
    expected_fence: SessionFence,
    expected_processes: ManifestProcessProofs,
    exited: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ManifestProcessProofs {
    host: ProcessProof,
    provider: Option<ProcessProof>,
}

fn validate_manifest_process_proofs(
    expected: &ManifestProcessProofs,
    hello_ack: &HelloAck,
) -> Result<(), ClientError> {
    // Provider exit commits in Host memory before the exited manifest is
    // published. Accept only that authenticated, monotonic transition.
    let provider_matches = hello_ack.provider_process == expected.provider
        || (expected.provider.is_some()
            && hello_ack.provider_process.is_none()
            && hello_ack.lifecycle == LifecycleState::Exited);
    if hello_ack.host_process != expected.host || !provider_matches {
        return Err(ClientError::transport(
            "hmux_manifest_process_mismatch",
            "authenticated Host process proofs do not match local discovery",
        ));
    }
    Ok(())
}

fn manifest_attach_context(manifest: &DiscoveryManifest) -> Result<AttachContext, ClientError> {
    match manifest {
        DiscoveryManifest::Ready(ready) => Ok(AttachContext {
            endpoint: ready.endpoint.clone(),
            capability_token: ready.capability_token.clone(),
            expected_fence: SessionFence {
                workspace_id: ready.common.lifetime.workspace_id.clone(),
                session_id: ready.common.lifetime.session_id.clone(),
                runner_principal: ready.common.lifetime.runner_principal.clone(),
                runner_instance: ready.common.lifetime.runner_instance.clone(),
                channel_epoch: ready.common.lifetime.channel_epoch,
                host_instance_id: ready.common.host_instance_id.clone(),
                terminal_epoch: ready.terminal_epoch.clone(),
            },
            expected_processes: ManifestProcessProofs {
                host: ready.common.host_process.clone(),
                provider: Some(ready.provider_process.clone()),
            },
            exited: false,
        }),
        DiscoveryManifest::Exited(exited) => Ok(AttachContext {
            endpoint: exited.endpoint.clone(),
            capability_token: exited.capability_token.clone(),
            expected_fence: exited.tombstone.fence.clone(),
            expected_processes: ManifestProcessProofs {
                host: exited.common.host_process.clone(),
                // The tombstone retains the predecessor proof for audit and
                // liveness checks, but an exited Host has no current provider.
                provider: None,
            },
            exited: true,
        }),
        DiscoveryManifest::Starting(_) => Err(ClientError::transport(
            "hmux_host_starting",
            "Hmux Host is not ready for attach",
        )),
    }
}

fn frame_kind_name(body: &FrameBody) -> String {
    format!("{:?}", body.kind()).to_lowercase()
}

fn endpoint_kind_name(kind: LocalEndpointKind) -> &'static str {
    match kind {
        LocalEndpointKind::UnixSocket => "unix_socket",
        LocalEndpointKind::WindowsNamedPipe => "windows_named_pipe",
    }
}

fn transport_closed() -> ClientError {
    ClientError::transport("hmux_transport_closed", "Hmux transport closed")
}

#[cfg(not(any(unix, windows)))]
fn platform_unsupported() -> ClientError {
    ClientError::PlatformTransportUnsupported
}

#[cfg(test)]
mod tests;
