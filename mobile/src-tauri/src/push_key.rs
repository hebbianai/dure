//! This install's push key and the grants it signs (#660).
//!
//! A paired computer may have alerts sent to this phone only while it holds a
//! grant this key signed over the fingerprint the phone pinned for that
//! computer at QR scan. The push service binds the key to this phone's APNs
//! token once the phone proves it receives that token's alerts: the service
//! sends a challenge alert, and the next grant carries its nonce
//! ([`crate::push::PushChallenges`]). The service is the only party that
//! verifies a grant; this module only signs.
//!
//! # Where it lives
//!
//! In the app's own sandbox ([`root_for`]), never in the App Group container
//! the notification service extension shares: the extension has no use for
//! it. Not in the configuration directory either, because
//! `shared_config::adopt` may move that whole directory into the group. On iOS
//! the folder is excluded from backup, so a restored phone mints its own key
//! instead of carrying this one to another device.
//!
//! # What losing it costs
//!
//! One more proof. A device reset deletes the folder, as the reset screen
//! promises for device keys, and a reinstall loses it. The next sync mints a
//! new key, the service challenges it, and the phone signs the challenge back.
//! The key is a per-install pseudonymous identifier: the service sees its
//! public half and nothing that names the person.

use crate::identity_store;
use dure_hub_protocol::push::{
    grant_signing_input, push_key_id, PushGrant, PushGrantClaims, PushGrantClaimsRead, PushId,
    PushNonce, PushSubscription, PUSH_GRANT_LIFETIME_SECS, PUSH_GRANT_VERSION,
};
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, KeyPair as _, ECDSA_P256_SHA256_ASN1_SIGNING};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The folder's name when the platform gives the app a local data folder of
/// its own.
const PUSH_DIRECTORY: &str = "push";

/// The PKCS#8 document of the P-256 key, written `0600`.
const KEY_FILE: &str = "push-key.p8";

/// The epoch every grant carries, in decimal. The service refuses a grant
/// older than the last one it saw, so this number never goes down.
const EPOCH_FILE: &str = "epoch";

const FIRST_EPOCH: u64 = 1;

/// Where the push key lives, given the folder the platform gives the app for
/// its configuration (`own_config`, which `shared_config::adopt` may move into
/// the App Group) and for its local data (`local_data`). None when the
/// configuration folder has no name to put a sibling beside.
pub fn root_for(own_config: &Path, local_data: &Path) -> Option<PathBuf> {
    if !local_data.starts_with(own_config) {
        return Some(local_data.join(PUSH_DIRECTORY));
    }
    // One folder for both (iOS): a sibling, which the move leaves in place.
    let mut name = own_config.file_name()?.to_os_string();
    name.push(".push");
    Some(own_config.with_file_name(name))
}

/// The key and the epoch its grants carry.
pub struct PushKey {
    pair: EcdsaKeyPair,
    epoch: u64,
}

/// The private half never prints; the key id names the key.
impl std::fmt::Debug for PushKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PushKey")
            .field("key", &self.key_id().as_str())
            .field("epoch", &self.epoch)
            .finish()
    }
}

impl PushKey {
    /// The key in `root`, minted on first use. A stored key that no longer
    /// parses is replaced: an unusable key has nothing left to protect, and
    /// a new one only has to prove receipt again.
    pub fn load_or_create(root: &Path) -> Result<Self, String> {
        let rng = SystemRandom::new();
        let path = root.join(KEY_FILE);
        let stored = match fs::read(&path) {
            Ok(bytes) => {
                EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &bytes, &rng).ok()
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("Could not read this phone's alert key: {error}")),
        };
        let pair = match stored {
            Some(pair) => pair,
            None => {
                prepare(root)?;
                let minted = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng)
                    .map_err(|_| "Could not create this phone's alert key".to_string())?;
                identity_store::write_private_file(&path, minted.as_ref())
                    .map_err(|error| error.to_string())?;
                EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, minted.as_ref(), &rng)
                    .map_err(|_| "Could not read this phone's new alert key".to_string())?
            }
        };
        Ok(Self {
            pair,
            epoch: load_or_create_epoch(root)?,
        })
    }

    /// The name the service and challenges give this key.
    pub fn key_id(&self) -> PushId {
        push_key_id(self.pair.public_key().as_ref())
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// A grant that lets the computer pinned as `hub` have alerts sent for
    /// `subscription` until [`PUSH_GRANT_LIFETIME_SECS`] after `now` (Unix
    /// seconds). `nonce` answers the service's challenge for this key.
    pub fn mint_grant(
        &self,
        hub: &str,
        subscription: &PushSubscription,
        nonce: Option<PushNonce>,
        now: u64,
    ) -> Result<PushGrant, String> {
        let claims = PushGrantClaims {
            version: PUSH_GRANT_VERSION,
            token: subscription.token.clone(),
            environment: subscription.environment,
            hub: hub.to_string(),
            preference: subscription.preference,
            epoch: self.epoch,
            issued_at: now,
            expires_at: now.saturating_add(PUSH_GRANT_LIFETIME_SECS),
            nonce,
        }
        .to_canonical_bytes();
        // Claims this build cannot read back are claims the service refuses
        // too: a pinned value that is not a fingerprint stops here, unsigned.
        if !matches!(
            PushGrantClaims::parse(&claims),
            Ok(PushGrantClaimsRead::Known(_))
        ) {
            return Err("This computer's pinned fingerprint cannot be named in an alert grant. Pair it again.".into());
        }
        let signature = self
            .pair
            .sign(&SystemRandom::new(), &grant_signing_input(&claims))
            .map_err(|_| "Could not sign the alert grant".to_string())?;
        PushGrant::new(
            self.pair.public_key().as_ref().to_vec(),
            claims,
            signature.as_ref().to_vec(),
        )
        .map_err(str::to_string)
    }
}

