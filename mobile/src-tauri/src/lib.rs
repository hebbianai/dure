//! Dure mobile attach client.
//!
//! A Tauri 2 app so the hmux protocol client is *the same Rust code* the
//! desktop runs. A Swift/Kotlin client would be a second implementation of a
//! versioned protocol, and keeping two in lockstep is precisely the drift the
//! protocol-contract work exists to prevent.
//!
//! ## Why the long work runs on threads
//!
//! Tauri runs a non-`async` command on the main thread, and an SSH dial has a
//! 15-second budget. Both long commands here are `async` and hand the blocking
//! call to `spawn_blocking`, so a phone on a bad network gets a spinner rather
//! than a frozen UI.

pub mod attach;
pub mod catalog;
pub mod census;
pub mod device_identity;
pub mod device_key;
pub mod device_reset;
mod clipboard;
#[cfg(target_os = "ios")]
mod clipboard_ios;
pub mod hub_client;
pub mod hub_session_file;
pub mod hub_store;
mod hub_transport;
pub mod identity_store;
pub mod layout_store;
mod offline_pairing;
pub mod pairing;
pub mod push;
#[cfg(target_os = "ios")]
mod push_ios;
pub mod relay;
pub mod server_store;
pub mod source_control;
pub mod standalone;
mod terminal_attach;

use catalog::{CatalogEnum, DiscoveredSession, RemoteSession};
use census::{CensusTarget, ProbeOutcome, ServerReport};
use device_key::DeviceKeyError;
use hmux_client::TerminalSurfaceAccess;
use hmux_ssh_transport::session_resolution::{self, SessionResolution};
use identity_store::{IdentityStoreError, KeyRole};
use pairing::PairingError;
use rand::rngs::SysRng;
use rand_core::TryRng;
use relay::{RelayError, RelayTarget};
use serde::Serialize;
use server_store::{ServerDocument, ServerEntry, ServerStoreError};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use terminal_attach::{AttachedSession, LiveAttach};

/// Error shape crossing the command boundary.
///
/// The store errors are not `Serialize` on purpose — they carry `io::Error` —
/// so every projection into this type is an explicit decision about what the
/// webview is allowed to render.
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl From<ServerStoreError> for CommandError {
    fn from(error: ServerStoreError) -> Self {
        let code = match error {
            ServerStoreError::Unreadable { .. } => "server_store_unreadable",
            ServerStoreError::UnsupportedVersion { .. } => "server_store_unsupported_version",
            ServerStoreError::DuplicateId { .. } => "server_store_duplicate_id",
            ServerStoreError::InvalidEntry { .. } => "server_store_invalid_entry",
            ServerStoreError::Io { .. } => "server_store_io",
        };
        Self {
            code: code.to_string(),
            message: error.to_string(),
        }
    }
}

impl From<IdentityStoreError> for CommandError {
    fn from(error: IdentityStoreError) -> Self {
        let code = match error {
            IdentityStoreError::Missing { .. } => "identity_missing",
            IdentityStoreError::NotAPrivateKey => "identity_not_a_private_key",
            IdentityStoreError::Io { .. } => "identity_io",
        };
        Self {
            code: code.to_string(),
            message: error.to_string(),
        }
    }
}

impl From<RelayError> for CommandError {
    fn from(error: RelayError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
        }
    }
}

impl From<hmux_ssh_transport::CatalogError> for CommandError {
    fn from(error: hmux_ssh_transport::CatalogError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
        }
    }
}

impl From<PairingError> for CommandError {
    fn from(error: PairingError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
        }
    }
}

impl From<DeviceKeyError> for CommandError {
    fn from(error: DeviceKeyError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
        }
    }
}

impl From<device_reset::DeviceResetError> for CommandError {
    fn from(error: device_reset::DeviceResetError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
        }
    }
}

/// What this build of the client speaks, reported to the UI.
#[derive(Debug, Serialize)]
pub struct RuntimeInfo {
    /// From the protocol crate, not a hand-written string — the point of
    /// embedding hmux-client is that there is one source for this.
    pub protocol_major: u16,
    pub protocol_minor: u16,
    /// Capabilities this client refuses to request over a relay.
    pub withheld_over_relay: Vec<&'static str>,
    /// What this build still cannot do, for the standing notice.
    pub limitations: Vec<attach::LimitationReport>,
}

#[must_use]
pub fn runtime_info() -> RuntimeInfo {
    let version = hmux_host::local_protocol::PROTOCOL_V1;
    RuntimeInfo {
        protocol_major: version.major,
        protocol_minor: version.minor,
        withheld_over_relay: attach::WITHHELD_OVER_RELAY.to_vec(),
        // The conservative shape, because this is the build-level report and
        // no attach exists yet. A live attach carries its own authority in
        // `AttachedSession::role`, and that is what the session screen reads.
        limitations: attach::limitation_reports(false),
    }
}

/// A server row as the list screen needs it: the entry, plus whether keys
/// exist — never the key material itself.
#[derive(Debug, Serialize)]
pub struct ServerListing {
    pub version: u32,
    pub servers: Vec<ServerRow>,
}

#[derive(Debug, Serialize)]
pub struct ServerRow {
    #[serde(flatten)]
    pub entry: ServerEntry,
    pub has_attach_key: bool,
    pub has_list_key: bool,
}

fn config_root(app: &AppHandle) -> Result<PathBuf, CommandError> {
    app.path().app_config_dir().map_err(|error| CommandError {
        code: "app_config_dir_unavailable".to_string(),
        message: error.to_string(),
    })
}

fn store_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    Ok(config_root(app)?.join("servers.json"))
}

/// The keypair this install pairs with, minted on first use and kept until a
/// device reset takes the whole config directory with it.
fn pairing_identity(app: &AppHandle) -> Result<device_key::DeviceKeypair, CommandError> {
    let stored = identity_store::pairing_identity(&key_root(app)?, || {
        device_key::generate(device_key::DEVICE_KEY_COMMENT)
            .map(|minted| minted.private_openssh.to_string())
            .map_err(|error| identity_store::IdentityStoreError::Io {
                operation: "mint this device's pairing key",
                source: std::io::Error::other(error.to_string()),
            })
    })?;
    Ok(device_key::imported(&stored)?)
}

fn key_root(app: &AppHandle) -> Result<PathBuf, CommandError> {
    Ok(config_root(app)?.join("identities"))
}

/// 페어링한 허브 목록. SSH 서버 목록(`servers.json`)과 다른 파일이다 — 담는
/// 것도 전송도 다르고, 한쪽 형식이 바뀔 때 다른 쪽을 끌고 가지 않는다.
fn hub_store_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    Ok(config_root(app)?.join("hubs.json"))
}

/// 노트북 사이드바의 묶음을 기억하는 파일. 허브 목록(`hubs.json`)과 다른 파일인
/// 이유는 [`layout_store`] 머리말에 있다 — 저쪽은 기기 토큰을 담는다.
fn layout_store_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    Ok(config_root(app)?.join("layouts.json"))
}

impl From<hub_store::HubStoreError> for CommandError {
    fn from(error: hub_store::HubStoreError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
        }
    }
}

impl From<layout_store::LayoutStoreError> for CommandError {
    fn from(error: layout_store::LayoutStoreError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
        }
    }
}

fn listing(app: &AppHandle) -> Result<ServerListing, CommandError> {
    let document = server_store::load(&store_path(app)?)?;
    let keys = key_root(app)?;
    Ok(ServerListing {
        version: document.version,
        servers: document
            .servers
            .into_iter()
            .map(|entry| ServerRow {
                has_attach_key: identity_store::has_key(&keys, &entry.id, KeyRole::Attach),
                has_list_key: identity_store::has_key(&keys, &entry.id, KeyRole::List),
                entry,
            })
            .collect(),
    })
}

fn target_for(app: &AppHandle, server_id: &str) -> Result<(ServerEntry, PathBuf), CommandError> {
    let document: ServerDocument = server_store::load(&store_path(app)?)?;
    let entry = document
        .servers
        .into_iter()
        .find(|entry| entry.id == server_id)
        .ok_or_else(|| CommandError {
            code: "server_not_found".to_string(),
            message: format!("등록되지 않은 서버입니다: {server_id}"),
        })?;
    Ok((entry, key_root(app)?))
}

fn relay_target(entry: &ServerEntry) -> RelayTarget {
    RelayTarget {
        host: entry.host.clone(),
        port: entry.port,
        username: entry.username.clone(),
        host_key_fingerprint: entry.host_key_fingerprint.clone(),
    }
}

#[tauri::command]
fn list_servers(app: AppHandle) -> Result<ServerListing, CommandError> {
    listing(&app)
}

#[tauri::command]
fn save_server(app: AppHandle, entry: ServerEntry) -> Result<ServerListing, CommandError> {
    let generation = device_reset::current_generation();
    let _guard = device_reset::mutation_guard(generation)?;
    server_store::upsert(&store_path(&app)?, entry)?;
    listing(&app)
}

/// A host somebody typed in, before it is a [`ServerEntry`].
///
/// The host key is missing on purpose: it is not something a person knows, and
/// asking for it is why this screen used to have a field nobody could fill.
/// [`add_ssh_host`] reads it from the host instead.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostDraft {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub auth: SshHostAuth,
}

/// How the phone will get in, as the 인증 section offers it.
///
/// No `Debug`, here or on the draft that holds it: a password that can print
/// itself is how one reaches a log, and this crosses an async boundary.
#[derive(Default, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SshHostAuth {
    /// A key made here and left for the person to install. Nothing is proven
    /// beyond the address answering — see [`add_ssh_host`].
    #[default]
    Device,
    /// A key the person already has, chosen from the system file picker. The
    /// host knows it already, so this proves the whole way in.
    #[serde(rename_all = "camelCase")]
    Imported { private_key_pem: String },
    /// A password, for the one job of installing this phone's key. It is used
    /// once and never stored — see [`relay::RelayCredential`].
    Password { password: String },
}

/// What the phone knows once a typed-in host has been reached.
///
/// No public key rides along: the stored private key is the one authority for
/// it, and [`server_public_key`] reads it back from there whenever a screen
/// needs the line. Carrying a copy here would give the key two writers.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostAdded {
    pub listing: ServerListing,
}

/// Reads one private key the person chose in the system file picker.
///
/// # Why the path comes from the picker and the read happens here
///
/// The picker is the grant: iOS hands this process one file because a person
/// pointed at it, and nothing else on the device becomes readable. Reading it
/// in Rust rather than through a filesystem plugin keeps it that way — there
/// is no path this command will open that a picker did not just return, and
/// the webview never gets a general "read a file" call.
///
/// The text is checked here for being a key at all, so a wrong file is refused
/// at the moment it is chosen rather than at the moment it fails to connect.
#[tauri::command]
async fn read_ssh_private_key(path: String) -> Result<String, CommandError> {
    let text = tauri::async_runtime::spawn_blocking(move || std::fs::read_to_string(&path))
        .await
        .map_err(|error| CommandError {
            code: "ssh_key_read_join_failed".to_string(),
            message: error.to_string(),
        })?
        .map_err(|error| CommandError {
            code: "ssh_key_unreadable".to_string(),
            message: format!("키 파일을 읽지 못했습니다: {error}"),
        })?;
    identity_store::validate_private_key(&text)?;
    Ok(text)
}

/// Adds a host by asking it who it is.
///
/// # What is proven, and what is not
///
/// The dial proves the address answers and pins the key it answered *with* —
/// nothing else, because the host key is checked before authentication and the
/// key this phone generates here is not in anybody's `authorized_keys` yet.
/// So this is the SSH client's own first-connection trust: whoever answers the
/// address at this moment is who the phone will talk to from now on, and a
/// later imposter is refused. It is entered by hand by the owner of both ends,
/// which is the one channel a pairing QR cannot cover.
#[tauri::command]
async fn add_ssh_host(app: AppHandle, draft: SshHostDraft) -> Result<SshHostAdded, CommandError> {
    let generation = device_reset::current_generation();
    let host = draft.host.trim().to_string();
    let username = draft.username.trim().to_string();
    let port = draft.port;

    // The key this host will see from now on. An imported one is the person's
    // own — already in that host's `authorized_keys`, which is what makes it
    // the one path here that proves the whole way in. The other two use a key
    // made here.
    let device = match &draft.auth {
        SshHostAuth::Imported { private_key_pem } => {
            identity_store::validate_private_key(private_key_pem)?;
            device_key::imported(private_key_pem)?
        }
        _ => device_key::generate(device_key::DEVICE_KEY_COMMENT)?,
    };

    // Learning the host's key comes first whichever way this goes: it happens
    // before authentication, so it is the one step a password and a key agree
    // on — and it is what makes the install below safe to send a password over.
    let dial = match &draft.auth {
        SshHostAuth::Password { password } => relay::RelayCredential::Password(password.clone()),
        _ => relay::RelayCredential::PrivateKey {
            openssh_pem: device.private_openssh.to_string(),
            passphrase: None,
        },
    };
    let probe_host = host.clone();
    let probe_username = username.clone();
    let fingerprint = tauri::async_runtime::spawn_blocking(move || {
        relay::learn_host_key(&probe_host, port, &probe_username, dial)
    })
    .await
    .map_err(|error| CommandError {
        code: "ssh_host_probe_join_failed".to_string(),
        message: error.to_string(),
    })??;

    // Now that the key is pinned, the password has somewhere safe to go — and
    // exactly one place to go. After this it is dropped and the entry carries
    // the key instead.
    if let SshHostAuth::Password { password } = draft.auth {
        let target = relay::RelayTarget {
            host: host.clone(),
            port,
            username: username.clone(),
            host_key_fingerprint: fingerprint.clone(),
        };
        let line = device.public_openssh.clone();
        tauri::async_runtime::spawn_blocking(move || {
            relay::install_authorized_key(&target, password, &line)
        })
        .await
        .map_err(|error| CommandError {
            code: "ssh_host_install_join_failed".to_string(),
            message: error.to_string(),
        })??;
    }

    let entry = ServerEntry {
        id: draft.id,
        label: draft.label.trim().to_string(),
        host,
        port,
        username,
        host_key_fingerprint: fingerprint,
        // Not paired: no laptop vouched for this one, and the confinement note
        // must not claim a forced command nobody installed.
        paired: false,
        // A key nobody confined. `account_wide` would be a claim about a line
        // this phone never wrote; the empty value is what the detail screen
        // reads as "the laptop did not say", and no laptop was here.
        attach_key_confinement: server_store::KeyConfinement(String::new()),
    };
    let guard = device_reset::mutation_guard(generation)?;
    let keys = key_root(&app)?;
    // The attach slot only. This key is the only one the host will ever see
    // from this phone — listing and attaching are two `authorized_keys` lines
    // on a paired box and one typed-in line here — and `identity_store::load`
    // lists with the attach key when there is no list key. A second copy in
    // the list slot would be a key the SSH 키 screen neither shows nor
    // replaces, and the listing would keep dialing with it after a
    // replacement.
    identity_store::store(&keys, &entry.id, KeyRole::Attach, &device.private_openssh)?;
    server_store::upsert(&store_path(&app)?, entry)?;
    drop(guard);

    Ok(SshHostAdded {
        listing: listing(&app)?,
    })
}

