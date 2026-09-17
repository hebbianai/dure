//! Attaching to a session that is on another machine.
//!
//! This is the join between the two halves of this work. `SshExecDialer`
//! produces a transport; `hmux-client` knows the handshake. Neither is an
//! attach on its own, and until this module existed nothing anywhere turned one
//! into the other — the dialer's output went into tests, and the client's seam
//! was only ever fed an in-memory duplex.
//!
//! What it deliberately does not do is invent a second handshake.
//! [`LocalConnection::attach_over_transport`] runs the same `Hello`, the same
//! `HelloAck` validation and the same colocation gate the local Unix-socket dial
//! runs, because it is literally the same function. A relay that spoke its own
//! handshake would be a second trust model, and every test of the first one
//! would keep passing while it drifted.
//!
//! ## Native artifact boundary
//!
//! `hmux mobile-gateway` now serves the far end, and its forced-command path is
//! covered through a real `sshd` in the CLI tests. This crate separately drives
//! the client half through a real SSH exec channel. Running both halves from
//! the exact packaged Linux artifact on native x86_64 and ARM64 remains a
//! release-gate concern tracked by `hebbian-frontend-1zqa`; unit coverage here
//! must not be presented as that deployment evidence.

use crate::dialer::SshExecDialer;
use crate::error::SshTransportError;
use crate::session::SshExecConfig;
use hmux_client::{
    AttachReplay, AttachedSessionController, AttachedSessionObserver, ClientError,
    ConnectionOptions, LocalAttachRole, LocalConnection, PeerAttestation, SessionFence,
    SessionRetirementReceipt, TerminalSurfaceAccess, TerminalSurfaceAttachment,
};
use hmux_session_protocol::{
    AGENT_IDENTITY_PROJECTION_CAPABILITY, AGENT_RUNTIME_STATE_CAPABILITY,
    EXECUTION_LOCATION_PROJECTION_CAPABILITY, FrameBody, ORDERED_SNAPSHOT_REFRESH_CAPABILITY,
    PROVIDER_CONVERSATION_IDENTITY_CAPABILITY, ReconnectCursor, SCREEN_SNAPSHOT_PROFILE_CAPABILITY,
    SESSION_RETIREMENT_CAPABILITY, WORKING_DIRECTORY_PROJECTION_CAPABILITY,
};
use std::io;
use std::time::{Duration, Instant};

const GATEWAY_DELEGATED_ATTACH: &str = "ssh-gateway-delegated";

/// Everything an attach needs that is not about SSH.
pub struct RemoteAttach {
    /// The session to attach to, in full.
    ///
    /// Every one of the seven fence fields is compared exactly, so this cannot
    /// be a session *name*. A remote client has no way to turn a name into a
    /// fence today: `LocalSessionCatalog` is a local directory scan and there is
    /// no census RPC, which is a named gap in the design document rather than
    /// something this module can paper over. Until one exists the fence is
    /// supplied by the caller, and a wrong one is refused loudly by
    /// `FenceMismatch` rather than silently attaching to a neighbour.
    pub fence: SessionFence,
    /// The bearer credential the Host expects in `Hello`.
    ///
    /// Named `attach_secret` rather than `capability_token` because over a relay
    /// these are not the same value: the real token never crosses SSH, and a
    /// gateway substitutes a scoped, expiring, revocable grant for it. Nothing
    /// mints such a grant yet, so today this is whatever the far end will accept.
    pub attach_secret: String,
    pub role: LocalAttachRole,
    /// The last terminal position the caller actually applied before its SSH
    /// carrier disappeared.
    ///
    /// A relayed reconnect must carry this through the same handshake as a
    /// local reconnect. Dropping it here makes the Host's resume support
    /// unreachable from every real SSH client while lower-level tests pass.
    pub reconnect_cursor: Option<ReconnectCursor>,
}

/// Opens the exec channel and completes the attach handshake over it.
///
/// The two failure vocabularies stay separate deliberately.
/// [`SshTransportError`] means the channel never carried a frame — sshd refused
/// the key, the host key was not pinned, the gateway is not on `PATH`. A
/// [`ClientError`] means the channel worked and the *session* refused. Collapsing
/// them is what makes a phone say "could not connect" to a problem that is
/// nothing of the sort.
pub fn attach_over_ssh(
    ssh: SshExecConfig,
    request: RemoteAttach,
) -> Result<LocalConnection, AttachError> {
    attach_with_options(
        ssh,
        request.fence,
        request.attach_secret,
        ConnectionOptions::new(request.role, None).with_reconnect_cursor(request.reconnect_cursor),
    )
}

