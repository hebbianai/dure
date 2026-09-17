//! The SSH private keys this device authenticates with.
//!
//! # This is not secure storage, and the UI says so
//!
//! The key is an ordinary file in the app's config directory. On iOS and
//! Android that container is not readable by other apps, and on Android it is
//! excluded from auto-backup by the manifest's default — but it *is* readable
//! by anything running as this app, it is copied by a full device backup on
//! iOS unless the file is excluded, and it survives on disk when the phone is
//! unlocked. A key here is a key that can leave the device.
//!
//! That is a deliberate, temporary trade and it is written into the product,
//! not just into this comment: [`crate::device_identity`] still reports
//! `NotProvisioned`, and the key screen carries a warning string. A demo that
//! quietly stored a private key in app storage and called itself secure is the
//! specific outcome this module refuses to produce.
//!
//! The real answer — a Secure Enclave / Keystore-bound `ecdsa-sha2-nistp256`
//! key that russh signs through, behind a Tauri mobile plugin that does not
//! exist for either platform — is scoped in `device_identity`.
//!
//! # Why there is still a second key slot, and why it is now optional in
//! practice as well as in the type
//!
//! The gateway is meant to be reached through a forced command
//! (`command="\"$HOME/.local/bin/hmux\" mobile-gateway",restrict` is what
//! `hmux pair` installs), and a forced command *replaces* whatever the client
//! asked to run — on the hosts where it applies at all. That used to
//! mean one key could serve only one mode, because listing was an argv flag the
//! client could never get past sshd. It no longer is: the listing request is a
//! document on the channel ([`crate::catalog::list_request`]), so **one key
//! serves both modes** and the ordinary setup stores only an attach key.
//!
//! The list slot is kept for the server an operator hardened by hand — a key
//! whose own forced command pins `--list`, which still works and still needs its
//! own line. When no list key is stored the attach key is reused, which is now
//! the normal path rather than a fallback with a caveat.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Which of a server's two possible keys is wanted.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeyRole {
    /// Authorized for the attach command.
    Attach,
    /// Authorized for a hand-hardened key whose own forced command pins
    /// `--list`. Optional, and normally absent: the listing request travels on
    /// the channel, so [`Self::Attach`] answers it. Falls back to
    /// [`Self::Attach`].
    List,
}

