//! Dialers: how a client obtains a byte stream **and the proof of what that
//! stream establishes**, together, as one value.
//!
//! Keeping them together is the whole point. A `UnixStream` silently carries
//! four separate guarantees, and only one of them — that the peer shares this
//! kernel — is what makes pids, `kill(-pgid)` and `/proc` meaningful. Handing
//! callers a bare stream would let a relayed connection reach code written on
//! the assumption of a local one, and the failure mode is not a compile error
//! but signalling the wrong machine's process table.
//!
//! So a dialer returns an [`AttachedTransport`]: the halves needed to speak the
//! protocol, plus a `PeerAttestation` describing what was actually proven.
//!
//! # Supplying a transport from outside this crate
//!
//! [`AttachedTransport::relayed`] is the public seam an SSH relay or a mobile
//! client builds on, and it is paired with
//! [`LocalConnection::attach_over_transport`](crate::LocalConnection::attach_over_transport).
//! The trait vocabulary needed to implement one is re-exported here, so writing
//! a transport does not require naming `hmux-host` directly.

// Shipped platform dialers are the only code that can mint a colocation
// witness. Local endpoint addresses are unreachable from a phone, so a build
// without the local runtime carries the seam without either implementation.
#[cfg(all(unix, feature = "local-runtime"))]
pub mod unix_socket;
#[cfg(all(windows, feature = "local-runtime"))]
pub mod windows_named_pipe;

use crate::error::ClientError;
// Imported under the same condition as the constructor that takes one: a build
// with no local dialer can never obtain a witness, so naming the type there
// would be an unused import rather than a missing capability.
#[cfg(any(
    all(unix, feature = "local-runtime"),
    all(windows, feature = "local-runtime")
))]
use hmux_local_platform::peer_attestation::ColocatedSameUserPeer;
use hmux_local_platform::peer_attestation::{PeerAttestation, SessionScope};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

pub use hmux_session_protocol::transport::{
    FrameOutcome, FrameProgress, FrameReader, FrameWriter, PayloadOutcome, TransportError,
    TransportInterrupt, drive_read_frame, drive_read_payload,
};
pub use hmux_session_protocol::{DEFAULT_MAX_FRAME_BYTES, FrameCodec};

/// Obtain a transport to the address a manifest published.
///
/// This one function is the whole of what the attach path knows about *how*
/// bytes travel. Everything downstream of it — the Hello, the fence checks,
/// the snapshot, the frame loop — is written against the traits above and runs
/// unchanged over a relay, which is why a build without the local runtime keeps
/// that code rather than deleting it. What such a build does not get is a
/// dialer: a filesystem socket path names nothing from a phone, and the relay
/// dialer that will answer here is desktop-side and does not exist yet.
#[cfg(all(unix, feature = "local-runtime"))]
pub(crate) fn dial_local_endpoint(
    address: &Path,
    scope: SessionScope,
    deadline: Option<Instant>,
) -> Result<AttachedTransport, ClientError> {
    unix_socket::UnixSocketDialer::open_before(address, scope, deadline)
}

#[cfg(all(windows, feature = "local-runtime"))]
pub(crate) fn dial_local_endpoint(
    address: &Path,
    scope: SessionScope,
    deadline: Option<Instant>,
) -> Result<AttachedTransport, ClientError> {
    windows_named_pipe::WindowsNamedPipeDialer::open_before(address, scope, deadline)
}

#[cfg(not(any(
    all(unix, feature = "local-runtime"),
    all(windows, feature = "local-runtime")
)))]
pub(crate) fn dial_local_endpoint(
    _address: &Path,
    _scope: SessionScope,
    _deadline: Option<Instant>,
) -> Result<AttachedTransport, ClientError> {
    Err(ClientError::PlatformTransportUnsupported)
}

