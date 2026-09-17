use super::{
    KernelPeerCredential, LocalUserIdentity, PeerIdentityError, PeerIdentitySource,
    verify_same_user,
};
use crate::windows_security::{
    WindowsSecurityError, WindowsTokenFacts, current_process_sid, current_process_token_facts,
    current_thread_token_facts, process_token_facts,
};
use std::io;
use std::os::windows::io::RawHandle;
use windows_sys::Win32::Security::RevertToSelf;
use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, ImpersonateNamedPipeClient};

pub struct WindowsNamedPipePeerIdentity {
    handle: RawHandle,
}

impl WindowsNamedPipePeerIdentity {
    #[must_use]
    pub fn new(handle: RawHandle) -> Self {
        Self { handle }
    }
}

impl PeerIdentitySource for WindowsNamedPipePeerIdentity {
    fn peer_identity(&self) -> Result<LocalUserIdentity, PeerIdentityError> {
        peer_identity_for_named_pipe(self.handle)
    }
}

pub fn current_user_identity() -> Result<LocalUserIdentity, PeerIdentityError> {
    let sid = current_process_sid().map_err(peer_error)?;
    Ok(LocalUserIdentity::WindowsSid(
        sid.to_string().map_err(peer_error)?,
    ))
}

pub fn peer_identity_for_named_pipe(
    handle: RawHandle,
) -> Result<LocalUserIdentity, PeerIdentityError> {
    Ok(named_pipe_client_facts(handle)?.identity)
}

fn named_pipe_client_facts(handle: RawHandle) -> Result<WindowsPeerFacts, PeerIdentityError> {
    // The caller must have completed a bounded read from this connected pipe.
    // Windows impersonates the client that supplied the last bytes read, so
    // authenticating before the first read fails with ERROR_CANNOT_IMPERSONATE.
    // SAFETY: the caller supplies that connected server-side named-pipe handle.
    // Windows binds impersonation to this thread until RevertToSelf.
    if unsafe { ImpersonateNamedPipeClient(handle.cast()) } == 0 {
        return Err(PeerIdentityError::Os {
            operation: "ImpersonateNamedPipeClient",
            source: io::Error::last_os_error(),
        });
    }
    let guard = ImpersonationGuard { active: true };
    let facts = current_thread_token_facts()
        .and_then(windows_peer_facts)
        .map_err(peer_error);
    guard.revert();
    facts
}

/// Windows counterpart of [`super::verify_pathname_socket_same_user`]: the
/// only producer of a [`KernelPeerCredential`] on this platform.
pub fn verify_named_pipe_same_user(
    handle: RawHandle,
) -> Result<KernelPeerCredential, PeerIdentityError> {
    let expected = current_process_token_facts()
        .and_then(windows_peer_facts)
        .map_err(peer_error)?;
    let actual = named_pipe_client_facts(handle)?;
    let verified = verify_windows_peer(actual, &expected)?;
    Ok(KernelPeerCredential::from_kernel(verified))
}

/// Client-side counterpart to impersonating a named-pipe client. The kernel
/// reports the process that owns the connected server end; querying that
/// process token binds the same-user/elevation proof to this carrier rather
/// than trusting the manifest's pipe name alone.
pub fn verify_named_pipe_server_same_user(
    handle: RawHandle,
) -> Result<KernelPeerCredential, PeerIdentityError> {
    let mut process_id = 0_u32;
    // SAFETY: handle is the connected client end and process_id is writable.
    if unsafe { GetNamedPipeServerProcessId(handle.cast(), &raw mut process_id) } == 0 {
        return Err(PeerIdentityError::Os {
            operation: "GetNamedPipeServerProcessId",
            source: io::Error::last_os_error(),
        });
    }
    if process_id == 0 {
        return Err(PeerIdentityError::InvalidKernelResponse {
            operation: "GetNamedPipeServerProcessId",
        });
    }
    let expected = current_process_token_facts()
        .and_then(windows_peer_facts)
        .map_err(peer_error)?;
    let actual = process_token_facts(process_id)
        .and_then(windows_peer_facts)
        .map_err(peer_error)?;
    let verified = verify_windows_peer(actual, &expected)?;
    Ok(KernelPeerCredential::from_kernel(verified))
}

struct WindowsPeerFacts {
    identity: LocalUserIdentity,
    elevation_type: i32,
    integrity_sid: String,
}

fn windows_peer_facts(facts: WindowsTokenFacts) -> Result<WindowsPeerFacts, WindowsSecurityError> {
    Ok(WindowsPeerFacts {
        identity: LocalUserIdentity::WindowsSid(facts.user_sid().to_string()?),
        elevation_type: facts.elevation_type(),
        integrity_sid: facts.integrity_sid().to_string()?,
    })
}

fn verify_windows_peer(
    actual: WindowsPeerFacts,
    expected: &WindowsPeerFacts,
) -> Result<super::VerifiedLocalPeer, PeerIdentityError> {
    let verified = verify_same_user(&|| Ok(actual.identity.clone()), &expected.identity)?;
    if actual.elevation_type != expected.elevation_type
        || actual.integrity_sid != expected.integrity_sid
    {
        return Err(PeerIdentityError::SecurityPostureMismatch);
    }
    Ok(verified)
}