#[derive(Debug)]
pub enum IdentityStoreError {
    /// No key of this role is stored for this server.
    Missing { server_id: String },
    /// The stored text is not an OpenSSH private key at all. Checked on the
    /// way *in* so the failure names the paste, not the handshake.
    NotAPrivateKey,
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl std::fmt::Display for IdentityStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing { server_id } => {
                write!(formatter, "no SSH key is stored for server {server_id}")
            }
            Self::NotAPrivateKey => formatter.write_str(
                "that is not an OpenSSH private key (it must begin with -----BEGIN and contain PRIVATE KEY)",
            ),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl std::error::Error for IdentityStoreError {}

/// The header every key this client accepts carries.
///
/// russh decodes OpenSSH-format keys. A PuTTY `.ppk`, an SSH *public* key, or
/// an `authorized_keys` line are all things a user might paste, and all three
/// are well-formed text that fails much later inside the handshake with a
/// message about the key material rather than about the paste.
const PEM_HEADER: &str = "-----BEGIN";
const PEM_PRIVATE: &str = "PRIVATE KEY";

/// Rejects anything that is obviously not a private key.
///
/// Deliberately a shape check and not a parse: parsing here would need russh's
/// decoder and would fail for a *correct* encrypted key with no passphrase
/// supplied yet, which is a legitimate thing to store.
pub fn validate_private_key(text: &str) -> Result<(), IdentityStoreError> {
    let trimmed = text.trim();
    if trimmed.starts_with(PEM_HEADER) && trimmed.contains(PEM_PRIVATE) {
        Ok(())
    } else {
        Err(IdentityStoreError::NotAPrivateKey)
    }
}

/// The pairing identity's file name. Not built from [`stable_digest`] like a
/// server key: it names no server, and a fixed name is what lets a person
/// answer "which key does this phone pair with" by looking.
const PAIRING_IDENTITY_FILE: &str = "pairing-identity.key";

fn key_path(root: &Path, server_id: &str, role: KeyRole) -> PathBuf {
    // The id is hashed rather than used as a file name. Server ids are
    // client-generated UUIDs today, but a `../` or a `/` in one would escape
    // the directory, and a store that is only safe because of who happens to
    // write to it is not safe.
    let digest = stable_digest(server_id);
    let suffix = match role {
        KeyRole::Attach => "attach",
        KeyRole::List => "list",
    };
    root.join(format!("{digest}.{suffix}.key"))
}

/// A short, filesystem-safe, collision-resistant-enough name for an id.
///
/// FNV-1a rather than a cryptographic hash: this is a *naming* function, not a
/// security boundary — the ids it names are chosen by this app, and a
/// collision would mean two of the user's own servers sharing a key file. 64
/// bits is far past what a hand-entered server list can reach.
fn stable_digest(value: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Writes a key, replacing any previous one for that server and role.
///
/// Replacing the attach key also drops a list key that was the same key. A
/// typed-in host used to be stored under both roles at once, and `load`'s
/// list-to-attach fallback already covers a host with one key; a copy left in
/// the list slot would make the listing dial with the key just replaced while
/// the screen shows the new key's public half as the line to register. A list
/// key of its own — the two-key setup — is not the same bytes and stays.
pub fn store(
    root: &Path,
    server_id: &str,
    role: KeyRole,
    private_key_pem: &str,
) -> Result<(), IdentityStoreError> {
    validate_private_key(private_key_pem)?;
    fs::create_dir_all(root).map_err(|source| IdentityStoreError::Io {
        operation: "create the SSH key directory",
        source,
    })?;
    let path = key_path(root, server_id, role);
    if role == KeyRole::Attach {
        drop_list_copy_of(root, server_id, &path)?;
    }
    write_private_file(&path, private_key_pem.trim_end().as_bytes())
}

/// Removes the list key when it is byte-for-byte the attach key at `attach_path`.
fn drop_list_copy_of(
    root: &Path,
    server_id: &str,
    attach_path: &Path,
) -> Result<(), IdentityStoreError> {
    let list_path = key_path(root, server_id, KeyRole::List);
    let (Some(list), Some(attach)) = (read_key(&list_path)?, read_key(attach_path)?) else {
        return Ok(());
    };
    if list != attach {
        return Ok(());
    }
    fs::remove_file(&list_path).map_err(|source| IdentityStoreError::Io {
        operation: "delete the SSH key",
        source,
    })
}

/// Where a key is staged before it replaces the live one.
fn staging_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".new");
    path.with_file_name(name)
}

/// Writes key material to `path` without ever leaving it readable.
///
/// # Why not `fs::write` and then `set_permissions`
///
/// `fs::write` creates with `0666 & !umask`, so on a machine whose umask is
/// `022` the private key exists at `0644` for the whole of the write and until
/// the `chmod` lands. That window is short and it is real: on a desktop dev run
/// the config directory is an ordinary home directory, and any process on the
/// box wins the race by simply reading the file. The mode therefore comes from
/// `OpenOptions::mode` at *creation*, which the kernel applies before the file
/// descriptor exists — there is no moment at which the file is both present and
/// wide.
///
/// # Why a staging file and a rename
///
/// Two properties, neither of which writing in place has:
///
/// - **Replacing a key is atomic.** A crash mid-write leaves the previous key
///   whole rather than a truncated one, which the SSH handshake would reject
///   with a message about the key material.
/// - **A symlink planted at the key path cannot carry the key out of the
///   directory.** `fs::write` follows a symlink and writes *through* it;
///   `fs::rename` replaces the link itself. The staging file is created with
///   `create_new`, which refuses to follow anything already at that name, and
///   the stale-staging removal before it is `remove_file`, which unlinks a
///   symlink rather than its target. If something re-plants between the two,
///   `create_new` fails and the write is refused — the one outcome that is
///   never "the key was written somewhere else".
fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), IdentityStoreError> {
    let staging = staging_path(path);
    match fs::remove_file(&staging) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(IdentityStoreError::Io {
                operation: "clear the staged SSH key",
                source,
            });
        }
    }

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    restrict_new_file(&mut options);
    let mut file = options
        .open(&staging)
        .map_err(|source| IdentityStoreError::Io {
            operation: "create the SSH key file",
            source,
        })?;
    file.write_all(contents)
        .map_err(|source| IdentityStoreError::Io {
            operation: "write the SSH key",
            source,
        })?;
    drop(file);

    fs::rename(&staging, path).map_err(|source| IdentityStoreError::Io {
        operation: "commit the SSH key",
        source,
    })
}

