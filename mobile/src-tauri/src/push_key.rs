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
//!
//! # Taking a grant back
//!
//! Every grant carries the key's epoch, and the service refuses a grant whose
//! epoch is lower than the newest one it has seen for the key. A grant that
//! must end before it expires is ended by raising the epoch; the next sync
//! carries the new epoch to the service through any computer still paired.
//! The epoch rises when:
//!
//! - a computer leaves the paired store ([`supersede`]): grants it still
//!   holds must stop working, even though it was never told;
//! - the phone asks for fewer alerts than it already granted at this epoch
//!   ([`PushKey::prepare_grants`]): a computer that missed the change must not
//!   keep sending what the wider grant allowed. The widest preference granted
//!   at the current epoch is recorded beside the epoch for this.
//!
//! Turning alerts on, or asking for more of them, keeps the epoch: no grant
//! already given allows more than the new one.

use crate::identity_store;
use dure_hub_protocol::push::{
    grant_signing_input, push_key_id, PushGrant, PushGrantClaims, PushGrantClaimsRead, PushId,
    PushNonce, PushPreference, PushSubscription, PUSH_GRANT_LIFETIME_SECS, PUSH_GRANT_VERSION,
};
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, KeyPair as _, ECDSA_P256_SHA256_ASN1_SIGNING};
use serde::{Deserialize, Serialize};
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

/// The widest preference this key granted at an epoch ([`Granted`]). It is
/// written before a grant for any other preference is signed.
const GRANTED_FILE: &str = "granted.json";

/// What [`GRANTED_FILE`] holds. A record for an older epoch than the current
/// one means nothing was granted since the epoch rose.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Granted {
    epoch: u64,
    preference: PushPreference,
}

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

/// The key, the epoch its grants carry, and the widest preference it
/// granted at that epoch.
pub struct PushKey {
    pair: EcdsaKeyPair,
    epoch: u64,
    /// None: no grant at this epoch yet.
    granted: Option<PushPreference>,
}

