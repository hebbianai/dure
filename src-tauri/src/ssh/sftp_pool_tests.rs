use std::{
    io,
    net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    sync::{Arc, Mutex},
    thread,
};

use super::{directory, SshOptions};

/// A loopback TCP relay in front of the SSH server, standing in for a local
/// tunnel. Dropping its connections leaves every parked session on a dead
/// socket while new connections still reach the server.
struct Relay {
    port: u16,
    connections: Arc<Mutex<Vec<TcpStream>>>,
}

impl Relay {
    fn start(upstream: SocketAddr) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let connections = Arc::new(Mutex::new(Vec::new()));
        let accepted = Arc::clone(&connections);
        thread::spawn(move || {
            for client in listener.incoming() {
                let Ok(client) = client else { return };
                let Ok(server) = TcpStream::connect(upstream) else {
                    continue;
                };
                accepted
                    .lock()
                    .unwrap()
                    .extend([client.try_clone().unwrap(), server.try_clone().unwrap()]);
                pipe(client.try_clone().unwrap(), server.try_clone().unwrap());
                pipe(server, client);
            }
        });
        Self { port, connections }
    }

    fn drop_connections(&self) -> usize {
        let mut connections = self.connections.lock().unwrap();
        let dropped = connections.len() / 2;
        for stream in connections.drain(..) {
            let _ = stream.shutdown(Shutdown::Both);
        }
        dropped
    }
}

fn pipe(mut from: TcpStream, mut to: TcpStream) {
    thread::spawn(move || {
        let _ = io::copy(&mut from, &mut to);
        let _ = to.shutdown(Shutdown::Both);
    });
}

#[test]
#[ignore = "requires the disposable SSH server from ssh-pool-sftp-smoke.mjs"]
fn sftp_work_replaces_a_parked_connection_that_went_away() {
    let mut options: SshOptions =
        serde_json::from_str(&std::env::var("DURE_SSH_POOL_QA_SSH").unwrap()).unwrap();
    let repository = std::env::var("DURE_SSH_POOL_QA_REPOSITORY").unwrap();
    let upstream = (options.host.as_str(), options.port.unwrap_or(22))
        .to_socket_addrs()
        .unwrap()
        .next()
        .unwrap();
    let relay = Relay::start(upstream);
    options.host = "127.0.0.1".into();
    options.port = Some(relay.port);

    // The first call leaves an authenticated session parked for this target.
    let listing = directory::browse(&options, Some(&repository)).unwrap();
    assert_eq!(listing.path, repository);
    assert!(listing.is_repo);
    assert_eq!(relay.drop_connections(), 1, "one parked session");

    // libssh2 reports the dead socket under SFTP as a plain channel failure.
    // It must neither surface as the remote's answer nor stay in the pool.
    for attempt in 1..=2 {
        let listing = directory::browse(&options, Some(&repository))
            .unwrap_or_else(|error| panic!("browse attempt {attempt}: {error}"));
        assert_eq!(listing.path, repository);
    }
    let project = directory::project(&options, &repository).unwrap();
    assert_eq!(project.path, repository);
    assert!(project.is_repo);

    // The same holds when the parked session is reused by project lookup,
    // the step `dure runs open` takes to register the Run's remote project.
    assert_eq!(relay.drop_connections(), 1, "one parked session");
    let project = directory::project(&options, &repository).unwrap();
    assert_eq!(project.path, repository);
    println!("SSH pool SFTP: dead parked sessions were replaced by fresh connections");
}