fn forget_server(
    app: &AppHandle,
    id: &str,
    generation: device_reset::ConfigGeneration,
) -> Result<(), CommandError> {
    let _guard = device_reset::mutation_guard(generation)?;
    server_store::remove(&store_path(app)?, id)?;
    identity_store::forget(&key_root(app)?, id)?;
    Ok(())
}

#[tauri::command]
fn delete_server(app: AppHandle, id: String) -> Result<ServerListing, CommandError> {
    let generation = device_reset::current_generation();
    forget_server(&app, &id, generation)?;
    listing(&app)
}

/// The `authorized_keys` line a host must carry before this phone can attach.
///
/// Derived from the stored private key rather than kept beside it: the private
/// key is the one fact, and a stored copy of its public half could only ever
/// agree with it or lie. Attach is the role both a typed-in host and pairing
/// write, so it is the one every server has.
#[tauri::command]
fn server_public_key(app: AppHandle, id: String) -> Result<String, CommandError> {
    let pem = identity_store::load(&key_root(&app)?, &id, KeyRole::Attach)?;
    Ok(device_key::imported(&pem)?.public_openssh)
}

#[tauri::command]
async fn reset_device(app: AppHandle) -> Result<(), CommandError> {
    let root = config_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || device_reset::reset(&root))
        .await
        .map_err(|error| CommandError {
            code: "device_reset_join_failed".to_string(),
            message: error.to_string(),
        })??;
    Ok(())
}

#[tauri::command]
fn save_identity(
    app: AppHandle,
    server_id: String,
    role: String,
    private_key_pem: String,
) -> Result<ServerListing, CommandError> {
    let generation = device_reset::current_generation();
    let _guard = device_reset::mutation_guard(generation)?;
    let role = parse_role(&role)?;
    identity_store::store(&key_root(&app)?, &server_id, role, &private_key_pem)?;
    listing(&app)
}

fn parse_role(role: &str) -> Result<KeyRole, CommandError> {
    match role {
        "attach" => Ok(KeyRole::Attach),
        "list" => Ok(KeyRole::List),
        other => Err(CommandError {
            code: "identity_unknown_role".to_string(),
            message: format!("알 수 없는 키 용도입니다: {other}"),
        }),
    }
}

/// Asks a server which sessions it is running.
#[tauri::command]
async fn discover_sessions(
    app: AppHandle,
    server_id: String,
) -> Result<Vec<DiscoveredSession>, CommandError> {
    let (entry, keys) = target_for(&app, &server_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let key = identity_store::load(&keys, &entry.id, KeyRole::List)?;
        let config = relay::ssh_config(&relay_target(&entry), key, None, relay::gateway_command())?;
        let listing = relay::list_sessions(config)?;
        Ok(catalog::worth_listing(listing.sessions))
    })
    .await
    .map_err(|error| CommandError {
        code: "discover_join_failed".to_string(),
        message: error.to_string(),
    })?
}

fn discovered_resolution(
    result: SessionResolution<RemoteSession>,
) -> SessionResolution<DiscoveredSession> {
    match result {
        SessionResolution::Resolved { session } => SessionResolution::Resolved {
            session: DiscoveredSession::from(session),
        },
        SessionResolution::Pending => SessionResolution::Pending,
        SessionResolution::Unknown => SessionResolution::Unknown,
    }
}

#[tauri::command]
async fn resolve_session_successor(
    app: AppHandle,
    server_id: String,
    session: RemoteSession,
) -> Result<SessionResolution<DiscoveredSession>, CommandError> {
    let (entry, keys) = target_for(&app, &server_id)?;
    let source = session.fence().map_err(RelayError::Catalog)?;
    tauri::async_runtime::spawn_blocking(move || {
        let key = identity_store::load(&keys, &entry.id, KeyRole::Attach)?;
        let config = relay::ssh_config(&relay_target(&entry), key, None, relay::gateway_command())?;
        session_resolution::over_ssh(config, &source, relay::DEFAULT_LIST_BUDGET)
            .map(discovered_resolution)
            .map_err(CommandError::from)
    })
    .await
    .map_err(|error| CommandError {
        code: "session_resolution_join_failed".into(),
        message: error.to_string(),
    })?
}

#[tauri::command]
async fn resolve_hub_session_successor(
    app: AppHandle,
    hub_id: String,
    box_id: String,
    session: RemoteSession,
) -> Result<SessionResolution<DiscoveredSession>, CommandError> {
    let entry = hub_target(&app, &hub_id)?;
    let source = session.fence().map_err(RelayError::Catalog)?;
    tauri::async_runtime::spawn_blocking(move || {
        let relay = match (&entry.relay_endpoint, &entry.server_id) {
            (Some(endpoint), Some(server_id)) => Some((endpoint.as_str(), server_id.as_str())),
            _ => None,
        };
        hub_client::resolve_session_successor(
            &entry.endpoint,
            relay,
            &entry.fingerprint,
            &entry.token,
            &box_id,
            &source,
        )
        .map(discovered_resolution)
        .map_err(|error| CommandError {
            code: error.code().to_string(),
            message: error.to_string(),
        })
    })
    .await
    .map_err(|error| CommandError {
        code: "session_resolution_join_failed".into(),
        message: error.to_string(),
    })?
}

/// Asks **every** server, directly, and reports on every one of them.
///
/// This is the screen the goal is written in terms of: one list of sessions
/// across every machine, each labelled with the machine it lives on, built by
/// this device talking to those machines — no laptop in the path, no index, no
/// broker. See [`census`] for what the bounds are for.
#[tauri::command]
async fn take_session_census(app: AppHandle) -> Result<Vec<ServerReport>, CommandError> {
    let servers = server_store::load(&store_path(&app)?)?.servers;
    let keys = key_root(&app)?;
    let targets: Vec<CensusTarget> = servers
        .iter()
        .map(|entry| CensusTarget {
            server_id: entry.id.clone(),
            server_label: entry.label.clone(),
        })
        .collect();

    tauri::async_runtime::spawn_blocking(move || {
        census::take_census(
            &targets,
            census::MAX_PARALLEL_SERVERS,
            census::CENSUS_BUDGET,
            |target| {
                let Some(entry) = servers.iter().find(|entry| entry.id == target.server_id) else {
                    // Unreachable: the targets are built from this same list.
                    // Reported rather than panicked, because a panic inside a
                    // worker thread on a phone loses the whole census, and the
                    // one thing this module promises is that no server goes
                    // missing from the report.
                    return ProbeOutcome::NotConfigured {
                        code: "server_not_found".to_string(),
                        detail: target.server_label.clone(),
                    };
                };
                probe_server(&keys, entry)
            },
        )
    })
    .await
    .map_err(|error| CommandError {
        code: "census_join_failed".to_string(),
        message: error.to_string(),
    })
}

/// One server's listing, classified.
fn probe_server(keys: &std::path::Path, entry: &ServerEntry) -> ProbeOutcome {
    let key = match identity_store::load(keys, &entry.id, KeyRole::List) {
        Ok(key) => key,
        // A missing key is the phone's problem, not the server's, and it is
        // reported as such rather than as an unreachable box.
        Err(error) => {
            let projected = CommandError::from(error);
            return ProbeOutcome::NotConfigured {
                code: projected.code,
                detail: projected.message,
            };
        }
    };
    let listing = relay::ssh_config(&relay_target(entry), key, None, relay::gateway_command())
        .and_then(|config| relay::list_sessions_within(config, relay::DEFAULT_LIST_BUDGET));
    match listing {
        Ok(listing) => ProbeOutcome::Listed {
            sessions: catalog::worth_listing(listing.sessions),
            forced_command_applied: listing.forced_command_applied,
        },
        Err(error) => census::classify(&error),
    }
}

/// 스캔한 텍스트가 어느 페어링 흐름인지.
///
/// 화면이 코드 입력을 띄울지 정하는 데 쓴다. 여기서 열지 않는 이유: v2를 열려면
/// 코드가 필요하고, 코드를 묻기 전에 어느 흐름인지 알아야 한다.
#[tauri::command]
fn pairing_flow_for(scanned: String) -> &'static str {
    // 허브 QR 을 먼저 본다. 이름공간(`dure-hub:`)으로 판별하므로 판이 올라가도
    // 여기는 그대로다 — 판을 못 읽는 것은 `decode` 가 "앱이 낡았습니다" 로
    // 말한다. 여기서 판까지 보면 그 문장이 "SSH 페어링" 으로 잘못 갈린다.
    if dure_hub_protocol::offer::is_hub_offer(&scanned) {
        "hub"
    } else if offline_pairing::is_offline_payload(&scanned) {
        "offline"
    } else if is_web_link(&scanned) {
        // 노트북의 1단계는 **앱 설치 페이지**를 QR 로 그린다. 앱을 이미 깐
        // 사람이 그것을 이 스캐너에 대면, 여기서 갈리지 않는 한 SSH 해독기까지
        // 내려가 "hmux 페어링 코드가 아닙니다" 로 끝난다 — 맞는 말이지만
        // 무엇을 해야 하는지는 말하지 않는다(2026-09-04 사용자 보고).
        "link"
    } else {
        "online"
    }
}

/// 사람이 브라우저에 넣을 주소인지.
///
/// 스킴만 본다. 이 판단이 하는 일은 화면이 "이건 페어링 코드가 아니라 설치
/// 페이지" 라고 말할 수 있게 하는 것뿐이고, 그 문장은 주소가 정확히 무엇을
/// 가리키는지와 무관하게 맞다.
fn is_web_link(scanned: &str) -> bool {
    let text = scanned.trim();
    text.starts_with("https://") || text.starts_with("http://")
}

/// 사용자가 입력한 코드가 코드가 될 수 있는지, 64MiB 유도를 걸기 전에.
///
/// 정규화한 값을 돌려주므로 화면이 그것을 보여줄 수도 있다 — `k7f2-q0`을 치면
/// `K7F2Q0`이 되는 것을 눈으로 확인하는 편이, 왜 통과했는지 모르는 것보다 낫다.
#[tauri::command]
fn pairing_code_normalize(typed: String) -> Option<String> {
    offline_pairing::normalize_code(&typed)
}

/// 코드 길이. 화면이 입력 칸을 그린다.
#[tauri::command]
fn pairing_code_length() -> usize {
    offline_pairing::code_length()
}

/// v2 QR과 코드로 페어링을 끝낸다. 어떤 소켓도 열지 않는다.
///
/// `spawn_blocking`인 이유: Argon2id가 64MiB를 쓰며 0.2초쯤 돈다. 그 동안 UI
/// 스레드를 잡으면 사용자에게는 앱이 멈춘 것으로 보인다.
#[tauri::command]
async fn pair_offline(
    app: AppHandle,
    scanned: String,
    code: String,
) -> Result<PairingOutcome, CommandError> {
    let generation = device_reset::current_generation();
    // 유도를 걸기 전에 코드 모양을 본다. 아니면 오타 하나에 0.2초를 쓰고
    // "코드가 맞지 않습니다"를 받는데, 사용자는 코드를 다시 읽는 대신 QR을
    // 다시 스캔하게 된다.
    if offline_pairing::normalize_code(&code).is_none() {
        return Err(CommandError {
            code: "pair_code_malformed".to_string(),
            message: format!(
                "코드는 {}글자입니다 — 노트북 화면의 글자를 다시 확인하세요",
                offline_pairing::code_length()
            ),
        });
    }

    let keys = key_root(&app)?;
    let store = store_path(&app)?;
    let (plan, _seed) = tauri::async_runtime::spawn_blocking(move || {
        let _guard = device_reset::mutation_guard(generation)?;
        offline_pairing::complete(&scanned, &code, &keys, &store).map_err(|error| CommandError {
            code: offline_pairing_code(&error).to_string(),
            message: error.to_string(),
        })
    })
    .await
    .map_err(|error| CommandError {
        code: "pair_offline_join_failed".to_string(),
        message: error.to_string(),
    })??;

    let listing = listing(&app)?;
    let adopted_ids: Vec<String> = plan.adopt.iter().map(|entry| entry.id.clone()).collect();
    Ok(PairingOutcome {
        adopted: listing
            .servers
            .into_iter()
            .filter(|row| adopted_ids.contains(&row.entry.id))
            .collect(),
        refused: plan
            .refused
            .into_iter()
            .map(|host| RefusedHost {
                label: host.label,
                host: host.host,
                // v1 의 `RefusedHost` 에는 포트가 있는데 v2 에서 거부된 항목은
                // 포트가 못 믿을 값일 수 있다(0 인 것이 거부 이유일 수도 있다).
                // 0 을 넣고 화면은 이유 문장을 보여준다.
                port: 0,
                detail: host.detail,
            })
            .collect(),
        // v2 는 노트북이 기기 기록을 갖고 있고 폰은 그 id 를 받지 않는다.
        // `hmux pair revoke` 는 노트북에서 이름으로 고른다.
        device_id: String::new(),
        key_algorithm: device_key::DEVICE_KEY_ALGORITHM,
    })
}

