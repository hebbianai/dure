//! The pairing token: single use, short lived, and never sent over the wire.
//!
//! This is the third of the three secrets this feature keeps apart. It is not
//! the phone's key (public, and the thing being distributed) and it is not the
//! Host's `capability_token` (which must never reach the phone at all). It is a
//! short-lived value that exists to prove one thing: the caller is the device
//! that just looked at this screen.
//!
//! **The token is not transmitted.** The phone proves possession with an
//! HMAC-SHA256 over the request it is about to send, keyed by the token. A
//! passive listener on the LAN — and the brief assumes there is one — therefore
//! never sees a value it could reuse, and an active one cannot alter any field
//! of the request without invalidating the proof. Sending the token itself
//! would have been simpler and would have put a working credential on the wire
//! in cleartext, which is exactly the mistake this design is trying not to make
//! elsewhere.
//!
//! The response is proven the same way, so the phone can tell the laptop it
//! scanned from something else that answered on that port first.

use base64::Engine as _;
use hmux_client::online_pairing::{RequestTranscript, ResponseTranscriptV1, ResponseTranscriptV2};
use std::time::{Duration, SystemTime};

/// How many proof failures a session tolerates before it gives up.
///
/// Not a brute-force defence — a 256-bit token does not need one. It bounds a
/// stranger's ability to keep the laptop parked on a listening socket while the
/// owner stands at the desk believing the pairing is still available.
pub(crate) const MAX_FAILED_ATTEMPTS: u32 = 5;

/// A 32-byte single-use pairing secret.
#[derive(Clone)]
pub(crate) struct PairingToken([u8; 32]);

impl PairingToken {
    /// Draws a token from the OS CSPRNG.
    ///
    /// Via `Uuid::new_v4`, which reads `getrandom` directly, rather than adding
    /// a userspace PRNG dependency for 32 bytes drawn once per pairing.
    pub(crate) fn generate() -> Self {
        let mut bytes = [0u8; 32];
        bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        Self(bytes)
    }

    /// The QR-safe encoding. base64url so the payload needs no escaping.
    pub(crate) fn encoded(&self) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(self.0)
    }

    /// Proof a phone computes over the request it is about to send.
    #[cfg(test)]
    pub(crate) fn request_proof(&self, transcript: &RequestTranscript) -> [u8; 32] {
        transcript.proof(&self.0)
    }

    /// Deployed proof the laptop keeps attaching for old phones.
    pub(crate) fn response_proof_v1(&self, transcript: &ResponseTranscriptV1) -> [u8; 32] {
        transcript.proof(&self.0)
    }

    /// Proof for a response transcript that includes every SSH host-key pin.
    pub(crate) fn response_proof_v2(&self, transcript: &ResponseTranscriptV2) -> [u8; 32] {
        transcript.proof(&self.0)
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum RedeemRefusal {
    /// The token was already spent. This is the second-scan case.
    AlreadyUsed,
    Expired,
    TooManyAttempts,
    BadProof,
}

impl RedeemRefusal {
    pub(crate) fn reason(&self) -> &'static str {
        match self {
            Self::AlreadyUsed => "pairing_token_already_used",
            Self::Expired => "pairing_token_expired",
            Self::TooManyAttempts => "pairing_attempts_exhausted",
            Self::BadProof => "pairing_proof_rejected",
        }
    }
}

/// One pairing offer: one token, one expiry, one redemption.
pub(crate) struct PairingSession {
    token: PairingToken,
    expires_at: SystemTime,
    used: bool,
    failed_attempts: u32,
}

impl PairingSession {
    pub(crate) fn new(token: PairingToken, now: SystemTime, lifetime: Duration) -> Self {
        Self {
            token,
            expires_at: now + lifetime,
            used: false,
            failed_attempts: 0,
        }
    }

    pub(crate) fn token(&self) -> &PairingToken {
        &self.token
    }

    pub(crate) fn expires_at(&self) -> SystemTime {
        self.expires_at
    }

    pub(crate) fn is_spent(&self) -> bool {
        self.used || self.failed_attempts >= MAX_FAILED_ATTEMPTS
    }

