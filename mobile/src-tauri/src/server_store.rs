//! The list of servers this device knows how to reach, persisted as one JSON
//! document.
//!
//! Deliberately dumb: a label, an address, an account, and the SSH host key
//! fingerprint to pin. No private keys — those are separate files in
//! [`crate::identity_store`], so drawing this list never loads key material.
//! No cached discovery results either: a fence caches four fields that move
//! when the Host is replaced, and a stale one attaches to nothing while
//! looking like it should.
//!
//! The module is pure — it takes a path — so it is testable without Tauri,
//! per the "logic in modules, wiring in components" rule in AGENTS.md.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Document format version.
///
/// 2 adds `host_key_fingerprint`. 3 adds `paired` and
/// `attach_key_confinement`, both written by the pairing flow. Bumped only for
/// a shape change this code cannot read; a *newer* version is refused rather
/// than ignored (see `load`), while an older one is read forward — see
/// `host_key_fingerprint`.
pub const STORE_VERSION: u32 = 3;

/// How confined the phone's attach key is on the server, as reported by the
/// laptop that installed it.
///
/// Text rather than a closed enum, for the reason `catalog::CatalogEnum` is
/// text: a value this build has never seen must render as "unknown", not
/// discard the whole server list. Meaning is applied in exactly one place — the
/// two predicates below — and both are positive, so an unrecognised value is
/// neither confined nor account-wide and the UI says it does not know.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct KeyConfinement(pub String);

/// The key is pinned to a `command="…"` forced command, so it can run nothing
/// else on the box.
///
/// This is what `hmux pair` now installs, and it is the honest value for it: the
/// pinned command is `hmux mobile-gateway` with no `--session`, so the key
/// reaches every session that account owns — but it still cannot run anything
/// *else*, which is the distinction this constant names. The reach is reported
/// separately, as `attach::Limitation::PairedKeyReachesEverySession`.
pub const CONFINEMENT_FORCED_COMMAND: &str = "forced_command";

/// The key carries `restrict` but **no** forced command, so it can run any
/// command as that account.
///
/// Not a hypothetical: it is what a user gets who pastes an ordinary key into an
/// `authorized_keys` by hand instead of pairing. It used to also describe paired
/// keys, back when a forced command had to name a session that did not exist yet
/// — that is no longer true, and a paired key is now
/// [`CONFINEMENT_FORCED_COMMAND`]. This value exists so a hand-pasted key cannot
/// look as confined as a paired one.
pub const CONFINEMENT_ACCOUNT_WIDE: &str = "account_wide";

impl KeyConfinement {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn is_forced_command(&self) -> bool {
        self.0 == CONFINEMENT_FORCED_COMMAND
    }

