//! The laptop half, driven by a stand-in client.
//!
//! Every test here fails without the guard it names — the private-key refusal,
//! the single-use token, the byte-preserving append, the restrict option, and
//! the rule that a failed host is named rather than dropped. `tests/pairing.rs`
//! runs the same shape against the real binary over a real socket; these run
//! against the decision function so a failure points at one branch.

use super::*;
use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Write as _};
use std::net::TcpStream;
use std::sync::Mutex;

mod deadline;

/// The public key a stand-in phone offers.
fn phone_public_key() -> String {
    let mut blob = Vec::new();
    blob.extend_from_slice(&(b"ssh-ed25519".len() as u32).to_be_bytes());
    blob.extend_from_slice(b"ssh-ed25519");
    blob.extend_from_slice(&32u32.to_be_bytes());
    blob.extend_from_slice(&[42u8; 32]);
    format!(
        "ssh-ed25519 {} kattpish@phone",
        base64::engine::general_purpose::STANDARD.encode(&blob)
    )
}

/// Builds the request a phone sends, proving the token exactly as the phone
/// half will have to. Nothing here reaches into the session's internals — it
/// uses the same public proof routine.
fn signed_request(token: &PairingToken, device_name: &str, public_key: &str) -> Vec<u8> {
    let nonce = [9u8; 16];
    let transcript =
        RequestTranscript::new(PAIRING_PROTOCOL_VERSION, device_name, public_key, &nonce);
    let request = PairingRequest {
        version: PAIRING_PROTOCOL_VERSION,
        device_name: device_name.to_string(),
        public_key: public_key.to_string(),
        nonce: base64::engine::general_purpose::STANDARD.encode(nonce),
        proof: base64::engine::general_purpose::STANDARD.encode(token.request_proof(&transcript)),
    };
    serde_json::to_vec(&request).unwrap()
}

/// A request whose proof is junk — the "no token" case.
fn unsigned_request(device_name: &str, public_key: &str) -> Vec<u8> {
    let request = PairingRequest {
        version: PAIRING_PROTOCOL_VERSION,
        device_name: device_name.to_string(),
        public_key: public_key.to_string(),
        nonce: base64::engine::general_purpose::STANDARD.encode([9u8; 16]),
        proof: base64::engine::general_purpose::STANDARD.encode([0u8; 32]),
    };
    serde_json::to_vec(&request).unwrap()
}

fn remote_host(id: &str, name: &str) -> InventoryHost {
    InventoryHost {
        id: id.into(),
        name: name.into(),
        host: format!("{id}.example"),
        port: 22,
        user: "kattpish".into(),
        auth: "auto".into(),
        key_path: None,
        target: HostTarget::Remote(SshInvocation::Explicit),
    }
}

fn recorded_remote_host(key_path: &str) -> PairedHostRecord {
    PairedHostRecord {
        id: "build".into(),
        name: "build box".into(),
        host: "build.example".into(),
        port: 22,
        user: "kattpish".into(),
        auth: "key".into(),
        key_path: Some(key_path.into()),
        ssh_config_alias: None,
        host_key_fingerprint: Some("SHA256:recorded".into()),
        this_laptop: false,
        installed: true,
        failure: None,
    }
}

#[test]
fn current_credentials_refresh_only_for_the_recorded_endpoint() {
    let record = recorded_remote_host("/old-key.pem");
    let mut current = remote_host("build", "renamed build box");
    current.auth = "key".into();
    current.key_path = Some("/current-key.pem".into());

    assert_eq!(
        revocation_host(&record, Some(&[current.clone()]))
            .key_path
            .as_deref(),
        Some("/current-key.pem")
    );

    current.host = "replacement.example".into();
    assert_eq!(
        revocation_host(&record, Some(&[current]))
            .key_path
            .as_deref(),
        Some("/old-key.pem"),
        "a reused row id must not retarget a destructive action"
    );
}

