//! The phone's push grant: what lets one paired computer have alerts sent to
//! this phone through the push service (#660).
//!
//! The phone signs it with its per-install push key, over the exact computer
//! fingerprint it pinned at QR scan. The desktop carries it to the push
//! service, which is the only party that verifies it. This module owns the
//! format: which bytes are signed, how they are laid out, and the limits every
//! reader applies before any cryptography. It holds no key and verifies no
//! signature.
//!
//! # Why the claims travel as bytes
//!
//! A signature covers bytes, not a meaning. If the claims travelled as a JSON
//! object, every hop that re-serializes them could change the bytes, and two
//! readers (serde here, `JSON.parse` in the service) could read the same bytes
//! differently: a duplicate key is an error to one and "the last one wins" to
//! the other. So the claims travel as the exact signed bytes, and every reader
//! requires them to equal their canonical re-serialization: compact JSON,
//! fields in [`PushGrantClaims`]'s declaration order, no duplicate, no
//! whitespace, integers only, a lowercase token.

use super::{ApnsEnvironment, ApnsToken, PUSH_ALERT_CONTEXT_KEY, PushId, PushPreference};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

/// The claims format this build writes and reads in full.
pub const PUSH_GRANT_VERSION: u16 = 1;

/// What the signature covers before the claims, so a grant can never pass
/// for another document signed with the same key.
pub const PUSH_GRANT_CONTEXT: &[u8] = b"dure-push-grant-v1\0";

/// How long a grant the phone issues lasts. The phone renews it on each sync,
/// which runs whenever Dure comes to the foreground.
pub const PUSH_GRANT_LIFETIME_SECS: u64 = 14 * 24 * 60 * 60;

/// The longest grant the service accepts: the phone's lifetime plus a day of
/// clock disagreement.
pub const PUSH_GRANT_MAX_LIFETIME_SECS: u64 = 15 * 24 * 60 * 60;

/// How far ahead of the service's clock a grant's `issuedAt` may be.
pub const PUSH_GRANT_MAX_FUTURE_SKEW_SECS: u64 = 300;

/// An uncompressed P-256 point: `0x04`, then x and y.
pub const PUSH_KEY_BYTES: usize = 65;

/// Upper bound of the signed claims. Real claims are a few hundred bytes; the
/// bound keeps a reader from parsing more than that before any check.
pub const MAX_GRANT_CLAIMS_BYTES: usize = 1024;

/// Upper bound of the signature. A DER ECDSA P-256 signature is at most 72
/// bytes.
pub const MAX_GRANT_SIGNATURE_BYTES: usize = 80;

/// One grant as it crosses the desktop: the phone's public key, the signed
/// claims and the signature, each base64url without padding on the wire.
///
/// Reading one checks the structure only. Whether the signature holds is the
/// service's question.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "EncodedPushGrant", into = "EncodedPushGrant")]
pub struct PushGrant {
    key: Vec<u8>,
    claims: Vec<u8>,
    signature: Vec<u8>,
}

/// The wire form. Extensions belong in a later claims version, which is
/// signed, never in an extra field beside it.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodedPushGrant {
    key: String,
    claims: String,
    signature: String,
}

impl PushGrant {
    pub fn new(key: Vec<u8>, claims: Vec<u8>, signature: Vec<u8>) -> Result<Self, &'static str> {
        if key.len() != PUSH_KEY_BYTES || key[0] != 0x04 {
            return Err("A push key is an uncompressed P-256 point");
        }
        if claims.is_empty() || claims.len() > MAX_GRANT_CLAIMS_BYTES {
            return Err("Push grant claims are out of range");
        }
        if signature.is_empty() || signature.len() > MAX_GRANT_SIGNATURE_BYTES {
            return Err("A push grant signature is out of range");
        }
        Ok(Self {
            key,
            claims,
            signature,
        })
    }

    /// The phone's public key, an uncompressed P-256 point.
    pub fn key(&self) -> &[u8] {
        &self.key
    }

    /// The exact signed claims bytes.
    pub fn claims(&self) -> &[u8] {
        &self.claims
    }

    /// An ASN.1 DER ECDSA P-256 SHA-256 signature over
    /// [`grant_signing_input`] of [`Self::claims`].
    pub fn signature(&self) -> &[u8] {
        &self.signature
    }

    /// The name the service and the phone give this grant's key.
    pub fn key_id(&self) -> PushId {
        push_key_id(&self.key)
    }

    pub fn read_claims(&self) -> Result<PushGrantClaimsRead, PushGrantError> {
        PushGrantClaims::parse(&self.claims)
    }
}

impl TryFrom<EncodedPushGrant> for PushGrant {
    type Error = &'static str;

    fn try_from(encoded: EncodedPushGrant) -> Result<Self, Self::Error> {
        // Strict: no padding, no other alphabet, no stray trailing bits, so
        // one grant has exactly one spelling.
        let decode = |value: &str| {
            URL_SAFE_NO_PAD
                .decode(value)
                .map_err(|_| "A push grant field is not unpadded base64url")
        };
        Self::new(
            decode(&encoded.key)?,
            decode(&encoded.claims)?,
            decode(&encoded.signature)?,
        )
    }
}

impl From<PushGrant> for EncodedPushGrant {
    fn from(grant: PushGrant) -> Self {
        Self {
            key: URL_SAFE_NO_PAD.encode(grant.key),
            claims: URL_SAFE_NO_PAD.encode(grant.claims),
            signature: URL_SAFE_NO_PAD.encode(grant.signature),
        }
    }
}

/// The claims name the APNs token, so they are never printed.
impl std::fmt::Debug for PushGrant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PushGrant")
            .field("key", &self.key_id().as_str())
            .field("claims", &format_args!("<{} bytes>", self.claims.len()))
            .field(
                "signature",
                &format_args!("<{} bytes>", self.signature.len()),
            )
            .finish()
    }
}

