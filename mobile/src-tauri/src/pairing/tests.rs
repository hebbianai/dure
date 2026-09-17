//! Unit tests for the phone half of pairing.
//!
//! The end-to-end test — this client against the **real** `hmux pair start`
//! process — lives in `tests/pairing_exchange.rs`. It is the one that would
//! exercise the shared wire implementation against the real host. These tests
//! pin the mobile policy and every refusal path a round trip never reaches.

use super::*;
use hmux_client::online_pairing::HostAnswer;

mod deadline;

const TOKEN: &[u8] = b"0123456789abcdef0123456789abcdef";

fn token_qr() -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(TOKEN)
}

/// A SHA-256-length digest whose two base64 alphabets actually differ.
///
/// Chosen, not arbitrary: `0xFB 0xEF 0xBE` encodes to `++++` and `0xFF 0xFF
/// 0xFF` to `////`, the two code points where standard and URL-safe base64 part
/// company. A digest of `0,1,2,…` encodes identically in both, which would make
/// [`the_qr_fingerprint_is_re_encoded_into_the_form_the_ssh_stack_compares`]
/// pass against an implementation that never re-encoded anything.
fn digest() -> [u8; 32] {
    let mut bytes = [0xFFu8; 32];
    for (index, byte) in bytes.iter_mut().take(30).enumerate() {
        *byte = [0xFB, 0xEF, 0xBE][index % 3];
    }
    bytes
}

fn payload() -> String {
    format!(
        "hmux-pair:1?a=192.168.0.12&p=47821&t={}&k=ssh-ed25519&f={}&e=1800000000000&rp=2",
        token_qr(),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest())
    )
}

// ---------------------------------------------------------------------------
// Reading the QR
// ---------------------------------------------------------------------------

#[test]
fn a_well_formed_payload_yields_a_dialable_invitation() {
    let invitation = parse_invitation(&payload()).expect("parse");

    assert_eq!(invitation.address, "192.168.0.12");
    assert_eq!(invitation.port, 47_821);
    assert_eq!(invitation.host_key_algorithm, "ssh-ed25519");
    assert_eq!(invitation.expires_at_unix_ms, 1_800_000_000_000);
    assert_eq!(
        invitation.response_proof_policy,
        ResponseProofPolicy::AuthenticatedResponseV2
    );
    assert_eq!(invitation.token, TOKEN.to_vec());
}

/// The QR carries base64**url**; russh compares `SHA256:` plus *standard*
/// base64. Passing the QR's text through would produce a pin that is perfectly
/// well-formed and can never match — a failure that surfaces at the far end of a
/// dial, named after the server rather than after the encoding.
#[test]
fn the_qr_fingerprint_is_re_encoded_into_the_form_the_ssh_stack_compares() {
    let invitation = parse_invitation(&payload()).expect("parse");

    assert_eq!(
        invitation.host_key_fingerprint,
        format!(
            "SHA256:{}",
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest())
        )
    );
    assert_ne!(
        invitation.host_key_fingerprint,
        format!(
            "SHA256:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest())
        ),
        "the two alphabets differ for this digest, which is what makes the test meaningful"
    );
}

/// A digest of the wrong length can never equal what a host offers. Refusing it
/// here is the difference between "that QR is not ours" and a dial that fails
/// minutes later against a server that is fine.
#[test]
fn a_fingerprint_that_is_not_a_sha256_digest_is_refused_before_any_dial() {
    let short = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([1u8; 20]);
    let scanned = payload().replace(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest()),
        &short,
    );

    let error = parse_invitation(&scanned).expect_err("a 20-byte digest is not SHA-256");

    assert_eq!(error.code(), "pairing_malformed_code");
}

/// A camera sees far more codes than ours. "Not a pairing code" and "the laptop
/// sent something broken" send the user to different places.
#[test]
fn a_url_scanned_by_mistake_is_not_reported_as_a_broken_pairing_code() {
    for scanned in [
        "https://example.com/wifi",
        "WIFI:S:cafe;T:WPA;P:x;;",
        r#"{"hebbian_pairing":1,"host":"10.0.0.1"}"#,
    ] {
        let error = parse_invitation(scanned).expect_err("not ours");

        assert_eq!(error.code(), "pairing_not_a_code", "{scanned}");
    }
}