/// Records what reached each host, and fails the hosts it was told to fail.
#[derive(Default)]
struct ScriptedInstaller {
    installed: Mutex<BTreeMap<String, String>>,
    failing: Vec<String>,
    /// Asserted at install time: the revocation record must already be durable.
    registry_path: Option<PathBuf>,
    /// Makes only the replaceable post-mutation projection unwritable.
    break_registry_after_mutation: bool,
}

impl ScriptedInstaller {
    fn failing(hosts: &[&str]) -> Self {
        Self {
            failing: hosts.iter().map(|host| (*host).to_string()).collect(),
            ..Self::default()
        }
    }

    fn entries(&self) -> BTreeMap<String, String> {
        self.installed.lock().unwrap().clone()
    }
}

impl AuthorizedKeyInstaller for ScriptedInstaller {
    fn install(
        &self,
        host: &InventoryHost,
        entry: &str,
        _deadline: Option<Instant>,
        before_mutation: &mut dyn FnMut(&str) -> Result<(), String>,
    ) -> Result<bool, String> {
        if let Some(path) = &self.registry_path {
            let recorded: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).unwrap_or_default())
                    .expect("the revocation record must exist before the first destructive edit");
            let entries: Vec<&str> = recorded["devices"]
                .as_array()
                .expect("the record lists devices")
                .iter()
                .filter_map(|device| device["authorized_keys_entry"].as_str())
                .collect();
            assert!(
                entries.contains(&entry),
                "the exact line about to be written must already be recorded, got {entries:?}"
            );
        }
        if self.failing.contains(&host.id) {
            return Err("network is unreachable".into());
        }
        before_mutation("SHA256:remotefingerprint")?;
        if let Some(path) = &self.registry_path {
            let recorded: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            let persisted = recorded["devices"][0]["hosts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|record| record["id"] == host.id)
                .unwrap();
            assert_eq!(
                persisted["host_key_fingerprint"], "SHA256:remotefingerprint",
                "the endpoint identity must be durable before the fake mutation"
            );
        }
        self.installed
            .lock()
            .unwrap()
            .insert(host.id.clone(), entry.to_string());
        if self.break_registry_after_mutation {
            let path = self
                .registry_path
                .as_ref()
                .expect("a registry path is required to break its projection");
            std::fs::remove_file(path).unwrap();
            std::fs::create_dir(path).unwrap();
        }
        Ok(true)
    }

    fn revoke(
        &self,
        host: &InventoryHost,
        _entry: &str,
        _expected_host_key_fingerprint: Option<&str>,
    ) -> Result<bool, String> {
        if self.failing.contains(&host.id) {
            return Err("network is unreachable".into());
        }
        Ok(self.installed.lock().unwrap().remove(&host.id).is_some())
    }
}

struct Harness {
    _directory: tempfile::TempDir,
    session: PairingSession,
    registry: DeviceRegistryLease,
    hosts: Vec<InventoryHost>,
}

impl Harness {
    fn new(hosts: Vec<InventoryHost>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let registry =
            DeviceRegistry::acquire(directory.path().join("paired-devices.json"), None).unwrap();
        Self {
            session: PairingSession::new(
                PairingToken::generate(),
                SystemTime::now(),
                Duration::from_secs(120),
            ),
            registry,
            hosts,
            _directory: directory,
        }
    }

    fn handle<I: AuthorizedKeyInstaller>(&mut self, installer: &I, raw: &[u8]) -> PairingResponse {
        self.handle_under(installer, raw, None)
    }

    fn handle_under<I: AuthorizedKeyInstaller>(
        &mut self,
        installer: &I,
        raw: &[u8],
        device_id: Option<&str>,
    ) -> PairingResponse {
        handle_request(
            &mut self.session,
            &self.hosts,
            PairingTerms {
                forced_command: entry::DEFAULT_FORCED_COMMAND,
                device_id,
            },
            installer,
            &mut self.registry,
            raw,
            SystemTime::now(),
        )
    }
}

