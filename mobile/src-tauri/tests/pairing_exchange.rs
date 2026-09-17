//! The phone half of pairing against the **real** `hmux pair start` process.
//!
//! # Why this test drives a subprocess instead of a fake laptop
//!
//! The failure this module set exists to prevent is a transcript mismatch: an
//! HMAC computed over a different byte layout is refused as
//! `pairing_proof_rejected`, which reads like a spent QR, a wrong clock, or a
//! stranger on the LAN — anything except "the two sides disagree about field
//! order". A hand-written fake laptop cannot catch that, because it would be
//! written from the same reading of `hmux-cli/src/pairing/` that produced the
//! client, and the two would agree while both were wrong.
//!
//! The exchange itself is plain TCP. A one-handshake russh fixture exists only
//! for the host's mandatory SSH-key observation, so the QR pin comes from an
//! endpoint this test owns instead of the developer's sshd.
//!
//! What is checked here, against the binary that actually shipped:
//!
//! 1. a proof this client computes is **accepted**, and the host's answer proof
//!    verifies here;
//! 2. a proof over the *wrong* token is **refused** by that same live process,
//!    with the host's own `pairing_proof_rejected` reason — so (1) is not
//!    passing because nothing is being checked;
//! 3. after a successful pairing the port stops accepting, which is the
//!    single-use property observed from outside;
//! 4. what the laptop actually wrote is one `authorized_keys` line carrying both
//!    `command="…"` and `restrict`, holding this device's **public** key and no
//!    private key material.
//!
//! # Nothing here touches the developer's own machine
//!
//! `hmux pair` resolves its device registry, its inventory and (for the laptop's
//! own row) the `authorized_keys` it edits from `$HOME`. The child gets a
//! temporary `$HOME`, plus `HMUX_PAIRING_DEVICES` and `HMUX_PAIRING_INVENTORY`
//! pointed inside it, so the real `~/.ssh/authorized_keys` and the real paired
//! device registry are never opened. The inventory lists no remote servers, so
//! nothing here can spawn `ssh` at anything: the only row is the laptop itself,
//! applied in-process against the temporary home. Host-key observation dials the
//! owned loopback fixture on its random port.

use base64::Engine as _;
use dure_mobile_lib::{device_key, pairing, relay};
use russh::keys::{Algorithm, HashAlg, PrivateKey};
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// How long the child gets to render the QR and print its payload.
const STARTUP_BUDGET: Duration = Duration::from_secs(60);

/// A running pairing window, killed on drop.
///
/// Not politeness: `hmux pair start` holds a listening socket until its TTL
/// expires, and a test that fails an assertion partway would otherwise leak one
/// per run.
struct PairingHost {
    child: Child,
    payload: String,
    home: tempfile::TempDir,
}

impl Drop for PairingHost {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The `hmux` binary under test.
///
/// Looked up rather than assumed present, and **built** when it is missing:
/// `pnpm verify:release` runs Hmux tests before the mobile Rust scope, so inside
/// the gate this is already a cache hit. Building rather than skipping is
/// deliberate — a skipped test that reports success is exactly the evidence gap
/// this file exists to close.
fn hmux_binary() -> PathBuf {
    if let Some(explicit) = std::env::var_os("HMUX_PAIR_BIN") {
        return PathBuf::from(explicit);
    }
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("hmux");
    let external_target = std::env::var_os("CARGO_TARGET_DIR");
    let target = hmux_target_root(&workspace, external_target.as_deref());
    for profile in ["debug", "release"] {
        let candidate = target
            .join(profile)
            .join(format!("hmux{}", std::env::consts::EXE_SUFFIX));
        if candidate.exists() {
            return candidate;
        }
    }
    let built = Command::new(env!("CARGO"))
        .arg("build")
        .arg("--manifest-path")
        .arg(workspace.join("Cargo.toml"))
        .arg("-p")
        .arg("hmux-cli")
        .arg("--bin")
        .arg("hmux")
        .status()
        .expect("build the hmux binary this test pairs against");
    assert!(built.success(), "could not build hmux-cli");
    let binary = target
        .join("debug")
        .join(format!("hmux{}", std::env::consts::EXE_SUFFIX));
    assert!(
        binary.exists(),
        "Cargo reported success without producing {}",
        binary.display()
    );
    binary
}

fn hmux_target_root(workspace: &Path, external: Option<&std::ffi::OsStr>) -> PathBuf {
    external
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.join("target"))
}

#[derive(Clone, Copy)]
struct HostKeyServer;

impl russh::server::Handler for HostKeyServer {
    type Error = russh::Error;
}