#[test]
fn a_newer_pairing_version_is_refused_rather_than_read_leniently() {
    let scanned = payload().replace("hmux-pair:1?", "hmux-pair:2?");

    let error = parse_invitation(&scanned).expect_err("a future code is refused");

    assert_eq!(error.code(), "pairing_unsupported_version");
}

/// Every one of the six parameters is load-bearing, so a payload missing any of
/// them is refused rather than defaulted. A default here would be a silent
/// substitution — an empty pin, port 0, or a token of no bytes — each of which
/// fails much later and names something other than the QR.
#[test]
fn a_payload_missing_any_required_parameter_is_refused() {
    let complete = payload();
    for parameter in ["a=", "p=", "t=", "k=", "f=", "e="] {
        let dropped: Vec<&str> = complete
            .trim_start_matches("hmux-pair:1?")
            .split('&')
            .filter(|field| !field.starts_with(parameter))
            .collect();
        let scanned = format!("hmux-pair:1?{}", dropped.join("&"));
        assert_ne!(scanned, complete, "{parameter} was not actually dropped");

        let error = parse_invitation(&scanned)
            .err()
            .unwrap_or_else(|| panic!("{parameter} must be required"));

        assert_eq!(error.code(), "pairing_malformed_code", "{parameter}");
    }
}

#[test]
fn port_zero_is_refused_even_though_it_is_a_valid_u16() {
    let scanned = payload().replace("p=47821", "p=0");

    let error = parse_invitation(&scanned).expect_err("port 0 must be refused");

    assert_eq!(error.code(), "pairing_malformed_code");
}

/// The camera hands over whatever it read. A code that is megabytes of text must
/// not get to choose how much work this process does.
#[test]
fn an_oversized_scan_is_refused_before_it_is_parsed() {
    let scanned = format!("hmux-pair:1?a={}", "x".repeat(MAX_INVITATION_BYTES));

    let error = parse_invitation(&scanned).expect_err("the cap must hold");

    assert_eq!(error.code(), "pairing_code_oversized");
}

/// An additive parameter at the same version must not break a fielded phone.
#[test]
fn an_unknown_parameter_is_ignored_rather_than_refused() {
    let scanned = format!("{}&z=future", payload());

    let invitation = parse_invitation(&scanned).expect("an extra parameter is not a refusal");

    assert_eq!(invitation.port, 47_821);
}

#[test]
fn a_qr_without_a_response_proof_capability_keeps_legacy_compatibility() {
    let scanned = payload().replace("&rp=2", "");

    let invitation = parse_invitation(&scanned).expect("a deployed v1 QR remains readable");

    assert_eq!(
        invitation.response_proof_policy,
        ResponseProofPolicy::LegacyV1 {
            qr_host_key_fingerprint: invitation.host_key_fingerprint.clone(),
        }
    );
}

/// The token is the credential the laptop uses to authorize this device on every
/// server it knows. It must not be reachable through the type's own printing.
#[test]
fn an_invitations_debug_output_does_not_carry_the_token() {
    let invitation = parse_invitation(&payload()).expect("parse");

    let printed = format!("{invitation:?}");

    assert!(!printed.contains(&token_qr()), "{printed}");
    assert!(!printed.contains("0123456789abcdef"), "{printed}");
    assert!(printed.contains("192.168.0.12"), "{printed}");
}

/// The expiry is in the payload precisely so a phone pointed at a photograph of
/// last week's screen says so, instead of failing at a socket with a connection
/// error that names the network.
#[test]
fn an_expired_qr_is_refused_before_a_packet_is_sent() {
    let invitation = parse_invitation(&payload()).expect("parse");
    let expired = UNIX_EPOCH + Duration::from_millis(invitation.expires_at_unix_ms + 5_000);

    let error = refuse_if_expired(&invitation, expired).expect_err("an old QR must be refused");

    assert_eq!(error.code(), "pairing_code_expired");
    assert!(refuse_if_expired(
        &invitation,
        UNIX_EPOCH + Duration::from_millis(invitation.expires_at_unix_ms - 1)
    )
    .is_ok());
}

// ---------------------------------------------------------------------------
// Reading the answer
// ---------------------------------------------------------------------------

fn host_answer(installed: bool) -> HostAnswer {
    HostAnswer {
        id: "h1".to_string(),
        name: "빌드 서버".to_string(),
        host: "10.0.0.4".to_string(),
        port: 22,
        user: "kattpish".to_string(),
        installed,
        failure: None,
        host_key_fingerprint: Some("SHA256:AAAABBBB".to_string()),
    }
}