#[test]
fn an_unrecordable_endpoint_identity_prevents_the_mutation() {
    let installer = ScriptedInstaller::default();
    let host = remote_host("build", "build box");
    let error = installer
        .install(&host, "pairing-entry", None, &mut |_| {
            Err("registry became unwritable".into())
        })
        .unwrap_err();

    assert!(error.contains("registry became unwritable"), "{error}");
    assert!(installer.entries().is_empty());
}

fn refusal(response: &PairingResponse) -> &hmux_client::online_pairing::Refusal {
    match response {
        PairingResponse::Refused(refusal) => refusal,
        PairingResponse::Paired(_) => panic!("expected a refusal, got a pairing"),
    }
}

fn paired(response: PairingResponse) -> PairedAnswer {
    match response {
        PairingResponse::Paired(answer) => answer,
        PairingResponse::Refused(refusal) => {
            panic!(
                "expected a pairing, got {} ({})",
                refusal.reason, refusal.detail
            )
        }
    }
}

#[test]
fn pairing_succeeds_once_and_the_same_token_is_refused_the_second_time() {
    let mut harness = Harness::new(vec![remote_host("build", "build box")]);
    let installer = ScriptedInstaller::default();
    let request = signed_request(harness.session.token(), "phone", &phone_public_key());

    let first = harness.handle(&installer, &request);
    assert!(matches!(first, PairingResponse::Paired(_)));
    assert_eq!(installer.entries().len(), 1);

    let second = harness.handle(&installer, &request);
    assert_eq!(refusal(&second).reason, "pairing_token_already_used");
    assert_eq!(
        installer.entries().len(),
        1,
        "a replayed request must not install a second time"
    );
}

#[test]
fn a_request_without_the_token_installs_nothing_on_any_host() {
    let mut harness = Harness::new(vec![
        remote_host("build", "build box"),
        remote_host("staging", "staging"),
    ]);
    let installer = ScriptedInstaller::default();

    let response = harness.handle(
        &installer,
        &unsigned_request("stranger", &phone_public_key()),
    );
    assert_eq!(refusal(&response).reason, "pairing_proof_rejected");
    assert!(
        installer.entries().is_empty(),
        "nothing may be installed anywhere without a proof of the token"
    );
    assert!(
        harness.registry.devices().is_empty(),
        "an unproven request must not even be recorded"
    );

    // And the token still works afterwards, so one junk packet cannot deny the
    // owner the QR they are looking at.
    let request = signed_request(harness.session.token(), "phone", &phone_public_key());
    let response = harness.handle(&installer, &request);
    assert!(matches!(response, PairingResponse::Paired(_)));
}

#[test]
fn a_verified_request_that_outlives_the_registry_wait_mutates_nothing() {
    let now = UNIX_EPOCH + Duration::from_secs(1_000);
    let mut session = PairingSession::new(PairingToken::generate(), now, Duration::from_secs(1));
    let request = signed_request(session.token(), "phone", &phone_public_key());
    let verified = match verify_request(
        &mut session,
        &request,
        now,
        Instant::now() + PAIRING_EXCHANGE_BUDGET,
    ) {
        Ok(verified) => verified,
        Err(_) => panic!("the request is valid before the simulated lease wait"),
    };
    let directory = tempfile::tempdir().unwrap();
    let mut registry =
        DeviceRegistry::acquire(directory.path().join("devices.json"), None).unwrap();
    let installer = ScriptedInstaller::default();
    let hosts = vec![remote_host("build", "build box")];

    let response = complete_after_lease(
        &session,
        &hosts,
        PairingTerms {
            forced_command: entry::DEFAULT_FORCED_COMMAND,
            device_id: None,
        },
        &installer,
        &mut registry,
        verified,
        now + Duration::from_secs(2),
    );

    assert_eq!(refusal(&response).reason, "pairing_token_expired");
    assert!(registry.devices().is_empty());
    assert!(installer.entries().is_empty());
}

