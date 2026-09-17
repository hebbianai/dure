//! Drives the real `hmux pair` binary with a stand-in phone.
//!
//! The subprocess and the socket are the point. The in-crate tests exercise the
//! decision function; this exercises the thing an actual phone will meet — the
//! QR payload it has to parse, the TCP port it has to reach, the proof it has
//! to compute, and the `authorized_keys` files that must still be correct
//! afterwards on two different machines.
//!
//! The HMAC here is written from RFC 2104 rather than imported from the crate
//! under test. A stand-in client that borrows the implementation it is meant to
//! check would agree with a wrong one; the phone half will be written from the
//! specification, so the stand-in is too.
//!
//! Against unmodified `main` every test here fails at spawn: `pair` is not a
//! subcommand, so clap exits 2 and no payload is ever printed.
#![cfg(unix)]

use base64::Engine as _;
use russh::keys::{Algorithm, PrivateKey};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const PROTOCOL_VERSION: u32 = 1;
const REMOTE_WIRE_PUBLIC_KEY_SEED: u8 = 6;

fn hmux() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_hmux"))
}

/// HMAC-SHA256, written from RFC 2104 so the stand-in checks rather than echoes.
fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let inner: Vec<u8> = block.iter().map(|byte| byte ^ 0x36).collect();
    let outer: Vec<u8> = block.iter().map(|byte| byte ^ 0x5c).collect();
    let mut first = Sha256::new();
    first.update(&inner);
    first.update(message);
    let first = first.finalize();
    let mut second = Sha256::new();
    second.update(&outer);
    second.update(first);
    second.finalize().to_vec()
}

/// Length-prefixed transcript, as documented in `pairing::token`.
fn transcript(label: &[u8], fields: &[&[u8]]) -> Vec<u8> {
    let mut encoded = Vec::new();
    for field in std::iter::once(&label).chain(fields.iter()) {
        encoded.extend_from_slice(&(field.len() as u64).to_be_bytes());
        encoded.extend_from_slice(field);
    }
    encoded
}

fn sample_public_key(seed: u8) -> String {
    let mut blob = Vec::new();
    blob.extend_from_slice(&(b"ssh-ed25519".len() as u32).to_be_bytes());
    blob.extend_from_slice(b"ssh-ed25519");
    blob.extend_from_slice(&32u32.to_be_bytes());
    blob.extend_from_slice(&[seed; 32]);
    format!(
        "ssh-ed25519 {} kattpish@phone",
        base64::engine::general_purpose::STANDARD.encode(&blob)
    )
}

fn fingerprint_of(public_key: &str) -> String {
    let blob = base64::engine::general_purpose::STANDARD
        .decode(public_key.split_whitespace().nth(1).unwrap())
        .unwrap();
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(blob))
    )
}

struct Fixture {
    root: tempfile::TempDir,
    laptop_ssh_port: u16,
    host_key_server: Mutex<Option<JoinHandle<()>>>,
}

impl Fixture {
    fn new() -> Self {
        Self::with_local_sshd(true)
    }

    fn remote_only() -> Self {
        Self::with_local_sshd(false)
    }

