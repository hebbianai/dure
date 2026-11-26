use super::*;
use crate::push::{PushAlertContext, PushSubscription};

const VECTORS: &str = include_str!("../../testdata/push-grant-v1.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorFile {
    context: String,
    hub: String,
    token: String,
    environment: ApnsEnvironment,
    preference: PushPreference,
    now: u64,
    max_lifetime_secs: u64,
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    name: String,
    key: String,
    key_id: String,
    claims: String,
    signature: String,
    parse: String,
    signature_valid: bool,
    verdict: String,
}

fn claims() -> PushGrantClaims {
    PushGrantClaims {
        version: PUSH_GRANT_VERSION,
        token: "a1b2".repeat(16).try_into().unwrap(),
        environment: ApnsEnvironment::Sandbox,
        hub: crate::fingerprint::of_der(b"computer certificate"),
        preference: PushPreference::Approvals,
        epoch: 3,
        issued_at: 1_795_600_000,
        expires_at: 1_795_600_000 + PUSH_GRANT_LIFETIME_SECS,
        nonce: None,
    }
}

fn point() -> Vec<u8> {
    let mut point = vec![0x04];
    point.extend([9; 64]);
    point
}

#[test]
fn every_canonical_and_parse_verdict_in_the_vectors_is_reproduced() {
    let file: VectorFile = serde_json::from_str(VECTORS).unwrap();
    assert_eq!(file.context.as_bytes(), PUSH_GRANT_CONTEXT);
    assert_eq!(file.max_lifetime_secs, PUSH_GRANT_MAX_LIFETIME_SECS);
    let names: Vec<&str> = file
        .vectors
        .iter()
        .map(|vector| vector.name.as_str())
        .collect();
    for required in [
        "valid",
        "tampered_claims",
        "tampered_signature",
        "duplicate_key",
        "whitespace",
        "reordered",
        "unknown_version",
        "point_not_on_curve",
        "lifetime_over_maximum",
    ] {
        assert!(names.contains(&required), "no {required} vector");
    }

    for vector in &file.vectors {
        let name = &vector.name;
        let grant: PushGrant = serde_json::from_value(serde_json::json!({
            "key": vector.key,
            "claims": vector.claims,
            "signature": vector.signature,
        }))
        .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(grant.key_id().as_str(), vector.key_id, "{name}");
        assert_eq!(
            serde_json::to_value(&grant).unwrap()["claims"],
            vector.claims.as_str(),
            "{name}: one spelling"
        );
        let read = grant.read_claims();
        match vector.parse.as_str() {
            "known" => {
                let claims = match read {
                    Ok(PushGrantClaimsRead::Known(claims)) => claims,
                    other => panic!("{name}: {other:?}"),
                };
                assert_eq!(claims.to_canonical_bytes(), grant.claims(), "{name}");
                let lifetime = claims.expires_at.saturating_sub(claims.issued_at);
                if name == "lifetime_over_maximum" {
                    assert!(lifetime > PUSH_GRANT_MAX_LIFETIME_SECS, "{name}");
                }
                if vector.verdict == "accept" {
                    assert!(vector.signature_valid, "{name}");
                    assert_eq!(
                        (
                            claims.token.as_str(),
                            claims.environment,
                            claims.preference,
                            claims.hub.as_str()
                        ),
                        (
                            file.token.as_str(),
                            file.environment,
                            file.preference,
                            file.hub.as_str()
                        ),
                        "{name}"
                    );
                    assert!(lifetime <= PUSH_GRANT_MAX_LIFETIME_SECS, "{name}");
                    assert!(
                        claims.issued_at <= file.now && file.now < claims.expires_at,
                        "{name}"
                    );
                }
            }
            "unknown" => assert_eq!(
                read,
                Ok(PushGrantClaimsRead::Unknown { version: 2 }),
                "{name}"
            ),
            "refused" => assert!(read.is_err(), "{name}: {read:?}"),
            other => panic!("{name}: unknown parse verdict {other}"),
        }
        if vector.verdict == "accept" {
            assert_eq!(vector.parse, "known", "{name}");
        } else {
            assert_eq!(vector.verdict, "reject", "{name}");
        }
    }
}

#[test]
fn canonical_claims_are_compact_ordered_and_read_back() {
    let mut claims = claims();
    claims.nonce = Some(
        "0123456789abcdef0123456789abcdef"
            .to_string()
            .try_into()
            .unwrap(),
    );
    let bytes = claims.to_canonical_bytes();
    assert_eq!(
        String::from_utf8(bytes.clone()).unwrap(),
        format!(
            r#"{{"version":1,"token":"{}","environment":"sandbox","hub":"{}","preference":"approvals","epoch":3,"issuedAt":{},"expiresAt":{},"nonce":"0123456789abcdef0123456789abcdef"}}"#,
            claims.token.as_str(),
            claims.hub,
            claims.issued_at,
            claims.expires_at,
        )
    );
    assert_eq!(
        PushGrantClaims::parse(&bytes),
        Ok(PushGrantClaimsRead::Known(claims))
    );
}