    #[must_use]
    pub fn is_account_wide(&self) -> bool {
        self.0 == CONFINEMENT_ACCOUNT_WIDE
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct ServerEntry {
    /// Stable identity for the entry, chosen by the client that created it.
    /// Not the hostname: a user may keep two accounts on one box.
    pub id: String,
    /// User-facing name. Free text.
    pub label: String,
    pub host: String,
    pub port: u16,
    /// The account `ssh` authenticates as. The gateway then runs as this
    /// account, and the whole relay trust chain is premised on it — so it is
    /// required, never inferred from the local username, which on a phone
    /// means nothing.
    pub username: String,
    /// The SSH host key to accept, as `SHA256:…`.
    ///
    /// `#[serde(default)]` so a version-1 document — written before pinning
    /// existed — is read forward with an empty value instead of failing to
    /// parse and taking the whole list with it. Empty is *not* treated as
    /// "accept anything": [`ServerEntry::validate`] leaves it alone so the
    /// entry survives, and `relay::ssh_config` refuses to dial without it. The
    /// alternative — validating it here — would turn every pre-existing entry
    /// into an unreadable document, which is the silent-data-loss failure
    /// `load` exists to avoid.
    #[serde(default)]
    pub host_key_fingerprint: String,
    /// True when this entry arrived from a pairing rather than being typed in.
    ///
    /// The distinction is not cosmetic: a paired entry's keys were installed on
    /// the server by the laptop, so "delete this server" also throws away
    /// access that nothing on the phone can restore. A hand-entered one can be
    /// retyped.
    #[serde(default)]
    pub paired: bool,
    /// What the pairing said about the attach key's `authorized_keys` line.
    /// Empty for a hand-entered server, where this client knows nothing about
    /// the line and must not guess.
    #[serde(default)]
    pub attach_key_confinement: KeyConfinement,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct ServerDocument {
    pub version: u32,
    pub servers: Vec<ServerEntry>,
}

impl ServerDocument {
    #[must_use]
    pub fn empty() -> Self {
        Self {
            version: STORE_VERSION,
            servers: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub enum ServerStoreError {
    /// The file exists but is not a document this build can read. Never
    /// downgraded to "no servers" — see `load`.
    Unreadable {
        detail: String,
    },
    UnsupportedVersion {
        found: u32,
        supported: u32,
    },
    DuplicateId {
        id: String,
    },
    InvalidEntry {
        field: &'static str,
        detail: String,
    },
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl std::fmt::Display for ServerStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable { detail } => {
                write!(formatter, "server list is not readable: {detail}")
            }
            Self::UnsupportedVersion { found, supported } => write!(
                formatter,
                "server list version {found} is newer than this build supports ({supported})"
            ),
            Self::DuplicateId { id } => write!(formatter, "duplicate server id: {id}"),
            Self::InvalidEntry { field, detail } => {
                write!(formatter, "invalid server {field}: {detail}")
            }
            Self::Io { operation, source } => {
                write!(formatter, "{operation} failed: {source}")
            }
        }
    }
}

impl std::error::Error for ServerStoreError {}

impl ServerEntry {
    /// Rejects entries that cannot describe a reachable account.
    ///
    /// Port 0 is refused explicitly: it is a valid `u16` and a valid "let the
    /// kernel pick" bind port, so it round-trips through serde without
    /// complaint and only fails much later, at connect, as an opaque error.
    pub fn validate(&self) -> Result<(), ServerStoreError> {
        for (field, value) in [
            ("id", &self.id),
            ("label", &self.label),
            ("host", &self.host),
            ("username", &self.username),
        ] {
            if value.trim().is_empty() {
                return Err(ServerStoreError::InvalidEntry {
                    field,
                    detail: "must not be empty".to_string(),
                });
            }
        }
        if self.port == 0 {
            return Err(ServerStoreError::InvalidEntry {
                field: "port",
                detail: "must not be 0".to_string(),
            });
        }
        Ok(())
    }
}

/// Reads the document at `path`.
///
/// A missing file is an empty list — that is first launch, not a fault.
///
/// Anything else that fails to parse is an **error**, never an empty list.
/// Returning `Ok(empty)` for a corrupt file is indistinguishable in the UI
/// from "you have not added a server yet", so the user re-enters everything
/// and the next save overwrites the file that was merely unparsed. The
/// user-visible cost of the honest answer is one error banner; the cost of the
/// convenient one is silent data loss.
pub fn load(path: &Path) -> Result<ServerDocument, ServerStoreError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ServerDocument::empty());
        }
        Err(source) => {
            return Err(ServerStoreError::Io {
                operation: "read server list",
                source,
            });
        }
    };

    let document: ServerDocument =
        serde_json::from_slice(&bytes).map_err(|error| ServerStoreError::Unreadable {
            detail: error.to_string(),
        })?;

    if document.version > STORE_VERSION {
        return Err(ServerStoreError::UnsupportedVersion {
            found: document.version,
            supported: STORE_VERSION,
        });
    }

    validate_document(&document)?;
    Ok(document)
}