/// The folder, made and excluded from backup before any key is written in it.
fn prepare(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("Could not create the alert key folder: {error}"))?;
    exclude_from_backup(root)
}

fn load_or_create_epoch(root: &Path) -> Result<u64, String> {
    let path = root.join(EPOCH_FILE);
    match fs::read_to_string(&path) {
        // Never reset to the first epoch: a lower epoch than the service saw
        // is refused, so guessing low would stop every alert.
        Ok(text) => text
            .trim()
            .parse()
            .map_err(|_| "This phone's alert epoch is unreadable".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            prepare(root)?;
            identity_store::write_private_file(&path, FIRST_EPOCH.to_string().as_bytes())
                .map_err(|error| error.to_string())?;
            Ok(FIRST_EPOCH)
        }
        Err(error) => Err(format!("Could not read this phone's alert epoch: {error}")),
    }
}

/// A backup restored to another phone must not carry this phone's key there.
#[cfg(target_os = "ios")]
fn exclude_from_backup(directory: &Path) -> Result<(), String> {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSNumber, NSString, NSURLIsExcludedFromBackupKey, NSURL};
    let path = directory
        .to_str()
        .ok_or("The alert key folder's path is not UTF-8")?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let excluded = NSNumber::new_bool(true);
    let value: &AnyObject = &excluded;
    // SAFETY: this resource key takes an NSNumber holding a BOOL, and the
    // key is a framework constant valid for the process lifetime.
    unsafe { url.setResourceValue_forKey_error(Some(value), NSURLIsExcludedFromBackupKey) }.map_err(
        |error| {
            format!(
                "Could not exclude the alert key folder from backup ({})",
                error.code()
            )
        },
    )
}