#[test]
fn a_request_carrying_a_private_key_is_refused_and_installs_nothing() {
    let mut harness = Harness::new(vec![remote_host("build", "build box")]);
    let installer = ScriptedInstaller::default();
    let token = harness.session.token().clone();
    let private = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----";
    let request = signed_request(&token, "phone", private);

    let response = harness.handle(&installer, &request);
    assert_eq!(refusal(&response).reason, "private_key_material");
    assert!(installer.entries().is_empty());
    assert!(
        !harness.registry.path().exists(),
        "a private key must not be written anywhere, including the device registry"
    );
}

#[test]
fn a_private_key_hidden_outside_the_key_field_is_still_refused() {
    // Pins the *placement* of the check, not just its existence: this request
    // has a perfectly valid public key, so a refusal can only come from the
    // scan over the raw bytes that runs before anything is parsed.
    let mut harness = Harness::new(vec![remote_host("build", "build box")]);
    let installer = ScriptedInstaller::default();
    let token = harness.session.token().clone();
    let request = signed_request(
        &token,
        "backup of my -----BEGIN OPENSSH PRIVATE KEY-----",
        &phone_public_key(),
    );

    let response = harness.handle(&installer, &request);
    assert_eq!(refusal(&response).reason, "private_key_material");
    assert!(installer.entries().is_empty());
}

#[test]
fn a_host_that_fails_is_named_in_the_answer_rather_than_dropped() {
    let mut harness = Harness::new(vec![
        remote_host("build", "build box"),
        remote_host("staging", "staging"),
        remote_host("archive", "archive"),
    ]);
    let installer = ScriptedInstaller::failing(&["staging"]);
    let request = signed_request(harness.session.token(), "phone", &phone_public_key());

    let answer = paired(harness.handle(&installer, &request));
    assert_eq!(
        answer.hosts.len(),
        3,
        "a short list reads as 'that server does not exist'"
    );
    let staging = answer
        .hosts
        .iter()
        .find(|host| host.id == "staging")
        .expect("the failed host must still be named");
    assert!(!staging.installed);
    assert_eq!(staging.name, "staging");
    assert_eq!(staging.failure.as_deref(), Some("network is unreachable"));
    assert!(
        answer
            .hosts
            .iter()
            .all(|host| host.host_key_fingerprint.is_some() == host.installed)
    );

    // The failed host is still revocable: it is in the record, so a key that
    // did land after a lost report can still be removed.
    let recorded = harness.registry.find(&answer.device_id).unwrap();
    assert_eq!(recorded.hosts.len(), 3);
}

#[test]
fn the_answer_is_proven_with_the_token_so_the_phone_can_authenticate_it() {
    let mut harness = Harness::new(vec![remote_host("build", "build box")]);
    let installer = ScriptedInstaller::default();
    let token = harness.session.token().clone();
    let answer = paired(harness.handle(
        &installer,
        &signed_request(&token, "phone", &phone_public_key()),
    ));

    let transcript = ResponseTranscriptV1::new(&[9u8; 16], &answer.device_id, &answer.hosts);
    let expected =
        base64::engine::general_purpose::STANDARD.encode(token.response_proof_v1(&transcript));
    assert_eq!(answer.proof, expected);

    let transcript_v2 = ResponseTranscriptV2::new(
        PAIRING_PROTOCOL_VERSION,
        &[9u8; 16],
        &answer.device_id,
        &answer.hosts,
    );
    let expected_v2 =
        base64::engine::general_purpose::STANDARD.encode(token.response_proof_v2(&transcript_v2));
    assert_eq!(answer.proof_v2.as_deref(), Some(expected_v2.as_str()));

    let mut tampered = answer.hosts.clone();
    tampered[0].installed = !tampered[0].installed;
    let tampered_transcript = ResponseTranscriptV1::new(&[9u8; 16], &answer.device_id, &tampered);
    assert_ne!(
        base64::engine::general_purpose::STANDARD
            .encode(token.response_proof_v1(&tampered_transcript)),
        answer.proof,
        "flipping an install result must invalidate the proof"
    );

    tampered[0].installed = answer.hosts[0].installed;
    tampered[0].host_key_fingerprint = Some("SHA256:substituted".into());
    let tampered_v2 = ResponseTranscriptV2::new(
        PAIRING_PROTOCOL_VERSION,
        &[9u8; 16],
        &answer.device_id,
        &tampered,
    );
    assert_ne!(
        base64::engine::general_purpose::STANDARD.encode(token.response_proof_v2(&tampered_v2)),
        expected_v2,
        "substituting the durable SSH pin must invalidate proof v2"
    );
}