/// The private half never prints; the key id names the key.
impl std::fmt::Debug for PushKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PushKey")
            .field("key", &self.key_id().as_str())
            .field("epoch", &self.epoch)
            .field("granted", &self.granted)
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
        let minted = stored.is_none();
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
        let epoch = load_or_create_epoch(root)?;
        Ok(Self {
            pair,
            epoch,
            // A key minted just now has signed nothing.
            granted: if minted {
                None
            } else {
                load_granted(root, epoch)
            },
        })
    }

    /// The name the service and challenges give this key.
    pub fn key_id(&self) -> PushId {
        push_key_id(self.pair.public_key().as_ref())
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Readies this key to sign grants for `preference`, before any is
    /// signed. Asking for fewer alerts than this epoch already granted
    /// raises the epoch first, so the service refuses the wider grants.
    /// Afterwards the record names exactly `preference`. Called under the
    /// device reset guard, in the same hold as [`Self::load_or_create`].
    pub fn prepare_grants(
        &mut self,
        root: &Path,
        preference: PushPreference,
    ) -> Result<(), String> {
        if self
            .granted
            .is_some_and(|granted| wider(granted, preference))
        {
            self.epoch = raise_epoch(root, self.epoch)?;
            self.granted = None;
        }
        if self.granted == Some(preference) {
            return Ok(());
        }
        let record = Granted {
            epoch: self.epoch,
            preference,
        };
        let bytes = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
        identity_store::write_private_file(&root.join(GRANTED_FILE), &bytes)
            .map_err(|error| error.to_string())?;
        self.granted = Some(preference);
        Ok(())
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
        // Only what [`Self::prepare_grants`] recorded is signed, so a later
        // narrower preference always knows to raise the epoch.
        if self.granted != Some(subscription.preference) {
            return Err("This phone's alert key was not readied for this alert preference".into());
        }
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

/// Ends every grant this install's key signed before now: the epoch rises,
/// and the service refuses grants below it once the next sync carries it.
/// `false` when no epoch was ever written, so no grant was ever signed.
/// Called under the device reset guard.
pub fn supersede(root: &Path) -> Result<bool, String> {
    match fs::read_to_string(root.join(EPOCH_FILE)) {
        Ok(text) => {
            raise_epoch(root, parse_epoch(&text)?)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not read this phone's alert epoch: {error}")),
    }
}

/// Whether a grant for `granted` allows alerts one for `wanted` does not.
fn wider(granted: PushPreference, wanted: PushPreference) -> bool {
    granted == PushPreference::All && wanted != PushPreference::All
}

fn raise_epoch(root: &Path, from: u64) -> Result<u64, String> {
    let next = from
        .checked_add(1)
        .ok_or("This phone's alert epoch cannot rise any further")?;
    identity_store::write_private_file(&root.join(EPOCH_FILE), next.to_string().as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(next)
}

/// The widest preference granted at `epoch`. A record that cannot be read,
/// or none at all from a key that signed before records were kept, could
/// have allowed every alert.
fn load_granted(root: &Path, epoch: u64) -> Option<PushPreference> {
    let record = fs::read(root.join(GRANTED_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Granted>(&bytes).ok());
    match record {
        Some(record) if record.epoch < epoch => None,
        Some(record) if record.epoch == epoch => Some(record.preference),
        _ => Some(PushPreference::All),
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
        Ok(text) => parse_epoch(&text),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            prepare(root)?;
            identity_store::write_private_file(&path, FIRST_EPOCH.to_string().as_bytes())
                .map_err(|error| error.to_string())?;
            Ok(FIRST_EPOCH)
        }
        Err(error) => Err(format!("Could not read this phone's alert epoch: {error}")),
    }
}

fn parse_epoch(text: &str) -> Result<u64, String> {
    text.trim()
        .parse()
        .map_err(|_| "This phone's alert epoch is unreadable".to_string())
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
    use dure_hub_protocol::push::{ApnsEnvironment, PushLanguage, PUSH_GRANT_MAX_LIFETIME_SECS};
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
        let mut key = PushKey::load_or_create(root.path()).unwrap();
        key.prepare_grants(root.path(), PushPreference::Approvals)
            .unwrap();
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
        let mut key = PushKey::load_or_create(root.path()).unwrap();
        key.prepare_grants(root.path(), PushPreference::All)
            .unwrap();
        assert!(key
            .mint_grant(
                "SHA256:short",
                &subscription(PushPreference::All),
                None,
                1_795_686_400
            )
            .is_err());
    }

    /// What a sync does with the key under the reset guard: load it, then
    /// ready it for the preference it is about to grant.
    fn ready(root: &Path, preference: PushPreference) -> PushKey {
        let mut key = PushKey::load_or_create(root).unwrap();
        key.prepare_grants(root, preference).unwrap();
        key
    }

    /// Each sync loads the key afresh, so every step reads the files back.
    #[test]
    fn the_epoch_rises_only_when_fewer_alerts_are_asked_for_than_were_granted() {
        let root = tempfile::tempdir().unwrap();
        let steps = [
            // Alerts turned on with approvals only: the first grant.
            (PushPreference::Approvals, FIRST_EPOCH),
            // More alerts: no grant already given allows more.
            (PushPreference::All, FIRST_EPOCH),
            (PushPreference::All, FIRST_EPOCH),
            // Fewer: the grants for every alert must stop working.
            (PushPreference::Approvals, FIRST_EPOCH + 1),
            (PushPreference::Approvals, FIRST_EPOCH + 1),
            (PushPreference::All, FIRST_EPOCH + 1),
            // Off in between loads no key and grants nothing, so turning
            // alerts back on with fewer of them still ends the wider grants.
            (PushPreference::Approvals, FIRST_EPOCH + 2),
        ];
        for (index, (preference, epoch)) in steps.into_iter().enumerate() {
            let key = ready(root.path(), preference);
            assert_eq!(key.epoch(), epoch, "step {index}: {preference:?}");
            let grant = key
                .mint_grant(
                    &dure_hub_protocol::fingerprint::of_der(b"laptop"),
                    &subscription(preference),
                    None,
                    1_795_686_400,
                )
                .unwrap();
            let Ok(PushGrantClaimsRead::Known(claims)) = grant.read_claims() else {
                panic!("a minted grant reads as known claims");
            };
            assert_eq!((claims.epoch, claims.preference), (epoch, preference));
        }
    }

    /// Only what was readied is signed: a grant the record does not name
    /// could not be taken back when the preference narrows later.
    #[test]
    fn a_grant_is_signed_only_for_the_preference_the_key_was_readied_for() {
        let root = tempfile::tempdir().unwrap();
        let hub = dure_hub_protocol::fingerprint::of_der(b"laptop");
        let now = 1_795_686_400;
        let mut key = PushKey::load_or_create(root.path()).unwrap();
        assert!(key
            .mint_grant(&hub, &subscription(PushPreference::Approvals), None, now)
            .is_err());
        key.prepare_grants(root.path(), PushPreference::All)
            .unwrap();
        assert!(key
            .mint_grant(&hub, &subscription(PushPreference::Approvals), None, now)
            .is_err());
        assert!(key
            .mint_grant(&hub, &subscription(PushPreference::All), None, now)
            .is_ok());
    }

    /// A computer left the paired store: the epoch rises, and the next sync
    /// grants the computers still paired at the new one.
    #[test]
    fn superseding_raises_the_epoch_and_starts_it_with_nothing_granted() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("push");
        // No epoch yet: nothing was ever granted, and nothing is written.
        assert_eq!(supersede(&folder), Ok(false));
        assert!(!folder.exists());

        ready(&folder, PushPreference::All);
        assert_eq!(supersede(&folder), Ok(true));
        let mut key = PushKey::load_or_create(&folder).unwrap();
        assert_eq!(key.epoch(), FIRST_EPOCH + 1);
        assert!(key
            .mint_grant(
                &dure_hub_protocol::fingerprint::of_der(b"laptop"),
                &subscription(PushPreference::All),
                None,
                1_795_686_400,
            )
            .is_err());
        // Nothing was granted at the new epoch, so fewer alerts need no
        // second rise.
        key.prepare_grants(&folder, PushPreference::Approvals)
            .unwrap();
        assert_eq!(key.epoch(), FIRST_EPOCH + 1);

        fs::write(folder.join(EPOCH_FILE), b"seven").unwrap();
        assert!(supersede(&folder).is_err());
    }

    /// A key that signed before the record existed, or whose record cannot
    /// be read, may have granted every alert.
    #[test]
    fn a_key_without_a_readable_record_counts_as_having_granted_every_alert() {
        let root = tempfile::tempdir().unwrap();
        let first = PushKey::load_or_create(root.path()).unwrap();
        assert_eq!(first.granted, None, "a key minted now has signed nothing");

        let older = PushKey::load_or_create(root.path()).unwrap();
        assert_eq!(older.granted, Some(PushPreference::All));
        assert_eq!(
            ready(root.path(), PushPreference::Approvals).epoch(),
            FIRST_EPOCH + 1
        );

        fs::write(root.path().join(GRANTED_FILE), b"{").unwrap();
        assert_eq!(
            ready(root.path(), PushPreference::Approvals).epoch(),
            FIRST_EPOCH + 2
        );
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
        // The record of what was granted is private too.
        ready(&folder, PushPreference::Approvals);
        for file in [EPOCH_FILE, GRANTED_FILE] {
            let mode = fs::metadata(folder.join(file))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "{file}: {mode:o}");
        }
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
