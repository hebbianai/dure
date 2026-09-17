use super::{
    KernelPeerCredential, LocalUserIdentity, PeerIdentityError, PeerIdentitySource,
    verify_same_user,
};
use std::io;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;

pub struct UnixSocketPeerIdentity<'a> {
    socket: &'a UnixStream,
}

impl<'a> UnixSocketPeerIdentity<'a> {
    #[must_use]
    pub fn new(socket: &'a UnixStream) -> Self {
        Self { socket }
    }
}

impl PeerIdentitySource for UnixSocketPeerIdentity<'_> {
    fn peer_identity(&self) -> Result<LocalUserIdentity, PeerIdentityError> {
        peer_identity_for_socket(self.socket)
    }
}

#[must_use]
pub fn current_user_identity() -> LocalUserIdentity {
    // SAFETY: geteuid has no arguments and does not dereference memory.
    LocalUserIdentity::UnixUid(unsafe { libc::geteuid() })
}

pub fn peer_identity_for_socket(
    socket: &UnixStream,
) -> Result<LocalUserIdentity, PeerIdentityError> {
    platform_peer_identity(socket.as_raw_fd())
}

/// Verifies that the socket's peer is this euid **and** that the socket is a
/// pathname socket, returning the only evidence that authorizes a
/// colocation-dependent operation.
///
/// The pathname requirement is what makes the answer mean anything. Both
/// endpoints of a `socketpair(2)` report the calling process's own uid, so a
/// bare same-user check passes on a transport that proves nothing about who is
/// on the other end — see `socket_pair_is_refused_because_it_proves_nothing`.
///
/// A pathname is present in exactly one direction, and which one depends on
/// how the socket was obtained. Measured on darwin 25.4.0 against a bound
/// `AF_UNIX` listener:
///
/// | | `getsockname` | `getpeername` |
/// |---|---|---|
/// | dialed (client) | empty | path |
/// | accepted (server) | path | empty |
/// | `socketpair` | empty | empty |
///
/// So the test is "a pathname in *either* direction". Checking only
/// `getsockname` would refuse every dialed socket — which is every socket the
/// Hmux client owns, since it connects and never binds.
///
/// Linux abstract-namespace sockets (leading NUL, name in the remaining bytes)
/// are refused. Hmux addresses are filesystem paths under a `path_security`
/// managed directory, so refusing the abstract namespace is the conservative
/// and correct answer here.
pub fn verify_pathname_socket_same_user(
    socket: &UnixStream,
) -> Result<KernelPeerCredential, PeerIdentityError> {
    let fd = socket.as_raw_fd();
    if !address_has_pathname(fd, AddressSide::Local)?
        && !address_has_pathname(fd, AddressSide::Peer)?
    {
        return Err(PeerIdentityError::NotAPathnameSocket);
    }
    let verified = verify_same_user(
        &UnixSocketPeerIdentity::new(socket),
        &current_user_identity(),
    )?;
    Ok(KernelPeerCredential::from_kernel(verified))
}

#[derive(Clone, Copy)]
enum AddressSide {
    Local,
    Peer,
}

impl AddressSide {
    fn operation(self) -> &'static str {
        match self {
            Self::Local => "getsockname",
            Self::Peer => "getpeername",
        }
    }
}

fn address_has_pathname(fd: RawFd, side: AddressSide) -> Result<bool, PeerIdentityError> {
    // SAFETY: sockaddr_un is a plain-old-data C struct; an all-zero bit
    // pattern is a valid (empty) value for every field.
    let mut address = unsafe { std::mem::zeroed::<libc::sockaddr_un>() };
    let mut length = libc::socklen_t::try_from(std::mem::size_of::<libc::sockaddr_un>())
        .expect("sockaddr_un size fits socklen_t");
    // SAFETY: address points to writable storage of the advertised size,
    // length is initialized, and fd is borrowed from a live UnixStream.
    let result = unsafe {
        let storage = std::ptr::addr_of_mut!(address).cast::<libc::sockaddr>();
        match side {
            AddressSide::Local => libc::getsockname(fd, storage, &mut length),
            AddressSide::Peer => libc::getpeername(fd, storage, &mut length),
        }
    };
    if result != 0 {
        let error = io::Error::last_os_error();
        // An unconnected endpoint has no peer name. That is not an OS failure
        // to report, it is the absence of a pathname.
        if side_reports_missing_name(&error) {
            return Ok(false);
        }
        return Err(PeerIdentityError::Os {
            operation: side.operation(),
            source: error,
        });
    }
    let path_offset =
        std::mem::size_of::<libc::sockaddr_un>() - std::mem::size_of_val(&address.sun_path);
    if usize::try_from(length).unwrap_or(0) <= path_offset {
        return Ok(false);
    }
    Ok(address.sun_path[0] != 0)
}