/// Builds the answer a laptop holding `TOKEN` would write.
fn proven_answer(nonce: &[u8], hosts: &[HostAnswer]) -> Vec<u8> {
    let device_id = "device-1";
    let proof = ResponseTranscriptV1::new(nonce, device_id, hosts).proof(TOKEN);
    let proof_v2 = ResponseTranscriptV2::new(PAIRING_VERSION, nonce, device_id, hosts).proof(TOKEN);
    serde_json::to_vec(&PairingResponse::Paired(
        hmux_client::online_pairing::PairedAnswer {
            version: PAIRING_VERSION,
            device_id: device_id.into(),
            hosts: hosts.to_vec(),
            proof: base64::engine::general_purpose::STANDARD.encode(proof),
            proof_v2: Some(base64::engine::general_purpose::STANDARD.encode(proof_v2)),
        },
    ))
    .expect("encode")
}

fn read_current_answer(
    raw: &[u8],
    nonce: &[u8],
    token: &[u8],
) -> Result<PairingAnswer, PairingError> {
    read_answer(
        raw,
        nonce,
        token,
        &ResponseProofPolicy::AuthenticatedResponseV2,
    )
}

#[test]
fn a_proven_answer_becomes_the_phones_own_server_list() {
    let raw = proven_answer(b"nonce-bytes-here", &[host_answer(true)]);

    let answer = read_current_answer(&raw, b"nonce-bytes-here", TOKEN).expect("a proven answer");

    assert_eq!(answer.device_id, "device-1");
    let entry = to_entry(answer.usable().next().expect("one usable host"));
    assert_eq!(entry.host, "10.0.0.4");
    assert_eq!(entry.username, "kattpish");
    assert_eq!(entry.host_key_fingerprint, "SHA256:AAAABBBB");
    assert!(entry.paired);
    assert!(entry.attach_key_confinement.is_forced_command());
}

/// The failure this check exists to stop: whoever answers that address gets to
/// hand the phone an inventory of *their* servers, and the phone would dial
/// those forever after, believing them.
#[test]
fn an_answer_from_something_that_does_not_hold_the_token_is_refused() {
    let raw = proven_answer(b"nonce-bytes-here", &[host_answer(true)]);

    let error = read_current_answer(&raw, b"nonce-bytes-here", b"a-different-token-entirely")
        .expect_err("an impostor must be refused");

    assert_eq!(error.code(), "pairing_answer_unproven");
}

/// The nonce binds the answer to the request that asked for it. A proof captured
/// off the LAN must not verify against a later request.
#[test]
fn an_answer_replayed_against_a_different_nonce_is_refused() {
    let raw = proven_answer(b"the-first-nonce!", &[host_answer(true)]);

    let error = read_current_answer(&raw, b"a-second-nonce!!", TOKEN)
        .expect_err("a replayed answer is refused");

    assert_eq!(error.code(), "pairing_answer_unproven");
}

/// `installed` is inside the transcript, so flipping it in flight invalidates
/// the proof rather than leaving the owner believing a server is reachable.
#[test]
fn an_installed_flag_flipped_in_flight_invalidates_the_answer() {
    let raw = proven_answer(b"nonce-bytes-here", &[host_answer(false)]);
    let tampered = String::from_utf8(raw)
        .expect("utf8")
        .replace("\"installed\":false", "\"installed\":true");

    let error = read_current_answer(tampered.as_bytes(), b"nonce-bytes-here", TOKEN)
        .expect_err("a flipped flag must not verify");

    assert_eq!(error.code(), "pairing_answer_unproven");
}

/// A host-key pin decides which SSH identity this phone trusts after pairing.
/// Rewriting only that pin must therefore invalidate the proven answer.
#[test]
fn a_host_key_fingerprint_flipped_in_flight_invalidates_the_answer() {
    let raw = proven_answer(b"nonce-bytes-here", &[host_answer(true)]);
    let tampered = String::from_utf8(raw)
        .expect("utf8")
        .replace("SHA256:AAAABBBB", "SHA256:CCCCDDDD");

    let error = read_current_answer(tampered.as_bytes(), b"nonce-bytes-here", TOKEN)
        .expect_err("a substituted host-key pin must not verify");

    assert_eq!(error.code(), "pairing_answer_unproven");
}