    fn with_local_sshd(start_sshd: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let public_key = host_key.public_key().to_openssh().unwrap();
        let (laptop_ssh_port, host_key_server) = if start_sshd {
            let (port, server) = start_host_key_server(host_key);
            (port, Some(server))
        } else {
            (0, None)
        };
        let fixture = Self {
            root,
            laptop_ssh_port,
            host_key_server: Mutex::new(host_key_server),
        };
        std::fs::create_dir_all(fixture.laptop_home().join(".ssh")).unwrap();
        std::fs::create_dir_all(fixture.remote_home().join(".ssh")).unwrap();
        std::fs::write(fixture.host_key(), format!("{public_key}\n")).unwrap();
        std::fs::write(
            fixture.inventory(),
            r#"{"version":3,"agents":[],"projects":[],"sshHosts":[
                {"id":"build","name":"build box","host":"build.example","port":22,
                 "user":"kattpish","auth":"auto"},
                {"id":"archive","name":"cold archive","host":"unreachable.example","port":22,
                 "user":"kattpish","auth":"auto"}]}"#,
        )
        .unwrap();
        fixture.write_ssh_stub();
        fixture
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    fn laptop_home(&self) -> PathBuf {
        self.path("laptop-home")
    }

    fn remote_home(&self) -> PathBuf {
        self.path("remote-home")
    }

    fn host_key(&self) -> PathBuf {
        self.path("ssh_host_ed25519_key.pub")
    }

    fn inventory(&self) -> PathBuf {
        self.path("agents.json")
    }

    fn devices(&self) -> PathBuf {
        self.path("paired-devices.json")
    }

    fn laptop_authorized_keys(&self) -> PathBuf {
        self.laptop_home().join(".ssh/authorized_keys")
    }

    fn remote_authorized_keys(&self) -> PathBuf {
        self.remote_home().join(".ssh/authorized_keys")
    }

    fn remote_wire_fingerprint(&self) -> String {
        fingerprint_of(&sample_public_key(REMOTE_WIRE_PUBLIC_KEY_SEED))
    }

    /// Stands in for `ssh`: reachable for `build.example`, timed out for
    /// `unreachable.example`, and it prints a login banner first so the receipt
    /// parser is exercised the way a real login shell exercises it.
    fn write_ssh_stub(&self) {
        let stub = self.path("ssh-stub.sh");
        std::fs::write(
            &stub,
            r#"#!/bin/sh
destination=""
mode=""
debug_log=""
identity_file=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "-E" ]; then
    debug_log="$argument"
  fi
  if [ "$previous" = "-i" ]; then
    identity_file="$argument"
  fi
  case "$argument" in
    *@*) destination="$argument" ;;
    *apply-authorized-key*) mode="apply-authorized-key" ;;
    *remove-authorized-key*) mode="remove-authorized-key" ;;
  esac
  previous="$argument"
done
if [ -n "$FAKE_EXPECT_IDENTITY_FILE" ] && [ "$mode" = "remove-authorized-key" ] && [ "$identity_file" != "$FAKE_EXPECT_IDENTITY_FILE" ]; then
  echo "Load key $identity_file: Operation not permitted" >&2
  exit 255
fi
case "$destination" in
  *@unreachable.example)
    echo "ssh: connect to host unreachable.example port 22: Operation timed out" >&2
    exit 255
    ;;
esac
if [ -n "$debug_log" ]; then
  printf 'debug1: Server host key: ssh-ed25519 %s\nAuthenticated to build.example using publickey.\ndebug1: Sending command: hmux pair %s\n' \
    "$FAKE_REMOTE_HOST_KEY_FINGERPRINT" "$mode" >> "$debug_log"
fi
echo "Welcome to build.example"
export HOME="$FAKE_REMOTE_HOME"
exec "$HMUX_UNDER_TEST" pair "$mode"
"#,
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn command(&self) -> Command {
        let mut command = Command::new(hmux());
        command
            .env("HOME", self.laptop_home())
            .env("HMUX_PAIRING_INVENTORY", self.inventory())
            .env("HMUX_PAIRING_DEVICES", self.devices())
            .env("HMUX_PAIRING_SSH", self.path("ssh-stub.sh"))
            .env("FAKE_REMOTE_HOME", self.remote_home())
            .env(
                "FAKE_REMOTE_HOST_KEY_FINGERPRINT",
                self.remote_wire_fingerprint(),
            )
            .env("HMUX_UNDER_TEST", hmux());
        command
    }

    fn start_pairing(&self) -> PairingProcess {
        self.start_pairing_with(&[])
    }

    fn start_pairing_with(&self, extra_args: &[&str]) -> PairingProcess {
        let mut child = self
            .command()
            .args([
                "pair",
                "start",
                "--address",
                "127.0.0.1",
                "--print-payload",
                "--port",
                "0",
                "--ttl-seconds",
                "30",
                "--host-key",
            ])
            .arg(self.host_key())
            .arg("--laptop-ssh-port")
            .arg(self.laptop_ssh_port.to_string())
            .args(extra_args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut payload = None;
        let mut line = String::new();
        while stdout.read_line(&mut line).unwrap() > 0 {
            if let Some(rest) = line.trim_end().strip_prefix("payload: ") {
                payload = Some(rest.to_string());
                break;
            }
            line.clear();
        }
        if let Some(server) = self.host_key_server.lock().unwrap().take() {
            server
                .join()
                .expect("the host-key server completed its handshake");
        }
        PairingProcess {
            child,
            stdout,
            payload: payload.expect("`hmux pair start` must print its payload"),
        }
    }
}

