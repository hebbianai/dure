//! Pairing with no channel between the phone and the laptop.
//!
//! The v1 flow needs one network round trip: the QR names a `host:port` the
//! phone dials to prove a token, and the laptop answers with the inventory.
//! That works at a desk on one wifi and nowhere else — a phone on cellular and
//! a laptop on wifi are at the desk and still cannot reach each other.
//!
//! So v2 carries everything and dials nothing. The laptop generates the key
//! pair, installs the **public** half on each server itself, and puts the
//! **private** half plus the server list inside the QR.
//!
//! # What that costs, and what pays for it
//!
//! A photograph of the screen would otherwise be a working credential, and
//! nothing can expire it: the public key is already in `authorized_keys`, so a
//! TTL on the QR bounds nothing an attacker cares about. The payload is
//! therefore sealed with a short code the laptop prints *beside* the QR and the
//! owner types on the phone. A camera that captures the screen captures both,
//! but a screenshot pasted into a chat, a photo taken over a shoulder, or a
//! recording of a shared screen generally carries the QR alone — and the QR
//! alone decrypts to nothing.
//!
//! The code is six characters of [Crockford base32], not six digits. Same
//! typing, and 32⁶ ≈ 1.07e9 instead of 1e6 — three orders of magnitude, for
//! free. It matters because the attack is *offline*: whoever holds the payload
//! guesses at their own pace, so the only defences are the size of the space
//! and the cost of one guess.
//!
//! One guess costs an Argon2id derivation at 64 MiB. That is deliberately
//! memory-hard rather than merely slow: memory is what a GPU array cannot
//! multiply cheaply, and a purely iterative KDF would be the one an attacker
//! parallelises best.
//!
//! **This is a bounded delay, not a wall.** A determined holder of the payload
//! gets through 32⁶ eventually. The real revocation is `hmux pair revoke`,
//! which removes the key from every host it was installed on; the code buys the
//! time to notice and do that. Said plainly here because "encrypted" invites
//! the reader to stop thinking.
//!
//! # Why the parameters are not in the payload
//!
//! A payload that names its own KDF cost is a payload an attacker can rewrite
//! to name a cheaper one, and the phone would obey. The version *is* the
//! parameter set: `hmux-pair:2` means exactly the constants below, and a future
//! tuning becomes `hmux-pair:3` rather than a field.
//!
//! [Crockford base32]: https://www.crockford.com/base32.html

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

/// Scheme and version. Also the AEAD's associated data, so a payload cannot be
/// replayed as a different version by rewriting the prefix.
pub const PAYLOAD_SCHEME: &str = "hmux-pair:2";

/// Argon2id cost. Fixed by the version rather than carried in the payload.
///
/// 64 MiB × 3 passes lands around a fifth of a second on the phones this
/// targets — slow enough to matter 10⁹ times over, fast enough that the owner
/// does not think the app hung. Parallelism is 1 because the wall-clock cost on
/// one device is the point; letting the deriver use more lanes helps the
/// attacker's array at least as much as it helps the phone.
const KDF_MEMORY_KIB: u32 = 64 * 1024;
const KDF_ITERATIONS: u32 = 3;
const KDF_PARALLELISM: u32 = 1;
const KDF_OUTPUT_BYTES: usize = 32;

/// Salt length. 16 bytes is the Argon2 recommendation and the reason two
/// laptops pairing with the same code never share a derived key.
const SALT_BYTES: usize = 16;
/// XChaCha20 takes a 24-byte nonce, which is what makes a random one safe.
const NONCE_BYTES: usize = 24;
/// An ed25519 private key is a 32-byte seed. Carrying the seed rather than an
/// OpenSSH PEM keeps the QR small enough to stay readable across a desk; the
/// phone reconstructs the PEM, and both sides agree on that because there is
/// exactly one way to expand an ed25519 seed.
pub const SEED_BYTES: usize = 32;

/// Characters a code may contain. Crockford base32: no `I`, `L`, `O`, or `U`.
///
/// The first three are excluded because they are misread as `1`, `1`, and `0`
/// on a screen at arm's length, and `U` because it turns an unlucky code into a
/// word nobody wants to read out. Excluding them is not politeness — a code the
/// owner types wrong is a pairing that fails for a reason the screen cannot
/// explain.
pub const CODE_ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/// Length of a pairing code. 32⁶ ≈ 1.07e9.
pub const CODE_LENGTH: usize = 6;