fn attach_with_options(
    ssh: SshExecConfig,
    fence: SessionFence,
    attach_secret: String,
    options: ConnectionOptions,
) -> Result<LocalConnection, AttachError> {
    let transport = SshExecDialer::open(ssh).map_err(AttachError::Ssh)?;
    // Asserted rather than assumed, on the shipped path rather than in a test.
    // The value of the whole attestation split is that a relayed attach cannot
    // reach colocation-premised authority, and that property is worth exactly
    // as much as the guarantee that this transport really is non-colocated. It
    // is a `debug_assert` because `relayed` is the only constructor this crate
    // can name, so in a release build the check is provably redundant; what it
    // catches is a future edit that reaches for a different one.
    debug_assert!(
        !transport.attestation().is_colocated(),
        "an SSH exec channel must never present as colocated"
    );

    LocalConnection::attach_over_transport(transport, fence, attach_secret, options)
        .map_err(AttachError::Session)
}

/// Opens a writable remote controller using the same high-level reducer as a
/// local controller attachment.
///
/// SSH authentication is the outer grant. The string carried in the relayed
/// `Hello` is deliberately a non-secret marker: `hmux mobile-gateway` resolves
/// the real capability token on the remote host and never sends it over SSH.
pub fn attach_controller_over_ssh(
    ssh: SshExecConfig,
    fence: SessionFence,
    reconnect_cursor: Option<ReconnectCursor>,
) -> Result<AttachedSessionController, AttachError> {
    const OPTIONAL_CAPABILITIES: &[&str] = &[
        WORKING_DIRECTORY_PROJECTION_CAPABILITY,
        AGENT_IDENTITY_PROJECTION_CAPABILITY,
        AGENT_RUNTIME_STATE_CAPABILITY,
        PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
        ORDERED_SNAPSHOT_REFRESH_CAPABILITY,
        SESSION_RETIREMENT_CAPABILITY,
    ];
    let connection = attach_with_options(
        ssh.with_controller_gateway(),
        fence,
        GATEWAY_DELEGATED_ATTACH.to_string(),
        ConnectionOptions::new(LocalAttachRole::Controller, None)
            .with_optional_capabilities(OPTIONAL_CAPABILITIES)
            .with_reconnect_cursor(reconnect_cursor),
    )?;
    AttachedSessionController::from_connection(connection).map_err(AttachError::Session)
}

/// Opens a read-only remote observer. Every presented pane owns one of these
/// attachments, while focused input is carried by the separate sole controller
/// lease. This keeps sibling panes visible to Host lifetime accounting.
pub fn attach_observer_over_ssh(
    ssh: SshExecConfig,
    fence: SessionFence,
    reconnect_cursor: Option<ReconnectCursor>,
) -> Result<AttachedSessionObserver, AttachError> {
    const OPTIONAL_CAPABILITIES: &[&str] = &[
        WORKING_DIRECTORY_PROJECTION_CAPABILITY,
        EXECUTION_LOCATION_PROJECTION_CAPABILITY,
        AGENT_IDENTITY_PROJECTION_CAPABILITY,
        AGENT_RUNTIME_STATE_CAPABILITY,
        PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
        ORDERED_SNAPSHOT_REFRESH_CAPABILITY,
        SCREEN_SNAPSHOT_PROFILE_CAPABILITY,
    ];
    let connection = attach_with_options(
        ssh.with_controller_gateway(),
        fence,
        GATEWAY_DELEGATED_ATTACH.to_string(),
        ConnectionOptions::new(LocalAttachRole::Observer, None)
            .with_optional_capabilities(OPTIONAL_CAPABILITIES)
            .with_reconnect_cursor(reconnect_cursor),
    )?;
    AttachedSessionObserver::from_connection(connection).map_err(AttachError::Session)
}

/// Opens one bounded Host-owned terminal viewport over the SSH relay.
///
/// Both access postures attach as observers. A writable surface asks the
/// gateway for its controller-capable outer ceiling, but the local Host still
/// admits writes only through the independent semantic input capability.
pub fn attach_terminal_surface_over_ssh(
    ssh: SshExecConfig,
    fence: SessionFence,
    access: TerminalSurfaceAccess,
) -> Result<TerminalSurfaceAttachment, AttachError> {
    let ssh = match access {
        TerminalSurfaceAccess::ReadOnly => ssh,
        TerminalSurfaceAccess::Writer => ssh.with_controller_gateway(),
    };
    let connection = attach_with_options(
        ssh,
        fence,
        GATEWAY_DELEGATED_ATTACH.to_string(),
        TerminalSurfaceAttachment::connection_options(access, None),
    )?;
    TerminalSurfaceAttachment::from_connection(connection).map_err(AttachError::Session)
}

