//! Generating this device's own SSH keypair, on the device.
//!
//! Pairing hands the laptop a **public** key. The private half is created here
//! and never leaves: it is not in the QR, not in the enrollment request, and
//! not in anything the laptop stores. That is the whole point of scanning a
//! code rather than copying a key across — a key that is transported is a key
//! that exists in two places.
//!
//! ## Ed25519, not the enclave's P-256
//!
//! [`crate::device_identity`] documents the hardware-backed identity that is
//! *not* built: the Secure Enclave holds only NIST P-256, Android's Keystore
//! P-256 or RSA, and neither can hold Ed25519. Since no enclave is involved
//! here — the key is a file, see below — there is no reason to accept P-256's
//! constraints, and Ed25519 is what every OpenSSH in the field accepts without
//! a `PubkeyAcceptedAlgorithms` line. Choosing P-256 *because* the enclave
//! would one day want it would be the worst of both: a software key with the
//! algorithm of a hardware one, and nothing hardware-backed to show for it.
//!
//! ## This key is a software key and the UI says so
//!
//! The private half is written to app storage by [`crate::identity_store`].
//! Anything running as this app can read it and a device backup can copy it
//! off. `Limitation::SoftwareKey` states that on the session screen and the
//! pairing screen, and `device_identity` still reports `NotProvisioned`.
//!
//! ## One keypair, because the wire carries one
//!
//! An earlier draft of this module generated two — an attach key and a list key
//! — reasoning that a forced command cannot append `--list` (see
//! `hmux-cli::mobile_gateway::list_stdio`) and that the two modes therefore need
//! two `authorized_keys` lines. The premise about `--list` is right and the
//! conclusion was wrong twice over. First locally: the pairing protocol that
//! landed (`hmux_client::online_pairing::PairingRequest`) carries exactly one
//! `public_key` and writes exactly one line, so a second keypair would be a
//! private key on this phone that no server has ever been told about. Then on
//! the far side: two pinned keys do not survive a Host replacement either,
//! because the session id they pin moves.
//!
//! One key is now also sufficient. Listing travels as a request on the channel
//! ([`crate::catalog::list_request`]) instead of as an argv flag a forced
//! command would discard, so the same key serves both modes. What is *reported*
//! is what that one key costs — `attach::Limitation::PairedKeyReachesEverySession`.
//! The list-key slot in [`crate::identity_store`] stays, for a server an
//! operator hardened by hand and gave a second key to.

use rand::rngs::SysRng;
use rand_core::{TryRng, UnwrapErr};
use russh::keys::ssh_key::{Algorithm, LineEnding, PrivateKey};
use std::fmt;
use zeroize::Zeroizing;

/// The comment written into the public key, so an operator reading
/// `authorized_keys` on the server can tell which line a phone put there.
///
/// Note that the *laptop* discards this comment and writes its own
/// (`hmux-pairing:<device-id>`, see `pairing::entry::device_comment`) — an
/// attacker-chosen comment must not land verbatim in `authorized_keys`. It is
/// still set here because the same public key is what the pairing screen shows
/// the owner, and an unlabelled key is one nobody can identify.
pub const DEVICE_KEY_COMMENT: &str = "dure-mobile";

/// The algorithm this client generates. Named as a constant because the
/// pairing report shows it and a test pins it.
pub const DEVICE_KEY_ALGORITHM: &str = "ssh-ed25519";

/// One freshly generated keypair.
///
/// The private half is [`Zeroizing`] so the buffer is wiped when it is
/// dropped. That is not a claim of secrecy — the same bytes are about to be
/// written to a file that survives the process — it is the cheap half of the
/// job: not leaving key material in a freed heap page that a later allocation
/// in this same process can read back.
pub struct DeviceKeypair {
    pub private_openssh: Zeroizing<String>,
    /// `ssh-ed25519 AAAA… comment`, the exact text an `authorized_keys` line
    /// carries.
    pub public_openssh: String,
}