/// 화면이 분기할 수 있는 안정된 코드.
///
/// "코드가 틀렸다"와 "이 QR 이 v2 가 아니다"는 사용자가 할 일이 다르다 — 전자는
/// 여섯 글자를 다시 읽는 것이고 후자는 노트북에서 다른 명령을 쓰는 것이다.
fn offline_pairing_code(error: &hmux_client::offline_pairing::OfflinePairingError) -> &'static str {
    use hmux_client::offline_pairing::OfflinePairingError as Error;
    match error {
        Error::NotThisScheme => "pair_not_offline_qr",
        Error::Malformed(_) => "pair_payload_malformed",
        Error::WrongCodeOrTampered => "pair_code_rejected",
        Error::MalformedContents(_) => "pair_contents_unusable",
    }
}

/// A server the laptop reported on that this device will not dial.
///
/// Reported, never omitted. A server that silently disappears reads exactly like
/// a server that does not exist, and the machine the owner came to the desk for
/// is the one that will have failed.
#[derive(Debug, Serialize)]
pub struct RefusedHost {
    pub label: String,
    pub host: String,
    pub port: u16,
    pub detail: String,
}

/// What one pairing produced.
#[derive(Debug, Serialize)]
pub struct PairingOutcome {
    /// The laptop's own record id for this device, which is what
    /// `hmux pair revoke` takes.
    pub device_id: String,
    /// The servers now in this device's own list, key installed.
    pub adopted: Vec<ServerRow>,
    /// Every server the laptop named and this device cannot use.
    pub refused: Vec<RefusedHost>,
    /// What the device key actually is, so the screen can say it plainly
    /// instead of implying an enclave.
    pub key_algorithm: &'static str,
}

/// A scanned hub QR read **without connecting**.
///
/// This is what the confirm screen (Figma 2865:77049) shows, and needing the
/// fingerprint *before* connecting is why this command exists at all:
/// [`hub_probe`] connects and then saves, so a confirm screen drawn from its
/// result would appear after the connection it is meant to authorise. On a path
/// with no certificate authority, the whole of trust starts at that one
/// comparison of two screens at the desk — a comparison that happens after the
/// connection protects nothing.
///
/// The token is not sent out. The screen has no use for it, and what never
/// leaves is always easier to take back than what does.
#[derive(Debug, Serialize)]
pub struct HubOfferPreview {
    pub box_label: String,
    pub endpoint: String,
    pub fingerprint: String,
    /// Whether the QR carried a relay address. Without one this phone only
    /// reaches the computer on the same network.
    pub relay_offered: bool,
}

#[tauri::command]
fn hub_preview(scanned: String) -> Result<HubOfferPreview, CommandError> {
    let offer = dure_hub_protocol::offer::decode(&scanned).map_err(|error| CommandError {
        code: "hub_offer".to_string(),
        message: error.to_string(),
    })?;
    Ok(HubOfferPreview {
        box_label: offer.box_label,
        endpoint: offer.endpoint,
        fingerprint: offer.fingerprint,
        relay_offered: offer.relay_endpoint.is_some(),
    })
}

/// 허브 QR 하나로 그 컴퓨터에 붙어 세션 목록을 받아 온다.
///
/// # 붙은 **뒤에** 저장한다
///
/// 순서가 요점이다. 스캔한 것을 먼저 저장하면 붙지도 않는 항목이 목록에 남고,
/// 사용자는 그 줄을 누를 때마다 같은 실패를 다시 겪는다. 한 번 저장된 뒤로는
/// [`hub_open`] 이 재스캔 없이 같은 길을 가고, [`hub_list`] 가 그 목록을 화면에
/// 준다.
#[tauri::command]
async fn hub_probe(
    app: AppHandle,
    scanned: String,
    device_label: String,
) -> Result<HubProbe, CommandError> {
    let generation = device_reset::current_generation();
    let offer = dure_hub_protocol::offer::decode(&scanned).map_err(|error| CommandError {
        code: "hub_offer".to_string(),
        message: error.to_string(),
    })?;
    let direct_pairing_payload = offer.direct_pairing_payload.clone();
    let saved = hub_store::HubEntry {
        // 지문이 항목의 신원이다. 주소는 네트워크마다 달라지므로 그것으로
        // 구별하면 같은 컴퓨터가 목록에 여러 줄로 쌓인다.
        id: offer.fingerprint.clone(),
        box_label: offer.box_label.clone(),
        endpoint: offer.endpoint.clone(),
        fingerprint: offer.fingerprint.clone(),
        token: offer.token.clone(),
        relay_endpoint: offer.relay_endpoint.clone(),
        server_id: offer.server_id.clone(),
    };

    // 붙는 것은 블로킹이다. 여기서 그대로 돌면 webview 가 그동안 멈춘다.
    let probed = tauri::async_runtime::spawn_blocking(move || {
        let relay = match (&offer.relay_endpoint, &offer.server_id) {
            (Some(endpoint), Some(server_id)) => Some((endpoint.as_str(), server_id.as_str())),
            _ => None,
        };
        hub_client::fetch_catalog(&offer.endpoint, relay, &offer.fingerprint, &offer.token).map(
            |(ack, catalog)| {
                // 릴레이 주소가 QR 에 있었는지. 없으면 이 폰은 같은 네트워크
                // 안에서만 이 컴퓨터에 닿는다.
                //
                // 신원은 지문이다. 위 `saved.id` 와 같은 값을 써야 화면이 방금
                // 저장된 줄을 목록에서 찾아낼 수 있다.
                describe(
                    &offer.fingerprint,
                    &offer.box_label,
                    offer.relay_endpoint.is_some(),
                    ack,
                    &catalog,
                )
            },
        )
    })
    .await
    .map_err(|error| CommandError {
        code: "hub_join".to_string(),
        message: error.to_string(),
    })?;

    let probe = probed.map_err(|error| CommandError {
        code: error.code().to_string(),
        message: error.to_string(),
    })?;

    // **붙고 나서 저장한다.** 순서가 반대면 붙지도 않는 항목이 목록에 남고,
    // 사용자는 그것을 눌러 볼 때마다 같은 실패를 다시 겪는다.
    {
        let _guard = device_reset::mutation_guard(generation)?;
        let path = hub_store_path(&app)?;
        let mut document = hub_store::load(&path)?;
        hub_store::upsert(&mut document, saved)?;
        hub_store::save(&path, &document)?;
    }

    let mut probe = remember_layout(&app, probe, generation);
    if let Some(payload) = direct_pairing_payload {
        let attempt = PairFromScanAttempt {
            scanned: payload,
            device_label,
            generation,
        };
        match pair_from_scan_attempt(app.clone(), attempt).await {
            Ok(outcome) => match forget_server(&app, "this-laptop", generation) {
                Ok(()) => probe.direct_pairing = Some(outcome),
                Err(error) => probe.direct_pairing_error = Some(error),
            },
            Err(error) => probe.direct_pairing_error = Some(error),
        }
    }
    Ok(probe)
}

/// 저장된 컴퓨터 하나로 다시 붙는다. 재스캔 없이.
#[tauri::command]
async fn hub_open(app: AppHandle, id: String) -> Result<HubProbe, CommandError> {
    let generation = device_reset::current_generation();
    let entry = hub_target(&app, &id)?;

    let probe = match tauri::async_runtime::spawn_blocking(move || connect_to(&entry))
        .await
        .map_err(|error| CommandError {
            code: "hub_join".to_string(),
            message: error.to_string(),
        })? {
        Ok(probe) => probe,
        Err(refusal) => {
            // 컴퓨터가 이 기기를 취소했다. 이것만은 네트워크 실패가 아니라
            // 답이다 — 저쪽은 이 기기를 모른다고 말했고, 그 말이 사실이면
            // 짝짓기가 준 것들은 전부 죽은 자물쇠다. 지우지 않으면 폰은 열리지
            // 않는 서버 목록을 계속 들고 있고, 사용자가 보는 것은 "지웠는데도
            // 남아 있는 화면" 이다.
            if refusal.code == hub_client::HubClientError::Refused.code() {
                forget_pairing_grant(&app, &id, generation)?;
            }
            return Err(refusal);
        }
    };

    Ok(remember_layout(&app, probe, generation))
}

/// 취소된 짝짓기가 이 기기에 남긴 것을 전부 버린다.
///
/// 버리는 것: 그 허브 항목, 짝짓기가 심어 준 서버들과 그 키, 그리고 이 설치의
/// 짝짓기 신원. 남는 것: 사람이 직접 적어 넣은 서버. 그것은 노트북이 준 적
/// 없으므로 노트북이 거둬 갈 것도 아니다.
///
/// 신원까지 버리는 이유는 다음 짝짓기 때문이다. 노트북은 지문으로 한 폰을
/// 알아보고 그 지문의 기록을 모두 거둔 참이므로, 같은 키로 다시 짝지으면 방금
/// 지운 신원이 되살아난다. 새 키로 시작하는 것이 "기기 초기화한 폰" 과 같은
/// 상태다.
fn forget_pairing_grant(
    app: &AppHandle,
    hub_id: &str,
    generation: device_reset::ConfigGeneration,
) -> Result<(), CommandError> {
    let _guard = device_reset::mutation_guard(generation)?;
    let keys = key_root(app)?;

    let path = store_path(app)?;
    let mut document = server_store::load(&path)?;
    let granted = server_store::drop_paired(&mut document);
    server_store::save(&path, &document)?;
    for id in &granted {
        identity_store::forget(&keys, id)?;
    }

    let hubs = hub_store_path(app)?;
    let mut stored = hub_store::load(&hubs)?;
    if hub_store::remove(&mut stored, hub_id) {
        hub_store::save(&hubs, &stored)?;
    }

    identity_store::forget_pairing_identity(&keys)?;
    Ok(())
}

/// 세션 하나의 변경 목록. 화면이 그대로 그린다.
#[derive(Debug, Serialize)]
pub struct SourceControlOutcome {
    /// 읽어냈는가. 거짓이면 `files` 는 비어 있고 `detail` 이 이유를 말한다 —
    /// 깨끗한 저장소(빈 목록, 참)와 갈라 두어야 한다.
    pub read: bool,
    /// 노트북이 그 순간 읽은 브랜치. 배치표의 캐시보다 이쪽이 우선이다.
    pub branch: Option<String>,
    pub files: Vec<SourceControlOutcomeFile>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub base_ref: Option<String>,
    pub detail: Option<String>,
    /// 파일 목록을 무엇과 비교한 것인가 — `merge_base` 또는 `head`.
    ///
    /// 위의 앞뒤 수는 **다른 질문**(브랜치의 upstream)에 답한다. 한 화면이 그
    /// 둘을 같은 것처럼 그리면 사용자는 40개 앞선 브랜치를 2개 앞섰다고 읽는다.
    pub comparison: Option<String>,
    /// 저장소 뿌리. 세션 디렉토리보다 위일 수 있다.
    pub root: Option<String>,
    /// 화면이 문장이 아니라 상태로 갈라야 하는 거절의 코드. 특히
    /// `unsupported_protocol_version` — 그건 그 상자의 hmux를 갱신하라는 뜻이다.
    pub code: Option<String>,
    /// 파일 목록을 실제로 물어봤나. 커밋 탭과 PR 탭의 답은 파일을 싣지
    /// 않으므로, 그 빈 목록을 "깨끗하다" 로 읽으면 브랜치 카드가 더러운
    /// 워크트리 위에 "0 changed" 라고 쓴다.
    pub files_read: bool,
    /// 리뷰를 부탁할 만한 사람들. 리뷰어 시트가 물었을 때만 채워진다.
    pub reviewers: Vec<SourceControlReviewer>,
    /// 사람 목록을 실제로 물어봤나. 빈 목록("함께 커밋한 사람이 없다")과
    /// 못 물어본 것을 가른다.
    pub reviewers_read: bool,
    /// 커밋 하나의 메시지 본문. 커밋 상세가 물었을 때만, 본문이 있을 때만 온다.
    pub commit_body: Option<String>,
    /// 이 저장소의 브랜치들. 전환 시트가 물었을 때만 채워진다.
    pub branches: Vec<SourceControlBranch>,
    /// 브랜치를 실제로 물어봤나. `commits_read` 와 같은 이유로 따로 있다.
    pub branches_read: bool,
    /// 기준 브랜치 이후의 커밋들. 커밋 탭이 물었을 때만 채워진다.
    pub commits: Vec<SourceControlCommit>,
    /// 커밋을 실제로 물어봤나. `commits` 가 비어 있어도 참이면 "기준 브랜치
    /// 이후 커밋이 없다" 는 뜻이고, 거짓이면 "못 물어봤다" 는 뜻이다.
    ///
    /// `review_read` 와 같은 이유로 따로 있다 — 빈 목록 하나로 두 사실을
    /// 나르면 base 에 그대로 앉은 워크트리가 "아직 안 보냅니다" 로 보인다.
    pub commits_read: bool,
    /// 이 브랜치에 열린 리뷰. Pull Request 탭이 물었을 때만 본다.
    pub review: Option<SourceControlReview>,
    /// 리뷰를 실제로 물어봤나. `review` 가 없어도 참이면 "아직 없다" 는 뜻이고,
    /// 거짓이면 "못 물어봤다" 는 뜻이다 — 화면이 갈라 그려야 하는 두 사실이다.
    pub review_read: bool,
}

