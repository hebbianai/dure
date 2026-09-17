//! Thin client adapter for the standalone Dure checkpoint control plane.
//!
//! The adapter selects only the canonical local profile and forwards reads over
//! the versioned Unix-socket transport. It never opens the backend database.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use dure_app::{
    AgentCheckpointRecordV1, AgentIdV1, AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
    MAX_BACKEND_CAPABILITIES_V1,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::{timeout, Duration};

const MAX_CATALOG_BYTES: u64 = 64 * 1024;
const MAX_TRANSPORT_BYTES: u64 = 256 * 1024;
const BACKEND_PROTOCOL_API: &str = "dure.backend-transport/v1";
const REQUIRED_CAPABILITY: &str = "agent_checkpoint.observe";
const SERVICE_DESCRIPTOR_SCHEMAS: [u16; 5] = [1, 2, 3, 4, 5];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    schema_version: u16,
    kind: String,
    profiles: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalProfile {
    id: String,
    #[serde(default, rename = "default")]
    _default: bool,
    transport: LocalTransport,
    auth: KindOnly,
    trust: KindOnly,
    expected: ExpectedLocal,
    deadline_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalTransport {
    kind: String,
    endpoint: LocalEndpoint,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalEndpoint {
    kind: String,
    path: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KindOnly {
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedLocal {
    backend_id: String,
    generation: String,
    protocol: ProtocolRange,
    capabilities: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtocolRange {
    minimum: ProtocolVersion,
    maximum: ProtocolVersion,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtocolVersion {
    major: u16,
    minor: u16,
}

#[derive(Debug)]
struct SelectedLocalProfile {
    generation: String,
    capabilities: BTreeSet<String>,
    socket_path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceDescriptor {
    schema_version: u16,
    backend_id: String,
    build_id: String,
    generation: String,
    activation_source_generation: Option<String>,
    socket_path: PathBuf,
    database_path: PathBuf,
    #[serde(default, rename = "controlPlaneIdentity")]
    control_plane_identity: Option<serde_json::Value>,
    hmux_executable_path: PathBuf,
    hmux_executable_device: String,
    hmux_executable_inode: String,
    hmux_executable_size: String,
    hmux_executable_modified: String,
    hmux_executable_sha256: String,
    hmux_runtime_executable_path: PathBuf,
    hmux_runtime_executable_device: String,
    hmux_runtime_executable_inode: String,
    hmux_runtime_executable_size: String,
    hmux_runtime_executable_modified: String,
    hmux_runtime_executable_sha256: String,
    hmux_discovery_root: PathBuf,
    hmux_discovery_device: String,
    hmux_discovery_inode: String,
    process_id: u32,
    observed_at_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackendObservation {
    id: String,
    generation: String,
    protocol: ProtocolVersion,
    capabilities: Vec<String>,
    observed_at_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObserveResult {
    schema_version: u16,
    records: Vec<ObservedCheckpoint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObservedCheckpoint {
    record: AgentCheckpointRecordV1,
    binding: ObservedBinding,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObservedBinding {
    session_id: String,
    workspace_id: String,
    binding_generation: i64,
    stop_fence: ObservedStopFence,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObservedStopFence {
    runner_principal: String,
    runner_instance: String,
    channel_epoch: String,
    host_instance_id: String,
    terminal_epoch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DureCheckpointProjectedRecord {
    #[serde(flatten)]
    record: AgentCheckpointRecordV1,
    observed_binding: ObservedBinding,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObserveResponse {
    schema_version: u16,
    api_version: String,
    kind: String,
    request_id: String,
    backend: BackendObservation,
    result: ObserveResult,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DureCheckpointObservation {
    schema_version: u16,
    backend_id: String,
    backend_generation: String,
    records: Vec<DureCheckpointProjectedRecord>,
}

fn read_owner_file(path: &Path) -> Result<String, String> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(format!("checkpoint profile unavailable: {error}")),
    };
    let before = file
        .metadata()
        .map_err(|error| format!("checkpoint profile metadata unavailable: {error}"))?;
    if !before.is_file()
        || before.uid() != unsafe { libc::geteuid() }
        || before.mode() & 0o077 != 0
        || before.len() == 0
        || before.len() > MAX_CATALOG_BYTES
    {
        return Err("checkpoint profile must be an owner-only regular file".into());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    let mut bounded = (&mut file).take(MAX_CATALOG_BYTES + 1);
    bounded
        .read_to_end(&mut bytes)
        .map_err(|error| format!("checkpoint profile read failed: {error}"))?;
    let after = file
        .metadata()
        .map_err(|error| format!("checkpoint profile metadata unavailable: {error}"))?;
    if bytes.len() as u64 != before.len()
        || after.dev() != before.dev()
        || after.ino() != before.ino()
        || after.len() != before.len()
        || after.modified().ok() != before.modified().ok()
        || after.ctime() != before.ctime()
        || after.ctime_nsec() != before.ctime_nsec()
    {
        return Err("checkpoint profile changed while it was read".into());
    }
    String::from_utf8(bytes).map_err(|_| "checkpoint profile is not UTF-8".into())
}

fn valid_generation(value: &str) -> bool {
    value.strip_prefix("local-v1-").is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn valid_capability(value: &str) -> bool {
    value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_control_plane_build_id(value: &str) -> bool {
    value
        .strip_prefix("dure-control-plane/v")
        .is_some_and(valid_capability)
}

fn now_ms() -> Result<i64, String> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "checkpoint observer clock is invalid")?
        .as_millis();
    i64::try_from(value).map_err(|_| "checkpoint observer clock is out of range".into())
}

fn request_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "checkpoint request identity is unavailable")?;
    let mut request_id = String::with_capacity("observe-".len() + bytes.len() * 2);
    request_id.push_str("observe-");
    for byte in bytes {
        write!(&mut request_id, "{byte:02x}")
            .map_err(|_| "checkpoint request identity is unavailable")?;
    }
    Ok(request_id)
}

async fn observe_local_checkpoints(
    root: &Path,
    selected: &SelectedLocalProfile,
    agent_ids: Vec<String>,
) -> Result<Vec<DureCheckpointProjectedRecord>, String> {
    if agent_ids.len() > 256 {
        return Err("checkpoint observation is too large".into());
    }
    let descriptor_source = read_owner_file(&root.join("backend/control-plane.json"))?;
    if descriptor_source.is_empty() {
        return Err("checkpoint control plane is unavailable".into());
    }
    let descriptor: ServiceDescriptor = serde_json::from_str(&descriptor_source)
        .map_err(|_| "checkpoint control-plane descriptor is invalid")?;
    let expected_database_path = root.join("backend/application-state.sqlite3");
    if !SERVICE_DESCRIPTOR_SCHEMAS.contains(&descriptor.schema_version)
        || descriptor.backend_id != "dure-local"
        || !valid_control_plane_build_id(&descriptor.build_id)
        || descriptor.generation != selected.generation.as_str()
        || !valid_generation(&descriptor.generation)
        || descriptor
            .activation_source_generation
            .as_deref()
            .is_some_and(|source| {
                !matches!(descriptor.schema_version, 3..=5)
                    || !valid_generation(source)
                    || source == descriptor.generation
            })
        || descriptor.socket_path != selected.socket_path
        || descriptor.database_path != expected_database_path
        || (descriptor.schema_version <= 3) != descriptor.control_plane_identity.is_none()
        || !descriptor.hmux_executable_path.is_absolute()
        || descriptor.hmux_executable_device.is_empty()
        || descriptor.hmux_executable_inode.is_empty()
        || descriptor.hmux_executable_size.is_empty()
        || descriptor.hmux_executable_modified.is_empty()
        || descriptor.hmux_executable_sha256.len() != 64
        || !descriptor
            .hmux_executable_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !descriptor.hmux_runtime_executable_path.is_absolute()
        || descriptor.hmux_runtime_executable_device.is_empty()
        || descriptor.hmux_runtime_executable_inode.is_empty()
        || descriptor.hmux_runtime_executable_size.is_empty()
        || descriptor.hmux_runtime_executable_modified.is_empty()
        || descriptor.hmux_runtime_executable_sha256.len() != 64
        || !descriptor
            .hmux_runtime_executable_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !descriptor.hmux_discovery_root.is_absolute()
        || descriptor.hmux_discovery_device.is_empty()
        || descriptor.hmux_discovery_inode.is_empty()
        || descriptor.process_id == 0
        || descriptor.observed_at_ms < 0
    {
        return Err("checkpoint control-plane descriptor is incompatible".into());
    }
    let mut requested = Vec::with_capacity(agent_ids.len());
    let mut requested_ids = BTreeSet::new();
    for agent_id in agent_ids {
        let agent_id =
            AgentIdV1::new(agent_id).map_err(|_| "checkpoint observation agent id is invalid")?;
        if !requested_ids.insert(agent_id.to_string()) {
            return Err("checkpoint observation agent id is duplicated".into());
        }
        requested.push(agent_id);
    }
    let request_id = request_id()?;
    let request = json!({
        "schemaVersion": 1,
        "apiVersion": BACKEND_PROTOCOL_API,
        "kind": "dure.backend.request",
        "requestId": request_id,
        "operation": "agent_checkpoint.observe",
        "expected": {
            "backendId": descriptor.backend_id,
            "generation": descriptor.generation,
            "protocol": {
                "minimum": { "major": 1, "minor": 0 },
                "maximum": { "major": 1, "minor": 0 }
            },
            "requiredCapabilities": [REQUIRED_CAPABILITY]
        },
        "body": { "schemaVersion": 1, "agentIds": requested }
    });
    let mut source =
        serde_json::to_vec(&request).map_err(|_| "checkpoint observation request is invalid")?;
    source.push(b'\n');
    if source.len() as u64 > MAX_TRANSPORT_BYTES {
        return Err("checkpoint observation request is too large".into());
    }
    let mut stream = timeout(
        Duration::from_secs(2),
        UnixStream::connect(&descriptor.socket_path),
    )
    .await
    .map_err(|_| "checkpoint control-plane connection timed out")?
    .map_err(|error| format!("checkpoint control-plane connection failed: {error}"))?;
    crate::dure_backend_transport::verify_local_backend_peer(&stream)
        .map_err(|_| "checkpoint control-plane peer is not trusted")?;
    timeout(Duration::from_secs(2), async {
        stream.write_all(&source).await?;
        stream.shutdown().await
    })
    .await
    .map_err(|_| "checkpoint control-plane write timed out")?
    .map_err(|error| format!("checkpoint control-plane write failed: {error}"))?;
    let mut response_source = Vec::new();
    let mut bounded = (&mut stream).take(MAX_TRANSPORT_BYTES + 1);
    timeout(
        Duration::from_secs(2),
        bounded.read_to_end(&mut response_source),
    )
    .await
    .map_err(|_| "checkpoint control-plane read timed out")?
    .map_err(|error| format!("checkpoint control-plane read failed: {error}"))?;
    if response_source.len() as u64 > MAX_TRANSPORT_BYTES {
        return Err("checkpoint control-plane response is too large".into());
    }
    let response: ObserveResponse = serde_json::from_slice(&response_source)
        .map_err(|_| "checkpoint control-plane response is invalid")?;
    let observed_capabilities = response
        .backend
        .capabilities
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if response.schema_version != 1
        || response.api_version != BACKEND_PROTOCOL_API
        || response.kind != "dure.backend.response"
        || response.request_id != request_id
        || response.backend.id != "dure-local"
        || response.backend.generation != selected.generation.as_str()
        || response.backend.protocol.major != 1
        || response.backend.protocol.minor != 0
        || response.backend.capabilities.len() > MAX_BACKEND_CAPABILITIES_V1
        || response
            .backend
            .capabilities
            .iter()
            .any(|capability| !valid_capability(capability))
        || selected
            .capabilities
            .iter()
            .any(|capability| !observed_capabilities.contains(capability.as_str()))
        || response.backend.capabilities.len() != observed_capabilities.len()
        || response.backend.observed_at_ms.abs_diff(now_ms()?) > 60_000
        || response.result.schema_version != AGENT_CHECKPOINT_SCHEMA_VERSION_V1
    {
        return Err("checkpoint control-plane response is incompatible".into());
    }
    let mut observed_ids = BTreeSet::new();
    let mut records = Vec::with_capacity(response.result.records.len());
    for observed in response.result.records {
        observed
            .record
            .validate()
            .map_err(|_| "checkpoint record is invalid")?;
        if !observed.record.consistent_with_serving_binding(
            observed.binding.binding_generation,
            &observed.binding.session_id,
        ) || observed.binding.workspace_id.is_empty()
            || observed.binding.stop_fence.runner_principal.is_empty()
            || !requested_ids.contains(observed.record.agent_id.as_str())
            || !observed_ids.insert(observed.record.agent_id.to_string())
        {
            return Err("checkpoint record does not match the observation request".into());
        }
        records.push(DureCheckpointProjectedRecord {
            record: observed.record,
            observed_binding: observed.binding,
        });
    }
    Ok(records)
}

fn selected_local_profile(
    source: &str,
    selector: Option<&str>,
) -> Result<Option<SelectedLocalProfile>, String> {
    if source.is_empty() {
        return Ok(None);
    }
    let catalog: Catalog =
        serde_json::from_str(source).map_err(|_| "checkpoint profile catalog is invalid")?;
    if catalog.schema_version != 1
        || catalog.kind != "dure.backend_profiles"
        || catalog.profiles.is_empty()
        || catalog.profiles.len() > 32
    {
        return Err("checkpoint profile catalog is invalid".into());
    }
    let mut profile_ids = BTreeSet::new();
    let mut default_ids = Vec::new();
    for profile in &catalog.profiles {
        let id = profile
            .get("id")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("checkpoint profile catalog is invalid")?;
        if !profile_ids.insert(id) {
            return Err("checkpoint profile catalog is invalid".into());
        }
        match profile.get("default") {
            Some(serde_json::Value::Bool(true)) => default_ids.push(id),
            Some(serde_json::Value::Bool(false)) | None => {}
            Some(_) => return Err("checkpoint profile catalog is invalid".into()),
        }
    }
    let selected_id = match selector.filter(|value| !value.is_empty()) {
        Some(selected) => selected,
        None => {
            if default_ids.len() != 1 {
                return Ok(None);
            }
            default_ids[0]
        }
    };
    if selected_id != "local" {
        return Err("checkpoint_observation_profile_unsupported".into());
    }
    let raw = catalog
        .profiles
        .into_iter()
        .find(|profile| profile.get("id").and_then(serde_json::Value::as_str) == Some("local"))
        .ok_or("selected local checkpoint profile is missing")?;
    let profile: LocalProfile =
        serde_json::from_value(raw).map_err(|_| "selected local checkpoint profile is invalid")?;
    let capabilities = profile
        .expected
        .capabilities
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if profile.id != "local"
        || profile.transport.kind != "local"
        || profile.transport.endpoint.kind != "unix_socket"
        || !profile.transport.endpoint.path.is_absolute()
        || profile.auth.kind != "peer"
        || profile.trust.kind != "local_peer"
        || profile.expected.backend_id != "dure-local"
        || !valid_generation(&profile.expected.generation)
        || profile.expected.protocol.minimum.major != 1
        || profile.expected.protocol.minimum.minor != 0
        || profile.expected.protocol.maximum.major != 1
        || profile.expected.protocol.maximum.minor != 0
        || capabilities.len() > MAX_BACKEND_CAPABILITIES_V1
        || capabilities
            .iter()
            .any(|capability| !valid_capability(capability))
        || !capabilities.contains(REQUIRED_CAPABILITY)
        || profile.expected.capabilities.len() != capabilities.len()
        || profile.deadline_ms == 0
        || profile.deadline_ms > 30_000
    {
        return Err("selected local checkpoint profile is incompatible".into());
    }
    Ok(Some(SelectedLocalProfile {
        generation: profile.expected.generation,
        capabilities,
        socket_path: profile.transport.endpoint.path,
    }))
}

#[tauri::command]
pub async fn dure_checkpoint_observe(
    agent_ids: Vec<String>,
) -> Result<DureCheckpointObservation, String> {
    let (root, _) = crate::app_home::app_root_resolution()?;
    let source = read_owner_file(&root.join("backend-profiles.json"))?;
    let selector = std::env::var("DURE_BACKEND_PROFILE").ok();
    let Some(selected) = selected_local_profile(&source, selector.as_deref())? else {
        return Ok(DureCheckpointObservation {
            schema_version: 1,
            backend_id: "dure-local".into(),
            backend_generation: "unavailable".into(),
            records: Vec::new(),
        });
    };
    let records = observe_local_checkpoints(&root, &selected, agent_ids).await?;
    Ok(DureCheckpointObservation {
        schema_version: 1,
        backend_id: "dure-local".into(),
        backend_generation: selected.generation,
        records,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_capability_contract_selects_current_identity_and_bounded_growth() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../cli/lib/control-plane-build-identity.json"
        )).unwrap();
        let maximum = std::iter::once(REQUIRED_CAPABILITY.to_string())
            .chain((1..128).map(|index| format!("capability.{index}")))
            .collect::<Vec<_>>();
        let source = |capabilities: serde_json::Value| {
            let mut profile = local(Path::new("/tmp/dure-checkpoint-capability-fixture"));
            profile["expected"]["capabilities"] = capabilities;
            json!({
                "schemaVersion": 1,
                "kind": "dure.backend_profiles",
                "profiles": [profile]
            }).to_string()
        };
        for capabilities in [manifest["identity"]["capabilities"].clone(), json!(maximum)] {
            assert!(selected_local_profile(&source(capabilities), None).unwrap().is_some());
        }
        for extra in ["capability.extra", "capability.1", "invalid capability"] {
            let mut invalid = maximum.clone();
            if extra != "capability.extra" {
                invalid.pop();
            }
            invalid.push(extra.into());
            assert!(selected_local_profile(&source(json!(invalid)), None).is_err());
        }
    }

    #[test]
    fn versioned_descriptor_keeps_the_complete_hmux_toolchain_identity() {
        let descriptor: ServiceDescriptor = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "backendId": "dure-local",
            "buildId": "dure-control-plane/v29-replacement-direction-fence",
            "generation": "local-v1-11111111111111111111111111111111",
            "socketPath": "/tmp/dure/backend/control-plane.sock",
            "databasePath": "/tmp/dure/backend/application-state.sqlite3",
            "hmuxExecutablePath": "/tmp/dure/bin/hmux",
            "hmuxExecutableDevice": "1",
            "hmuxExecutableInode": "2",
            "hmuxExecutableSize": "3",
            "hmuxExecutableModified": "4:5",
            "hmuxExecutableSha256": "a".repeat(64),
            "hmuxRuntimeExecutablePath": "/tmp/dure/bin/hmux-runtime",
            "hmuxRuntimeExecutableDevice": "6",
            "hmuxRuntimeExecutableInode": "7",
            "hmuxRuntimeExecutableSize": "8",
            "hmuxRuntimeExecutableModified": "9:10",
            "hmuxRuntimeExecutableSha256": "b".repeat(64),
            "hmuxDiscoveryRoot": "/tmp/dure/hmux-hosts",
            "hmuxDiscoveryDevice": "11",
            "hmuxDiscoveryInode": "12",
            "processId": 13,
            "observedAtMs": 14
        }))
        .unwrap();

        assert!(SERVICE_DESCRIPTOR_SCHEMAS.contains(&descriptor.schema_version));
        assert_eq!(
            descriptor.hmux_runtime_executable_path,
            Path::new("/tmp/dure/bin/hmux-runtime")
        );
    }

    fn local(root: &Path) -> serde_json::Value {
        serde_json::json!({
            "id": "local",
            "default": true,
            "transport": {
                "kind": "local",
                "endpoint": {
                    "kind": "unix_socket",
                    "path": root.join("backend/control-plane.sock")
                }
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
                    "agent_checkpoint.binding.ensure",
                    "agent_checkpoint.observe",
                    "agent_checkpoint.read",
                    "agent_checkpoint.write",
                    "sessions.list",
                    "sessions.show"
                ]
            },
            "deadlineMs": 10_000
        })
    }

    #[test]
    fn observes_only_the_selected_canonical_local_profile() {
        let root = Path::new("/tmp/dure-checkpoint-profile-fixture");
        let remote = serde_json::json!({ "id": "remote", "default": false });
        let source = serde_json::json!({
            "schemaVersion": 1,
            "kind": "dure.backend_profiles",
            "profiles": [local(root), remote]
        })
        .to_string();
        let selected = selected_local_profile(&source, None)
            .unwrap()
            .unwrap();
        assert_eq!(
            selected.generation,
            "local-v1-11111111111111111111111111111111"
        );
        assert!(selected.capabilities.contains(REQUIRED_CAPABILITY));
        assert_eq!(
            selected_local_profile(&source, Some("remote")).unwrap_err(),
            "checkpoint_observation_profile_unsupported"
        );

        let mut future_local = local(root);
        future_local["expected"]["capabilities"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!("client_view.read"));
        let future_source = serde_json::json!({
            "schemaVersion": 1,
            "kind": "dure.backend_profiles",
            "profiles": [future_local]
        })
        .to_string();
        assert!(selected_local_profile(&future_source, None).is_ok());

        let mut old_local = local(root);
        old_local["expected"]["capabilities"] = serde_json::json!([
            "agent_checkpoint.binding.ensure",
            "agent_checkpoint.read",
            "agent_checkpoint.write"
        ]);
        let old_source = serde_json::json!({
            "schemaVersion": 1,
            "kind": "dure.backend_profiles",
            "profiles": [old_local]
        })
        .to_string();
        assert!(selected_local_profile(&old_source, None).is_err());

        let duplicate_source = serde_json::json!({
            "schemaVersion": 1,
            "kind": "dure.backend_profiles",
            "profiles": [local(root), local(root)]
        })
        .to_string();
        assert!(selected_local_profile(&duplicate_source, None).is_err());
    }
}