/// Opens the explicit Host-atomic agent-prompt operation over the SSH relay.
/// The gateway mints and consumes the local managed grant; no proof crosses
/// the SSH protocol boundary.
pub fn attach_agent_prompt_over_ssh(
    ssh: SshExecConfig,
    fence: SessionFence,
) -> Result<TerminalSurfaceAttachment, AttachError> {
    let connection = attach_with_options(
        ssh.with_controller_gateway(),
        fence,
        GATEWAY_DELEGATED_ATTACH.to_string(),
        TerminalSurfaceAttachment::agent_prompt_connection_options(None),
    )?;
    TerminalSurfaceAttachment::from_connection(connection).map_err(AttachError::Session)
}

/// Reports an intentional departure for one exact remote standalone generation.
///
/// This opens a fresh observer through the controller-capable gateway only
/// after the product adapter has released the pane's long-lived controller.
/// Observer posture is deliberate: another pane may still own the sole
/// controller lease, and that is exactly when the Host should answer
/// `other_clients_attached` instead of rejecting this lifecycle request with a
/// controller conflict. The supplied fence is carried through both `Hello` and
/// `SessionRetirementRequest`; a replacement Host reusing the same
/// session/workspace names is therefore refused before it can arm retirement.
/// Merely losing either SSH connection never calls this function and remains
/// preserve-only.
pub fn depart_gracefully_over_ssh(
    ssh: SshExecConfig,
    fence: SessionFence,
) -> Result<SessionRetirementReceipt, AttachError> {
    let mut connection = attach_with_options(
        ssh.with_controller_gateway(),
        fence,
        GATEWAY_DELEGATED_ATTACH.to_string(),
        ConnectionOptions::new(LocalAttachRole::Observer, None)
            .with_optional_capabilities(&[SESSION_RETIREMENT_CAPABILITY]),
    )?;
    connection.depart_gracefully().map_err(AttachError::Session)
}

/// Why an attach did not produce a live session.
#[derive(Debug)]
pub enum AttachError {
    /// The bytes never got there.
    Ssh(SshTransportError),
    /// The bytes got there and the session said no.
    Session(ClientError),
}

impl std::fmt::Display for AttachError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ssh(error) => write!(formatter, "{error}"),
            Self::Session(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for AttachError {}

impl AttachError {
    /// A stable code for callers that branch rather than display.
    #[must_use]
    pub fn code(&self) -> &str {
        match self {
            Self::Ssh(error) => error.code(),
            Self::Session(error) => error.code(),
        }
    }
}

/// When [`relay_output`] should stop.
#[derive(Clone, Copy, Debug)]
pub struct OutputBudget {
    /// Stop after this much wall time. `None` runs until the session ends.
    pub duration: Option<Duration>,
    /// Stop after this many output frames. `None` means no limit.
    pub frames: Option<usize>,
}

/// Why the output stream stopped.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputStop {
    /// The budget ran out. The session is still alive.
    BudgetSpent,
    /// The session exited.
    SessionExited,
    /// The far end closed the transport.
    TransportClosed,
}

/// What the caller durably applied before the relay stopped.
///
/// `applied_cursor` advances only after the corresponding terminal bytes have
/// been written and flushed. Persisting [`LocalConnection::reconnect_cursor`]
/// directly is unsafe for resumed attaches because the handshake may have
/// already buffered replay frames the sink has not seen yet.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelayReceipt {
    pub stop: OutputStop,
    pub applied_cursor: ReconnectCursor,
}

