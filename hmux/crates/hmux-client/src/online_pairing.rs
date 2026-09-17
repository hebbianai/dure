//! Shared wire documents and proofs for one online pairing exchange.
//!
//! The laptop CLI writes these documents and the phone reads them. Keeping the
//! serde shapes, transcript order, and HMAC implementation here gives that
//! protocol one authority; neither endpoint reconstructs the byte layout.

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::time::{Duration, Instant};

pub mod exchange_io;

pub const PAIRING_PROTOCOL_VERSION: u32 = 1;
/// One exchange budget shared by the phone and the fleet installer.
pub const PAIRING_EXCHANGE_BUDGET: Duration = Duration::from_secs(90);
pub const PAIRING_DEADLINE_ELAPSED: &str = "pairing_deadline_elapsed";

/// Remaining time from the caller's one monotonic exchange deadline.
pub fn pairing_time_remaining(deadline: Instant) -> Result<Duration, &'static str> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or(PAIRING_DEADLINE_ELAPSED)
}

/// Response-proof capability advertised additively in the pairing QR.
pub const AUTHENTICATED_RESPONSE_PROOF_VERSION: u32 = 2;

/// Largest request accepted before the connection is dropped.
pub const MAX_REQUEST_BYTES: usize = 8 * 1024;

/// Shortest acceptable nonce, making every request transcript unique.
pub const MIN_NONCE_BYTES: usize = 16;

const PRIVATE_KEY_MARKERS: &[&str] = &[
    "private key",
    "openssh private",
    "-----begin",
    "putty-user-key-file",
];
const SHA256_BLOCK_BYTES: usize = 64;
const REQUEST_LABEL: &[u8] = b"hmux-pairing-request-v1";
const RESPONSE_V1_LABEL: &[u8] = b"hmux-pairing-response-v1";
const RESPONSE_V2_LABEL: &[u8] = b"hmux-pairing-response-v2";

