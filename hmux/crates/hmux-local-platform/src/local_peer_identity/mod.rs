#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::{
    UnixSocketPeerIdentity, current_user_identity, peer_identity_for_socket,
    verify_pathname_socket_same_user,
};
#[cfg(windows)]
pub use windows::{
    WindowsNamedPipePeerIdentity, current_user_identity, peer_identity_for_named_pipe,
    verify_named_pipe_same_user, verify_named_pipe_server_same_user,
};

use crate::peer_attestation::{ColocatedSameUserPeer, SessionScope};
use std::fmt;
use std::io;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocalUserIdentity {
    UnixUid(u32),
    WindowsSid(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedLocalPeer {
    identity: LocalUserIdentity,
}

impl VerifiedLocalPeer {
    #[must_use]
    pub fn identity(&self) -> &LocalUserIdentity {
        &self.identity
    }
}

/// A [`VerifiedLocalPeer`] that a real kernel credential call produced against
/// a transport which structurally cannot be a `socketpair(2)`.
///
/// [`verify_same_user`] alone is not enough evidence to authorize a
/// colocation-dependent operation. It takes any [`PeerIdentitySource`], and
/// that trait is blanket-implemented for closures, so a `VerifiedLocalPeer` is
/// mintable with no syscall at all — this module's own tests do exactly that.
/// A `KernelPeerCredential` can only come from a platform verifier that asked
/// the kernel and rejected socketpair-shaped transports.
///
/// The constructor below is deliberately bare-private rather than
/// `pub(super)`: `local_peer_identity` is declared at the crate root, so
/// `pub(super)` here would mean `pub(crate)` and every other platform module
/// could mint one. Rust child modules can see an ancestor's private items, so
/// `unix` and `windows` still reach it while the rest of the crate cannot.
/// Deliberately not `Clone`. One kernel credential call yields one credential,
/// which [`Self::bind_to_session`] then consumes into one witness. Cloning
/// would let a caller that verified one session endpoint mint witnesses for
/// several, which is the escalation the session binding exists to prevent —
/// just one level up from the witness itself.
#[derive(Debug)]
pub struct KernelPeerCredential(VerifiedLocalPeer);

impl KernelPeerCredential {
    fn from_kernel(verified: VerifiedLocalPeer) -> Self {
        Self(verified)
    }

    #[must_use]
    pub fn identity(&self) -> &LocalUserIdentity {
        self.0.identity()
    }

    /// Turn a kernel credential into a session-bound colocation witness.
    ///
    /// This is `pub` on purpose while `ColocatedSameUserPeer::new` is not: the
    /// only shipped producer of a witness is the client crate's Unix socket
    /// dialer, so a constructor sealed to this crate would leave the witness
    /// unconstructible where it is actually needed. Consuming `self` keeps it
    /// unforgeable anyway — a `KernelPeerCredential` cannot exist unless a
    /// sealed platform verifier asked the kernel about a pathname Unix socket
    /// or a connected server-side Windows named pipe.
    #[must_use]
    pub fn bind_to_session(self, scope: SessionScope) -> ColocatedSameUserPeer {
        ColocatedSameUserPeer::new(self, scope)
    }
}

pub trait PeerIdentitySource {
    fn peer_identity(&self) -> Result<LocalUserIdentity, PeerIdentityError>;
}

impl<F> PeerIdentitySource for F
where
    F: Fn() -> Result<LocalUserIdentity, PeerIdentityError>,
{
    fn peer_identity(&self) -> Result<LocalUserIdentity, PeerIdentityError> {
        self()
    }
}

/// Performs the authorization-relevant comparison in one shared function so
/// platform adapters can only supply kernel facts, not redefine same-user.
pub fn verify_same_user(
    source: &impl PeerIdentitySource,
    expected: &LocalUserIdentity,
) -> Result<VerifiedLocalPeer, PeerIdentityError> {
    let actual = source.peer_identity()?;
    if actual != *expected {
        return Err(PeerIdentityError::IdentityMismatch {
            expected: expected.clone(),
            actual,
        });
    }
    Ok(VerifiedLocalPeer { identity: actual })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnsupportedPeerIdentityCapability {
    KernelSocketCredentials,
    WindowsNamedPipeTokenUser,
}

#[derive(Debug)]
pub enum PeerIdentityError {
    Os {
        operation: &'static str,
        source: io::Error,
    },
    Unsupported {
        capability: UnsupportedPeerIdentityCapability,
        platform: &'static str,
    },
    IdentityMismatch {
        expected: LocalUserIdentity,
        actual: LocalUserIdentity,
    },
    /// The SID matched, but crossing this pipe would let a lower-integrity or
    /// differently elevated process drive a peer with another token posture.
    SecurityPostureMismatch,
    InvalidKernelResponse {
        operation: &'static str,
    },
    /// The transport is not a pathname socket, so a kernel same-user answer
    /// about it proves nothing about colocation. A `socketpair(2)` is the
    /// motivating case: both of its endpoints report the calling process's own
    /// uid, so every same-user check passes vacuously.
    NotAPathnameSocket,
}

impl fmt::Display for PeerIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Os { operation, source } => write!(formatter, "{operation} failed: {source}"),
            Self::Unsupported {
                capability,
                platform,
            } => write!(
                formatter,
                "peer identity capability {capability:?} is unsupported on {platform}"
            ),
            Self::IdentityMismatch { .. } => {
                write!(formatter, "local peer belongs to another user")
            }
            Self::SecurityPostureMismatch => write!(
                formatter,
                "local peer has an incompatible Windows integrity or elevation posture"
            ),
            Self::InvalidKernelResponse { operation } => {
                write!(
                    formatter,
                    "{operation} returned an invalid credential record"
                )
            }
            Self::NotAPathnameSocket => {
                write!(
                    formatter,
                    "local peer transport is not a pathname socket, so its kernel credentials do not prove colocation"
                )
            }
        }
    }
}

impl std::error::Error for PeerIdentityError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Os { source, .. } => Some(source),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injectable_identity_source_accepts_same_user() {
        let source = || Ok(LocalUserIdentity::UnixUid(1000));
        let verified = verify_same_user(&source, &LocalUserIdentity::UnixUid(1000)).unwrap();

        assert_eq!(verified.identity(), &LocalUserIdentity::UnixUid(1000));
    }

    #[test]
    fn injectable_identity_source_refuses_mismatch() {
        let source = || Ok(LocalUserIdentity::UnixUid(1001));

        assert!(matches!(
            verify_same_user(&source, &LocalUserIdentity::UnixUid(1000)),
            Err(PeerIdentityError::IdentityMismatch {
                expected: LocalUserIdentity::UnixUid(1000),
                actual: LocalUserIdentity::UnixUid(1001),
            })
        ));
    }

    #[test]
    fn windows_sid_mismatch_is_refused_by_the_shared_authority() {
        let source = || Ok(LocalUserIdentity::WindowsSid("S-1-5-21-200".into()));

        assert!(matches!(
            verify_same_user(
                &source,
                &LocalUserIdentity::WindowsSid("S-1-5-21-100".into())
            ),
            Err(PeerIdentityError::IdentityMismatch { .. })
        ));
    }
}