/// Other platforms keep the app's data out of device backups already, or
/// have no backup to keep it out of.
#[cfg(not(target_os = "ios"))]
fn exclude_from_backup(_directory: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use dure_hub_protocol::push::{
        ApnsEnvironment, PushLanguage, PushPreference, PUSH_GRANT_MAX_LIFETIME_SECS,
    };
    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_ASN1};

    /// What the service does with a grant's signature, with the same
    /// algorithm: ASN.1 DER ECDSA P-256 SHA-256 over the signing input.
    fn signature_holds(key: &[u8], claims: &[u8], signature: &[u8]) -> bool {
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, key)
            .verify(&grant_signing_input(claims), signature)
            .is_ok()
    }

    fn subscription(preference: PushPreference) -> PushSubscription {
        PushSubscription {
            token: "a1b2c3d4".to_string().try_into().unwrap(),
            environment: ApnsEnvironment::Production,
            preference,
            language: PushLanguage::En,
        }
    }

    /// The vectors S0 wrote with node: ring reaches the same signature
    /// verdict on each, so a grant this phone signs is one the service's
    /// verifier accepts, and a tampered one is not.
    #[test]
    fn ring_reaches_every_vectors_signature_verdict() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../crates/dure-hub-protocol/testdata/push-grant-v1.json"
        ))
        .unwrap();
        let vectors = vectors["vectors"].as_array().unwrap();
        assert!(vectors.len() >= 14, "{}", vectors.len());
        for vector in vectors {
            let field = |name: &str| {
                URL_SAFE_NO_PAD
                    .decode(vector[name].as_str().unwrap())
                    .unwrap()
            };
            assert_eq!(
                signature_holds(&field("key"), &field("claims"), &field("signature")),
                vector["signatureValid"].as_bool().unwrap(),
                "{}",
                vector["name"]
            );
            assert_eq!(
                push_key_id(&field("key")).as_str(),
                vector["keyId"].as_str().unwrap(),
                "{}",
                vector["name"]
            );
        }
    }

    #[test]
    fn a_minted_grant_names_this_computer_and_subscription_and_verifies() {
        let root = tempfile::tempdir().unwrap();
        let key = PushKey::load_or_create(root.path()).unwrap();
        let hub = dure_hub_protocol::fingerprint::of_der(b"laptop");
        let now = 1_795_686_400;
        let nonce: PushNonce = "0123456789abcdef0123456789abcdef"
            .to_string()
            .try_into()
            .unwrap();
        let wanted = subscription(PushPreference::Approvals);

        let grant = key
            .mint_grant(&hub, &wanted, Some(nonce.clone()), now)
            .unwrap();

        let Ok(PushGrantClaimsRead::Known(claims)) = grant.read_claims() else {
            panic!("a minted grant reads as known claims");
        };
        assert_eq!(
            claims,
            PushGrantClaims {
                version: PUSH_GRANT_VERSION,
                token: wanted.token.clone(),
                environment: ApnsEnvironment::Production,
                hub,
                preference: PushPreference::Approvals,
                epoch: FIRST_EPOCH,
                issued_at: now,
                expires_at: now + PUSH_GRANT_LIFETIME_SECS,
                nonce: Some(nonce),
            }
        );
        assert!(claims.expires_at - claims.issued_at <= PUSH_GRANT_MAX_LIFETIME_SECS);
        assert_eq!(grant.key_id(), key.key_id());
        assert!(signature_holds(
            grant.key(),
            grant.claims(),
            grant.signature()
        ));
        // The grant crosses the desktop as JSON and stays the same grant.
        let wire = serde_json::to_string(&grant).unwrap();
        assert_eq!(serde_json::from_str::<PushGrant>(&wire).unwrap(), grant);
    }

    #[test]
    fn a_pinned_value_that_is_not_a_fingerprint_is_never_signed() {
        let root = tempfile::tempdir().unwrap();
        let key = PushKey::load_or_create(root.path()).unwrap();
        assert!(key
            .mint_grant(
                "SHA256:short",
                &subscription(PushPreference::All),
                None,
                1_795_686_400
            )
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_key_is_minted_once_kept_private_and_reused() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("dev.hebbian.ide.mobile.push");

        let first = PushKey::load_or_create(&folder).unwrap();
        let again = PushKey::load_or_create(&folder).unwrap();

        assert_eq!(first.key_id(), again.key_id());
        assert_eq!((first.epoch(), again.epoch()), (FIRST_EPOCH, FIRST_EPOCH));
        let mode = fs::metadata(folder.join(KEY_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "{mode:o}");
        let mut files: Vec<_> = fs::read_dir(&folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        files.sort();
        assert_eq!(files, [EPOCH_FILE, KEY_FILE]);
        // The private half never prints.
        let printed = format!("{first:?}");
        assert!(printed.contains(first.key_id().as_str()), "{printed}");
    }

    #[test]
    fn an_unusable_key_is_replaced_and_an_unreadable_epoch_is_not_guessed() {
        let root = tempfile::tempdir().unwrap();
        let first = PushKey::load_or_create(root.path()).unwrap();
        fs::write(root.path().join(KEY_FILE), b"truncated").unwrap();
        let replaced = PushKey::load_or_create(root.path()).unwrap();
        assert_ne!(first.key_id(), replaced.key_id());

        fs::write(root.path().join(EPOCH_FILE), b"seven").unwrap();
        assert!(PushKey::load_or_create(root.path()).is_err());
        fs::write(root.path().join(EPOCH_FILE), b"7\n").unwrap();
        assert_eq!(PushKey::load_or_create(root.path()).unwrap().epoch(), 7);
    }

    /// On iOS the configuration and local data folders are the same, and
    /// `shared_config::adopt` may move that folder into the App Group: the
    /// key goes beside it. Where the platform gives local data a folder of its
    /// own, the key goes there.
    #[test]
    fn the_key_folder_is_never_inside_the_folder_that_moves_into_the_group() {
        let own = Path::new("/sandbox/Library/Application Support/dev.hebbian.ide.mobile");
        assert_eq!(
            root_for(own, own).unwrap(),
            Path::new("/sandbox/Library/Application Support/dev.hebbian.ide.mobile.push")
        );
        assert_eq!(
            root_for(own, &own.join("data")).unwrap(),
            Path::new("/sandbox/Library/Application Support/dev.hebbian.ide.mobile.push")
        );
        let local = Path::new("/home/me/.local/share/dev.hebbian.ide.mobile");
        let config = Path::new("/home/me/.config/dev.hebbian.ide.mobile");
        assert_eq!(root_for(config, local).unwrap(), local.join(PUSH_DIRECTORY));
        assert_eq!(root_for(Path::new("/"), Path::new("/")), None);
    }
}