fn side_reports_missing_name(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ENOTCONN) | Some(libc::EINVAL)
    )
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn platform_peer_identity(fd: RawFd) -> Result<LocalUserIdentity, PeerIdentityError> {
    let mut credentials = std::mem::MaybeUninit::<libc::ucred>::uninit();
    let mut length = libc::socklen_t::try_from(std::mem::size_of::<libc::ucred>())
        .expect("ucred size fits socklen_t");
    // SAFETY: credentials points to writable storage of the advertised size,
    // length is initialized, and fd is borrowed from a live UnixStream.
    let result = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credentials.as_mut_ptr().cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(PeerIdentityError::Os {
            operation: "SO_PEERCRED",
            source: io::Error::last_os_error(),
        });
    }
    if usize::try_from(length).ok() != Some(std::mem::size_of::<libc::ucred>()) {
        return Err(PeerIdentityError::InvalidKernelResponse {
            operation: "SO_PEERCRED",
        });
    }
    // SAFETY: getsockopt succeeded and reported a complete ucred value.
    let credentials = unsafe { credentials.assume_init() };
    Ok(LocalUserIdentity::UnixUid(credentials.uid))
}

#[cfg(any(
    target_os = "macos",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
))]
fn platform_peer_identity(fd: RawFd) -> Result<LocalUserIdentity, PeerIdentityError> {
    let mut user_id = libc::uid_t::MAX;
    let mut group_id = libc::gid_t::MAX;
    // SAFETY: both output pointers are valid and fd is borrowed from a live
    // UnixStream. getpeereid initializes both values on success.
    let result = unsafe { libc::getpeereid(fd, &mut user_id, &mut group_id) };
    if result != 0 {
        return Err(PeerIdentityError::Os {
            operation: "getpeereid",
            source: io::Error::last_os_error(),
        });
    }
    Ok(LocalUserIdentity::UnixUid(user_id))
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
)))]
fn platform_peer_identity(_fd: RawFd) -> Result<LocalUserIdentity, PeerIdentityError> {
    Err(PeerIdentityError::Unsupported {
        capability: super::UnsupportedPeerIdentityCapability::KernelSocketCredentials,
        platform: std::env::consts::OS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_socket_pair_reports_same_process_user() {
        let (left, right) = UnixStream::pair().unwrap();

        assert_eq!(
            peer_identity_for_socket(&left).unwrap(),
            current_user_identity()
        );
        assert_eq!(
            peer_identity_for_socket(&right).unwrap(),
            current_user_identity()
        );
    }

    /// The reason `verify_pathname_socket_same_user` exists. A socketpair
    /// satisfies every same-user check while proving nothing about who is on
    /// the other end, so a relay carried over one would mint a colocation
    /// witness it did not earn.
    #[test]
    fn socket_pair_is_refused_because_it_proves_nothing() {
        let (left, right) = UnixStream::pair().unwrap();

        for socket in [&left, &right] {
            assert!(matches!(
                verify_pathname_socket_same_user(socket),
                Err(PeerIdentityError::NotAPathnameSocket)
            ));
        }
    }

    /// Both ends of a real pathname socket must pass — the accepted side
    /// carries the path in `getsockname`, the dialed side in `getpeername`.
    /// A `getsockname`-only rule would refuse every client attach.
    #[test]
    fn pathname_socket_is_accepted_from_both_directions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("peer-identity.sock");
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();

        let dialed = UnixStream::connect(&path).unwrap();
        let (accepted, _) = listener.accept().unwrap();

        let dialed_credential = verify_pathname_socket_same_user(&dialed).unwrap();
        let accepted_credential = verify_pathname_socket_same_user(&accepted).unwrap();

        assert_eq!(dialed_credential.identity(), &current_user_identity());
        assert_eq!(accepted_credential.identity(), &current_user_identity());
    }
}