/// Writes the session's terminal bytes to `sink` until the budget runs out.
///
/// A fresh attach's initial snapshot goes first, and that ordering is the
/// protocol's, not a preference: `repaint_bytes` is the screen as it stands,
/// and the deltas that follow are relative to it. A resumed attach instead
/// starts from its previously applied cursor and writes only retained deltas.
///
/// Frames that are not terminal bytes are skipped rather than rendered. A
/// `ScreenSnapshot` arriving mid-stream is a repaint the reducer has already
/// validated against the fence, so it replaces what came before; an
/// `AgentRuntimeState` is metadata that would corrupt the screen if written to
/// it.
pub fn relay_output(
    connection: &mut LocalConnection,
    sink: &mut dyn io::Write,
    budget: OutputBudget,
) -> Result<RelayReceipt, ClientError> {
    let terminal_epoch = connection.reconnect_cursor().terminal_epoch;
    let mut applied_cursor = match connection.attach_replay() {
        AttachReplay::Resumed {
            after_output_seq, ..
        } => ReconnectCursor {
            terminal_epoch,
            after_output_seq: *after_output_seq,
        },
        AttachReplay::Snapshot | AttachReplay::SnapshotAfterGap(_) => {
            let snapshot = connection.require_initial_snapshot()?;
            sink.write_all(&snapshot.repaint_bytes)
                .map_err(io_failure)?;
            sink.flush().map_err(io_failure)?;
            ReconnectCursor {
                terminal_epoch,
                after_output_seq: snapshot.sequence_through,
            }
        }
        AttachReplay::TerminalViewportFrame => {
            return Err(ClientError::InconsistentStream {
                reason: "the ANSI SSH relay cannot render a structured terminal-state attach",
            });
        }
    };

    let started = Instant::now();
    let mut frames = 0_usize;
    loop {
        if let Some(limit) = budget.frames {
            if frames >= limit {
                return Ok(RelayReceipt {
                    stop: OutputStop::BudgetSpent,
                    applied_cursor,
                });
            }
        }
        if let Some(limit) = budget.duration {
            let Some(remaining) = limit.checked_sub(started.elapsed()) else {
                return Ok(RelayReceipt {
                    stop: OutputStop::BudgetSpent,
                    applied_cursor,
                });
            };
            // A first-byte poll, not a frame deadline. It is retry-safe by
            // contract -- expiring consumes nothing -- which is what lets the
            // budget be checked between frames without ever tearing one in half.
            // Arming the *completion* deadline this way would poison the
            // connection on an idle session.
            connection.set_read_timeout(Some(remaining.min(POLL_SLICE)))?;
        }

        match connection.read_body() {
            Ok(FrameBody::OutputDelta(delta)) => {
                sink.write_all(&delta.bytes).map_err(io_failure)?;
                sink.flush().map_err(io_failure)?;
                applied_cursor.after_output_seq = delta.output_seq;
                frames += 1;
            }
            Ok(FrameBody::ScreenSnapshot(snapshot)) => {
                sink.write_all(&snapshot.repaint_bytes)
                    .map_err(io_failure)?;
                sink.flush().map_err(io_failure)?;
                applied_cursor.after_output_seq = snapshot.sequence_through;
                frames += 1;
            }
            Ok(FrameBody::Exit(_)) => {
                return Ok(RelayReceipt {
                    stop: OutputStop::SessionExited,
                    applied_cursor,
                });
            }
            // Everything else is protocol traffic, not screen content.
            Ok(_) => {}
            Err(error) if is_idle_poll_timeout(&error) => {
                if budget
                    .duration
                    .is_some_and(|limit| started.elapsed() >= limit)
                {
                    return Ok(RelayReceipt {
                        stop: OutputStop::BudgetSpent,
                        applied_cursor,
                    });
                }
            }
            Err(ClientError::Transport {
                code: "hmux_transport_closed",
                ..
            }) => {
                return Ok(RelayReceipt {
                    stop: OutputStop::TransportClosed,
                    applied_cursor,
                });
            }
            Err(error) => return Err(error),
        }
    }
}

/// How long a single readability poll waits before the budget is re-checked.
///
/// Short enough that a budget expiring during a quiet session is noticed
/// promptly, long enough not to spin. The value only bounds responsiveness, not
/// correctness: a timeout here consumed nothing.
const POLL_SLICE: Duration = Duration::from_millis(200);

/// A quiet session, not a broken one.
///
/// This is the same classification `hmux-cli` makes on its interactive attach,
/// and the transport contract that makes it safe is explicit: a first-byte
/// timeout is retry-safe and leaves the stream usable. Treating it as fatal
/// would end a remote attach every time the agent stopped typing.
fn is_idle_poll_timeout(error: &ClientError) -> bool {
    matches!(
        error,
        ClientError::Io { source, .. } if source.kind() == io::ErrorKind::TimedOut
    )
}

fn io_failure(source: io::Error) -> ClientError {
    ClientError::Io {
        operation: "write Hmux session output",
        source,
    }
}

/// What the transport established about its peer, for display.
///
/// Rendered rather than derived so that the one thing an operator has to be
/// able to see is stated in words: a relayed attach holds no colocation
/// witness, and no amount of successful SSH authentication changes that.
#[must_use]
pub fn describe_attestation(attestation: &PeerAttestation) -> &'static str {
    match attestation {
        PeerAttestation::ColocatedSameUser(_) => {
            "colocated (kernel-verified same user on this machine)"
        }
        PeerAttestation::Relayed => {
            "relayed (sshd authenticated a principal; no colocation witness, so \
             shared_terminal_input, standalone_termination_v1 and agent_state_report are withheld)"
        }
        PeerAttestation::Simulated => "simulated (test transport)",
    }
}