/// Writes the document at `path` via a temp file and a rename.
///
/// The rename is what makes a crash mid-save leave the previous list intact
/// instead of a truncated one, which `load` would then refuse.
pub fn save(path: &Path, document: &ServerDocument) -> Result<(), ServerStoreError> {
    validate_document(document)?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| ServerStoreError::Io {
            operation: "create server list directory",
            source,
        })?;
    }

    let serialized =
        serde_json::to_vec_pretty(document).map_err(|error| ServerStoreError::Unreadable {
            detail: error.to_string(),
        })?;

    let temporary = temporary_path(path);
    fs::write(&temporary, &serialized).map_err(|source| ServerStoreError::Io {
        operation: "write server list",
        source,
    })?;
    fs::rename(&temporary, path).map_err(|source| ServerStoreError::Io {
        operation: "commit server list",
        source,
    })
}

/// Inserts or replaces `entry` by id and persists.
pub fn upsert(path: &Path, entry: ServerEntry) -> Result<ServerDocument, ServerStoreError> {
    entry.validate()?;
    let mut document = load(path)?;
    match document.servers.iter_mut().find(|held| held.id == entry.id) {
        Some(held) => *held = entry,
        None => document.servers.push(entry),
    }
    document.version = STORE_VERSION;
    save(path, &document)?;
    Ok(document)
}

/// Takes a paired inventory into the list, in one save.
///
/// Upsert semantics per id, deliberately **not** "replace the whole list".
/// After pairing, the laptop is gone — it is not consulted again — so its
/// inventory is the authority on the servers it named and on nothing else. A
/// server the user typed in by hand, or one from an earlier pairing with a
/// different laptop, is not something a later pairing gets to delete: the phone
/// would lose reachable sessions and the only fix would be to open the laptop
/// again, which is the dependency this design exists to remove.
///
/// One save for the whole batch, not one per server, so a failure part-way
/// leaves the previous list whole rather than half the inventory.
pub fn adopt(path: &Path, incoming: Vec<ServerEntry>) -> Result<ServerDocument, ServerStoreError> {
    for entry in &incoming {
        entry.validate()?;
    }
    let mut document = load(path)?;
    for entry in incoming {
        match document.servers.iter_mut().find(|held| held.id == entry.id) {
            Some(held) => *held = entry,
            None => document.servers.push(entry),
        }
    }
    document.version = STORE_VERSION;
    save(path, &document)?;
    Ok(document)
}

/// Drops every server a pairing installed, and names the ones it dropped.
///
/// Called when the laptop answers that this device is revoked. Those entries
/// are keys the laptop put on servers and has just taken back, so what is left
/// on the phone is a list of doors that no longer open — and the phone cannot
/// restore them itself, which is exactly why they must go rather than sit there
/// failing.
///
/// A hand-entered server stays. The laptop never granted it and is not
/// revoking it; its key is the person's own, and it can still be typed again
/// even if it were removed. Deleting it here would turn "the laptop removed
/// this phone" into "the phone lost servers the laptop never knew about".
///
/// The ids come back so the caller can delete the matching key files: a key
/// left behind after its server is gone is key material with no purpose.
pub fn drop_paired(document: &mut ServerDocument) -> Vec<String> {
    let dropped: Vec<String> = document
        .servers
        .iter()
        .filter(|entry| entry.paired)
        .map(|entry| entry.id.clone())
        .collect();
    document.servers.retain(|entry| !entry.paired);
    dropped
}

/// Removes the entry with `id` and persists. Removing an absent id succeeds:
/// the caller asked for a state, not for a transition.
pub fn remove(path: &Path, id: &str) -> Result<ServerDocument, ServerStoreError> {
    let mut document = load(path)?;
    document.servers.retain(|entry| entry.id != id);
    save(path, &document)?;
    Ok(document)
}