#[test]
fn remote_only_pairing_keeps_remote_hosts_and_omits_this_laptop() {
    let fixture = Fixture::remote_only();
    let pairing = fixture.start_pairing_with(&["--remote-only"]);
    let answer = pairing.request(&pairing.signed_request("kattpish phone", &sample_public_key(9)));

    let hosts = answer["hosts"].as_array().unwrap();
    let ids: Vec<&str> = hosts
        .iter()
        .filter_map(|host| host["id"].as_str())
        .collect();
    assert_eq!(ids, vec!["build", "archive"]);
    assert!(!fixture.laptop_authorized_keys().exists());

    let (success, _, stderr) = pairing.finish();
    assert!(success, "{stderr}");
}

#[derive(Clone, Copy)]
struct HostKeyServer;

impl russh::server::Handler for HostKeyServer {
    type Error = russh::Error;
}

/// One real SSH handshake, owned by this fixture. Pairing must learn the key
/// from the endpoint it advertises instead of from a parallel test seam.
fn start_host_key_server(host_key: PrivateKey) -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let server = thread::Builder::new()
        .name("pairing-host-key-server".into())
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
                .expect("pairing reached the host-key endpoint before the fixture deadline");
            });
        })
        .unwrap();
    (port, server)
}

struct PairingProcess {
    child: Child,
    stdout: BufReader<std::process::ChildStdout>,
    payload: String,
}

impl PairingProcess {
    fn fields(&self) -> BTreeMap<String, String> {
        let query = self
            .payload
            .strip_prefix("hmux-pair:1?")
            .expect("the payload names its scheme and version");
        query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn token(&self) -> Vec<u8> {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&self.fields()["t"])
            .expect("the token is base64url")
    }

    fn endpoint(&self) -> (String, u16) {
        let fields = self.fields();
        (fields["a"].clone(), fields["p"].parse().unwrap())
    }

    /// Sends one request as the phone would and returns the parsed answer.
    fn request(&self, body: &[u8]) -> serde_json::Value {
        let (address, port) = self.endpoint();
        let mut stream = TcpStream::connect((address.as_str(), port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        stream.write_all(body).unwrap();
        stream.write_all(b"\n").unwrap();
        let mut answer = String::new();
        BufReader::new(&stream).read_line(&mut answer).unwrap();
        serde_json::from_str(answer.trim()).unwrap_or_else(|error| {
            panic!("the answer was not JSON ({error}): {answer}");
        })
    }

    fn signed_request(&self, device_name: &str, public_key: &str) -> Vec<u8> {
        let nonce = [3u8; 16];
        let proof = hmac_sha256(
            &self.token(),
            &transcript(
                b"hmux-pairing-request-v1",
                &[
                    PROTOCOL_VERSION.to_string().as_bytes(),
                    device_name.as_bytes(),
                    public_key.as_bytes(),
                    &nonce,
                ],
            ),
        );
        serde_json::to_vec(&serde_json::json!({
            "version": PROTOCOL_VERSION,
            "device_name": device_name,
            "public_key": public_key,
            "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
            "proof": base64::engine::general_purpose::STANDARD.encode(proof),
        }))
        .unwrap()
    }

    fn unsigned_request(&self, device_name: &str, public_key: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": PROTOCOL_VERSION,
            "device_name": device_name,
            "public_key": public_key,
            "nonce": base64::engine::general_purpose::STANDARD.encode([3u8; 16]),
            "proof": base64::engine::general_purpose::STANDARD.encode([0u8; 32]),
        }))
        .unwrap()
    }

    /// Waits for the pairing window to close and returns its remaining output.
    fn finish(mut self) -> (bool, String, String) {
        let mut remaining = String::new();
        self.stdout.read_to_string(&mut remaining).ok();
        let mut stderr = String::new();
        self.child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .ok();
        let status = self.child.wait().unwrap();
        (status.success(), remaining, stderr)
    }

    fn kill(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_default()
}