/// 이 브랜치에 열린 리뷰.
#[derive(Debug, Serialize)]
pub struct SourceControlReview {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub is_draft: bool,
    pub base_ref: String,
    /// 리뷰가 요청된 사람들의 로그인. 팀은 여기 없다.
    pub requested_reviewers: Vec<String>,
    /// 호스트의 리뷰 판정. 아무도 아직 안 봤으면 빈 문자열이다.
    pub review_decision: String,
    /// 호스트의 체크 요약. 못 물어봤으면 없다 — "체크가 없다" 와 다른 사실이다.
    pub checks: Option<SourceControlChecks>,
}

/// 커밋 하나. 화면이 한 줄로 그린다.
#[derive(Debug, Serialize)]
pub struct SourceControlCommit {
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    pub when: String,
}

/// 파일 하나의 변경. 프로토콜 타입을 그대로 내보내지 않고 여기서 한 번 옮기는
/// 이유는 [`HubPlacement`] 와 같다 — 약속과 화면의 모양은 따로 움직인다.
#[derive(Debug, Serialize)]
pub struct SourceControlOutcomeFile {
    pub path: String,
    pub status: String,
    /// 옮겨진 파일의 원래 경로. `R`/`C` 가 아니면 없다.
    pub old_path: Option<String>,
    /// 이진 파일이면 없다. 0 이 아니다.
    pub added: Option<u32>,
    pub deleted: Option<u32>,
    /// 아직 커밋되지 않은 변경이 있나. `None` 은 거짓이 아니라 **안 물어봤다**
    /// 이다 — 목록은 기준 브랜치와의 비교라 이미 커밋된 파일도 들어 있다.
    pub uncommitted: Option<bool>,
}

/// 세션 하나가 무엇을 바꿔 놓았는지 노트북에 묻는다.
///
/// 다른 hub request와 같은 모양이다 — 블로킹 왕복을 다른 스레드에 두고, 노트북이
/// 거절한 것은 예외가 아니라 결과로 돌려준다. 화면이 닫혀 있어서 못 읽은 것과
/// 네트워크가 끊긴 것은 사용자에게 다른 조치를 뜻한다.
#[tauri::command]
async fn hub_git_status(
    app: AppHandle,
    id: String,
    session_id: String,
    want: Option<String>,
) -> Result<SourceControlOutcome, CommandError> {
    let entry = hub_target(&app, &id)?;
    let request = dure_hub_protocol::hello::HubRequest::GitStatus {
        session_id,
        // 모르는 값은 기본(변경 파일)이다. 화면이 새 탭을 배우기 전에 노트북이
        // 먼저 배우는 순서가 정상이라, 여기서 거절하면 그 순서가 막힌다.
        want: match want.as_deref() {
            Some("commits") => dure_hub_protocol::hello::GitStatusWant::Commits,
            Some("pull_request") => dure_hub_protocol::hello::GitStatusWant::PullRequest,
            Some("branches") => dure_hub_protocol::hello::GitStatusWant::Branches,
            Some("reviewers") => dure_hub_protocol::hello::GitStatusWant::Reviewers,
            _ => dure_hub_protocol::hello::GitStatusWant::Changes,
        },
    };

    // 붙는 것은 블로킹이다. 여기서 그대로 돌면 웹뷰가 그동안 멈춘다.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let relay = match (&entry.relay_endpoint, &entry.server_id) {
            (Some(endpoint), Some(server_id)) => Some((endpoint.as_str(), server_id.as_str())),
            _ => None,
        };
        hub_client::send_git_status(
            &entry.endpoint,
            relay,
            &entry.fingerprint,
            &entry.token,
            request,
        )
    })
    .await
    .map_err(|error| CommandError {
        code: "hub_join".to_string(),
        message: error.to_string(),
    })?
    .map_err(|error| CommandError {
        code: error.code().to_string(),
        message: error.to_string(),
    })?;

    Ok(hub_outcome(result))
}

/// 리뷰를 부탁할 수 있는 사람 하나.
#[derive(Debug, Serialize)]
pub struct SourceControlReviewer {
    pub login: String,
    /// 커밋이 들고 있는 이름. 없으면 화면이 로그인만 그린다.
    pub name: String,
}

/// 리뷰의 체크 요약. 시안의 "체크 2/2 통과".
#[derive(Debug, Serialize)]
pub struct SourceControlChecks {
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
}

/// 브랜치 하나. 전환 시트가 한 줄로 그린다.
#[derive(Debug, Serialize)]
pub struct SourceControlBranch {
    pub name: String,
    pub current: bool,
    /// 다른 워크트리가 쓰고 있으면 그 경로. git 이 두 번째 체크아웃을 거절한다.
    pub checked_out_at: Option<String>,
    pub when: Option<String>,
}

/// 허브가 돌려준 결과를 화면이 그리는 모양으로.
///
/// 읽기와 만들기가 같은 답을 받는다 — 리뷰를 연 뒤에도 화면이 알아야 하는
/// 것은 "지금 이 브랜치의 리뷰" 하나뿐이라, 두 명령이 같은 옮김을 쓴다.
fn hub_outcome(result: dure_hub_protocol::HubGitStatusResult) -> SourceControlOutcome {
    SourceControlOutcome {
        read: result.read,
        branch: result.branch,
        files: result
            .files
            .into_iter()
            .map(|file| SourceControlOutcomeFile {
                path: file.path,
                status: file.status,
                old_path: file.old_path,
                added: file.added,
                deleted: file.deleted,
                uncommitted: file.uncommitted,
            })
            .collect(),
        ahead: result.ahead,
        behind: result.behind,
        base_ref: result.base_ref,
        detail: result.detail,
        files_read: result.files_read,
        // 노트북은 merge-base 기준으로 목록을 만든다(`agent_diff_stat`).
        comparison: Some("merge_base".to_string()),
        root: None,
        commits: result
            .commits
            .into_iter()
            .map(|commit| SourceControlCommit {
                short_sha: commit.short_sha,
                subject: commit.subject,
                author: commit.author,
                when: commit.when,
            })
            .collect(),
        commits_read: result.commits_read,
        review: result.review.map(|review| SourceControlReview {
            number: review.number,
            title: review.title,
            state: review.state,
            url: review.url,
            is_draft: review.is_draft,
            base_ref: review.base_ref,
            requested_reviewers: review.requested_reviewers,
            review_decision: review.review_decision,
            checks: review.checks.map(|checks| SourceControlChecks {
                total: checks.total,
                passed: checks.passed,
                failed: checks.failed,
                pending: checks.pending,
            }),
        }),
        review_read: result.review_read,
        commit_body: result.commit_body,
        reviewers: result
            .reviewers
            .into_iter()
            .map(|reviewer| SourceControlReviewer {
                login: reviewer.login,
                name: reviewer.name,
            })
            .collect(),
        reviewers_read: result.reviewers_read,
        branches: result
            .branches
            .into_iter()
            .map(|branch| SourceControlBranch {
                name: branch.name,
                current: branch.current,
                checked_out_at: branch.checked_out_at,
                when: branch.when,
            })
            .collect(),
        branches_read: result.branches_read,
        // 거절의 종류. 화면이 문장이 아니라 이 값으로 분기한다 — 특히
        // `session_elsewhere` 는 포기가 아니라 "그 상자에 직접 물어라" 다.
        code: result.code,
    }
}

/// 이 브랜치에 리뷰를 열어 달라고 노트북에 부탁한다.
///
/// 폰이 일으키는 유일한 **바깥으로 나가는** 일이다. 값 셋만 보내고, 저장소와
/// 브랜치와 argv 는 전부 노트북이 정한다.
#[tauri::command]
async fn hub_create_pull_request(
    app: AppHandle,
    id: String,
    session_id: String,
    title: String,
    body: String,
    draft: bool,
) -> Result<SourceControlOutcome, CommandError> {
    let entry = hub_target(&app, &id)?;
    let request = dure_hub_protocol::hello::HubRequest::CreatePullRequest {
        session_id,
        title,
        body,
        draft,
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let relay = match (&entry.relay_endpoint, &entry.server_id) {
            (Some(endpoint), Some(server_id)) => Some((endpoint.as_str(), server_id.as_str())),
            _ => None,
        };
        hub_client::send_git_status(
            &entry.endpoint,
            relay,
            &entry.fingerprint,
            &entry.token,
            request,
        )
    })
    .await
    .map_err(|error| CommandError {
        code: "hub_create_pull_request".to_string(),
        message: error.to_string(),
    })?
    .map_err(|error| CommandError {
        code: error.code().to_string(),
        message: error.to_string(),
    })?;
    Ok(hub_outcome(result))
}

/// The phone consumes the same target capabilities as the Hub wire. Only the
/// version envelope is removed here; copying every field loses new capabilities.
#[derive(Debug, Serialize)]
pub struct LaunchOfferOutcome {
    /// 노트북 화면이 이 표를 한 번이라도 내려보냈는가.
    ///
    /// 빈 목록과 갈라 두는 이유: 방금 켜진 노트북과 폴더가 하나도 없는 노트북은
    /// 사람이 할 일이 다르다. 전자는 기다리면 되고, 후자는 노트북에서 폴더를
    /// 등록해야 한다.
    pub published: bool,
    pub targets: Vec<dure_hub_protocol::launch_offer::LaunchTarget>,
    pub kinds: Vec<dure_hub_protocol::launch_offer::AgentKind>,
}

/// 띄우기의 결과.
#[derive(Debug, Serialize)]
pub struct StartAgentOutcome {
    pub started: bool,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    pub detail: Option<String>,
    pub code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FolderBrowserOutcome {
    pub ok: bool,
    pub path: Option<String>,
    pub entries: Vec<FolderBrowserEntry>,
    pub detail: Option<String>,
    pub code: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FolderBrowserEntry {
    pub name: String,
    pub path: String,
}

async fn folder_browser_request(
    app: AppHandle,
    id: String,
    request: dure_hub_protocol::hello::HubRequest,
) -> Result<FolderBrowserOutcome, CommandError> {
    let entry = hub_target(&app, &id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let relay = match (&entry.relay_endpoint, &entry.server_id) {
            (Some(endpoint), Some(server_id)) => Some((endpoint.as_str(), server_id.as_str())),
            _ => None,
        };
        hub_client::send_folder_browser(
            &entry.endpoint,
            relay,
            &entry.fingerprint,
            &entry.token,
            request,
        )
    })
    .await
    .map_err(|error| CommandError {
        code: "hub_join".to_string(),
        message: error.to_string(),
    })?
    .map_err(|error| CommandError {
        code: error.code().to_string(),
        message: error.to_string(),
    })?;
    Ok(FolderBrowserOutcome {
        ok: result.ok,
        path: result.path,
        entries: result
            .entries
            .into_iter()
            .map(|entry| FolderBrowserEntry {
                name: entry.name,
                path: entry.path,
            })
            .collect(),
        detail: result.detail,
        code: result.code,
    })
}

#[tauri::command]
async fn hub_browse_folder(
    app: AppHandle,
    id: String,
    path: Option<String>,
) -> Result<FolderBrowserOutcome, CommandError> {
    folder_browser_request(
        app,
        id,
        dure_hub_protocol::hello::HubRequest::BrowseFolder { path },
    )
    .await
}

#[tauri::command]
async fn hub_create_folder(
    app: AppHandle,
    id: String,
    parent: String,
    name: String,
) -> Result<FolderBrowserOutcome, CommandError> {
    folder_browser_request(
        app,
        id,
        dure_hub_protocol::hello::HubRequest::CreateFolder { parent, name },
    )
    .await
}

/// "새 에이전트" 폼이 열렸다. 무엇을 고를 수 있는지 노트북에 묻는다.
///
/// [`hub_git_status`] 와 같은 모양이다 — 블로킹 왕복을 다른 스레드에 두고,
/// 노트북이 거절한 것은 예외가 아니라 결과로 돌려준다.
#[tauri::command]
async fn hub_launch_offer(app: AppHandle, id: String) -> Result<LaunchOfferOutcome, CommandError> {
    let entry = hub_target(&app, &id)?;
    let offer = tauri::async_runtime::spawn_blocking(move || {
        let relay = match (&entry.relay_endpoint, &entry.server_id) {
            (Some(endpoint), Some(server_id)) => Some((endpoint.as_str(), server_id.as_str())),
            _ => None,
        };
        hub_client::send_launch_offer(&entry.endpoint, relay, &entry.fingerprint, &entry.token)
    })
    .await
    .map_err(|error| CommandError {
        code: "hub_join".to_string(),
        message: error.to_string(),
    })?
    .map_err(|error| CommandError {
        code: error.code().to_string(),
        message: error.to_string(),
    })?;

    Ok(LaunchOfferOutcome {
        published: offer.published,
        targets: offer.targets,
        kinds: offer.kinds,
    })
}

/// 에이전트를 하나 띄워 달라고 한다.
///
/// `action_id` 를 화면에서 받는 이유: 이 값은 **한 번의 누름**을 뜻하고, 누름은
/// 화면에서 일어난 사건이다. 여기서 지으면 화면이 재시도할 때마다 새 이름이
/// 붙어, 답을 못 받아 다시 물은 것과 사람이 한 번 더 누른 것이 같아진다 — 그
/// 순간 에이전트가 둘 뜬다.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartAgentInput {
    target_id: String,
    kind_id: String,
    action_id: String,
    use_worktree: bool,
    branch: Option<String>,
    folder_path: Option<String>,
}