/// A connected transport and the evidence that came with it.
///
/// The fields are crate-private and the constructors differ in visibility on
/// purpose. That difference is the only part of the socketpair defence the
/// compiler can carry, so it is spent here rather than on a doc comment: with
/// no public field and no public struct literal, an out-of-crate caller has
/// exactly one way to build this value, and that way cannot attach a
/// colocation claim to a carrier the caller chose.
///
/// What this does **not** enforce, stated plainly because the accepted trade in
/// `hmux-transport-attestation.md` says the seal is discipline rather than a
/// type guarantee: a *new dialer inside this crate* could still run
/// `verify_pathname_socket_same_user` on one socket and then hand
/// [`Self::colocated`] a carrier that is not that socket. Nothing here detects
/// it. The compiler stops every caller outside `hmux-client`; the reviewer has
/// to stop that one, which is why [`unix_socket::UnixSocketDialer::open`] takes
/// a *path* and connects it itself instead of accepting a stream.
pub struct AttachedTransport {
    pub(crate) reader: Box<dyn FrameReader>,
    pub(crate) writer: Box<dyn FrameWriter>,
    pub(crate) interrupt: Arc<dyn TransportInterrupt>,
    /// What this transport proves about its peer. A relay reports something
    /// that yields no colocation witness, and every operation that needs one
    /// takes it by argument.
    ///
    /// `pub(crate)` like its siblings so that outside this crate there is no
    /// struct literal to write — the constructors below are the only way in,
    /// and only the crate-private one can attach a colocation claim.
    pub(crate) attestation: PeerAttestation,
}

impl AttachedTransport {
    /// A transport whose peer a dialer *in this crate* verified against the
    /// kernel.
    ///
    /// `pub(crate)` is load-bearing. [`ColocatedSameUserPeer`] can only be
    /// minted by a real credential call on a pathname socket or connected
    /// named pipe. Keeping this constructor inside the crate means no
    /// caller-supplied carrier can be labelled colocated, so verified peer
    /// evidence and the framed carrier stay together.
    ///
    /// Gated to exactly the builds that have a dialer able to mint a witness.
    /// A build with no local runtime has no way to obtain a
    /// [`ColocatedSameUserPeer`] at all, so the constructor is absent rather
    /// than present-and-unreachable — which also keeps it out of the mobile
    /// clippy gate's dead-code surface without an `allow`.
    #[cfg(any(
        all(unix, feature = "local-runtime"),
        all(windows, feature = "local-runtime")
    ))]
    pub(crate) fn colocated(
        reader: Box<dyn FrameReader>,
        writer: Box<dyn FrameWriter>,
        interrupt: Arc<dyn TransportInterrupt>,
        peer: ColocatedSameUserPeer,
    ) -> Self {
        Self {
            reader,
            writer,
            interrupt,
            attestation: PeerAttestation::ColocatedSameUser(peer),
        }
    }

    /// A transport a caller connected itself, over a relay.
    ///
    /// It takes **no attestation argument**, for the same reason
    /// `MemoryEndpoint::pair` takes none: an attestation parameter is a place
    /// for a caller to put a claim it did not earn. An SSH exec channel cannot
    /// say who is on the far end; the gateway on the session-owning box says
    /// that, later, with a grant.
    ///
    /// The attestation is [`PeerAttestation::Relayed`] and deliberately not
    /// `Simulated`, whose documented contract is that no shipped dialer
    /// produces it. `hmux-ssh-transport` is a shipped dialer and reaches this
    /// constructor, so reporting `Simulated` would have made that sentence
    /// false while leaving it written down — and the next author to build a
    /// gate on it would have been reasoning from a deleted invariant. Both
    /// variants answer `witness_for` the same way today, so nothing but the
    /// name distinguishes them, which is exactly why the name has to be right.
    #[must_use]
    pub fn relayed(
        reader: Box<dyn FrameReader>,
        writer: Box<dyn FrameWriter>,
        interrupt: Arc<dyn TransportInterrupt>,
    ) -> Self {
        Self {
            reader,
            writer,
            interrupt,
            attestation: PeerAttestation::Relayed,
        }
    }

    /// What this transport proves about its peer.
    #[must_use]
    pub fn attestation(&self) -> &PeerAttestation {
        &self.attestation
    }
}

impl std::fmt::Debug for AttachedTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AttachedTransport")
            .field("attestation", &self.attestation)
            .finish_non_exhaustive()
    }
}