/// No `Debug` derive, for the reason `SshAuthentication` has none: a struct
/// that can print itself is how key material reaches a log.
impl fmt::Debug for DeviceKeypair {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeviceKeypair")
            .field("public_openssh", &self.public_openssh)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub enum DeviceKeyError {
    /// The operating system's random generator would not produce entropy.
    ///
    /// Its own variant, and checked before anything else, because it is the
    /// one failure here that must never be papered over: a key derived from a
    /// degraded generator is a key an attacker can reproduce, and it would look
    /// exactly like a working key on every screen in this app.
    NoEntropy { detail: String },
    /// The key could not be generated or encoded.
    Generation { detail: String },
}

impl fmt::Display for DeviceKeyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoEntropy { detail } => write!(
                formatter,
                "기기의 난수 생성기를 쓸 수 없어 키를 만들지 않았습니다: {detail}"
            ),
            Self::Generation { detail } => {
                write!(formatter, "기기 SSH 키를 만들지 못했습니다: {detail}")
            }
        }
    }
}

impl std::error::Error for DeviceKeyError {}

impl DeviceKeyError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoEntropy { .. } => "device_key_no_entropy",
            Self::Generation { .. } => "device_key_generation_failed",
        }
    }
}

/// Generates one Ed25519 keypair, tagged with `comment`.
///
/// # Why the generator is probed first
///
/// `SysRng` is fallible — it is the OS call, and on a phone it can refuse
/// (an unentitled process, a platform that has not finished seeding). ssh-key's
/// `random` wants an infallible generator, and the adapter that provides one,
/// [`UnwrapErr`], turns that refusal into a **panic**. Probing first means the
/// ordinary "no entropy available" case is a typed error the pairing screen can
/// render, and the residual panic covers only a generator that worked one line
/// ago and then failed — a platform that is broken in a way this app cannot
/// report from anyway. The alternative, silently continuing with weak bytes, is
/// not on the table: this key is the whole of the device's authority.
pub fn generate(comment: &str) -> Result<DeviceKeypair, DeviceKeyError> {
    let mut probe = [0_u8; 32];
    SysRng
        .try_fill_bytes(&mut probe)
        .map_err(|error| DeviceKeyError::NoEntropy {
            detail: error.to_string(),
        })?;

    let mut rng = UnwrapErr(SysRng);
    let mut key = PrivateKey::random(&mut rng, Algorithm::Ed25519).map_err(|error| {
        DeviceKeyError::Generation {
            detail: error.to_string(),
        }
    })?;
    key.set_comment(comment);

    // LF, not CRLF: OpenSSH reads either, but the file is also what a user may
    // eventually copy into a terminal, and a CR inside a base64 body is the
    // kind of difference that only shows up as "invalid format".
    let private_openssh =
        key.to_openssh(LineEnding::LF)
            .map_err(|error| DeviceKeyError::Generation {
                detail: error.to_string(),
            })?;
    let public_openssh =
        key.public_key()
            .to_openssh()
            .map_err(|error| DeviceKeyError::Generation {
                detail: error.to_string(),
            })?;

    Ok(DeviceKeypair {
        private_openssh,
        public_openssh,
    })
}

/// The public half of a private key somebody already has.
///
/// # Why the public half is derived rather than asked for
///
/// A private key carries its public half — that is what makes it a key pair —
/// and asking for both would let the two disagree. This app needs the public
/// one only to say what the host must already trust, so it is read out of the
/// private one and never entered.
pub fn imported(private_openssh: &str) -> Result<DeviceKeypair, DeviceKeyError> {
    let key =
        PrivateKey::from_openssh(private_openssh).map_err(|error| DeviceKeyError::Generation {
            detail: error.to_string(),
        })?;
    // An encrypted key cannot answer for its own public half without the
    // passphrase, and there is nowhere on this screen to ask for one. Refused
    // by name, so the message says what to do rather than "invalid format".
    if key.is_encrypted() {
        return Err(DeviceKeyError::Generation {
            detail: "암호가 걸린 키입니다 — 암호를 푼 키를 가져오세요".to_string(),
        });
    }
    let public_openssh =
        key.public_key()
            .to_openssh()
            .map_err(|error| DeviceKeyError::Generation {
                detail: error.to_string(),
            })?;
    Ok(DeviceKeypair {
        private_openssh: Zeroizing::new(private_openssh.to_string()),
        public_openssh,
    })
}