#[tauri::command]
async fn hub_start_agent(
    app: AppHandle,
    id: String,
    input: StartAgentInput,
) -> Result<StartAgentOutcome, CommandError> {
    let entry = hub_target(&app, &id)?;
    let StartAgentInput {
        target_id,
        kind_id,
        action_id,
        use_worktree,
        branch,
        folder_path,
    } = input;
    // A blank means "not chosen", not an empty branch name.
    let branch = branch
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let request = match folder_path.filter(|path| !path.trim().is_empty()) {
        Some(folder_path) => dure_hub_protocol::hello::HubRequest::StartAgentInFolder {
            target_id,
            folder_path,
            kind_id,
            action_id,
            use_worktree,
            branch,
        },
        None => dure_hub_protocol::hello::HubRequest::StartAgent {
            target_id,
            kind_id,
            action_id,
            use_worktree,
            branch,
        },
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let relay = match (&entry.relay_endpoint, &entry.server_id) {
            (Some(endpoint), Some(server_id)) => Some((endpoint.as_str(), server_id.as_str())),
            _ => None,
        };
        hub_client::send_start_agent(
            &entry.endpoint,
            relay,
            &entry.fingerprint,
            &entry.token,
            request,
        )
    })
    .await
    .map_err(|error| CommandError {
        code: "hub_join".to_string(),
        message: error.to_string(),
    })?
    .map_err(|error| CommandError {
        code: error.code().to_string(),
        message: error.to_string(),
    })?;

    Ok(StartAgentOutcome {
        started: result.started,
        agent_id: result.agent_id,
        session_id: result.session_id,
        detail: result.detail,
        code: result.code,
    })
}

/// 세션 하나가 무엇을 바꿔 놓았는지 그 상자에 직접 묻는다.
///
/// [`hub_git_status`] 와 같은 질문에 대한 두 번째 답이다. 짝지은 노트북이 그
/// 세션을 아는 경우가 아니면 — SSH 로만 닿는 상자가 그렇다 — 물어볼 곳은 그
/// 상자 자신뿐이다. 페어링 키는 `command="…",restrict` 라 거기서 명령을 돌릴 수
/// 없고, 돌릴 수 있어서도 안 된다: 게이트웨이의 타입 있는 문서 하나로만 묻는다.
///
/// 거절은 예외가 아니라 결과다. 특히 그 상자의 `hmux` 가 이 질문을 모르는 경우가
/// 정상 경로에 있고, 그건 사용자가 할 일이 있는 상태(그 상자를 갱신)라
/// `code` 로 갈라 준다.
#[tauri::command]
async fn ssh_git_status(
    app: AppHandle,
    server_id: String,
    session_id: String,
    workspace_id: String,
    want: Option<String>,
) -> Result<SourceControlOutcome, CommandError> {
    let (entry, keys) = target_for(&app, &server_id)?;
    let request_id = format!("scm-{}", entry.id);
    // 모르는 낱말은 변경 탭이다. 화면이 새 탭을 붙이고 여기를 안 고치면 그
    // 탭은 다른 탭의 답을 그리게 되는데, 그건 빈 화면보다 나쁘다 — 하지만
    // 여기서 거절하면 낡은 화면이 아무것도 못 읽는다. 낱말은 닫힌 집합이라
    // 새 낱말은 이 표에 같이 들어온다.
    let want = match want.as_deref() {
        Some("commits") => source_control::Want::Commits,
        Some("pull_request") => source_control::Want::PullRequest,
        _ => source_control::Want::Changes,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let key = identity_store::load(&keys, &entry.id, KeyRole::List)?;
        let config = relay::ssh_config(&relay_target(&entry), key, None, relay::gateway_command())?;
        let answered = relay::source_control_status_within(
            config,
            &request_id,
            &session_id,
            &workspace_id,
            want,
            relay::DEFAULT_SOURCE_CONTROL_BUDGET,
        );
        Ok(source_control_outcome(answered))
    })
    .await
    .map_err(|error| CommandError {
        code: "ssh_git_status".to_string(),
        message: error.to_string(),
    })?
}

/// 한 번의 생성이 쓸 임의 토큰.
///
/// 시계나 카운터가 아니라 난수인 이유: 이 토큰에서 나온 `request_id` 와
/// `bridge_nonce` 가 영수증이 **이 요청의 것인지** 가르는 값이다. 예측 가능한
/// 값이면 같은 상자에서 동시에 만든 두 세션이 서로의 영수증을 받아들일 수 있고,
/// 그건 남의 세션에 붙는 길이 된다.
fn create_token() -> Result<String, CommandError> {
    let mut bytes = [0u8; 12];
    SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|error| CommandError {
            code: "create_token_unavailable".to_string(),
            message: format!("기기의 난수 생성기를 쓸 수 없습니다: {error}"),
        })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// 그 상자에서 방금 시작한 세션.
///
/// 실패도 결과다 — 가장 흔한 실패가 "이 키로는 만들 수 없다"이고, 그건 상자의
/// `authorized_keys`에서 사람이 켜야 하는 상태다. 그래서 `code`로 갈라 주고
/// 문장은 상자가 쓴 그대로 싣는다(어느 플래그를 켜야 하는지 그 문장이 말한다).
#[derive(Debug, Serialize)]
pub struct CreatedSessionOutcome {
    pub started: bool,
    /// 만들어진 세션. 화면은 이걸로 곧장 붙는다 — fence 요소가 다 들어 있다.
    pub session: Option<catalog::RemoteSession>,
    pub code: Option<String>,
    pub detail: Option<String>,
}

/// 이 상자에서 세션 하나를 시작한다.
///
/// # 왜 노트북 없이 되는가
///
/// 폰은 이 상자에 SSH로 직접 닿는다. 지금까지 시작만은 노트북을 거쳤는데, 그건
/// 게이트웨이가 강제 명령 키의 생성 요청을 거절했기 때문이다. 운영자가 그 줄에
/// `--allow-create`를 켜면 이 경로가 열린다. 켜지 않은 상자는 전과 같이
/// 거절하고, 그 문장이 무엇을 켜야 하는지 말한다.
///
/// `cwd`가 없으면 상자의 홈에서 시작한다 — 폰은 그 상자의 폴더 목록을 모르고,
/// 모르는 채로 경로를 지어내는 것보다 홈이 정직하다.
#[tauri::command]
async fn ssh_create_session(
    app: AppHandle,
    server_id: String,
    cwd: Option<String>,
) -> Result<CreatedSessionOutcome, CommandError> {
    let (entry, keys) = target_for(&app, &server_id)?;
    // 붙기와 같은 키다. 목록 키는 읽기 전용 자리라 생성에 쓰지 않는다.
    let ids = standalone::CreateIds::from_token(&create_token()?);
    tauri::async_runtime::spawn_blocking(move || {
        let key = identity_store::load(&keys, &entry.id, KeyRole::Attach)?;
        let config = relay::ssh_config(&relay_target(&entry), key, None, relay::gateway_command())?;
        let created = relay::create_session_within(
            config,
            &ids,
            cwd.as_deref(),
            relay::DEFAULT_CREATE_BUDGET,
        );
        Ok(match created {
            Ok(receipt) => CreatedSessionOutcome {
                started: true,
                session: Some(receipt.session),
                code: None,
                detail: None,
            },
            Err(error) => CreatedSessionOutcome {
                started: false,
                session: None,
                code: Some(error.code().to_string()),
                detail: Some(error.to_string()),
            },
        })
    })
    .await
    .map_err(|error| CommandError {
        code: "ssh_create_session".to_string(),
        message: error.to_string(),
    })?
}

/// 파일 하나의 패치. 화면이 그리는 모양으로.
#[derive(Debug, Serialize)]
pub struct FileDiffOutcome {
    /// 읽어냈는가. 실패했으면 `patch` 가 없고 `detail` 이 이유를 말한다.
    pub read: bool,
    /// 물어본 경로 그대로. 화면이 답과 줄을 맞춘다.
    pub path: String,
    /// 통합 diff 본문. 이진 파일이면 없다 — 빈 문자열이 아니다. 빈 본문은
    /// "이 파일에서 바뀐 게 없다" 라는 다른 답이다.
    pub patch: Option<String>,
    /// 본문이 상한에 걸려 잘렸나. 조용히 자르면 화면은 파일의 끝을 본 줄 안다.
    pub truncated: bool,
    /// 이진 파일인가. 참이면 본문이 없고, 그것은 실패가 아니다.
    pub binary: bool,
    pub added: Option<u32>,
    pub deleted: Option<u32>,
    /// 거절의 종류. 화면이 문장이 아니라 이 값으로 분기한다.
    pub code: Option<String>,
    pub detail: Option<String>,
}

impl FileDiffOutcome {
    fn refused(path: String, detail: String, code: Option<String>) -> Self {
        Self {
            read: false,
            path,
            patch: None,
            truncated: false,
            binary: false,
            added: None,
            deleted: None,
            code,
            detail: Some(detail),
        }
    }
}

/// 패치를 못 읽은 이유를 사람 말로.
///
/// 커밋·리뷰와 따로 두는 이유는 같다 — 같은 `timed_out` 이라도 사용자가 볼
/// 곳이 다르고, `path_not_listed` 는 아예 다른 조치(목록 새로고침)다.
fn file_diff_detail(reason: &str) -> String {
    match reason {
        "path_not_listed" => "그 파일은 이 비교에 더 이상 없습니다. 목록을 새로 고쳐 보세요",
        "commit_unreadable" => "그 상자가 읽을 수 있는 커밋 식별자가 아닙니다",
        "not_versioned" => "이 세션의 디렉토리는 저장소가 아닙니다",
        "directory_missing" => "그 세션의 디렉토리가 상자에 없습니다",
        "working_directory_unknown" => "그 상자가 이 세션의 디렉토리를 모릅니다",
        "host_unreachable" => "그 상자에서 이 세션이 답하지 않습니다",
        "reader_missing" => "그 상자에 git 이 없습니다",
        "timed_out" => "그 상자가 제한 시간 안에 패치를 읽지 못했습니다",
        "output_too_large" => "이 파일의 diff 가 너무 커서 그 상자가 보내지 못합니다",
        _ => "그 상자가 이 파일을 읽지 못했습니다",
    }
    .to_string()
}

/// 노트북이 돌려준 패치를 화면이 그리는 모양으로.
fn hub_file_diff_outcome(result: dure_hub_protocol::HubFileDiffResult) -> FileDiffOutcome {
    FileDiffOutcome {
        read: result.read,
        path: result.path,
        patch: result.patch,
        truncated: result.truncated,
        binary: result.binary,
        added: result.added,
        deleted: result.deleted,
        code: result.code,
        detail: result.detail,
    }
}

/// 한 번의 SSH 패치 왕복을 화면이 그리는 모양으로.
fn file_diff_outcome(
    path: String,
    answered: Result<source_control::FileDiffDocument, relay::RelayError>,
) -> FileDiffOutcome {
    let document = match answered {
        Ok(document) => document,
        Err(error) => {
            let code = error.code().to_string();
            return FileDiffOutcome::refused(path, error.to_string(), Some(code));
        }
    };
    match document.body {
        source_control::FileDiffBody::Read { patch, truncated } => FileDiffOutcome {
            read: true,
            path: document.path,
            patch: Some(patch),
            truncated,
            binary: false,
            added: document.added,
            deleted: document.deleted,
            code: None,
            detail: None,
        },
        source_control::FileDiffBody::Binary => FileDiffOutcome {
            read: true,
            path: document.path,
            patch: None,
            truncated: false,
            binary: true,
            added: None,
            deleted: None,
            code: None,
            detail: None,
        },
        source_control::FileDiffBody::Unavailable { reason } => FileDiffOutcome::refused(
            document.path,
            file_diff_detail(&reason),
            Some(format!("diff_{reason}")),
        ),
    }
}

/// 폰이 부탁할 수 있는 저장소 변경, 전부.
///
/// 약속의 갈래를 그대로 받지 않고 한 벌 더 쓴다 — 화면이 부르는 이름과 약속이
/// 부르는 이름은 따로 움직인다. 두 벌이 갈리면 `serde` 가 경계에서 거절하고,
/// 그것이 조용히 다른 일을 하는 것보다 낫다.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScmWriteAction {
    Commit { paths: Vec<String>, message: String },
    Discard { paths: Vec<String> },
    Checkout { branch: String },
    CreateBranch { name: String },
    Push,
}

impl ScmWriteAction {
    fn into_protocol(self) -> dure_hub_protocol::hello::SourceControlAction {
        use dure_hub_protocol::hello::SourceControlAction as Wire;
        match self {
            Self::Commit { paths, message } => Wire::Commit { paths, message },
            Self::Discard { paths } => Wire::Discard { paths },
            Self::Checkout { branch } => Wire::Checkout { branch },
            Self::CreateBranch { name } => Wire::CreateBranch { name },
            Self::Push => Wire::Push,
        }
    }
}

