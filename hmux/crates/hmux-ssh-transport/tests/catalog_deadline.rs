use hmux_ssh_transport::{
    HostKeyPolicy, SshAuthentication, SshEndpoint, SshExecConfig, list_sessions_over_ssh,
    list_sessions_with_facts_over_ssh,
};
use std::io::Read;
use std::net::TcpListener;
use std::thread;
use std::time::{Duration, Instant};

fn silent_peer() -> (SshExecConfig, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let config = SshExecConfig::new(
        SshEndpoint {
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
        },
        "catalog-deadline-fixture",
        SshAuthentication::Password("unused-fixture-secret".into()),
        HostKeyPolicy::pinned(["SHA256:unused-fixture-key".into()]),
    );
    let peer = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = [0; 256];
        while matches!(stream.read(&mut bytes), Ok(n) if n > 0) {}
    });
    (config, peer)
}

fn catalog_budget_includes_handshake(facts: bool) {
    let (mut config, peer) = silent_peer();
    config.connect_timeout = Duration::from_secs(2);
    let started = Instant::now();
    let result = if facts {
        list_sessions_with_facts_over_ssh(config, Duration::from_millis(100))
    } else {
        list_sessions_over_ssh(config, Duration::from_millis(100))
    };
    let elapsed = started.elapsed();
    peer.join().unwrap();
    assert_eq!(result.unwrap_err().code(), "hmux_ssh_timed_out");
    assert!(
        elapsed < Duration::from_secs(1),
        "catalog waited {elapsed:?}"
    );
}

#[test]
fn legacy_catalog_budget_includes_handshake() {
    catalog_budget_includes_handshake(false);
}

#[test]
fn facts_catalog_budget_includes_handshake() {
    catalog_budget_includes_handshake(true);
}

#[test]
fn shorter_catalog_deadline_does_not_wait_for_another_callers_handshake() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut config = SshExecConfig::new(
        SshEndpoint {
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
        },
        "shared-deadline-fixture",
        SshAuthentication::Password("unused-fixture-secret".into()),
        HostKeyPolicy::pinned(["SHA256:unused-fixture-key".into()]),
    );
    config.connect_timeout = Duration::from_secs(2);
    let (accepted, ready) = std::sync::mpsc::sync_channel(1);
    let peer = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        accepted.send(()).unwrap();
        let mut bytes = [0; 256];
        while matches!(stream.read(&mut bytes), Ok(n) if n > 0) {}
    });
    let other_config = config.clone();
    let other = thread::spawn(move || list_sessions_over_ssh(other_config, Duration::from_secs(2)));
    ready.recv_timeout(Duration::from_secs(2)).unwrap();
    let started = Instant::now();
    let result = list_sessions_with_facts_over_ssh(config, Duration::from_millis(100));
    let elapsed = started.elapsed();
    assert!(other.join().unwrap().is_err());
    peer.join().unwrap();
    assert_eq!(result.unwrap_err().code(), "hmux_ssh_timed_out");
    assert!(
        elapsed < Duration::from_secs(1),
        "catalog waited for another caller: {elapsed:?}"
    );
}