/// 32바이트 ed25519 씨앗에서 OpenSSH 개인키 PEM을 만든다.
///
/// v2(오프라인) 페어링의 QR은 개인키 전체가 아니라 씨앗만 나른다 — PEM은
/// base64 껍데기가 붙어 QR을 키우고, ed25519 씨앗을 확장하는 방법은 하나뿐이라
/// 양쪽이 다르게 만들 수가 없다. 그 확장을 여기서 한다.
///
/// [`generate`]와 달리 난수를 쓰지 않는다. 이 씨앗은 노트북이 만들었고, 그
/// 공개 절반이 이미 각 서버의 `authorized_keys`에 들어가 있다 — 여기서 새로
/// 만들면 자물쇠는 저기 있고 열쇠는 여기 없는 상태가 된다.
pub fn openssh_private_key_from_seed(seed: &[u8; 32]) -> Result<Zeroizing<String>, DeviceKeyError> {
    let keypair = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(seed);
    let mut key = PrivateKey::new(
        russh::keys::ssh_key::private::KeypairData::Ed25519(keypair),
        DEVICE_KEY_COMMENT,
    )
    .map_err(|error| DeviceKeyError::Generation {
        detail: error.to_string(),
    })?;
    key.set_comment(DEVICE_KEY_COMMENT);
    key.to_openssh(LineEnding::LF)
        .map_err(|error| DeviceKeyError::Generation {
            detail: error.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generated_key_is_an_openssh_private_key_the_store_accepts() {
        let keypair = generate(DEVICE_KEY_COMMENT).expect("generate");

        crate::identity_store::validate_private_key(&keypair.private_openssh)
            .expect("the store must accept what this module generates");
    }

    #[test]
    fn the_public_half_is_an_authorized_keys_line_carrying_its_comment() {
        let keypair = generate(DEVICE_KEY_COMMENT).expect("generate");

        assert!(
            keypair.public_openssh.starts_with(DEVICE_KEY_ALGORITHM),
            "{}",
            keypair.public_openssh
        );
        assert!(
            keypair.public_openssh.ends_with(DEVICE_KEY_COMMENT),
            "{}",
            keypair.public_openssh
        );
    }

    /// The private half must not appear in the text that goes to the laptop.
    /// Asserted rather than assumed because the two halves are produced by one
    /// call and returned in one struct, which is exactly the shape that makes
    /// sending the wrong field a one-character mistake.
    #[test]
    fn the_public_half_carries_no_private_key_material() {
        let keypair = generate(DEVICE_KEY_COMMENT).expect("generate");

        assert!(!keypair.public_openssh.contains("PRIVATE"));
        assert!(!keypair.public_openssh.contains("BEGIN"));
    }

    /// The public half read back from a stored private key must be the one the
    /// generator handed out. `server_public_key` shows exactly this readback,
    /// and a comment or encoding lost on the way would put a line on the host
    /// that never matches the key the phone dials with.
    #[test]
    fn the_public_half_read_back_from_the_private_key_is_the_generated_one() {
        let keypair = generate(DEVICE_KEY_COMMENT).expect("generate");

        let read_back = imported(&keypair.private_openssh).expect("imported");

        assert_eq!(read_back.public_openssh, keypair.public_openssh);
    }

    /// Two calls must not produce the same key. A generator that returned a
    /// constant would satisfy every other test in this module.
    #[test]
    fn two_generated_keys_differ() {
        let first = generate(DEVICE_KEY_COMMENT).expect("first");
        let second = generate(DEVICE_KEY_COMMENT).expect("second");

        assert_ne!(first.public_openssh, second.public_openssh);
        assert_ne!(
            first.private_openssh.as_str(),
            second.private_openssh.as_str()
        );
    }

    /// A key this client generates must round-trip through the same decoder
    /// the SSH handshake uses. Encoding it with a `LineEnding` or a cipher the
    /// decoder refuses would only surface as an authentication failure against
    /// a real server.
    #[test]
    fn a_generated_key_decodes_with_the_decoder_the_handshake_uses() {
        let keypair = generate(DEVICE_KEY_COMMENT).expect("generate");

        let decoded = russh::keys::decode_secret_key(&keypair.private_openssh, None)
            .expect("the handshake's own decoder must accept this key");

        assert_eq!(
            decoded
                .public_key()
                .to_openssh()
                .expect("re-encode the public half"),
            keypair.public_openssh
        );
    }
}
