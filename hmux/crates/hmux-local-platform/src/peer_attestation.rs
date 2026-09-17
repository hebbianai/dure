//! What a transport proves about the peer on the other end.
//!
//! A local Unix socket silently bundles four separate properties: the address
//! came from a manifest read under `path_security`, the capability token was
//! therefore readable only by this euid, the Host verified the peer's
//! credentials on accept, and the peer shares this kernel. Only the fourth
//! makes pids, `kill(-pgid)`, `/proc` and flock meaningful. A kernel-backed
//! local endpoint — a pathname socket on Unix or a protected named pipe on
//! Windows — establishes it.
//!
//! A relay carries the same protocol over a stream that establishes none of
//! them. So a transport must carry its proof rather than let callers assume
//! one: operations that depend on colocation take a [`ColocatedSameUserPeer`]
//! by argument, and the compiler refuses the ones that cannot supply it.

use crate::local_peer_identity::{KernelPeerCredential, LocalUserIdentity};
use std::fmt;

/// The session a colocation witness was obtained for.
///
/// `host_instance_id` is part of the identity on purpose. A session id alone
/// survives a Host being replaced, and a witness that outlives the Host it was
/// taken against is exactly the stale evidence this type exists to prevent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionScope {
    workspace_id: String,
    session_id: String,
    host_instance_id: String,
}

impl SessionScope {
    #[must_use]
    pub fn new(
        workspace_id: impl Into<String>,
        session_id: impl Into<String>,
        host_instance_id: impl Into<String>,
    ) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            session_id: session_id.into(),
            host_instance_id: host_instance_id.into(),
        }
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn host_instance_id(&self) -> &str {
        &self.host_instance_id
    }
}

/// Evidence that the peer shares this kernel, runs as this user, and is serving
/// one specific session.
///
/// Deliberately **not** `Clone`, and it exposes no accessor for its scope. Both
/// are load-bearing. Local and relayed attachments share one session registry
/// in the adapter, so a clonable, scope-readable witness invites the natural
/// wrong fix: an implementer facing a relay connection that cannot produce one
/// satisfies the compiler with a witness taken from a different session, and
/// the destructive operation then runs against the wrong process table. The
/// only way to obtain a reference is [`PeerAttestation::witness_for`], which
/// hands one back solely for the session it was taken against.
pub struct ColocatedSameUserPeer {
    credential: KernelPeerCredential,
    scope: SessionScope,
}

impl ColocatedSameUserPeer {
    pub(crate) fn new(credential: KernelPeerCredential, scope: SessionScope) -> Self {
        Self { credential, scope }
    }

    #[must_use]
    pub fn identity(&self) -> &LocalUserIdentity {
        self.credential.identity()
    }
}

impl fmt::Debug for ColocatedSameUserPeer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ColocatedSameUserPeer")
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}

/// What the transport a connection rides on establishes about its peer.
#[derive(Debug)]
pub enum PeerAttestation {
    /// A kernel credential call against a platform local endpoint succeeded.
    ColocatedSameUser(ColocatedSameUserPeer),
    /// A relay carried the frames. sshd authenticated a principal, and a
    /// gateway running on the session-owning box as the session-owning user did
    /// the filesystem provenance work — but nothing on this side shares a
    /// kernel with the session, so no witness exists and none ever will for
    /// this variant.
    ///
    /// Fieldless, and not because a relay has nothing worth naming: it has the
    /// sshd principal, and a grant scoped to a session with an expiry and a
    /// revocable id. Storing those now would put an expiry nothing compares to
    /// a clock and a grant id nothing checks inside a type that reads as a
    /// security boundary — the decoration this design rejects by name for
    /// `RelayAuthenticatedPeer`. They land with the code that evaluates them.
    /// Nothing here is scoped away by their absence, because the one question
    /// this variant answers is answered the same way for every grant.
    ///
    /// What it does carry is the only thing that is both already true and
    /// already load-bearing: this transport is not colocated. A shipped dialer
    /// saying that through [`Self::Simulated`] would have made that variant's
    /// "test-only" claim false — and the next author reading it while writing a
    /// gate would have been misled by an invariant that had quietly stopped
    /// holding.
    Relayed,
    /// Test-only. No shipped dialer produces this, and it establishes nothing.
    Simulated,
}