/// One real handshake owned by this test, isolated from the developer's sshd.
fn start_host_key_server(host_key: PrivateKey) -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind host-key server");
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let server = thread::Builder::new()
        .name("mobile-pairing-host-key-server".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                tokio::time::timeout(Duration::from_secs(5), async move {
                    let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                    let (stream, _) = listener.accept().await.unwrap();
                    let config = Arc::new(russh::server::Config {
                        keys: vec![host_key],
                        ..russh::server::Config::default()
                    });
                    let session = russh::server::run_stream(config, stream, HostKeyServer)
                        .await
                        .unwrap();
                    let _ = session.await;
                })
                .await
                .expect("pairing reached its owned SSH endpoint");
            });
        })
        .unwrap();
    (port, server)
}

/// Adding a host by hand pins whatever key the address answers with, and this
/// is the read that learns it: a real handshake against a server the phone has
/// never seen, refused by a policy that pins nothing, with the refusal naming
/// the key. A stub that returned any well-formed `SHA256:` string would satisfy
/// the shape check in `ssh_config` and pin a key nobody offered.
#[test]
fn a_typed_in_host_has_its_key_learned_from_a_real_handshake() {
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let expected = host_key
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();
    let (port, server) = start_host_key_server(host_key);
    let device = device_key::generate(device_key::DEVICE_KEY_COMMENT).expect("device key");

    let learned = relay::learn_host_key(
        "127.0.0.1",
        port,
        "phone",
        relay::RelayCredential::PrivateKey {
            openssh_pem: device.private_openssh.to_string(),
            passphrase: None,
        },
    )
    .expect("the handshake names the key it was offered");

    assert_eq!(learned, expected);
    server.join().expect("host-key server thread");
}

#[test]
fn the_real_hmux_binary_follows_an_isolated_cargo_target() {
    let workspace = Path::new("/checkout/hmux");

    assert_eq!(
        hmux_target_root(workspace, Some(std::ffi::OsStr::new("/runner/target"))),
        PathBuf::from("/runner/target")
    );
    assert_eq!(hmux_target_root(workspace, None), workspace.join("target"));
}