#[test]
fn the_revocation_record_is_durable_before_the_first_destructive_edit() {
    let directory = tempfile::tempdir().unwrap();
    let registry_path = directory.path().join("paired-devices.json");
    let mut harness = Harness::new(vec![remote_host("build", "build box")]);
    harness.registry = DeviceRegistry::acquire(registry_path.clone(), None).unwrap();
    let installer = ScriptedInstaller {
        registry_path: Some(registry_path),
        ..ScriptedInstaller::default()
    };
    let request = signed_request(harness.session.token(), "phone", &phone_public_key());
    assert!(matches!(
        harness.handle(&installer, &request),
        PairingResponse::Paired(_)
    ));
}

#[test]
fn a_completed_mutation_survives_an_outcome_projection_failure() {
    let mut harness = Harness::new(vec![remote_host("build", "build box")]);
    let registry_path = harness.registry.path().to_path_buf();
    let installer = ScriptedInstaller {
        registry_path: Some(registry_path),
        break_registry_after_mutation: true,
        ..ScriptedInstaller::default()
    };
    let request = signed_request(harness.session.token(), "phone", &phone_public_key());

    let answer = paired(harness.handle(&installer, &request));

    assert!(answer.hosts[0].installed);
    assert_eq!(installer.entries().len(), 1);
}

#[test]
fn an_authorized_keys_file_without_a_trailing_newline_survives_a_real_install() {
    let home = tempfile::tempdir().unwrap();
    let existing =
        b"ssh-ed25519 AAAAsomeoneelse laptop\nssh-rsa AAAAB3teammate no-trailing-newline";
    std::fs::create_dir_all(home.path().join(".ssh")).unwrap();
    let path = home.path().join(".ssh/authorized_keys");
    std::fs::write(&path, existing).unwrap();

    let mut harness = Harness::new(vec![inventory::this_laptop(
        "127.0.0.1",
        22,
        "kattpish".into(),
    )]);
    let installer = SshExecInstaller::new(
        home.path().to_path_buf(),
        "unused".into(),
        Some("SHA256:test-local-pin".into()),
    );
    let request = signed_request(harness.session.token(), "phone", &phone_public_key());
    let answer = paired(harness.handle(&installer, &request));
    assert!(answer.hosts[0].installed);

    let after = std::fs::read(&path).unwrap();
    assert!(
        after.starts_with(existing),
        "a naive append would have concatenated the entry onto the teammate's key: {}",
        String::from_utf8_lossy(&after)
    );
    let lines: Vec<&[u8]> = after.split(|byte| *byte == b'\n').collect();
    assert_eq!(
        lines[1], b"ssh-rsa AAAAB3teammate no-trailing-newline",
        "the teammate's key must still be its own line"
    );
    assert!(lines[2].starts_with(b"command=\""));
}

#[test]
fn the_installed_entry_carries_both_the_forced_command_and_restrict() {
    let home = tempfile::tempdir().unwrap();
    let mut harness = Harness::new(vec![inventory::this_laptop(
        "127.0.0.1",
        22,
        "kattpish".into(),
    )]);
    let installer = SshExecInstaller::new(
        home.path().to_path_buf(),
        "unused".into(),
        Some("SHA256:test-local-pin".into()),
    );
    let request = signed_request(harness.session.token(), "phone", &phone_public_key());
    let answer = paired(harness.handle(&installer, &request));

    let written = std::fs::read_to_string(home.path().join(".ssh/authorized_keys")).unwrap();
    let line = written.lines().next().unwrap();
    // Split at the key: the assertions must be about the option field, not
    // about the words appearing somewhere on the line.
    let (options, _) = line
        .split_once(" ssh-ed25519 ")
        .expect("the entry carries options followed by the key");
    assert!(
        options.contains("command=\""),
        "without a forced command the key opens a shell: {line}"
    );
    assert!(
        options.contains("restrict"),
        "without restrict the entry is a port-forwarding pivot even with no shell: {line}"
    );
    assert!(line.ends_with(&format!("hmux-pairing:{}", answer.device_id)));
}