#[test]
fn proof_v2_cannot_be_removed_to_downgrade_a_current_qr() {
    let raw = proven_answer(b"nonce-bytes-here", &[host_answer(true)]);
    let mut document: serde_json::Value = serde_json::from_slice(&raw).expect("answer JSON");
    document
        .as_object_mut()
        .expect("answer object")
        .remove("proof_v2");
    let without_v2 = serde_json::to_vec(&document).expect("encode answer");

    let error = read_current_answer(&without_v2, b"nonce-bytes-here", TOKEN)
        .expect_err("rp=2 must never fall back to the still-valid legacy proof");

    assert_eq!(error.code(), "pairing_answer_unproven");
    assert!(read_answer(
        &without_v2,
        b"nonce-bytes-here",
        TOKEN,
        &ResponseProofPolicy::LegacyV1 {
            qr_host_key_fingerprint: "SHA256:AAAABBBB".into(),
        },
    )
    .is_ok());
}

#[test]
fn a_legacy_answer_cannot_introduce_a_pin_that_was_not_in_its_qr() {
    let raw = proven_answer(b"nonce-bytes-here", &[host_answer(true)]);

    let answer = read_answer(
        &raw,
        b"nonce-bytes-here",
        TOKEN,
        &ResponseProofPolicy::LegacyV1 {
            qr_host_key_fingerprint: "SHA256:QR-TRUSTED".into(),
        },
    )
    .expect("the deployed v1 proof remains readable");

    assert_eq!(answer.hosts[0].host_key_fingerprint, None);
    assert!(!answer.hosts[0].is_usable());
}

#[test]
fn a_legacy_answer_can_reuse_the_pin_authenticated_by_its_qr() {
    let raw = proven_answer(b"nonce-bytes-here", &[host_answer(true)]);

    let answer = read_answer(
        &raw,
        b"nonce-bytes-here",
        TOKEN,
        &ResponseProofPolicy::LegacyV1 {
            qr_host_key_fingerprint: "SHA256:AAAABBBB".into(),
        },
    )
    .expect("the QR-authenticated pin remains usable");

    assert_eq!(
        answer.hosts[0].host_key_fingerprint.as_deref(),
        Some("SHA256:AAAABBBB")
    );
    assert!(answer.hosts[0].is_usable());
}

/// A refusal is a sentence the owner needs — "this QR was already used" sends
/// them to press a key on the laptop, and reporting it as an impostor would send
/// them to look for an attacker.
#[test]
fn a_refusal_is_surfaced_with_the_hosts_own_reason_token() {
    let raw = br#"{"status":"refused","version":1,"reason":"pairing_token_already_used","detail":"this pairing QR was already used; show a new one"}"#;

    let error = read_current_answer(raw, b"nonce", TOKEN).expect_err("a refusal is not an answer");

    assert_eq!(error.code(), "pairing_token_already_used");
    assert!(error.to_string().contains("already used"), "{error}");
}

/// A server the laptop could not provision must arrive named, never omitted: a
/// server that silently disappears reads exactly like a server that does not
/// exist, and the machine the owner came to the desk for is the one that failed.
#[test]
fn a_server_the_laptop_failed_on_is_reported_rather_than_dropped() {
    let mut failed = host_answer(false);
    failed.failure = Some("ssh to build box failed".to_string());
    failed.host_key_fingerprint = None;
    let raw = proven_answer(b"nonce-bytes-here", &[host_answer(true), failed]);

    let answer = read_current_answer(&raw, b"nonce-bytes-here", TOKEN).expect("a proven answer");

    assert_eq!(answer.hosts.len(), 2);
    assert_eq!(answer.usable().count(), 1);
    assert_eq!(
        answer.hosts[1].refusal().as_deref(),
        Some("ssh to build box failed")
    );
}

/// The subtle one. The laptop installed the key and published no host key for
/// that machine (`installer::apply_locally` sends `None` in as many words). This
/// client has no accept-anything mode, so the row is a server it can never dial
/// — adopting it would put a list entry there that renders as "connect" and
/// fails forever.
#[test]
fn a_server_with_no_pinnable_fingerprint_is_named_rather_than_adopted() {
    let mut unpinned = host_answer(true);
    unpinned.host_key_fingerprint = None;
    let raw = proven_answer(b"nonce-bytes-here", &[unpinned]);

    let answer = read_current_answer(&raw, b"nonce-bytes-here", TOKEN).expect("a proven answer");

    assert_eq!(answer.hosts.len(), 1);
    assert_eq!(answer.usable().count(), 0);
    assert!(answer.hosts[0]
        .refusal()
        .expect("a reason")
        .contains("호스트 키 지문"));
}