/// 이 리뷰의 리뷰어를 바꿔 달라고 노트북에 부탁한다.
///
/// `hub_scm_write` 와 나뉘어 있는 이유는 `hello.rs` 의 `SetReviewers` 에 있다 —
/// 저장소를 바꾸는 것과 코드 호스트에 부탁하는 것은 성공했을 때 화면이 해야
/// 하는 일이 다르다.
#[tauri::command]
async fn hub_set_reviewers(
    app: AppHandle,
    id: String,
    session_id: String,
    action_id: String,
    number: u64,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<SourceControlOutcome, CommandError> {
    let entry = hub_target(&app, &id)?;
    let request = dure_hub_protocol::hello::HubRequest::SetReviewers {
        session_id,
        action_id,
        number,
        add,
        remove,
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let relay = match (&entry.relay_endpoint, &entry.server_id) {
            (Some(endpoint), Some(server_id)) => Some((endpoint.as_str(), server_id.as_str())),
            _ => None,
        };
        hub_client::send_git_status(
            &entry.endpoint,
            relay,
            &entry.fingerprint,
            &entry.token,
            request,
        )
    })
    .await
    .map_err(|error| CommandError {
        code: "hub_set_reviewers".to_string(),
        message: error.to_string(),
    })?
    .map_err(|error| CommandError {
        code: error.code().to_string(),
        message: error.to_string(),
    })?;
    Ok(hub_outcome(result))
}

/// 커밋 하나가 무엇을 했는지 노트북에 묻는다.
///
/// 목록의 `want` 가 아니라 자기 요청인 이유는 `hello.rs` 의 `CommitDetail` 에
/// 있다 — 목록 요청의 모양이 "리비전을 이름 짓지 않는다" 는 약속이다.
#[tauri::command]
async fn hub_commit_detail(
    app: AppHandle,
    id: String,
    session_id: String,
    commit: String,
) -> Result<SourceControlOutcome, CommandError> {
    let entry = hub_target(&app, &id)?;
    let request = dure_hub_protocol::hello::HubRequest::CommitDetail { session_id, commit };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let relay = match (&entry.relay_endpoint, &entry.server_id) {
            (Some(endpoint), Some(server_id)) => Some((endpoint.as_str(), server_id.as_str())),
            _ => None,
        };
        hub_client::send_git_status(
            &entry.endpoint,
            relay,
            &entry.fingerprint,
            &entry.token,
            request,
        )
    })
    .await
    .map_err(|error| CommandError {
        code: "hub_commit_detail".to_string(),
        message: error.to_string(),
    })?
    .map_err(|error| CommandError {
        code: error.code().to_string(),
        message: error.to_string(),
    })?;
    Ok(hub_outcome(result))
}

/// 저장소를 바꿔 달라고 노트북에 부탁한다.
///
/// # 왜 SSH 짝은 없나
///
/// 폰이 상자에 직접 쓰는 길은 없고, 있어서도 안 된다. 페어링 키는
/// `command="…",restrict` 라 게이트웨이의 타입 있는 문서 하나로만 말할 수 있고,
/// 그 문서 어휘의 쓰기는 전부 forced command 에서 거절된다. 그래서 이 명령은
/// 짝지은 노트북이 그 세션을 아는 경우에만 존재한다.
///
/// 답은 바뀐 뒤의 변경 목록이다 — 읽기와 같은 문서라 화면이 한 번 더 묻지
/// 않는다.
#[tauri::command]
async fn hub_scm_write(
    app: AppHandle,
    id: String,
    session_id: String,
    action_id: String,
    action: ScmWriteAction,
) -> Result<SourceControlOutcome, CommandError> {
    let entry = hub_target(&app, &id)?;
    let request = dure_hub_protocol::hello::HubRequest::SourceControlWrite {
        session_id,
        action_id,
        action: action.into_protocol(),
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let relay = match (&entry.relay_endpoint, &entry.server_id) {
            (Some(endpoint), Some(server_id)) => Some((endpoint.as_str(), server_id.as_str())),
            _ => None,
        };
        hub_client::send_git_status(
            &entry.endpoint,
            relay,
            &entry.fingerprint,
            &entry.token,
            request,
        )
    })
    .await
    .map_err(|error| CommandError {
        code: "hub_scm_write".to_string(),
        message: error.to_string(),
    })?
    .map_err(|error| CommandError {
        code: error.code().to_string(),
        message: error.to_string(),
    })?;
    Ok(hub_outcome(result))
}

/// 파일 하나의 패치를 노트북에 묻는다.
///
/// [`hub_git_status`] 와 같은 왕복이다. 다른 것은 경로 하나가 실린다는 점이고,
/// 그것을 거르는 자리는 폰도 노트북 화면도 아닌 **저장소 옆**이다 — 답하는
/// 쪽이 자기 목록을 먼저 읽고, 그 목록에 없는 경로는 거절한다.
#[tauri::command]
async fn hub_file_diff(
    app: AppHandle,
    id: String,
    session_id: String,
    path: String,
    commit: Option<String>,
) -> Result<FileDiffOutcome, CommandError> {
    let entry = hub_target(&app, &id)?;
    let request = dure_hub_protocol::hello::HubRequest::FileDiff {
        session_id,
        path,
        commit,
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let relay = match (&entry.relay_endpoint, &entry.server_id) {
            (Some(endpoint), Some(server_id)) => Some((endpoint.as_str(), server_id.as_str())),
            _ => None,
        };
        hub_client::send_file_diff(
            &entry.endpoint,
            relay,
            &entry.fingerprint,
            &entry.token,
            request,
        )
    })
    .await
    .map_err(|error| CommandError {
        code: "hub_join".to_string(),
        message: error.to_string(),
    })?
    .map_err(|error| CommandError {
        code: error.code().to_string(),
        message: error.to_string(),
    })?;

    Ok(hub_file_diff_outcome(result))
}

/// 파일 하나의 패치를 그 상자에 직접 묻는다.
///
/// [`ssh_git_status`] 와 같은 이유로 존재한다 — 짝지은 노트북이 그 세션을
/// 모르면 물어볼 곳은 그 상자 자신뿐이다.
#[tauri::command]
async fn ssh_file_diff(
    app: AppHandle,
    server_id: String,
    session_id: String,
    workspace_id: String,
    path: String,
    commit: Option<String>,
) -> Result<FileDiffOutcome, CommandError> {
    let (entry, keys) = target_for(&app, &server_id)?;
    let request_id = format!("diff-{}", entry.id);
    let echo = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let key = identity_store::load(&keys, &entry.id, KeyRole::List)?;
        let config = relay::ssh_config(&relay_target(&entry), key, None, relay::gateway_command())?;
        let answered = relay::file_diff_within(
            config,
            &request_id,
            &session_id,
            &workspace_id,
            &path,
            commit.as_deref(),
            relay::DEFAULT_SOURCE_CONTROL_BUDGET,
        );
        Ok(file_diff_outcome(echo, answered))
    })
    .await
    .map_err(|error| CommandError {
        code: "ssh_file_diff".to_string(),
        message: error.to_string(),
    })?
}

/// 커밋을 못 읽은 이유를 사람 말로.
///
/// 변경 목록의 표와 따로 두는 이유는, 같은 `timed_out` 이라도 사용자가 볼 곳이
/// 다르기 때문이다 — 파일이 너무 많은 것과 커밋이 너무 많은 것은 다른 저장소
/// 상태다.
fn commits_detail(reason: &str) -> String {
    match reason {
        "not_versioned" => "이 세션의 디렉토리는 저장소가 아닙니다",
        "reader_missing" => "그 상자에 git 이 없습니다",
        "timed_out" => "그 상자가 제한 시간 안에 커밋을 읽지 못했습니다",
        "output_too_large" => "커밋이 너무 많아 그 상자가 읽기를 멈췄습니다",
        _ => "그 상자가 커밋을 읽지 못했습니다",
    }
    .to_string()
}

/// 리뷰를 못 읽은 이유를 사람 말로.
///
/// 셋은 서로 다른 곳으로 사람을 보낸다: 설치, 로그인, 그리고 "이 저장소는
/// 그 호스트에 없다". 하나로 접으면 로그인만 하면 되는 사람이 설치를 뒤진다.
fn review_detail(reason: &str) -> String {
    match reason {
        "reader_missing" => "그 상자에 gh 가 설치되어 있지 않습니다",
        "not_authenticated" => "그 상자의 gh 가 로그인되어 있지 않습니다",
        "not_hosted" => "그 상자의 이 저장소에는 리뷰를 물어볼 원격이 없습니다",
        "timed_out" => "그 상자가 제한 시간 안에 리뷰를 읽지 못했습니다",
        _ => "그 상자가 리뷰를 읽지 못했습니다",
    }
    .to_string()
}

/// 한 번의 SSH 왕복을 화면이 그리는 모양으로.
///
/// 실패는 던지지 않는다 — 기다리는 화면은 회색으로 남고, 사용자는 앱이 멈춘
/// 것으로 읽는다. 못 읽은 이유는 결과 안에 들어간다.
fn source_control_outcome(
    answered: Result<source_control::SourceControlDocument, relay::RelayError>,
) -> SourceControlOutcome {
    let refused = |detail: String, code: Option<String>| SourceControlOutcome {
        read: false,
        branch: None,
        files: Vec::new(),
        ahead: None,
        behind: None,
        base_ref: None,
        detail: Some(detail),
        comparison: None,
        root: None,
        code,
        files_read: false,
        commit_body: None,
        reviewers: Vec::new(),
        reviewers_read: false,
        branches: Vec::new(),
        branches_read: false,
        commits: Vec::new(),
        commits_read: false,
        review: None,
        review_read: false,
    };
    let document = match answered {
        Ok(document) => document,
        Err(error) => {
            let code = error.code().to_string();
            return refused(error.to_string(), Some(code));
        }
    };
    match document.body {
        source_control::SourceControlBody::Read(snapshot) => {
            // 세 상태를 두 값으로 접는다: `Some` 이면 물어봤다는 뜻이고, 그 안이
            // 비어 있으면 "없다" 는 답이다. 못 읽은 경우는 `None` 으로 접히고
            // 아래에서 이유가 붙은 거절이 된다.
            let commits = match &snapshot.commits {
                Some(source_control::SourceControlCommits::Read { commits, .. }) => Some(
                    commits
                        .iter()
                        .map(|commit| SourceControlCommit {
                            short_sha: commit.short_sha.clone(),
                            subject: commit.subject.clone(),
                            author: commit.author.clone(),
                            when: commit.when.clone(),
                        })
                        .collect::<Vec<_>>(),
                ),
                Some(source_control::SourceControlCommits::Unavailable { reason }) => {
                    return refused(commits_detail(reason), Some(format!("commits_{reason}")));
                }
                None => None,
            };
            let review = match &snapshot.review {
                Some(source_control::SourceControlReview::Open {
                    number,
                    title,
                    state,
                    url,
                    is_draft,
                    base_ref,
                }) => Some(Some(SourceControlReview {
                    number: *number,
                    title: title.clone(),
                    state: state.clone(),
                    url: url.clone(),
                    is_draft: *is_draft,
                    base_ref: base_ref.clone(),
                    // 상자의 게이트웨이는 체크도 리뷰어도 읽지 않는다.
                    requested_reviewers: Vec::new(),
                    review_decision: String::new(),
                    checks: None,
                })),
                // 물어봤고, 아직 없다. 만들기 버튼이 존재하는 상태다.
                Some(source_control::SourceControlReview::None) => Some(None),
                Some(source_control::SourceControlReview::Unavailable { reason }) => {
                    return refused(review_detail(reason), Some(format!("review_{reason}")));
                }
                None => None,
            };
            // 물어봤는가는 값이 아니라 `Option` 의 유무다. 값을 옮기기 전에 읽어
            // 둔다 — 옮기고 나면 그 사실은 사라진다.
            let commits_read = commits.is_some();
            let review_read = review.is_some();
            SourceControlOutcome {
                read: true,
                branch: snapshot.branch,
                ahead: snapshot.ahead,
                behind: snapshot.behind,
                base_ref: snapshot.base_ref,
                detail: None,
                comparison: Some(snapshot.comparison),
                root: Some(snapshot.root),
                code: None,
                // 상자가 무엇을 읽었는지 그대로 옮긴다. 물어보지 않은 탭은 `_read`
                // 가 거짓이고, 화면은 "없다" 가 아니라 그 사실을 말한다.
                files_read: snapshot.files_read,
                // 상자는 브랜치 목록을 답하지 않는다 — 그 목록으로 할 수 있는 일(전환)이
                // 그 경로에는 없기 때문이다. 안 물어봤다고 말하는 것이 맞다.
                commit_body: None,
                reviewers: Vec::new(),
                reviewers_read: false,
                branches: Vec::new(),
                branches_read: false,
                commits_read,
                commits: commits.unwrap_or_default(),
                review_read,
                review: review.flatten(),
                files: snapshot
                    .files
                    .into_iter()
                    .map(|file| SourceControlOutcomeFile {
                        path: file.path,
                        status: file.status,
                        old_path: file.old_path,
                        added: file.added,
                        deleted: file.deleted,
                        // 상자는 HEAD 대비 비교를 하지 않는다. 모른다고 말한다 —
                        // 어차피 쓰기는 이 경로로 갈 수 없다(페어링 키는 읽기 전용).
                        uncommitted: None,
                    })
                    .collect(),
            }
        }
        // 저장소가 아닌 디렉토리는 사실이다. 빈 목록으로 그리면 "바뀐 게 없다"
        // 가 되고, 그건 다른 말이다.
        source_control::SourceControlBody::NotVersioned => refused(
            "이 세션의 디렉토리는 저장소가 아닙니다".to_string(),
            Some("not_versioned".to_string()),
        ),
        source_control::SourceControlBody::Unavailable { reason } => refused(
            match reason.as_str() {
                "working_directory_unknown" => "그 상자가 이 세션의 디렉토리를 모릅니다",
                "host_unreachable" => "그 상자에서 이 세션이 응답하지 않습니다",
                "directory_missing" => "이 세션의 디렉토리가 그 상자에 없습니다",
                "reader_missing" => "그 상자에 git 이 없습니다",
                "timed_out" => "그 상자가 제한 시간 안에 읽지 못했습니다",
                "output_too_large" => "변경이 너무 많아 그 상자가 읽기를 멈췄습니다",
                _ => "그 상자가 변경 목록을 읽지 못했습니다",
            }
            .to_string(),
            Some(reason),
        ),
    }
}

