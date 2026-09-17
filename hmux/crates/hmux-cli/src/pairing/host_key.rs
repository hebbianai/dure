//! Resolves the SSH **host** key fingerprint the phone pins.
//!
//! Trust on first use is the thing pairing is supposed to remove. The phone
//! learns each server's host key fingerprint at the desk — the laptop's through
//! the QR, every other server's through the pairing answer — so the first real
//! SSH connection, made later with the lid closed and over whatever network the
//! phone is on, is checked against something the owner physically approved
//! rather than accepted because it was first. The advertised endpoint's wire
//! key is authoritative. Public key files are read only for an explicit
//! operator assertion, remote-only payload-v1 metadata, and the legacy remote
//! receipt boundary.
//!
//! File reads open only the public half (`…_key.pub`, mode 0644). The host's
//! private key is never opened.

use base64::Engine as _;
use hmux_ssh_transport::{ObservedHostKey, SshEndpoint, observe_server_host_key};
use sha2::{Digest as _, Sha256};
use std::path::Path;
use std::time::Duration;

/// Payload/receipt-v1 compatibility order. Local pairing observes the wire.
const HOST_KEY_CANDIDATES: &[&str] = &[
    "/etc/ssh/ssh_host_ed25519_key.pub",
    "/etc/ssh/ssh_host_ecdsa_key.pub",
    "/etc/ssh/ssh_host_rsa_key.pub",
];

#[derive(Clone, Debug)]
pub(crate) struct HostKeyFingerprint {
    pub(crate) algorithm: String,
    /// `SHA256:<base64>`, byte-for-byte what `ssh-keygen -lf` prints, so an
    /// operator can compare the two without converting anything.
    pub(crate) display: String,
    /// The raw digest, base64url encoded for the QR payload.
    pub(crate) compact: String,
}

/// Resolves the one pin both the QR and this laptop's inventory row use.
///
/// The wire observation is authoritative. `expected` is only an operator
/// assertion and can reject a mismatch; it never replaces what sshd offered.
pub(crate) fn observe_sshd(
    host: &str,
    port: u16,
    expected: Option<&Path>,
    timeout: Duration,
) -> Result<HostKeyFingerprint, String> {
    let endpoint = SshEndpoint {
        host: host.to_string(),
        port,
    };
    let offered = observe_server_host_key(endpoint, timeout).map_err(|error| error.to_string())?;
    let offered = from_observed(offered);
    if let Some(path) = expected {
        verify_expected(&offered, path, host, port)?;
    }
    Ok(offered)
}

fn verify_expected(
    offered: &HostKeyFingerprint,
    path: &Path,
    host: &str,
    port: u16,
) -> Result<(), String> {
    let expected = from_public_key_file(path)?;
    if expected.compact == offered.compact {
        return Ok(());
    }
    Err(format!(
        "SSH host key mismatch for {host}:{port}: {} contains {} {}, but sshd offered {} {}",
        path.display(),
        expected.algorithm,
        expected.display,
        offered.algorithm,
        offered.display,
    ))
}

fn from_observed(observed: ObservedHostKey) -> HostKeyFingerprint {
    let display = observed.fingerprint();
    let compact =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(observed.fingerprint_sha256());
    HostKeyFingerprint {
        algorithm: observed.algorithm().to_string(),
        display,
        compact,
    }
}

/// Best-effort compatibility source for payload/receipt v1 metadata.
pub(crate) fn discover_published() -> Result<HostKeyFingerprint, String> {
    let mut last_error = String::from("no SSH host key was found");
    for candidate in HOST_KEY_CANDIDATES {
        match from_public_key_file(Path::new(candidate)) {
            Ok(fingerprint) => return Ok(fingerprint),
            Err(error) => last_error = error,
        }
    }
    Err(format!(
        "{last_error}. The remote pairing receipt cannot publish a host-key fingerprint."
    ))
}

/// Supplies fields that pairing payload v1 requires even when this laptop is
/// intentionally absent from a remote-only answer.
pub(crate) fn remote_only_qr_metadata(
    explicit: Option<&Path>,
) -> Result<HostKeyFingerprint, String> {
    explicit.map_or_else(discover_published, from_public_key_file)
}

pub(super) fn from_public_key_file(path: &Path) -> Result<HostKeyFingerprint, String> {
    let contents = std::fs::read_to_string(path).map_err(|error| {
        format!(
            "could not read the SSH host key {}: {error}",
            path.display()
        )
    })?;
    let mut fields = contents.split_ascii_whitespace();
    let algorithm = fields
        .next()
        .ok_or_else(|| format!("{} is empty", path.display()))?;
    let encoded = fields
        .next()
        .ok_or_else(|| format!("{} carries no key body", path.display()))?;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("{} is not a valid public key: {error}", path.display()))?;
    let digest = Sha256::digest(&blob);
    Ok(HostKeyFingerprint {
        algorithm: algorithm.to_string(),
        display: format!(
            "SHA256:{}",
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
        ),
        compact: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fingerprint_is_reported_in_both_the_ssh_keygen_form_and_a_qr_safe_one() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ssh_host_ed25519_key.pub");
        let mut blob = Vec::new();
        blob.extend_from_slice(&(b"ssh-ed25519".len() as u32).to_be_bytes());
        blob.extend_from_slice(b"ssh-ed25519");
        blob.extend_from_slice(&32u32.to_be_bytes());
        blob.extend_from_slice(&[3u8; 32]);
        std::fs::write(
            &path,
            format!(
                "ssh-ed25519 {} root@box\n",
                base64::engine::general_purpose::STANDARD.encode(&blob)
            ),
        )
        .unwrap();

        let fingerprint = from_public_key_file(&path).unwrap();
        assert_eq!(fingerprint.algorithm, "ssh-ed25519");
        assert!(fingerprint.display.starts_with("SHA256:"));
        assert!(
            !fingerprint.compact.contains('/'),
            "the QR payload needs no escaping"
        );
        assert_eq!(
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(&fingerprint.compact)
                .unwrap(),
            base64::engine::general_purpose::STANDARD_NO_PAD
                .decode(fingerprint.display.trim_start_matches("SHA256:"))
                .unwrap(),
            "both encodings must name the same digest"
        );
    }

    #[test]
    fn a_missing_expected_host_key_names_the_file() {
        let path = Path::new("/nonexistent/ssh_host_ed25519_key.pub");
        let error = from_public_key_file(path).unwrap_err();
        assert!(error.contains(&path.display().to_string()), "{error}");
    }

    #[test]
    fn an_expected_file_cannot_override_the_key_sshd_offered() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("expected.pub");
        std::fs::write(&path, "ssh-ed25519 AQID expected\n").unwrap();
        let offered = HostKeyFingerprint {
            algorithm: "ssh-ed25519".into(),
            display: "SHA256:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc".into(),
            compact: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7; 32]),
        };

        let error = verify_expected(&offered, &path, "laptop.example", 2222).unwrap_err();
        assert!(error.contains(&path.display().to_string()), "{error}");
        assert!(error.contains("laptop.example:2222"), "{error}");
        assert!(error.contains(&offered.display), "{error}");
    }
}