#[test]
fn a_stand_in_phone_pairs_once_and_the_window_then_stops_accepting() {
    let fixture = Fixture::new();
    // A pre-existing key whose file has no trailing newline: the exact shape
    // that a naive append silently corrupts.
    let existing = b"ssh-ed25519 AAAAteammatekey teammate@laptop";
    std::fs::write(fixture.laptop_authorized_keys(), existing).unwrap();

    let pairing = fixture.start_pairing();
    let advertised_pin = pairing.fields()["f"].clone();
    std::fs::write(fixture.host_key(), format!("{}\n", sample_public_key(8))).unwrap();
    let answer = pairing.request(&pairing.signed_request("kattpish phone", &sample_public_key(1)));
    assert_eq!(answer["status"], "paired", "{answer}");

    // Every configured server is named, including the one that failed.
    let hosts = answer["hosts"].as_array().unwrap();
    let by_id: BTreeMap<&str, &serde_json::Value> = hosts
        .iter()
        .map(|host| (host["id"].as_str().unwrap(), host))
        .collect();
    assert_eq!(
        by_id.keys().copied().collect::<Vec<_>>(),
        vec!["archive", "build", "this-laptop"],
        "a host that failed must be named, not omitted: {answer}"
    );
    assert_eq!(by_id["this-laptop"]["installed"], true);
    assert_eq!(by_id["build"]["installed"], true);
    assert_eq!(by_id["archive"]["installed"], false);
    let remote_wire_fingerprint = fixture.remote_wire_fingerprint();
    assert_eq!(
        by_id["build"]["host_key_fingerprint"].as_str(),
        Some(remote_wire_fingerprint.as_str()),
        "the remote row must pin the key from its system-ssh connection"
    );
    assert!(
        by_id["archive"]["failure"]
            .as_str()
            .unwrap()
            .contains("unreachable.example"),
        "the failure must say which server and why: {answer}"
    );
    let stored_pin = by_id["this-laptop"]["host_key_fingerprint"]
        .as_str()
        .expect("this laptop stores the pin advertised in the QR")
        .strip_prefix("SHA256:")
        .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(stored_pin)
            .unwrap(),
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(advertised_pin)
            .unwrap(),
        "QR and receipt must remain projections of one observation after the source file changes"
    );

    // The teammate's key survived byte-for-byte, on its own line.
    let laptop = read(&fixture.laptop_authorized_keys());
    assert!(
        laptop.starts_with(existing),
        "the pre-existing bytes must be a prefix: {}",
        String::from_utf8_lossy(&laptop)
    );
    let laptop_text = String::from_utf8(laptop).unwrap();
    let mut lines = laptop_text.lines();
    assert_eq!(
        lines.next().unwrap(),
        "ssh-ed25519 AAAAteammatekey teammate@laptop"
    );
    let installed = lines.next().expect("the new entry is its own line");
    let (options, _) = installed.split_once(" ssh-ed25519 ").unwrap();
    assert!(options.contains("command=\""), "{installed}");
    assert!(options.contains("restrict"), "{installed}");

    // The reachable server got the identical line, through the real ssh path.
    let remote = String::from_utf8(read(&fixture.remote_authorized_keys())).unwrap();
    assert_eq!(remote.lines().count(), 1);
    assert_eq!(remote.lines().next().unwrap(), installed);

    // Single use, observable from outside: the port is gone.
    let (address, port) = pairing.endpoint();
    let (success, report, _) = pairing.finish();
    assert!(success, "{report}");
    assert!(
        report.contains("cold archive"),
        "the report names the failure: {report}"
    );
    assert!(
        TcpStream::connect((address.as_str(), port)).is_err(),
        "a spent pairing window must stop accepting"
    );
}

#[test]
fn a_request_without_the_token_installs_nothing_and_leaves_the_window_open() {
    let fixture = Fixture::new();
    let pairing = fixture.start_pairing();

    let refusal = pairing.request(&pairing.unsigned_request("stranger", &sample_public_key(2)));
    assert_eq!(refusal["status"], "refused", "{refusal}");
    assert_eq!(refusal["reason"], "pairing_proof_rejected");
    assert!(
        read(&fixture.laptop_authorized_keys()).is_empty(),
        "an unproven request must install nothing on this laptop"
    );
    assert!(
        read(&fixture.remote_authorized_keys()).is_empty(),
        "an unproven request must install nothing on any server"
    );
    assert!(
        !fixture.devices().exists(),
        "an unproven request must not be recorded either"
    );

    // The owner's own scan still works: one junk packet must not burn the QR.
    let answer = pairing.request(&pairing.signed_request("kattpish phone", &sample_public_key(2)));
    assert_eq!(answer["status"], "paired", "{answer}");
    pairing.finish();
}

#[test]
fn a_request_carrying_a_private_key_is_refused_and_nothing_is_written() {
    let fixture = Fixture::new();
    let pairing = fixture.start_pairing();

    let private = "-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAAA\\n-----END OPENSSH PRIVATE KEY-----";
    let refusal = pairing.request(&pairing.signed_request("kattpish phone", private));
    assert_eq!(refusal["status"], "refused", "{refusal}");
    assert_eq!(refusal["reason"], "private_key_material");
    assert!(read(&fixture.laptop_authorized_keys()).is_empty());
    assert!(read(&fixture.remote_authorized_keys()).is_empty());
    assert!(!fixture.devices().exists());
    pairing.kill();
}