#[test]
fn a_stand_in_client_pairs_over_a_real_socket_and_the_port_then_stops_accepting() {
    let directory = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut session = PairingSession::new(
        PairingToken::generate(),
        SystemTime::now(),
        Duration::from_secs(30),
    );
    let request = signed_request(session.token(), "phone", &phone_public_key());
    let hosts = vec![remote_host("build", "build box")];
    let registry_path = directory.path().join("devices.json");

    let served = std::thread::spawn(move || {
        let installer = ScriptedInstaller::default();
        serve(
            &listener,
            &mut session,
            &hosts,
            PairingTerms {
                forced_command: entry::DEFAULT_FORCED_COMMAND,
                device_id: None,
            },
            &installer,
            &registry_path,
        )
    });

    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.write_all(&request).unwrap();
    stream.write_all(b"\n").unwrap();
    let mut answer = String::new();
    BufReader::new(&stream).read_line(&mut answer).unwrap();
    let response: PairingResponse = serde_json::from_str(answer.trim()).unwrap();
    assert!(matches!(response, PairingResponse::Paired(_)), "{answer}");

    assert!(served.join().unwrap().unwrap().is_some());
    let second = TcpStream::connect(("127.0.0.1", port));
    assert!(
        second.is_err(),
        "a spent pairing window must stop accepting, not merely refuse"
    );
}

/// `--writable` is the flag anybody reaching for "drive this box from the
/// phone" will use, and a phone that may type but not start cannot begin
/// anything while the laptop sleeps (owner, 2026-09-04).
#[test]
fn writable_pairing_writes_the_line_that_also_starts_sessions() {
    let line = pairing_forced_command(true, false, entry::DEFAULT_FORCED_COMMAND);

    assert_eq!(
        line,
        hmux_client::gateway_invocation::pairing_invocation(true, true)
    );
    assert!(line.contains("--role controller"));
    assert!(line.contains("--allow-create"));
}

/// Asking only for creation still gets it — the implication runs one way, so a
/// deployment that wants a phone which starts but does not type is spellable.
#[test]
fn creation_alone_writes_the_observer_line_that_starts_sessions() {
    let line = pairing_forced_command(false, true, entry::DEFAULT_FORCED_COMMAND);

    assert!(line.contains("--allow-create"));
    assert!(!line.contains("--role controller"));
}

/// Neither flag leaves the default line untouched — the phone watches, and
/// starts nothing.
#[test]
fn a_plain_pairing_still_writes_the_narrow_line() {
    assert_eq!(
        pairing_forced_command(false, false, entry::DEFAULT_FORCED_COMMAND),
        entry::DEFAULT_FORCED_COMMAND
    );
}

/// The escape hatch stays verbatim: an operator who spells the line themselves
/// gets exactly what they wrote, which is the point of `--forced-command`.
#[test]
fn a_hand_written_forced_command_is_taken_as_written() {
    let hand = "\"$HOME/bin/hmux\" mobile-gateway --session abc";

    assert_eq!(pairing_forced_command(false, false, hand), hand);
}