/// Starts a real pairing window and returns once it has printed its QR payload.
fn start_pairing_host() -> PairingHost {
    let home = tempfile::tempdir().expect("temp home");
    let hmux = hmux_binary();
    let host_key = home.path().join("ssh_host_ed25519_key.pub");
    let private_host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    std::fs::write(
        &host_key,
        format!("{}\n", private_host_key.public_key().to_openssh().unwrap()),
    )
    .expect("write the observed host key");
    let (laptop_ssh_port, host_key_server) = start_host_key_server(private_host_key);
    let inventory = home.path().join("agents.json");
    // `Some(vec![])`, not an absent array: the host refuses the latter by design,
    // and an empty list is the honest statement "this laptop has no servers
    // configured" — which leaves exactly the laptop's own row.
    std::fs::write(&inventory, r#"{"sshHosts":[]}"#).expect("write the inventory");

    let mut child = Command::new(hmux)
        .arg("pair")
        .arg("start")
        .arg("--address")
        .arg("127.0.0.1")
        // 0 asks the OS for a free port. Choosing one here and hoping would be a
        // race against every other test on the machine.
        .arg("--port")
        .arg("0")
        .arg("--ttl-seconds")
        .arg("120")
        .arg("--laptop-ssh-port")
        .arg(laptop_ssh_port.to_string())
        .arg("--host-key")
        .arg(&host_key)
        .arg("--inventory")
        .arg(&inventory)
        .arg("--print-payload")
        .env("HOME", home.path())
        .env("HMUX_PAIRING_DEVICES", home.path().join("paired.json"))
        .env("HMUX_PAIRING_INVENTORY", &inventory)
        // Belt and braces: if a future change ever puts a remote row in this
        // inventory, the ssh hop fails loudly instead of reaching a real machine.
        .env("HMUX_PAIRING_SSH", "/nonexistent/ssh")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn hmux pair start");

    let stdout = child.stdout.take().expect("child stdout");
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(payload) = line.strip_prefix("payload: ") {
                let _ = sender.send(payload.to_string());
                return;
            }
        }
    });

    match receiver.recv_timeout(STARTUP_BUDGET) {
        Ok(payload) => {
            host_key_server.join().expect("host-key server thread");
            PairingHost {
                child,
                payload,
                home,
            }
        }
        Err(error) => {
            let _ = child.kill();
            let output = child.wait_with_output().expect("child output");
            panic!(
                "hmux pair start never printed its payload ({error}): {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}

/// Replaces the QR's token with a different, well-formed one.
fn with_a_different_token(payload: &str) -> String {
    let (prefix, query) = payload.split_once('?').expect("a query");
    let fields: Vec<String> = query
        .split('&')
        .map(|field| {
            if field.starts_with("t=") {
                format!(
                    "t={}",
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0xABu8; 32])
                )
            } else {
                field.to_string()
            }
        })
        .collect();
    format!("{prefix}?{}", fields.join("&"))
}

fn authorized_keys(home: &Path) -> String {
    std::fs::read_to_string(home.join(".ssh").join("authorized_keys")).unwrap_or_default()
}

/// The whole point, in one test: a live `hmux pair start` refuses a proof over
/// the wrong token and accepts the one this client computes, and the answer it
/// signs verifies here.
///
/// Both halves run against the **same process**, in this order, because a
/// rejected proof deliberately does not burn the token
/// (`token::PairingSession::redeem`). Checking the refusal against a separate
/// window would let an implementation that accepted everything still pass the
/// acceptance half.
#[test]
fn a_real_pairing_window_refuses_a_wrong_proof_and_accepts_the_right_one() {
    let host = start_pairing_host();
    assert!(
        host.payload.split('&').any(|field| field == "rp=2"),
        "a current host must advertise the proof that authenticates SSH pins: {}",
        host.payload
    );
    let device = device_key::generate(device_key::DEVICE_KEY_COMMENT).expect("device key");

    let impostor = pairing::parse_invitation(&with_a_different_token(&host.payload))
        .expect("the payload is still well-formed with a substituted token");
    let refusal = pairing::enroll(&impostor, "wrong token phone", &device.public_openssh)
        .expect_err("a proof over the wrong token must be refused");
    assert_eq!(
        refusal.code(),
        "pairing_proof_rejected",
        "the live host must reject this, not merely fail to answer: {refusal}"
    );
    assert!(
        authorized_keys(host.home.path()).is_empty(),
        "a refused request must not have installed anything"
    );

    let invitation = pairing::parse_invitation(&host.payload).expect("parse the real payload");
    pairing::refuse_if_expired(&invitation, std::time::SystemTime::now())
        .expect("a freshly printed QR is not expired");
    let answer = pairing::enroll(&invitation, "내 폰", &device.public_openssh)
        .expect("the real host must accept a proof this client computed");

    assert!(!answer.device_id.is_empty());
    assert_eq!(
        answer.hosts.len(),
        1,
        "the inventory listed no remote servers, so only the laptop row is expected"
    );
    let laptop = &answer.hosts[0];
    assert!(laptop.installed, "{:?}", laptop.failure);
    assert_eq!(laptop.host, "127.0.0.1");

    // What the laptop actually wrote, asserted on the file rather than on the
    // answer — the answer is only what the laptop *says* it did.
    let line = authorized_keys(host.home.path());
    let (options, key) = line
        .trim()
        .split_once(" ssh-ed25519 ")
        .expect("an options field followed by the key");
    assert!(options.contains("command=\""), "{line}");
    assert!(
        options.contains("restrict"),
        "without restrict the entry is a port-forwarding pivot: {line}"
    );
    let installed_body = key.split_whitespace().next().expect("key body");
    assert!(
        device.public_openssh.contains(installed_body),
        "the installed line must carry this device's own public key: {line}"
    );
    assert!(!line.contains("PRIVATE"), "{line}");
    assert!(!line.contains("BEGIN"), "{line}");
}

/// A successful pairing closes the window immediately. Observed from outside as
/// the port ceasing to accept, which is the only thing a phone could ever check
/// and the property that makes a photographed QR worthless.
#[test]
fn a_spent_pairing_window_stops_accepting() {
    let host = start_pairing_host();
    let device = device_key::generate(device_key::DEVICE_KEY_COMMENT).expect("device key");
    let invitation = pairing::parse_invitation(&host.payload).expect("parse");

    pairing::enroll(&invitation, "first", &device.public_openssh).expect("the first scan pairs");

    let second = pairing::parse_invitation(&host.payload).expect("parse");
    let error = pairing::enroll(&second, "second", &device.public_openssh)
        .expect_err("the window must be gone");

    // Either the socket is already closed (connect refused) or the process is
    // mid-exit and closes without answering. Both mean "that QR is spent"; what
    // must never happen is a second successful pairing.
    assert!(
        matches!(
            error,
            pairing::PairingError::Connect { .. } | pairing::PairingError::Io { .. }
        ),
        "unexpected error: {error:?}"
    );
}