#[derive(Debug, Eq, PartialEq)]
pub enum OfflinePairingError {
    /// The text is not a `hmux-pair:2` payload at all.
    NotThisScheme,
    /// Structurally a v2 payload, but a field is missing or unreadable.
    Malformed(&'static str),
    /// The code did not decrypt the payload.
    ///
    /// One variant for "wrong code" and "tampered payload" on purpose: the AEAD
    /// cannot tell them apart, and a screen that guessed would be wrong exactly
    /// when it matters. The phone says "check the code" and that is honest for
    /// both.
    WrongCodeOrTampered,
    /// Decrypted cleanly and the contents are not what v2 describes.
    MalformedContents(&'static str),
}

impl std::fmt::Display for OfflinePairingError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotThisScheme => write!(formatter, "not an hmux pairing QR"),
            Self::Malformed(detail) => write!(formatter, "malformed pairing payload: {detail}"),
            Self::WrongCodeOrTampered => write!(
                formatter,
                "the code did not open this QR; check the characters on the laptop screen"
            ),
            Self::MalformedContents(detail) => {
                write!(
                    formatter,
                    "pairing payload decoded to something unusable: {detail}"
                )
            }
        }
    }
}

impl std::error::Error for OfflinePairingError {}

/// One server the phone should adopt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfflineHost {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// `SHA256:…`, pinned so the phone's first connection is checked against
    /// something the owner approved rather than trusted on sight.
    pub host_key_fingerprint: String,
}

/// Everything the phone needs, once the code has opened it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfflinePairingContents {
    /// The ed25519 seed whose public half is already in each `authorized_keys`.
    pub private_key_seed: [u8; SEED_BYTES],
    pub hosts: Vec<OfflineHost>,
}

/// Fields are tab-separated and records newline-separated, so a value
/// containing either would silently become two fields. Refused at construction
/// rather than escaped: none of these can legitimately contain a control
/// character, and an escape layer is a second thing both sides must implement
/// identically.
fn refuse_separators(value: &str, field: &'static str) -> Result<(), OfflinePairingError> {
    if value.contains('\t') || value.contains('\n') || value.contains('\r') {
        return Err(OfflinePairingError::MalformedContents(field));
    }
    Ok(())
}

impl OfflinePairingContents {
    fn encode(&self) -> Result<Vec<u8>, OfflinePairingError> {
        let mut plaintext = Vec::with_capacity(64 + self.hosts.len() * 96);
        plaintext.extend_from_slice(&self.private_key_seed);
        for host in &self.hosts {
            refuse_separators(&host.id, "id")?;
            refuse_separators(&host.label, "label")?;
            refuse_separators(&host.host, "host")?;
            refuse_separators(&host.username, "username")?;
            refuse_separators(&host.host_key_fingerprint, "fingerprint")?;
            plaintext.extend_from_slice(
                format!(
                    "{}\t{}\t{}\t{}\t{}\n",
                    host.id, host.label, host.host, host.port, host.username
                )
                .as_bytes(),
            );
            plaintext.extend_from_slice(host.host_key_fingerprint.as_bytes());
            plaintext.push(b'\n');
        }
        Ok(plaintext)
    }

    fn decode(plaintext: &[u8]) -> Result<Self, OfflinePairingError> {
        if plaintext.len() < SEED_BYTES {
            return Err(OfflinePairingError::MalformedContents("no key seed"));
        }
        let (seed, rest) = plaintext.split_at(SEED_BYTES);
        let mut private_key_seed = [0u8; SEED_BYTES];
        private_key_seed.copy_from_slice(seed);

        let text = std::str::from_utf8(rest)
            .map_err(|_| OfflinePairingError::MalformedContents("host records are not UTF-8"))?;
        let mut lines = text.split_terminator('\n');
        let mut hosts = Vec::new();
        while let Some(record) = lines.next() {
            let fingerprint = lines.next().ok_or(OfflinePairingError::MalformedContents(
                "a host record without a fingerprint line",
            ))?;
            let mut fields = record.split('\t');
            let mut next = |what: &'static str| {
                fields
                    .next()
                    .ok_or(OfflinePairingError::MalformedContents(what))
            };
            let id = next("id")?.to_string();
            let label = next("label")?.to_string();
            let host = next("host")?.to_string();
            let port: u16 = next("port")?
                .parse()
                .map_err(|_| OfflinePairingError::MalformedContents("port"))?;
            let username = next("username")?.to_string();
            if fields.next().is_some() {
                return Err(OfflinePairingError::MalformedContents(
                    "a host record with unexpected extra fields",
                ));
            }
            hosts.push(OfflineHost {
                id,
                label,
                host,
                port,
                username,
                host_key_fingerprint: fingerprint.to_string(),
            });
        }
        Ok(Self {
            private_key_seed,
            hosts,
        })
    }
}

