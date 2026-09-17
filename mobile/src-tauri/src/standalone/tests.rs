use super::*;

fn framed(payload: &str) -> Vec<u8> {
    let mut framed = Vec::new();
    framed.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_be_bytes());
    framed.extend_from_slice(payload.as_bytes());
    framed
}

fn receipt_payload(request_id: &str, bridge_nonce: &str, version: u16) -> String {
    serde_json::json!({
        "gateway_create_version": version,
        "request_id": request_id,
        "bridge_nonce": bridge_nonce,
        "session": {
            "session_id": "standalone_abc",
            "session_name": "phone-standalone_abc",
            "workspace_id": "workspace-1",
            "session_class": "standalone",
            "lifecycle": "ready",
            "provider_id": "shell",
            "runner_principal": "user",
            "runner_instance": "i",
            "channel_epoch": "e",
            "host_instance_id": "h",
            "terminal_epoch": "t",
            "supported_protocol": { "minimum": 1, "maximum": 1 },
            "capabilities": [],
        }
    })
    .to_string()
}

/// The gateway bounds every identifier to ASCII alphanumerics and `._:+-`. A
/// name that fails there is refused *after* the box has already been dialled,
/// so the shapes are decided here instead.
#[test]
fn generated_identifiers_stay_inside_what_the_gateway_admits() {
    let ids = CreateIds::from_token("9f3a1c");

    for value in [
        &ids.request_id,
        &ids.session_id,
        &ids.launch_proof,
        &ids.session_name,
        &ids.bridge_nonce,
    ] {
        assert!(!value.is_empty() && value.len() <= 256, "{value}");
        assert!(
            value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:+-".contains(&byte)),
            "{value}"
        );
    }
    assert!(ids.session_id.starts_with("standalone_"));
}

/// v7 is the version that admits a create carrying its directory. Sending the
/// older one with a `cwd` is refused by the box, and sending v7 without one is
/// refused too — the pairing is what makes an old box's refusal legible.
#[test]
fn the_request_names_its_version_its_directory_and_the_two_intercepts() {
    let ids = CreateIds::from_token("9f3a1c");
    let framed = create_request(&ids, Some("/home/kattpish/dure"));
    let payload: serde_json::Value =
        serde_json::from_slice(&framed[LENGTH_PREFIX_BYTES..]).unwrap();

    assert_eq!(payload["gateway_request_version"], 7);
    let request = &payload["request"]["create_standalone"];
    assert_eq!(request["cwd"], "/home/kattpish/dure");
    assert_eq!(request["target_session_id"], ids.session_id.as_str());
    let intercepts = request["command_intercepts"].as_array().unwrap();
    assert_eq!(intercepts.len(), 2);
    assert_eq!(intercepts[0]["command"], "claude");
    assert_eq!(intercepts[1]["command"], "codex");
    // The frame's length prefix has to describe the document that follows it.
    let announced = u32::from_be_bytes(framed[..LENGTH_PREFIX_BYTES].try_into().unwrap()) as usize;
    assert_eq!(announced, framed.len() - LENGTH_PREFIX_BYTES);
}

/// Regression: hebbian-frontend-ahjuv — `~` was sent as a v7 cwd even though
/// the gateway admits only an absolute path for that version.
/// Found by /qa on 2026-09-10.
#[test]
fn a_home_request_omits_the_directory_and_uses_version_one() {
    let ids = CreateIds::from_token("9f3a1c");
    let framed = create_request(&ids, None);
    let payload: serde_json::Value =
        serde_json::from_slice(&framed[LENGTH_PREFIX_BYTES..]).unwrap();

    assert_eq!(payload["gateway_request_version"], 1);
    assert!(payload["request"]["create_standalone"].get("cwd").is_none());
}

#[test]
fn a_receipt_for_this_request_carries_the_created_session() {
    let ids = CreateIds::from_token("9f3a1c");
    let answer = framed(&receipt_payload(&ids.request_id, &ids.bridge_nonce, 1));

    let receipt = read_created(&mut answer.as_slice(), &ids, MAX_CREATE_ANSWER_BYTES)
        .expect("a matching receipt is accepted");

    assert_eq!(receipt.session.session_id, "standalone_abc");
}

/// A receipt that does not echo this request's ids may belong to another
/// create, and attaching to what it names would open somebody else's session.
#[test]
fn a_receipt_for_another_request_is_refused_rather_than_attached_to() {
    let ids = CreateIds::from_token("9f3a1c");
    let answer = framed(&receipt_payload("phone_create_other", &ids.bridge_nonce, 1));

    let error = read_created(&mut answer.as_slice(), &ids, MAX_CREATE_ANSWER_BYTES)
        .expect_err("a receipt for another request must be refused");

    assert!(matches!(error, CreateError::Mismatched));
}

/// The refusal a phone hits most is a key the operator never widened. Its
/// message names the flag, so it is shown rather than replaced.
#[test]
fn a_refusal_is_carried_with_the_words_the_box_used() {
    let ids = CreateIds::from_token("9f3a1c");
    let refusal = serde_json::json!({
        "protocol_version": 1,
        "body": {
            "kind": "error",
            "payload": {
                "code": "authorization_denied",
                "message": "a forced-command gateway cannot create remote processes without --allow-create",
            }
        }
    })
    .to_string();
    let answer = framed(&refusal);

    let error = read_created(&mut answer.as_slice(), &ids, MAX_CREATE_ANSWER_BYTES)
        .expect_err("a refusal is not a receipt");

    match error {
        CreateError::Refused { code, message } => {
            assert_eq!(code, "authorization_denied");
            assert!(message.contains("--allow-create"), "{message}");
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn a_receipt_from_a_newer_document_version_is_refused_rather_than_guessed() {
    let ids = CreateIds::from_token("9f3a1c");
    let answer = framed(&receipt_payload(&ids.request_id, &ids.bridge_nonce, 2));

    let error = read_created(&mut answer.as_slice(), &ids, MAX_CREATE_ANSWER_BYTES)
        .expect_err("an unknown receipt version must be refused");

    assert!(matches!(
        error,
        CreateError::UnsupportedVersion {
            found: 2,
            supported: 1
        }
    ));
}