/// The desktop app registers the phone with this laptop's hub and shows a
/// pairing QR in one click, and those were two identities for one phone: the
/// app knew the hub id and never learned the ssh one. Removing the device in
/// the app dropped the hub token and left the forced-command key on every
/// server, unrevocable because nothing on the laptop named it. Filing the
/// pairing under the caller's id is what lets one Remove reach both.
#[test]
fn a_pairing_is_filed_under_the_identity_its_caller_assigned() {
    let mut harness = Harness::new(vec![remote_host("build", "build box")]);
    let installer = ScriptedInstaller::default();
    let request = signed_request(harness.session.token(), "phone", &phone_public_key());

    let answer = paired(harness.handle_under(&installer, &request, Some("device_2f9c81")));

    assert_eq!(answer.device_id, "device_2f9c81");
    assert_eq!(
        harness
            .registry
            .devices()
            .iter()
            .map(|device| device.device_id.as_str())
            .collect::<Vec<_>>(),
        vec!["device_2f9c81"],
        "revocation reads the registry by id; a record filed under anything else is \
         a key the caller cannot remove"
    );
    let (_, line) = installer.entries().into_iter().next().expect("one install");
    assert!(
        line.contains(&entry::device_comment("device_2f9c81")),
        "the server-side comment is how an operator answers whose key this is with \
         the laptop closed, got {line}"
    );
}

/// `persist` replaces a record with the same id, so pairing a second phone
/// under an id already in the registry would drop the first record — and with
/// it the exact `authorized_keys` line that is the only way to remove the key
/// already installed on every server. Refused under the lease, where the answer
/// cannot go stale between the check and the write.
#[test]
fn a_second_pairing_under_a_taken_identity_never_forgets_the_first_key() {
    let mut harness = Harness::new(vec![remote_host("build", "build box")]);
    let installer = ScriptedInstaller::default();
    let first = signed_request(harness.session.token(), "phone", &phone_public_key());
    paired(harness.handle_under(&installer, &first, Some("device_2f9c81")));
    let installed = installer.entries();

    // 두 번째는 새 창이다 — 같은 토큰은 이미 한 번 쓰였고, 그 거부가 먼저
    // 걸리면 신원 검사에 닿지도 못한다.
    let mut next = PairingSession::new(
        PairingToken::generate(),
        SystemTime::now(),
        Duration::from_secs(120),
    );
    let second = signed_request(next.token(), "other", &phone_public_key());
    let response = handle_request(
        &mut next,
        &harness.hosts,
        PairingTerms {
            forced_command: entry::DEFAULT_FORCED_COMMAND,
            device_id: Some("device_2f9c81"),
        },
        &installer,
        &mut harness.registry,
        &second,
        SystemTime::now(),
    );

    assert_eq!(refusal(&response).reason, "pairing_identity_taken");
    assert_eq!(
        harness.registry.devices().len(),
        1,
        "the first record is what names the installed key"
    );
    assert_eq!(
        installer.entries(),
        installed,
        "and nothing else was written"
    );
}

/// With no caller the identity is still minted here — the hand-run case, where
/// nothing else in the system needs to name that pairing.
#[test]
fn a_pairing_with_no_assigned_identity_still_mints_one() {
    let mut harness = Harness::new(vec![remote_host("build", "build box")]);
    let installer = ScriptedInstaller::default();
    let request = signed_request(harness.session.token(), "phone", &phone_public_key());

    let answer = paired(harness.handle(&installer, &request));

    assert!(uuid::Uuid::parse_str(&answer.device_id).is_ok());
}

/// The id is written raw into the `authorized_keys` comment, so a newline in it
/// appends a line to a file whose every line is an authorization. Narrowed once
/// at the flag, before anything is installed anywhere.
#[test]
fn an_assigned_identity_that_could_forge_an_authorized_keys_line_is_refused() {
    for hostile in [
        "device_1 ssh-ed25519 AAAAC3Nz",
        "device_1\nssh-ed25519 AAAAC3Nz",
        "",
        "id\twith-tab",
    ] {
        assert!(
            parse_assigned_device_id(hostile).is_err(),
            "{hostile:?} must not reach an authorized_keys comment"
        );
    }
    assert_eq!(
        parse_assigned_device_id("device_2f9c81aa").unwrap(),
        "device_2f9c81aa"
    );
    assert_eq!(
        parse_assigned_device_id("4ef42451-154d-43ba-b19d-a00c0530ee53").unwrap(),
        "4ef42451-154d-43ba-b19d-a00c0530ee53",
        "the uuids this module has always minted must stay spellable"
    );
}