fn peer_error(error: WindowsSecurityError) -> PeerIdentityError {
    match error {
        WindowsSecurityError::Os { operation, source } => {
            PeerIdentityError::Os { operation, source }
        }
        WindowsSecurityError::InvalidKernelResponse { operation } => {
            PeerIdentityError::InvalidKernelResponse { operation }
        }
    }
}

struct ImpersonationGuard {
    active: bool,
}

impl ImpersonationGuard {
    fn revert(mut self) {
        // SAFETY: this guard exists only after this thread successfully began
        // named-pipe impersonation.
        if unsafe { RevertToSelf() } == 0 {
            // Continuing would execute caller code under the client's token.
            // Microsoft explicitly requires process shutdown in this case.
            std::process::abort();
        }
        self.active = false;
    }
}

impl Drop for ImpersonationGuard {
    fn drop(&mut self) {
        if self.active {
            // SAFETY: a still-active guard means unwinding crossed the
            // impersonation scope. Continuing under the client's token is not
            // safe, so a failed cleanup terminates the process.
            if unsafe { RevertToSelf() } == 0 {
                std::process::abort();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows_security::OwnedHandle;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use windows_sys::Win32::Foundation::{ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        PIPE_ACCESS_DUPLEX, ReadFile, WriteFile,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    static NEXT_PIPE: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn current_process_exposes_a_stable_windows_sid() {
        let identity = current_user_identity().unwrap();

        let LocalUserIdentity::WindowsSid(sid) = identity else {
            panic!("expected a Windows SID");
        };
        assert!(sid.starts_with("S-1-"));
    }

    #[test]
    fn connected_named_pipe_client_is_verified_as_the_current_user() {
        let sequence = NEXT_PIPE.fetch_add(1, Ordering::Relaxed);
        let name = format!(
            r"\\.\pipe\hmux-peer-identity-{}-{sequence}",
            std::process::id()
        );
        let mut encoded = name.encode_utf16().collect::<Vec<_>>();
        encoded.push(0);
        // SAFETY: encoded is a live NUL-terminated pipe name and the remaining
        // pointer arguments are intentionally absent.
        let server = unsafe {
            CreateNamedPipeW(
                encoded.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                4096,
                4096,
                0,
                null(),
            )
        };
        let server = OwnedHandle::from_file(server).unwrap();
        let (release, released) = mpsc::channel();
        let client_name = encoded.clone();
        let client = std::thread::spawn(move || {
            // SAFETY: client_name is NUL-terminated and stays live for the call.
            let handle = unsafe {
                CreateFileW(
                    client_name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    null_mut(),
                )
            };
            let handle = OwnedHandle::from_file(handle).unwrap();
            let server_credential = verify_named_pipe_server_same_user(handle.raw()).unwrap();
            assert_eq!(
                server_credential.identity(),
                &current_user_identity().unwrap()
            );
            let probe = [0x48_u8];
            let mut written = 0_u32;
            // SAFETY: handle is the live client end and probe is one readable
            // byte. A synchronous pipe write completes before this returns.
            assert_ne!(
                unsafe {
                    WriteFile(
                        handle.raw(),
                        probe.as_ptr().cast(),
                        u32::try_from(probe.len()).unwrap(),
                        &raw mut written,
                        null_mut(),
                    )
                },
                0
            );
            assert_eq!(written, 1);
            released.recv().unwrap();
        });

        // SAFETY: server is a live server-side named-pipe handle.
        if unsafe { ConnectNamedPipe(server.raw(), null_mut()) } == 0 {
            let error = io::Error::last_os_error();
            assert_eq!(
                error.raw_os_error(),
                Some(i32::try_from(ERROR_PIPE_CONNECTED).unwrap())
            );
        }
        let mut probe = [0_u8];
        let mut read = 0_u32;
        // SAFETY: server is the live server end and probe has one writable byte.
        assert_ne!(
            unsafe {
                ReadFile(
                    server.raw(),
                    probe.as_mut_ptr().cast(),
                    u32::try_from(probe.len()).unwrap(),
                    &raw mut read,
                    null_mut(),
                )
            },
            0
        );
        assert_eq!((read, probe), (1, [0x48]));
        let credential = verify_named_pipe_same_user(server.raw()).unwrap();
        assert_eq!(credential.identity(), &current_user_identity().unwrap());

        release.send(()).unwrap();
        client.join().unwrap();
        // SAFETY: server is still a live connected named-pipe handle.
        unsafe {
            DisconnectNamedPipe(server.raw());
        }
    }

    #[test]
    fn matching_sid_cannot_cross_an_elevation_or_integrity_boundary() {
        let expected = WindowsPeerFacts {
            identity: LocalUserIdentity::WindowsSid("S-1-5-21-test".into()),
            elevation_type: 1,
            integrity_sid: "S-1-16-8192".into(),
        };
        let elevated = WindowsPeerFacts {
            identity: expected.identity.clone(),
            elevation_type: 2,
            integrity_sid: expected.integrity_sid.clone(),
        };
        assert!(matches!(
            verify_windows_peer(elevated, &expected),
            Err(PeerIdentityError::SecurityPostureMismatch)
        ));

        let high_integrity = WindowsPeerFacts {
            identity: expected.identity.clone(),
            elevation_type: expected.elevation_type,
            integrity_sid: "S-1-16-12288".into(),
        };
        assert!(matches!(
            verify_windows_peer(high_integrity, &expected),
            Err(PeerIdentityError::SecurityPostureMismatch)
        ));
    }
}