fn validate_document(document: &ServerDocument) -> Result<(), ServerStoreError> {
    let mut seen: Vec<&str> = Vec::with_capacity(document.servers.len());
    for entry in &document.servers {
        entry.validate()?;
        if seen.contains(&entry.id.as_str()) {
            return Err(ServerStoreError::DuplicateId {
                id: entry.id.clone(),
            });
        }
        seen.push(entry.id.as_str());
    }
    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> ServerEntry {
        ServerEntry {
            id: id.to_string(),
            label: "작업 서버".to_string(),
            host: "box.example".to_string(),
            port: 22,
            username: "kattpish".to_string(),
            host_key_fingerprint: "SHA256:AAAABBBBCCCC".to_string(),
            paired: false,
            attach_key_confinement: KeyConfinement::default(),
        }
    }

    fn paired_entry(id: &str) -> ServerEntry {
        ServerEntry {
            paired: true,
            attach_key_confinement: KeyConfinement(CONFINEMENT_ACCOUNT_WIDE.to_string()),
            ..entry(id)
        }
    }

    /// A version-2 document predates the pairing flow entirely. Refusing it
    /// would delete a hand-entered list on upgrade.
    #[test]
    fn a_version_2_document_is_read_forward_as_not_paired() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("servers.json");
        fs::write(
            &path,
            br#"{"version":2,"servers":[{"id":"a","label":"L","host":"h","port":22,
                "username":"u","host_key_fingerprint":"SHA256:x"}]}"#,
        )
        .expect("seed a version 2 document");

        let document = load(&path).expect("an older document must still load");

        assert!(!document.servers[0].paired);
        assert_eq!(document.servers[0].attach_key_confinement.as_str(), "");
    }

    /// A confinement value this build has never seen must not take the list
    /// down with it, and must not read as either known state.
    #[test]
    fn an_unrecognised_confinement_is_neither_confined_nor_account_wide() {
        let unknown = KeyConfinement("sandboxed_v2".to_string());

        assert!(!unknown.is_forced_command());
        assert!(!unknown.is_account_wide());
    }

    /// The property the whole "the laptop is gone afterwards" premise rests
    /// on: adopting an inventory must not be able to remove reachability the
    /// phone already had. A replace-the-list implementation passes every other
    /// test here and fails this one.
    #[test]
    fn adopting_an_inventory_keeps_servers_the_inventory_does_not_mention() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("servers.json");
        upsert(&path, entry("hand-typed")).expect("seed a hand-entered server");

        let document = adopt(&path, vec![paired_entry("from-laptop")]).expect("adopt");

        let ids: Vec<_> = document
            .servers
            .iter()
            .map(|server| server.id.as_str())
            .collect();
        assert_eq!(ids, vec!["hand-typed", "from-laptop"]);
    }

    #[test]
    fn adopting_replaces_a_server_the_inventory_names_again() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("servers.json");
        adopt(&path, vec![paired_entry("box")]).expect("first pairing");

        let mut moved = paired_entry("box");
        moved.host = "box-2.example".to_string();
        moved.attach_key_confinement = KeyConfinement(CONFINEMENT_FORCED_COMMAND.to_string());
        let document = adopt(&path, vec![moved.clone()]).expect("second pairing");

        assert_eq!(document.servers, vec![moved]);
        assert!(document.servers[0]
            .attach_key_confinement
            .is_forced_command());
    }

    /// A malformed entry must not be written and must not be half-written.
    /// The batch is validated before `load`, so the previous list is still on
    /// disk untouched.
    #[test]
    fn one_invalid_server_refuses_the_whole_inventory() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("servers.json");
        upsert(&path, entry("kept")).expect("seed");
        let mut broken = paired_entry("broken");
        broken.port = 0;

        let error = adopt(&path, vec![paired_entry("good"), broken])
            .expect_err("an unusable entry must refuse the batch");

        assert!(
            matches!(error, ServerStoreError::InvalidEntry { field: "port", .. }),
            "unexpected error: {error:?}"
        );
        let reloaded = load(&path).expect("reload");
        assert_eq!(reloaded.servers, vec![entry("kept")]);
    }

    /// A list written before host-key pinning existed must survive the
    /// upgrade. Refusing it would mean the user's servers vanish and the next
    /// save overwrites the file that was merely unparsed — the same
    /// silent-data-loss shape `load` refuses for a corrupt file.
    #[test]
    fn a_version_1_document_is_read_forward_with_an_empty_fingerprint() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("servers.json");
        fs::write(
            &path,
            br#"{"version":1,"servers":[{"id":"a","label":"L","host":"h","port":22,"username":"u"}]}"#,
        )
        .expect("seed a version 1 document");

        let document = load(&path).expect("an older document must still load");

        assert_eq!(document.servers.len(), 1);
        assert_eq!(document.servers[0].host_key_fingerprint, "");
    }

    #[test]
    fn missing_store_is_an_empty_list_not_an_error() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("servers.json");

        let document = load(&path).expect("first launch must not fail");

        assert_eq!(document, ServerDocument::empty());
    }

    #[test]
    fn corrupt_store_refuses_rather_than_reporting_no_servers() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("servers.json");
        fs::write(&path, b"{ this is not json").expect("seed corrupt file");

        let error = load(&path).expect_err("a corrupt list must not read as an empty list");

        assert!(
            matches!(error, ServerStoreError::Unreadable { .. }),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn newer_document_version_refuses_instead_of_dropping_unknown_entries() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("servers.json");
        fs::write(&path, br#"{"version":99,"servers":[]}"#).expect("seed future document");

        let error = load(&path).expect_err("a future document must be refused");

        assert!(
            matches!(
                error,
                ServerStoreError::UnsupportedVersion {
                    found: 99,
                    supported: STORE_VERSION
                }
            ),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn duplicate_ids_are_refused_on_read() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("servers.json");
        let document = ServerDocument {
            version: STORE_VERSION,
            servers: vec![entry("a"), entry("a")],
        };
        fs::write(&path, serde_json::to_vec(&document).expect("encode")).expect("seed");

        let error = load(&path).expect_err("duplicate ids must be refused");

        assert!(
            matches!(error, ServerStoreError::DuplicateId { .. }),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn upsert_replaces_by_id_and_survives_a_reload() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("servers.json");

        upsert(&path, entry("a")).expect("insert");
        let mut renamed = entry("a");
        renamed.label = "이름 바꾼 서버".to_string();
        upsert(&path, renamed.clone()).expect("replace");
        upsert(&path, entry("b")).expect("insert second");

        let reloaded = load(&path).expect("reload");

        assert_eq!(reloaded.servers, vec![renamed, entry("b")]);
    }

    #[test]
    fn remove_is_idempotent() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("servers.json");
        upsert(&path, entry("a")).expect("insert");

        remove(&path, "a").expect("first remove");
        let document = remove(&path, "a").expect("removing an absent id is not an error");

        assert!(document.servers.is_empty());
    }

    #[test]
    fn port_zero_is_refused_even_though_it_is_a_valid_u16() {
        let mut candidate = entry("a");
        candidate.port = 0;

        let error = candidate.validate().expect_err("port 0 must be refused");

        assert!(
            matches!(error, ServerStoreError::InvalidEntry { field: "port", .. }),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn a_blank_username_is_refused_because_the_relay_trust_chain_needs_it() {
        let mut candidate = entry("a");
        candidate.username = "   ".to_string();

        let error = candidate
            .validate()
            .expect_err("blank username must be refused");

        assert!(
            matches!(
                error,
                ServerStoreError::InvalidEntry {
                    field: "username",
                    ..
                }
            ),
            "unexpected error: {error:?}"
        );
    }

    /// 노트북이 이 기기를 취소하면 노트북이 준 서버는 열리지 않는 문이 된다 —
    /// 폰 혼자서는 되살릴 수 없으므로 남겨 두는 것은 실패를 보여 주는 목록일
    /// 뿐이다. 반대로 사람이 직접 적은 서버는 노트북이 준 적이 없으므로 노트북이
    /// 거둬 갈 것도 아니다.
    #[test]
    fn a_revoked_pairing_takes_its_own_servers_and_leaves_hand_entered_ones() {
        let mut document = ServerDocument {
            version: STORE_VERSION,
            servers: vec![paired_entry("from-laptop"), entry("typed-by-hand")],
        };

        let dropped = drop_paired(&mut document);

        assert_eq!(dropped, vec!["from-laptop"]);
        assert_eq!(
            document
                .servers
                .iter()
                .map(|server| server.id.as_str())
                .collect::<Vec<_>>(),
            vec!["typed-by-hand"]
        );
    }
}