fn hub_target(app: &AppHandle, id: &str) -> Result<hub_store::HubEntry, CommandError> {
    hub_store::load(&hub_store_path(app)?)?
        .hubs
        .into_iter()
        .find(|row| row.id == id)
        .ok_or_else(|| CommandError {
            code: "hub_unknown".to_string(),
            message: "저장된 컴퓨터가 아닙니다. 다시 스캔하세요".to_string(),
        })
}

/// 받은 묶음을 폰에 기억시키고, 그 결과를 결과 안에 적어 돌려준다.
///
/// # 왜 실패해도 오류가 아닌가
///
/// 이 시점에서 **연결은 이미 성공했다.** 돌려주는 결과 안에 방금 받은 묶음이
/// 그대로 들어 있으므로 지금 화면은 완전히 맞다. 여기서 오류를 던지면 화면은
/// "연결 실패" 를 말하고, 그건 사용자에게 하는 거짓말이다 — 실패한 것은 다음에
/// 노트북이 꺼져 있을 때를 위한 기억뿐이다.
///
/// 그렇다고 삼키지도 않는다. 삼키면 읽을 수 없게 된 파일 하나 때문에 오프라인
/// 묶음이 영영 죽어 있고 아무 데도 그 이유가 안 나온다. [`HubProbe::layout_note`]
/// 로 화면까지 올라간다.
fn remember_layout(
    app: &AppHandle,
    mut probe: HubProbe,
    generation: device_reset::ConfigGeneration,
) -> HubProbe {
    // 못 받았으면 아무것도 안 한다. 파일을 열지도 않는다 — `None` 은 "사이드바가
    // 비었다" 가 아니라 "화면이 아직 안 보냈다" 이고, 그 사실로는 기억을 바꿀
    // 것이 없다(`layout_store::remember` 머리말).
    let Some(layout) = probe.layout.clone() else {
        return probe;
    };
    let remembered = layout_store_path(app)
        .map_err(|error| error.message)
        .and_then(|path| {
            let _guard =
                device_reset::mutation_guard(generation).map_err(|error| error.to_string())?;
            let mut document =
                layout_store::load_or_reset(&path).map_err(|error| error.to_string())?;
            layout_store::remember(
                &mut document,
                &probe.id,
                Some(layout_store::HubLayout {
                    placements: layout
                        .placements
                        .into_iter()
                        .map(|(session_id, seat)| {
                            (
                                session_id,
                                layout_store::Placement {
                                    desktop: seat.desktop,
                                    project: seat.project,
                                    order: seat.order,
                                    branch: seat.branch,
                                },
                            )
                        })
                        .collect(),
                    desktop_order: layout.desktop_order,
                }),
            )
            .map_err(|error| error.to_string())?;
            layout_store::save(&path, &document).map_err(|error| error.to_string())
        });
    probe.layout_note = remembered.err();
    probe
}

/// 저장된 컴퓨터 목록. 토큰은 나가지 않는다.
#[tauri::command]
fn hub_list(app: AppHandle) -> Result<Vec<HubRow>, CommandError> {
    let document = hub_store::load(&hub_store_path(&app)?)?;
    Ok(document
        .hubs
        .into_iter()
        .map(|entry| HubRow {
            id: entry.id,
            box_label: entry.box_label,
            endpoint: entry.endpoint,
            relay_offered: entry.relay_endpoint.is_some(),
        })
        .collect())
}

/// 지운다. 지운 것이 있었으면 `true`.
///
/// 노트북 쪽 등록까지 지우지는 않는다 — 그건 노트북의 기기 목록에서 취소한다.
/// 여기서 지우는 것은 이 폰이 기억하고 있던 것뿐이다.
#[tauri::command]
fn hub_forget(app: AppHandle, id: String) -> Result<bool, CommandError> {
    let generation = device_reset::current_generation();
    let _guard = device_reset::mutation_guard(generation)?;
    let path = hub_store_path(&app)?;
    let mut document = hub_store::load(&path)?;
    let removed = hub_store::remove(&mut document, &id);
    if removed {
        hub_store::save(&path, &document)?;
        // 잊으라고 한 컴퓨터의 구조가 남아서 목록을 계속 묶으면 안 된다.
        //
        // 여기서 실패해도 오류가 아니다. 위에서 **이미 지웠고** 그것이 이 명령이
        // 하기로 한 일이다. 캐시 한 줄 때문에 실패를 돌려주면 화면은 "못
        // 지웠습니다" 를 말하고, 사용자는 이미 없는 것을 다시 지우려 한다.
        if let Ok(layouts) = layout_store_path(&app) {
            if let Ok(mut remembered) = layout_store::load_or_reset(&layouts) {
                if layout_store::forget(&mut remembered, &id) {
                    let _ = layout_store::save(&layouts, &remembered);
                }
            }
        }
    }
    Ok(removed)
}

/// 폰이 기억하고 있는 묶음 전체. 허브 id → 그 노트북의 사이드바 모양.
///
/// 노트북에 붙지 않고 읽는다. 그것이 이 명령이 있는 이유다 — 노트북이 꺼져 있어도
/// SSH 로 붙는 서버 세션은 살아 있고, 그 목록은 사용자가 만든 묶음대로 서야 한다.
#[tauri::command]
fn hub_layouts(app: AppHandle) -> Result<BTreeMap<String, HubLayout>, CommandError> {
    let document = layout_store::load_or_reset(&layout_store_path(&app)?)?;
    Ok(document
        .hubs
        .into_iter()
        .map(|(hub_id, layout)| {
            (
                hub_id,
                HubLayout {
                    placements: layout
                        .placements
                        .into_iter()
                        .map(|(session_id, seat)| {
                            (
                                session_id,
                                HubPlacement {
                                    desktop: seat.desktop,
                                    project: seat.project,
                                    order: seat.order,
                                    branch: seat.branch,
                                },
                            )
                        })
                        .collect(),
                    desktop_order: layout.desktop_order,
                },
            )
        })
        .collect())
}

/// 저장된 항목 하나로 붙어 목록을 받는다. [`hub_probe`] 와 같은 길이다.
fn connect_to(entry: &hub_store::HubEntry) -> Result<HubProbe, CommandError> {
    let relay = match (&entry.relay_endpoint, &entry.server_id) {
        (Some(endpoint), Some(server_id)) => Some((endpoint.as_str(), server_id.as_str())),
        _ => None,
    };
    hub_client::fetch_catalog(&entry.endpoint, relay, &entry.fingerprint, &entry.token)
        .map(|(ack, catalog)| {
            describe(
                &entry.id,
                &entry.box_label,
                entry.relay_endpoint.is_some(),
                ack,
                &catalog,
            )
        })
        .map_err(|error| CommandError {
            code: error.code().to_string(),
            message: error.to_string(),
        })
}

/// 붙은 결과 하나를 화면이 그릴 모양으로 옮긴다.
///
/// [`hub_probe`] 와 [`hub_open`] 이 **같은 함수**를 쓴다. 두 벌로 두면 목록에
/// 필드를 하나 더할 때 한쪽만 고치게 되고, 그 차이는 "스캔하면 보이는데 저장된
/// 것으로 열면 안 보인다" 라는 재현하기 나쁜 증상으로 나타난다 — 실제로 이 두
/// 함수는 그렇게 복제된 채로 한 세대를 보냈다.
fn describe(
    id: &str,
    box_label: &str,
    relay_offered: bool,
    ack: dure_hub_protocol::hello::HubHelloAck,
    catalog: &dure_hub_protocol::catalog::HubCatalog,
) -> HubProbe {
    HubProbe {
        id: id.to_string(),
        box_label: box_label.to_string(),
        device_label: ack.device_label,
        relay_offered,
        sessions: catalog
            .sessions
            .iter()
            .map(|entry| HubProbeSession {
                session: RemoteSession {
                    session_id: entry.session_id.clone(),
                    session_name: entry
                        .display_title
                        .clone()
                        .or_else(|| entry.session_name.clone()),
                    workspace_id: entry.workspace_id.clone(),
                    session_class: CatalogEnum(entry.session_class.clone()),
                    lifecycle: CatalogEnum(entry.lifecycle.clone()),
                    provider_id: entry.provider_id.clone(),
                    launch_program: entry.launch_program.clone(),
                    host_liveness: None,
                    runner_principal: entry.runner_principal.clone(),
                    runner_instance: entry.runner_instance.clone(),
                    channel_epoch: entry.channel_epoch.clone(),
                    host_instance_id: entry.host_instance_id.clone(),
                    terminal_epoch: entry.terminal_epoch.clone(),
                    capabilities: entry.capabilities.clone(),
                },
                // 뜻을 붙이는 곳은 한 군데다. SSH 경로가 `DiscoveredSession` 에서
                // 같은 상수를 쓰고, 두 목록이 같은 세션을 다르게 그리면 그건
                // 취향이 아니라 사실이 어긋난 것이다. 모르는 lifecycle 은 붙을 수
                // 없는 쪽으로 떨어진다 — 새 "terminating" 이 생겨도 열 수 있는
                // 것처럼 보이지 않는다.
                ready: entry.lifecycle == catalog::LIFECYCLE_READY,
                box_id: entry.box_id.clone(),
                box_label: entry.box_label.clone(),
                presentation: entry.presentation.clone(),
            })
            .collect(),
        // 사용자가 앱에서 만든 묶음 전체. 현재 카탈로그에 없는 세션의 자리도
        // 직접 SSH 경로가 복원할 수 있게 함께 들어 있다.
        layout: catalog.layout.clone().map(|layout| HubLayout {
            placements: layout
                .placements
                .into_iter()
                .map(|(session_id, seat)| {
                    (
                        session_id,
                        HubPlacement {
                            desktop: seat.desktop,
                            project: seat.project,
                            order: seat.order,
                            branch: seat.branch,
                        },
                    )
                })
                .collect(),
            desktop_order: layout.desktop_order,
        }),
        // 이 함수는 저장하지 않는다. 채우는 곳은 [`remember_layout`] 한 군데다.
        layout_note: None,
        direct_pairing: None,
        direct_pairing_error: None,
        // 대답하지 못한 상자를 숨기지 않는다 — 사라진 상자는 없는 상자로 읽히고,
        // 폰을 꺼낸 이유가 그 상자일 수 있다.
        unreachable: catalog
            .unreachable
            .iter()
            .map(|box_| format!("{}: {}", box_.box_label, box_.detail))
            .collect(),
    }
}

/// 목록 화면이 그리는 한 줄. **토큰도 지문도 나가지 않는다** — 화면이 쓸 일이
/// 없고, 나가지 않는 것이 나가는 것보다 언제나 되돌리기 쉽다.
#[derive(Debug, Serialize)]
pub struct HubRow {
    pub id: String,
    pub box_label: String,
    pub endpoint: String,
    pub relay_offered: bool,
}

/// 폰 화면이 그리는 것.
#[derive(Debug, Serialize)]
pub struct HubProbe {
    /// 이 결과가 어느 저장된 컴퓨터의 것인지. [`HubRow::id`] 와 같은 값이고,
    /// 곧 인증서 지문이다.
    ///
    /// 라벨이 아니라 이것을 돌려주는 이유: 스캔 직후 화면은 방금 저장된 줄을
    /// 목록에서 찾아 자기 신원으로 삼는데, 라벨로 찾으면 이름이 같은 컴퓨터
    /// 두 대에서 틀린 줄을 집는다. 그리고 그 상태는 "붙었는데 다른 기계가
    /// 열린다" 로 나타난다.
    pub id: String,
    pub box_label: String,
    /// 허브가 이 폰을 무엇으로 인식했는지. 화면이 스스로 기억한 값이 아니라
    /// 붙은 결과로 저쪽이 알려준 값이다.
    pub device_label: String,
    pub relay_offered: bool,
    pub sessions: Vec<HubProbeSession>,
    /// 사용자가 노트북 앱에서 만든 묶음. 화면이 아직 안 보냈으면 없다.
    ///
    /// `null` 과 빈 표는 다른 사실이다 — 앞은 "아직 못 받았다", 뒤는 "사이드바가
    /// 비었다". 화면이 그 둘을 같게 그리면 사용자는 자기가 정리한 것이 사라졌다고
    /// 읽는다.
    pub layout: Option<HubLayout>,
    /// 묶음을 폰에 기억시키지 못한 이유. 성공했으면 없다.
    ///
    /// 연결은 성공했고 위 `layout` 도 맞다 — 실패한 것은 **다음에 노트북이 꺼져
    /// 있을 때를 위한 기억**뿐이다. 그래서 오류가 아니라 쪽지다.
    pub layout_note: Option<String>,
    pub direct_pairing: Option<PairingOutcome>,
    pub direct_pairing_error: Option<CommandError>,
    pub unreachable: Vec<String>,
}