/// A fingerprint in a shape this client cannot pin is the same situation as no
/// fingerprint at all, and must not become an entry that fails at handshake.
#[test]
fn a_fingerprint_in_an_unpinnable_shape_is_treated_as_absent() {
    for candidate in [Some("MD5:ab:cd"), Some("SHA256:"), Some("  "), None] {
        assert_eq!(usable_fingerprint(candidate), None, "{candidate:?}");
    }
    assert_eq!(
        usable_fingerprint(Some(" SHA256:AAAA ")),
        Some("SHA256:AAAA".to_string())
    );
}

#[test]
fn an_answer_over_the_server_cap_is_refused_rather_than_allocated() {
    let hosts: Vec<HostAnswer> = (0..=MAX_INVENTORY_SERVERS)
        .map(|index| {
            let mut host = host_answer(true);
            host.id = format!("h{index}");
            host
        })
        .collect();
    let raw = proven_answer(b"nonce-bytes-here", &hosts);

    let error =
        read_current_answer(&raw, b"nonce-bytes-here", TOKEN).expect_err("the cap must hold");

    assert_eq!(error.code(), "pairing_too_many_servers");
}

#[test]
fn an_answer_this_build_cannot_parse_is_named_as_such() {
    let error = read_current_answer(b"not json at all", b"nonce", TOKEN).expect_err("garbage");

    assert_eq!(error.code(), "pairing_malformed_answer");
}

/// A trailing newline is what the host writes. Stripping it is not optional:
/// `serde_json` tolerates it, but the proof is computed over the parsed fields,
/// so a reader that mishandles framing would fail much less obviously.
#[test]
fn the_answers_trailing_newline_does_not_change_how_it_reads() {
    let mut raw = proven_answer(b"nonce-bytes-here", &[host_answer(true)]);
    raw.extend_from_slice(b"\r\n");

    assert!(read_current_answer(&raw, b"nonce-bytes-here", TOKEN).is_ok());
}

// ---------------------------------------------------------------------------
// What crosses the wire
// ---------------------------------------------------------------------------

/// The request carries public key material and nothing else. Asserted against
/// the encoded bytes rather than the struct, because the encoding is what the
/// laptop — and anyone with a packet capture — actually sees.
#[test]
fn only_public_key_material_is_encoded_into_a_request() {
    let request = PairingRequest {
        version: PAIRING_VERSION,
        device_name: "내 폰".to_string(),
        public_key: "ssh-ed25519 AAAApublic dure-mobile".to_string(),
        nonce: base64::engine::general_purpose::STANDARD.encode([7u8; 32]),
        proof: base64::engine::general_purpose::STANDARD.encode([9u8; 32]),
    };

    let encoded = serde_json::to_vec(&request).expect("encode");

    assert!(refuse_private_key_material(&encoded).is_ok());
    let text = String::from_utf8(encoded).expect("utf8");
    assert!(text.contains("\"version\":1"), "{text}");
    assert!(!text.contains("PRIVATE"), "{text}");
    assert!(!text.contains("BEGIN"), "{text}");
}

/// The host refuses a request carrying private key material before it parses
/// anything, in *any* field. The same refusal runs here so the property is this
/// client's, not the server's — and so the message names the device name rather
/// than arriving as an opaque server refusal.
#[test]
fn a_private_key_pasted_into_any_field_is_refused_before_it_is_sent() {
    let request = serde_json::to_vec(&PairingRequest {
        version: PAIRING_VERSION,
        device_name: "my rsa PRIVATE KEY backup".to_string(),
        public_key: "ssh-ed25519 AAAA c".to_string(),
        nonce: String::new(),
        proof: String::new(),
    })
    .expect("encode");

    let error = refuse_private_key_material(&request).expect_err("that must never be sent");

    assert_eq!(error.code(), "pairing_private_key_material");
}

/// A nonce that repeated would let a proof captured off the LAN be replayed
/// inside the same pairing window. Two draws must differ.
#[test]
fn two_nonces_differ_and_meet_the_hosts_minimum_length() {
    let first = fresh_nonce().expect("nonce");
    let second = fresh_nonce().expect("nonce");

    assert_ne!(first, second);
    // The shared protocol minimum is 16; anything shorter is refused as
    // malformed by the laptop.
    assert!(first.len() >= 16, "{}", first.len());
}