    /// Consumes the token if `proof` is the phone's HMAC over `transcript`.
    ///
    /// The checks are ordered so a caller learns the *most specific true* thing:
    /// a replay after a successful pairing is reported as already used rather
    /// than as a bad proof, because the two mean different things to whoever is
    /// standing at the desk wondering why the second scan did nothing.
    ///
    /// `used` is set only on success. A failed proof must not burn the pairing,
    /// or anyone on the network could deny the owner their own QR by sending
    /// one junk packet.
    pub(crate) fn redeem(
        &mut self,
        transcript: &RequestTranscript,
        proof: &[u8],
        now: SystemTime,
    ) -> Result<(), RedeemRefusal> {
        if self.used {
            return Err(RedeemRefusal::AlreadyUsed);
        }
        if now >= self.expires_at {
            return Err(RedeemRefusal::Expired);
        }
        if self.failed_attempts >= MAX_FAILED_ATTEMPTS {
            return Err(RedeemRefusal::TooManyAttempts);
        }
        if !transcript.verifies(&self.token.0, proof) {
            self.failed_attempts += 1;
            return Err(RedeemRefusal::BadProof);
        }
        self.used = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transcript() -> RequestTranscript {
        RequestTranscript::new(1, "phone", "ssh-ed25519 AAAA", b"nonce-bytes-here")
    }

    fn session(now: SystemTime) -> PairingSession {
        PairingSession::new(PairingToken::generate(), now, Duration::from_secs(120))
    }

    #[test]
    fn a_token_is_redeemed_once_and_refused_the_second_time() {
        let now = SystemTime::now();
        let mut session = session(now);
        let transcript = transcript();
        let proof = session.token().request_proof(&transcript);
        assert_eq!(session.redeem(&transcript, &proof, now), Ok(()));
        assert_eq!(
            session.redeem(&transcript, &proof, now),
            Err(RedeemRefusal::AlreadyUsed),
            "a replayed request must be refused, not honoured a second time"
        );
    }

    #[test]
    fn a_request_whose_fields_were_altered_in_flight_is_refused() {
        let now = SystemTime::now();
        let mut session = session(now);
        let original = transcript();
        let proof = session.token().request_proof(&original);
        let tampered =
            RequestTranscript::new(1, "phone", "ssh-ed25519 ATTACKER", b"nonce-bytes-here");
        assert_eq!(
            session.redeem(&tampered, &proof, now),
            Err(RedeemRefusal::BadProof)
        );
        assert!(
            !session.is_spent(),
            "a rejected proof must not burn the token"
        );
    }

    #[test]
    fn a_proofless_request_never_redeems_the_token() {
        let now = SystemTime::now();
        let mut session = session(now);
        assert_eq!(
            session.redeem(&transcript(), b"", now),
            Err(RedeemRefusal::BadProof)
        );
    }

    #[test]
    fn an_expired_token_is_refused_even_with_a_correct_proof() {
        let now = SystemTime::now();
        let mut session = session(now);
        let transcript = transcript();
        let proof = session.token().request_proof(&transcript);
        assert_eq!(
            session.redeem(&transcript, &proof, now + Duration::from_secs(121)),
            Err(RedeemRefusal::Expired)
        );
    }

    #[test]
    fn repeated_bad_proofs_exhaust_the_session() {
        let now = SystemTime::now();
        let mut session = session(now);
        for _ in 0..MAX_FAILED_ATTEMPTS {
            assert_eq!(
                session.redeem(&transcript(), b"nope", now),
                Err(RedeemRefusal::BadProof)
            );
        }
        assert!(session.is_spent());
        let transcript = transcript();
        let proof = session.token().request_proof(&transcript);
        assert_eq!(
            session.redeem(&transcript, &proof, now),
            Err(RedeemRefusal::TooManyAttempts)
        );
    }

    #[test]
    fn field_boundaries_cannot_be_shifted_without_changing_the_proof() {
        let token = PairingToken::generate();
        let joined = RequestTranscript::new(1, "ab", "", b"");
        let split = RequestTranscript::new(1, "a", "b", b"");
        let joined = token.request_proof(&joined);
        let split = token.request_proof(&split);
        assert_ne!(joined, split);
    }
}