/// Asks the kernel for `0600` at creation time, where the platform has modes.
#[cfg(unix)]
fn restrict_new_file(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

/// Windows has no mode bits to set here; the per-app container is the boundary.
/// Present so the caller is not `cfg`-shaped, and so this file compiles on the
/// desktop targets `cargo test` runs on.
#[cfg(not(unix))]
fn restrict_new_file(_options: &mut OpenOptions) {}

/// Reads the key for `role`, falling back to the attach key for a list request.
///
/// The fallback is one-directional. An attach must never silently use the list
/// key: under the two-key setup that key is pinned to `--list`, so the attach
/// would run a listing, and a handshake reply that is a catalog document is
/// far more confusing than a missing key.
pub fn load(root: &Path, server_id: &str, role: KeyRole) -> Result<String, IdentityStoreError> {
    match read_key(&key_path(root, server_id, role)) {
        Ok(Some(key)) => Ok(key),
        Ok(None) if role == KeyRole::List => {
            match read_key(&key_path(root, server_id, KeyRole::Attach))? {
                Some(key) => Ok(key),
                None => Err(IdentityStoreError::Missing {
                    server_id: server_id.to_string(),
                }),
            }
        }
        Ok(None) => Err(IdentityStoreError::Missing {
            server_id: server_id.to_string(),
        }),
        Err(error) => Err(error),
    }
}

fn read_key(path: &Path) -> Result<Option<String>, IdentityStoreError> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(IdentityStoreError::Io {
            operation: "read the SSH key",
            source,
        }),
    }
}

/// The one key this install pairs with, created on first use.
///
/// # Why this is not a fresh key per pairing
///
/// It was, and that made the laptop's "remove this phone" a half-truth. Each
/// pairing installed its own `authorized_keys` line on every configured
/// server, so a phone that had paired three times held three keys and removing
/// the device took one of them — the phone kept walking in through the others.
/// The owner reported it as "some of them still work" and the servers agreed:
/// seven pairing lines on one box, five on another (2026-09-05).
///
/// The laptop groups a phone's records by public-key fingerprint, so one
/// durable key is what makes one phone one identity there. Pairing again
/// re-uses this key rather than adding to the pile.
///
/// # What it costs
///
/// Per-pairing keys could, in principle, be revoked one at a time. Nothing
/// asked for that: a pairing is not a session, and the operator's unit of
/// thought is the phone. What the granularity actually bought was an
/// unrevocable pile.
///
/// The key lives in the same directory as the per-server keys, so
/// `device_reset` — which renames the whole config root — takes it too. That
/// is the property the reset screen promises: after it, this is a new phone,
/// and the laptop will file its next pairing under a new identity.
pub fn pairing_identity(
    root: &Path,
    generate: impl FnOnce() -> Result<String, IdentityStoreError>,
) -> Result<String, IdentityStoreError> {
    let path = root.join(PAIRING_IDENTITY_FILE);
    if let Some(stored) = read_key(&path)? {
        // Validated on the way out as well as in: a truncated or hand-edited
        // file must fail here, where the message is about the stored key,
        // rather than inside a handshake that will name the network instead.
        validate_private_key(&stored)?;
        return Ok(stored);
    }
    let minted = generate()?;
    validate_private_key(&minted)?;
    fs::create_dir_all(root).map_err(|source| IdentityStoreError::Io {
        operation: "create the SSH key directory",
        source,
    })?;
    write_private_file(&path, minted.trim_end().as_bytes())?;
    Ok(minted)
}

/// Drops this install's pairing identity, so the next pairing mints a new one.
///
/// Called when the laptop says this device is revoked: the laptop has just
/// collected every record carrying this key's fingerprint, and pairing again
/// under the same key would file the phone back under the identity that was
/// removed. Missing is success — there is nothing to drop on a phone that has
/// never paired.
pub fn forget_pairing_identity(root: &Path) -> Result<(), IdentityStoreError> {
    match fs::remove_file(root.join(PAIRING_IDENTITY_FILE)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(IdentityStoreError::Io {
            operation: "remove this device's pairing key",
            source,
        }),
    }
}

/// Whether a key of this role is stored, without reading the key material.
///
/// The UI needs to render "this server has a key" on every list row, and
/// loading private keys into memory to draw a label is how key material ends
/// up somewhere it was never meant to be.
#[must_use]
pub fn has_key(root: &Path, server_id: &str, role: KeyRole) -> bool {
    key_path(root, server_id, role).exists()
}