impl PeerAttestation {
    /// The only route to a colocation witness.
    ///
    /// Returns it solely when this attestation was taken for `scope`, so a
    /// witness cannot be carried from one session to another.
    pub fn witness_for(
        &self,
        scope: &SessionScope,
    ) -> Result<&ColocatedSameUserPeer, AttestationError> {
        match self {
            Self::ColocatedSameUser(peer) if peer.scope == *scope => Ok(peer),
            Self::ColocatedSameUser(_) => Err(AttestationError::ScopeMismatch {
                requested: scope.clone(),
            }),
            // Both non-colocated variants are named rather than swept up by a
            // `_` arm. Fail-closed is the right default here, but a `_` would
            // deliver it silently: a variant added later would start refusing
            // without anyone having decided that it should, and the compiler
            // would never ask. Naming them makes adding a variant a decision.
            Self::Relayed | Self::Simulated => Err(AttestationError::NotColocated),
        }
    }

    /// Whether this transport establishes colocation at all, for callers that
    /// need to branch without naming a session (diagnostics, posture checks).
    /// Prefer [`Self::witness_for`] anywhere the answer authorizes something.
    #[must_use]
    pub fn is_colocated(&self) -> bool {
        matches!(self, Self::ColocatedSameUser(_))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AttestationError {
    /// The transport does not establish colocation. A relay always lands here.
    NotColocated,
    /// Colocation was proven, but for a different session.
    ///
    /// Names only the session that was *asked* for. The witness deliberately
    /// exposes no accessor for its own scope, and reporting it here would be
    /// the same leak through a side door — an error value is routinely logged
    /// and propagated, so it would hand out the identity of whatever other
    /// session the caller happened to be holding a witness for.
    ScopeMismatch { requested: SessionScope },
}

impl fmt::Display for AttestationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotColocated => write!(
                formatter,
                "this transport does not prove the peer shares this kernel"
            ),
            Self::ScopeMismatch { requested } => write!(
                formatter,
                "colocation was proven for another session, not {}/{}",
                requested.workspace_id(),
                requested.session_id()
            ),
        }
    }
}

impl std::error::Error for AttestationError {}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::{UnixListener, UnixStream};

    fn scope(session: &str) -> SessionScope {
        SessionScope::new("workspace-1", session, "host-1")
    }

    fn colocated(session: &str) -> PeerAttestation {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("attestation.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let dialed = UnixStream::connect(&path).unwrap();
        let _accepted = listener.accept().unwrap();

        let credential =
            crate::local_peer_identity::verify_pathname_socket_same_user(&dialed).unwrap();
        PeerAttestation::ColocatedSameUser(ColocatedSameUserPeer::new(credential, scope(session)))
    }

    #[test]
    fn a_witness_is_returned_only_for_the_session_it_was_taken_for() {
        let attestation = colocated("session-a");

        assert!(attestation.witness_for(&scope("session-a")).is_ok());
        assert!(matches!(
            attestation.witness_for(&scope("session-b")),
            Err(AttestationError::ScopeMismatch { .. })
        ));
    }

    /// A witness taken against one Host must not survive that Host being
    /// replaced, even though the session id is unchanged.
    #[test]
    fn a_witness_does_not_survive_a_host_replacement() {
        let attestation = colocated("session-a");
        let after_rehost = SessionScope::new("workspace-1", "session-a", "host-2");

        assert!(matches!(
            attestation.witness_for(&after_rehost),
            Err(AttestationError::ScopeMismatch { .. })
        ));
    }

    /// Both non-colocated variants, together, because the reason they refuse is
    /// the same one and a variant that started answering differently would be a
    /// silent widening of every gate keyed on this.
    #[test]
    fn a_non_colocated_transport_yields_no_witness() {
        for attestation in [PeerAttestation::Relayed, PeerAttestation::Simulated] {
            assert!(!attestation.is_colocated(), "{attestation:?}");
            assert!(
                matches!(
                    attestation.witness_for(&scope("session-a")),
                    Err(AttestationError::NotColocated)
                ),
                "{attestation:?}"
            );
        }
    }
}