#[test]
fn revoking_a_device_removes_its_exact_line_from_every_recorded_host() {
    let fixture = Fixture::new();
    let teammate = "ssh-ed25519 AAAAteammatekey teammate@laptop\n";
    std::fs::write(fixture.laptop_authorized_keys(), teammate).unwrap();
    std::fs::write(fixture.remote_authorized_keys(), teammate).unwrap();

    let pairing = fixture.start_pairing();
    let answer = pairing.request(&pairing.signed_request("lost phone", &sample_public_key(4)));
    let device_id = answer["device_id"].as_str().unwrap().to_string();
    pairing.finish();

    let listed = fixture.command().args(["pair", "list"]).output().unwrap();
    let listed = String::from_utf8(listed.stdout).unwrap();
    assert!(listed.contains(&device_id), "{listed}");
    assert!(listed.contains("lost phone"), "{listed}");

    let revoked = fixture
        .command()
        .args(["pair", "revoke", &device_id])
        .output()
        .unwrap();
    let report = String::from_utf8(revoked.stdout).unwrap();
    assert!(report.contains("unreachable.example"), "{report}");
    assert!(
        !revoked.status.success(),
        "a revocation that could not reach every host must not report success"
    );

    // The key is gone from the hosts that answered, and every other line is
    // exactly where it was.
    assert_eq!(
        String::from_utf8(read(&fixture.laptop_authorized_keys())).unwrap(),
        teammate
    );
    assert_eq!(
        String::from_utf8(read(&fixture.remote_authorized_keys())).unwrap(),
        teammate
    );

    // The record is kept so the unreachable server can be retried, and dropped
    // only when the owner says so.
    let still_listed = fixture.command().args(["pair", "list"]).output().unwrap();
    assert!(
        String::from_utf8(still_listed.stdout)
            .unwrap()
            .contains(&device_id)
    );
    let forgotten = fixture
        .command()
        .args(["pair", "revoke", &device_id, "--forget-unreachable"])
        .output()
        .unwrap();
    assert!(forgotten.status.success());
    let after = fixture.command().args(["pair", "list"]).output().unwrap();
    assert!(
        !String::from_utf8(after.stdout)
            .unwrap()
            .contains(&device_id)
    );
}

#[test]
fn revocation_uses_the_current_credential_for_the_same_recorded_endpoint() {
    let fixture = Fixture::new();
    let old_key = fixture.path("old-key.pem");
    let current_key = fixture.path("current-key.pem");
    std::fs::write(&old_key, b"old").unwrap();
    std::fs::write(&current_key, b"current").unwrap();
    std::fs::write(
        fixture.inventory(),
        serde_json::to_vec(&serde_json::json!({
            "version": 3,
            "agents": [],
            "projects": [],
            "sshHosts": [{
                "id": "build",
                "name": "build box",
                "host": "build.example",
                "port": 22,
                "user": "kattpish",
                "auth": "key",
                "keyPath": old_key,
            }],
        }))
        .unwrap(),
    )
    .unwrap();

    let pairing = fixture.start_pairing();
    let answer = pairing.request(&pairing.signed_request("moved key phone", &sample_public_key(7)));
    let device_id = answer["device_id"].as_str().unwrap().to_string();
    pairing.finish();

    std::fs::write(
        fixture.inventory(),
        serde_json::to_vec(&serde_json::json!({
            "version": 3,
            "agents": [],
            "projects": [],
            "sshHosts": [{
                "id": "build",
                "name": "build box",
                "host": "build.example",
                "port": 22,
                "user": "kattpish",
                "auth": "key",
                "keyPath": current_key,
            }],
        }))
        .unwrap(),
    )
    .unwrap();

    let revoked = fixture
        .command()
        .env("FAKE_EXPECT_IDENTITY_FILE", &current_key)
        .args(["pair", "revoke", &device_id, "--inventory"])
        .arg(fixture.inventory())
        .output()
        .unwrap();

    assert!(
        revoked.status.success(),
        "revocation did not use the current credential: {}",
        String::from_utf8_lossy(&revoked.stderr)
    );
    assert!(
        !fixture.devices().exists()
            || !String::from_utf8(read(&fixture.devices()))
                .unwrap()
                .contains(&device_id)
    );
}
