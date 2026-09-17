use crate::{PeerAttestation, SessionScope};
use tempfile::TempDir;

/// Mints a real colocation witness the only way one can be minted: dial an
/// actual pathname socket and ask the kernel who answered. The `TempDir`
/// comes back because dropping it unlinks the socket.
#[cfg(unix)]
pub(super) fn colocated_for(session: &str) -> (TempDir, PeerAttestation) {
    use hmux_local_platform::local_peer_identity::verify_pathname_socket_same_user;
    use std::os::unix::net::{UnixListener, UnixStream};

    let directory = TempDir::new().unwrap();
    let path = directory.path().join("attestation.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let dialed = UnixStream::connect(&path).unwrap();
    let _accepted = listener.accept().unwrap();
    let credential = verify_pathname_socket_same_user(&dialed).unwrap();
    let witness = credential.bind_to_session(SessionScope::new("workspace", session, "host-1"));
    (directory, PeerAttestation::ColocatedSameUser(witness))
}

/// Run the same grant tests with a kernel-verified local pipe on Windows.
#[cfg(windows)]
pub(super) fn colocated_for(session: &str) -> (TempDir, PeerAttestation) {
    use hmux_local_platform::local_peer_identity::verify_named_pipe_server_same_user;
    use hmux_local_platform::transport::windows_named_pipe::{
        WindowsNamedPipeListener, WindowsNamedPipeTransport,
    };
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let directory = TempDir::new().unwrap();
    let name = directory.path().file_name().unwrap().to_string_lossy();
    let address = std::path::PathBuf::from(format!(
        r"\\.\pipe\hmux-client-attestation-{}-{name}",
        std::process::id()
    ));
    let mut listener = WindowsNamedPipeListener::bind(&address).unwrap();
    let scope = SessionScope::new("workspace", session, "host-1");
    let deadline = Instant::now() + Duration::from_secs(3);
    let (release, released) = mpsc::channel();
    let client = std::thread::spawn(move || {
        let transport =
            WindowsNamedPipeTransport::connect_before(&address, Some(deadline)).unwrap();
        let credential = verify_named_pipe_server_same_user(transport.raw_handle()).unwrap();
        released
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        PeerAttestation::ColocatedSameUser(credential.bind_to_session(scope))
    });
    let _accepted = listener.accept_before(Some(deadline)).unwrap();
    release.send(()).unwrap();
    (directory, client.join().unwrap())
}
