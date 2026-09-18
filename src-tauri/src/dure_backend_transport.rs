//! Bounded persistent client transport for standalone Dure backends.
//!
//! This module owns only profile selection, local socket/SSH process I/O, and
//! response correlation. Domain merge and retry policy stays in each web
//! client, while the daemonless CLI keeps its independent one-shot transport.

mod operation_capability;
mod route_authority;
mod ssh_references;
pub(crate) mod subscription;

use operation_capability::operation_capability;

use std::collections::{BTreeMap, BTreeSet};
use std::fs::OpenOptions;
use std::io::Read as _;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};

use dure_app::{is_durable_agent_observation, MAX_BACKEND_CAPABILITIES_V1};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, Semaphore};
use tokio::time::{timeout_at, Duration, Instant};

pub use route_authority::{DureBackendRouteAuthorityV1, DureBackendRouteV1};

const BACKEND_PROTOCOL_API: &str = "dure.backend-transport/v1";
const BACKEND_REQUEST_KIND: &str = "dure.backend.request";
const BACKEND_RESPONSE_KIND: &str = "dure.backend.response";
const BACKEND_ERROR_KIND: &str = "dure.backend.error";
const PERSISTENT_CAPABILITY: &str = "backend.connection.persistent";
const DURE_CONTROL_PLANE_GATEWAY: &str = "~/.local/bin/dure-control-plane";
const SSH_GATEWAY_CAPABILITY: &str = "backend.transport.ssh_gateway";
const SUBSCRIBE_CAPABILITY: &str = "agent_conversation.subscribe.v6";
const MAX_CATALOG_BYTES: u64 = 64 * 1024;
const MAX_PROFILES: usize = 32;
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_QUEUE_COUNT: usize = 32;
const MAX_QUEUE_KIB: usize = 2 * 1024;
// Keep the desktop reader aligned with cli/lib/backend-profiles.mjs, which is
// the canonical writer for local and remote backend profile deadlines.
// Recovery-class operations (rehost, credential switch, provider relaunch)
// get 180s at the control plane; the transport backstop sits just above so
// the backend's own deadline always fires first with its cleaner error.
const MAX_DEADLINE_MS: u64 = 190_000;
const MAX_CLOCK_SKEW_MS: i64 = 60_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendCatalog {
    schema_version: u16,
    kind: String,
    profiles: Vec<BackendProfile>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BackendProfile {
    id: String,
    #[serde(default)]
    default: bool,
    transport: ProfileTransport,
    auth: ProfileAuth,
    trust: ProfileTrust,
    expected: ExpectedBackend,
    #[serde(default = "default_deadline_ms")]
    deadline_ms: u64,
}

impl BackendProfile {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn deadline(&self) -> Duration {
        Duration::from_millis(self.deadline_ms)
    }

    pub(crate) fn same_profile_id(&self, other: &Self) -> bool {
        self.id == other.id
    }

    pub(crate) fn matches_reconcile_receipt(
        &self,
        profile_id: &str,
        transport_kind: &str,
        backend_id: &str,
        generation: &str,
    ) -> bool {
        self.id == profile_id
            && matches!(
                (&self.transport, transport_kind),
                (ProfileTransport::Local { .. }, "local")
            )
            && self.expected.backend_id == backend_id
            && self.expected.generation == generation
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ProfileTransport {
    Local {
        endpoint: ProfileEndpoint,
    },
    Ssh {
        host: String,
        port: u16,
        user: String,
        endpoint: ProfileEndpoint,
        #[serde(default = "default_true", rename = "batchMode")]
        batch_mode: bool,
        #[serde(
            default = "default_strict_host_key_checking",
            rename = "strictHostKeyChecking"
        )]
        strict_host_key_checking: String,
        #[serde(default, rename = "connectTimeoutMs")]
        connect_timeout_ms: Option<u64>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ProfileEndpoint {
    UnixSocket { path: PathBuf },
    WindowsNamedPipe { name: String },
    Tcp { host: String, port: u16 },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ProfileAuth {
    Peer,
    SshAgent,
    IdentityFile { reference: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ProfileTrust {
    LocalPeer,
    KnownHosts { reference: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedBackend {
    backend_id: String,
    generation: String,
    protocol: ProtocolRange,
    #[serde(deserialize_with = "sorted_capabilities")]
    capabilities: Vec<String>,
}

fn sorted_capabilities<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let mut capabilities = Vec::<String>::deserialize(deserializer)?;
    capabilities.sort();
    Ok(capabilities)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ProtocolRange {
    minimum: ProtocolVersion,
    maximum: ProtocolVersion,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ProtocolVersion {
    major: u16,
    minor: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
    path: PathBuf,
    digest: [u8; 32],
    device: u64,
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SshReferences {
    known_hosts_file: FileIdentity,
    identity_file: Option<FileIdentity>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SelectedProfile {
    profile: BackendProfile,
    ssh_references: Option<SshReferences>,
    catalog_profile_ids: BTreeSet<String>,
}

impl SelectedProfile {
    fn same_connection_identity(&self, other: &Self) -> bool {
        route_authority::authority_for(self) == route_authority::authority_for(other)
    }

    fn same_observation_target(&self, other: &Self) -> bool {
        self.profile.id == other.profile.id
            && self.profile.expected.backend_id == other.profile.expected.backend_id
            && match (&self.profile.transport, &other.profile.transport) {
                (ProfileTransport::Local { .. }, ProfileTransport::Local { .. }) => true,
                (
                    ProfileTransport::Ssh {
                        host: left_host,
                        port: left_port,
                        user: left_user,
                        ..
                    },
                    ProfileTransport::Ssh {
                        host: right_host,
                        port: right_port,
                        user: right_user,
                        ..
                    },
                ) => left_host == right_host && left_port == right_port && left_user == right_user,
                _ => false,
            }
    }
}

#[derive(Clone, Debug)]
struct RuntimeConfig {
    ssh_command: PathBuf,
    profile_selector_override: Option<String>,
    ssh_reference_profile_override: Option<String>,
    known_hosts_override: Option<PathBuf>,
    identity_override: Option<PathBuf>,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            ssh_command: PathBuf::from("ssh"),
            profile_selector_override: None,
            ssh_reference_profile_override: None,
            known_hosts_override: None,
            identity_override: None,
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_strict_host_key_checking() -> String {
    "yes".into()
}

fn default_deadline_ms() -> u64 {
    10_000
}

fn effective_connect_timeout_ms(profile: &BackendProfile) -> u64 {
    match &profile.transport {
        ProfileTransport::Ssh {
            connect_timeout_ms, ..
        } => connect_timeout_ms.unwrap_or_else(|| 5_000.min(profile.deadline_ms)),
        ProfileTransport::Local { .. } => profile.deadline_ms,
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DureBackendTransportError {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

impl DureBackendTransportError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    fn with_details(code: &str, message: &str, details: Option<Value>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DureBackendTransportResult {
    schema_version: u16,
    backend_id: String,
    backend_generation: String,
    route_authority: DureBackendRouteAuthorityV1,
    result: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireResponse {
    schema_version: u16,
    api_version: String,
    kind: String,
    request_id: String,
    backend: WireBackend,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<WireError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireBackend {
    id: String,
    generation: String,
    protocol: ProtocolVersion,
    capabilities: Vec<String>,
    observed_at_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireError {
    code: String,
    message: String,
    #[serde(default)]
    details: Option<Value>,
}

enum PersistentConnection {
    Local(BufReader<UnixStream>),
    Ssh {
        child: Box<Child>,
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
        materials: Option<ssh_references::PinnedSshReferences>,
    },
}

fn verify_local_backend_peer_uid(uid: u32) -> Result<(), DureBackendTransportError> {
    if uid == unsafe { libc::geteuid() } {
        Ok(())
    } else {
        Err(DureBackendTransportError::new(
            "backend_transport_peer_untrusted",
            "the local backend peer is not trusted",
        ))
    }
}

pub(crate) fn verify_local_backend_peer(
    stream: &UnixStream,
) -> Result<(), DureBackendTransportError> {
    let credentials = stream.peer_cred().map_err(|_| {
        DureBackendTransportError::new(
            "backend_transport_peer_untrusted",
            "the local backend peer is not trusted",
        )
    })?;
    verify_local_backend_peer_uid(credentials.uid())
}

struct CachedConnection {
    selected: SelectedProfile,
    connection: PersistentConnection,
}

pub struct DureBackendTransportState {
    queue_slots: Arc<Semaphore>,
    queue_bytes: Arc<Semaphore>,
    connections: StdMutex<BTreeMap<String, Arc<Mutex<Option<CachedConnection>>>>>,
    subscriptions: Arc<subscription::ActiveSubscriptions>,
    config: RuntimeConfig,
    recovery: crate::dure_backend_coordinator::ManagedBackendCoordinatorHandle,
}

impl Default for DureBackendTransportState {
    fn default() -> Self {
        Self {
            queue_slots: Arc::new(Semaphore::new(MAX_QUEUE_COUNT)),
            queue_bytes: Arc::new(Semaphore::new(MAX_QUEUE_KIB)),
            connections: StdMutex::new(BTreeMap::new()),
            subscriptions: Arc::new(subscription::ActiveSubscriptions::default()),
            config: RuntimeConfig::default(),
            recovery: crate::dure_backend_coordinator::ManagedBackendCoordinatorHandle::disabled(),
        }
    }
}

fn local_liveness_failure(
    selected: &SelectedProfile,
    error: &DureBackendTransportError,
) -> bool {
    matches!(&selected.profile.transport, ProfileTransport::Local { .. })
        && matches!(
            error.code.as_str(),
            "backend_transport_timeout"
                | "backend_transport_unavailable"
                | "backend_transport_eof"
        )
}

fn coordinator_error(
    error: crate::dure_backend_coordinator::BackendCoordinatorError,
) -> DureBackendTransportError {
    DureBackendTransportError::new(error.0, error.1)
}

fn queue_timeout(message: &str) -> DureBackendTransportError {
    DureBackendTransportError::new("backend_transport_queue_timeout", message)
}

fn queue_unavailable() -> DureBackendTransportError {
    DureBackendTransportError::new(
        "backend_transport_state_unavailable",
        "the backend request queue is unavailable",
    )
}

fn valid_profile_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && (bytes[bytes.len() - 1].is_ascii_lowercase() || bytes[bytes.len() - 1].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn valid_token(value: &str, maximum: usize) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= maximum
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_capability(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && (bytes[bytes.len() - 1].is_ascii_lowercase() || bytes[bytes.len() - 1].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn valid_ssh_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b':' | b'-'))
}

fn valid_ssh_user(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn validate_reference(reference: &str, prefix: &str) -> bool {
    reference.strip_prefix(prefix).is_some_and(valid_profile_id)
}

fn compare_version(left: &ProtocolVersion, right: &ProtocolVersion) -> std::cmp::Ordering {
    (left.major, left.minor).cmp(&(right.major, right.minor))
}

fn validate_profile(profile: &BackendProfile) -> Result<(), DureBackendTransportError> {
    let capabilities = profile
        .expected
        .capabilities
        .iter()
        .collect::<BTreeSet<_>>();
    if !valid_profile_id(&profile.id)
        || !valid_profile_id(&profile.expected.backend_id)
        || !valid_token(&profile.expected.generation, 128)
        || compare_version(
            &profile.expected.protocol.minimum,
            &profile.expected.protocol.maximum,
        )
        .is_gt()
        || profile.expected.capabilities.len() > MAX_BACKEND_CAPABILITIES_V1
        || capabilities.len() != profile.expected.capabilities.len()
        || profile
            .expected
            .capabilities
            .iter()
            .any(|capability| !valid_capability(capability))
        || profile.deadline_ms == 0
        || profile.deadline_ms > MAX_DEADLINE_MS
    {
        return Err(DureBackendTransportError::new(
            "backend_transport_profile_invalid",
            "the selected backend profile is invalid",
        ));
    }
    match (&profile.transport, &profile.auth, &profile.trust) {
        (
            ProfileTransport::Local {
                endpoint: ProfileEndpoint::UnixSocket { path },
            },
            ProfileAuth::Peer,
            ProfileTrust::LocalPeer,
        ) if path.is_absolute()
            && path.to_string_lossy().len() <= 1_024
            && !path.to_string_lossy().chars().any(char::is_control) =>
        {
            Ok(())
        }
        (
            ProfileTransport::Ssh {
                host,
                port,
                user,
                endpoint:
                    ProfileEndpoint::Tcp {
                        host: endpoint_host,
                        port: endpoint_port,
                    },
                batch_mode,
                strict_host_key_checking,
                connect_timeout_ms,
            },
            auth,
            ProfileTrust::KnownHosts { reference },
        ) if valid_ssh_host(host)
            && *port > 0
            && valid_ssh_user(user)
            && valid_ssh_host(endpoint_host)
            && *endpoint_port > 0
            && *batch_mode
            && strict_host_key_checking == "yes"
            && connect_timeout_ms
                .is_none_or(|timeout| timeout > 0 && timeout <= profile.deadline_ms)
            && validate_reference(reference, "known-hosts-profile:")
            && (matches!(auth, ProfileAuth::SshAgent)
                || matches!(auth, ProfileAuth::IdentityFile { reference } if validate_reference(reference, "credential-profile:"))) =>
        {
            Ok(())
        }
        (
            ProfileTransport::Ssh {
                host,
                port,
                user,
                endpoint: ProfileEndpoint::UnixSocket { path },
                batch_mode,
                strict_host_key_checking,
                connect_timeout_ms,
            },
            auth,
            ProfileTrust::KnownHosts { reference },
        ) if valid_ssh_host(host)
            && *port > 0
            && valid_ssh_user(user)
            && path.is_absolute()
            && path.to_string_lossy().len() <= 1_024
            && !path.to_string_lossy().chars().any(char::is_control)
            && profile
                .expected
                .capabilities
                .iter()
                .any(|capability| capability == SSH_GATEWAY_CAPABILITY)
            && *batch_mode
            && strict_host_key_checking == "yes"
            && connect_timeout_ms
                .is_none_or(|timeout| timeout > 0 && timeout <= profile.deadline_ms)
            && validate_reference(reference, "known-hosts-profile:")
            && (matches!(auth, ProfileAuth::SshAgent)
                || matches!(auth, ProfileAuth::IdentityFile { reference } if validate_reference(reference, "credential-profile:"))) =>
        {
            Ok(())
        }
        _ => Err(DureBackendTransportError::new(
            "backend_transport_profile_invalid",
            "the selected backend profile is invalid",
        )),
    }
}

fn read_owner_file(path: &Path) -> Result<Vec<u8>, DureBackendTransportError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| {
            DureBackendTransportError::new(
                "backend_transport_profile_unavailable",
                "the backend profile catalog is unavailable",
            )
        })?;
    let before = file.metadata().map_err(|_| {
        DureBackendTransportError::new(
            "backend_transport_profile_unavailable",
            "the backend profile catalog metadata is unavailable",
        )
    })?;
    if !before.is_file()
        || before.uid() != unsafe { libc::geteuid() }
        || before.mode() & 0o077 != 0
        || before.len() == 0
        || before.len() > MAX_CATALOG_BYTES
    {
        return Err(DureBackendTransportError::new(
            "backend_transport_profile_untrusted",
            "the backend profile catalog is not an owner-only regular file",
        ));
    }
    let mut source = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(MAX_CATALOG_BYTES + 1)
        .read_to_end(&mut source)
        .map_err(|_| {
            DureBackendTransportError::new(
                "backend_transport_profile_unavailable",
                "the backend profile catalog could not be read",
            )
        })?;
    let after = file.metadata().map_err(|_| {
        DureBackendTransportError::new(
            "backend_transport_profile_unavailable",
            "the backend profile catalog metadata is unavailable",
        )
    })?;
    if source.len() as u64 != before.len()
        || after.dev() != before.dev()
        || after.ino() != before.ino()
        || after.len() != before.len()
        || after.mtime() != before.mtime()
        || after.mtime_nsec() != before.mtime_nsec()
    {
        return Err(DureBackendTransportError::new(
            "backend_transport_profile_changed",
            "the backend profile catalog changed while it was read",
        ));
    }
    Ok(source)
}

fn read_catalog(root: &Path) -> Result<BackendCatalog, DureBackendTransportError> {
    let source = read_owner_file(&root.join("backend-profiles.json"))?;
    let catalog: BackendCatalog = serde_json::from_slice(&source).map_err(|_| {
        DureBackendTransportError::new(
            "backend_transport_profile_invalid",
            "the backend profile catalog is invalid",
        )
    })?;
    if catalog.schema_version != 1
        || catalog.kind != "dure.backend_profiles"
        || catalog.profiles.is_empty()
        || catalog.profiles.len() > MAX_PROFILES
    {
        return Err(DureBackendTransportError::new(
            "backend_transport_profile_invalid",
            "the backend profile catalog is invalid",
        ));
    }
    let mut ids = BTreeSet::new();
    let mut defaults = Vec::new();
    for profile in &catalog.profiles {
        validate_profile(profile)?;
        if !ids.insert(profile.id.clone()) {
            return Err(DureBackendTransportError::new(
                "backend_transport_profile_invalid",
                "the backend profile catalog contains duplicate ids",
            ));
        }
        if profile.default {
            defaults.push(profile.id.clone());
        }
    }
    if defaults.len() > 1 {
        return Err(DureBackendTransportError::new(
            "backend_transport_profile_invalid",
            "the backend profile catalog has multiple defaults",
        ));
    }
    Ok(catalog)
}

fn selected_profile(
    root: &Path,
    config: &RuntimeConfig,
    explicit_selector: Option<&str>,
) -> Result<SelectedProfile, DureBackendTransportError> {
    let catalog = read_catalog(root)?;
    let ids = catalog.profiles.iter().map(|profile| profile.id.clone()).collect();
    let defaults: Vec<_> = catalog
        .profiles
        .iter()
        .filter(|profile| profile.default)
        .map(|profile| profile.id.clone())
        .collect();
    let selector = explicit_selector
        .map(str::to_owned)
        .or_else(|| config.profile_selector_override.clone())
        .or_else(|| std::env::var("DURE_BACKEND_PROFILE").ok())
        .filter(|selector| !selector.is_empty());
    let selected_id = match selector {
        Some(selector) if valid_profile_id(&selector) => selector,
        Some(_) => {
            return Err(DureBackendTransportError::new(
                "backend_transport_profile_invalid",
                "the backend profile selector is invalid",
            ));
        }
        None if defaults.len() == 1 => defaults[0].clone(),
        None => {
            return Err(DureBackendTransportError::new(
                "backend_transport_profile_unavailable",
                "no unique default backend profile is available",
            ));
        }
    };
    let profile = catalog
        .profiles
        .into_iter()
        .find(|profile| profile.id == selected_id)
        .ok_or_else(|| {
            DureBackendTransportError::new(
                "backend_transport_profile_unavailable",
                "the selected backend profile does not exist",
            )
        })?;
    let ssh_references = match (&profile.transport, &profile.auth, &profile.trust) {
        (ProfileTransport::Local { .. }, _, _) => None,
        (ProfileTransport::Ssh { .. }, auth, trust @ ProfileTrust::KnownHosts { .. }) => {
            Some(ssh_references::resolve(
                root,
                &profile.id,
                auth,
                trust,
                ssh_references::Compatibility {
                    profile_id: config
                        .ssh_reference_profile_override
                        .clone()
                        .or_else(|| {
                            std::env::var("DURE_BACKEND_SSH_REFERENCE_PROFILE").ok()
                        })
                        .filter(|value| !value.is_empty()),
                    known_hosts_file: config.known_hosts_override.clone().or_else(|| {
                        std::env::var_os("DURE_BACKEND_KNOWN_HOSTS_FILE").map(PathBuf::from)
                    }),
                    identity_file: config.identity_override.clone().or_else(|| {
                        std::env::var_os("DURE_BACKEND_IDENTITY_FILE").map(PathBuf::from)
                    }),
                },
            )?)
        }
        _ => unreachable!("validated backend profile"),
    };
    Ok(SelectedProfile {
        profile,
        ssh_references,
        catalog_profile_ids: ids,
    })
}

#[derive(Clone, Copy)]
struct SupportedOperation<'a> {
    name: &'a str,
    capability: &'static str,
    durable_observation: bool,
}

impl<'a> SupportedOperation<'a> {
    fn parse(name: &'a str) -> Result<Self, DureBackendTransportError> {
        let capability = operation_capability(name).ok_or_else(|| {
            DureBackendTransportError::new(
                "backend_transport_operation_unsupported",
                "the requested backend operation is unsupported",
            )
        })?;
        Ok(Self {
            name,
            capability,
            durable_observation: is_durable_agent_observation(name),
        })
    }
}

fn required_capabilities(
    selected: &SelectedProfile,
    operation_capability: &'static str,
) -> Result<Vec<&'static str>, DureBackendTransportError> {
    let mut required = vec![operation_capability, PERSISTENT_CAPABILITY];
    if matches!(
        &selected.profile.transport,
        ProfileTransport::Ssh {
            endpoint: ProfileEndpoint::UnixSocket { .. },
            ..
        }
    ) {
        required.push(SSH_GATEWAY_CAPABILITY);
    }
    for &capability in &required {
        if !selected
            .profile
            .expected
            .capabilities
            .iter()
            .any(|declared| declared == capability)
        {
            return Err(DureBackendTransportError::with_details(
                "backend_transport_capability_missing",
                "the selected backend does not declare a required capability",
                Some(json!({ "capability": capability })),
            ));
        }
    }
    Ok(required)
}

fn serialize_request(
    selected: &SelectedProfile,
    request_id: &str,
    operation: &str,
    body: &Value,
    required_capabilities: &[&str],
) -> Result<Vec<u8>, DureBackendTransportError> {
    let request = json!({
        "schemaVersion": 1,
        "apiVersion": BACKEND_PROTOCOL_API,
        "kind": BACKEND_REQUEST_KIND,
        "requestId": request_id,
        "operation": operation,
        "expected": {
            "backendId": selected.profile.expected.backend_id,
            "generation": selected.profile.expected.generation,
            "protocol": selected.profile.expected.protocol,
            "requiredCapabilities": required_capabilities
        },
        "body": body,
        "connection": { "mode": "persistent_v1" }
    });
    let mut source = serde_json::to_vec(&request).map_err(|_| {
        DureBackendTransportError::new(
            "backend_transport_invalid_request",
            "the backend request could not be serialized",
        )
    })?;
    source.push(b'\n');
    if source.len() > MAX_REQUEST_BYTES {
        return Err(DureBackendTransportError::new(
            "backend_transport_request_limit",
            "the backend request exceeded its byte bound",
        ));
    }
    Ok(source)
}

fn request_id() -> Result<String, DureBackendTransportError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| {
        DureBackendTransportError::new(
            "backend_transport_request_id_unavailable",
            "a backend request id could not be generated",
        )
    })?;
    Ok(bytes.iter().fold(String::from("app-"), |mut output, byte| {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
        output
    }))
}

fn ssh_arguments(
    selected: &SelectedProfile,
    known_hosts_file: &Path,
    identity_file: Option<&Path>,
) -> Result<Vec<String>, DureBackendTransportError> {
    let ProfileTransport::Ssh {
        host,
        port,
        user,
        endpoint,
        ..
    } = &selected.profile.transport
    else {
        return Err(DureBackendTransportError::new(
            "backend_transport_endpoint_unsupported",
            "the selected backend endpoint is unsupported",
        ));
    };
    let mut arguments = vec![
        "-F".into(),
        "/dev/null".into(),
        "-T".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "StrictHostKeyChecking=yes".into(),
        "-o".into(),
        "GlobalKnownHostsFile=/dev/null".into(),
        "-o".into(),
        "PasswordAuthentication=no".into(),
        "-o".into(),
        "KbdInteractiveAuthentication=no".into(),
        "-o".into(),
        "GSSAPIAuthentication=no".into(),
        "-o".into(),
        "HostbasedAuthentication=no".into(),
        "-o".into(),
        "PreferredAuthentications=publickey".into(),
        "-o".into(),
        "PubkeyAuthentication=yes".into(),
        "-o".into(),
        "NumberOfPasswordPrompts=0".into(),
        "-o".into(),
        "ConnectionAttempts=1".into(),
        "-o".into(),
        "ClearAllForwardings=yes".into(),
        "-o".into(),
        "PermitLocalCommand=no".into(),
        "-o".into(),
        "LogLevel=ERROR".into(),
        "-o".into(),
        format!(
            "ConnectTimeout={}",
            effective_connect_timeout_ms(&selected.profile)
                .div_ceil(1_000)
                .max(1)
        ),
        "-o".into(),
        format!("UserKnownHostsFile={}", known_hosts_file.display()),
    ];
    match (&selected.profile.auth, identity_file) {
        (ProfileAuth::SshAgent, None) => arguments.extend([
            "-o".into(),
            "IdentitiesOnly=no".into(),
            "-o".into(),
            "IdentityFile=none".into(),
        ]),
        (ProfileAuth::IdentityFile { .. }, Some(identity_file)) => arguments.extend([
            "-o".into(),
            "IdentitiesOnly=yes".into(),
            "-o".into(),
            format!("IdentityFile={}", identity_file.display()),
        ]),
        _ => return Err(ssh_references::unavailable()),
    }
    arguments.extend(["-p".into(), port.to_string(), "-l".into(), user.clone()]);
    match endpoint {
        ProfileEndpoint::Tcp {
            host: endpoint_host,
            port: endpoint_port,
        } => arguments.extend([
            "-W".into(),
            format!("{endpoint_host}:{endpoint_port}"),
            "--".into(),
            host.clone(),
        ]),
        ProfileEndpoint::UnixSocket { path } => {
            let path = path.to_str().ok_or_else(|| {
                DureBackendTransportError::new(
                    "backend_transport_endpoint_unsupported",
                    "the selected backend endpoint is unsupported",
                )
            })?;
            let socket_hex = path.as_bytes().iter().fold(
                String::with_capacity(path.len() * 2),
                |mut output, byte| {
                    use std::fmt::Write as _;
                    let _ = write!(output, "{byte:02x}");
                    output
                },
            );
            arguments.extend([
                "--".into(),
                host.clone(),
                DURE_CONTROL_PLANE_GATEWAY.into(),
                "gateway".into(),
                "--socket-hex".into(),
                socket_hex,
                "--expected-generation".into(),
                selected.profile.expected.generation.clone(),
            ]);
        }
        ProfileEndpoint::WindowsNamedPipe { .. } => {
            return Err(DureBackendTransportError::new(
                "backend_transport_endpoint_unsupported",
                "the selected backend endpoint is unsupported",
            ));
        }
    }
    Ok(arguments)
}

async fn read_bounded_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Vec<u8>, DureBackendTransportError> {
    let mut source = Vec::new();
    loop {
        let available = reader.fill_buf().await.map_err(|_| {
            DureBackendTransportError::new(
                "backend_transport_unavailable",
                "the backend response could not be read",
            )
        })?;
        if available.is_empty() {
            return Err(DureBackendTransportError::new(
                "backend_transport_eof",
                "the backend connection ended before a framed response",
            ));
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if source.len() + consumed > MAX_RESPONSE_BYTES {
            return Err(DureBackendTransportError::new(
                "backend_transport_output_limit",
                "the backend response exceeded its byte bound",
            ));
        }
        let ended = available[consumed - 1] == b'\n';
        source.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if ended {
            return Ok(source);
        }
    }
}

impl PersistentConnection {
    async fn connect(
        selected: &SelectedProfile,
        config: &RuntimeConfig,
        deadline: Instant,
    ) -> Result<Self, DureBackendTransportError> {
        Self::connect_with_material_hook(selected, config, deadline, |_| {}).await
    }

    async fn connect_with_material_hook(
        selected: &SelectedProfile,
        config: &RuntimeConfig,
        deadline: Instant,
        after_material_open: impl Fn(&Path),
    ) -> Result<Self, DureBackendTransportError> {
        match &selected.profile.transport {
            ProfileTransport::Local {
                endpoint: ProfileEndpoint::UnixSocket { path },
            } => {
                let stream = timeout_at(deadline, UnixStream::connect(path))
                    .await
                    .map_err(|_| {
                        DureBackendTransportError::new(
                            "backend_transport_timeout",
                            "the backend connection exceeded its deadline",
                        )
                    })?
                    .map_err(|_| {
                        DureBackendTransportError::new(
                            "backend_transport_unavailable",
                            "the local backend endpoint is unavailable",
                        )
                    })?;
                verify_local_backend_peer(&stream)?;
                Ok(Self::Local(BufReader::new(stream)))
            }
            ProfileTransport::Ssh { .. } => {
                let references = selected.ssh_references.as_ref().ok_or_else(|| {
                    DureBackendTransportError::new(
                        "backend_transport_reference_unavailable",
                        "the backend SSH references are unavailable",
                    )
                })?;
                let materials =
                    ssh_references::pin_with_hook(references, after_material_open)?;
                let mut command = Command::new(&config.ssh_command);
                command
                    .args(ssh_arguments(
                        selected,
                        materials.known_hosts_file(),
                        materials.identity_file(),
                    )?)
                    .kill_on_drop(true)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null());
                let mut child = Box::new(command.spawn().map_err(|_| {
                    DureBackendTransportError::new(
                        "backend_transport_ssh_unavailable",
                        "the SSH backend transport could not be started",
                    )
                })?);
                let stdin = child.stdin.take().ok_or_else(|| {
                    DureBackendTransportError::new(
                        "backend_transport_ssh_unavailable",
                        "the SSH backend input stream is unavailable",
                    )
                })?;
                let stdout = child.stdout.take().ok_or_else(|| {
                    DureBackendTransportError::new(
                        "backend_transport_ssh_unavailable",
                        "the SSH backend output stream is unavailable",
                    )
                })?;
                Ok(Self::Ssh {
                    child,
                    stdin,
                    stdout: BufReader::new(stdout),
                    materials: Some(materials),
                })
            }
            _ => Err(DureBackendTransportError::new(
                "backend_transport_endpoint_unsupported",
                "the selected backend endpoint is unsupported",
            )),
        }
    }

    async fn exchange(
        &mut self,
        request: &[u8],
        deadline: Instant,
    ) -> Result<Vec<u8>, DureBackendTransportError> {
        let exchanged = async {
            self.write_request(request).await?;
            self.read_frame().await
        };
        timeout_at(deadline, exchanged).await.map_err(|_| {
            DureBackendTransportError::new(
                "backend_transport_timeout",
                "the backend request exceeded its deadline",
            )
        })?
    }

    async fn write_request(
        &mut self,
        request: &[u8],
    ) -> Result<(), DureBackendTransportError> {
        match self {
            Self::Local(reader) => {
                reader.get_mut().write_all(request).await.map_err(|_| {
                    DureBackendTransportError::new(
                        "backend_transport_unavailable",
                        "the local backend request could not be written",
                    )
                })?;
                reader.get_mut().flush().await.map_err(|_| {
                    DureBackendTransportError::new(
                        "backend_transport_unavailable",
                        "the local backend request could not be flushed",
                    )
                })
            }
            Self::Ssh {
                child,
                stdin,
                ..
            } => {
                if child
                    .try_wait()
                    .map_err(|_| {
                        DureBackendTransportError::new(
                            "backend_transport_ssh_failed",
                            "the SSH backend process could not be observed",
                        )
                    })?
                    .is_some()
                {
                    return Err(DureBackendTransportError::new(
                        "backend_transport_ssh_failed",
                        "the SSH backend process exited",
                    ));
                }
                stdin.write_all(request).await.map_err(|_| {
                    DureBackendTransportError::new(
                        "backend_transport_ssh_failed",
                        "the SSH backend request could not be written",
                    )
                })?;
                stdin.flush().await.map_err(|_| {
                    DureBackendTransportError::new(
                        "backend_transport_ssh_failed",
                        "the SSH backend request could not be flushed",
                    )
                })
            }
        }
    }

    async fn read_frame(&mut self) -> Result<Vec<u8>, DureBackendTransportError> {
        match self {
            Self::Local(reader) => read_bounded_line(reader).await,
            Self::Ssh {
                child,
                stdin: _,
                stdout,
                ..
            } => {
                if child
                    .try_wait()
                    .map_err(|_| {
                        DureBackendTransportError::new(
                            "backend_transport_ssh_failed",
                            "the SSH backend process could not be observed",
                        )
                    })?
                    .is_some()
                {
                    return Err(DureBackendTransportError::new(
                        "backend_transport_ssh_failed",
                        "the SSH backend process exited",
                    ));
                }
                read_bounded_line(stdout).await.map_err(|error| {
                    if matches!(
                        error.code.as_str(),
                        "backend_transport_eof" | "backend_transport_unavailable"
                    ) {
                        DureBackendTransportError::new(
                            "backend_transport_ssh_failed",
                            "the SSH backend connection ended unexpectedly",
                        )
                    } else {
                        error
                    }
                })
            }
        }
    }

    fn release_startup_materials(&mut self) {
        if let Self::Ssh { materials, .. } = self {
            drop(materials.take());
        }
    }

    async fn close(self) {
        self.close_with_material_hook(|| {}).await;
    }

    async fn close_with_material_hook(self, before_material_drop: impl FnOnce()) {
        if let Self::Ssh {
            mut child,
            stdin,
            materials,
            ..
        } = self
        {
            drop(stdin);
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
            drop(child);
            before_material_drop();
            drop(materials);
        }
    }
}

async fn retire_connection(cached: &mut Option<CachedConnection>) {
    if let Some(cached) = cached.take() {
        cached.connection.close().await;
    }
}

fn now_ms() -> Result<i64, DureBackendTransportError> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| {
                DureBackendTransportError::new(
                    "backend_transport_clock_invalid",
                    "the system clock is invalid",
                )
            })?
            .as_millis(),
    )
    .map_err(|_| {
        DureBackendTransportError::new(
            "backend_transport_clock_invalid",
            "the system clock is invalid",
        )
    })
}

fn parse_response(
    source: &[u8],
    request_id: &str,
    selected: &SelectedProfile,
    required: &[&str],
) -> Result<DureBackendTransportResult, DureBackendTransportError> {
    let response: WireResponse = serde_json::from_slice(source).map_err(|_| {
        DureBackendTransportError::new(
            "backend_transport_malformed_response",
            "the backend response is malformed",
        )
    })?;
    if response.schema_version != 1
        || response.api_version != BACKEND_PROTOCOL_API
        || response.request_id != request_id
    {
        return Err(DureBackendTransportError::new(
            "backend_transport_handshake_mismatch",
            "the backend response does not match the selected profile",
        ));
    }
    validate_wire_backend(&response.backend, selected, required)?;
    match (response.kind.as_str(), response.result, response.error) {
        (BACKEND_RESPONSE_KIND, Some(result), None) => Ok(DureBackendTransportResult {
            schema_version: 1,
            backend_id: response.backend.id,
            backend_generation: response.backend.generation,
            route_authority: route_authority::authority_for(selected),
            result,
        }),
        (BACKEND_ERROR_KIND, None, Some(error))
            if valid_token(&error.code, 128)
                && !error.message.is_empty()
                && error.message.len() <= 512 =>
        {
            Err(DureBackendTransportError::with_details(
                &error.code,
                &error.message,
                error.details,
            ))
        }
        _ => Err(DureBackendTransportError::new(
            "backend_transport_malformed_response",
            "the backend response is malformed",
        )),
    }
}

fn validate_wire_backend(
    backend: &WireBackend,
    selected: &SelectedProfile,
    required: &[&str],
) -> Result<(), DureBackendTransportError> {
    let observed_capabilities = backend.capabilities.iter().collect::<BTreeSet<_>>();
    if backend.id != selected.profile.expected.backend_id
        || backend.generation != selected.profile.expected.generation
        || compare_version(
            &backend.protocol,
            &selected.profile.expected.protocol.minimum,
        )
        .is_lt()
        || compare_version(
            &backend.protocol,
            &selected.profile.expected.protocol.maximum,
        )
        .is_gt()
        || backend.capabilities.len() > MAX_BACKEND_CAPABILITIES_V1
        || observed_capabilities.len() != backend.capabilities.len()
        || backend
            .capabilities
            .iter()
            .any(|capability| !valid_capability(capability))
        || required.iter().any(|capability| {
            !backend
                .capabilities
                .iter()
                .any(|observed| observed == capability)
        })
        || backend.observed_at_ms.abs_diff(now_ms()?) > MAX_CLOCK_SKEW_MS as u64
    {
        return Err(DureBackendTransportError::new(
            "backend_transport_handshake_mismatch",
            "the backend response does not match the selected profile",
        ));
    }
    Ok(())
}

impl DureBackendTransportState {
    pub(crate) fn with_recovery(
        recovery: crate::dure_backend_coordinator::ManagedBackendCoordinatorHandle,
    ) -> Self {
        Self {
            recovery,
            ..Self::default()
        }
    }

    pub(crate) fn cancel_window_subscriptions(&self, owner_window: &str) -> usize {
        subscription::cancel_window_subscriptions(&self.subscriptions, owner_window)
    }

    fn prune_connection_cells(
        &self,
        retained_profile_ids: &BTreeSet<String>,
    ) -> Result<(), DureBackendTransportError> {
        let mut connections = self.connections.lock().map_err(|_| {
            DureBackendTransportError::new(
                "backend_transport_state_unavailable",
                "the backend transport state is unavailable",
            )
        })?;
        connections.retain(|profile_id, _| retained_profile_ids.contains(profile_id));
        Ok(())
    }

    fn connection_cell(
        &self,
        profile_id: &str,
    ) -> Result<Arc<Mutex<Option<CachedConnection>>>, DureBackendTransportError> {
        let mut connections = self.connections.lock().map_err(|_| {
            DureBackendTransportError::new(
                "backend_transport_state_unavailable",
                "the backend transport state is unavailable",
            )
        })?;
        if let Some(connection) = connections.get(profile_id) {
            return Ok(Arc::clone(connection));
        }
        if connections.len() >= MAX_PROFILES {
            return Err(DureBackendTransportError::new(
                "backend_transport_profile_capacity",
                "the backend connection profile capacity is exhausted",
            ));
        }
        let connection = Arc::new(Mutex::new(None));
        connections.insert(profile_id.into(), Arc::clone(&connection));
        Ok(connection)
    }

    async fn request(
        &self,
        root: &Path,
        route: &DureBackendRouteV1,
        operation: &str,
        body: Value,
    ) -> Result<DureBackendTransportResult, DureBackendTransportError> {
        let operation = SupportedOperation::parse(operation)?;
        if !body.is_object() {
            return Err(DureBackendTransportError::new(
                "backend_transport_invalid_request",
                "the backend request body is invalid",
            ));
        }
        self.recovery
            .wait_for_startup()
            .await
            .map_err(coordinator_error)?;
        let mut selected = route_authority::select(root, &self.config, route)?;
        let mut recovered = false;
        let follows_selected_generation =
            operation.durable_observation && matches!(route, DureBackendRouteV1::Selected { .. });
        loop {
            if !operation.durable_observation {
                self.recovery
                    .wait_before_request(&selected.profile)
                    .await
                    .map_err(coordinator_error)?;
            }
            selected = route_authority::select(root, &self.config, route)?;
            match self
                .request_selected(
                    root,
                    route,
                    &selected,
                    operation,
                    &body,
                    follows_selected_generation,
                )
                .await
            {
                Ok(result) => return Ok(result),
                Err(error) if !recovered && local_liveness_failure(&selected, &error) => {
                    let Some(ticket) = self.recovery.begin_recovery(&selected.profile) else {
                        return Err(error);
                    };
                    self.recovery
                        .wait_for_recovery(&ticket)
                        .await
                        .map_err(coordinator_error)?;
                    selected = route_authority::select(root, &self.config, route)?;
                    recovered = true;
                }
                Err(error) => return Err(error),
            }
        }
    }

    async fn request_selected(
        &self,
        root: &Path,
        route: &DureBackendRouteV1,
        selected: &SelectedProfile,
        operation: SupportedOperation<'_>,
        body: &Value,
        follows_selected_generation: bool,
    ) -> Result<DureBackendTransportResult, DureBackendTransportError> {
        let required_capabilities = required_capabilities(selected, operation.capability)?;
        let request_id = request_id()?;
        let request_source = serialize_request(
            selected,
            &request_id,
            operation.name,
            body,
            &required_capabilities,
        )?;
        let request_kib = request_source.len().div_ceil(1024) as u32;
        let profile_key = selected.profile.id.clone();
        self.prune_connection_cells(&selected.catalog_profile_ids)?;
        let connection = self.connection_cell(&profile_key)?;
        let deadline = Instant::now() + selected.profile.deadline();
        let queue_slot = timeout_at(deadline, Arc::clone(&self.queue_slots).acquire_owned())
            .await
            .map_err(|_| queue_timeout("the backend request queue exceeded its deadline"))?
            .map_err(|_| queue_unavailable())?;
        let queue_bytes = timeout_at(
            deadline,
            Arc::clone(&self.queue_bytes).acquire_many_owned(request_kib),
        )
        .await
        .map_err(|_| queue_timeout("the backend request byte queue exceeded its deadline"))?
        .map_err(|_| queue_unavailable())?;
        // persistent_v1 serves one request at a time on each connection. Keep
        // one reusable connection per profile, but give an overlapping caller
        // its own exchange under the same global count and byte permits.
        let (mut cached, reusable) = match connection.try_lock_owned() {
            Ok(cached) => (cached, true),
            Err(_) => (Arc::new(Mutex::new(None)).lock_owned().await, false),
        };
        if cached
            .as_ref()
            .is_some_and(|connection| !connection.selected.same_connection_identity(selected))
        {
            retire_connection(&mut cached).await;
        }
        let mut last_error = None;
        for attempt in 0..=1 {
            if cached.is_none() {
                let connection =
                    PersistentConnection::connect(selected, &self.config, deadline).await?;
                *cached = Some(CachedConnection {
                    selected: selected.clone(),
                    connection,
                });
            }
            let response = cached
                .as_mut()
                .expect("connection was initialized")
                .connection
                .exchange(&request_source, deadline)
                .await;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    retire_connection(&mut cached).await;
                    last_error = Some(error);
                    if attempt == 0 && Instant::now() < deadline {
                        continue;
                    }
                    break;
                }
            };
            let parsed = parse_response(
                &response,
                &request_id,
                selected,
                &required_capabilities,
            );
            let handshake_failed = parsed.as_ref().is_err_and(|error| {
                matches!(
                    error.code.as_str(),
                    "backend_transport_malformed_response" | "backend_transport_handshake_mismatch"
                )
            });
            if handshake_failed {
                retire_connection(&mut cached).await;
            } else if let Some(cached) = cached.as_mut() {
                cached.connection.release_startup_materials();
            }
            let current = match selected_profile(root, &self.config, route.profile_id()) {
                Ok(current) => current,
                Err(error) => {
                    retire_connection(&mut cached).await;
                    return Err(error);
                }
            };
            if follows_selected_generation && !current.same_observation_target(selected) {
                retire_connection(&mut cached).await;
                return Err(DureBackendTransportError::new(
                    "backend_transport_target_changed",
                    "the selected backend target changed while the request was in flight",
                ));
            }
            if !follows_selected_generation && !current.same_connection_identity(selected) {
                retire_connection(&mut cached).await;
                return Err(DureBackendTransportError::new(
                    "backend_transport_generation_changed",
                    "the selected backend changed while the request was in flight",
                ));
            }
            if !reusable {
                retire_connection(&mut cached).await;
            }
            drop(queue_bytes);
            drop(queue_slot);
            return parsed;
        }
        drop(queue_bytes);
        drop(queue_slot);
        Err(last_error.unwrap_or_else(|| {
            DureBackendTransportError::new(
                "backend_transport_unavailable",
                "the backend request failed",
            )
        }))
    }

    #[cfg(test)]
    async fn close(&self) {
        let connections = self
            .connections
            .lock()
            .map(|mut connections| std::mem::take(&mut *connections))
            .unwrap_or_default();
        for (_, connection) in connections {
            let mut cached = connection.lock().await;
            retire_connection(&mut cached).await;
        }
    }

    #[cfg(test)]
    async fn has_cached_connection(&self, profile_id: &str) -> bool {
        let connection = self
            .connections
            .lock()
            .ok()
            .and_then(|connections| connections.get(profile_id).cloned());
        match connection {
            Some(connection) => connection.lock().await.is_some(),
            None => false,
        }
    }
}

/// Saved connection names only; credentials and socket paths stay native.
#[tauri::command]
pub fn dure_backend_profiles() -> Result<Value, DureBackendTransportError> {
    let (root, _) = crate::app_home::app_root_resolution().map_err(|_| {
        DureBackendTransportError::new(
            "backend_transport_profile_unavailable",
            "the Dure application root is unavailable",
        )
    })?;
    let catalog = read_catalog(&root)?;
    Ok(json!({ "schemaVersion": 1, "profiles": catalog.profiles.iter().map(|profile| {
        json!({ "id": profile.id, "default": profile.default, "kind": match &profile.transport {
            ProfileTransport::Local { .. } => "local", ProfileTransport::Ssh { .. } => "ssh"
        } })
    }).collect::<Vec<_>>() }))
}

#[tauri::command]
pub async fn dure_backend_request(
    state: State<'_, DureBackendTransportState>,
    route: DureBackendRouteV1,
    operation: String,
    body: Value,
) -> Result<DureBackendTransportResult, DureBackendTransportError> {
    let (root, _) = crate::app_home::app_root_resolution().map_err(|_| {
        DureBackendTransportError::new(
            "backend_transport_profile_unavailable",
            "the Dure application root is unavailable",
        )
    })?;
    state
        .request(&root, &route, &operation, body)
        .await
}

#[tauri::command]
pub fn dure_backend_route_assert(
    state: State<'_, DureBackendTransportState>,
    route: DureBackendRouteV1,
) -> Result<DureBackendRouteAuthorityV1, DureBackendTransportError> {
    let (root, _) = crate::app_home::app_root_resolution().map_err(|_| {
        DureBackendTransportError::new(
            "backend_transport_profile_unavailable",
            "the Dure application root is unavailable",
        )
    })?;
    let selected = route_authority::select(&root, &state.config, &route)?;
    Ok(route_authority::authority_for(&selected))
}

#[cfg(test)]
mod tests {
    mod concurrency;

    use super::*;
    use std::io::Write as _;
    use std::os::unix::fs::{FileExt as _, PermissionsExt as _};

    #[test]
    fn backend_capability_contract_accepts_current_identity_and_bounded_growth() {
        let manifest: Value = serde_json::from_str(include_str!(
            "../../cli/lib/control-plane-build-identity.json"
        )).unwrap();
        let current: Vec<String> = serde_json::from_value(
            manifest["identity"]["capabilities"].clone()
        ).unwrap();
        let maximum: Vec<String> = (0..128).map(|index| format!("capability.{index}")).collect();
        let mut selected = ssh_selected(ProfileEndpoint::Tcp {
            host: "127.0.0.1".into(),
            port: 4681,
        });
        for capabilities in [current, maximum.clone()] {
            selected.profile.expected.capabilities = capabilities.clone();
            validate_profile(&selected.profile).unwrap();
            let mut response: Value = serde_json::from_slice(&response_for(
                &json!({ "requestId": "capability-bound" }),
                &selected.profile.expected.backend_id,
                &selected.profile.expected.generation,
            )).unwrap();
            response["backend"]["capabilities"] = json!(capabilities);
            parse_response(
                &serde_json::to_vec(&response).unwrap(),
                "capability-bound",
                &selected,
                &[&capabilities[0]],
            ).unwrap();
        }
        for extra in ["capability.extra", "capability.1", "invalid capability"] {
            let mut invalid = maximum.clone();
            if extra != "capability.extra" {
                invalid.pop();
            }
            invalid.push(extra.into());
            selected.profile.expected.capabilities = invalid.clone();
            assert!(validate_profile(&selected.profile).is_err());
            let backend = WireBackend {
                id: selected.profile.expected.backend_id.clone(),
                generation: selected.profile.expected.generation.clone(),
                protocol: ProtocolVersion { major: 1, minor: 0 },
                capabilities: invalid,
                observed_at_ms: now_ms().unwrap(),
            };
            assert!(validate_wire_backend(&backend, &selected, &[]).is_err());
        }
    }

    #[tokio::test]
    async fn local_backend_connection_requires_the_current_effective_uid() {
        let (stream, _peer) = UnixStream::pair().unwrap();
        assert!(verify_local_backend_peer(&stream).is_ok());

        let current_uid = unsafe { libc::geteuid() };
        let foreign_uid = if current_uid == u32::MAX {
            current_uid - 1
        } else {
            current_uid + 1
        };
        let error = verify_local_backend_peer_uid(foreign_uid).unwrap_err();
        assert_eq!(error.code, "backend_transport_peer_untrusted");
    }

    #[test]
    fn orchestration_uses_the_negotiated_generic_backend_capability() {
        assert_eq!(
            operation_capability("orchestration.invoke"),
            Some("orchestration.invoke")
        );
        assert_eq!(operation_capability("orchestration.events.read"), None);
    }

    #[test]
    fn agent_spawn_operations_use_their_exact_negotiated_capabilities() {
        for operation in ["agent_spawn.apply", "agent_spawn.status"] {
            assert_eq!(operation_capability(operation), Some(operation));
        }
        assert_eq!(
            operation_capability("agent_spawn.preview"),
            Some("agent_spawn.preview.v2")
        );
        assert_eq!(operation_capability("agent_spawn.abort"), None);
    }

    #[test]
    fn agent_runtime_lifecycle_uses_its_exact_negotiated_capabilities() {
        for operation in [
            "agent_runtime.inspect",
            "agent_runtime.native_rehost.reconcile",
            "agent_runtime.native_resume.publish",
            "agent_runtime.projection.inspect",
            "agent_runtime.repair",
            "agent_runtime.repair_intent.inspect.v1",
            "agent_runtime.stop",
            "agent_runtime.remove",
            "agent_runtime.transition",
        ] {
            assert_eq!(operation_capability(operation), Some(operation));
        }
        assert_eq!(operation_capability("agent_runtime.force"), None);
    }

    #[test]
    fn dispatch_stop_uses_its_exact_negotiated_capabilities() {
        for operation in [
            "dispatch.stop.preview",
            "dispatch.stop.apply",
            "dispatch.stop.status",
        ] {
            assert_eq!(operation_capability(operation), Some(operation));
        }
        assert_eq!(operation_capability("dispatch.stop.cancel"), None);
    }

    #[test]
    fn versioned_inspection_refuses_local_and_ssh_profiles_without_its_capability() {
        for operation in [
            "agent_runtime.projection.inspect",
            "agent_runtime.repair_intent.inspect.v1",
        ] {
            let operation = operation_capability(operation).unwrap();
            let remote = ssh_selected(ProfileEndpoint::Tcp {
                host: "127.0.0.1".into(),
                port: 4681,
            });
            let remote_error = required_capabilities(&remote, operation).unwrap_err();
            assert_eq!(remote_error.code, "backend_transport_capability_missing");
            assert_eq!(
                remote_error.details,
                Some(json!({ "capability": operation }))
            );

            let mut local = remote;
            local.profile.transport = ProfileTransport::Local {
                endpoint: ProfileEndpoint::UnixSocket {
                    path: PathBuf::from("/tmp/dure-control-plane.sock"),
                },
            };
            local.profile.auth = ProfileAuth::Peer;
            local.profile.trust = ProfileTrust::LocalPeer;
            local.profile.expected.capabilities = vec![PERSISTENT_CAPABILITY.into()];
            local.ssh_references = None;
            let local_error = required_capabilities(&local, operation).unwrap_err();
            assert_eq!(local_error.code, "backend_transport_capability_missing");
            assert_eq!(
                local_error.details,
                Some(json!({ "capability": operation }))
            );
        }
    }

    #[test]
    fn checkpoint_binding_uses_its_exact_negotiated_capability() {
        assert_eq!(
            operation_capability("agent_checkpoint.binding.ensure"),
            Some("agent_checkpoint.binding.ensure")
        );
    }

    #[test]
    fn workflow_delegation_uses_its_exact_negotiated_capabilities() {
        for operation in [
            "workflow.delegate_once",
            "workflow.delegate_once.complete",
            "workflow.delegate_once.show",
        ] {
            assert_eq!(operation_capability(operation), Some(operation));
        }
    }

    #[test]
    fn project_operations_use_their_exact_negotiated_capabilities() {
        for operation in ["projects.list", "projects.register", "projects.show"] {
            assert_eq!(operation_capability(operation), Some(operation));
        }
        assert_eq!(operation_capability("projects.delete"), None);
    }

    #[test]
    fn provider_launch_defaults_use_their_exact_negotiated_capabilities() {
        assert_eq!(
            operation_capability("provider_launch_defaults.get"),
            Some("provider_launch_defaults.get")
        );
        assert_eq!(
            operation_capability("provider_launch_defaults.put"),
            Some("provider_launch_defaults.put")
        );
        assert_eq!(operation_capability("provider_launch_defaults.delete"), None);
    }

    #[test]
    fn agent_conversation_requests_use_only_public_negotiated_capabilities() {
        for operation in [
            "agent_conversation.inspect",
            "agent_conversation.recover",
            "agent_conversation.start_turn",
            "agent_conversation.continue_turn",
            "agent_conversation.answer_pending",
            "agent_conversation.interrupt_turn",
            "claude_conversation.open",
            "claude_conversation.stop",
            "provider_credential_profile.register",
        ] {
            assert_eq!(operation_capability(operation), Some(operation));
        }
        assert_eq!(
            operation_capability("agent_conversation.read"),
            Some("agent_conversation.read.v6")
        );
        assert_eq!(SUBSCRIBE_CAPABILITY, "agent_conversation.subscribe.v6");
        assert_eq!(operation_capability("agent_conversation.create"), None);
        assert_eq!(operation_capability("agent_conversation.subscribe"), None);
        assert_eq!(operation_capability("claude_conversation.launch"), None);
    }

    fn write_owner_file(path: &Path, source: &[u8], executable: bool) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(if executable { 0o700 } else { 0o600 })
            .open(path)
            .unwrap();
        file.write_all(source).unwrap();
        file.sync_all().unwrap();
    }

    fn write_catalog(root: &Path, profile: Value) {
        write_catalog_profiles(root, vec![profile]);
    }

    fn selected_route(profile_id: &str) -> DureBackendRouteV1 {
        DureBackendRouteV1::Selected {
            profile_id: Some(profile_id.into()),
        }
    }

    fn write_catalog_profiles(root: &Path, profiles: Vec<Value>) {
        write_owner_file(
            &root.join("backend-profiles.json"),
            format!(
                "{}\n",
                json!({
                    "schemaVersion": 1,
                    "kind": "dure.backend_profiles",
                    "profiles": profiles
                })
            )
            .as_bytes(),
            false,
        );
    }

    fn replace_catalog(root: &Path, profile: Value) {
        replace_catalog_profiles(root, vec![profile]);
    }

    fn replace_catalog_profiles(root: &Path, profiles: Vec<Value>) {
        let temporary = root.join("backend-profiles.next.json");
        write_owner_file(
            &temporary,
            format!(
                "{}\n",
                json!({
                    "schemaVersion": 1,
                    "kind": "dure.backend_profiles",
                    "profiles": profiles
                })
            )
            .as_bytes(),
            false,
        );
        std::fs::rename(temporary, root.join("backend-profiles.json")).unwrap();
    }

    fn local_profile(socket_path: &Path) -> Value {
        json!({
            "id": "local",
            "default": true,
            "transport": {
                "kind": "local",
                "endpoint": { "kind": "unix_socket", "path": socket_path }
            },
            "auth": { "kind": "peer" },
            "trust": { "kind": "local_peer" },
            "expected": {
                "backendId": "dure-local",
                "generation": "local-v1-11111111111111111111111111111111",
                "protocol": {
                    "minimum": { "major": 1, "minor": 0 },
                    "maximum": { "major": 1, "minor": 0 }
                },
                "capabilities": [
                    "backend.connection.persistent",
                    "client_view.authority.read",
                    "agent_conversation.read.v6",
                    "agent_runtime.transition",
                    "dispatch.stop.status"
                ]
            },
            "deadlineMs": 2_000
        })
    }

    fn remote_profile(profile_id: &str, default: bool) -> Value {
        json!({
            "id": profile_id,
            "default": default,
            "transport": {
                "kind": "ssh",
                "host": "build.example.test",
                "port": 22,
                "user": "dure_runner",
                "endpoint": { "kind": "tcp", "host": "127.0.0.1", "port": 4681 }
            },
            "auth": {
                "kind": "identity_file",
                "reference": format!("credential-profile:{profile_id}")
            },
            "trust": {
                "kind": "known_hosts",
                "reference": format!("known-hosts-profile:{profile_id}")
            },
            "expected": {
                "backendId": format!("backend-{profile_id}"),
                "generation": format!("generation-{profile_id}"),
                "protocol": {
                    "minimum": { "major": 1, "minor": 0 },
                    "maximum": { "major": 1, "minor": 0 }
                },
                "capabilities": [
                    "backend.connection.persistent",
                    "client_view.authority.read"
                ]
            },
            "deadlineMs": 2_000
        })
    }

    pub(super) fn write_ssh_reference_fixture(root: &Path) -> BTreeMap<String, PathBuf> {
        let paths = BTreeMap::from([
            ("__IDENTITY_A__".into(), root.join("identity-a")),
            ("__IDENTITY_B__".into(), root.join("identity-b")),
            ("__KNOWN_HOSTS_A__".into(), root.join("known-hosts-a")),
            ("__KNOWN_HOSTS_B__".into(), root.join("known-hosts-b")),
        ]);
        for path in paths.values() {
            write_owner_file(path, b"fixture-material\n", false);
        }
        let mut catalog: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/dure-backend-ssh-reference-catalog.json"
        ))
        .unwrap();
        for entry in catalog["references"].as_array_mut().unwrap() {
            let token = entry["path"].as_str().unwrap();
            entry["path"] = Value::from(paths[token].to_str().unwrap());
        }
        write_owner_file(
            &root.join(ssh_references::CATALOG_FILE),
            format!("{catalog}\n").as_bytes(),
            false,
        );
        paths
    }

    fn response_for(request: &Value, backend_id: &str, generation: &str) -> Vec<u8> {
        format!(
            "{}\n",
            json!({
                "schemaVersion": 1,
                "apiVersion": BACKEND_PROTOCOL_API,
                "kind": BACKEND_RESPONSE_KIND,
                "requestId": request["requestId"],
                "backend": {
                    "id": backend_id,
                    "generation": generation,
                    "protocol": { "major": 1, "minor": 0 },
                    "capabilities": [
                        "backend.connection.persistent",
                        "client_view.authority.read",
                        "agent_conversation.read.v6",
                        "agent_runtime.transition",
                        "dispatch.stop.status"
                    ],
                    "observedAtMs": now_ms().unwrap()
                },
                "result": { "schemaVersion": 1, "authority": null }
            })
        )
        .into_bytes()
    }

    fn ssh_selected(endpoint: ProfileEndpoint) -> SelectedProfile {
        SelectedProfile {
            profile: BackendProfile {
                id: "remote-build".into(),
                default: true,
                transport: ProfileTransport::Ssh {
                    host: "build.example.test".into(),
                    port: 22,
                    user: "dure_runner".into(),
                    endpoint,
                    batch_mode: true,
                    strict_host_key_checking: "yes".into(),
                    connect_timeout_ms: Some(1_500),
                },
                auth: ProfileAuth::SshAgent,
                trust: ProfileTrust::KnownHosts {
                    reference: "known-hosts-profile:remote-build".into(),
                },
                expected: ExpectedBackend {
                    backend_id: "remote-backend".into(),
                    generation: "remote-v1".into(),
                    protocol: ProtocolRange {
                        minimum: ProtocolVersion { major: 1, minor: 0 },
                        maximum: ProtocolVersion { major: 1, minor: 0 },
                    },
                    capabilities: vec![
                        PERSISTENT_CAPABILITY.into(),
                        SSH_GATEWAY_CAPABILITY.into(),
                    ],
                },
                deadline_ms: 5_000,
            },
            ssh_references: Some(SshReferences {
                known_hosts_file: FileIdentity {
                    path: PathBuf::from("/tmp/dure-known-hosts"),
                    digest: [0; 32],
                    device: 1,
                    inode: 2,
                    size: 3,
                    modified_seconds: 4,
                    modified_nanoseconds: 5,
                    changed_seconds: 6,
                    changed_nanoseconds: 7,
                },
                identity_file: None,
            }),
            catalog_profile_ids: BTreeSet::from(["remote-build".into()]),
        }
    }

    #[test]
    fn durable_observation_target_ignores_replaceable_connection_material() {
        let selected = ssh_selected(ProfileEndpoint::Tcp {
            host: "127.0.0.1".into(),
            port: 4681,
        });
        let mut rotated = selected.clone();
        rotated.profile.expected.generation = "remote-v2".into();
        rotated.profile.deadline_ms += 1_000;
        if let ProfileTransport::Ssh {
            connect_timeout_ms,
            strict_host_key_checking,
            ..
        } = &mut rotated.profile.transport
        {
            *connect_timeout_ms = Some(2_000);
            *strict_host_key_checking = "accept-new".into();
        }
        rotated
            .ssh_references
            .as_mut()
            .unwrap()
            .known_hosts_file
            .inode += 1;

        assert!(selected.same_observation_target(&rotated));
        assert!(!selected.same_connection_identity(&rotated));
    }

    #[test]
    fn durable_observation_target_rejects_a_backend_or_ssh_retarget() {
        let selected = ssh_selected(ProfileEndpoint::Tcp {
            host: "127.0.0.1".into(),
            port: 4681,
        });
        let mut retargeted = selected.clone();
        if let ProfileTransport::Ssh { user, .. } = &mut retargeted.profile.transport {
            *user = "other_runner".into();
        }
        assert!(!selected.same_observation_target(&retargeted));

        let mut other_backend = selected.clone();
        other_backend.profile.expected.backend_id = "other-backend".into();
        assert!(!selected.same_observation_target(&other_backend));
    }

    #[test]
    fn shared_ssh_reference_catalog_isolates_two_profiles() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-ssh-reference-catalog-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let paths = write_ssh_reference_fixture(root);
        let mut composed = remote_profile("remote-shared", false);
        composed["auth"]["reference"] = Value::from("credential-profile:remote-b");
        composed["trust"]["reference"] = Value::from("known-hosts-profile:remote-a");
        write_catalog_profiles(
            root,
            vec![
                remote_profile("remote-a", true),
                remote_profile("remote-b", false),
                composed,
            ],
        );

        let remote_a = selected_profile(root, &RuntimeConfig::default(), Some("remote-a")).unwrap();
        let remote_b = selected_profile(root, &RuntimeConfig::default(), Some("remote-b")).unwrap();
        let remote_shared =
            selected_profile(root, &RuntimeConfig::default(), Some("remote-shared")).unwrap();
        let remote_a_references = remote_a.ssh_references.unwrap();
        let remote_b_references = remote_b.ssh_references.unwrap();
        assert_eq!(
            remote_a_references.known_hosts_file.path,
            paths["__KNOWN_HOSTS_A__"]
        );
        assert_eq!(
            remote_a_references.identity_file.unwrap().path,
            paths["__IDENTITY_A__"]
        );
        assert_eq!(
            remote_b_references.known_hosts_file.path,
            paths["__KNOWN_HOSTS_B__"]
        );
        assert_eq!(
            remote_b_references.identity_file.unwrap().path,
            paths["__IDENTITY_B__"]
        );
        let shared_references = remote_shared.ssh_references.unwrap();
        assert_eq!(
            shared_references.known_hosts_file.path,
            paths["__KNOWN_HOSTS_A__"]
        );
        assert_eq!(
            shared_references.identity_file.unwrap().path,
            paths["__IDENTITY_B__"]
        );
    }

    #[test]
    fn ssh_reference_catalog_replacement_during_read_fails_closed() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-ssh-reference-replace-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        write_ssh_reference_fixture(root);
        let catalog_path = root.join(ssh_references::CATALOG_FILE);
        let replacement = root.join("backend-ssh-references.next.json");
        let source = std::fs::read(&catalog_path).unwrap();
        let error = ssh_references::read_catalog_with_hook(&catalog_path, || {
            write_owner_file(&replacement, &source, false);
            std::fs::rename(&replacement, &catalog_path).unwrap();
        })
        .unwrap_err();
        assert_eq!(error.code, "backend_transport_reference_unavailable");
        assert!(!error.message.contains(root.to_str().unwrap()));
    }

    #[test]
    fn exact_route_revision_tracks_resolved_ssh_reference_file_identity() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-route-ssh-reference-identity-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let paths = write_ssh_reference_fixture(root);
        write_catalog(root, remote_profile("remote-a", true));
        let selected = selected_profile(root, &RuntimeConfig::default(), Some("remote-a")).unwrap();
        let captured = route_authority::authority_for(&selected);

        let replacement = root.join("known-hosts-a.next");
        write_owner_file(&replacement, b"replacement fixture material\n", false);
        std::fs::rename(replacement, &paths["__KNOWN_HOSTS_A__"]).unwrap();

        let changed = selected_profile(root, &RuntimeConfig::default(), Some("remote-a")).unwrap();
        let observed = route_authority::authority_for(&changed);
        assert_ne!(captured, observed);
        let error = route_authority::select(
            root,
            &RuntimeConfig::default(),
            &DureBackendRouteV1::Exact {
                authority: captured,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "backend_transport_authority_changed");
    }

    #[test]
    fn exact_route_revision_includes_the_internal_material_digest() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-route-ssh-reference-digest-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        write_ssh_reference_fixture(root);
        write_catalog(root, remote_profile("remote-a", true));
        let mut selected =
            selected_profile(root, &RuntimeConfig::default(), Some("remote-a")).unwrap();
        let captured = route_authority::authority_for(&selected);

        selected
            .ssh_references
            .as_mut()
            .unwrap()
            .known_hosts_file
            .digest[0] ^= 1;

        assert_ne!(route_authority::authority_for(&selected), captured);
    }

    #[test]
    fn exact_route_rejects_same_size_ssh_material_rewritten_with_restored_mtime() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-route-ssh-reference-ctime-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let paths = write_ssh_reference_fixture(root);
        write_catalog(root, remote_profile("remote-a", true));
        let material = &paths["__KNOWN_HOSTS_A__"];
        let before = std::fs::metadata(material).unwrap();
        let original_mtime = before.modified().unwrap();
        let captured = route_authority::authority_for(
            &selected_profile(root, &RuntimeConfig::default(), Some("remote-a")).unwrap(),
        );

        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(material)
            .unwrap();
        file.write_all(b"changed-material\n").unwrap();
        file.sync_all().unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(original_mtime))
            .unwrap();
        let after = std::fs::metadata(material).unwrap();
        assert_eq!(before.dev(), after.dev());
        assert_eq!(before.ino(), after.ino());
        assert_eq!(before.len(), after.len());
        assert_eq!(before.mtime(), after.mtime());
        assert_eq!(before.mtime_nsec(), after.mtime_nsec());
        assert_ne!(
            (before.ctime(), before.ctime_nsec()),
            (after.ctime(), after.ctime_nsec())
        );

        let observed = route_authority::authority_for(
            &selected_profile(root, &RuntimeConfig::default(), Some("remote-a")).unwrap(),
        );
        assert_ne!(
            serde_json::to_value(&captured).unwrap()["revision"],
            serde_json::to_value(&observed).unwrap()["revision"]
        );
        let error = route_authority::select(
            root,
            &RuntimeConfig::default(),
            &DureBackendRouteV1::Exact {
                authority: captured,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "backend_transport_authority_changed");
    }

    #[test]
    fn exact_route_stays_valid_when_only_timeout_policy_changes() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-route-timeout-policy-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        write_ssh_reference_fixture(root);
        let mut original = remote_profile("remote-a", true);
        original["transport"]["connectTimeoutMs"] = Value::from(1_000);
        write_catalog(root, original);
        let captured = route_authority::authority_for(
            &selected_profile(root, &RuntimeConfig::default(), Some("remote-a")).unwrap(),
        );

        let mut changed = remote_profile("remote-a", true);
        changed["deadlineMs"] = Value::from(4_000);
        changed["transport"]["connectTimeoutMs"] = Value::from(3_000);
        replace_catalog(root, changed);

        let selected = route_authority::select(
            root,
            &RuntimeConfig::default(),
            &DureBackendRouteV1::Exact {
                authority: captured.clone(),
            },
        )
        .unwrap();
        assert_eq!(route_authority::authority_for(&selected), captured);
    }

    #[test]
    fn ssh_reference_material_replacement_before_connect_fails_closed() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-ssh-reference-material-replace-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let material = root.join("known-hosts");
        let replacement = root.join("known-hosts.next");
        write_owner_file(&material, b"host-a key-a\n", false);
        let error = ssh_references::material_identity_with_hook(material.clone(), || {
            write_owner_file(&replacement, b"host-b key-b\n", false);
            std::fs::rename(&replacement, &material).unwrap();
        })
        .unwrap_err();
        assert_eq!(error.code, "backend_transport_reference_unavailable");
        assert!(!error.message.contains(root.to_str().unwrap()));
    }

    #[tokio::test]
    async fn ssh_reference_replaced_after_selection_fails_before_spawn() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-ssh-reference-pre-spawn-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let paths = write_ssh_reference_fixture(root);
        write_catalog(root, remote_profile("remote-a", true));
        let spawn_log = root.join("spawn.log");
        let fake_ssh = root.join("ssh-fixture");
        write_owner_file(
            &fake_ssh,
            format!(
                "#!/bin/sh\nprintf 'spawned\\n' >> '{}'\nwhile IFS= read -r _line; do :; done\n",
                spawn_log.display()
            )
            .as_bytes(),
            true,
        );
        let config = RuntimeConfig {
            ssh_command: fake_ssh,
            ..RuntimeConfig::default()
        };
        let selected = selected_profile(root, &config, Some("remote-a")).unwrap();
        let known_hosts = &paths["__KNOWN_HOSTS_A__"];
        let replacement = root.join("known-hosts-a.next");
        write_owner_file(&replacement, b"replacement material\n", false);
        std::fs::rename(replacement, known_hosts).unwrap();

        let outcome = PersistentConnection::connect(
            &selected,
            &config,
            Instant::now() + Duration::from_secs(2),
        )
        .await;
        let error_code = match outcome {
            Ok(connection) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
                connection.close().await;
                None
            }
            Err(error) => Some(error.code),
        };
        let spawn_count = std::fs::read_to_string(&spawn_log)
            .map(|source| source.lines().count())
            .unwrap_or(0);
        assert_eq!(
            (error_code.as_deref(), spawn_count),
            (Some("backend_transport_reference_unavailable"), 0)
        );
    }

    #[tokio::test]
    async fn ssh_spawn_consumes_the_fd_pinned_material_after_path_replacement() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-ssh-reference-pinned-")
            .tempdir_in("/tmp")
            .unwrap();
        let reference_root = temporary.path().join("source %h ${DURE_REFERENCE} material");
        std::fs::create_dir(&reference_root).unwrap();
        let root = reference_root.as_path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let paths = write_ssh_reference_fixture(root);
        write_catalog(root, remote_profile("remote-a", true));
        let original_known_hosts = std::fs::read(&paths["__KNOWN_HOSTS_A__"]).unwrap();
        let original_identity = std::fs::read(&paths["__IDENTITY_A__"]).unwrap();
        let observed_known_hosts = root.join("observed-known-hosts");
        let observed_identity = root.join("observed-identity");
        let observed_known_hosts_path = root.join("observed-known-hosts-path");
        let observed_identity_path = root.join("observed-identity-path");
        let observed_arguments = root.join("observed-arguments");
        let fake_ssh = root.join("ssh-fixture");
        write_owner_file(
            &fake_ssh,
            format!(
                r#"#!/bin/sh
known_hosts_file=''
identity_file=''
printf '%s\n' "$@" > '{}'
for argument in "$@"; do
  case "$argument" in
    UserKnownHostsFile=*) known_hosts_file=${{argument#UserKnownHostsFile=}} ;;
    IdentityFile=*) identity_file=${{argument#IdentityFile=}} ;;
  esac
done
printf '%s\n' "$known_hosts_file" > '{}'
printf '%s\n' "$identity_file" > '{}'
cat "$known_hosts_file" > '{}'
cat "$identity_file" > '{}'
while IFS= read -r _line; do :; done
"#,
                observed_arguments.display(),
                observed_known_hosts_path.display(),
                observed_identity_path.display(),
                observed_known_hosts.display(),
                observed_identity.display(),
            )
            .as_bytes(),
            true,
        );
        let config = RuntimeConfig {
            ssh_command: fake_ssh,
            ..RuntimeConfig::default()
        };
        let selected = selected_profile(root, &config, Some("remote-a")).unwrap();
        let known_hosts = paths["__KNOWN_HOSTS_A__"].clone();
        let replacement = root.join("known-hosts-a.next");
        let hook_known_hosts = known_hosts.clone();
        let connection = PersistentConnection::connect_with_material_hook(
            &selected,
            &config,
            Instant::now() + Duration::from_secs(2),
            move |opened_path| {
                if opened_path == hook_known_hosts {
                    write_owner_file(&replacement, b"replacement material\n", false);
                    std::fs::rename(&replacement, &hook_known_hosts).unwrap();
                }
            },
        )
        .await
        .unwrap();
        let observation_deadline = Instant::now() + Duration::from_secs(5);
        while (std::fs::read(&observed_known_hosts).ok().as_deref()
            != Some(original_known_hosts.as_slice())
            || std::fs::read(&observed_identity).ok().as_deref()
                != Some(original_identity.as_slice()))
            && Instant::now() < observation_deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            std::fs::read(&observed_known_hosts).unwrap(),
            original_known_hosts
        );
        assert_eq!(std::fs::read(&observed_identity).unwrap(), original_identity);
        let pinned_known_hosts = PathBuf::from(
            std::fs::read_to_string(&observed_known_hosts_path)
                .unwrap()
                .trim(),
        );
        let pinned_identity = PathBuf::from(
            std::fs::read_to_string(&observed_identity_path)
                .unwrap()
                .trim(),
        );
        assert_ne!(pinned_known_hosts, known_hosts);
        assert_ne!(pinned_identity, paths["__IDENTITY_A__"]);
        assert_eq!(
            std::fs::metadata(&pinned_known_hosts)
                .unwrap()
                .permissions()
                .mode()
                & 0o077,
            0
        );
        let material_owner = pinned_known_hosts.parent().unwrap().to_path_buf();
        assert!(pinned_identity.starts_with(&material_owner));
        assert_eq!(material_owner.parent(), Some(Path::new("/tmp")));
        assert!(material_owner.to_str().is_some_and(|path| {
            !path.contains('%')
                && !path.contains('$')
                && !path.chars().any(char::is_whitespace)
        }));
        let arguments = std::fs::read_to_string(&observed_arguments)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert!(arguments.contains(&"GlobalKnownHostsFile=/dev/null".into()));
        assert!(arguments.contains(&"PreferredAuthentications=publickey".into()));
        assert!(arguments.contains(&"GSSAPIAuthentication=no".into()));
        assert!(arguments.contains(&"HostbasedAuthentication=no".into()));
        assert!(arguments.contains(&"IdentitiesOnly=yes".into()));
        assert_eq!(
            arguments
                .iter()
                .filter(|argument| argument.starts_with("IdentityFile="))
                .collect::<Vec<_>>(),
            vec![&format!("IdentityFile={}", pinned_identity.display())]
        );
        connection.close().await;
        assert!(!material_owner.exists());
    }

    #[tokio::test]
    async fn ssh_fd_digest_rejects_same_size_mutation_after_unlink() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-ssh-reference-fd-mutation-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let paths = write_ssh_reference_fixture(root);
        write_catalog(root, remote_profile("remote-a", true));
        let spawn_log = root.join("spawn.log");
        let fake_ssh = root.join("ssh-fixture");
        write_owner_file(
            &fake_ssh,
            format!("#!/bin/sh\nprintf 'spawned\\n' >> '{}'\n", spawn_log.display())
                .as_bytes(),
            true,
        );
        let config = RuntimeConfig {
            ssh_command: fake_ssh,
            ..RuntimeConfig::default()
        };
        let selected = selected_profile(root, &config, Some("remote-a")).unwrap();
        let known_hosts = paths["__KNOWN_HOSTS_A__"].clone();
        let original_metadata = std::fs::metadata(&known_hosts).unwrap();
        let original_mtime = original_metadata.modified().unwrap();
        let replacement = root.join("known-hosts-a.next");
        write_owner_file(&replacement, b"replacement material\n", false);
        let mutator = OpenOptions::new().write(true).open(&known_hosts).unwrap();
        let hook_known_hosts = known_hosts.clone();

        let outcome = PersistentConnection::connect_with_material_hook(
            &selected,
            &config,
            Instant::now() + Duration::from_secs(2),
            move |opened_path| {
                if opened_path == hook_known_hosts {
                    std::fs::rename(&replacement, &hook_known_hosts).unwrap();
                    let mutated = b"mutated-material\n";
                    assert_eq!(mutated.len() as u64, original_metadata.len());
                    mutator.write_all_at(mutated, 0).unwrap();
                    mutator.sync_all().unwrap();
                    mutator
                        .set_times(std::fs::FileTimes::new().set_modified(original_mtime))
                        .unwrap();
                }
            },
        )
        .await;
        let error_code = match outcome {
            Ok(connection) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
                connection.close().await;
                None
            }
            Err(error) => Some(error.code),
        };
        let spawn_count = std::fs::read_to_string(&spawn_log)
            .map(|source| source.lines().count())
            .unwrap_or(0);
        assert_eq!(
            (error_code.as_deref(), spawn_count),
            (Some("backend_transport_reference_unavailable"), 0)
        );
    }

    #[test]
    fn compatibility_paths_require_an_exact_profile_fence() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-ssh-reference-compatibility-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let known_hosts = root.join("known-hosts");
        let identity = root.join("identity");
        write_owner_file(&known_hosts, b"fixture-host key\n", false);
        write_owner_file(&identity, b"fixture-private\n", false);
        write_catalog_profiles(
            root,
            vec![
                remote_profile("remote-a", true),
                remote_profile("remote-b", false),
            ],
        );
        let wrong_fence = RuntimeConfig {
            ssh_reference_profile_override: Some("remote-b".into()),
            known_hosts_override: Some(known_hosts.clone()),
            identity_override: Some(identity.clone()),
            ..RuntimeConfig::default()
        };
        assert_eq!(
            selected_profile(root, &wrong_fence, Some("remote-a"))
                .unwrap_err()
                .code,
            "backend_transport_reference_unavailable"
        );
        let fenced = RuntimeConfig {
            ssh_reference_profile_override: Some("remote-a".into()),
            known_hosts_override: Some(known_hosts),
            identity_override: Some(identity),
            ..RuntimeConfig::default()
        };
        assert!(selected_profile(root, &fenced, Some("remote-a")).is_ok());
        assert_eq!(
            selected_profile(root, &fenced, Some("remote-b"))
                .unwrap_err()
                .code,
            "backend_transport_reference_unavailable"
        );
    }

    #[test]
    fn canonical_profile_maximum_deadline_is_accepted() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-backend-profile-deadline-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut profile = local_profile(&root.join("backend.sock"));
        profile["deadlineMs"] = Value::from(45_000);
        write_catalog(root, profile);

        let selected = selected_profile(root, &RuntimeConfig::default(), Some("local")).unwrap();

        assert_eq!(selected.profile.deadline_ms, 45_000);
    }

    #[tokio::test]
    async fn managed_recovery_accepts_a_new_generation_for_the_same_local_profile() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-managed-recovery-generation-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut next_profile = local_profile(&root.join("backend-next.sock"));
        next_profile["expected"]["generation"] =
            Value::from("local-v1-22222222222222222222222222222222");
        write_catalog(root, local_profile(&root.join("backend.sock")));
        let current = selected_profile(root, &RuntimeConfig::default(), Some("local")).unwrap();
        replace_catalog(root, next_profile);
        let next = selected_profile(root, &RuntimeConfig::default(), Some("local")).unwrap();
        let (recovery, mut requests) =
            crate::dure_backend_coordinator::ManagedBackendCoordinatorHandle::ready_for_test(
                current.profile.clone(),
            );

        let ticket = recovery.begin_recovery(&current.profile).unwrap();
        assert_eq!(requests.recv().await.unwrap(), ticket);
        recovery.complete_for_test(&ticket, next.profile);

        assert!(recovery.wait_for_recovery(&ticket).await.is_ok());
    }

    #[tokio::test]
    async fn repeated_local_requests_reuse_one_profile_generation_connection() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-persistent-local-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket_path = root.join("backend.sock");
        write_catalog(root, local_profile(&socket_path));
        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            for _ in 0..2 {
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(request["connection"]["mode"], "persistent_v1");
                stream
                    .get_mut()
                    .write_all(&response_for(
                        &request,
                        "dure-local",
                        "local-v1-11111111111111111111111111111111",
                    ))
                    .await
                    .unwrap();
            }
        });
        let state = DureBackendTransportState {
            config: RuntimeConfig {
                profile_selector_override: Some("local".into()),
                ..RuntimeConfig::default()
            },
            ..DureBackendTransportState::default()
        };
        let request_body = || {
            json!({
                "schemaVersion": 1,
                "namespace": {
                    "tenantId": "tenant",
                    "userId": "user",
                    "clientId": "client"
                }
            })
        };
        let first_route = selected_route("local");
        let second_route = selected_route("local");
        let first = state
            .request(
                root,
                &first_route,
                "client_view.authority.read",
                request_body(),
            )
            .await;
        let second = state
            .request(
                root,
                &second_route,
                "client_view.authority.read",
                request_body(),
            )
            .await;
        for result in [first.unwrap(), second.unwrap()] {
            assert_eq!(result.backend_id, "dure-local");
        }
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("the request must reach the fixture backend")
            .unwrap();
        state.close().await;
    }

    #[tokio::test]
    async fn exact_route_change_is_rejected_before_the_replacement_backend_sees_a_request() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-exact-route-before-effect-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let original_socket = root.join("original.sock");
        write_catalog(root, local_profile(&original_socket));
        let captured = route_authority::authority_for(
            &selected_profile(root, &RuntimeConfig::default(), Some("local")).unwrap(),
        );

        let replacement_socket = root.join("replacement.sock");
        replace_catalog(root, local_profile(&replacement_socket));
        let listener = tokio::net::UnixListener::bind(&replacement_socket).unwrap();
        let replacement_observer = tokio::spawn(async move {
            let accepted = tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
            let Ok(Ok((stream, _))) = accepted else {
                return false;
            };
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            stream
                .get_mut()
                .write_all(&response_for(
                    &request,
                    "dure-local",
                    "local-v1-11111111111111111111111111111111",
                ))
                .await
                .unwrap();
            true
        });
        let state = DureBackendTransportState::default();

        let error = state
            .request(
                root,
                &DureBackendRouteV1::Exact {
                    authority: captured,
                },
                "client_view.authority.read",
                json!({ "schemaVersion": 1 }),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, "backend_transport_authority_changed");
        assert!(
            !replacement_observer.await.unwrap(),
            "the replacement backend observed a request before route authority was checked"
        );
    }

    #[tokio::test]
    async fn unrelated_profile_change_keeps_the_exact_selected_route_valid() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-exact-route-unrelated-profile-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket_path = root.join("backend.sock");
        let local = local_profile(&socket_path);
        write_catalog_profiles(
            root,
            vec![local.clone(), remote_profile("remote-build", false)],
        );
        let captured = route_authority::authority_for(
            &selected_profile(root, &RuntimeConfig::default(), Some("local")).unwrap(),
        );
        let mut changed_remote = remote_profile("remote-build", false);
        changed_remote["expected"]["generation"] = Value::String("generation-remote-next".into());
        replace_catalog_profiles(root, vec![local, changed_remote]);

        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            stream
                .get_mut()
                .write_all(&response_for(
                    &request,
                    "dure-local",
                    "local-v1-11111111111111111111111111111111",
                ))
                .await
                .unwrap();
        });
        let state = DureBackendTransportState::default();
        let result = state
            .request(
                root,
                &DureBackendRouteV1::Exact {
                    authority: captured,
                },
                "client_view.authority.read",
                json!({ "schemaVersion": 1 }),
            )
            .await
            .unwrap();

        assert_eq!(result.backend_id, "dure-local");
        server.await.unwrap();
        state.close().await;
    }

    #[tokio::test]
    async fn selected_read_reconstructs_a_complete_route_authority() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-selected-route-authority-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket_path = root.join("backend.sock");
        write_catalog(root, local_profile(&socket_path));
        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            stream
                .get_mut()
                .write_all(&response_for(
                    &request,
                    "dure-local",
                    "local-v1-11111111111111111111111111111111",
                ))
                .await
                .unwrap();
        });
        let state = DureBackendTransportState::default();

        let result = state
            .request(
                root,
                &selected_route("local"),
                "client_view.authority.read",
                json!({ "schemaVersion": 1 }),
            )
            .await
            .unwrap();
        let route = serde_json::to_value(result.route_authority).unwrap();

        assert_eq!(route["schemaVersion"], 1);
        assert_eq!(route["profileId"], "local");
        assert_eq!(route["backend"]["id"], "dure-local");
        assert_eq!(route["target"], json!({ "source": "local", "hostId": "local" }));
        assert!(route["revision"]
            .as_str()
            .is_some_and(|revision| revision.starts_with("sha256:") && revision.len() == 71));
        server.await.unwrap();
        state.close().await;
    }

    #[tokio::test]
    async fn request_started_before_profile_catalog_waits_for_startup_readiness() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-request-before-profile-ready-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket_path = root.join("backend.sock");
        let recovery =
            crate::dure_backend_coordinator::ManagedBackendCoordinatorHandle::starting_for_test();
        let state = DureBackendTransportState {
            recovery: recovery.clone(),
            ..DureBackendTransportState::default()
        };
        let route = selected_route("local");
        let body = json!({
            "schemaVersion": 1,
            "spawnOperationId": "spawn-1"
        });
        let request = state.request(root, &route, "dispatch.stop.status", body);
        tokio::pin!(request);

        let premature = tokio::time::timeout(Duration::from_millis(50), &mut request).await;
        assert!(
            premature.is_err(),
            "the original status request must remain pending until startup publishes readiness"
        );

        write_catalog(root, local_profile(&socket_path));
        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["operation"], "dispatch.stop.status");
            stream
                .get_mut()
                .write_all(&response_for(
                    &request,
                    "dure-local",
                    "local-v1-11111111111111111111111111111111",
                ))
                .await
                .unwrap();
        });
        let selected = route_authority::select(root, &RuntimeConfig::default(), &route).unwrap();
        recovery.complete_startup_for_test(selected.profile);

        let result = tokio::time::timeout(Duration::from_secs(1), &mut request)
            .await
            .expect("the original request must resume after startup readiness")
            .unwrap();

        assert_eq!(result.backend_id, "dure-local");
        server.await.unwrap();
        state.close().await;
    }

    #[tokio::test]
    async fn eof_reconnect_retries_once_with_the_same_request_identity() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-persistent-retry-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket_path = root.join("backend.sock");
        write_catalog(root, local_profile(&socket_path));
        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let mut request_ids = Vec::new();
            for attempt in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                request_ids.push(request["requestId"].as_str().unwrap().to_string());
                if attempt == 1 {
                    stream
                        .get_mut()
                        .write_all(&response_for(
                            &request,
                            "dure-local",
                            "local-v1-11111111111111111111111111111111",
                        ))
                        .await
                        .unwrap();
                }
            }
            request_ids
        });
        let state = DureBackendTransportState {
            config: RuntimeConfig {
                profile_selector_override: Some("local".into()),
                ..RuntimeConfig::default()
            },
            ..DureBackendTransportState::default()
        };
        let result = state
            .request(
                root,
                &selected_route("local"),
                "client_view.authority.read",
                json!({ "schemaVersion": 1, "namespace": {
                    "tenantId": "tenant", "userId": "user", "clientId": "client"
                }}),
            )
            .await
            .unwrap();
        assert_eq!(result.backend_id, "dure-local");
        let request_ids = server.await.unwrap();
        assert_eq!(request_ids.len(), 2);
        assert_eq!(request_ids[0], request_ids[1]);
        state.close().await;
    }

    async fn request_across_profile_generation_change(
        operation: &'static str,
        body: Value,
    ) -> (
        Result<DureBackendTransportResult, DureBackendTransportError>,
        bool,
    ) {
        let temporary = tempfile::Builder::new()
            .prefix("dure-persistent-generation-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket_path = root.join("backend.sock");
        write_catalog(root, local_profile(&socket_path));
        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let root_for_server = root.to_path_buf();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            let mut next_profile = local_profile(&root_for_server.join("backend-next.sock"));
            next_profile["expected"]["generation"] =
                Value::String("local-v1-22222222222222222222222222222222".into());
            replace_catalog(&root_for_server, next_profile);
            stream
                .get_mut()
                .write_all(&response_for(
                    &request,
                    "dure-local",
                    "local-v1-11111111111111111111111111111111",
                ))
                .await
                .unwrap();
        });
        let state = DureBackendTransportState {
            config: RuntimeConfig {
                profile_selector_override: Some("local".into()),
                ..RuntimeConfig::default()
            },
            ..DureBackendTransportState::default()
        };
        let result = state
            .request(root, &selected_route("local"), operation, body)
            .await;
        let cached = state.has_cached_connection("local").await;
        server.await.unwrap();
        state.close().await;
        (result, cached)
    }

    #[tokio::test]
    async fn durable_observation_keeps_a_completed_inflight_response() {
        let (result, cached) = request_across_profile_generation_change(
            "agent_conversation.read",
            json!({
                "schemaVersion": 1,
                "interactionSessionId": "interaction-1",
                "cursor": null,
                "limit": 100,
            }),
        )
        .await;
        let result = result.unwrap();
        assert_eq!(
            result.backend_generation,
            "local-v1-11111111111111111111111111111111"
        );
        assert!(cached);
    }

    #[tokio::test]
    async fn durable_observation_bypasses_active_recovery_while_mutation_waits() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-persistent-active-recovery-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket_path = root.join("backend.sock");
        write_catalog(root, local_profile(&socket_path));
        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            stream
                .get_mut()
                .write_all(&response_for(
                    &request,
                    "dure-local",
                    "local-v1-11111111111111111111111111111111",
                ))
                .await
                .unwrap();
        });
        let route = selected_route("local");
        let selected = route_authority::select(root, &RuntimeConfig::default(), &route).unwrap();
        let (recovery, _incidents) =
            crate::dure_backend_coordinator::ManagedBackendCoordinatorHandle::ready_for_test(
                selected.profile.clone(),
            );
        let ticket = recovery.begin_recovery(&selected.profile).unwrap();
        let state = DureBackendTransportState {
            config: RuntimeConfig {
                profile_selector_override: Some("local".into()),
                ..RuntimeConfig::default()
            },
            recovery: recovery.clone(),
            ..DureBackendTransportState::default()
        };

        let observed = tokio::time::timeout(
            Duration::from_millis(250),
            state.request(
                root,
                &route,
                "agent_conversation.read",
                json!({
                    "schemaVersion": 1,
                    "interactionSessionId": "interaction-1",
                    "cursor": null,
                    "limit": 100,
                }),
            ),
        )
        .await
        .expect("durable observation must not wait for backend recovery")
        .unwrap();
        assert_eq!(
            observed.backend_generation,
            "local-v1-11111111111111111111111111111111"
        );

        let mutation = tokio::time::timeout(
            Duration::from_millis(50),
            state.request(
                root,
                &route,
                "agent_runtime.transition",
                json!({ "schemaVersion": 1 }),
            ),
        )
        .await;
        assert!(
            mutation.is_err(),
            "mutation must wait for recovery authority"
        );

        recovery.complete_for_test(&ticket, selected.profile);
        server.await.unwrap();
        state.close().await;
    }

    #[tokio::test]
    async fn mutation_discards_a_response_from_a_superseded_generation() {
        let (result, cached) = request_across_profile_generation_change(
            "agent_runtime.transition",
            json!({ "schemaVersion": 1 }),
        )
        .await;
        assert_eq!(
            result.unwrap_err().code,
            "backend_transport_generation_changed"
        );
        assert!(!cached);
    }

    #[tokio::test]
    async fn queue_count_backpressure_waits_for_capacity() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-persistent-queue-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        write_catalog(root, local_profile(&root.join("never-opened.sock")));
        let state = DureBackendTransportState {
            config: RuntimeConfig {
                profile_selector_override: Some("local".into()),
                ..RuntimeConfig::default()
            },
            ..DureBackendTransportState::default()
        };
        let capacity = Arc::clone(&state.queue_slots)
            .acquire_many_owned(MAX_QUEUE_COUNT as u32)
            .await
            .unwrap();
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            drop(capacity);
        });
        let error = state
            .request(
                root,
                &selected_route("local"),
                "client_view.authority.read",
                json!({ "schemaVersion": 1 }),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "backend_transport_unavailable");
        assert!(!state.has_cached_connection("local").await);
        release.await.unwrap();
    }

    #[tokio::test]
    async fn repeated_ssh_requests_reuse_and_then_reap_the_exact_child() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-persistent-ssh-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let known_hosts = root.join("known-hosts");
        write_owner_file(&known_hosts, b"fixture\n", false);
        let spawn_log = root.join("spawn.log");
        let material_log = root.join("material.log");
        let argument_log = root.join("arguments.log");
        let fake_ssh = root.join("ssh-fixture");
        write_owner_file(
            &fake_ssh,
            format!(
                r#"#!/bin/sh
known_hosts_file=''
printf '%s\n' "$@" > '{}'
for argument in "$@"; do
  case "$argument" in
    UserKnownHostsFile=*) known_hosts_file=${{argument#UserKnownHostsFile=}} ;;
  esac
done
printf '%s\n' "$known_hosts_file" > '{}'
printf '%s\n' "$$" >> '{}'
while IFS= read -r line; do
  request_id=$(printf '%s\n' "$line" | sed -E 's/.*"requestId":"([^"]+)".*/\1/')
  observed_at_ms=$(($(date +%s) * 1000))
  printf '{{"schemaVersion":1,"apiVersion":"dure.backend-transport/v1","kind":"dure.backend.response","requestId":"%s","backend":{{"id":"remote-backend","generation":"remote-v1","protocol":{{"major":1,"minor":0}},"capabilities":["backend.connection.persistent","backend.transport.ssh_gateway","client_view.authority.read"],"observedAtMs":%s}},"result":{{"schemaVersion":1,"authority":null}}}}\n' "$request_id" "$observed_at_ms"
done
"#,
                argument_log.display(),
                material_log.display(),
                spawn_log.display()
            )
            .as_bytes(),
            true,
        );
        write_catalog(
            root,
            json!({
                "id": "remote",
                "default": true,
                "transport": {
                    "kind": "ssh",
                    "host": "build.example.test",
                    "port": 22,
                    "user": "dure_runner",
                    "endpoint": {
                        "kind": "unix_socket",
                        "path": "/srv/dure/backend/control-plane.sock"
                    }
                },
                "auth": { "kind": "ssh_agent" },
                "trust": {
                    "kind": "known_hosts",
                    "reference": "known-hosts-profile:remote"
                },
                "expected": {
                    "backendId": "remote-backend",
                    "generation": "remote-v1",
                    "protocol": {
                        "minimum": { "major": 1, "minor": 0 },
                        "maximum": { "major": 1, "minor": 0 }
                    },
                    "capabilities": [
                        "backend.connection.persistent",
                        "backend.transport.ssh_gateway",
                        "client_view.authority.read"
                    ]
                }
            }),
        );
        let state = DureBackendTransportState {
            config: RuntimeConfig {
                ssh_command: fake_ssh,
                profile_selector_override: Some("remote".into()),
                ssh_reference_profile_override: Some("remote".into()),
                known_hosts_override: Some(known_hosts),
                identity_override: None,
            },
            ..DureBackendTransportState::default()
        };
        state
            .request(
                root,
                &selected_route("remote"),
                "client_view.authority.read",
                json!({ "schemaVersion": 1, "namespace": {
                    "tenantId": "tenant", "userId": "user", "clientId": "client"
                }}),
            )
            .await
            .unwrap();
        let pid = std::fs::read_to_string(&spawn_log)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        let pinned_known_hosts = PathBuf::from(
            std::fs::read_to_string(&material_log).unwrap().trim(),
        );
        let material_owner = pinned_known_hosts.parent().unwrap();
        assert!(
            !material_owner.exists(),
            "pinned SSH material survived the first validated backend frame"
        );
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            0,
            "the cached SSH child did not survive material release"
        );
        let arguments = std::fs::read_to_string(&argument_log)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert!(arguments.contains(&"GlobalKnownHostsFile=/dev/null".into()));
        assert!(arguments.contains(&"IdentityFile=none".into()));
        assert!(arguments.contains(&"IdentitiesOnly=no".into()));
        assert!(!arguments.iter().any(|argument| {
            argument.starts_with("IdentityFile=") && argument != "IdentityFile=none"
        }));
        state
            .request(
                root,
                &selected_route("remote"),
                "client_view.authority.read",
                json!({ "schemaVersion": 1, "namespace": {
                    "tenantId": "tenant", "userId": "user", "clientId": "client"
                }}),
            )
            .await
            .unwrap();
        let pids = std::fs::read_to_string(&spawn_log).unwrap();
        let pids = pids.lines().collect::<Vec<_>>();
        assert_eq!(pids.len(), 1, "SSH transport spawned more than one child");
        state.close().await;
        let deadline = Instant::now() + Duration::from_secs(1);
        while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_ne!(
            unsafe { libc::kill(pid, 0) },
            0,
            "exact SSH child survived cleanup"
        );
    }

    #[tokio::test]
    async fn request_deadline_retires_a_nonresponsive_connection() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-persistent-timeout-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket_path = root.join("backend.sock");
        let mut profile = local_profile(&socket_path);
        profile["deadlineMs"] = Value::from(50);
        write_catalog(root, profile);
        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            tokio::time::sleep(Duration::from_millis(150)).await;
        });
        let state = DureBackendTransportState {
            config: RuntimeConfig {
                profile_selector_override: Some("local".into()),
                ..RuntimeConfig::default()
            },
            ..DureBackendTransportState::default()
        };
        let error = state
            .request(
                root,
                &selected_route("local"),
                "client_view.authority.read",
                json!({ "schemaVersion": 1 }),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "backend_transport_timeout");
        assert!(!state.has_cached_connection("local").await);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn ssh_child_failure_is_typed_as_auth_or_transport_failure() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-persistent-ssh-failure-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let fake_ssh = root.join("ssh-failure");
        write_owner_file(&fake_ssh, b"#!/bin/sh\nexit 255\n", true);
        let known_hosts = root.join("known-hosts");
        write_owner_file(&known_hosts, b"fixture-host key\n", false);
        let selected = SelectedProfile {
            profile: BackendProfile {
                id: "remote".into(),
                default: true,
                transport: ProfileTransport::Ssh {
                    host: "build.example.test".into(),
                    port: 22,
                    user: "dure_runner".into(),
                    endpoint: ProfileEndpoint::Tcp {
                        host: "127.0.0.1".into(),
                        port: 4681,
                    },
                    batch_mode: true,
                    strict_host_key_checking: "yes".into(),
                    connect_timeout_ms: Some(1_000),
                },
                auth: ProfileAuth::SshAgent,
                trust: ProfileTrust::KnownHosts {
                    reference: "known-hosts-profile:remote".into(),
                },
                expected: ExpectedBackend {
                    backend_id: "remote-backend".into(),
                    generation: "remote-v1".into(),
                    protocol: ProtocolRange {
                        minimum: ProtocolVersion { major: 1, minor: 0 },
                        maximum: ProtocolVersion { major: 1, minor: 0 },
                    },
                    capabilities: vec![PERSISTENT_CAPABILITY.into()],
                },
                deadline_ms: 1_000,
            },
            ssh_references: Some(SshReferences {
                known_hosts_file: ssh_references::material_identity_with_hook(
                    known_hosts,
                    || {},
                )
                .unwrap(),
                identity_file: None,
            }),
            catalog_profile_ids: BTreeSet::from(["remote".into()]),
        };
        let config = RuntimeConfig {
            ssh_command: fake_ssh,
            ..RuntimeConfig::default()
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut connection = PersistentConnection::connect(&selected, &config, deadline)
            .await
            .unwrap();
        let error = connection.exchange(b"{}\n", deadline).await.unwrap_err();
        assert_eq!(error.code, "backend_transport_ssh_failed");
        connection.close().await;
    }

    #[tokio::test]
    async fn malformed_ssh_handshake_retains_material_until_the_child_is_reaped() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-persistent-ssh-handshake-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let known_hosts = root.join("known-hosts");
        write_owner_file(&known_hosts, b"fixture-host key\n", false);
        let material_log = root.join("material.log");
        let pid_log = root.join("pid.log");
        let fake_ssh = root.join("ssh-handshake-failure");
        write_owner_file(
            &fake_ssh,
            format!(
                r#"#!/bin/sh
known_hosts_file=''
for argument in "$@"; do
  case "$argument" in
    UserKnownHostsFile=*) known_hosts_file=${{argument#UserKnownHostsFile=}} ;;
  esac
done
printf '%s\n' "$known_hosts_file" > '{}'
printf '%s\n' "$$" > '{}'
while IFS= read -r _line; do
  printf 'not-json\n'
done
"#,
                material_log.display(),
                pid_log.display(),
            )
            .as_bytes(),
            true,
        );
        let mut selected = ssh_selected(ProfileEndpoint::Tcp {
            host: "127.0.0.1".into(),
            port: 4681,
        });
        selected
            .ssh_references
            .as_mut()
            .unwrap()
            .known_hosts_file =
            ssh_references::material_identity_with_hook(known_hosts, || {}).unwrap();
        let config = RuntimeConfig {
            ssh_command: fake_ssh,
            ..RuntimeConfig::default()
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut connection = PersistentConnection::connect(&selected, &config, deadline)
            .await
            .unwrap();
        let response = connection.exchange(b"{}\n", deadline).await.unwrap();
        let error = parse_response(&response, "request-1", &selected, &[PERSISTENT_CAPABILITY])
            .unwrap_err();
        assert_eq!(error.code, "backend_transport_malformed_response");
        let pinned_known_hosts = PathBuf::from(
            std::fs::read_to_string(&material_log).unwrap().trim(),
        );
        let material_owner = pinned_known_hosts.parent().unwrap().to_path_buf();
        let pid = std::fs::read_to_string(&pid_log)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        assert!(material_owner.exists());
        let owner_during_close = material_owner.clone();
        connection
            .close_with_material_hook(move || {
                assert_ne!(
                    unsafe { libc::kill(pid, 0) },
                    0,
                    "SSH material cleanup ran before the exact child was reaped"
                );
                assert!(owner_during_close.exists());
            })
            .await;
        assert!(!material_owner.exists());
    }

    #[test]
    fn malformed_and_miscorrelated_responses_fail_closed() {
        let temporary = tempfile::Builder::new()
            .prefix("dure-persistent-response-")
            .tempdir_in("/tmp")
            .unwrap();
        let root = temporary.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).unwrap();
        write_catalog(root, local_profile(&root.join("backend.sock")));
        let config = RuntimeConfig {
            profile_selector_override: Some("local".into()),
            ..RuntimeConfig::default()
        };
        let selected = selected_profile(root, &config, None).unwrap();
        let malformed = parse_response(
            b"not-json\n",
            "request-1",
            &selected,
            &["client_view.authority.read", PERSISTENT_CAPABILITY],
        )
        .unwrap_err();
        assert_eq!(malformed.code, "backend_transport_malformed_response");
        let source = response_for(
            &json!({ "requestId": "different-request" }),
            "dure-local",
            "local-v1-11111111111111111111111111111111",
        );
        let mismatch = parse_response(
            &source,
            "request-1",
            &selected,
            &["client_view.authority.read", PERSISTENT_CAPABILITY],
        )
        .unwrap_err();
        assert_eq!(mismatch.code, "backend_transport_handshake_mismatch");
    }

    #[test]
    fn strict_ssh_arguments_keep_forwarding_non_interactive() {
        let selected = ssh_selected(ProfileEndpoint::Tcp {
            host: "127.0.0.1".into(),
            port: 4681,
        });
        let references = selected.ssh_references.as_ref().unwrap();
        let arguments = ssh_arguments(
            &selected,
            &references.known_hosts_file.path,
            references
                .identity_file
                .as_ref()
                .map(|identity| identity.path.as_path()),
        )
        .unwrap();
        assert!(arguments.windows(2).any(|pair| pair == ["-F", "/dev/null"]));
        assert!(arguments.contains(&"BatchMode=yes".into()));
        assert!(arguments.contains(&"StrictHostKeyChecking=yes".into()));
        assert!(arguments.contains(&"PasswordAuthentication=no".into()));
        assert!(arguments.contains(&"GlobalKnownHostsFile=/dev/null".into()));
        assert!(arguments.contains(&"PreferredAuthentications=publickey".into()));
        assert!(arguments.contains(&"GSSAPIAuthentication=no".into()));
        assert!(arguments.contains(&"HostbasedAuthentication=no".into()));
        assert!(arguments.contains(&"IdentityFile=none".into()));
        assert!(arguments.contains(&"IdentitiesOnly=no".into()));
        assert!(arguments.contains(&"127.0.0.1:4681".into()));
        assert_eq!(
            arguments.last().map(String::as_str),
            Some("build.example.test")
        );
    }

    #[test]
    fn strict_ssh_arguments_use_the_fixed_unix_gateway() {
        let selected = ssh_selected(ProfileEndpoint::UnixSocket {
            path: PathBuf::from("/srv/dure/backend/control-plane.sock"),
        });
        let references = selected.ssh_references.as_ref().unwrap();
        let arguments = ssh_arguments(
            &selected,
            &references.known_hosts_file.path,
            references
                .identity_file
                .as_ref()
                .map(|identity| identity.path.as_path()),
        )
        .unwrap();
        assert!(!arguments.iter().any(|argument| argument == "-W"));
        assert_eq!(
            &arguments[arguments.len() - 7..],
            [
                "build.example.test",
                DURE_CONTROL_PLANE_GATEWAY,
                "gateway",
                "--socket-hex",
                "2f7372762f647572652f6261636b656e642f636f6e74726f6c2d706c616e652e736f636b",
                "--expected-generation",
                "remote-v1",
            ]
        );
    }

    #[tokio::test]
    async fn bounded_line_rejects_eof_without_a_frame() {
        let mut reader = BufReader::new(&b"{}"[..]);
        let error = read_bounded_line(&mut reader).await.unwrap_err();
        assert_eq!(error.code, "backend_transport_eof");
    }

    #[tokio::test]
    async fn close_drops_the_cached_exact_connection() {
        let state = DureBackendTransportState::default();
        state.close().await;
        assert!(state.connections.lock().unwrap().is_empty());
    }
}
