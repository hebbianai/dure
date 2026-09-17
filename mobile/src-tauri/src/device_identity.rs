//! Per-device SSH identity, backed by the Secure Enclave / Android Keystore.
//!
//! **Nothing here generates a key.** This module exists to report that no
//! identity is provisioned and to record what provisioning will actually
//! require, because the constraints are sharp enough to change the design of
//! the pieces around it and are cheaper to learn now than after a pairing flow
//! is written against the wrong key type.
//!
//! ## The constraint that drives everything
//!
//! The Secure Enclave stores exactly one key type: **NIST P-256 ECDSA**
//! (`kSecAttrKeyTypeECSECPrimeRandom`, 256 bits). Android's Keystore adds
//! RSA, and StrongBox is again EC P-256 / RSA-2048. Neither platform can hold
//! an Ed25519 key.
//!
//! So a hardware-bound per-device SSH identity is `ecdsa-sha2-nistp256`, and
//! the server's `authorized_keys` must accept that algorithm. This is not a
//! preference — an Ed25519 device key is simply not hardware-backed, and a
//! software key on a phone is a file that a backup copies off the device.
//!
//! ## What that costs the SSH layer
//!
//! The private key never leaves the enclave, so the client cannot hand bytes
//! to a signer. russh must call *out* to sign: its `Signer`/agent seam takes
//! the digest to `SecKeyCreateSignature` (iOS) or a `java.security.Signature`
//! bound to the Keystore alias (Android), and the platform returns a DER
//! ECDSA signature that has to be re-encoded into SSH's `mpint r, mpint s`
//! wire form. That re-encoding is a real, testable unit of work and it is
//! where this integration will actually break.
//!
//! ## Why this needs a custom Tauri plugin
//!
//! Neither `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave` nor
//! `KeyGenParameterSpec` has a Rust binding in the Tauri plugin ecosystem.
//! Both are platform-API calls that must run on the native side: Swift/ObjC
//! for iOS, Kotlin for Android, exposed through a Tauri mobile plugin's
//! command bridge. Scope it as a plugin with three operations — generate,
//! public-key export, sign-digest — plus biometric/`LAContext` policy on the
//! iOS side, and expect the Android StrongBox-vs-TEE fallback to need its own
//! decision (StrongBox is absent on many devices and `KeyGenParameterSpec`
//! throws rather than degrading).

use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum DeviceIdentityStatus {
    /// No key exists and no code can create one yet.
    NotProvisioned {
        /// Korean UI source; English in `mobile/src/locales/en.ts`.
        reason: &'static str,
        /// The SSH key algorithm a provisioned identity will use, surfaced now
        /// so the server side can prepare `authorized_keys` before the plugin
        /// exists.
        planned_algorithm: &'static str,
    },
}

/// The algorithm a hardware-bound device identity must use.
///
/// Fixed by the enclave, not chosen: see the module docs.
pub const PLANNED_ALGORITHM: &str = "ecdsa-sha2-nistp256";

#[must_use]
pub fn status() -> DeviceIdentityStatus {
    DeviceIdentityStatus::NotProvisioned {
        reason: "기기 키를 만드는 네이티브 플러그인이 아직 없습니다",
        planned_algorithm: PLANNED_ALGORITHM,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_is_honest_about_having_no_key() {
        assert!(matches!(
            status(),
            DeviceIdentityStatus::NotProvisioned { .. }
        ));
    }

    /// The enclave cannot hold an Ed25519 key, so an ed25519 default here
    /// would produce a pairing flow that provisions a software key onto a
    /// phone — the thing hardware binding exists to prevent.
    #[test]
    fn the_planned_algorithm_is_one_the_secure_enclave_can_actually_hold() {
        assert_eq!(PLANNED_ALGORITHM, "ecdsa-sha2-nistp256");
    }
}