fn base64url() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}

/// Normalises what the owner typed into the canonical code.
///
/// Case is folded and Crockford's confusable letters are mapped to the digits
/// they resemble, so a code read off a screen and typed with `O` for `0` still
/// opens the payload. Separators the owner may add for readability are dropped.
/// Returns `None` when what is left is not a code, so the caller can say so
/// before spending a second on a derivation that cannot succeed.
#[must_use]
pub fn normalize_code(typed: &str) -> Option<String> {
    let mut normalized = String::with_capacity(CODE_LENGTH);
    for character in typed.chars() {
        if character.is_whitespace() || character == '-' {
            continue;
        }
        let upper = character.to_ascii_uppercase();
        let mapped = match upper {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        };
        if !CODE_ALPHABET.contains(&(mapped as u8)) {
            return None;
        }
        normalized.push(mapped);
    }
    (normalized.len() == CODE_LENGTH).then_some(normalized)
}

fn derive_key(code: &str, salt: &[u8]) -> Result<[u8; KDF_OUTPUT_BYTES], OfflinePairingError> {
    let params = Params::new(
        KDF_MEMORY_KIB,
        KDF_ITERATIONS,
        KDF_PARALLELISM,
        Some(KDF_OUTPUT_BYTES),
    )
    .map_err(|_| OfflinePairingError::Malformed("kdf parameters"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KDF_OUTPUT_BYTES];
    argon
        .hash_password_into(code.as_bytes(), salt, &mut key)
        .map_err(|_| OfflinePairingError::Malformed("key derivation"))?;
    Ok(key)
}

/// Seals `contents` under `code`, returning the QR text.
///
/// `salt` and `nonce` are arguments rather than generated here so the caller
/// owns its randomness — and so the tests can pin a vector. Both must come from
/// a cryptographic RNG in production; reusing a nonce under one derived key is
/// the one mistake XChaCha20's 24-byte nonce is sized to make unlikely, not
/// impossible.
pub fn seal(
    contents: &OfflinePairingContents,
    code: &str,
    salt: &[u8; SALT_BYTES],
    nonce: &[u8; NONCE_BYTES],
) -> Result<String, OfflinePairingError> {
    let key = derive_key(code, salt)?;
    let cipher = XChaCha20Poly1305::new(&key.into());
    let plaintext = contents.encode()?;
    let sealed = cipher
        .encrypt(
            &XNonce::from(*nonce),
            Payload {
                msg: &plaintext,
                aad: PAYLOAD_SCHEME.as_bytes(),
            },
        )
        .map_err(|_| OfflinePairingError::Malformed("sealing"))?;
    let mut body = Vec::with_capacity(NONCE_BYTES + sealed.len());
    body.extend_from_slice(nonce);
    body.extend_from_slice(&sealed);
    Ok(format!(
        "{PAYLOAD_SCHEME}?s={}&c={}",
        base64url().encode(salt),
        base64url().encode(&body)
    ))
}

/// Opens a payload with the code the owner typed.
///
/// The code is normalised here rather than by the caller, so every front end
/// accepts the same typing.
pub fn open(
    payload: &str,
    typed_code: &str,
) -> Result<OfflinePairingContents, OfflinePairingError> {
    let rest = payload
        .strip_prefix(PAYLOAD_SCHEME)
        .and_then(|rest| rest.strip_prefix('?'))
        .ok_or(OfflinePairingError::NotThisScheme)?;
    let mut salt_field = None;
    let mut sealed_field = None;
    for pair in rest.split('&') {
        match pair.split_once('=') {
            Some(("s", value)) => salt_field = Some(value),
            Some(("c", value)) => sealed_field = Some(value),
            // Unknown fields are ignored, not refused: a later version may add
            // one, and a phone that refuses the whole payload over a field it
            // does not need would strand an owner for no reason.
            _ => {}
        }
    }
    let salt = base64url()
        .decode(salt_field.ok_or(OfflinePairingError::Malformed("no salt"))?)
        .map_err(|_| OfflinePairingError::Malformed("salt is not base64url"))?;
    if salt.len() != SALT_BYTES {
        return Err(OfflinePairingError::Malformed("salt length"));
    }
    let body = base64url()
        .decode(sealed_field.ok_or(OfflinePairingError::Malformed("no ciphertext"))?)
        .map_err(|_| OfflinePairingError::Malformed("ciphertext is not base64url"))?;
    if body.len() <= NONCE_BYTES {
        return Err(OfflinePairingError::Malformed("ciphertext too short"));
    }
    let code = normalize_code(typed_code).ok_or(OfflinePairingError::WrongCodeOrTampered)?;
    let key = derive_key(&code, &salt)?;
    let cipher = XChaCha20Poly1305::new(&key.into());
    let (nonce, sealed) = body.split_at(NONCE_BYTES);
    // The length was checked above, so this cannot fail; `TryFrom` rather than
    // the deprecated `from_slice` because that one panics on a bad length, and a
    // panic reached from a scanned QR is a crash an attacker chooses.
    let nonce =
        XNonce::try_from(nonce).map_err(|_| OfflinePairingError::Malformed("nonce length"))?;
    let plaintext = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: sealed,
                aad: PAYLOAD_SCHEME.as_bytes(),
            },
        )
        .map_err(|_| OfflinePairingError::WrongCodeOrTampered)?;
    OfflinePairingContents::decode(&plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 주소는 RFC 5737 문서 전용 대역과 `example.com`을 쓴다.
    ///
    /// 개발자의 실제 서버 주소를 픽스처에 넣으면 그것이 저장소에 영구히 남고,
    /// 이 저장소가 공개로 가는 날 함께 넘어간다. 테스트가 필요한 것은 주소가
    /// 왕복하는지이지 그 주소가 진짜인지가 아니다.
    fn contents() -> OfflinePairingContents {
        OfflinePairingContents {
            private_key_seed: [7u8; SEED_BYTES],
            hosts: vec![
                OfflineHost {
                    id: "gate1".into(),
                    label: "Gate1".into(),
                    host: "192.0.2.10".into(),
                    port: 22,
                    username: "gate1".into(),
                    host_key_fingerprint: "SHA256:oNHiIEYQVRhn6eXM4a5EF1".into(),
                },
                OfflineHost {
                    id: "clink".into(),
                    label: "Clink".into(),
                    host: "server-b.example.com".into(),
                    port: 22,
                    username: "ubuntu".into(),
                    host_key_fingerprint: "SHA256:2iw17Ip0l2zanMEt1Wxmnm".into(),
                },
            ],
        }
    }

    const SALT: [u8; SALT_BYTES] = [3u8; SALT_BYTES];
    const NONCE: [u8; NONCE_BYTES] = [5u8; NONCE_BYTES];

    #[test]
    fn what_is_sealed_with_a_code_opens_with_that_code() {
        let payload = seal(&contents(), "K7F2QX", &SALT, &NONCE).expect("seals");
        assert_eq!(open(&payload, "K7F2QX").expect("opens"), contents());
    }

    /// The property the whole design rests on: the QR alone is not a credential.
    #[test]
    fn the_payload_alone_yields_nothing_without_the_code() {
        let payload = seal(&contents(), "K7F2QX", &SALT, &NONCE).expect("seals");

        assert_eq!(
            open(&payload, "K7F2QY").unwrap_err(),
            OfflinePairingError::WrongCodeOrTampered
        );
        // And the seed is not sitting in the text for a reader who skips the
        // decryption entirely.
        let seed = base64url().encode([7u8; SEED_BYTES]);
        assert!(
            !payload.contains(&seed),
            "the key seed must not be recoverable from the payload text"
        );
    }

    /// A payload edited in flight must fail closed rather than decode to
    /// something the phone then acts on.
    #[test]
    fn a_tampered_ciphertext_is_refused_rather_than_decoded() {
        let payload = seal(&contents(), "K7F2QX", &SALT, &NONCE).expect("seals");
        let (head, tail) = payload.split_at(payload.len() - 4);
        let flipped = format!(
            "{head}{}",
            if tail.starts_with('A') {
                "BBBB"
            } else {
                "AAAA"
            }
        );

        assert_eq!(
            open(&flipped, "K7F2QX").unwrap_err(),
            OfflinePairingError::WrongCodeOrTampered
        );
    }

    /// The scheme is the AEAD's associated data, so relabelling a payload as
    /// another version cannot succeed even with the right code.
    #[test]
    fn a_payload_relabelled_as_another_version_does_not_open() {
        let payload = seal(&contents(), "K7F2QX", &SALT, &NONCE).expect("seals");
        let relabelled = payload.replace("hmux-pair:2", "hmux-pair:9");

        assert_eq!(
            open(&relabelled, "K7F2QX").unwrap_err(),
            OfflinePairingError::NotThisScheme
        );
    }

    /// Typed at a desk, off a screen, by someone who reads `0` as `O`.
    #[test]
    fn a_code_survives_the_ways_a_person_actually_types_it() {
        let payload = seal(&contents(), "K7F2Q0", &SALT, &NONCE).expect("seals");

        for typed in ["K7F2Q0", "k7f2q0", "K7F2QO", "k7f2-qo", " K7F2 QO "] {
            assert_eq!(
                open(&payload, typed).map(|opened| opened.hosts.len()),
                Ok(2),
                "{typed:?} must open the same payload"
            );
        }
    }

    /// Not a code at all is answered before a 64 MiB derivation runs.
    #[test]
    fn input_that_cannot_be_a_code_is_rejected_without_deriving() {
        assert_eq!(normalize_code("K7F2Q"), None, "too short");
        assert_eq!(normalize_code("K7F2QXX"), None, "too long");
        assert_eq!(normalize_code("K7F2Q!"), None, "not in the alphabet");
        assert_eq!(normalize_code("K7F2QU"), None, "U is excluded");
    }

    /// Whatever the QR holds has to survive the round trip byte for byte —
    /// a fingerprint that loses a character pins the wrong host.
    #[test]
    fn every_host_field_survives_the_round_trip() {
        let payload = seal(&contents(), "K7F2QX", &SALT, &NONCE).expect("seals");
        let opened = open(&payload, "K7F2QX").expect("opens");

        assert_eq!(opened.hosts, contents().hosts);
        assert_eq!(opened.private_key_seed, [7u8; SEED_BYTES]);
    }

    /// A value carrying a separator would silently become two fields, so it is
    /// refused where it is introduced rather than corrupting a later decode.
    #[test]
    fn a_host_field_containing_a_separator_is_refused_at_seal_time() {
        let mut hostile = contents();
        hostile.hosts[0].label = "Gate1\tevil\tfields".into();

        assert_eq!(
            seal(&hostile, "K7F2QX", &SALT, &NONCE).unwrap_err(),
            OfflinePairingError::MalformedContents("label")
        );
    }

    /// The payload has to fit a QR that a phone can read across a desk. Version
    /// 40 holds 2953 bytes at the lowest error correction; staying well inside
    /// that is what keeps the symbol small enough to render in a terminal.
    #[test]
    fn a_realistic_fleet_stays_within_a_readable_qr() {
        let mut fleet = contents();
        while fleet.hosts.len() < 8 {
            let mut extra = fleet.hosts[1].clone();
            extra.id = format!("host-{}", fleet.hosts.len());
            fleet.hosts.push(extra);
        }

        let payload = seal(&fleet, "K7F2QX", &SALT, &NONCE).expect("seals");

        assert!(
            payload.len() < 1600,
            "eight servers produced {} bytes, which pushes the symbol past what \
             a terminal renders legibly",
            payload.len()
        );
    }

    /// A payload with no servers is a pairing that adopted nothing, and the
    /// phone should be handed that fact rather than an error that reads like a
    /// corrupt QR.
    #[test]
    fn a_payload_with_no_hosts_opens_and_reports_none() {
        let empty = OfflinePairingContents {
            private_key_seed: [1u8; SEED_BYTES],
            hosts: Vec::new(),
        };
        let payload = seal(&empty, "K7F2QX", &SALT, &NONCE).expect("seals");

        assert_eq!(open(&payload, "K7F2QX").expect("opens"), empty);
    }
}