/// Whether raw pairing bytes contain a recognizable private-key envelope.
///
/// Both endpoints call this before parsing or transmitting a request so the
/// protocol has one definition of material that must never cross the wire.
#[must_use]
pub fn contains_private_key_material(raw: &[u8]) -> bool {
    let lowered = String::from_utf8_lossy(raw).to_ascii_lowercase();
    PRIVATE_KEY_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PairingRequest {
    pub version: u32,
    /// Free text shown to the owner. It is never written to authorized_keys.
    pub device_name: String,
    /// An OpenSSH one-line public key.
    pub public_key: String,
    /// Standard-base64 nonce, at least [`MIN_NONCE_BYTES`] when decoded.
    pub nonce: String,
    /// Standard-base64 HMAC-SHA256 request proof.
    pub proof: String,
}

/// The answer, tagged so a reader branches on status before its body.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PairingResponse {
    Paired(PairedAnswer),
    Refused(Refusal),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PairedAnswer {
    pub version: u32,
    pub device_id: String,
    /// Every configured host, including failed installs.
    pub hosts: Vec<HostAnswer>,
    /// Standard-base64 legacy response proof.
    pub proof: String,
    /// Proof v2 authenticates every semantic host field, including its SSH pin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_v2: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HostAnswer {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub installed: bool,
    pub failure: Option<String>,
    pub host_key_fingerprint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Refusal {
    pub version: u32,
    /// Stable machine token such as `pairing_token_already_used`.
    pub reason: String,
    pub detail: String,
}

impl PairingResponse {
    #[must_use]
    pub fn refused(reason: &str, detail: impl Into<String>) -> Self {
        Self::Refused(Refusal {
            version: PAIRING_PROTOCOL_VERSION,
            reason: reason.to_owned(),
            detail: detail.into(),
        })
    }
}

/// Request proof fields. Order: version, device name, public key, nonce.
pub struct RequestTranscript {
    parts: Vec<Vec<u8>>,
}

impl RequestTranscript {
    #[must_use]
    pub fn new(version: u32, device_name: &str, public_key: &str, nonce: &[u8]) -> Self {
        Self {
            parts: vec![
                version.to_string().into_bytes(),
                device_name.as_bytes().to_vec(),
                public_key.as_bytes().to_vec(),
                nonce.to_vec(),
            ],
        }
    }

    #[must_use]
    pub fn proof(&self, token: &[u8]) -> [u8; 32] {
        proof(token, REQUEST_LABEL, &self.parts)
    }

    #[must_use]
    pub fn verifies(&self, token: &[u8], offered: &[u8]) -> bool {
        constant_time_eq(&self.proof(token), offered)
    }
}

/// Deployed response-v1 fields. This layout stays byte-for-byte compatible.
pub struct ResponseTranscriptV1 {
    parts: Vec<Vec<u8>>,
}

impl ResponseTranscriptV1 {
    #[must_use]
    pub fn new(nonce: &[u8], device_id: &str, hosts: &[HostAnswer]) -> Self {
        let mut parts = vec![nonce.to_vec(), device_id.as_bytes().to_vec()];
        for host in hosts {
            parts.push(host.id.as_bytes().to_vec());
            parts.push(host.host.as_bytes().to_vec());
            parts.push(host.port.to_string().into_bytes());
            parts.push(host.user.as_bytes().to_vec());
            parts.push(bool_field(host.installed));
        }
        Self { parts }
    }

    #[must_use]
    pub fn proof(&self, token: &[u8]) -> [u8; 32] {
        proof(token, RESPONSE_V1_LABEL, &self.parts)
    }

    #[must_use]
    pub fn verifies(&self, token: &[u8], offered: &[u8]) -> bool {
        constant_time_eq(&self.proof(token), offered)
    }
}

/// Response-v2 fields: answer version plus every semantic host field.
pub struct ResponseTranscriptV2 {
    parts: Vec<Vec<u8>>,
}

impl ResponseTranscriptV2 {
    #[must_use]
    pub fn new(version: u32, nonce: &[u8], device_id: &str, hosts: &[HostAnswer]) -> Self {
        let mut parts = vec![
            version.to_string().into_bytes(),
            nonce.to_vec(),
            device_id.as_bytes().to_vec(),
        ];
        for host in hosts {
            // Exhaustive on purpose: adding a semantic answer field must force
            // an explicit decision about whether and where v2 authenticates it.
            let HostAnswer {
                id,
                name,
                host,
                port,
                user,
                installed,
                failure,
                host_key_fingerprint,
            } = host;
            parts.push(id.as_bytes().to_vec());
            parts.push(name.as_bytes().to_vec());
            parts.push(host.as_bytes().to_vec());
            parts.push(port.to_string().into_bytes());
            parts.push(user.as_bytes().to_vec());
            parts.push(bool_field(*installed));
            push_optional(&mut parts, failure.as_deref());
            push_optional(&mut parts, host_key_fingerprint.as_deref());
        }
        Self { parts }
    }

    #[must_use]
    pub fn proof(&self, token: &[u8]) -> [u8; 32] {
        proof(token, RESPONSE_V2_LABEL, &self.parts)
    }

    #[must_use]
    pub fn verifies(&self, token: &[u8], offered: &[u8]) -> bool {
        constant_time_eq(&self.proof(token), offered)
    }
}

fn bool_field(value: bool) -> Vec<u8> {
    if value { b"1".to_vec() } else { b"0".to_vec() }
}

fn push_optional(parts: &mut Vec<Vec<u8>>, value: Option<&str>) {
    parts.push(bool_field(value.is_some()));
    parts.push(value.unwrap_or_default().as_bytes().to_vec());
}

fn proof(token: &[u8], label: &[u8], fields: &[Vec<u8>]) -> [u8; 32] {
    let mut message = Vec::new();
    for field in std::iter::once(label).chain(fields.iter().map(Vec::as_slice)) {
        message.extend_from_slice(&(field.len() as u64).to_be_bytes());
        message.extend_from_slice(field);
    }
    hmac_sha256(token, &message)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut padded = [0u8; SHA256_BLOCK_BYTES];
    if key.len() > SHA256_BLOCK_BYTES {
        padded[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        padded[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36u8; SHA256_BLOCK_BYTES];
    let mut outer_pad = [0x5cu8; SHA256_BLOCK_BYTES];
    for index in 0..SHA256_BLOCK_BYTES {
        inner_pad[index] ^= padded[index];
        outer_pad[index] ^= padded[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner.finalize());
    outer.finalize().into()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        use std::fmt::Write as _;

        bytes.iter().fold(
            String::with_capacity(bytes.len() * 2),
            |mut encoded, byte| {
                write!(encoded, "{byte:02x}").expect("writing to a String cannot fail");
                encoded
            },
        )
    }

    fn answer(installed: bool) -> HostAnswer {
        HostAnswer {
            id: "h1".into(),
            name: "build box".into(),
            host: "10.0.0.4".into(),
            port: 22,
            user: "kattpish".into(),
            installed,
            failure: None,
            host_key_fingerprint: Some("SHA256:AAAABBBB".into()),
        }
    }

    #[test]
    fn private_key_markers_have_one_case_insensitive_wire_definition() {
        assert!(contains_private_key_material(
            br#"{"device_name":"my OpenSSH PRIVATE key backup"}"#
        ));
        assert!(contains_private_key_material(
            b"PuTTY-User-Key-File-3: ssh-rsa"
        ));
        assert!(!contains_private_key_material(
            br#"{"public_key":"ssh-ed25519 AAAA phone"}"#
        ));
    }

    #[test]
    fn hmac_matches_the_rfc_4231_first_vector() {
        let mac = hmac_sha256(&[0x0b; 20], b"Hi There");
        let actual = hex(&mac);
        assert_eq!(
            actual,
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn response_proofs_keep_the_deployed_and_v2_vectors() {
        let token = b"0123456789abcdef0123456789abcdef";
        let host = answer(true);

        assert_eq!(
            hex(&ResponseTranscriptV1::new(
                b"nonce-bytes-here",
                "device-1",
                std::slice::from_ref(&host),
            )
            .proof(token)),
            "fab2b02941fa0a0b8bc7fdbfa30bea7b517a88ddb0a6c8d7b86974978ac28bb1"
        );
        assert_eq!(
            hex(&ResponseTranscriptV2::new(
                PAIRING_PROTOCOL_VERSION,
                b"nonce-bytes-here",
                "device-1",
                &[host],
            )
            .proof(token)),
            "776cccc282befa610a4bb90cc5ba4b4c770ba483e05bc8a50069ac849d32226a"
        );
    }

    #[test]
    fn request_proof_keeps_the_deployed_v1_vector() {
        let proof = RequestTranscript::new(
            PAIRING_PROTOCOL_VERSION,
            "phone",
            "ssh-ed25519 AAAA",
            b"nonce-bytes-here",
        )
        .proof(b"0123456789abcdef0123456789abcdef");

        assert_eq!(
            hex(&proof),
            "79735936a39d3df9a7f7a86f7c1e971c6b8322d830a7d30d33a9d70f0a1e6d6b"
        );
    }

    #[test]
    fn v2_authenticates_fields_v1_did_not_cover() {
        let original = answer(true);
        let mut substituted = original.clone();
        substituted.host_key_fingerprint = Some("SHA256:BBBBCCCC".into());

        assert_eq!(
            ResponseTranscriptV1::new(b"nonce", "d1", std::slice::from_ref(&original))
                .proof(b"token"),
            ResponseTranscriptV1::new(b"nonce", "d1", std::slice::from_ref(&substituted))
                .proof(b"token")
        );
        assert_ne!(
            ResponseTranscriptV2::new(PAIRING_PROTOCOL_VERSION, b"nonce", "d1", &[original],)
                .proof(b"token"),
            ResponseTranscriptV2::new(PAIRING_PROTOCOL_VERSION, b"nonce", "d1", &[substituted],)
                .proof(b"token")
        );
    }

    #[test]
    fn old_readers_ignore_the_additive_v2_proof() {
        #[derive(Deserialize)]
        struct LegacyPairedAnswer {
            version: u32,
            device_id: String,
            hosts: Vec<HostAnswer>,
            proof: String,
        }

        let current = PairedAnswer {
            version: PAIRING_PROTOCOL_VERSION,
            device_id: "d1".into(),
            hosts: vec![answer(true)],
            proof: "legacy".into(),
            proof_v2: Some("authenticated-pins".into()),
        };
        let legacy: LegacyPairedAnswer =
            serde_json::from_str(&serde_json::to_string(&current).unwrap()).unwrap();

        assert_eq!(legacy.version, PAIRING_PROTOCOL_VERSION);
        assert_eq!(legacy.device_id, "d1");
        assert_eq!(legacy.hosts.len(), 1);
        assert_eq!(legacy.proof, "legacy");
    }
}