/// What the phone signs: that alerts for this token may come from the
/// computer it pinned, for this preference, until `expires_at`.
///
/// The declaration order is the canonical order. Moving a field changes the
/// bytes every phone signs and every verifier expects.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PushGrantClaims {
    pub version: u16,
    pub token: ApnsToken,
    pub environment: ApnsEnvironment,
    /// The computer's certificate fingerprint as the phone pinned it
    /// ([`crate::fingerprint::of_der`]).
    pub hub: String,
    pub preference: PushPreference,
    /// Raised by the phone when it forgets a computer or narrows its
    /// preference. The service refuses grants older than the last it saw.
    pub epoch: u64,
    /// Unix seconds.
    pub issued_at: u64,
    /// Unix seconds.
    pub expires_at: u64,
    /// The challenge this grant answers, when the service asked the phone to
    /// prove it receives alerts for the token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<PushNonce>,
}

/// What [`PushGrantClaims::parse`] found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PushGrantClaimsRead {
    Known(PushGrantClaims),
    /// A later claims version. The desktop passes such a grant through
    /// unchanged rather than refusing what a newer phone and service agree
    /// on.
    Unknown {
        version: u16,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushGrantError {
    /// Not a claims object of a version this build reads: not JSON, too
    /// long, a field missing, unknown, repeated or of the wrong type.
    Malformed,
    /// The `hub` is not a certificate fingerprint.
    InvalidHub,
    /// Readable claims whose bytes are not the canonical serialization.
    NonCanonical,
}

impl std::fmt::Display for PushGrantError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Malformed => "The push grant claims are malformed",
            Self::InvalidHub => "The push grant does not name a computer fingerprint",
            Self::NonCanonical => "The push grant claims are not in canonical form",
        })
    }
}

impl std::error::Error for PushGrantError {}

impl PushGrantClaims {
    /// The bytes a phone signs for these claims.
    pub fn to_canonical_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("grant claims are plain fields and always serialize")
    }

    /// Reads signed claims bytes.
    ///
    /// The version comes first, from a probe that ignores the other fields,
    /// so a later version reads as [`PushGrantClaimsRead::Unknown`] instead of
    /// failing on fields this build does not know.
    pub fn parse(bytes: &[u8]) -> Result<PushGrantClaimsRead, PushGrantError> {
        #[derive(Deserialize)]
        struct VersionProbe {
            version: u16,
        }

        if bytes.len() > MAX_GRANT_CLAIMS_BYTES {
            return Err(PushGrantError::Malformed);
        }
        let probe: VersionProbe =
            serde_json::from_slice(bytes).map_err(|_| PushGrantError::Malformed)?;
        if probe.version > PUSH_GRANT_VERSION {
            return Ok(PushGrantClaimsRead::Unknown {
                version: probe.version,
            });
        }
        if probe.version != PUSH_GRANT_VERSION {
            return Err(PushGrantError::Malformed);
        }
        let claims: Self = serde_json::from_slice(bytes).map_err(|_| PushGrantError::Malformed)?;
        if !crate::fingerprint::is_fingerprint(&claims.hub) {
            return Err(PushGrantError::InvalidHub);
        }
        if claims.to_canonical_bytes() != bytes {
            return Err(PushGrantError::NonCanonical);
        }
        Ok(PushGrantClaimsRead::Known(claims))
    }
}

/// What a grant's signature covers: [`PUSH_GRANT_CONTEXT`], then the claims.
pub fn grant_signing_input(claims: &[u8]) -> Vec<u8> {
    let mut input = Vec::with_capacity(PUSH_GRANT_CONTEXT.len() + claims.len());
    input.extend_from_slice(PUSH_GRANT_CONTEXT);
    input.extend_from_slice(claims);
    input
}

/// The short name of a push key: `k.` and the first 8 bytes of its SHA-256
/// in hex. It names the key in a challenge without carrying the key itself.
pub fn push_key_id(point: &[u8]) -> PushId {
    let digest = Sha256::digest(point);
    let hex: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    PushId(format!("k.{hex}"))
}

/// The nonce a challenge alert carries and the next grant echoes: 16 random
/// bytes from the service, as 32 lowercase hex digits.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PushNonce(String);

impl TryFrom<String> for PushNonce {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() != 32
            || !value
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err("Invalid push challenge nonce");
        }
        Ok(Self(value))
    }
}

impl From<PushNonce> for String {
    fn from(value: PushNonce) -> Self {
        value.0
    }
}

impl PushNonce {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for PushNonce {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PushNonce(<redacted>)")
    }
}

/// What a challenge alert carries beside `aps`, under
/// [`PUSH_ALERT_CONTEXT_KEY`]: the service asks the holder of key `key` to
/// sign `challenge` back, which proves that key's phone receives this
/// token's alerts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushChallenge {
    pub challenge: PushNonce,
    pub key: PushId,
}

impl PushChallenge {
    /// Reads a challenge from a delivered alert's whole JSON payload. None for
    /// any other alert, and for a challenge with a malformed field.
    pub fn from_payload(payload: &[u8]) -> Option<Self> {
        let Ok(serde_json::Value::Object(mut payload)) = serde_json::from_slice(payload) else {
            return None;
        };
        let Some(serde_json::Value::Object(mut context)) = payload.remove(PUSH_ALERT_CONTEXT_KEY)
        else {
            return None;
        };
        Some(Self {
            challenge: serde_json::from_value(context.remove("challenge")?).ok()?,
            key: serde_json::from_value(context.remove("key")?).ok()?,
        })
    }
}

#[cfg(test)]
#[path = "grant_tests.rs"]
mod tests;