/// 세션 하나가 사이드바에서 앉아 있는 자리.
#[derive(Clone, Debug, Serialize)]
pub struct HubPlacement {
    pub desktop: String,
    pub project: String,
    pub order: u32,
    /// 그 세션이 올라앉은 git 브랜치. 노트북이 모르면 `None` — 화면은 그때
    /// 아무것도 그리지 않는다.
    pub branch: Option<String>,
}

/// 사이드바 묶음 전체.
///
/// 프로토콜 타입을 그대로 내보내지 않고 여기서 한 번 옮긴다. 프로토콜은 두 앱이
/// 맞춰 놓은 약속이고 이것은 이 앱 화면의 모양이라, 한쪽이 바뀔 때 다른 쪽이
/// 조용히 따라 바뀌면 안 된다 — [`HubProbeSession`] 이 같은 이유로 같은 모양이다.
#[derive(Clone, Debug, Serialize)]
pub struct HubLayout {
    /// hmux 세션 id → 자리. 이 허브가 나르지 않는 세션의 자리도 들어 있다.
    pub placements: std::collections::HashMap<String, HubPlacement>,
    pub desktop_order: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct HubProbeSession {
    pub presentation: Option<dure_hub_protocol::catalog::SessionPresentation>,
    #[serde(flatten)]
    pub session: RemoteSession,
    /// 붙일 수 있는지. `lifecycle` 문자열을 화면이 다시 해석하지 않는다는 뜻이고,
    /// 그 규칙은 SSH 경로의 [`catalog::DiscoveredSession`] 과 같다.
    pub ready: bool,
    pub box_id: String,
    pub box_label: String,
}

struct PairFromScanAttempt {
    scanned: String,
    device_label: String,
    generation: device_reset::ConfigGeneration,
}

/// Scans once, at the desk, and is done with the laptop.
///
/// The order is the security argument, and it is not interchangeable:
///
/// 1. parse and validate the code — an unpinnable fingerprint never becomes a
///    dial, and an expired QR never becomes a packet;
/// 2. generate the keypair **here**, so the private half exists only on this
///    device;
/// 3. exchange with the laptop, whose answer is refused unless it proves it
///    holds the pairing token;
/// 4. store the private key, then adopt the inventory.
///
/// Keys before servers, deliberately. A server row with no key is a row that
/// renders as "connect" and fails; a key with no server row is an unreferenced
/// file that the next successful pairing overwrites. If the process dies between
/// the two, the second is the state to be in.
///
/// **One keypair, not two.** An earlier draft generated an attach key and a
/// separate list key, because a forced command cannot append `--list`. The
/// landed `hmux pair` wire carries exactly one `public_key`
/// (`hmux_client::online_pairing::PairingRequest`) and writes exactly one
/// `authorized_keys` line, so a second keypair would be a private key on this
/// phone that no server has ever heard of — worse than the limitation it was
/// trying to work around. The key is stored under [`KeyRole::Attach`] and the
/// listing path reaches it through `identity_store::load`'s one-directional
/// fallback. The consequence is real and is in the report: under the forced
/// command that pairing installs, one key cannot serve both modes.
#[tauri::command]
async fn pair_from_scan(
    app: AppHandle,
    scanned: String,
    device_label: String,
) -> Result<PairingOutcome, CommandError> {
    pair_from_scan_attempt(
        app,
        PairFromScanAttempt {
            scanned,
            device_label,
            generation: device_reset::current_generation(),
        },
    )
    .await
}

async fn pair_from_scan_attempt(
    app: AppHandle,
    attempt: PairFromScanAttempt,
) -> Result<PairingOutcome, CommandError> {
    let PairFromScanAttempt {
        scanned,
        device_label,
        generation,
    } = attempt;
    let invitation = pairing::parse_invitation(&scanned)?;
    // Checked here rather than inside `enroll` so the clock stays an argument to
    // the pure function and a phone with a wrong clock produces a refusal that
    // names the expiry instead of a connection error that names the network.
    pairing::refuse_if_expired(&invitation, std::time::SystemTime::now())?;
    // The identity this install pairs with, not a new one per scan: the laptop
    // groups a phone's records by fingerprint, and a phone that mints a key per
    // pairing leaves one key behind on every server for each pairing it ever
    // did — keys its own "remove this phone" then cannot reach.
    let device = pairing_identity(&app)?;
    let public_key = device.public_openssh.clone();

    let answer = tauri::async_runtime::spawn_blocking(move || {
        pairing::enroll(&invitation, &device_label, &public_key)
    })
    .await
    .map_err(|error| CommandError {
        code: "pair_join_failed".to_string(),
        message: error.to_string(),
    })??;

    let keys = key_root(&app)?;
    let entries: Vec<ServerEntry> = answer.usable().map(pairing::to_entry).collect();
    let guard = device_reset::mutation_guard(generation)?;
    for entry in &entries {
        // The one device key, written once per server id. The laptop appended
        // the same public key to every `authorized_keys` it touched, so there is
        // one private key; it is stored per server anyway, because deleting one
        // server must not take away access to the others — which is exactly what
        // a single shared key file would do.
        identity_store::store(&keys, &entry.id, KeyRole::Attach, &device.private_openssh)?;
    }
    server_store::adopt(&store_path(&app)?, entries)?;
    drop(guard);

    let listing = listing(&app)?;
    let adopted_ids: Vec<&str> = answer.usable().map(|host| host.id.as_str()).collect();
    Ok(PairingOutcome {
        adopted: listing
            .servers
            .into_iter()
            .filter(|row| adopted_ids.contains(&row.entry.id.as_str()))
            .collect(),
        refused: answer
            .hosts
            .iter()
            .filter_map(|host| {
                host.refusal().map(|detail| RefusedHost {
                    label: if host.name.trim().is_empty() {
                        host.host.clone()
                    } else {
                        host.name.clone()
                    },
                    host: host.host.clone(),
                    port: host.port,
                    detail,
                })
            })
            .collect(),
        device_id: answer.device_id,
        key_algorithm: device_key::DEVICE_KEY_ALGORITHM,
    })
}

#[tauri::command]
async fn attach_session(
    app: AppHandle,
    state: tauri::State<'_, LiveAttach>,
    server_id: String,
    session: RemoteSession,
    writable: bool,
) -> Result<AttachedSession, CommandError> {
    let (entry, keys) = target_for(&app, &server_id)?;
    let request = state.begin_attach();

    let access = if writable {
        TerminalSurfaceAccess::Writer
    } else {
        TerminalSurfaceAccess::ReadOnly
    };
    let session_id = session.session_id.clone();
    let attaching = session.clone();
    let attachment = tauri::async_runtime::spawn_blocking(move || {
        let key = identity_store::load(&keys, &entry.id, KeyRole::Attach)?;
        let config = relay::ssh_config(&relay_target(&entry), key, None, relay::gateway_command())?;
        relay::open_terminal_surface(config, &attaching, access).map_err(CommandError::from)
    })
    .await
    .map_err(|error| CommandError {
        code: "attach_join_failed".to_string(),
        message: error.to_string(),
    })??;

    terminal_attach::activate_terminal_surface(&state, request, session_id, access, attachment)
}

#[tauri::command]
async fn attach_hub_session(
    app: AppHandle,
    state: tauri::State<'_, LiveAttach>,
    hub_id: String,
    box_id: String,
    session: RemoteSession,
    writable: bool,
) -> Result<AttachedSession, CommandError> {
    let entry = hub_target(&app, &hub_id)?;
    let request = state.begin_attach();

    let access = if writable {
        TerminalSurfaceAccess::Writer
    } else {
        TerminalSurfaceAccess::ReadOnly
    };
    let session_id = session.session_id.clone();
    let attaching = session.clone();
    let attachment = tauri::async_runtime::spawn_blocking(move || {
        let relay = match (&entry.relay_endpoint, &entry.server_id) {
            (Some(endpoint), Some(server_id)) => Some((endpoint.as_str(), server_id.as_str())),
            _ => None,
        };
        let (transport, interrupt) = hub_client::open_transport(
            &entry.endpoint,
            relay,
            &entry.fingerprint,
            &entry.token,
            writable,
            &box_id,
        )
        .map_err(|error| CommandError {
            code: error.code().to_string(),
            message: error.to_string(),
        })?;
        relay::open_relayed_terminal_surface(transport, interrupt, &attaching, access)
            .map_err(CommandError::from)
    })
    .await
    .map_err(|error| CommandError {
        code: "hub_attach_join_failed".to_string(),
        message: error.to_string(),
    })??;

    terminal_attach::activate_terminal_surface(&state, request, session_id, access, attachment)
}

#[tauri::command]
fn device_identity_status() -> device_identity::DeviceIdentityStatus {
    device_identity::status()
}

#[tauri::command]
fn client_runtime_info() -> RuntimeInfo {
    runtime_info()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().manage(LiveAttach::production());

    // The camera plugin exists on Android and iOS only — its crate is literally
    // `#![cfg(mobile)]`, so `init()` does not exist on a desktop build. The
    // desktop shell is what `cargo test` and `tauri build --debug` exercise
    // here, and it keeps working: `pair_from_scan` takes the scanned *text*, so
    // the same pairing path runs from the manual-entry field with no camera at
    // all. That is what makes the flow testable off a phone.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    // The system file picker. Unlike the camera it exists on every target, so
    // there is no `cfg` here — the desktop shell this repo tests on gets the
    // same one dialog.
    let builder = builder.plugin(tauri_plugin_dialog::init());
    // The system browser, for http(s) links: the help site, the feedback form
    // and hyperlinks a terminal prints. The `external-links` capability scopes
    // it to http/https only.
    let builder = builder.plugin(tauri_plugin_opener::init());
    // Clipboard writes for the device public key and selected terminal text.
    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    // Impact feedback on a gesture. Exists on every target — desktop is a no-op.
    let builder = builder.plugin(tauri_plugin_haptics::init());
    // OS notification permissions and local delivery on targets without APNs.
    let builder = builder.plugin(tauri_plugin_notification::init());
    // Face ID / fingerprint before an approval. Like the camera plugin, the
    // crate is `#![cfg(mobile)]`, so the desktop shell has no `init()`.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_biometric::init());

    builder
        .invoke_handler(tauri::generate_handler![
            list_servers,
            save_server,
            add_ssh_host,
            read_ssh_private_key,
            delete_server,
            server_public_key,
            reset_device,
            save_identity,
            discover_sessions,
            resolve_session_successor,
            resolve_hub_session_successor,
            take_session_census,
            pair_from_scan,
            hub_git_status,
            hub_launch_offer,
            hub_browse_folder,
            hub_create_folder,
            hub_start_agent,
            hub_create_pull_request,
            ssh_git_status,
            ssh_create_session,
            clipboard::read_terminal_clipboard,
            hub_file_diff,
            hub_session_file::hub_stage_session_file,
            push::sync_push_notifications,
            ssh_file_diff,
            hub_scm_write,
            hub_commit_detail,
            hub_set_reviewers,
            hub_preview,
            hub_probe,
            hub_open,
            hub_list,
            hub_forget,
            hub_layouts,
            pair_offline,
            pairing_flow_for,
            pairing_code_normalize,
            pairing_code_length,
            attach_session,
            attach_hub_session,
            terminal_attach::detach_session,
            terminal_attach::next_terminal_record,
            terminal_attach::send_terminal_record,
            device_identity_status,
            client_runtime_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dure mobile");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_info_reports_the_protocol_version_from_the_embedded_client() {
        let info = runtime_info();

        assert_eq!(info.protocol_major, 1);
        assert_eq!(info.withheld_over_relay.len(), 3);
    }

    /// The standing notice is the only thing between a working attach and a
    /// screen that reads as a finished remote terminal.
    #[test]
    fn runtime_info_carries_the_limitations_the_ui_must_show() {
        let info = runtime_info();

        assert!(!info.limitations.is_empty());
    }

    #[test]
    fn an_unknown_key_role_is_refused_rather_than_defaulted() {
        let error = parse_role("controller").expect_err("an unknown role must be refused");

        assert_eq!(error.code, "identity_unknown_role");
    }

    #[test]
    fn the_two_key_roles_parse() {
        assert_eq!(parse_role("attach").expect("attach"), KeyRole::Attach);
        assert_eq!(parse_role("list").expect("list"), KeyRole::List);
    }

    /// 노트북의 1단계 QR 은 설치 페이지 주소다. 그것을 SSH 해독기로 흘려보내면
    /// "hmux 페어링 코드가 아닙니다" 로 끝나고, 사용자는 무엇을 해야 하는지
    /// 모른다 — 그래서 주소는 주소로 갈린다.
    #[test]
    fn a_web_address_is_told_apart_from_a_pairing_code() {
        assert_eq!(
            pairing_flow_for("https://github.com/hebbianai/releases/latest".into()),
            "link"
        );
        assert_eq!(
            pairing_flow_for("  http://example.test/app ".into()),
            "link"
        );
    }

    /// 갈래는 페어링 코드를 하나도 가로채지 않는다.
    #[test]
    fn pairing_codes_keep_their_own_flows() {
        assert_eq!(pairing_flow_for("dure-hub:3?o=abc".into()), "hub");
        assert_eq!(
            pairing_flow_for("hmux-pair:1?a=192.168.0.12&p=47821".into()),
            "online"
        );
    }
}