/// Deletes both keys for a server. Called when the server entry goes away, so
/// that removing a server does not leave its key on disk.
pub fn forget(root: &Path, server_id: &str) -> Result<(), IdentityStoreError> {
    for role in [KeyRole::Attach, KeyRole::List] {
        let path = key_path(root, server_id, role);
        // The staging file too. A crash between create and rename leaves a
        // complete private key at that name, and a copy that outlives the entry
        // naming it is a file nobody will ever think to delete.
        for target in [staging_path(&path), path] {
            match fs::remove_file(target) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(source) => {
                    return Err(IdentityStoreError::Io {
                        operation: "delete the SSH key",
                        source,
                    });
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str =
        "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----";

    #[test]
    fn a_stored_key_round_trips() {
        let directory = tempfile::tempdir().expect("tempdir");

        store(directory.path(), "server-a", KeyRole::Attach, KEY).expect("store");

        assert_eq!(
            load(directory.path(), "server-a", KeyRole::Attach).expect("load"),
            KEY
        );
    }

    /// A typed-in host used to be stored under both roles at once. Replacing
    /// the attach key must not leave that copy behind in the list slot: the
    /// listing would dial with the old key while the screen shows the new
    /// key's public half as the one to register.
    #[test]
    fn replacing_an_attach_key_drops_a_list_key_that_was_the_same_key() {
        let directory = tempfile::tempdir().expect("tempdir");
        const REPLACEMENT: &str =
            "-----BEGIN OPENSSH PRIVATE KEY-----\nnext\n-----END OPENSSH PRIVATE KEY-----";
        store(directory.path(), "server-a", KeyRole::Attach, KEY).expect("store attach");
        store(directory.path(), "server-a", KeyRole::List, KEY).expect("store list");

        store(directory.path(), "server-a", KeyRole::Attach, REPLACEMENT).expect("replace");

        assert!(!has_key(directory.path(), "server-a", KeyRole::List));
        assert_eq!(
            load(directory.path(), "server-a", KeyRole::List).expect("list falls back"),
            REPLACEMENT
        );
        assert_eq!(
            load(directory.path(), "server-a", KeyRole::Attach).expect("attach"),
            REPLACEMENT
        );
    }

    /// A list key of its own — the two-key setup — is not touched by an
    /// attach replacement.
    #[test]
    fn replacing_an_attach_key_keeps_a_distinct_list_key() {
        let directory = tempfile::tempdir().expect("tempdir");
        const LIST: &str =
            "-----BEGIN OPENSSH PRIVATE KEY-----\nlist\n-----END OPENSSH PRIVATE KEY-----";
        const REPLACEMENT: &str =
            "-----BEGIN OPENSSH PRIVATE KEY-----\nnext\n-----END OPENSSH PRIVATE KEY-----";
        store(directory.path(), "server-a", KeyRole::Attach, KEY).expect("store attach");
        store(directory.path(), "server-a", KeyRole::List, LIST).expect("store list");

        store(directory.path(), "server-a", KeyRole::Attach, REPLACEMENT).expect("replace");

        assert!(has_key(directory.path(), "server-a", KeyRole::List));
        assert_eq!(
            load(directory.path(), "server-a", KeyRole::List).expect("list"),
            LIST
        );
    }

    #[test]
    fn a_missing_key_is_a_named_error_rather_than_an_empty_string() {
        let directory = tempfile::tempdir().expect("tempdir");

        let error = load(directory.path(), "server-a", KeyRole::Attach)
            .expect_err("no key must not read as an empty key");

        assert!(matches!(error, IdentityStoreError::Missing { .. }));
    }

    /// The two-key setup: a list request may borrow the attach key, because
    /// the common first-time setup is one unrestricted key.
    #[test]
    fn a_list_request_falls_back_to_the_attach_key() {
        let directory = tempfile::tempdir().expect("tempdir");
        store(directory.path(), "server-a", KeyRole::Attach, KEY).expect("store");

        assert_eq!(
            load(directory.path(), "server-a", KeyRole::List).expect("fallback"),
            KEY
        );
    }

    /// The reverse must never happen. A list key is pinned to `--list` under
    /// the hardened setup, so an attach borrowing it would run a listing and
    /// answer the handshake with a catalog document.
    #[test]
    fn an_attach_never_borrows_the_list_key() {
        let directory = tempfile::tempdir().expect("tempdir");
        store(directory.path(), "server-a", KeyRole::List, KEY).expect("store");

        let error = load(directory.path(), "server-a", KeyRole::Attach)
            .expect_err("an attach must not fall back to the list key");

        assert!(matches!(error, IdentityStoreError::Missing { .. }));
    }

    #[test]
    fn a_public_key_paste_is_refused_at_the_point_it_is_pasted() {
        let error = validate_private_key("ssh-ed25519 AAAAC3Nz… phone")
            .expect_err("a public key must be refused");

        assert!(matches!(error, IdentityStoreError::NotAPrivateKey));
    }

    #[test]
    fn an_encrypted_key_is_accepted_because_the_passphrase_comes_later() {
        validate_private_key(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nencrypted-body\n-----END OPENSSH PRIVATE KEY-----",
        )
        .expect("an encrypted key is still a key");
    }

    /// A server id is used to *name* a file. It is a UUID today, but a store
    /// that is only safe because of who happens to write to it is not safe.
    #[test]
    fn a_traversing_server_id_cannot_escape_the_key_directory() {
        let directory = tempfile::tempdir().expect("tempdir");

        store(directory.path(), "../../escaped", KeyRole::Attach, KEY).expect("store");

        let written: Vec<_> = fs::read_dir(directory.path())
            .expect("read dir")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(written.len(), 1, "{written:?}");
        assert!(!written[0].to_string_lossy().contains(".."), "{written:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_written_key_is_not_readable_by_the_rest_of_the_machine() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().expect("tempdir");

        store(directory.path(), "server-a", KeyRole::Attach, KEY).expect("store");

        let path = key_path(directory.path(), "server-a", KeyRole::Attach);
        let mode = fs::metadata(&path).expect("metadata").permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "{mode:o}");
    }

    /// The mode must come from the *create*, not from a `chmod` afterwards.
    ///
    /// A permissive umask is what makes the difference observable: a
    /// `fs::write` creates at `0666 & !umask`, so under umask `000` the file
    /// sits at `0666` until the `chmod` lands. This test reads the mode of the
    /// staged file — the one the write actually goes to — while it still
    /// exists, which is the window the old shape left open.
    #[cfg(unix)]
    #[test]
    fn the_staged_key_is_private_from_the_moment_it_exists() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().expect("tempdir");
        let destination = key_path(directory.path(), "server-a", KeyRole::Attach);
        fs::create_dir_all(directory.path()).expect("create the key directory");

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        restrict_new_file(&mut options);
        let staging = staging_path(&destination);
        let file = options.open(&staging).expect("create the staged key");

        let mode = file.metadata().expect("metadata").permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "the staged key was {mode:o} before a single byte was written"
        );
    }

    /// A symlink at the key path must not become a pipe for the private key to
    /// leave the app's directory. `fs::write` follows it and writes *through*
    /// it; a rename replaces the link.
    #[cfg(unix)]
    #[test]
    fn a_symlink_at_the_key_path_cannot_carry_the_key_out_of_the_directory() {
        let directory = tempfile::tempdir().expect("tempdir");
        let elsewhere = tempfile::tempdir().expect("elsewhere");
        let stolen = elsewhere.path().join("stolen");
        fs::write(&stolen, b"untouched").expect("seed the target");
        let destination = key_path(directory.path(), "server-a", KeyRole::Attach);
        fs::create_dir_all(directory.path()).expect("create the key directory");
        std::os::unix::fs::symlink(&stolen, &destination).expect("plant the symlink");

        store(directory.path(), "server-a", KeyRole::Attach, KEY).expect("store");

        assert_eq!(
            fs::read_to_string(&stolen).expect("read the planted target"),
            "untouched",
            "the private key was written through a planted symlink"
        );
        assert_eq!(
            fs::read_to_string(&destination).expect("read the key"),
            KEY,
            "the key must land at its own path"
        );
    }

    /// The same attack against the staging name. `create_new` refuses to open
    /// anything already there, and the removal that precedes it unlinks the
    /// link rather than following it.
    #[cfg(unix)]
    #[test]
    fn a_symlink_at_the_staging_path_cannot_carry_the_key_out_either() {
        let directory = tempfile::tempdir().expect("tempdir");
        let elsewhere = tempfile::tempdir().expect("elsewhere");
        let stolen = elsewhere.path().join("stolen");
        fs::write(&stolen, b"untouched").expect("seed the target");
        let destination = key_path(directory.path(), "server-a", KeyRole::Attach);
        fs::create_dir_all(directory.path()).expect("create the key directory");
        std::os::unix::fs::symlink(&stolen, staging_path(&destination)).expect("plant the symlink");

        store(directory.path(), "server-a", KeyRole::Attach, KEY).expect("store");

        assert_eq!(
            fs::read_to_string(&stolen).expect("read the planted target"),
            "untouched",
            "the private key was written through a planted staging symlink"
        );
    }

    /// Replacing a key must leave exactly one file behind. A staging file that
    /// survives is a second copy of a private key that nobody will think to
    /// delete.
    #[test]
    fn replacing_a_key_leaves_no_staged_copy_behind() {
        let directory = tempfile::tempdir().expect("tempdir");
        let replacement =
            "-----BEGIN OPENSSH PRIVATE KEY-----\nsecond\n-----END OPENSSH PRIVATE KEY-----";

        store(directory.path(), "server-a", KeyRole::Attach, KEY).expect("first");
        store(directory.path(), "server-a", KeyRole::Attach, replacement).expect("second");

        let written: Vec<_> = fs::read_dir(directory.path())
            .expect("read dir")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(written.len(), 1, "{written:?}");
        assert_eq!(
            load(directory.path(), "server-a", KeyRole::Attach).expect("load"),
            replacement
        );
    }

    #[test]
    fn forgetting_a_server_removes_both_of_its_keys() {
        let directory = tempfile::tempdir().expect("tempdir");
        store(directory.path(), "server-a", KeyRole::Attach, KEY).expect("store");
        store(directory.path(), "server-a", KeyRole::List, KEY).expect("store");

        forget(directory.path(), "server-a").expect("forget");

        assert!(!has_key(directory.path(), "server-a", KeyRole::Attach));
        assert!(!has_key(directory.path(), "server-a", KeyRole::List));
    }

    #[test]
    fn forgetting_a_server_that_has_no_keys_is_not_an_error() {
        let directory = tempfile::tempdir().expect("tempdir");

        forget(directory.path(), "server-a")
            .expect("removing nothing is a state, not a transition");
    }

    /// 짝짓기마다 키를 새로 만들면 서버마다 줄이 하나씩 쌓이고, 노트북의
    /// "이 폰 삭제"는 그중 하나만 거둔다 — 지운 뒤에도 폰이 들어가는 그 상태다.
    /// 두 번째 짝짓기가 첫 번째와 같은 키를 써야 한 폰이 하나의 신원이 된다.
    #[test]
    fn pairing_twice_uses_the_same_identity() {
        let directory = tempfile::tempdir().expect("tempdir");
        let second = format!("{KEY}\n");

        let first = pairing_identity(directory.path(), || Ok(KEY.to_string())).expect("mint");
        let again = pairing_identity(directory.path(), || Ok(second.clone()))
            .expect("the stored key answers the second scan");

        assert_eq!(first.trim(), KEY);
        assert_eq!(
            again.trim(),
            KEY,
            "the second pairing must not mint a key the first pairing's servers never saw"
        );
    }

    /// 기기 초기화는 설정 디렉터리째 옮긴다. 그 뒤의 이 폰은 새 폰이어야 하고,
    /// 노트북은 다음 짝짓기를 새 신원으로 적는다.
    #[test]
    fn a_reset_config_directory_mints_a_new_identity() {
        let directory = tempfile::tempdir().expect("tempdir");
        pairing_identity(directory.path(), || Ok(KEY.to_string())).expect("mint");
        let fresh = directory.path().join("after-reset");

        let minted = pairing_identity(&fresh, || Ok(KEY.to_string())).expect("mint again");

        assert_eq!(minted.trim(), KEY);
        assert!(fresh.join(PAIRING_IDENTITY_FILE).exists());
    }

    /// 잘린 파일은 여기서 이름을 갖고 실패해야 한다. 그대로 들고 나가면
    /// 핸드셰이크가 네트워크 이야기를 하며 실패한다.
    #[test]
    fn a_stored_identity_that_is_not_a_key_is_refused_by_name() {
        let directory = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(directory.path()).expect("directory");
        fs::write(directory.path().join(PAIRING_IDENTITY_FILE), "잘린 파일").expect("write");

        let refusal = pairing_identity(directory.path(), || Ok(KEY.to_string()));

        assert!(matches!(refusal, Err(IdentityStoreError::NotAPrivateKey)));
    }
}