#[test]
fn parse_refuses_what_two_readers_could_read_differently() {
    let canonical = String::from_utf8(claims().to_canonical_bytes()).unwrap();
    let edit = |from: &str, to: &str| {
        assert!(canonical.contains(from), "{from}");
        canonical.replacen(from, to, 1).into_bytes()
    };
    let refused = [
        (
            edit(r#""epoch":3,"#, r#""epoch":3,"epoch":3,"#),
            "duplicate",
        ),
        (edit(r#","token""#, r#",  "token""#), "whitespace"),
        (format!("{canonical}\n").into_bytes(), "trailing newline"),
        (
            edit(
                r#""environment":"sandbox","hub""#,
                r#""hub":"PLACEHOLDER","environment":"sandbox","hub""#,
            ),
            "repeated hub",
        ),
        (edit(r#""epoch":3,"#, r#""epoch":3.0,"#), "float"),
        (edit(r#""epoch":3,"#, r#""epoch":3e0,"#), "exponent"),
        (edit(r#""epoch":3,"#, r#""epoch":"3","#), "string number"),
        (
            edit(r#""epoch":3,"#, r#""epoch":3,"extra":true,"#),
            "unknown field",
        ),
        (edit("}", r#","nonce":null}"#), "null nonce"),
        (
            edit("}", r#","nonce":"ABCDEF0123456789ABCDEF0123456789"}"#),
            "uppercase nonce",
        ),
        (edit(r#""version":1"#, r#""version":0"#), "version zero"),
        (edit(r#""issuedAt""#, r#""issued_at""#), "snake case"),
        (b"not json".to_vec(), "not json"),
        (b"[1]".to_vec(), "not an object"),
    ];
    for (bytes, why) in refused {
        assert!(
            PushGrantClaims::parse(&bytes).is_err(),
            "{why}: {}",
            String::from_utf8_lossy(&bytes)
        );
    }
    // Reordered: the same fields with the token first.
    let value: serde_json::Value = serde_json::from_slice(canonical.as_bytes()).unwrap();
    let reordered = format!(
        r#"{{"token":{},{}"#,
        value["token"],
        canonical[1..].replacen(&format!(r#""token":{},"#, value["token"]), "", 1)
    );
    assert_eq!(
        PushGrantClaims::parse(reordered.as_bytes()),
        Err(PushGrantError::NonCanonical),
        "{reordered}"
    );
    let mut elsewhere = claims();
    elsewhere.hub = "SHA256:short".to_string();
    assert_eq!(
        PushGrantClaims::parse(&elsewhere.to_canonical_bytes()),
        Err(PushGrantError::InvalidHub)
    );
    assert_eq!(
        PushGrantClaims::parse(&[b' '; MAX_GRANT_CLAIMS_BYTES + 1]),
        Err(PushGrantError::Malformed)
    );
}

/// A later version is passed through, even with fields version 1 lacks.
#[test]
fn a_later_claims_version_reads_as_unknown() {
    for later in [
        r#"{"version":2,"token":"aa","nothing":"known"}"#,
        r#"{"version":65535}"#,
        r#"{"nothing":"first","version":7}"#,
    ] {
        let version: u16 = serde_json::from_str::<serde_json::Value>(later).unwrap()["version"]
            .as_u64()
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(
            PushGrantClaims::parse(later.as_bytes()),
            Ok(PushGrantClaimsRead::Unknown { version }),
            "{later}"
        );
    }
}

#[test]
fn a_grant_is_structure_checked_when_read() {
    let encode = |bytes: &[u8]| URL_SAFE_NO_PAD.encode(bytes);
    let claims = claims().to_canonical_bytes();
    let grant = |key: String, claims: String, signature: String| {
        serde_json::from_value::<PushGrant>(serde_json::json!({
            "key": key, "claims": claims, "signature": signature,
        }))
    };
    let valid = grant(encode(&point()), encode(&claims), encode(&[1; 72])).unwrap();
    assert_eq!(valid.key(), point());
    assert_eq!(valid.claims(), claims);
    assert_eq!(valid.signature(), [1_u8; 72]);
    assert_eq!(
        serde_json::from_value::<PushGrant>(serde_json::to_value(&valid).unwrap()).unwrap(),
        valid
    );

    let mut compressed = point();
    compressed.truncate(33);
    compressed[0] = 0x02;
    let mut wrong_prefix = point();
    wrong_prefix[0] = 0x05;
    let padded = format!("{}=", encode(&[1; 71]));
    let standard_alphabet = base64::engine::general_purpose::STANDARD_NO_PAD.encode([0xfb; 72]);
    for (key, claims, signature, why) in [
        (
            encode(&compressed),
            encode(&claims),
            encode(&[1; 72]),
            "compressed key",
        ),
        (
            encode(&wrong_prefix),
            encode(&claims),
            encode(&[1; 72]),
            "not a point",
        ),
        (
            encode(&point()),
            String::new(),
            encode(&[1; 72]),
            "empty claims",
        ),
        (
            encode(&point()),
            encode(&[b'x'; MAX_GRANT_CLAIMS_BYTES + 1]),
            encode(&[1; 72]),
            "long claims",
        ),
        (
            encode(&point()),
            encode(&claims),
            String::new(),
            "empty signature",
        ),
        (
            encode(&point()),
            encode(&claims),
            encode(&[1; MAX_GRANT_SIGNATURE_BYTES + 1]),
            "long signature",
        ),
        (encode(&point()), encode(&claims), padded, "padding"),
        (
            encode(&point()),
            encode(&claims),
            standard_alphabet,
            "standard alphabet",
        ),
    ] {
        assert!(grant(key, claims, signature).is_err(), "{why}");
    }
    let extra = serde_json::json!({
        "key": encode(&point()),
        "claims": encode(&claims),
        "signature": encode(&[1; 72]),
        "note": "unsigned",
    });
    assert!(serde_json::from_value::<PushGrant>(extra).is_err());
}

#[test]
fn a_push_key_id_is_short_stable_and_a_push_id() {
    let id = push_key_id(&point());
    assert_eq!(id, push_key_id(&point()));
    assert_eq!(id.as_str().len(), 18);
    assert!(id.as_str().starts_with("k."));
    assert_eq!(
        PushId::try_from(id.as_str().to_string()).unwrap(),
        id,
        "inside the PushId alphabet"
    );
    let mut other = point();
    other[64] = 0;
    assert_ne!(push_key_id(&other), id);
}

#[test]
fn the_signature_covers_the_context_then_the_claims() {
    assert_eq!(PUSH_GRANT_CONTEXT, b"dure-push-grant-v1\0");
    let input = grant_signing_input(b"{}");
    assert_eq!(input, b"dure-push-grant-v1\0{}");
}

/// The claims name the APNs token, and a log line must not carry it.
#[test]
fn debug_output_never_carries_the_token() {
    let claims = claims();
    let token = claims.token.as_str().to_string();
    let bytes = claims.to_canonical_bytes();
    let grant = PushGrant::new(point(), bytes.clone(), vec![1; 72]).unwrap();
    let request = crate::hello::HubRequest::UpdatePushSubscriptionV2 {
        registration: Some(crate::push::PushRegistration {
            subscription: PushSubscription {
                token: claims.token.clone(),
                environment: claims.environment,
                preference: claims.preference,
                language: crate::push::PushLanguage::En,
            },
            grant,
        }),
    };
    let printed = format!("{claims:?} {request:?}");
    assert!(!printed.contains(&token), "{printed}");
    assert!(
        !printed.contains(&URL_SAFE_NO_PAD.encode(&bytes)),
        "{printed}"
    );
    assert!(
        printed.contains(push_key_id(&point()).as_str()),
        "{printed}"
    );
}

#[test]
fn a_challenge_is_read_from_its_alert_and_absent_otherwise() {
    let key = push_key_id(&point());
    let payload = |dure: serde_json::Value| {
        serde_json::to_vec(&serde_json::json!({
            "aps": { "alert": { "body": "Dure alerts are on for this iPhone." } },
            "dure": dure,
        }))
        .unwrap()
    };
    let delivered = payload(serde_json::json!({
        "challenge": "00112233445566778899aabbccddeeff",
        "key": key.as_str(),
    }));
    let challenge = PushChallenge::from_payload(&delivered).unwrap();
    assert_eq!(
        (challenge.challenge.as_str(), &challenge.key),
        ("00112233445566778899aabbccddeeff", &key)
    );
    assert_eq!(
        serde_json::from_value::<PushChallenge>(serde_json::to_value(&challenge).unwrap()).unwrap(),
        challenge
    );
    // A challenge never opens or answers anything.
    assert_eq!(
        PushAlertContext::from_payload(&delivered),
        PushAlertContext::default()
    );

    for unusable in [
        payload(
            serde_json::json!({ "challenge": "00112233445566778899AABBCCDDEEFF", "key": key.as_str() }),
        ),
        payload(serde_json::json!({ "challenge": "0011", "key": key.as_str() })),
        payload(
            serde_json::json!({ "challenge": "00112233445566778899aabbccddeeff", "key": "k/1" }),
        ),
        payload(serde_json::json!({ "challenge": "00112233445566778899aabbccddeeff" })),
        payload(serde_json::json!({ "key": key.as_str() })),
        payload(serde_json::json!({ "session": "agent-1", "kind": "done" })),
        payload(serde_json::json!("00112233445566778899aabbccddeeff")),
        br#"{"aps":{}}"#.to_vec(),
        b"not json".to_vec(),
    ] {
        assert_eq!(
            PushChallenge::from_payload(&unusable),
            None,
            "{}",
            String::from_utf8_lossy(&unusable)
        );
    }
}
